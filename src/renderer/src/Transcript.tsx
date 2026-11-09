import { AlertTriangle, Check, ChevronRight, FileText, Loader2, RotateCcw, Shuffle } from 'lucide-react'
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  PLAN_TOOL,
  sameModel,
  type ApprovalDecision,
  type ApprovalRequest,
  type AttachmentPart,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Part,
  type QuestionAnswer,
  type QuestionRequest,
  type Thread,
  type ToolCallPart,
  type ToolResultPart
} from '../../shared/types'
import { formatFileSize, modelLabel, providerLabel, shortToolName, toolActivity, toolSummary, usageLabel } from './format'
import { Markdown } from './Markdown'
import { api, type LiveTurn } from './store'

interface TranscriptProps {
  thread: Thread
  models: ModelInfo[]
  live: LiveTurn | undefined
  running: boolean
  approvals: ApprovalRequest[]
  questions: QuestionRequest[]
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

function SentAttachment({ part }: { part: AttachmentPart }) {
  const [preview, setPreview] = useState<string | null>(null)
  const image = part.mediaType.startsWith('image/')
  useEffect(() => {
    if (image) void api.attachments.preview(part.ref).then(setPreview)
  }, [image, part.ref])
  if (image && preview) return <img className="sent-image" src={preview} alt={part.name} title={part.name} />
  return (
    <span className="sent-file" title={part.name}>
      <FileText size={13} aria-hidden /> {part.name} <span className="sent-size">{formatFileSize(part.size)}</span>
    </span>
  )
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
  const isPlan = preview.kind === 'plan'
  const title = isPlan ? 'Aprovar este plano?' : RISK_TITLE[approval.risk]
  const respond = (decision: ApprovalDecision) => void api.chat.respond(threadId, approval.id, decision)
  // Takes no focus when it appears: an Enter meant for the message box must never approve an action.
  return (
    <div className="approval" role="group" aria-label={title}>
      <div className="approval-title">{title}</div>
      {preview.kind === 'plan' && <><pre className="approval-code tall">{preview.text}</pre><p>Ao aprovar, edições comuns serão aceitas. Comandos, ferramentas externas e arquivos sensíveis continuam pedindo confirmação.</p></>}
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
          {isPlan ? 'Aprovar e executar' : 'Permitir'}
        </button>
        {!isPlan && approval.risk !== 'sensitive' && (
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

/** Options to click. Takes no focus, like approvals: an Enter meant for the message box answers nothing. */
function QuestionCard({ threadId, request }: { threadId: string; request: QuestionRequest }) {
  const [chosen, setChosen] = useState<string[][]>(() => request.questions.map(() => []))
  const [own, setOwn] = useState<string[]>(() => request.questions.map(() => ''))
  const instant = request.questions.length === 1 && !request.questions[0].multiple
  const send = (answers: QuestionAnswer[] | null) => void api.chat.answer(threadId, request.id, answers)
  const answers = (picked = chosen): QuestionAnswer[] => picked.map((labels, index) => ({ chosen: labels, ...(own[index].trim() ? { other: own[index].trim() } : {}) }))
  const complete = request.questions.every((_, index) => chosen[index].length > 0 || own[index].trim())
  const pick = (index: number, label: string, multiple: boolean): void => {
    if (instant) return send(answers([[label]]))
    setChosen((all) => all.map((labels, i) => (i !== index ? labels : multiple ? (labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label]) : [label])))
  }
  return (
    <div className="approval question-card" role="group" aria-label="Perguntas do modelo">
      {request.questions.map((question, index) => (
        <div key={index} className="question">
          <div className="approval-title">{question.question}</div>
          <div className="approval-actions">
            {question.options.map((option) => (
              <button
                key={option.label}
                className={`button${chosen[index].includes(option.label) ? ' primary' : ''}`}
                aria-pressed={instant ? undefined : chosen[index].includes(option.label)}
                title={option.description}
                onClick={() => pick(index, option.label, question.multiple === true)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            className="panel-input"
            aria-label={`Outra resposta: ${question.question}`}
            placeholder="Outra resposta"
            value={own[index]}
            onChange={(event) => setOwn((all) => all.map((text, i) => (i === index ? event.target.value : text)))}
            onKeyDown={(event) => event.key === 'Enter' && complete && send(answers())}
          />
        </div>
      ))}
      <div className="approval-actions">
        <button className="button primary" disabled={!complete} onClick={() => send(answers())}>
          Responder
        </button>
        <button className="button quiet" onClick={() => send(null)}>
          Pular
        </button>
      </div>
    </div>
  )
}

function ToolRow({
  call,
  result,
  approval,
  question,
  threadId,
  interrupted
}: {
  call: ToolCallPart
  result: ToolResultPart | undefined
  approval: ApprovalRequest | undefined
  question?: QuestionRequest
  threadId: string
  interrupted: boolean
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const summary = toolSummary(call.input)
  const status = result
    ? result.denied
      ? 'denied'
      : result.isError
        ? 'error'
        : 'ok'
    : interrupted
      ? 'error'
      : approval || question
        ? 'waiting'
        : 'running'
  const failed = status === 'error' || status === 'denied'
  useEffect(() => {
    if (failed) setExpanded((current) => current === true ? true : null)
  }, [failed])
  const statusText = { ok: '', denied: 'não permitido', error: 'erro', waiting: 'aguardando você', running: 'executando' }[status]
  const open = expanded ?? (status === 'error' || status === 'denied')
  return (
    <div className={`tool tool-${status}`}>
      <button className="tool-row" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <ChevronRight size={13} className={`chevron${open ? ' rotated' : ''}`} />
        <span className="tool-name">{shortToolName(call.name)}</span>
        <span className="tool-summary">{summary}</span>
        {statusText && <span className="tool-status">{statusText}</span>}
      </button>
      {approval && <ApprovalCard threadId={threadId} approval={approval} />}
      {question && <QuestionCard threadId={threadId} request={question} />}
      {open && (
        <div className="tool-detail">
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {result && <pre className={result.isError ? 'tool-output failed' : 'tool-output'}>{result.content}</pre>}
        </div>
      )}
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
  questions: QuestionRequest[]
  threadId: string
  running: boolean
}

function ToolGroup({ calls, props }: { calls: ToolCallPart[]; props: AssistantProps }) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const id = useId()
  const waiting = calls.some((call) => props.approvals.some((entry) => entry.callId === call.id) || props.questions.some((entry) => entry.callId === call.id))
  const failed = calls.some((call) => {
    const result = props.results.get(call.id)
    return result ? result.isError || result.denied : !props.running
  })
  useEffect(() => {
    if (failed) setExpanded((current) => current === true ? true : null)
  }, [failed])
  const active = calls.find((call) => !props.results.has(call.id))
  const executing = !!active && props.running && !waiting
  // Approval controls can never be hidden. Manual expansion survives completion.
  const open = waiting || (expanded ?? failed)
  const count = `${calls.length} ${calls.length === 1 ? 'chamada de ferramenta' : 'chamadas de ferramenta'}`
  const status = waiting ? 'Aguardando você' : executing ? 'Executando' : failed ? 'Com falha ou recusa' : 'Concluído'
  const activities = [...new Set(calls.map((call) => toolActivity(call.name, call.input)))]
  const summary = executing && active ? toolActivity(active.name, active.input) : activities.slice(0, 2).join(' · ') + (activities.length > 2 ? ` · +${activities.length - 2}` : '')
  return (
    <div className={`tool-group${failed ? ' tool-group-failed' : ''}`}>
      <button className="tool-group-toggle" aria-expanded={open} aria-controls={id} onClick={() => setExpanded(!open)}>
        <ChevronRight size={13} className={`chevron${open ? ' rotated' : ''}`} aria-hidden />
        {executing ? <Loader2 size={13} className="spin" aria-hidden /> : failed ? <AlertTriangle size={13} aria-hidden /> : !waiting ? <Check size={13} aria-hidden /> : null}
        <span className="tool-group-summary" title={summary}>{summary}</span>
        <span className="tool-group-count">{count}</span>
        <span className="tool-group-status">{status}</span>
      </button>
      <div id={id} className="tool-group-body" hidden={!open}>
        {calls.map((call, index) => (
          <ToolRow key={`${call.id}-${index}`} call={call} result={props.results.get(call.id)} approval={props.approvals.find((entry) => entry.callId === call.id)} question={props.questions.find((entry) => entry.callId === call.id)} threadId={props.threadId} interrupted={!props.running} />
        ))}
      </div>
    </div>
  )
}

/** Group only adjacent calls; prose, reasoning and model handoffs keep their original order. */
function assistantParts(props: AssistantProps): ReactNode[] {
  const nodes: ReactNode[] = []
  let calls: ToolCallPart[] = []
  let start = 0
  const flush = (): void => {
    if (calls.length) nodes.push(<ToolGroup key={`tools-${start}`} calls={calls} props={props} />)
    calls = []
  }
  props.message.parts.forEach((part, index) => {
    if (part.type === 'tool_call') {
      if (part.name !== PLAN_TOOL) {
        if (!calls.length) start = index
        calls.push(part)
      }
    } else {
      flush()
      nodes.push(renderPart(part, index))
    }
  })
  flush()
  return nodes
}

function renderPart(part: Part, index: number) {
  switch (part.type) {
    case 'reasoning':
      return <Reasoning key={index} text={part.text} />
    case 'text':
      return <Markdown key={index} text={part.text} />
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
      {assistantParts(props)}
      {props.approvals.filter((approval) => approval.preview.kind === 'plan' && approval.callId === message.id).map((approval) => <ApprovalCard key={approval.id} threadId={props.threadId} approval={approval} />)}
      {message.stop === 'aborted' && <div className="turn-note">Interrompido por você.</div>}
      {message.excluded && <div className="turn-note">Esta resposta fica fora do contexto dos próximos modelos.</div>}
    </article>
  )
})

const NO_APPROVALS: ApprovalRequest[] = []
const NO_QUESTIONS: QuestionRequest[] = []

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

export function Transcript({ thread, models, live, running, approvals, questions, notices, error, onRetry, onChangeModel }: TranscriptProps) {
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
  // The model whose name is showing for the current turn, so later steps can skip repeating it.
  let namedInTurn: ModelRef | null = null
  const items = thread.messages.map((message) => {
    if (message.role === 'tool') {
      previousRole = 'tool'
      return null
    }
    if (message.role === 'user') {
      previousRole = 'user'
      namedInTurn = null
      const text = message.parts.map((part) => (part.type === 'text' && !part.appContext ? part.text : '')).join('')
      return (
        <article className="turn user" key={message.id}>
          <span className="node hollow" aria-hidden />
          {message.parts.some((part) => part.type === 'attachment') && (
            <div className="sent-attachments">
              {message.parts.flatMap((part) => (part.type === 'attachment' ? [<SentAttachment key={part.ref} part={part} />] : []))}
            </div>
          )}
          {text && <div className="user-text">{text}</div>}
          {message.parts.some((part) => part.type === 'text' && part.appContext === 'plan') && <div className="turn-note">Modo Plano · investigar e aguardar aprovação antes de executar</div>}
        </article>
      )
    }
    const onlyPlan = message.parts.every((part) => part.type === 'tool_call' && part.name === PLAN_TOOL)
    if (onlyPlan) {
      previousRole = 'assistant'
      return null
    }
    const continued = previousRole === 'tool' && sameModel(namedInTurn, message.model)
    const handoff = previousAuthor !== null && !sameModel(previousAuthor, message.model)
    previousAuthor = message.model ?? previousAuthor
    previousRole = 'assistant'
    namedInTurn = message.model ?? namedInTurn
    return (
      <AssistantMessage
        key={message.id}
        message={message}
        showHeader={!continued}
        handoff={handoff}
        models={models}
        results={results.get(message.id) ?? NO_RESULTS}
        approvals={message === latestAssistant ? approvals : NO_APPROVALS}
        questions={message === latestAssistant ? questions : NO_QUESTIONS}
        threadId={thread.id}
        running={running}
      />
    )
  })

  const liveTurn = live && (live.text || live.reasoning)
  const nextModel = thread.model
  const liveHandoff = previousAuthor !== null && !sameModel(previousAuthor, nextModel)
  const liveContinues = thread.messages.at(-1)?.role === 'tool' && sameModel(namedInTurn, nextModel)

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

        {liveTurn && (
          <article className={`turn assistant live${liveContinues ? ' continued' : ''}`}>
            {!liveContinues && (
              <header className="turn-header">
                <span className={`node pulse${liveHandoff ? ' handoff' : ''}`} aria-hidden />
                <span className="author">{modelLabel(nextModel, models)}</span>
                <span className="provider">{providerLabel(nextModel, models)}</span>
                {liveHandoff && <span className="handoff-tag">assumiu aqui</span>}
              </header>
            )}
            {live.reasoning && <Reasoning text={live.reasoning} active={!live.text} />}
            {live.text && <Markdown text={live.text} />}
          </article>
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
