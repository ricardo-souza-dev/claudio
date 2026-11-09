import type OpenAI from 'openai'
import type { ModelInfo } from '../../shared/types'
import { describeError, type ProviderConnection } from './types'

const NOT_TEXT =
  /embed|whisper|tts|transcri|moderation|dall-e|image|sora|video|realtime|audio|speech|rerank|instruct|davinci|babbage|guard|ocr/i

export function isTextModel(id: string): boolean {
  return !NOT_TEXT.test(id)
}

// Product curation only: availability and metadata still come from the API/catalog.
const OPENAI_SELECTION = new Set(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6'])

export function isSelectableOpenAiModel(id: string): boolean {
  return OPENAI_SELECTION.has(id)
}

interface RawModel {
  id: string
  name?: string
  context_length?: number
  max_model_len?: number
  capabilities?: { completion_chat?: boolean }
}

/** Reads /models directly, because some OpenAI-compatible servers answer with a bare array. */
export async function listOpenAiStyleModels(
  client: OpenAI,
  connection: ProviderConnection,
  keep: (id: string) => boolean,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  try {
    // No retries: a local server that isn't running should not delay the whole list.
    const body = await client.get<RawModel[] | { data?: RawModel[] }>('/models', { signal, maxRetries: 0 })
    const list = Array.isArray(body) ? body : (body.data ?? [])
    return list
      .filter((model) => typeof model.id === 'string' && keep(model.id) && model.capabilities?.completion_chat !== false)
      .map((model) => ({
        provider: connection.id,
        providerName: connection.name,
        id: model.id,
        label: model.name || model.id,
        contextWindow: model.context_length ?? model.max_model_len
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  } catch (error) {
    throw describeError(error, connection.name)
  }
}
