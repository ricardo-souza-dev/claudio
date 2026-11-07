import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { modelKey, NEW_THREAD_TITLE, type ModelRef, type ModelSpeed, type Preferences, type Protocol, type ProviderView, type Thread, type ThreadSummary } from '../shared/types'
import { PROVIDER_CATALOG } from './providers/catalog'
import type { ProviderConnection } from './providers/types'
import type { McpServerConfig } from './tools/mcp'

export interface Vault {
  encrypt(text: string): string
  decrypt(data: string): string
}

interface CustomProvider {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
}

interface SettingsFile {
  keys: Record<string, string>
  baseUrls: Record<string, string>
  custom: CustomProvider[]
  /** Encrypted as a whole: env vars and headers usually hold tokens. */
  mcp: string | null
  prefs: Preferences
  /** How fast each model has been here, by model key. */
  speeds?: Record<string, ModelSpeed>
}

const MIN_OUTPUT_TO_MEASURE = 5
const MIN_GENERATING_MS = 50
/** Recent answers count more, so a provider that got faster or slower shows up quickly. */
const SPEED_SMOOTHING = 0.3

const EMPTY: SettingsFile = {
  keys: {},
  baseUrls: {},
  custom: [],
  mcp: null,
  prefs: { memory: '', lastModel: null, permissionMode: 'ask', effort: null, autoModel: false }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file)
      return
    } catch (error) {
      // On Windows, antivirus or indexers can hold the destination for a moment.
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 5) {
        await rm(temporary, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export class SettingsStore {
  private data: SettingsFile = structuredClone(EMPTY)
  private file: string
  private queue: Promise<void> = Promise.resolve()

  constructor(
    dir: string,
    private vault: Vault,
    private env: NodeJS.ProcessEnv = process.env
  ) {
    this.file = path.join(dir, 'settings.json')
  }

  async load(): Promise<void> {
    const text = await readFile(this.file, 'utf8').catch(() => null)
    if (!text) return
    const parsed = JSON.parse(text) as Partial<SettingsFile>
    this.data = { ...structuredClone(EMPTY), ...parsed, prefs: { ...EMPTY.prefs, ...parsed.prefs } }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.queue = this.queue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeAtomic(this.file, snapshot)
    })
    return this.queue
  }

  prefs(): Preferences {
    return this.data.prefs
  }

  speedOf(model: ModelRef): ModelSpeed | undefined {
    return this.data.speeds?.[modelKey(model)]
  }

  recordSpeed(model: ModelRef, firstTokenMs: number, generatingMs: number, outputTokens: number): void {
    if (outputTokens < MIN_OUTPUT_TO_MEASURE) return
    const tokensPerSecond = outputTokens / (Math.max(generatingMs, MIN_GENERATING_MS) / 1000)
    const previous = this.speedOf(model)
    const blend = (old: number | undefined, next: number): number => (old === undefined ? next : old + (next - old) * SPEED_SMOOTHING)
    this.data.speeds = {
      ...this.data.speeds,
      [modelKey(model)]: {
        tokensPerSecond: blend(previous?.tokensPerSecond, tokensPerSecond),
        firstTokenMs: blend(previous?.firstTokenMs, firstTokenMs)
      }
    }
    void this.save().catch(() => undefined)
  }

  async setPrefs(patch: Partial<Preferences>): Promise<Preferences> {
    this.data.prefs = { ...this.data.prefs, ...patch }
    await this.save()
    return this.data.prefs
  }

  private definition(id: string) {
    return PROVIDER_CATALOG.find((entry) => entry.id === id)
  }

  private savedKey(id: string): string | null {
    const stored = this.data.keys[id]
    if (!stored) return null
    try {
      return this.vault.decrypt(stored)
    } catch {
      return null
    }
  }

  private resolveKey(id: string): { key: string | null; source: ProviderView['keySource'] } {
    const saved = this.savedKey(id)
    if (saved) return { key: saved, source: 'saved' }
    const definition = this.definition(id)
    // An environment key only ever goes to its vendor's own endpoint.
    const fromEnv = definition?.envKey && !this.data.baseUrls[id] ? this.env[definition.envKey] : undefined
    return fromEnv ? { key: fromEnv, source: 'env' } : { key: null, source: null }
  }

  providers(): ProviderView[] {
    const builtIn = PROVIDER_CATALOG.map((definition): ProviderView => ({
      id: definition.id,
      name: definition.name,
      protocol: definition.protocol,
      baseUrl: this.data.baseUrls[definition.id] ?? definition.baseUrl,
      defaultBaseUrl: definition.baseUrl,
      custom: false,
      local: definition.local === true,
      needsKey: definition.local !== true,
      keySource: this.resolveKey(definition.id).source,
      envKey: definition.envKey,
      keyUrl: definition.keyUrl
    }))
    const custom = this.data.custom.map((entry): ProviderView => ({
      ...entry,
      defaultBaseUrl: entry.baseUrl,
      custom: true,
      local: false,
      needsKey: false,
      keySource: this.resolveKey(entry.id).source
    }))
    return [...builtIn, ...custom]
  }

  connection(id: string): ProviderConnection | null {
    const definition = this.definition(id)
    const custom = this.data.custom.find((entry) => entry.id === id)
    if (!definition && !custom) return null
    const override = this.data.baseUrls[id]
    return {
      id,
      name: definition?.name ?? custom!.name,
      protocol: definition?.protocol ?? custom!.protocol,
      baseUrl: override ?? definition?.baseUrl ?? custom!.baseUrl,
      official: !!definition && !definition.local && !override,
      apiKey: this.resolveKey(id).key,
      quirks: definition?.quirks
    }
  }

  async setKey(id: string, key: string | null): Promise<void> {
    if (!this.connection(id)) throw new Error('Provedor desconhecido.')
    if (key?.trim()) this.data.keys[id] = this.vault.encrypt(key.trim())
    else delete this.data.keys[id]
    await this.save()
  }

  async setBaseUrl(id: string, baseUrl: string | null): Promise<void> {
    if (!this.connection(id)) throw new Error('Provedor desconhecido.')
    const trimmed = baseUrl?.trim().replace(/\/+$/, '')
    const definition = this.definition(id)
    if (trimmed) {
      if (!/^https?:\/\//.test(trimmed)) throw new Error('O endereço precisa começar com http:// ou https://')
      if (trimmed === definition?.baseUrl) delete this.data.baseUrls[id]
      else this.data.baseUrls[id] = trimmed
    } else {
      delete this.data.baseUrls[id]
    }
    await this.save()
  }

  async addCustom(input: { name: string; protocol: Protocol; baseUrl: string; key?: string }): Promise<void> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    if (!input.name.trim()) throw new Error('Dê um nome ao provedor.')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('O endereço precisa começar com http:// ou https://')
    const id = `custom-${randomUUID().slice(0, 8)}`
    this.data.custom.push({ id, name: input.name.trim(), protocol: input.protocol, baseUrl })
    if (input.key?.trim()) this.data.keys[id] = this.vault.encrypt(input.key.trim())
    await this.save()
  }

  async removeCustom(id: string): Promise<void> {
    this.data.custom = this.data.custom.filter((entry) => entry.id !== id)
    delete this.data.keys[id]
    delete this.data.baseUrls[id]
    await this.save()
  }

  mcpServers(): McpServerConfig[] {
    if (!this.data.mcp) return []
    try {
      return JSON.parse(this.vault.decrypt(this.data.mcp)) as McpServerConfig[]
    } catch {
      return []
    }
  }

  async setMcpServers(servers: McpServerConfig[]): Promise<void> {
    this.data.mcp = servers.length > 0 ? this.vault.encrypt(JSON.stringify(servers)) : null
    await this.save()
  }
}

export class ThreadStore {
  private dir: string
  private summaries = new Map<string, ThreadSummary>()
  private cache = new Map<string, Thread>()
  private queues = new Map<string, Promise<void>>()
  /** A run that is still ending must not bring a deleted conversation back. */
  private removed = new Set<string>()

  constructor(dir: string) {
    this.dir = path.join(dir, 'threads')
  }

  /** Ids reach file paths, and they come from the renderer. */
  private fileFor(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Identificador de conversa inválido.')
    return path.join(this.dir, `${id}.json`)
  }

  private summaryOf(thread: Thread): ThreadSummary {
    return { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, workspace: thread.workspace }
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const thread = JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as Thread
        this.summaries.set(thread.id, this.summaryOf(thread))
      } catch {
        // A corrupt file costs that one conversation, not the whole app.
      }
    }
  }

  list(): ThreadSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<Thread | null> {
    const cached = this.cache.get(id)
    if (cached) return cached
    const text = await readFile(this.fileFor(id), 'utf8').catch(() => null)
    if (!text) return null
    const thread = JSON.parse(text) as Thread
    this.cache.set(id, thread)
    return thread
  }

  async create(workspace: string | null, model: ModelRef | null): Promise<Thread> {
    const now = Date.now()
    const thread: Thread = {
      id: randomUUID(),
      title: NEW_THREAD_TITLE,
      createdAt: now,
      updatedAt: now,
      workspace,
      model,
      system: null,
      contextFiles: [],
      allowedTools: [],
      messages: []
    }
    this.cache.set(thread.id, thread)
    await this.save(thread)
    return thread
  }

  save(thread: Thread): Promise<void> {
    if (this.removed.has(thread.id)) return Promise.resolve()
    this.summaries.set(thread.id, this.summaryOf(thread))
    const snapshot = JSON.stringify(thread)
    const file = this.fileFor(thread.id)
    const next = (this.queues.get(thread.id) ?? Promise.resolve()).catch(() => undefined).then(() => writeAtomic(file, snapshot))
    this.queues.set(thread.id, next)
    return next
  }

  async remove(id: string): Promise<void> {
    const file = this.fileFor(id)
    this.removed.add(id)
    await this.queues.get(id)?.catch(() => undefined)
    this.summaries.delete(id)
    this.cache.delete(id)
    this.queues.delete(id)
    await rm(file, { force: true })
  }
}
