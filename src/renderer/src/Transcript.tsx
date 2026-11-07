import { AlertTriangle, ChevronRight, RotateCcw, Shuffle } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  modelKey,
  sameModel,
  type ApprovalDecision,
  type ApprovalRequest,
  type CouncilVoice,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Part,
  type Thread,
  type ToolCallPart,
  type ToolResultPart
} from '../../shared/types'
import { modelLabel, providerLabel, shortToolName, toolSummary, usageLabel } from './format'
import { Markdown } from './Markdown'
import { api, type LiveTurn } from './store'

interface TranscriptProps {
  thread: Thread
  models: ModelInfo[]
  live: LiveTurn | undefined
  running: boolean
  approvals: ApprovalRequest[]
  notices: string[]
  error: string | undefined
  onRetry(): void
  onChangeModel(): void
}

const RISK_TITLE: Record<ApprovalRequest['risk'], string> = {
  read: 'Ler?',
  sensitive: 'Abrir um arquivo que pode conter segredos?',
  write: 'Alterar este arquivo?',
  exec: 'Executar este comando?',
  external: 'Usar esta ferramenta externa?'
}

function Reasoning({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`reasoning${open ? ' open' : ''}`}>
      <button className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="chevron" />
        {active ? 'Raciocinando…' : 'Raciocínio'}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {before.split('\n').map((line, index) => (
        <span className="diff-line removed" key={`-${index}`}>
          {line || ' '}
        </span>
      ))}
      {after.split('\n').map((line, index) => (
        <span className="diff-line added" key={`+${index}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function ApprovalCard({ threadId, approval }: { threadId: string; approval: ApprovalRequest }) {
  const { preview } = approval
  const respond = (decision: ApprovalDecision) => void api.chat.respond(threadId, approval.id, decision)
  // Takes no focus when it appears: an Enter meant for the message box must never approve an action.
  return (
    <div className="approval" role="group" aria-label={RISK_TITLE[approval.risk]}>
      <div className="approval-title">{RISK_TITLE[approval.risk]}</div>
      {preview.kind === 'command' && <pre className="approval-code">{preview.command}</pre>}
      {preview.kind === 'path' && <pre className="approval-code">{preview.path}</pre>}
      {preview.kind === 'json' && <pre className="approval-code">{preview.json}</pre>}
      {preview.kind === 'edit' && (
        <>
          <div className="approval-path">{preview.path}</div>
          <Diff before={preview.before} after={preview.after} />
        </>
      )}
      {preview.kind === 'write' && (
        <>
          <div className="approval-path">{preview.path}</div>
          <pre className="approval-code tall">{preview.content}</pre>
        </>
      )}
      <div className="approval-actions">
        <button className="button primary" onClick={() => respond('allow')}>
          Permitir
        </button>
        {approval.risk !== 'sensitive' && (
          <button className="button" onClick={() => respond('allow-always')}>
            Sempre nesta conversa
          </button>
        )}
        <button className="button quiet" onClick={() => respond('deny')}>
          Negar
        </button>
      </div>
    </div>
  )
}

function ToolRow({
  call,
  result,
  approval,
  threadId,
  interrupted
}: {
  call: ToolCallPart
  result: ToolResultPart | undefined
  approval: ApprovalRequest | undefined
  threadId: string
  interrupted: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(call.input)
  const status = result
    ? result.denied
      ? 'denied'
      : result.isError
        ? 'error'
        : 'ok'
    : interrupted
      ? 'error'
      : approval
        ? 'waiting'
        : 'running'
  const statusText = { ok: '', denied: 'não permitido', error: 'erro', waiting: 'aguardando você', running: 'executando' }[status]
  return (
    <div className={`tool tool-${status}`}>
      <button className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={`chevron${open ? ' rotated' : ''}`} />
        <span className="tool-name">{shortToolName(call.name)}</span>
        <span className="tool-summary">{summary}</span>
        {statusText && <span className="tool-status">{statusText}</span>}
      </button>
      {approval && <ApprovalCard threadId={threadId} approval={approval} />}
      {open && (
        <div className="tool-detail">
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {result && <pre className={result.isError ? 'tool-output failed' : 'tool-output'}>{result.content}</pre>}
        </div>
      )}
    </div>
  )
}

function CouncilSummary({ voices, models }: { voices: CouncilVoice[]; models: ModelInfo[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const voice = voices.find((entry) => modelKey(entry.model) === selected)
  const answered = voices.filter((entry) => !entry.error).length
  return (
    <div className="council-summary">
      <div className="council-chips" role="tablist" aria-label="Respostas do conselho">
        <span className="council-count">
          {answered} {answered === 1 ? 'voz' : 'vozes'}
        </span>
        {voices.map((entry) => {
          const key = modelKey(entry.model)
          return (
            <button
              key={key}
              role="tab"
              aria-selected={selected === key}
              className={`chip${selected === key ? ' selected' : ''}${entry.error ? ' failed' : ''}`}
              onClick={() => setSelected(selected === key ? null : key)}
            >
              {modelLabel(entry.model, models)}
            </button>
          )
        })}
      </div>
      {voice && (
        <div className="council-voice">{voice.error ? <p className="voice-error">{voice.error}</p> : <Markdown text={voice.text} />}</div>
      )}
    </div>
  )
}

function LiveCouncil({ live, models }: { live: LiveTurn; models: ModelInfo[] }) {
  const council = live.council!
  return (
    <div className={`council-live count-${Math.min(council.voices.length, 4)}`}>
      {council.voices.map((voice) => {
        const stream = live.voices[voice.key]
        return (
          <section className={`voice state-${voice.status}`} key={voice.key} aria-label={modelLabel(voice.model, models)}>
            <header className="voice-header">
              <span className="voice-name">{modelLabel(voice.model, models)}</span>
              <span className="voice-provider">{providerLabel(voice.model, models)}</span>
            </header>
            <div className="voice-body">
              {voice.error ? <p className="voice-error">{voice.error}</p> : stream?.text ? <Markdown text={stream.text} /> : <span className="waiting-dots">pensando</span>}
            </div>
          </section>
        )
      })}
    </div>
  )
}

interface AssistantProps {
  message: Message
  showHeader: boolean
  handoff: boolean
  models: ModelInfo[]
  results: Map<string, ToolResultPart>
  approvals: ApprovalRequest[]
  threadId: string
  running: boolean
}

function renderPart(part: Part, index: number, props: AssistantProps) {
  switch (part.type) {
    case 'reasoning':
      return <Reasoning key={index} text={part.text} />
    case 'text':
      return <Markdown key={index} text={part.text} />
    case 'tool_call':
      return (
        <ToolRow
          key={`${part.id}-${index}`}
          call={part}
          result={props.results.get(part.id)}
          approval={props.approvals.find((entry) => entry.callId === part.id)}
          threadId={props.threadId}
          interrupted={!props.running}
        />
      )
    default:
      return null
  }
}

const AssistantMessage = memo(function AssistantMessage(props: AssistantProps) {
  const { message, showHeader, handoff, models } = props
  const usage = usageLabel(message.usage)
  return (
    <article className={`turn assistant${showHeader ? '' : ' continued'}${message.excluded ? ' refused' : ''}`}>
      {showHeader && (
        <header className="turn-header">
          <span className={`node${handoff ? ' handoff' : ''}`} aria-hidden />
          <span className="author">{modelLabel(message.model, models)}</span>
          <span className="provider">{providerLabel(message.model, models)}</span>
          {handoff && <span className="handoff-tag">assumiu aqui</span>}
          {usage && (
            <span className="usage" title="Tokens usados nesta resposta">
              {usage}
            </span>
          )}
        </header>
      )}
      {message.council && <CouncilSummary voices={message.council.voices} models={models} />}
      {message.parts.map((part, index) => renderPart(part, index, props))}
      {message.stop === 'aborted' && <div className="turn-note">Interrompido por você.</div>}
      {message.excluded && <div className="turn-note">Esta resposta fica fora do contexto dos próximos modelos.</div>}
    </article>
  )
})

const NO_APPROVALS: ApprovalRequest[] = []

/**
 * Results for each assistant message, taken from the tool message right after it.
 * Ids can't be matched across the whole thread: some servers reuse them on every turn.
 */
function resultsByMessage(messages: Message[]): Map<string, Map<string, ToolResultPart>> {
  const byMessage = new Map<string, Map<string, ToolResultPart>>()
  messages.forEach((message, index) => {
    const next = messages[index + 1]
    if (message.role !== 'assistant' || next?.role !== 'tool') return
    const results = new Map<string, ToolResultPart>()
    for (const part of next.parts) if (part.type === 'tool_result') results.set(part.callId, part)
    byMessage.set(message.id, results)
  })
  return byMessage
}

const NO_RESULTS = new Map<string, ToolResultPart>()

export function Transcript({ thread, models, live, running, approvals, notices, error, onRetry, onChangeModel }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const results = useMemo(() => resultsByMessage(thread.messages), [thread.messages])
  const latestAssistant = thread.messages.findLast((message) => message.role === 'assistant')

  useEffect(() => {
    stuck.current = true
  }, [thread.id])

  // Follows new output, unless the reader has scrolled up to look at something.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  })

  let previousAuthor: ModelRef | null = null
  let previousRole: Message['role'] | null = null
  const items = thread.messages.map((message) => {
    if (message.role === 'tool') {
      previousRole = 'tool'
      return null
    }
    if (message.role === 'user') {
      previousRole = 'user'
      const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
      return (
        <article className="turn user" key={message.id}>
          <span className="node hollow" aria-hidden />
          <div className="user-text">{text}</div>
        </article>
      )
    }
    const continued = previousRole === 'tool' && sameModel(previousAuthor, message.model)
    const handoff = previousAuthor !== null && !sameModel(previousAuthor, message.model)
    previousAuthor = message.model ?? previousAuthor
    previousRole = 'assistant'
    return (
      <AssistantMessage
        key={message.id}
        message={message}
        showHeader={!continued}
        handoff={handoff}
        models={models}
        results={results.get(message.id) ?? NO_RESULTS}
        approvals={message === latestAssistant ? approvals : NO_APPROVALS}
        threadId={thread.id}
        running={running}
      />
    )
  })

  const liveTurn = live && (live.text || live.reasoning)
  const lastIsTool = thread.messages.at(-1)?.role === 'tool'
  const hasPendingWork = running && !liveTurn && !live?.council && approvals.length === 0
  const nextModel = thread.model
  const liveHandoff = previousAuthor !== null && !sameModel(previousAuthor, nextModel)

  return (
    <div
      className="transcript"
      ref={scroller}
      aria-busy={running}
      onScroll={(event) => {
        const element = event.currentTarget
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
      }}
    >
      <div className="transcript-inner">
        {items}

        {live?.council && <LiveCouncil live={live} models={models} />}

        {liveTurn && (
          <article className={`turn assistant live${lastIsTool && !liveHandoff ? ' continued' : ''}`}>
            {!(lastIsTool && !liveHandoff) && (
              <header className="turn-header">
                <span className={`node pulse${liveHandoff ? ' handoff' : ''}`} aria-hidden />
                <span className="author">{modelLabel(nextModel, models)}</span>
                <span className="provider">{providerLabel(nextModel, models)}</span>
                {liveHandoff && <span className="handoff-tag">assumiu aqui</span>}
                {live?.council?.phase === 'synthesis' && <span className="handoff-tag">unindo as vozes</span>}
              </header>
            )}
            {live.reasoning && <Reasoning text={live.reasoning} active={!live.text} />}
            {live.text && <Markdown text={live.text} />}
          </article>
        )}

        {hasPendingWork && (
          <div className="working" role="status">
            <span className="node pulse" aria-hidden />
            {live?.council ? 'Unindo as vozes…' : 'Pensando…'}
          </div>
        )}

        {notices.map((notice) => (
          <div className="notice" key={notice} role="status">
            {notice}
          </div>
        ))}

        {error && (
          <div className="error-block" role="alert">
            <AlertTriangle size={15} aria-hidden />
            <div className="error-content">
              <p className="error-text">{error}</p>
              <div className="error-actions">
                <button className="button" onClick={onRetry}>
                  <RotateCcw size={13} aria-hidden /> Tentar de novo
                </button>
                <button className="button" onClick={onChangeModel}>
                  <Shuffle size={13} aria-hidden /> Trocar de modelo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
