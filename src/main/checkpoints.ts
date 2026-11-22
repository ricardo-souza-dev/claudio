import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Checkpoint, CheckpointPreview, RestoreResult, RestoreState, Thread } from '../shared/types'
import { revertNotice } from './agent/context'
import { writeAtomic } from './store'
import { resolveInside } from './tools/builtin'
import type { ToolResult } from './tools/types'

/** A file the agent would overwrite must fit in a stored copy, or the edit is refused rather than left without an undo. */
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

interface FileRecord {
  /** Relative to the project, with forward slashes. */
  path: string
  /** Hash of the stored copy from before the agent, or null when the file did not exist. */
  before: string | null
  /** Hash of the file as the agent left it, or null when it no longer exists. */
  after: string | null
  restoredAt?: number
}

interface CheckpointRecord {
  id: string
  createdAt: number
  commands: number
  files: FileRecord[]
}

interface Index {
  checkpoints: CheckpointRecord[]
}

export interface CheckpointOptions {
  maxFileBytes?: number
  onChange?(threadId: string, checkpoints: Checkpoint[]): void
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function readIfFile(file: string, maxBytes: number): Promise<{ data: Buffer | null; tooBig: boolean; notAFile: boolean }> {
  const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (!info) return { data: null, tooBig: false, notAFile: false }
  if (!info.isFile()) return { data: null, tooBig: false, notAFile: true }
  if (info.size > maxBytes) return { data: null, tooBig: true, notAFile: false }
  return { data: await readFile(file), tooBig: false, notAFile: false }
}

/** The hash of a file as it is now, or null when there is no regular file. */
async function currentHash(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  return sha256(await readFile(file))
}

/**
 * Restore points for what the agent writes. Before a file tool changes a file, the previous bytes are
 * kept under their hash, so the same content is stored once. Nothing here depends on Git.
 * It covers `write_file` and `edit_file` only: what a command or an external tool changes is unknown.
 */
export class CheckpointStore {
  private cache = new Map<string, Index>()
  private queues = new Map<string, Promise<unknown>>()
  private maxFileBytes: number

  constructor(private dir: string, private options: CheckpointOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  private blobFile(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Cópia inválida.')
    return path.join(this.dir, 'blobs', hash)
  }

  /** Ids reach file paths, and they come from the renderer. */
  private indexFile(threadId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(threadId)) throw new Error('Identificador de conversa inválido.')
    return path.join(this.dir, `${threadId}.json`)
  }

  /** One operation at a time per conversation, so two saves never interleave. */
  private locked<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.queues.set(threadId, next)
    return next
  }

  private async load(threadId: string): Promise<Index> {
    const cached = this.cache.get(threadId)
    if (cached) return cached
    const text = await readFile(this.indexFile(threadId), 'utf8').catch(() => null)
    let index: Index = { checkpoints: [] }
    if (text) {
      try {
        index = JSON.parse(text) as Index
      } catch {
        // A damaged index loses the undo of that conversation, never the conversation.
      }
    }
    this.cache.set(threadId, index)
    return index
  }

  private async save(threadId: string, index: Index): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeAtomic(this.indexFile(threadId), JSON.stringify(index))
    this.options.onChange?.(threadId, this.summaries(index))
  }

  private async putBlob(data: Buffer): Promise<string> {
    const hash = sha256(data)
    await mkdir(path.join(this.dir, 'blobs'), { recursive: true })
    await writeAtomic(this.blobFile(hash), data)
    return hash
  }

  private summaries(index: Index): Checkpoint[] {
    return index.checkpoints
      .filter((checkpoint) => checkpoint.files.length > 0)
      .map((checkpoint) => ({
        id: checkpoint.id,
        createdAt: checkpoint.createdAt,
        commands: checkpoint.commands,
        files: checkpoint.files.map((file) => ({ path: file.path, kind: file.before === null ? ('created' as const) : ('modified' as const), restored: file.restoredAt !== undefined }))
      }))
  }

  async list(threadId: string): Promise<Checkpoint[]> {
    return this.locked(threadId, async () => this.summaries(await this.load(threadId)))
  }

  private entry(index: Index, id: string): CheckpointRecord {
    let checkpoint = index.checkpoints.find((entry) => entry.id === id)
    if (!checkpoint) {
      checkpoint = { id, createdAt: Date.now(), commands: 0, files: [] }
      index.checkpoints.push(checkpoint)
    }
    return checkpoint
  }

  /**
   * Runs a file tool and records what it changed under the message `anchor`. A change that can't be
   * recorded as undoable is refused up front. Returns whether anything was recorded.
   */
  async track(thread: Pick<Thread, 'id' | 'workspace'>, anchor: string, requested: string, run: () => Promise<ToolResult>): Promise<{ result: ToolResult; recorded: boolean }> {
    if (!thread.workspace) return { result: await run(), recorded: false }
    let file: string
    let relative: string
    try {
      file = await resolveInside(thread.workspace, requested)
      relative = path.relative(await realpath(thread.workspace), file).split(path.sep).join('/')
    } catch {
      // The tool will fail on the same path with its own message.
      return { result: await run(), recorded: false }
    }

    let before: Awaited<ReturnType<typeof readIfFile>>
    try {
      before = await readIfFile(file, this.maxFileBytes)
    } catch {
      return { result: { content: `Não foi possível guardar uma cópia de ${requested} antes de alterá-lo, então nada foi feito.`, isError: true }, recorded: false }
    }
    if (before.notAFile) return { result: await run(), recorded: false }
    if (before.tooBig) {
      return { result: { content: `${requested} é grande demais para guardar uma cópia (limite de ${Math.round(this.maxFileBytes / 1024 / 1024)} MB), então não foi alterado. Peça ao usuário para fazer essa alteração.`, isError: true }, recorded: false }
    }

    const result = await run()
    try {
      const after = await readIfFile(file, Number.POSITIVE_INFINITY)
      const beforeHash = before.data ? sha256(before.data) : null
      const afterHash = after.data ? sha256(after.data) : null
      if (beforeHash === afterHash) return { result, recorded: false }
      if (before.data) await this.putBlob(before.data)
      await this.locked(thread.id, async () => {
        const index = await this.load(thread.id)
        const checkpoint = this.entry(index, anchor)
        const known = checkpoint.files.find((entry) => entry.path === relative)
        if (known) {
          known.after = afterHash
          delete known.restoredAt
          if (known.after === known.before) checkpoint.files = checkpoint.files.filter((entry) => entry !== known)
        } else {
          checkpoint.files.push({ path: relative, before: beforeHash, after: afterHash })
        }
        if (checkpoint.files.length === 0 && checkpoint.commands === 0) index.checkpoints = index.checkpoints.filter((entry) => entry !== checkpoint)
        await this.save(thread.id, index)
      })
      return { result, recorded: true }
    } catch {
      return { result: { ...result, content: `${result.content}\n[Aviso: não foi possível registrar esta alteração para desfazer.]` }, recorded: false }
    }
  }

  /** A command ran, and whatever it changed is outside what can be undone. */
  async noteCommand(thread: Pick<Thread, 'id'>, anchor: string): Promise<void> {
    await this.locked(thread.id, async () => {
      const index = await this.load(thread.id)
      this.entry(index, anchor).commands += 1
      await this.save(thread.id, index)
    })
  }

  private record(index: Index, id: string): CheckpointRecord {
    const checkpoint = index.checkpoints.find((entry) => entry.id === id && entry.files.length > 0)
    if (!checkpoint) throw new Error('Esta alteração não está mais disponível.')
    return checkpoint
  }

  private stateOf(current: string | null, file: FileRecord): RestoreState {
    if (current === file.after) return 'ready'
    if (current === file.before) return 'unchanged'
    return 'changed'
  }

  async preview(thread: Pick<Thread, 'id' | 'workspace'>, id: string): Promise<CheckpointPreview> {
    return this.locked(thread.id, async () => {
      const checkpoint = this.record(await this.load(thread.id), id)
      const root = this.root(thread)
      const files = []
      for (const file of checkpoint.files) {
        const current = await currentHash(await resolveInside(root, file.path))
        files.push({ path: file.path, kind: file.before === null ? ('created' as const) : ('modified' as const), restored: file.restoredAt !== undefined, state: this.stateOf(current, file) })
      }
      return { files, commands: checkpoint.commands }
    })
  }

  private root(thread: Pick<Thread, 'workspace'>): string {
    if (!thread.workspace) throw new Error('Esta conversa não tem um projeto.')
    return thread.workspace
  }

  /**
   * Puts the chosen files back as they were before the agent. A file that changed after the agent's
   * edit is left alone unless `force` says the person knows. Only files of this checkpoint are touched,
   * whatever the page asks.
   */
  async restore(
    thread: Pick<Thread, 'id' | 'workspace'>,
    id: string,
    selection: { path: string; force: boolean }[]
  ): Promise<{ results: RestoreResult[]; checkpoints: Checkpoint[] }> {
    return this.locked(thread.id, async () => {
      const index = await this.load(thread.id)
      const checkpoint = this.record(index, id)
      const root = this.root(thread)
      const results: RestoreResult[] = []
      const done = new Set<string>()
      for (const { path: requested, force } of selection) {
        if (done.has(requested)) continue
        done.add(requested)
        const file = checkpoint.files.find((entry) => entry.path === requested)
        if (!file) {
          results.push({ path: requested, outcome: 'failed', error: 'Este arquivo não faz parte desta alteração.' })
          continue
        }
        try {
          const target = await resolveInside(root, file.path)
          const state = this.stateOf(await currentHash(target), file)
          if (state === 'unchanged') {
            results.push({ path: file.path, outcome: 'unchanged' })
            continue
          }
          if (state === 'changed' && !force) {
            results.push({ path: file.path, outcome: 'changed' })
            continue
          }
          if (file.before === null) {
            await rm(target, { force: true })
          } else {
            const saved = await readFile(this.blobFile(file.before)).catch(() => null)
            if (!saved) throw new Error('A cópia guardada deste arquivo não está mais disponível.')
            await mkdir(path.dirname(target), { recursive: true })
            await writeFile(target, saved)
          }
          file.restoredAt = Date.now()
          results.push({ path: file.path, outcome: 'restored' })
        } catch (error) {
          results.push({ path: requested, outcome: 'failed', error: (error as Error).message })
        }
      }
      await this.save(thread.id, index)
      return { results, checkpoints: this.summaries(index) }
    })
  }

  /** The conversation is gone, and so are the copies nobody else points at. */
  async forget(threadId: string): Promise<void> {
    await this.locked(threadId, async () => {
      this.cache.delete(threadId)
      await rm(this.indexFile(threadId), { force: true })
      const referenced = new Set<string>()
      for (const name of await readdir(this.dir).catch(() => [])) {
        if (!name.endsWith('.json')) continue
        try {
          const index = JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as Index
          for (const checkpoint of index.checkpoints) for (const file of checkpoint.files) if (file.before) referenced.add(file.before)
        } catch {
          // An unreadable index keeps nothing alive.
        }
      }
      for (const name of await readdir(path.join(this.dir, 'blobs')).catch(() => [])) {
        if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) await rm(path.join(this.dir, 'blobs', name), { force: true })
      }
    })
  }
}

/** Tells the next message what the person undid, because the history itself only grows. */
export function noteRestored(thread: Thread, results: RestoreResult[]): void {
  const paths = results.filter((result) => result.outcome === 'restored').map((result) => result.path)
  if (paths.length > 0) (thread.revertNotes ??= []).push(revertNotice(paths))
}
