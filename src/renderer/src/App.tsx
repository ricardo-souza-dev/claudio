import { Folder, Plus, Settings as SettingsIcon, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { sameModel, type ModelRef, type PermissionMode } from '../../shared/types'
import { Composer, type ComposerHandle, type ComposerMode } from './Composer'
import { folderName, relativeDay } from './format'
import { ModelPicker } from './ModelPicker'
import { Settings } from './Settings'
import { api, useAppStore } from './store'
import { Transcript } from './Transcript'

function Mark() {
  return (
    <svg className="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M9 0v18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="4" fill="currentColor" />
    </svg>
  )
}

export function App() {
  const store = useAppStore()
  const { state } = store
  const { thread, listing, prefs } = state
  const [picker, setPicker] = useState<'model' | 'voices' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('agent')
  const [toolCount, setToolCount] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const composer = useRef<ComposerHandle>(null)

  const running = thread ? state.running[thread.id] === true : false
  const hasProviders = listing.models.length > 0
  // A thread remembers its model; otherwise the last one used, otherwise the first available.
  const firstModel = listing.models[0]
  const model: ModelRef | null =
    thread?.model ?? prefs.lastModel ?? (firstModel ? { provider: firstModel.provider, id: firstModel.id } : null)

  useEffect(() => {
    if (!thread) return
    void api.system.toolCount(thread.workspace).then(setToolCount)
  }, [thread?.id, thread?.workspace, state.mcp]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    composer.current?.focus()
  }, [thread?.id])

  const startNew = useCallback(() => {
    // An untouched conversation is already a new one.
    if (thread && thread.messages.length === 0 && !state.running[thread.id]) {
      composer.current?.focus()
      return
    }
    // Most new conversations continue in the same project.
    void store.newThread(model, thread?.workspace ?? null)
  }, [thread, model, store, state.running])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (settingsOpen || !(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setPicker('model')
      } else if (key === 'n') {
        event.preventDefault()
        startNew()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startNew, settingsOpen])

  if (!state.ready || !thread) return <div className="splash" />

  const chooseModel = (next: ModelRef): void => {
    void api.threads.setModel(thread.id, next)
    store.patchThread({ ...thread, model: next })
    void store.setPrefs({ lastModel: next })
  }

  const toggleVoice = (voice: ModelRef): void => {
    const exists = prefs.councilVoices.some((entry) => sameModel(entry, voice))
    void store.setPrefs({ councilVoices: exists ? prefs.councilVoices.filter((entry) => !sameModel(entry, voice)) : [...prefs.councilVoices, voice] })
  }

  const send = (text: string): void => {
    if (!model) return
    const base = { threadId: thread.id, text, model, permissionMode: prefs.permissionMode }
    store.send(mode === 'council' ? { ...base, mode: 'council', voices: prefs.councilVoices } : { ...base, mode: 'agent' })
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await api.system.pickFolder()
    if (folder) store.patchThread(await api.threads.setWorkspace(thread.id, folder))
  }

  const folderLocked = thread.system !== null
  const empty = thread.messages.length === 0 && !running

  let lastGroup = ''

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span>claudio</span>
        </div>
        <button className="new-thread" onClick={startNew} title="Nova conversa (Ctrl+N)">
          <Plus size={14} aria-hidden /> Nova conversa
        </button>
        <nav className="thread-list" aria-label="Conversas">
          {state.summaries.map((summary) => {
            const group = relativeDay(summary.updatedAt)
            const heading = group !== lastGroup ? group : null
            lastGroup = group
            return (
              <div key={summary.id}>
                {heading && <div className="thread-group">{heading}</div>}
                <div className={`thread-item${summary.id === thread.id ? ' active' : ''}`} onMouseLeave={() => setConfirmingDelete(null)}>
                  <button className="thread-open" onClick={() => void store.openThread(summary.id)} aria-current={summary.id === thread.id}>
                    {state.running[summary.id] && <span className="node pulse small" aria-hidden />}
                    <span className="thread-title">{summary.title}</span>
                  </button>
                  {confirmingDelete === summary.id ? (
                    <button
                      className="thread-delete confirming"
                      aria-label={`Confirmar: apagar “${summary.title}” para sempre`}
                      onBlur={() => setConfirmingDelete(null)}
                      onClick={() => {
                        setConfirmingDelete(null)
                        void store.removeThread(summary.id, thread.id, model)
                      }}
                    >
                      Apagar?
                    </button>
                  ) : (
                    <button className="thread-delete" aria-label={`Apagar “${summary.title}”`} title="Apagar" onClick={() => setConfirmingDelete(summary.id)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </nav>
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={14} aria-hidden /> Ajustes
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{thread.title}</div>
          <div className="topbar-chips">
            {thread.contextFiles.length > 0 && (
              <span className="context-chip" title={`Instruções do projeto: ${thread.contextFiles.join(', ')}`}>
                {thread.contextFiles.join(' · ')}
              </span>
            )}
            <span className="context-chip" title="Ferramentas disponíveis para qualquer modelo nesta conversa">
              <Wrench size={12} aria-hidden /> {toolCount}
            </span>
            <button className="context-chip action" disabled={folderLocked} onClick={() => void pickFolder()} title={folderLocked ? `${thread.workspace ?? 'Sem pasta'}. A pasta é definida antes da primeira mensagem.` : (thread.workspace ?? 'Escolher a pasta de trabalho')}>
              <Folder size={12} aria-hidden /> {thread.workspace ? folderName(thread.workspace) : 'Sem pasta'}
            </button>
          </div>
        </header>

        {empty ? (
          <div className="welcome">
            <h1>Uma conversa. Qualquer modelo.</h1>
            <p>Comece com um modelo e troque quando quiser. A conversa, a memória e as ferramentas continuam as mesmas.</p>
            {!hasProviders && !state.loadingModels && (
              <button className="button primary" onClick={() => setSettingsOpen(true)}>
                Conectar o primeiro provedor
              </button>
            )}
          </div>
        ) : (
          <Transcript
            thread={thread}
            models={listing.models}
            live={state.live[thread.id]}
            running={running}
            approvals={state.approvals[thread.id] ?? []}
            notices={state.notices[thread.id] ?? []}
            error={state.errors[thread.id]}
            onRetry={() => send('')}
            onChangeModel={() => setPicker('model')}
          />
        )}

        <Composer
          ref={composer}
          mode={mode}
          model={model}
          voices={prefs.councilVoices}
          models={listing.models}
          permission={prefs.permissionMode}
          running={running}
          hasTools={toolCount > 0}
          onModeChange={setMode}
          onPickModel={() => setPicker('model')}
          onPickVoices={() => setPicker('voices')}
          onRemoveVoice={toggleVoice}
          onPermissionChange={(next: PermissionMode) => void store.setPrefs({ permissionMode: next })}
          onSend={send}
          onStop={() => void api.chat.stop(thread.id)}
        />
      </main>

      {picker && (
        <ModelPicker
          listing={listing}
          loading={state.loadingModels}
          mode={picker === 'voices' ? 'multiple' : 'single'}
          title={picker === 'voices' ? 'Quem responde no conselho?' : mode === 'council' ? 'Quem une as respostas?' : 'Quem continua a conversa?'}
          selected={picker === 'voices' ? prefs.councilVoices : model ? [model] : []}
          onSelect={picker === 'voices' ? toggleVoice : chooseModel}
          onRefresh={() => void store.refreshModels(true)}
          onClose={() => {
            setPicker(null)
            composer.current?.focus()
          }}
          onOpenSettings={() => {
            setPicker(null)
            setSettingsOpen(true)
          }}
        />
      )}

      {settingsOpen && (
        <Settings
          providers={state.providers}
          models={listing.models}
          errors={listing.errors}
          mcp={state.mcp}
          prefs={prefs}
          onProviders={store.setProviders}
          onMcp={store.setMcp}
          onPrefs={store.setPrefs}
          onClose={() => {
            setSettingsOpen(false)
            composer.current?.focus()
          }}
        />
      )}
    </div>
  )
}
