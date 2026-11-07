import { GoogleGenAI, type Content, type Part as GeminiPart } from '@google/genai'
import type { Message, ModelInfo, Part, StopReason } from '../../shared/types'
import { contextOf, generatedCallId, replayable, toolResultsOf } from './history'
import {
  AbortedError,
  describeError,
  isAbort,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderConnection,
  type ToolSpec
} from './types'

// Google's documented value for function calls Gemini did not generate, such as a
// thread that started on another model. Without it, Gemini 3 and later reject the call.
const FOREIGN_CALL_SIGNATURE = 'context_engineering_is_the_way_to_go'
const RETRY_DELAYS_MS = [1000, 3000]
const NOT_TEXT = /embedding|aqa|imagen|veo|tts|image|live|native-audio|learnlm/i

function acceptsForeignSignature(modelId: string): boolean {
  return !/^gemini-[12](\.|-|$)/.test(modelId)
}

const SCHEMA_KEYS = new Set([
  'type',
  'description',
  'enum',
  'format',
  'items',
  'properties',
  'required',
  'nullable',
  'anyOf',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'title'
])

/** Gemini takes a subset of OpenAPI, not full JSON Schema: unknown keywords are a 400. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const source = schema as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toGeminiSchema(child)]))
    } else if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((entry) => entry !== 'null')
      result.type = types[0] ?? 'string'
      if (types.length !== value.length) result.nullable = true
    } else if (key === 'items' || key === 'anyOf') {
      result[key] = toGeminiSchema(value)
    } else {
      result[key] = value
    }
  }
  if (source.const !== undefined) result.enum = [source.const]
  return result
}

function declarationOf(tool: ToolSpec) {
  const properties = (tool.schema as { properties?: Record<string, unknown> }).properties
  const hasParameters = properties && Object.keys(properties).length > 0
  return {
    name: tool.name,
    description: tool.description,
    ...(hasParameters ? { parameters: toGeminiSchema(tool.schema) as never } : {})
  }
}

export function toGeminiContents(messages: Message[], target: ModelInfo, replayRaw: boolean): Content[] {
  const contents: Content[] = []
  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (parts.length === 0) return
    const last = contents.at(-1)
    if (last && last.role === role) last.parts!.push(...parts)
    else contents.push({ role, parts: [...parts] })
  }
  const nativeIds = new Set<string>()

  for (const message of contextOf(messages)) {
    if (message.role === 'tool') {
      push(
        'user',
        toolResultsOf(message).map((part) => ({
          functionResponse: {
            // Only ids Gemini itself issued can be echoed back.
            ...(nativeIds.has(part.callId) ? { id: part.callId } : {}),
            name: part.name,
            response: part.isError ? { error: part.content } : { output: part.content }
          }
        }))
      )
      continue
    }
    if (message.role === 'assistant' && replayRaw && replayable(message, target, false)) {
      const parts = message.raw!.data as GeminiPart[]
      for (const part of parts) if (part.functionCall?.id) nativeIds.add(part.functionCall.id)
      push('model', parts)
      continue
    }
    const parts: GeminiPart[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) parts.push({ text: part.text })
      if (part.type === 'tool_call') {
        parts.push({
          functionCall: { name: part.name, args: (part.input ?? {}) as Record<string, unknown> },
          ...(acceptsForeignSignature(target.id) ? { thoughtSignature: FOREIGN_CALL_SIGNATURE } : {})
        })
      }
    }
    push(message.role === 'user' ? 'user' : 'model', parts)
  }
  return contents
}

function stopOf(finish: string | undefined, blocked: boolean, hasCalls: boolean): StopReason {
  if (blocked) return 'refusal'
  if (finish === 'MAX_TOKENS') return 'length'
  if (finish && finish !== 'STOP' && finish !== 'FINISH_REASON_UNSPECIFIED') return 'refusal'
  return hasCalls ? 'tool_use' : 'end'
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  return status === 429 || status === 500 || status === 503
}

export function createGeminiAdapter(connection: ProviderConnection): ProviderAdapter {
  const ai = new GoogleGenAI({
    // Explicit, so an environment variable can't silently switch this connection to Vertex AI.
    vertexai: false,
    apiKey: connection.apiKey ?? 'missing',
    ...(connection.official ? {} : { httpOptions: { baseUrl: connection.baseUrl } })
  })

  const attempt = async (
    request: CompletionRequest,
    onEvent: Parameters<ProviderAdapter['stream']>[1],
    onOutput: () => void
  ): Promise<CompletionResult> => {
    const { model, system, messages, tools, signal, replayRaw } = request
    const stream = await ai.models.generateContentStream({
      model: model.id,
      contents: toGeminiContents(messages, model, replayRaw),
      config: {
        systemInstruction: system,
        abortSignal: signal,
        ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools.map(declarationOf) }] } : {}),
        ...(model.thinking ? { thinkingConfig: { includeThoughts: true } } : {})
      }
    })

    const rawParts: GeminiPart[] = []
    const parts: Part[] = []
    let usage: CompletionResult['usage']
    let finish: string | undefined
    let blocked = false

    const appendText = (type: 'text' | 'reasoning', text: string): void => {
      const last = parts.at(-1)
      if (last?.type === type) last.text += text
      else parts.push({ type, text })
    }

    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) blocked = true
      if (chunk.usageMetadata) {
        usage = {
          input: chunk.usageMetadata.promptTokenCount ?? 0,
          output: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
          cached: chunk.usageMetadata.cachedContentTokenCount
        }
      }
      const candidate = chunk.candidates?.[0]
      if (!candidate) continue
      if (candidate.finishReason) finish = candidate.finishReason
      for (const part of candidate.content?.parts ?? []) {
        rawParts.push(part)
        onOutput()
        if (part.functionCall?.name) {
          parts.push({
            type: 'tool_call',
            id: part.functionCall.id ?? generatedCallId(),
            name: part.functionCall.name,
            input: part.functionCall.args ?? {}
          })
        } else if (part.text) {
          const kind = part.thought ? 'reasoning' : 'text'
          appendText(kind, part.text)
          onEvent({ type: kind, text: part.text })
        }
      }
    }

    return {
      parts,
      stop: stopOf(finish, blocked, parts.some((part) => part.type === 'tool_call')),
      usage,
      raw: rawParts
    }
  }

  return {
    async listModels() {
      const models: ModelInfo[] = []
      try {
        const pager = await ai.models.list({ config: { pageSize: 1000 } })
        for await (const model of pager) {
          const id = (model.name ?? '').replace(/^models\//, '')
          if (!id || NOT_TEXT.test(id)) continue
          if (model.supportedActions && !model.supportedActions.includes('generateContent')) continue
          models.push({
            provider: connection.id,
            providerName: connection.name,
            id,
            label: model.displayName || id,
            contextWindow: model.inputTokenLimit,
            maxOutput: model.outputTokenLimit,
            thinking: (model as { thinking?: boolean }).thinking === true
          })
        }
        return models
      } catch (error) {
        throw describeError(error, connection.name)
      }
    },

    async stream(request, onEvent) {
      for (let retry = 0; ; retry++) {
        let produced = false
        try {
          return await attempt(request, onEvent, () => {
            produced = true
          })
        } catch (error) {
          if (isAbort(error, request.signal)) throw new AbortedError()
          if (!produced && retry < RETRY_DELAYS_MS.length && isRetryable(error)) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[retry]))
            continue
          }
          throw describeError(error, connection.name)
        }
      }
    }
  }
}
