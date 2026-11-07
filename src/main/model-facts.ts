import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelPricing, Protocol } from '../shared/types'

const DEFAULT_URL = 'https://models.dev/api.json'
const CACHE_FILE = 'model-facts.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

/** Where a provider's name differs between this app's catalog and the public one. */
const CATALOG_NAMES: Record<string, string> = { together: 'togetherai' }

export interface ModelFacts {
  context?: number
  output?: number
  pricing?: ModelPricing
  reasoning?: boolean
  tools?: boolean
  imageInput?: boolean
  released?: string
  textOutput: boolean
}

interface FactsFile {
  fetchedAt: number
  providers: Record<string, Record<string, ModelFacts>>
}

/** Keeps only what is used: the public file is several megabytes. */
export function trimCatalog(raw: unknown): FactsFile['providers'] {
  const providers: FactsFile['providers'] = {}
  for (const [providerId, provider] of Object.entries((raw ?? {}) as Record<string, { models?: Record<string, any> }>)) {
    if (!provider?.models) continue
    const models: Record<string, ModelFacts> = {}
    for (const [modelId, entry] of Object.entries(provider.models)) {
      const cost = entry?.cost
      models[modelId] = {
        context: typeof entry?.limit?.context === 'number' ? entry.limit.context : undefined,
        output: typeof entry?.limit?.output === 'number' ? entry.limit.output : undefined,
        pricing:
          typeof cost?.input === 'number' && typeof cost?.output === 'number'
            ? { input: cost.input, output: cost.output, cacheRead: typeof cost.cache_read === 'number' ? cost.cache_read : undefined }
            : undefined,
        reasoning: typeof entry?.reasoning === 'boolean' ? entry.reasoning : undefined,
        tools: typeof entry?.tool_call === 'boolean' ? entry.tool_call : undefined,
        imageInput: Array.isArray(entry?.modalities?.input) ? entry.modalities.input.includes('image') : undefined,
        released: typeof entry?.release_date === 'string' ? entry.release_date : undefined,
        textOutput: !Array.isArray(entry?.modalities?.output) || entry.modalities.output.includes('text')
      }
    }
    providers[providerId] = models
  }
  return providers
}

/**
 * Context limits, prices and capabilities from models.dev, a public open-source catalog.
 * Several provider APIs don't report these. It only ever improves what is shown and how
 * "Automático" chooses: without it (offline, or the site is down) everything still works.
 */
export class ModelFactsStore {
  private providers: FactsFile['providers'] = {}
  private byModelId = new Map<string, ModelFacts>()

  constructor(
    private dir: string,
    private url = process.env.CLAUDIO_MODEL_FACTS_URL || DEFAULT_URL,
    private onUpdated: () => void = () => undefined
  ) {}

  private adopt(providers: FactsFile['providers']): void {
    this.providers = providers
    this.byModelId = new Map()
    for (const models of Object.values(providers)) {
      for (const [id, facts] of Object.entries(models)) {
        // Prefer an entry with a price: resellers and aggregators often leave it out.
        if (!this.byModelId.get(id)?.pricing) this.byModelId.set(id, facts)
      }
    }
  }

  async load(): Promise<void> {
    const file = path.join(this.dir, CACHE_FILE)
    const cached = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text) as FactsFile)
      .catch(() => null)
    if (cached?.providers) this.adopt(cached.providers)
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return
    void this.refresh(file)
  }

  private async refresh(file: string): Promise<void> {
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) return
      const providers = trimCatalog(await response.json())
      if (Object.keys(providers).length === 0) return
      this.adopt(providers)
      await mkdir(this.dir, { recursive: true })
      await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), providers } satisfies FactsFile))
      this.onUpdated()
    } catch {
      // Offline, or the catalog is unavailable: keep what we have and try again next launch.
    }
  }

  lookup(providerId: string, modelId: string): ModelFacts | undefined {
    const name = CATALOG_NAMES[providerId] ?? providerId
    return this.providers[name]?.[modelId] ?? this.byModelId.get(modelId)
  }
}

/** Reasoning models from these protocols accept these levels. Anthropic reports its own. */
export function defaultEfforts(protocol: Protocol, reasoning: boolean | undefined): ('low' | 'medium' | 'high')[] | undefined {
  return protocol !== 'anthropic' && reasoning ? ['low', 'medium', 'high'] : undefined
}
