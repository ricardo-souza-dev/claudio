import { createHash, randomUUID } from 'node:crypto'
import type { AttachmentPart, Message, ModelInfo, Part, ToolCallPart, ToolResultPart } from '../../shared/types'

const FLATTENED_RESULT_LIMIT = 4000

export function newId(prefix = ''): string {
  return prefix + randomUUID().replaceAll('-', '')
}

/** Ids we create ourselves because the provider sent none (Gemini often doesn't). */
export function generatedCallId(): string {
  return newId('gen_')
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export function isImage(part: AttachmentPart): boolean {
  return part.mediaType.startsWith('image/')
}

export function isPdf(part: AttachmentPart): boolean {
  return part.mediaType === 'application/pdf'
}

/** Every protocol reads text attachments the same way: as text, with the file's name. */
export function attachmentAsText(part: AttachmentPart): string {
  const content = part.data ? Buffer.from(part.data, 'base64').toString('utf8') : ''
  return `Arquivo anexado: ${part.name}\n\`\`\`\n${content}\n\`\`\``
}

export function toolCallsOf(message: Message): ToolCallPart[] {
  return message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
}

export function toolResultsOf(message: Message): ToolResultPart[] {
  return message.parts.filter((part): part is ToolResultPart => part.type === 'tool_result')
}

/**
 * Providers disagree on what a tool call id may look like, and a thread can carry
 * ids minted by any of them. The mapping is a pure function of the id, so the same
 * history always serializes to the same bytes.
 */
export function safeToolId(id: string, style: 'default' | 'short' = 'default'): string {
  if (style === 'short') {
    return createHash('sha1').update(id).digest('hex').slice(0, 9)
  }
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id
  return `call_${createHash('sha1').update(id).digest('hex').slice(0, 32)}`
}

/**
 * What a model may see of a thread: refused turns removed, and every tool call
 * answered, since all providers reject a dangling call. The run loop records
 * real results when it cancels; this is the safety net for threads that were
 * interrupted hard, such as the app closing mid-tool.
 */
export function contextOf(messages: Message[]): Message[] {
  const visible = messages.filter((message) => !message.excluded)
  const result: Message[] = []
  for (let i = 0; i < visible.length; i++) {
    const message = visible[i]
    result.push(message)
    const calls = message.role === 'assistant' ? toolCallsOf(message) : []
    if (calls.length === 0) continue
    const next = visible[i + 1]
    const answered = new Set(next?.role === 'tool' ? toolResultsOf(next).map((part) => part.callId) : [])
    const missing = calls.filter((call) => !answered.has(call.id))
    if (missing.length === 0) continue
    const synthetic: ToolResultPart[] = missing.map((call) => ({
      type: 'tool_result',
      callId: call.id,
      name: call.name,
      content: 'A chamada foi interrompida antes de terminar.',
      isError: true
    }))
    if (next?.role === 'tool') {
      visible[i + 1] = { ...next, parts: [...next.parts, ...synthetic] }
    } else {
      result.push({ id: `${message.id}-interrupted`, role: 'tool', parts: synthetic, createdAt: message.createdAt })
    }
  }
  return result
}

/**
 * Rewrites tool activity as plain text, for a model that rejects function calling.
 * Provider-specific wire data is dropped along with it.
 */
export function flattenHistory(messages: Message[]): Message[] {
  const flat: Message[] = []
  for (const message of contextOf(messages)) {
    if (message.role === 'tool') {
      const text = toolResultsOf(message)
        .map((part) => {
          const content =
            part.content.length > FLATTENED_RESULT_LIMIT
              ? `${part.content.slice(0, FLATTENED_RESULT_LIMIT)}\n[…${part.content.length - FLATTENED_RESULT_LIMIT} caracteres omitidos]`
              : part.content
          return `(Resultado de ${part.name}${part.isError ? ', com erro' : ''}: ${content})`
        })
        .join('\n')
      flat.push({ id: message.id, role: 'user', parts: [{ type: 'text', text }], createdAt: message.createdAt })
      continue
    }
    // What the user wrote and attached stays as it is: only tool activity becomes text.
    if (message.role === 'user') {
      flat.push(message)
      continue
    }
    const pieces: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) pieces.push(part.text)
      if (part.type === 'tool_call') pieces.push(`(Executei ${part.name} com ${JSON.stringify(part.input)})`)
    }
    if (pieces.length === 0) continue
    flat.push({
      id: message.id,
      role: message.role,
      parts: [{ type: 'text', text: pieces.join('\n') }],
      createdAt: message.createdAt,
      model: message.model
    })
  }
  return flat
}

/**
 * Can this message be replayed in its original wire format? Anthropic reads its
 * own history across models and drops what a model can't read. Reasoning items and
 * thought signatures from OpenAI and Google are only safe with the model that wrote them.
 */
export function replayable(message: Message, target: ModelInfo, anyModel: boolean): boolean {
  if (!message.raw || message.raw.provider !== target.provider) return false
  return anyModel || message.raw.model === target.id
}

/** Reduces a JSON schema to what every provider accepts, keeping its top-level shape an object. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const source = schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : {}
  const { $schema: _ignored, ...rest } = source
  void _ignored
  return { ...rest, type: 'object', properties: rest.properties ?? {} }
}
