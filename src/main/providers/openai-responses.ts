import OpenAI from 'openai'
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses'
import type { Message, ModelInfo, Part, StopReason } from '../../shared/types'
import { contextOf, replayable, safeToolId, textOf, toolResultsOf } from './history'
import { isTextModel, listOpenAiStyleModels } from './openai-models'
import {
  AbortedError,
  describeError,
  isAbort,
  ProviderError,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderConnection
} from './types'

export function toResponsesInput(messages: Message[], target: ModelInfo, replayRaw: boolean): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  for (const message of contextOf(messages)) {
    if (message.role === 'tool') {
      for (const part of toolResultsOf(message)) {
        input.push({ type: 'function_call_output', call_id: safeToolId(part.callId), output: part.content })
      }
      continue
    }
    if (message.role === 'assistant' && replayRaw && replayable(message, target, false)) {
      // Stateless mode: reasoning items carry encrypted content and must go back as they came.
      input.push(...(message.raw!.data as ResponseInputItem[]))
      continue
    }
    const text = textOf(message.parts)
    if (text) input.push({ role: message.role === 'user' ? 'user' : 'assistant', content: text })
    for (const part of message.parts) {
      if (part.type === 'tool_call') {
        input.push({
          type: 'function_call',
          call_id: safeToolId(part.id),
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        })
      }
    }
  }
  return input
}

function partsOf(output: ResponseOutputItem[]): { parts: Part[]; refused: boolean } {
  const parts: Part[] = []
  let refused = false
  for (const item of output) {
    if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map((entry) => entry.text).join('\n')
      if (text) parts.push({ type: 'reasoning', text })
    }
    if (item.type === 'message') {
      for (const piece of item.content) {
        if (piece.type === 'output_text') parts.push({ type: 'text', text: piece.text })
        if (piece.type === 'refusal') {
          refused = true
          parts.push({ type: 'text', text: piece.refusal })
        }
      }
    }
    if (item.type === 'function_call') {
      const call: Part = { type: 'tool_call', id: item.call_id, name: item.name, input: {} }
      try {
        call.input = item.arguments ? JSON.parse(item.arguments) : {}
      } catch {
        call.invalid = item.arguments
      }
      parts.push(call)
    }
  }
  return { parts, refused }
}

export function createResponsesAdapter(connection: ProviderConnection): ProviderAdapter {
  const client = new OpenAI({
    apiKey: connection.apiKey ?? 'missing',
    baseURL: connection.baseUrl,
    // Organization ids from the environment belong to OpenAI, not to other endpoints.
    ...(connection.official ? {} : { organization: null, project: null })
  })

  return {
    listModels: (signal) => listOpenAiStyleModels(client, connection, isTextModel, signal),

    async stream(request, onEvent): Promise<CompletionResult> {
      const { model, system, messages, tools, signal, replayRaw } = request
      try {
        const stream = await client.responses.create(
          {
            model: model.id,
            instructions: system,
            input: toResponsesInput(messages, model, replayRaw),
            store: false,
            stream: true,
            ...(tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    type: 'function' as const,
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.schema,
                    strict: false
                  }))
                }
              : {})
          },
          { signal }
        )

        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') onEvent({ type: 'text', text: event.delta })
          if (event.type === 'response.refusal.delta') onEvent({ type: 'text', text: event.delta })
          if (event.type === 'response.reasoning_summary_text.delta') onEvent({ type: 'reasoning', text: event.delta })
          if (event.type === 'error') throw new ProviderError(`${connection.name}: ${event.message}`)
          if (event.type === 'response.failed') {
            throw new ProviderError(`${connection.name}: ${event.response.error?.message ?? 'a resposta falhou'}`)
          }
          if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            const { response } = event
            const { parts, refused } = partsOf(response.output)
            const reason = response.incomplete_details?.reason
            let stop: StopReason = parts.some((part) => part.type === 'tool_call') ? 'tool_use' : 'end'
            if (reason === 'max_output_tokens') stop = 'length'
            if (refused || reason === 'content_filter') stop = 'refusal'
            return {
              parts,
              stop,
              raw: response.output,
              servedModel: response.model,
              usage: response.usage
                ? {
                    input: response.usage.input_tokens,
                    output: response.usage.output_tokens,
                    cached: response.usage.input_tokens_details?.cached_tokens
                  }
                : undefined
            }
          }
        }
        throw new ProviderError(`${connection.name} encerrou a resposta antes do fim.`)
      } catch (error) {
        if (isAbort(error, signal)) throw new AbortedError()
        throw describeError(error, connection.name)
      }
    }
  }
}
