import { Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSession, UniEvent } from '../../shared/types'
import { remoteErrorMessage } from './format'
import { api } from './store'

function TerminalView({ session, active, onError }: { session: TerminalSession; active: boolean; onError(message: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null)
  const errorRef = useRef(onError)
  errorRef.current = onError

  useEffect(() => {
    if (!host.current) return
    const terminal = new Terminal({
      fontFamily: "'IBM Plex Mono', Consolas, monospace", fontSize: 12, cursorBlink: true,
      scrollback: 3000, allowProposedApi: false, allowTransparency: false,
      // Shell output is untrusted: no HTML, links, clipboard APIs or remote images.
      theme: { background: '#181818', foreground: '#ececec', cursor: '#ececec', selectionBackground: '#355578' }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    terminal.textarea?.setAttribute('aria-label', `Entrada do terminal ${session.title}`)
    instance.current = { terminal, fit }
    let disposed = false
    let sequence = -1
    let pending: Extract<UniEvent, { type: 'terminal-data' }>[] = []
    const unsubscribe = api.on((event) => {
      if (event.type !== 'terminal-data' || event.id !== session.id) return
      if (sequence < 0) pending.push(event)
      else if (event.sequence > sequence) {
        terminal.write(event.data)
        sequence = event.sequence
      }
    })
    void api.terminal.read(session.id).then((snapshot) => {
      if (disposed) return
      terminal.write(snapshot.data)
      sequence = snapshot.sequence
      for (const event of pending) {
        if (event.sequence > sequence) {
          terminal.write(event.data)
          sequence = event.sequence
        }
      }
      pending = []
    }).catch((error) => { if (!disposed) errorRef.current(remoteErrorMessage(error)) })
    const input = terminal.onData((data) => {
      void api.terminal.write(session.id, data).catch((error) => errorRef.current(remoteErrorMessage(error)))
    })
    const resize = terminal.onResize(({ cols, rows }) => {
      void api.terminal.resize(session.id, cols, rows).catch((error) => { if (!disposed) errorRef.current(remoteErrorMessage(error)) })
    })
    const observer = new ResizeObserver(() => {
      if (host.current && host.current.clientWidth > 0 && host.current.clientHeight > 0) fit.fit()
    })
    observer.observe(host.current)
    return () => {
      disposed = true
      unsubscribe()
      observer.disconnect()
      input.dispose()
      resize.dispose()
      instance.current = null
      terminal.dispose()
    }
  }, [session.id])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      instance.current?.fit.fit()
      instance.current?.terminal.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    if (instance.current) instance.current.terminal.options.disableStdin = session.exitCode !== undefined
  }, [session.exitCode])

  return <div className="terminal-view" role="tabpanel" aria-label={session.title} hidden={!active} ref={host} />
}

export function TerminalPanel({ threadId, open, onClose }: { threadId: string; open: boolean; onClose(): void }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const current = sessions.filter((session) => session.threadId === threadId)
  const active = current.find((session) => session.id === selected[threadId]) ?? current.at(-1)

  useEffect(() => {
    // Subscribe before reading the initial list so shell output cannot fall through a gap.
    let alive = true
    const unsubscribe = api.on((event) => {
      if (event.type === 'terminal-changed') setSessions((all) => all.some((entry) => entry.id === event.terminal.id) ? all.map((entry) => entry.id === event.terminal.id ? event.terminal : entry) : [...all, event.terminal])
      if (event.type === 'terminal-closed') setSessions((all) => all.filter((entry) => entry.id !== event.id))
    })
    void api.terminal.list().then((list) => { if (alive) { setSessions(list); setLoaded(true) } }).catch((cause) => { if (alive) { setError(remoteErrorMessage(cause)); setLoaded(true) } })
    return () => { alive = false; unsubscribe() }
  }, [])

  const create = async (): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setError(null)
    try {
      const session = await api.terminal.create(threadId)
      setSessions((all) => all.some((entry) => entry.id === session.id) ? all : [...all, session])
      setSelected((all) => ({ ...all, [threadId]: session.id }))
    } catch (cause) {
      setError(remoteErrorMessage(cause))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  // First open starts a shell; hiding the panel never disposes it.
  const openedThreads = useRef(new Set<string>())
  useEffect(() => {
    if (!open || !loaded || openedThreads.current.has(threadId)) return
    openedThreads.current.add(threadId)
    if (!current.length) void create()
  }, [open, threadId, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="terminal-panel" aria-label="Terminais do projeto" hidden={!open}>
      <div className="terminal-head">
        <TerminalIcon size={14} aria-hidden /><strong>Terminal</strong>
      </div>
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Terminais abertos">
          {current.map((session) => (
            <div className="terminal-tab" key={session.id}>
              <button role="tab" aria-selected={active?.id === session.id} onClick={() => setSelected((all) => ({ ...all, [threadId]: session.id }))}>
                {session.title}{session.exitCode !== undefined ? ` · encerrado (${session.exitCode})` : ''}
              </button>
              <button className="terminal-icon" aria-label={`Encerrar ${session.title}`} title="Encerrar terminal e seus processos" onClick={() => void api.terminal.close(session.id).catch((cause) => setError(remoteErrorMessage(cause)))}><X size={12} /></button>
            </div>
          ))}
        </div>
        <button className="terminal-icon" aria-label="Novo terminal" title="Novo terminal na pasta do projeto" disabled={creating} onClick={() => void create()}><Plus size={15} /></button>
        <button className="terminal-icon" aria-label="Ocultar terminais" title="Ocultar sem encerrar as sessões" onClick={onClose}><X size={15} /></button>
      </div>
      <p className="terminal-hint">Sessões locais · comandos rodam com suas permissões.</p>
      {error && <div className="terminal-error" role="alert">{error}</div>}
      {!current.length && <div className="terminal-empty">{creating ? 'Abrindo terminal…' : <button className="button" onClick={() => void create()}>Abrir terminal</button>}</div>}
      {sessions.map((session) => <TerminalView key={session.id} session={session} active={open && session.id === active?.id && session.threadId === threadId} onError={setError} />)}
    </aside>
  )
}
