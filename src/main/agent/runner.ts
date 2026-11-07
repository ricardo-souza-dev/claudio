import Ajv, { type ValidateFunction } from 'ajv'
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type AttachmentPart,
  type Effort,
  type Message,
  type ModelInfo,
  type ModelRef,
  type OutgoingAttachment,
  type Part,
  type PermissionMode,
  type PlanItem,
  type Question,
  type QuestionAnswer,
  type QuestionRequest,
  type SendRequest,
  type Thread,
  type ToolCallPart,
  type ToolResultPart,
  type UniEvent
} from '../../shared/types'
import { flattenHistory, newId, toolCallsOf } from '../providers/history'
import { AbortedError, ProviderError, type ProviderAdapter } from '../providers/types'
import { ASK_TOOL, permissionFor, PLAN_TOOL, type Tool } from '../tools/types'
import { buildSystemPrompt } from './context'

const MAX_AGENT_STEPS = 40
const TITLE_LENGTH = 60

export interface RunnerDeps {
  resolveModel(ref: ModelRef): Promise<{ adapter: ProviderAdapter; info: ModelInfo }>
  toolsFor(workspace: string | null): Tool[]
  memory(): string
  emit(event: UniEvent): void
  save(thread: Thread): Promise<void>
  requestApproval(threadId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
  /** Shows the questions and waits. Null when the person skips them or the run stops. */
  askUser?(threadId: string, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer[] | null>
  saveAttachments?(attachments: OutgoingAttachment[]): Promise<AttachmentPart[]>
  loadAttachments?(messages: Message[], model: ModelInfo): Promise<Message[]>
  /** Called after each answer, so time estimates come from how this model really performs here. */
  recordSpeed?(ref: ModelRef, firstTokenMs: number, generatingMs: number, outputTokens: number): void
}

interface TurnOptions {
  info: ModelInfo
  adapter: ProviderAdapter
  system: string
  messages: Message[]
  tools: Tool[]
  replayRaw: boolean
  threadId: string
  effort?: Effort | null
  signal: AbortSignal
}

const validator = new Ajv({ strict: false, allErrors: true, validateFormats: false })
const validators = new WeakMap<object, ValidateFunction | null>()

/** Models can emit malformed arguments, and a truncated object can still parse, so input is checked before anything runs. */
function inputProblem(tool: Tool, input: unknown): string | null {
  let validate = validators.get(tool.schema)
  if (validate === undefined) {
    try {
      validate = validator.compile(tool.schema)
    } catch {
      validate = null
    }
    validators.set(tool.schema, validate)
  }
  if (!validate || validate(input)) return null
  return validator.errorsText(validate.errors, { dataVar: 'input' })
}

const MAX_OWN_WORDS = 2000

/** The answers as plain text, which every model reads the same way. */
export function describeAnswers(questions: Question[], answers: QuestionAnswer[]): string {
  return questions
    .map((question, index) => {
      const answer = answers[index]
      const parts = (answer?.chosen ?? []).map(String)
      const own = answer?.other?.trim().slice(0, MAX_OWN_WORDS)
      if (own) parts.push(`nas palavras do usuário: ${own}`)
      return `${question.question}\nResposta: ${parts.length > 0 ? parts.join('; ') : 'sem resposta'}`
    })
    .join('\n\n')
}

function sameModelId(requested: string, served: string): boolean {
  // Providers may answer an alias with a dated snapshot of the same model.
  return served === requested || served.startsWith(`${requested}-`) || requested.startsWith(`${served}-`)
}

export class Runner {
  private active = new Map<string, AbortController>()

  constructor(private deps: RunnerDeps) {}

  isRunning(threadId: string): boolean {
    return this.active.has(threadId)
  }

  stop(threadId: string): void {
    this.active.get(threadId)?.abort()
  }

  stopAll(): void {
    for (const controller of this.active.values()) controller.abort()
  }

  async send(thread: Thread, request: SendRequest): Promise<void> {
    if (this.active.has(thread.id)) throw new Error('Esta conversa já está em andamento.')
    const controller = new AbortController()
    this.active.set(thread.id, controller)
    const { deps } = this
    deps.emit({ type: 'run', threadId: thread.id, running: true })
    try {
      const text = request.text.trim()
      const attachments = request.attachments?.length && deps.saveAttachments ? await deps.saveAttachments(request.attachments) : []
      if (text || attachments.length > 0) {
        if (thread.messages.length === 0) {
          const title = text || attachments.map((part) => part.name).join(', ')
          thread.title = title.replace(/\s+/g, ' ').slice(0, TITLE_LENGTH)
        }
        thread.plan = []
        thread.messages.push({
          id: newId('m_'),
          role: 'user',
          // Files first: models read better with what they refer to already in view.
          parts: [...attachments, ...(text ? [{ type: 'text' as const, text }] : [])],
          createdAt: Date.now()
        })
      } else if (thread.messages.at(-1)?.role === 'assistant' && !thread.messages.at(-1)?.excluded) {
        return
      }
      if (thread.system === null) {
        const { system, files } = await buildSystemPrompt(thread.workspace, deps.memory())
        thread.system = system
        thread.contextFiles = files
      }
      thread.model = request.model
      this.publish(thread)
      await deps.save(thread)
      if (request.note) deps.emit({ type: 'notice', threadId: thread.id, text: request.note })

      await this.runAgent(thread, request.model, request.permissionMode, request.effort, controller.signal)
    } catch (error) {
      if (!(error instanceof AbortedError) && !controller.signal.aborted) {
        deps.emit({ type: 'error', threadId: thread.id, text: (error as Error).message })
      }
    } finally {
      this.active.delete(thread.id)
      thread.updatedAt = Date.now()
      this.publish(thread)
      await deps.save(thread).catch(() => undefined)
      deps.emit({ type: 'run', threadId: thread.id, running: false })
    }
  }

  private publish(thread: Thread): void {
    this.deps.emit({ type: 'thread', thread })
  }

  /** Streams one model turn. If the model turns out not to accept tools, reruns without them. */
  private async streamTurn(options: TurnOptions): Promise<{ parts: Part[]; result?: Awaited<ReturnType<ProviderAdapter['stream']>>; toolsDropped: boolean }> {
    const { info, adapter, system, tools, threadId, signal } = options
    let { messages, replayRaw, effort } = options
    let toolList = tools
    let toolsDropped = false
    for (;;) {
      let partialText = ''
      let partialReasoning = ''
      const startedAt = Date.now()
      let firstTokenAt: number | null = null
      try {
        const loaded = this.deps.loadAttachments ? await this.deps.loadAttachments(messages, info) : messages
        const result = await adapter.stream(
          {
            model: info,
            system,
            messages: loaded,
            tools: toolList.map(({ name, description, schema }) => ({ name, description, schema })),
            replayRaw,
            effort,
            signal
          },
          (event) => {
            if (event.type === 'text' || event.type === 'reasoning') {
              firstTokenAt ??= Date.now()
              if (event.type === 'text') partialText += event.text
              else partialReasoning += event.text
              this.deps.emit({ type: 'delta', threadId, kind: event.type, text: event.text })
            } else if (event.type === 'reset') {
              partialText = ''
              partialReasoning = ''
              this.deps.emit({ type: 'reset', threadId })
            } else {
              this.deps.emit({ type: 'notice', threadId, text: event.text })
            }
          }
        )
        if (firstTokenAt !== null && result.usage?.output) {
          this.deps.recordSpeed?.(info, firstTokenAt - startedAt, Date.now() - firstTokenAt, result.usage.output)
        }
        return { parts: result.parts, result, toolsDropped }
      } catch (error) {
        if (error instanceof AbortedError) {
          const parts: Part[] = []
          if (partialReasoning) parts.push({ type: 'reasoning', text: partialReasoning })
          if (partialText) parts.push({ type: 'text', text: partialText })
          return { parts, toolsDropped }
        }
        if (error instanceof ProviderError && error.toolsUnsupported && toolList.length > 0) {
          toolList = []
          toolsDropped = true
          messages = flattenHistory(messages)
          replayRaw = false
          this.deps.emit({ type: 'reset', threadId })
          this.deps.emit({ type: 'notice', threadId, text: `${info.label} não aceita ferramentas. Seguiu só com texto.` })
          continue
        }
        // Catalog data can be wrong about a model: the turn still matters more than the setting.
        if (error instanceof ProviderError && error.effortUnsupported && effort !== null) {
          effort = null
          this.deps.emit({ type: 'reset', threadId })
          this.deps.emit({ type: 'notice', threadId, text: `${info.label} não aceita ajuste de força. Seguiu com o padrão dele.` })
          continue
        }
        throw error
      }
    }
  }

  private assistantMessage(
    outcome: Awaited<ReturnType<Runner['streamTurn']>>,
    ref: ModelRef,
    threadId: string,
    keepRaw: boolean
  ): Message {
    const { parts, result } = outcome
    let author = ref
    if (result?.servedModel && !sameModelId(ref.id, result.servedModel)) {
      author = { provider: ref.provider, id: result.servedModel }
      this.deps.emit({ type: 'notice', threadId, text: `Esta resposta foi escrita por ${result.servedModel}.` })
    }
    const refused = result?.stop === 'refusal'
    return {
      id: newId('m_'),
      role: 'assistant',
      parts,
      createdAt: Date.now(),
      model: author,
      usage: result?.usage,
      stop: result?.stop ?? 'aborted',
      ...(result?.raw && keepRaw && !refused ? { raw: { provider: ref.provider, model: ref.id, data: result.raw } } : {}),
      ...(refused ? { excluded: true } : {})
    }
  }

  private async runAgent(thread: Thread, ref: ModelRef, mode: PermissionMode, effort: Effort | null | undefined, signal: AbortSignal): Promise<void> {
    const { adapter, info } = await this.deps.resolveModel(ref)
    const tools = [...this.deps.toolsFor(thread.workspace)].sort((a, b) => a.name.localeCompare(b.name))
    let turnTools = tools

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const outcome = await this.streamTurn({
        info,
        adapter,
        system: thread.system!,
        messages: thread.messages,
        tools: turnTools,
        replayRaw: true,
        threadId: thread.id,
        effort: effort ?? undefined,
        signal
      })
      if (outcome.toolsDropped) turnTools = []

      const { result } = outcome
      if (outcome.parts.length === 0) {
        if (result) this.deps.emit({ type: 'notice', threadId: thread.id, text: `${info.label} não devolveu conteúdo.` })
        if (result?.stop !== 'refusal') return
      }
      const message = this.assistantMessage(outcome, ref, thread.id, !outcome.toolsDropped)
      thread.messages.push(message)
      this.publish(thread)
      await this.deps.save(thread)

      if (!result) return // Interrupted while streaming.
      if (result.stop === 'refusal') {
        this.deps.emit({ type: 'notice', threadId: thread.id, text: `${info.label} recusou este pedido. Você pode tentar com outro modelo.` })
        return
      }

      const calls = toolCallsOf(message)
      if (calls.length === 0) {
        if (result.stop === 'length') {
          this.deps.emit({ type: 'notice', threadId: thread.id, text: 'A resposta foi cortada pelo limite de tamanho. Peça para continuar.' })
        }
        return
      }
      if (result.stop === 'length') {
        // A truncated tool call can still parse into a valid-looking object: never run it.
        this.appendResults(thread, calls.map((call) => this.errorResult(call, 'Resposta cortada pelo limite de tamanho; a chamada não foi executada.')))
        this.deps.emit({ type: 'notice', threadId: thread.id, text: 'A resposta foi cortada antes de terminar a chamada de ferramenta. Peça para continuar.' })
        await this.deps.save(thread)
        return
      }

      await this.executeCalls(thread, calls, turnTools, mode, signal)
      await this.deps.save(thread)
      if (signal.aborted) return
    }
    this.deps.emit({ type: 'notice', threadId: thread.id, text: `Parei após ${MAX_AGENT_STEPS} passos seguidos. Peça para continuar se fizer sentido.` })
  }

  private errorResult(call: ToolCallPart, content: string): ToolResultPart {
    return { type: 'tool_result', callId: call.id, name: call.name, content, isError: true }
  }

  private appendResults(thread: Thread, parts: ToolResultPart[]): void {
    thread.messages.push({ id: newId('m_'), role: 'tool', parts, createdAt: Date.now() })
    this.publish(thread)
  }

  private async executeCalls(thread: Thread, calls: ToolCallPart[], tools: Tool[], mode: PermissionMode, signal: AbortSignal): Promise<void> {
    const message: Message = { id: newId('m_'), role: 'tool', parts: [], createdAt: Date.now() }
    thread.messages.push(message)
    for (const call of calls) {
      const result = signal.aborted
        ? this.errorResult(call, 'Cancelado pelo usuário.')
        : await this.executeCall(thread, call, tools, mode, signal)
      message.parts.push(result)
      this.publish(thread)
    }
  }

  private async executeCall(thread: Thread, call: ToolCallPart, tools: Tool[], mode: PermissionMode, signal: AbortSignal): Promise<ToolResultPart> {
    const checked = this.checkCall(call, tools)
    if ('error' in checked) return this.errorResult(call, checked.error)
    const { tool, input } = checked
    // Asking is itself waiting for the person, so it needs no permission, in any mode.
    if (tool.name === ASK_TOOL && this.deps.askUser) return this.ask(thread.id, call, (input as { questions: Question[] }).questions, signal)

    const risk = tool.risk(input)
    const permission = permissionFor(risk, mode, thread.allowedTools.includes(tool.name))
    if (permission === 'deny') {
      return { ...this.errorResult(call, 'Bloqueado: esta conversa está no modo somente leitura.'), denied: true }
    }
    if (permission === 'ask') {
      const approval: ApprovalRequest = { id: newId('a_'), callId: call.id, tool: tool.name, risk, preview: tool.preview(input) }
      const decision = await this.deps.requestApproval(thread.id, approval, signal)
      if (decision === 'deny') {
        return { ...this.errorResult(call, signal.aborted ? 'Cancelado pelo usuário.' : 'O usuário negou esta ação.'), denied: true }
      }
      if (decision === 'allow-always') thread.allowedTools.push(tool.name)
    }
    if (tool.name === PLAN_TOOL) thread.plan = (input as { items: PlanItem[] }).items
    return this.run(tool, call, input, signal)
  }

  private checkCall(call: ToolCallPart, tools: Tool[]): { tool: Tool; input: Record<string, unknown> } | { error: string } {
    if (call.invalid !== undefined) return { error: `Os argumentos não eram JSON válido: ${call.invalid.slice(0, 500)}` }
    const tool = tools.find((candidate) => candidate.name === call.name)
    if (!tool) return { error: `Ferramenta indisponível: ${call.name}` }
    const input = (call.input ?? {}) as Record<string, unknown>
    const problem = inputProblem(tool, input)
    if (problem) return { error: `Argumentos inválidos: ${problem}` }
    return { tool, input }
  }

  private async ask(threadId: string, call: ToolCallPart, questions: Question[], signal: AbortSignal): Promise<ToolResultPart> {
    const answers = await this.deps.askUser!(threadId, { id: newId('q_'), callId: call.id, questions }, signal)
    if (signal.aborted) return this.errorResult(call, 'Cancelado pelo usuário.')
    const content = answers ? describeAnswers(questions, answers) : 'O usuário pulou estas perguntas. Siga com o que fizer mais sentido e diga o que escolheu, ou pergunte de outro jeito.'
    return { type: 'tool_result', callId: call.id, name: call.name, content }
  }

  private async run(tool: Tool, call: ToolCallPart, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResultPart> {
    const output = await tool.run(input, signal).catch((error: Error) => ({ content: error.message, isError: true }))
    return { type: 'tool_result', callId: call.id, name: call.name, content: output.content, ...(output.isError ? { isError: true } : {}) }
  }

}
