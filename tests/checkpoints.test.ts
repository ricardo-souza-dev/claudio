import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointStore, noteRestored } from '../src/main/checkpoints'
import { workspaceTools } from '../src/main/tools/builtin'
import type { ToolResult } from '../src/main/tools/types'
import type { Checkpoint, Thread } from '../src/shared/types'

const THREAD_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ID = '00000000-0000-4000-8000-000000000002'
let root: string
let workspace: string
let store: CheckpointStore
let notifications: Checkpoint[][]

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'uni-checkpoints-'))
  workspace = path.join(root, 'projeto')
  await mkdir(workspace)
  notifications = []
  store = new CheckpointStore(path.join(root, 'dados'), { onChange: (_id, list) => notifications.push(list) })
})
afterEach(() => rm(root, { recursive: true, force: true }))

const thread = (id = THREAD_ID): Pick<Thread, 'id' | 'workspace'> => ({ id, workspace })
const toolsOf = () => workspaceTools(workspace)
const tool = (name: string) => toolsOf().find((entry) => entry.name === name)!
const never = new AbortController().signal

/** Runs a real file tool through the store, as the runner does. */
async function viaTool(name: 'write_file' | 'edit_file', input: Record<string, unknown>, anchor = 'm_1', who = thread()): Promise<{ result: ToolResult; recorded: boolean }> {
  return store.track(who, anchor, String(input.path), () => tool(name).run(input, never).catch((error: Error) => ({ content: error.message, isError: true })))
}
const read = (name: string) => readFile(path.join(workspace, name), 'utf8')
const exists = (name: string) => stat(path.join(workspace, name)).then(() => true, () => false)

describe('registrar alterações', () => {
  it('records a modified file and a created one, with how each was', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('edit_file', { path: 'a.txt', old_string: 'original', new_string: 'mudado' })
    await viaTool('write_file', { path: 'pasta/nova.txt', content: 'novo' })

    const [checkpoint] = await store.list(THREAD_ID)
    expect(checkpoint.id).toBe('m_1')
    expect(checkpoint.files).toEqual([
      { path: 'a.txt', kind: 'modified', restored: false },
      { path: 'pasta/nova.txt', kind: 'created', restored: false }
    ])
    expect(notifications.at(-1)).toEqual([checkpoint])
  })

  it('keeps the first original when the same file changes twice in one response', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'um')
    await viaTool('edit_file', { path: 'a.txt', old_string: 'um', new_string: 'dois' })
    await viaTool('edit_file', { path: 'a.txt', old_string: 'dois', new_string: 'três' })
    expect((await store.list(THREAD_ID))[0].files).toHaveLength(1)

    await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    expect(await read('a.txt')).toBe('um')
  })

  it('records nothing when the tool fails or changes nothing', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'igual')
    const failed = await viaTool('edit_file', { path: 'a.txt', old_string: 'não existe', new_string: 'x' })
    const same = await viaTool('write_file', { path: 'a.txt', content: 'igual' })
    expect(failed).toMatchObject({ recorded: false, result: { isError: true } })
    expect(same.recorded).toBe(false)
    expect(await store.list(THREAD_ID)).toEqual([])
  })

  it('drops the entry when a file is changed and changed back within the same response', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'um')
    await viaTool('write_file', { path: 'a.txt', content: 'dois' })
    await viaTool('write_file', { path: 'a.txt', content: 'um' })
    expect(await store.list(THREAD_ID)).toEqual([])
  })

  it('keeps one checkpoint per message', async () => {
    await viaTool('write_file', { path: 'a.txt', content: '1' }, 'm_1')
    await viaTool('write_file', { path: 'b.txt', content: '2' }, 'm_2')
    expect((await store.list(THREAD_ID)).map((entry) => entry.id)).toEqual(['m_1', 'm_2'])
  })

  it('refuses to overwrite a file too big to keep a copy of, so no edit is left without an undo', async () => {
    const small = new CheckpointStore(path.join(root, 'pequeno'), { maxFileBytes: 10 })
    await writeFile(path.join(workspace, 'grande.txt'), 'x'.repeat(50))
    const outcome = await small.track(thread(), 'm_1', 'grande.txt', () => tool('write_file').run({ path: 'grande.txt', content: 'y' }, never))
    expect(outcome.result.isError).toBe(true)
    expect(outcome.result.content).toContain('grande demais')
    expect(await read('grande.txt')).toBe('x'.repeat(50))
  })

  it('lets the tool answer for a path outside the project, without recording anything', async () => {
    const outcome = await viaTool('write_file', { path: '../fora.txt', content: 'x' })
    expect(outcome).toMatchObject({ recorded: false, result: { isError: true } })
    expect(await exists('../fora.txt')).toBe(false)
  })

  it('counts commands but shows nothing until a file changed', async () => {
    await store.noteCommand(thread(), 'm_1')
    expect(await store.list(THREAD_ID)).toEqual([])
    await viaTool('write_file', { path: 'a.txt', content: '1' })
    await store.noteCommand(thread(), 'm_1')
    expect((await store.list(THREAD_ID))[0].commands).toBe(2)
  })
})

describe('desfazer', () => {
  it('puts back a modified file, and deletes one the agent created', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('edit_file', { path: 'a.txt', old_string: 'original', new_string: 'mudado' })
    await viaTool('write_file', { path: 'nova.txt', content: 'novo' })

    const { results, checkpoints } = await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }, { path: 'nova.txt', force: false }])

    expect(results.map((result) => result.outcome)).toEqual(['restored', 'restored'])
    expect(await read('a.txt')).toBe('original')
    expect(await exists('nova.txt')).toBe(false)
    expect(checkpoints[0].files.every((file) => file.restored)).toBe(true)
  })

  it('restores bytes exactly, including content that is not valid text', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0x41])
    await writeFile(path.join(workspace, 'dados.bin'), bytes)
    await viaTool('write_file', { path: 'dados.bin', content: 'texto' })
    await store.restore(thread(), 'm_1', [{ path: 'dados.bin', force: false }])
    expect(Buffer.compare(await readFile(path.join(workspace, 'dados.bin')), bytes)).toBe(0)
  })

  it('works without Git', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    expect(await exists('.git')).toBe(false)
    await viaTool('write_file', { path: 'a.txt', content: 'mudado' })
    await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    expect(await read('a.txt')).toBe('original')
  })

  it('leaves a file the person changed after the agent alone, unless they confirm', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })
    await writeFile(path.join(workspace, 'a.txt'), 'escrito pela pessoa')

    expect((await store.preview(thread(), 'm_1')).files[0].state).toBe('changed')
    const refused = await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    expect(refused.results[0].outcome).toBe('changed')
    expect(await read('a.txt')).toBe('escrito pela pessoa')

    const forced = await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: true }])
    expect(forced.results[0].outcome).toBe('restored')
    expect(await read('a.txt')).toBe('original')
  })

  it('treats a file the person deleted as changed, and recreates it only when confirmed', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })
    await rm(path.join(workspace, 'a.txt'))
    expect((await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])).results[0].outcome).toBe('changed')
    expect((await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: true }])).results[0].outcome).toBe('restored')
    expect(await read('a.txt')).toBe('original')
  })

  it('does nothing to a file that is already as it was', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    expect((await store.preview(thread(), 'm_1')).files[0].state).toBe('unchanged')
    expect((await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: true }])).results[0].outcome).toBe('unchanged')
  })

  it('only touches files of that checkpoint, whatever the page asks for', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await writeFile(path.join(root, 'segredo.txt'), 'fora')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })

    const outcome = await store.restore(thread(), 'm_1', [{ path: '../segredo.txt', force: true }, { path: 'outro.txt', force: true }])

    expect(outcome.results.map((result) => result.outcome)).toEqual(['failed', 'failed'])
    expect(await readFile(path.join(root, 'segredo.txt'), 'utf8')).toBe('fora')
  })

  it('refuses a conversation id that is not one', async () => {
    await expect(store.list('../../etc/passwd')).rejects.toThrow('inválido')
  })

  it('will not follow a link out of the project to restore or delete', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })
    await rm(path.join(workspace, 'a.txt'))
    await writeFile(path.join(root, 'fora.txt'), 'de fora')
    await symlink(path.join(root, 'fora.txt'), path.join(workspace, 'a.txt'))

    const outcome = await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: true }])

    expect(outcome.results[0].outcome).toBe('failed')
    expect(await readFile(path.join(root, 'fora.txt'), 'utf8')).toBe('de fora')
  })

  it('can undo again after the agent edits the file once more', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'primeira' })
    await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    await viaTool('write_file', { path: 'a.txt', content: 'segunda' })
    expect((await store.list(THREAD_ID))[0].files[0].restored).toBe(false)
    await store.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    expect(await read('a.txt')).toBe('original')
  })

  it('survives closing the app', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'original')
    await viaTool('write_file', { path: 'a.txt', content: 'do agente' })
    const reopened = new CheckpointStore(path.join(root, 'dados'))
    expect((await reopened.list(THREAD_ID))[0].files[0].path).toBe('a.txt')
    await reopened.restore(thread(), 'm_1', [{ path: 'a.txt', force: false }])
    expect(await read('a.txt')).toBe('original')
  })
})

describe('avisar o próximo modelo', () => {
  const base = (): Thread => ({ id: THREAD_ID, title: 'x', createdAt: 0, updatedAt: 0, workspace, model: null, system: null, contextFiles: [], allowedTools: [], messages: [] })

  it('adds a note only for files that were really restored', () => {
    const t = base()
    noteRestored(t, [{ path: 'a.txt', outcome: 'restored' }, { path: 'b.txt', outcome: 'changed' }, { path: 'c.txt', outcome: 'failed', error: 'x' }])
    expect(t.revertNotes).toHaveLength(1)
    expect(t.revertNotes![0]).toContain('a.txt')
    expect(t.revertNotes![0]).not.toContain('b.txt')
    const none = base()
    noteRestored(none, [{ path: 'b.txt', outcome: 'unchanged' }])
    expect(none.revertNotes).toBeUndefined()
  })
})

describe('apagar a conversa', () => {
  it('removes its copies, and keeps the ones another conversation still needs', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'compartilhado')
    await viaTool('write_file', { path: 'a.txt', content: '1' }, 'm_1', thread(THREAD_ID))
    await writeFile(path.join(workspace, 'a.txt'), 'compartilhado')
    await viaTool('write_file', { path: 'a.txt', content: '2' }, 'm_9', thread(OTHER_ID))
    await writeFile(path.join(workspace, 'b.txt'), 'só da primeira')
    await viaTool('write_file', { path: 'b.txt', content: '3' }, 'm_2', thread(THREAD_ID))
    const blobs = path.join(root, 'dados', 'blobs')
    expect(await readdir(blobs)).toHaveLength(2)

    await store.forget(THREAD_ID)

    expect(await readdir(blobs)).toHaveLength(1)
    expect(await store.list(THREAD_ID)).toEqual([])
    await store.restore(thread(OTHER_ID), 'm_9', [{ path: 'a.txt', force: true }])
    expect(await read('a.txt')).toBe('compartilhado')
  })
})
