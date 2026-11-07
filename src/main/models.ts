import type { ModelInfo, ModelListing, ModelRef, ProviderTest } from '../shared/types'
import { defaultEfforts, type ModelFactsStore } from './model-facts'
import { createAdapter } from './providers/catalog'
import type { ProviderAdapter } from './providers/types'
import type { SettingsStore } from './store'

const LIST_TIMEOUT_MS = 10_000

/** Every model of every connected provider, read from their own APIs. */
export class ModelDirectory {
  private cache = new Map<string, ModelInfo[]>()
  private errors: Record<string, string> = {}

  constructor(
    private settings: SettingsStore,
    private facts: ModelFactsStore
  ) {}

  invalidate(providerId?: string): void {
    if (providerId) {
      this.cache.delete(providerId)
      delete this.errors[providerId]
    } else {
      this.cache.clear()
      this.errors = {}
    }
  }

  private async adapter(providerId: string): Promise<ProviderAdapter> {
    const connection = await this.settings.connection(providerId)
    if (!connection) throw new Error(`Provedor não configurado: ${providerId}`)
    return createAdapter(connection)
  }

  private async fetch(providerId: string): Promise<ModelInfo[]> {
    return (await this.adapter(providerId)).listModels(AbortSignal.timeout(LIST_TIMEOUT_MS))
  }

  /** A provider's own API wins; the public catalog fills in what it doesn't report. */
  private async enrich(listed: ModelInfo): Promise<ModelInfo> {
    const speed = this.settings.speedOf(listed)
    const model = speed ? { ...listed, speed } : listed
    const facts = this.facts.lookup(model.provider, model.id)
    if (!facts) return model
    const protocol = (await this.settings.connection(model.provider))?.protocol ?? 'openai-chat'
    return {
      ...model,
      contextWindow: model.contextWindow ?? facts.context,
      maxOutput: model.maxOutput ?? facts.output,
      pricing: facts.pricing,
      reasoning: facts.reasoning,
      supportsTools: facts.tools,
      imageInput: facts.imageInput,
      released: facts.released,
      efforts: model.efforts?.length ? model.efforts : defaultEfforts(protocol, facts.reasoning)
    }
  }

  private isTextModel(model: ModelInfo): boolean {
    return this.facts.lookup(model.provider, model.id)?.textOutput !== false
  }

  async list(refresh = false): Promise<ModelListing> {
    if (refresh) this.invalidate()
    const pending = (await this.settings.providers()).filter((provider) => {
      if (this.cache.has(provider.id)) return false
      return provider.keySource !== null || !provider.needsKey
    })
    await Promise.all(
      pending.map(async (provider) => {
        try {
          this.cache.set(provider.id, await this.fetch(provider.id))
          delete this.errors[provider.id]
        } catch (error) {
          // A local server that isn't running is normal, not an error worth showing.
          if (!provider.local) this.errors[provider.id] = (error as Error).message
        }
      })
    )
    const known = new Set((await this.settings.providers()).map((provider) => provider.id))
    const models = await Promise.all([...this.cache.entries()]
      .filter(([id]) => known.has(id))
      .flatMap(([, list]) => list)
      .filter((model) => this.isTextModel(model))
      .map((model) => this.enrich(model)))
    return { models, errors: { ...this.errors } }
  }

  async test(providerId: string): Promise<ProviderTest> {
    this.invalidate(providerId)
    try {
      const models = await this.fetch(providerId)
      this.cache.set(providerId, models)
      return { ok: true, count: models.filter((model) => this.isTextModel(model)).length }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async resolve(ref: ModelRef): Promise<{ adapter: ProviderAdapter; info: ModelInfo }> {
    const adapter = await this.adapter(ref.provider)
    let list = this.cache.get(ref.provider)
    if (!list) {
      list = await this.fetch(ref.provider).catch(() => [])
      if (list.length > 0) this.cache.set(ref.provider, list)
    }
    const known = list.find((model) => model.id === ref.id)
    const providerName = (await this.settings.connection(ref.provider))!.name
    return { adapter, info: await this.enrich(known ?? { ...ref, label: ref.id, providerName }) }
  }
}
