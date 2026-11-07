import { Check, CornerDownLeft, Loader2, Pause, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRequest, OutgoingAttachment, Part, PlanItem, Thread } from '../../shared/types'
import { PLAN_TOOL } from '../../shared/types'
import { outputSinceLastUser } from '../../shared/usage'
import { formatElapsed, formatTokens, shortToolName } from './format'
import type { LiveTurn } from './store'

const CHARS_PER_TOKEN = 4

function Plan({ items, running }: { items: PlanItem[]; running: boolean }) {
  return (
    <ul className="plan" aria-label={running ? 'Tarefas em andamento' : 'Tarefas pendentes'}>
      {items.map((item, index) => (
        <li key={index} className={`plan-item ${item.status}`}>
          <span className="plan-mark" aria-hidden>
            {item.status === 'completed' ? <Check size={13} /> : item.status === 'in_progress' ? (running ? <Loader2 size={13} className="spin" /> : <Pause size={13} />) : <span className="plan-dot" />}
          </span>
          {item.content}
        </li>
      ))}
    </ul>
  )
}

/** What the run is doing right now, in a few words. */
function activityOf(thread: Thread, live: LiveTurn | undefined, approvals: ApprovalRequest[]): string {
  if (approvals.length > 0) return 'Aguardando você'
  if (live?.text) return 'Escrevendo'
  if (live?.reasoning) return 'Raciocinando'

  const assistant = thread.messages.findLast((message) => message.role === 'assistant')
  const results = thread.messages.at(-1)?.role === 'tool' ? thread.messages.at(-1)!.parts : []
  const answered = new Set(results.flatMap((part: Part) => (part.type === 'tool_result' ? [part.callId] : [])))
  const pending = assistant?.parts.find((part) => part.type === 'tool_call' && part.name !== PLAN_TOOL && !answered.has(part.id))
  if (pending?.type === 'tool_call' && thread.messages.at(-1)?.role !== 'user') return `Executando ${shortToolName(pending.name)}`
  return 'Pensando'
}

function RunStatus({ thread, live, approvals }: { thread: Thread; live: LiveTurn | undefined; approvals: ApprovalRequest[] }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Exact counts only arrive when each step ends, so the step in progress is estimated.
  const streamed = (live?.text.length ?? 0) + (live?.reasoning.length ?? 0)
  const tokens = outputSinceLastUser(thread.messages) + Math.ceil(streamed / CHARS_PER_TOKEN)
  const elapsed = live?.startedAt ? formatElapsed(now - live.startedAt) : null

  return (
    <div className="run-status" role="status">
      <span className="node pulse small" aria-hidden />
      <span className="run-activity">{activityOf(thread, live, approvals)}</span>
      {elapsed && <span className="run-figure">{elapsed}</span>}
      {tokens > 0 && <span className="run-figure">{formatTokens(tokens)} tokens</span>}
    </div>
  )
}

export interface QueuedMessage {
  text: string
  attachments: OutgoingAttachment[]
}

function describeQueued(message: QueuedMessage): string {
  const names = message.attachments.map((file) => file.name).join(', ')
  return [message.text.trim(), names && `(${names})`].filter(Boolean).join(' ')
}

interface LivePanelProps {
  thread: Thread
  live: LiveTurn | undefined
  running: boolean
  approvals: ApprovalRequest[]
  queue: QueuedMessage[]
  onSendNow(index: number): void
  onRemove(index: number): void
}

/** What is happening now, pinned above the message box: the task list, the status and the queue. */
export function LivePanel({ thread, live, running, approvals, queue, onSendNow, onRemove }: LivePanelProps) {
  const plan = thread.plan ?? []
  const showPlan = plan.length > 0 && (running || plan.some((item) => item.status !== 'completed'))
  const interrupted = !running && thread.lastRun === 'aborted'
  if (!showPlan && !running && !interrupted && queue.length === 0) return null

  return (
    <div className="live-panel">
      {!running && (showPlan || interrupted) && (
        <div className="plan-status" role="status">
          {interrupted ? 'Execução interrompida.' : 'Nenhuma execução em andamento.'}
          {showPlan && ' Tarefas não concluídas foram mantidas.'}
        </div>
      )}
      {showPlan && <Plan items={plan} running={running} />}
      {running && <RunStatus thread={thread} live={live} approvals={approvals} />}
      {queue.length > 0 && (
        <ul className="queue" aria-label="Mensagens na fila">
          {queue.map((message, index) => (
            <li key={index} className="queued">
              <span className="queued-label">Na fila</span>
              <span className="queued-text">{describeQueued(message)}</span>
              <button className="queued-action" onClick={() => onSendNow(index)} title={running ? 'Interrompe o trabalho atual e envia esta mensagem' : 'Enviar esta mensagem'}>
                <CornerDownLeft size={12} aria-hidden /> Enviar agora
              </button>
              <button className="icon-button" aria-label={`Remover da fila: ${describeQueued(message)}`} title="Remover da fila" onClick={() => onRemove(index)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
