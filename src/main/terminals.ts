import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { TerminalSession, TerminalSnapshot, UniEvent } from '../shared/types'
import { resolveInside } from './tools/builtin'

const MAX_SESSIONS = 16
const BUFFER_LIMIT = 200_000

export function terminalEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !/(_API_KEY|_AUTH_TOKEN|_SECRET)$|^ELECTRON_|^CLAUDIO_/i.test(name)))
}

interface Session {
  info: TerminalSession
  pty: IPty
  data: string
  pending: string
  sequence: number
  timer?: ReturnType<typeof setTimeout>
}

/** User-operated shells only. This service is deliberately not an agent tool. */
export class TerminalService {
  private sessions = new Map<string, Session>()
  private opening = 0
  private numbers = new Map<string, number>()
  private disposed = false

  constructor(private emit: (event: UniEvent) => void) {}

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }))
  }

  async create(threadId: string, workspace: string, scriptPath?: string): Promise<TerminalSession> {
    if (this.disposed) throw new Error('Os terminais estão sendo encerrados.')
    if (this.sessions.size + this.opening >= MAX_SESSIONS) throw new Error('Limite de 16 terminais abertos. Feche uma aba para abrir outra.')
    this.opening++
    try {
      const cwd = await realpath(workspace)
      if (!(await stat(cwd)).isDirectory()) throw new Error('A pasta do projeto não existe.')
      let script: string | undefined
      if (scriptPath !== undefined) {
        if (typeof scriptPath !== 'string' || !/\.ps1$/i.test(scriptPath) || /[\x00-\x1f]/.test(scriptPath)) throw new Error('Escolha um arquivo .ps1 válido para executar.')
        script = await resolveInside(cwd, scriptPath)
        if (!(await stat(script)).isFile()) throw new Error('O script precisa ser um arquivo .ps1.')
      }
      if (this.disposed) throw new Error('Os terminais estão sendo encerrados.')
      const windows = process.platform === 'win32'
      const shell = windows
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : script ? 'pwsh' : process.env.SHELL || '/bin/bash'
      // Pass the script as a literal argv entry, never as interpolated shell input.
      // Keep the shell interactive after completion, without bypassing execution policy.
      const args = script ? ['-NoLogo', '-NoProfile', '-NoExit', '-File', script] : windows ? ['-NoLogo', '-NoProfile'] : []
      const pty = spawn(shell, args, {
        name: 'xterm-256color', cols: 80, rows: 24, cwd,
        env: { ...terminalEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      })
      const number = (this.numbers.get(threadId) ?? 0) + 1
      this.numbers.set(threadId, number)
      const info: TerminalSession = { id: randomUUID(), threadId, workspace, title: script ? `${path.basename(scriptPath!)} · ${number}` : `${windows ? 'PowerShell' : path.basename(shell)} ${number}` }
      const session: Session = { info, pty, data: '', pending: '', sequence: 0 }
      this.sessions.set(info.id, session)
      pty.onData((data) => {
        if (!this.sessions.has(info.id)) return
        session.pending += data
        // Bound both memory and IPC payloads when a command produces a lot of output.
        if (session.pending.length >= 32_768) this.flush(session)
        else session.timer ??= setTimeout(() => this.flush(session), 16)
      })
      pty.onExit(({ exitCode }) => {
        if (!this.sessions.has(info.id)) return
        this.flush(session)
        info.exitCode = exitCode
        this.emit({ type: 'terminal-changed', terminal: { ...info } })
      })
      this.emit({ type: 'terminal-changed', terminal: { ...info } })
      return { ...info }
    } finally {
      this.opening--
    }
  }

  private get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Terminal não encontrado.')
    return session
  }

  private flush(session: Session): void {
    clearTimeout(session.timer)
    session.timer = undefined
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    session.data = (session.data + data).slice(-BUFFER_LIMIT)
    this.emit({ type: 'terminal-data', id: session.info.id, sequence: ++session.sequence, data })
  }

  read(id: string): TerminalSnapshot {
    const session = this.get(id)
    this.flush(session)
    return { data: session.data, sequence: session.sequence }
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 65_536) throw new Error('Entrada de terminal inválida ou muito longa.')
    const session = this.get(id)
    if (session.info.exitCode !== undefined) throw new Error('Este terminal já foi encerrado. Abra outra aba.')
    session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) throw new Error('Dimensões de terminal inválidas.')
    const session = this.get(id)
    if (session.info.exitCode === undefined) session.pty.resize(cols, rows)
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    clearTimeout(session.timer)
    if (session.info.exitCode === undefined) {
      try { session.pty.kill() } catch { /* The shell may have exited before its event arrived. */ }
    }
    this.emit({ type: 'terminal-closed', id })
  }

  closeThread(threadId: string): void {
    for (const session of this.list()) if (session.threadId === threadId) this.close(session.id)
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.sessions.keys()) this.close(id)
  }
}
