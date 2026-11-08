import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UniEvent } from '../src/shared/types'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fake.spawn }))
import { TerminalService, terminalEnvironment } from '../src/main/terminals'

function mockPty() {
  let data: (text: string) => void = () => undefined
  let exit: (event: { exitCode: number }) => void = () => undefined
  return {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (listener: typeof data) => { data = listener },
    onExit: (listener: typeof exit) => { exit = listener },
    output: (text: string) => data(text),
    exit: (code: number) => exit({ exitCode: code })
  }
}

beforeEach(() => fake.spawn.mockReset())

describe('interactive terminals', () => {
  it('filters app secrets and Electron control variables, keeping normal shell variables', () => {
    expect(terminalEnvironment({ PATH: 'bin', HOME: 'home', OPENAI_API_KEY: 'secret', X_AUTH_TOKEN: 'secret', X_SECRET: 'secret', ELECTRON_RUN_AS_NODE: '1', CLAUDIO_DATA_DIR: 'private', EMPTY: undefined })).toEqual({ PATH: 'bin', HOME: 'home' })
  })

  it('opens in the project, streams bounded snapshots, and validates input and dimensions', async () => {
    const pty = mockPty()
    fake.spawn.mockReturnValue(pty)
    const events: UniEvent[] = []
    const service = new TerminalService((event) => events.push(event))
    const info = await service.create('thread', process.cwd())
    expect(fake.spawn.mock.calls[0][2].cwd.toLowerCase()).toBe(process.cwd().toLowerCase())
    expect(fake.spawn.mock.calls[0][2].name).toBe('xterm-256color')
    pty.output('hello\r\n')
    expect(service.read(info.id)).toEqual({ data: 'hello\r\n', sequence: 1 })
    expect(events).toContainEqual({ type: 'terminal-data', id: info.id, data: 'hello\r\n', sequence: 1 })
    pty.output('x'.repeat(210_000))
    expect(service.read(info.id).data).toHaveLength(200_000)
    service.write(info.id, '\x03')
    expect(pty.write).toHaveBeenCalledWith('\x03')
    service.resize(info.id, 120, 40)
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
    expect(() => service.resize(info.id, 0, 1)).toThrow('inválidas')
    expect(() => service.resize(info.id, NaN, 24)).toThrow('inválidas')
    expect(() => service.write(info.id, 'x'.repeat(65_537))).toThrow('longa')
    expect(() => service.write('unknown', 'echo')).toThrow('não encontrado')
    service.dispose()
    expect(pty.kill).toHaveBeenCalledOnce()
  })

  it('preserves finished output, numbers tabs uniquely, and closes only the requested conversation', async () => {
    const ptys = [mockPty(), mockPty(), mockPty()]
    for (const pty of ptys) fake.spawn.mockReturnValueOnce(pty)
    const events: UniEvent[] = []
    const service = new TerminalService((event) => events.push(event))
    const first = await service.create('one', process.cwd())
    ptys[0].output('finished')
    ptys[0].exit(7)
    expect(service.list()[0].exitCode).toBe(7)
    expect(service.read(first.id).data).toBe('finished')
    expect(() => service.write(first.id, 'x')).toThrow('encerrado')
    service.close(first.id)
    expect(ptys[0].kill).not.toHaveBeenCalled()
    const second = await service.create('one', process.cwd())
    expect(second.title).toMatch(/ 2$/)
    const third = await service.create('two', process.cwd())
    service.closeThread('one')
    expect(service.list().map((entry) => entry.id)).toEqual([third.id])
    expect(ptys[1].kill).toHaveBeenCalledOnce()
    expect(ptys[2].kill).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'terminal-closed', id: second.id })
    service.dispose()
    expect(ptys[2].kill).toHaveBeenCalledOnce()
    await expect(service.create('two', process.cwd())).rejects.toThrow('encerrados')
  })

  it('limits concurrent opens and refuses missing projects without spawning', async () => {
    fake.spawn.mockImplementation(() => mockPty())
    const service = new TerminalService(() => undefined)
    await expect(service.create('one', `${process.cwd()}/missing-terminal-project`)).rejects.toThrow()
    expect(fake.spawn).not.toHaveBeenCalled()
    const attempts = await Promise.allSettled(Array.from({ length: 17 }, () => service.create('one', process.cwd())))
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(16)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    service.dispose()
  })
})
