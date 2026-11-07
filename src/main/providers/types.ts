import type { Message, ModelInfo, Part, Protocol, StopReason, Usage } from '../../shared/types'

/** A tool as every provider sees it: same name, description and schema everywhere. */
export interface ToolSpec {
  name: string
  description: string
  schema: Record<string, unknown>
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** Discard what was streamed so far: the turn is being issued again. */
  | { type: 'reset' }
  | { type: 'notice'; text: string }

export interface CompletionRequest {
  model: ModelInfo
  system: string
  messages: Message[]
  tools: ToolSpec[]
  /** Replay the provider's own wire format when possible. Off when history is flattened to text. */
  replayRaw: boolean
  signal: AbortSignal
}

export interface CompletionResult {
  parts: Part[]
  stop: StopReason
  usage?: Usage
  raw?: unknown
  /** Set when the provider served the turn with a different model than requested. */
  servedModel?: string
}

export interface ProviderAdapter {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  stream(request: CompletionRequest, onEvent: (event: StreamEvent) => void): Promise<CompletionResult>
}

export interface ProviderConnection {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  /** True when baseUrl is the vendor's own endpoint, which unlocks vendor-only features. */
  official: boolean
  apiKey: string | null
  /** Quirks of OpenAI-compatible servers. */
  quirks?: { noStreamOptions?: boolean; shortToolIds?: boolean }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly toolsUnsupported = false
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class AbortedError extends Error {
  constructor() {
    super('Interrompido')
    this.name = 'AbortedError'
  }
}

export function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'APIUserAbortError' || name === 'AbortedError'
}

const TOOLS_UNSUPPORTED = /(does not|doesn't|do not|not) (support|allow).{0,40}(tool|function)|(tool|function).{0,40}(not supported|unsupported|not available|not allowed)/i

/** Turns any SDK error into a message a person can act on. */
export function describeError(error: unknown, providerName: string): ProviderError {
  if (error instanceof ProviderError) return error
  const e = error as { status?: number; code?: number; message?: string } | null
  const status = e?.status ?? (typeof e?.code === 'number' ? e.code : undefined)
  const detail = (e?.message ?? String(error)).trim()
  const toolsUnsupported = status !== undefined && status >= 400 && status < 500 && TOOLS_UNSUPPORTED.test(detail)
  const prefix: Record<number, string> = {
    401: `${providerName} recusou a chave de API. Confira em Ajustes.`,
    403: `${providerName} negou acesso a este modelo com a sua chave.`,
    404: `${providerName} não encontrou este modelo.`,
    429: `${providerName} atingiu o limite de uso. Aguarde um pouco ou troque de modelo.`
  }
  const known = status !== undefined ? prefix[status] : undefined
  const server = status !== undefined && status >= 500 ? `${providerName} está instável (${status}). Tente de novo ou troque de modelo.` : undefined
  const network = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Connection error|net::ERR/i.test(detail)
    ? `Não foi possível falar com ${providerName}. Verifique a conexão e o endereço.`
    : undefined
  const summary = known ?? server ?? network
  const message = summary ? `${summary}\n${detail}` : `${providerName}: ${detail}`
  return new ProviderError(message, status, toolsUnsupported)
}
