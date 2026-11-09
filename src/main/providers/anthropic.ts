import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { clampEffort, EFFORT_LEVELS, type Message, type ModelInfo, type Part, type StopReason } from '../../shared/types'
import { attachmentAsText, contextOf, isImage, isPdf, replayable, safeToolId, toolResultsOf } from './history'
import {
  AbortedError,
  describeError,
  isAbort,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderConnection,
  type StreamEvent
} from './types'

// Curate selectable versions without inventing availability or API capabilities.
const SELECTABLE_MODELS = /^claude-(?:sonnet-5-5|haiku-5-5|opus-5-5|fable-5-1|haiku-4-5|sonnet-4-6)(?:-\d{8})?$/

const MAX_OUTPUT = 64000
const UNKNOWN_MODEL_MAX_OUTPUT = 8192
const MAX_REISSUES = 2

const THINKING_CONTROLS_BETA = 'thinking-binding-controls-2026-08-01'
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MODELS_WITH_SERVER_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** Consecutive same-role messages are merged: tool results and the next user turn share one message. */
export function toAnthropicMessages(messages: Message[], target: ModelInfo, replayRaw: boolean): BetaMessageParam[] {
  const result: BetaMessageParam[] = []
  const push = (role: 'user' | 'assistant', content: BetaContentBlockParam[]): void => {
    if (content.length === 0) return
    const last = result.at(-1)
    if (last && last.role === role) (last.content as BetaContentBlockParam[]).push(...content)
    else result.push({ role, content: [...content] })
  }

  for (const message of contextOf(messages)) {
    if (message.role === 'tool') {
      push(
        'user',
        toolResultsOf(message).map((part) => ({
          type: 'tool_result' as const,
          tool_use_id: safeToolId(part.callId),
          content: part.content,
          ...(part.isError ? { is_error: true } : {})
        }))
      )
      continue
    }
    if (message.role === 'assistant' && replayRaw && replayable(message, target, true)) {
      // Verbatim, thinking included: the API drops what the current model can't read.
      push('assistant', message.raw!.data as BetaContentBlockParam[])
      continue
    }
    const content: BetaContentBlockParam[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text })
      if (part.type === 'attachment' && part.data) {
        if (isImage(part)) {
          content.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType as 'image/png', data: part.data } })
        } else if (isPdf(part)) {
          content.push({ type: 'document', title: part.name, source: { type: 'base64', media_type: 'application/pdf', data: part.data } })
        } else {
          content.push({ type: 'text', text: attachmentAsText(part) })
        }
      }
      if (part.type === 'tool_call') {
        content.push({
          type: 'tool_use',
          id: safeToolId(part.id),
          name: part.name,
          input: (part.input ?? {}) as Record<string, unknown>
        })
      }
    }
    push(message.role === 'user' ? 'user' : 'assistant', content)
  }
  return result
}

/**
 * After a mid-output fallback, only text from before the switch may be replayed;
 * thinking and tool use from the model that declined must go.
 */
function keepAfterFallback(blocks: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = blocks.findLastIndex((block) => block.type === 'fallback')
  if (boundary < 0) return blocks
  return blocks.filter((block, index) => index > boundary || block.type === 'text')
}

function partsOf(blocks: BetaContentBlock[]): Part[] {
  const parts: Part[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    if (block.type === 'thinking' && block.thinking) parts.push({ type: 'reasoning', text: block.thinking })
    if (block.type === 'tool_use') parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input })
  }
  return parts
}

function stopOf(reason: string | null | undefined): StopReason {
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length'
  if (reason === 'refusal') return 'refusal'
  return 'end'
}

export function buildAnthropicRequest(request: CompletionRequest, official: boolean): MessageCreateParamsStreaming {
  const { model, system, messages, tools, replayRaw } = request
  const betas: string[] = []
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: model.maxOutput ? Math.min(MAX_OUTPUT, model.maxOutput) : UNKNOWN_MODEL_MAX_OUTPUT,
    system,
    messages: toAnthropicMessages(messages, model, replayRaw),
    cache_control: { type: 'ephemeral' },
    stream: true
  }
  if (tools.length > 0) {
    params.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema as { type: 'object' },
      eager_input_streaming: true
    }))
  }
  if (model.thinking) {
    // The system prompt is frozen and history is append-only, but the tool set
    // can change when an MCP server connects. Degrade by dropping old thinking
    // in that case rather than failing the turn.
    params.thinking = {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' }
    } as MessageCreateParamsStreaming['thinking']
    betas.push(THINKING_CONTROLS_BETA)
  }
  // The app's default is "high", since this API's own default varies by model.
  const effort = request.effort !== null && model.efforts?.length ? clampEffort(request.effort ?? 'high', model.efforts) : undefined
  if (effort) params.output_config = { effort }
  if (official && MODELS_WITH_SERVER_FALLBACK.has(model.id)) {
    // Retries a policy decline on another model inside the same call. The label on
    // the message comes from the response, so the user sees who actually answered.
    ;(params as unknown as { fallbacks: string }).fallbacks = 'default'
    betas.push(SERVER_FALLBACK_BETA)
  }
  if (betas.length > 0) params.betas = betas
  return params
}

export function createAnthropicAdapter(connection: ProviderConnection): ProviderAdapter {
  const client = new Anthropic({
    apiKey: connection.apiKey ?? 'missing',
    // Explicit, so credentials and endpoints in the environment can't redirect this connection.
    authToken: null,
    baseURL: connection.baseUrl
  })

  const attempt = async (
    params: MessageCreateParamsStreaming,
    signal: AbortSignal,
    onEvent: (event: StreamEvent) => void
  ): Promise<CompletionResult> => {
    const { stream: _stream, ...body } = params
    void _stream
    const stream = client.beta.messages.stream(body, { signal })
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') onEvent({ type: 'text', text: event.delta.text })
        if (event.delta.type === 'thinking_delta') onEvent({ type: 'reasoning', text: event.delta.thinking })
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        const block = event.content_block
        onEvent({ type: 'notice', text: `${block.from.model} recusou este pedido; ${block.to.model} continuou.` })
      }
    }
    const final = await stream.finalMessage()
    // A plain copy: the SDK attaches non-enumerable parser state to its blocks.
    const blocks = keepAfterFallback(JSON.parse(JSON.stringify(final.content)) as BetaContentBlock[])
    return {
      parts: partsOf(blocks),
      stop: stopOf(final.stop_reason),
      usage: {
        input: final.usage.input_tokens + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0),
        output: final.usage.output_tokens,
        cached: final.usage.cache_read_input_tokens ?? undefined
      },
      raw: blocks,
      servedModel: final.model
    }
  }

  return {
    async listModels(signal) {
      const models: ModelInfo[] = []
      for await (const model of client.models.list({ limit: 1000 }, { signal })) {
        if (connection.id === 'anthropic' && !SELECTABLE_MODELS.test(model.id)) continue
        const caps = (model as unknown as { capabilities?: Record<string, any> }).capabilities
        const detail = model as unknown as { max_input_tokens?: number; max_tokens?: number }
        models.push({
          provider: connection.id,
          providerName: connection.name,
          id: model.id,
          label: model.display_name || model.id,
          contextWindow: detail.max_input_tokens,
          maxOutput: detail.max_tokens,
          thinking: caps?.thinking?.types?.adaptive?.supported === true,
          efforts: EFFORT_LEVELS.filter((level) => caps?.effort?.[level]?.supported === true)
        })
      }
      return models
    },

    async stream(request, onEvent) {
      const params = buildAnthropicRequest(request, connection.official)
      for (let reissue = 0; ; reissue++) {
        try {
          return await attempt(params, request.signal, onEvent)
        } catch (error) {
          if (isAbort(error, request.signal)) throw new AbortedError()
          // With eager input streaming, the SDK raises a plain error on tool input
          // it cannot parse at all. API errors stay typed and are not retried here.
          const unparsable = !(error instanceof Anthropic.APIError) && !(error as { status?: number }).status
          const isConnectionIssue = /connection|fetch failed|network|socket/i.test((error as Error).message ?? '')
          if (unparsable && !isConnectionIssue && reissue < MAX_REISSUES) {
            onEvent({ type: 'reset' })
            continue
          }
          throw describeError(error, connection.name)
        }
      }
    }
  }
}
