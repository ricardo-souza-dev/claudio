import OpenAI from 'openai'
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { clampEffort, type Message, type Part, type StopReason } from '../../shared/types'
import { attachmentAsText, contextOf, generatedCallId, isImage, isPdf, safeToolId, textOf, toolCallsOf, toolResultsOf } from './history'
import { isTextModel, listOpenAiStyleModels } from './openai-models'
import {
  AbortedError,
  describeError,
  isAbort,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderConnection
} from './types'

/** Plain text stays a plain string: some compatible servers only accept the array form with images. */
function userContent(message: Message, text: string): string | ChatCompletionContentPart[] | null {
  const images: ChatCompletionContentPart[] = []
  const texts: string[] = []
  for (const part of message.parts) {
    if (part.type !== 'attachment' || !part.data) continue
    if (isImage(part)) images.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } })
    else if (isPdf(part)) texts.push(`[PDF anexado: ${part.name}. Este provedor não lê PDFs.]`)
    else texts.push(attachmentAsText(part))
  }
  const combined = [...texts, text].filter(Boolean).join('\n\n')
  if (images.length === 0) return combined || null
  return [...images, ...(combined ? [{ type: 'text' as const, text: combined }] : [])]
}

export function toChatMessages(
  system: string,
  messages: Message[],
  idStyle: 'default' | 'short'
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const message of contextOf(messages)) {
    if (message.role === 'tool') {
      for (const part of toolResultsOf(message)) {
        result.push({ role: 'tool', tool_call_id: safeToolId(part.callId, idStyle), content: part.content })
      }
      continue
    }
    const text = textOf(message.parts)
    if (message.role === 'user') {
      const content = userContent(message, text)
      if (content) result.push({ role: 'user', content })
      continue
    }
    const calls = toolCallsOf(message)
    if (!text && calls.length === 0) continue
    result.push({
      role: 'assistant',
      content: text,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: safeToolId(call.id, idStyle),
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) }
            }))
          }
        : {})
    })
  }
  return result
}

interface PendingCall {
  id?: string
  name: string
  args: string
}

/** Covers every server that speaks OpenAI Chat Completions: xAI, DeepSeek, Groq, OpenRouter, Ollama… */
export function createChatAdapter(connection: ProviderConnection): ProviderAdapter {
  const client = new OpenAI({
    apiKey: connection.apiKey ?? 'not-needed',
    baseURL: connection.baseUrl,
    // Organization ids from the environment belong to OpenAI, not to these servers.
    organization: null,
    project: null
  })
  const idStyle = connection.quirks?.shortToolIds ? 'short' : 'default'

  return {
    listModels: (signal) => listOpenAiStyleModels(client, connection, isTextModel, signal),

    async stream(request, onEvent): Promise<CompletionResult> {
      const { model, system, messages, tools, signal } = request
      const effort = request.effort && model.efforts?.length ? clampEffort(request.effort, model.efforts) : undefined
      try {
        const stream = await client.chat.completions.create(
          {
            model: model.id,
            messages: toChatMessages(system, messages, idStyle),
            stream: true,
            ...(effort ? { reasoning_effort: effort as 'low' | 'medium' | 'high' } : {}),
            ...(connection.quirks?.noStreamOptions ? {} : { stream_options: { include_usage: true } }),
            ...(tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    type: 'function' as const,
                    function: { name: tool.name, description: tool.description, parameters: tool.schema }
                  }))
                }
              : {})
          },
          { signal }
        )

        let text = ''
        let reasoning = ''
        let finish: string | null = null
        let usage: CompletionResult['usage']
        const pending = new Map<number, PendingCall>()

        for await (const chunk of stream) {
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens,
              output: chunk.usage.completion_tokens,
              cached: chunk.usage.prompt_tokens_details?.cached_tokens
            }
          }
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finish = choice.finish_reason
          const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string }
          if (delta.content) {
            text += delta.content
            onEvent({ type: 'text', text: delta.content })
          }
          const thought = delta.reasoning_content ?? delta.reasoning
          if (thought) {
            reasoning += thought
            onEvent({ type: 'reasoning', text: thought })
          }
          delta.tool_calls?.forEach((call, position) => {
            const index = call.index ?? position
            const entry = pending.get(index) ?? { name: '', args: '' }
            if (call.id) entry.id = call.id
            if (call.function?.name) entry.name += call.function.name
            if (call.function?.arguments) entry.args += call.function.arguments
            pending.set(index, entry)
          })
        }

        // The SDK ends the iteration quietly on abort instead of throwing.
        if (signal.aborted) throw new AbortedError()

        const parts: Part[] = []
        if (reasoning) parts.push({ type: 'reasoning', text: reasoning })
        if (text) parts.push({ type: 'text', text })
        for (const index of [...pending.keys()].sort((a, b) => a - b)) {
          const call = pending.get(index)!
          const part: Part = { type: 'tool_call', id: call.id ?? generatedCallId(), name: call.name, input: {} }
          try {
            part.input = call.args.trim() ? JSON.parse(call.args) : {}
          } catch {
            part.invalid = call.args
          }
          parts.push(part)
        }

        let stop: StopReason = pending.size > 0 ? 'tool_use' : 'end'
        if (finish === 'length') stop = 'length'
        if (finish === 'content_filter') stop = 'refusal'
        return { parts, stop, usage }
      } catch (error) {
        if (isAbort(error, signal)) throw new AbortedError()
        throw describeError(error, connection.name)
      }
    }
  }
}
