import type { ModelInfo, ModelListing, ModelRef, ProviderTest } from '../shared/types'
import { createAdapter } from './providers/catalog'
import type { ProviderAdapter } from './providers/types'
import type { SettingsStore } from './store'

const LIST_TIMEOUT_MS = 10_000

/** Every model of every connected provider, read from their own APIs. */
export class ModelDirectory {
  private cache = new Map<string, ModelInfo[]>()
  private errors: Record<string, string> = {}

  constructor(private settings: SettingsStore) {}

  invalidate(providerId?: string): void {
    if (providerId) {
      this.cache.delete(providerId)
      delete this.errors[providerId]
    } else {
      this.cache.clear()
      this.errors = {}
    }
  }

  private adapter(providerId: string): ProviderAdapter {
    const connection = this.settings.connection(providerId)
    if (!connection) throw new Error(`Provedor não configurado: ${providerId}`)
    return createAdapter(connection)
  }

  private async fetch(providerId: string): Promise<ModelInfo[]> {
    return this.adapter(providerId).listModels(AbortSignal.timeout(LIST_TIMEOUT_MS))
  }

  async list(refresh = false): Promise<ModelListing> {
    if (refresh) this.invalidate()
    const pending = this.settings.providers().filter((provider) => {
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
    const known = new Set(this.settings.providers().map((provider) => provider.id))
    const models = [...this.cache.entries()]
      .filter(([id]) => known.has(id))
      .flatMap(([, list]) => list)
    return { models, errors: { ...this.errors } }
  }

  async test(providerId: string): Promise<ProviderTest> {
    this.invalidate(providerId)
    try {
      const models = await this.fetch(providerId)
      this.cache.set(providerId, models)
      return { ok: true, count: models.length }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  async resolve(ref: ModelRef): Promise<{ adapter: ProviderAdapter; info: ModelInfo }> {
    const adapter = this.adapter(ref.provider)
    let list = this.cache.get(ref.provider)
    if (!list) {
      list = await this.fetch(ref.provider).catch(() => [])
      if (list.length > 0) this.cache.set(ref.provider, list)
    }
    const known = list.find((model) => model.id === ref.id)
    const providerName = this.settings.connection(ref.provider)!.name
    return { adapter, info: known ?? { ...ref, label: ref.id, providerName } }
  }
}
