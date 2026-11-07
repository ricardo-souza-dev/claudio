import Ajv, { type ValidateFunction } from 'ajv'
import {
  MAIN_STREAM,
  modelKey,
  type ApprovalDecision,
  type ApprovalRequest,
  type CouncilVoice,
  type LiveVoice,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Part,
  type PermissionMode,
  type SendRequest,
  type Thread,
  type ToolCallPart,
  type ToolResultPart,
  type UniEvent
} from '../../shared/types'
import { flattenHistory, newId, textOf, toolCallsOf } from '../providers/history'
import { AbortedError, ProviderError, type ProviderAdapter } from '../providers/types'
import { permissionFor, type Tool } from '../tools/types'
import { buildSystemPrompt } from './context'

const MAX_AGENT_STEPS = 40
const MAX_VOICE_STEPS = 8
const TITLE_LENGTH = 60

export interface RunnerDeps {
  resolveModel(ref: ModelRef): Promise<{ adapter: ProviderAdapter; info: ModelInfo }>
  toolsFor(workspace: string | null): Tool[]
  memory(): string
  emit(event: UniEvent): void
  save(thread: Thread): Promise<void>
  requestApproval(threadId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
}

interface TurnOptions {
  info: ModelInfo
  adapter: ProviderAdapter
  system: string
  messages: Message[]
  tools: Tool[]
  replayRaw: boolean
  threadId: string
  stream: string
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
      if (text) {
        if (thread.messages.length === 0) thread.title = text.replace(/\s+/g, ' ').slice(0, TITLE_LENGTH)
        thread.messages.push({
          id: newId('m_'),
          role: 'user',
          parts: [{ type: 'text', text }],
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

      if (request.mode === 'council') {
        await this.runCouncil(thread, request.voices, request.model, controller.signal)
      } else {
        await this.runAgent(thread, request.model, request.permissionMode, controller.signal)
      }
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
    const { info, adapter, system, tools, threadId, stream, signal } = options
    let { messages, replayRaw } = options
    let toolList = tools
    let toolsDropped = false
    for (;;) {
      let partialText = ''
      let partialReasoning = ''
      try {
        const result = await adapter.stream(
          {
            model: info,
            system,
            messages,
            tools: toolList.map(({ name, description, schema }) => ({ name, description, schema })),
            replayRaw,
            signal
          },
          (event) => {
            if (event.type === 'text' || event.type === 'reasoning') {
              if (event.type === 'text') partialText += event.text
              else partialReasoning += event.text
              this.deps.emit({ type: 'delta', threadId, stream, kind: event.type, text: event.text })
            } else if (event.type === 'reset') {
              partialText = ''
              partialReasoning = ''
              this.deps.emit({ type: 'reset', threadId, stream })
            } else {
              this.deps.emit({ type: 'notice', threadId, text: event.text })
            }
          }
        )
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
          this.deps.emit({ type: 'reset', threadId, stream })
          this.deps.emit({ type: 'notice', threadId, text: `${info.label} não aceita ferramentas. Seguiu só com texto.` })
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

  private async runAgent(thread: Thread, ref: ModelRef, mode: PermissionMode, signal: AbortSignal): Promise<void> {
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
        stream: MAIN_STREAM,
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

  private async run(tool: Tool, call: ToolCallPart, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResultPart> {
    const output = await tool.run(input, signal).catch((error: Error) => ({ content: error.message, isError: true }))
    return { type: 'tool_result', callId: call.id, name: call.name, content: output.content, ...(output.isError ? { isError: true } : {}) }
  }

  /**
   * Many models, one answer. Voices work apart from the thread, with read-only tools
   * and no ability to change anything. Only the synthesis enters the history, so
   * whichever model continues afterwards inherits a single voice.
   */
  private async runCouncil(thread: Thread, voices: ModelRef[], synthesizer: ModelRef, signal: AbortSignal): Promise<void> {
    const threadId = thread.id
    const live: LiveVoice[] = voices.map((model) => ({ key: modelKey(model), model, status: 'running' }))
    const publishVoices = (phase: 'voices' | 'synthesis' | 'done'): void =>
      this.deps.emit({ type: 'council', threadId, phase, voices: live.map((voice) => ({ ...voice })) })
    publishVoices('voices')

    const history = flattenHistory(thread.messages)
    const readTools = this.deps.toolsFor(thread.workspace).filter((tool) => tool.readOnly)

    const results: CouncilVoice[] = await Promise.all(
      voices.map(async (model, index): Promise<CouncilVoice> => {
        try {
          const voice = await this.runVoice(thread, model, history, readTools, signal)
          live[index].status = 'done'
          publishVoices('voices')
          return voice
        } catch (error) {
          const text = error instanceof AbortedError ? 'Interrompido' : (error as Error).message
          live[index] = { ...live[index], status: 'error', error: text }
          publishVoices('voices')
          return { model, text: '', error: text }
        }
      })
    )
    if (signal.aborted) {
      publishVoices('done')
      throw new AbortedError()
    }

    const answered = results.filter((voice) => !voice.error && voice.text.trim())
    if (answered.length === 0) {
      publishVoices('done')
      throw new Error(`Nenhum modelo do conselho respondeu.\n${results.map((voice) => voice.error).filter(Boolean).join('\n')}`)
    }

    if (answered.length === 1) {
      // Nothing to reconcile: use the only answer as it is, without paying for a synthesis.
      thread.messages.push({
        id: newId('m_'),
        role: 'assistant',
        parts: [{ type: 'text', text: answered[0].text }],
        createdAt: Date.now(),
        model: answered[0].model,
        usage: answered[0].usage,
        stop: 'end',
        council: { voices: results }
      })
      publishVoices('done')
      return
    }

    publishVoices('synthesis')
    const { adapter, info } = await this.deps.resolveModel(synthesizer)
    const outcome = await this.streamTurn({
      info,
      adapter,
      system: thread.system!,
      messages: [...history, councilBrief(answered)],
      tools: [],
      replayRaw: false,
      threadId,
      stream: MAIN_STREAM,
      signal
    })
    const message = this.assistantMessage(outcome, synthesizer, threadId, false)
    message.council = { voices: results }
    if (outcome.parts.length > 0 || outcome.result) thread.messages.push(message)
    publishVoices('done')
  }

  private async runVoice(thread: Thread, ref: ModelRef, history: Message[], tools: Tool[], signal: AbortSignal): Promise<CouncilVoice> {
    const { adapter, info } = await this.deps.resolveModel(ref)
    const messages = [...history]
    const usage = { input: 0, output: 0 }
    for (let step = 0; step < MAX_VOICE_STEPS; step++) {
      const outcome = await this.streamTurn({
        info,
        adapter,
        system: thread.system!,
        messages,
        tools,
        replayRaw: false,
        threadId: thread.id,
        stream: modelKey(ref),
        signal
      })
      const { result } = outcome
      if (!result) throw new AbortedError()
      usage.input += result.usage?.input ?? 0
      usage.output += result.usage?.output ?? 0
      if (result.stop === 'refusal') throw new Error(`${info.label} recusou este pedido.`)

      const message = this.assistantMessage(outcome, ref, thread.id, false)
      messages.push(message)
      const calls = toolCallsOf(message)
      if (calls.length === 0 || outcome.toolsDropped || result.stop === 'length') {
        return { model: message.model ?? ref, text: textOf(outcome.parts), usage }
      }
      const parts: ToolResultPart[] = []
      for (const call of calls) {
        const checked = this.checkCall(call, tools)
        if ('error' in checked) {
          parts.push(this.errorResult(call, checked.error))
        } else if (checked.tool.risk(checked.input) !== 'read') {
          // A voice has nobody to ask, so anything beyond a plain read is refused.
          parts.push(this.errorResult(call, 'Bloqueado: no conselho só é possível ler arquivos comuns.'))
        } else {
          parts.push(await this.run(checked.tool, call, checked.input, signal))
        }
      }
      messages.push({ id: newId('m_'), role: 'tool', parts, createdAt: Date.now() })
    }
    throw new Error(`${info.label} excedeu o limite de passos no conselho.`)
  }
}

function councilBrief(voices: CouncilVoice[]): Message {
  const answers = voices
    .map((voice) => `<answer model="${modelKey(voice.model)}">\n${voice.text.trim()}\n</answer>`)
    .join('\n\n')
  return {
    id: newId('m_'),
    role: 'user',
    createdAt: Date.now(),
    parts: [
      {
        type: 'text',
        text: `Several models answered my last message independently:\n\n${answers}\n\nWrite the single final answer to me, in the language I wrote in. Keep what is right and correct what is wrong. Where the answers disagree on something that matters, say so and say which view you favor and why. Do not describe this process, and do not name the models unless a disagreement requires it.`
      }
    ]
  }
}
