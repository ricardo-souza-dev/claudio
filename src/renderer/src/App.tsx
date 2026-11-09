import { ChevronRight, Folder, FolderOpen, Monitor, Moon, PanelRight, Pencil, Plus, Settings as SettingsIcon, Sun, Terminal as TerminalIcon, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { chooseAutoModel, estimateTurn, type TaskInfo } from '../../shared/auto-model'
import { modelKey, NEW_THREAD_TITLE, type Effort, type Message, type ModelInfo, type ModelRef, type OutgoingAttachment, type PermissionMode, type ThreadSummary } from '../../shared/types'
import { summarizeUsage } from '../../shared/usage'
import { ClaudioIllustration } from './ClaudioIllustration'
import { Composer, type ComposerHandle } from './Composer'
import { ContextMeter } from './ContextMeter'
import { folderName, modelLabel, remoteErrorMessage } from './format'
import { LivePanel, type QueuedMessage } from './LivePanel'
import { ModelPicker } from './ModelPicker'
import { ProjectPanel } from './ProjectPanel'
import { Settings } from './Settings'
import { api, useAppStore } from './store'
import { Transcript } from './Transcript'
import { Updates } from './Updates'
import { TerminalPanel } from './TerminalPanel'

/** Below this width the panel stays closed until asked for, leaving the conversation room to breathe. */
const PANEL_MIN_WIDTH = 1100
/** Before the first answer there is no count yet: this covers the instructions and tools. */
const BASELINE_CONTEXT_TOKENS = 2000
const RECENT_MESSAGES = 6

/** What the conversation so far says about the next message. */
function taskFrom(messages: Message[], models: ModelInfo[], text: string, hasImages: boolean): TaskInfo {
  const recentToolCalls = messages.slice(-RECENT_MESSAGES).reduce((sum, message) => sum + message.parts.filter((part) => part.type === 'tool_call').length, 0)
  return { text, hasImages, recentToolCalls, contextTokens: summarizeUsage(messages, models).context || BASELINE_CONTEXT_TOKENS }
}

function Mark() {
  return (
    <svg className="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M9 0v18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="4" fill="currentColor" />
    </svg>
  )
}

interface ProjectGroup {
  workspace: string | null
  threads: ThreadSummary[]
}

/** Conversations by project, most recently used first. Summaries already arrive in that order. */
function groupByProject(summaries: ThreadSummary[]): ProjectGroup[] {
  const groups = new Map<string | null, ProjectGroup>()
  for (const summary of summaries) {
    // A conversation still waiting for its project has nothing to show yet.
    if (summary.workspace === null && summary.title === NEW_THREAD_TITLE) continue
    const group = groups.get(summary.workspace) ?? { workspace: summary.workspace, threads: [] }
    group.threads.push(summary)
    groups.set(summary.workspace, group)
  }
  return [...groups.values()]
}

function ProjectChooser({ recent, error, onChoose }: { recent: string[]; error: string | null; onChoose(folder?: string): void }) {
  return (
    <div className="welcome chooser">
      <ClaudioIllustration />
      <h1>Em qual projeto vamos trabalhar?</h1>
      <p>Toda conversa parte de uma pasta no seu computador. Assim, qualquer modelo trabalha com o contexto geral do projeto.</p>
      <button className="button primary" onClick={() => onChoose()}>
        <FolderOpen size={14} aria-hidden /> Escolher a pasta do projeto
      </button>
      {error && (
        <p className="result failed" role="alert">
          {error}
        </p>
      )}
      {recent.length > 0 && (
        <div className="recent-projects">
          <h2>Recentes</h2>
          {recent.map((folder) => (
            <button key={folder} className="recent-project" onClick={() => onChoose(folder)} title={folder}>
              <Folder size={13} aria-hidden />
              <span className="recent-name">{folderName(folder)}</span>
              <span className="recent-path">{folder}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function App() {
  const store = useAppStore()
  const { state } = store
  const { thread, listing, prefs } = state
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme
  }, [prefs.theme])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const activeThreadId = useRef(thread?.id)
  activeThreadId.current = thread?.id
  const [pickerOpen, setPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toolCount, setToolCount] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState<{ id: string; value: string } | null>(null)
  const titleSaving = useRef(false)
  const saveTitle = async (id: string, value: string) => {
    if (titleSaving.current) return
    titleSaving.current = true
    setEditingTitle(null)
    try {
      if (value.trim()) await api.threads.rename(id, value)
    } finally {
      titleSaving.current = false
    }
  }
  const [projectError, setProjectError] = useState<string | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string | null>>(() => new Set())
  const projectGroupsId = useId()
  // Switching to or creating a conversation reveals it, without preventing manual collapse.
  useEffect(() => {
    const workspace = thread?.workspace
    if (workspace === undefined) return
    setCollapsedProjects((current) => {
      if (!current.has(workspace)) return current
      const next = new Set(current)
      next.delete(workspace)
      return next
    })
  }, [thread?.id, thread?.workspace])
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({})
  const [pickerDraft, setPickerDraft] = useState({ text: '', hasImages: false })
  const [wide, setWide] = useState(() => window.innerWidth >= PANEL_MIN_WIDTH)
  const [panelWhenWide, setPanelWhenWide] = useState(true)
  const [panelWhenNarrow, setPanelWhenNarrow] = useState(false)
  const panelOpen = wide ? panelWhenWide : panelWhenNarrow
  const setPanelOpen = wide ? setPanelWhenWide : setPanelWhenNarrow
  const composer = useRef<ComposerHandle>(null)
  const sendRef = useRef<(text: string, attachments: OutgoingAttachment[]) => void>(() => undefined)
  const sendNowRequested = useRef(false)

  const running = thread ? state.running[thread.id] === true : false
  const hasProviders = listing.models.length > 0
  // A thread remembers its model; otherwise the last one used, otherwise the first available.
  const firstModel = listing.models[0]
  const model: ModelRef | null =
    thread?.model ?? prefs.lastModel ?? (firstModel ? { provider: firstModel.provider, id: firstModel.id } : null)

  const groups = useMemo(() => groupByProject(state.summaries), [state.summaries])
  const recentProjects = useMemo(() => groups.flatMap((group) => (group.workspace ? [group.workspace] : [])), [groups])

  // With little room the panel would cover the message box, so there it only opens on request.
  // That choice lasts while the window stays narrow and leaves the one for a wide window alone.
  useEffect(() => {
    const onResize = (): void => {
      const nowWide = window.innerWidth >= PANEL_MIN_WIDTH
      setWide(nowWide)
      if (nowWide) setPanelWhenNarrow(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!thread) return
    void api.system.toolCount(thread.workspace).then(setToolCount)
  }, [thread?.id, thread?.workspace, state.mcp]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    composer.current?.focus()
    setProjectError(null)
  }, [thread?.id, thread?.workspace])

  // The next queued message goes out when a run ends on its own. After an error or an
  // interruption the person may want something else, so it waits for "Enviar agora".
  useEffect(() => {
    if (!thread || running) return
    const pending = queues[thread.id]
    if (!pending?.length) return
    const forced = sendNowRequested.current
    const interrupted = thread.lastRun === 'aborted' || thread.messages.findLast((message) => message.role === 'assistant')?.stop === 'aborted'
    if (!forced && (interrupted || thread.lastRun === 'error' || state.errors[thread.id])) return
    sendNowRequested.current = false
    setQueues((all) => ({ ...all, [thread.id]: pending.slice(1) }))
    sendRef.current(pending[0].text, pending[0].attachments)
  }, [running, thread?.id, queues]) // eslint-disable-line react-hooks/exhaustive-deps

  const openPicker = useCallback(() => {
    setPickerDraft(composer.current?.draft() ?? { text: '', hasImages: false })
    setPickerOpen(true)
    // Also brings in how fast each model has been since the list was last read.
    void store.refreshModels()
  }, [store])

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
        openPicker()
      } else if (key === 'n') {
        event.preventDefault()
        startNew()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startNew, settingsOpen, openPicker])

  if (!state.ready || !thread) return <div className="splash" />

  const chooseModel = (next: ModelRef): void => {
    void api.threads.setModel(thread.id, next)
    store.patchThread({ ...thread, model: next })
    void store.setPrefs({ lastModel: next, autoModel: false })
  }

  // Stepping down mid-conversation loses the prompt cache. A conversation with no answers yet has none.
  const inConversation = thread.messages.some((message) => message.role === 'assistant') ? thread.model : null

  const send = (text: string, attachments: OutgoingAttachment[] = []): void => {
    let target = model
    let note: string | undefined
    if (prefs.autoModel && (text.trim() || attachments.length > 0)) {
      const hasImages = attachments.some((file) => file.mediaType.startsWith('image/'))
      const choice = chooseAutoModel(listing.models, taskFrom(thread.messages, listing.models, text, hasImages), inConversation, { profile: prefs.performanceProfile ?? (prefs.economyMode ? 'economy' : 'balanced') })
      if (choice) {
        target = choice.model
        note = choice.note
      } else if (target) {
        note = 'Automático: faltam dados de preço dos modelos conectados, então mantive o modelo atual.'
      }
    }
    if (!target) return
    const hasImages = attachments.some((file) => file.mediaType.startsWith('image/'))
    const task = taskFrom(thread.messages, listing.models, text, hasImages)
    const targetInfo = listing.models.find((entry) => modelKey(entry) === modelKey(target))
    const estimate = targetInfo ? estimateTurn(targetInfo, task).cost : null
    if (estimate !== null && prefs.warnCostUsd > 0 && estimate >= prefs.warnCostUsd) {
      const label = modelLabel(target, listing.models)
      const ok = window.confirm(`Esta mensagem está estimada em US$ ${estimate.toFixed(2)} com ${label}.\n\nEnviar mesmo assim?`)
      if (!ok) return
    }
    const effort: Effort | null = prefs.effort
    const costNote = estimate !== null ? ` Estimativa desta mensagem: US$ ${estimate.toFixed(2)}.` : ''
    store.send({ threadId: thread.id, text, model: target, permissionMode: prefs.permissionMode, effort, compactResponse: prefs.autoModel && (prefs.performanceProfile ?? (prefs.economyMode ? 'economy' : 'balanced')) === 'economy', note: `${note ?? ''}${costNote}`.trim() || undefined, attachments })
  }
  sendRef.current = send

  const queue = queues[thread.id] ?? []
  const updateQueue = (next: QueuedMessage[]): void => setQueues((all) => ({ ...all, [thread.id]: next }))
  const sendQueuedNow = (index: number): void => {
    sendNowRequested.current = true
    updateQueue([queue[index], ...queue.filter((_, position) => position !== index)])
    if (running) void api.chat.stop(thread.id)
  }

  const chooseProject = async (folder?: string): Promise<void> => {
    setProjectError(null)
    const picked = folder ?? (await api.system.pickFolder())
    if (!picked) return
    try {
      store.patchThread(await api.threads.setWorkspace(thread.id, picked))
    } catch (error) {
      setProjectError(remoteErrorMessage(error))
    }
  }

  const openAnotherProject = (): void => {
    // An untouched conversation goes back to the chooser instead of leaving an empty one behind.
    if (thread.messages.length === 0 && !running) {
      if (thread.workspace) void api.threads.setWorkspace(thread.id, null).then(store.patchThread)
      return
    }
    void store.newThread(model, null)
  }

  // Under "Automático", this asks for the model it would pick for an ordinary piece of work.
  const commitRef = prefs.autoModel ? (chooseAutoModel(listing.models, { text: 'revise estas alterações' }, null, { profile: prefs.performanceProfile ?? (prefs.economyMode ? 'economy' : 'balanced') })?.model ?? model) : model
  const commitModel = commitRef ? { ref: commitRef, label: modelLabel(commitRef, listing.models) } : null

  const folderLocked = thread.system !== null
  const needsProject = thread.workspace === null && thread.messages.length === 0 && !running
  // Only conversations from before projects were required can be in this state.
  const withoutProject = thread.workspace === null && !needsProject
  const empty = thread.messages.length === 0 && !running
  const showTerminals = terminalOpen && thread.workspace !== null
  const showPanel = panelOpen && thread.workspace !== null

  return (
    <div className={`app${showPanel ? ' with-panel' : ''}${showTerminals ? ' with-terminal' : ''}`}>
      <aside className="sidebar" aria-label="Navegação principal">
        <div className="brand">
          <Mark />
          <span>claudio</span>
        </div>
        <div className="sidebar-actions">
          <button className="new-thread" onClick={startNew} title="Nova conversa (Ctrl+N)">
            <Plus size={15} aria-hidden />
            <span>Nova conversa</span>
            <kbd aria-hidden>Ctrl N</kbd>
          </button>
          <button className="open-project" onClick={openAnotherProject}>
            <FolderOpen size={15} aria-hidden /> Abrir outro projeto
          </button>
        </div>
        <nav className="thread-list" aria-label="Conversas por projeto">
          {groups.length > 0 && <div className="sidebar-section-label">Projetos</div>}
          {groups.map((group, index) => {
            const name = group.workspace ? folderName(group.workspace) : 'Sem projeto'
            const open = !collapsedProjects.has(group.workspace)
            const groupId = `${projectGroupsId}-${index}`
            return (
              <div className="sidebar-project" key={group.workspace ?? 'sem-projeto'}>
                <div className="thread-group" title={group.workspace ?? undefined}>
                  <button className="thread-group-toggle" aria-label={`Conversas de ${name}`} aria-expanded={open} aria-controls={groupId} onClick={() => setCollapsedProjects((current) => {
                    const next = new Set(current)
                    if (next.has(group.workspace)) next.delete(group.workspace)
                    else next.add(group.workspace)
                    return next
                  })}>
                    <ChevronRight size={12} className={`chevron${open ? ' rotated' : ''}`} aria-hidden />
                    <Folder size={13} aria-hidden />
                    <span className="thread-group-name">{name}</span>
                    <span className="thread-group-count" aria-label={`${group.threads.length} ${group.threads.length === 1 ? 'conversa' : 'conversas'}`}>{group.threads.length}</span>
                  </button>
                  {group.workspace && (
                    <button className="thread-group-add" aria-label={`Nova conversa em ${name}`} title={`Nova conversa em ${name}`} onClick={() => void store.newThread(model, group.workspace)}>
                      <Plus size={13} />
                    </button>
                  )}
                </div>
                <div id={groupId} hidden={!open}>
                {group.threads.map((summary) => (
                  <div key={summary.id} className={`thread-item${summary.id === thread.id ? ' active' : ''}`} onMouseLeave={() => setConfirmingDelete(null)}>
                    <button className="thread-open" title={summary.title} onClick={() => void store.openThread(summary.id)} onDoubleClick={() => setEditingTitle({ id: summary.id, value: summary.title })} aria-current={summary.id === thread.id}>
                      {state.running[summary.id] && <span className="node pulse small" aria-hidden />}
                      <span className="thread-title">{summary.title}</span>
                    </button>
                    {editingTitle?.id === summary.id ? (
                      <input className="thread-rename-input" aria-label="Título da conversa" maxLength={120} autoFocus
                        value={editingTitle.value}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setEditingTitle({ id: summary.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveTitle(summary.id, editingTitle.value)
                          if (event.key === 'Escape') setEditingTitle(null)
                        }}
                        onBlur={() => void saveTitle(summary.id, editingTitle.value)} />
                    ) : (
                      <button className="thread-rename" aria-label={`Renomear “${summary.title}”`} title="Renomear" onClick={() => { setConfirmingDelete(null); setEditingTitle({ id: summary.id, value: summary.title }) }}>
                        <Pencil size={13} aria-hidden />
                      </button>
                    )}
                    {confirmingDelete === summary.id ? (
                      <button
                        className="thread-delete confirming"
                        aria-label={`Confirmar: apagar “${summary.title}” para sempre`}
                        onBlur={(event) => {
                          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setConfirmingDelete(null)
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setConfirmingDelete(null)
                          void store.removeThread(summary.id, thread.id, model, thread.workspace)
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
                ))}
                </div>
              </div>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={15} aria-hidden /> Ajustes
          </button>
          <div className="theme-picker" role="group" aria-label="Tema da aparência">
            {([
              { value: 'light', label: 'Tema claro', Icon: Sun },
              { value: 'dark', label: 'Tema escuro', Icon: Moon },
              { value: 'system', label: 'Seguir tema do sistema', Icon: Monitor }
            ] as const).map(({ value, label, Icon }) => (
              <button key={value} aria-label={label} title={label} aria-pressed={prefs.theme === value} onClick={() => void store.setPrefs({ theme: value })}>
                <Icon size={14} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{needsProject ? 'Escolha um projeto' : thread.title}</div>
          {!needsProject && (
            <div className="topbar-chips">
              {thread.contextFiles.length > 0 && (
                <span className="context-chip" title={`Instruções do projeto: ${thread.contextFiles.join(', ')}`}>
                  {thread.contextFiles.join(' · ')}
                </span>
              )}
              <span className="context-chip" title="Ferramentas disponíveis para qualquer modelo nesta conversa">
                <Wrench size={12} aria-hidden /> {toolCount}
              </span>
              <button
                className="context-chip action"
                disabled={folderLocked}
                onClick={() => void chooseProject()}
                title={folderLocked ? `${thread.workspace ?? 'Sem projeto'}. O projeto é definido antes da primeira mensagem.` : (thread.workspace ?? undefined)}
              >
                <Folder size={12} aria-hidden /> {thread.workspace ? folderName(thread.workspace) : 'Sem projeto'}
              </button>
              {thread.workspace && <button className={`panel-toggle${showTerminals ? ' on' : ''}`} aria-label={showTerminals ? 'Ocultar painel de terminais' : 'Abrir painel de terminais'} aria-pressed={showTerminals} title="Terminal" onClick={() => setTerminalOpen(!terminalOpen)}><TerminalIcon size={15} /></button>}
              {thread.workspace && (
                <button className={`panel-toggle${showPanel ? ' on' : ''}`} aria-label={showPanel ? 'Fechar painel do projeto' : 'Abrir painel do projeto'} aria-pressed={showPanel} title="Painel do projeto" onClick={() => setPanelOpen(!showPanel)}>
                  <PanelRight size={14} />
                </button>
              )}
            </div>
          )}
        </header>
        <Updates compact />

        {needsProject ? (
          <ProjectChooser recent={recentProjects} error={projectError} onChoose={(folder) => void chooseProject(folder)} />
        ) : empty ? (
          <div className="welcome">
            <ClaudioIllustration />
            <h1>Claudio, o queridinho dos devs.</h1>
            <p>Uma conversa, qualquer modelo. Comece com um e troque quando quiser: a conversa, a memória e as ferramentas continuam as mesmas.</p>
            {projectError && (
              <p className="result failed" role="alert">
                {projectError}
              </p>
            )}
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
            questions={state.questions[thread.id] ?? []}
            notices={state.notices[thread.id] ?? []}
            error={state.errors[thread.id]}
            onRetry={() => send('')}
            onChangeModel={openPicker}
          />
        )}

        {withoutProject && (
          <div className="composer">
            <span className="node composer-node" aria-hidden />
            <div className="no-project">
              <span>Esta conversa começou sem projeto, então não pode continuar.</span>
              <button className="button" onClick={openAnotherProject}>
                <FolderOpen size={13} aria-hidden /> Abrir um projeto
              </button>
            </div>
          </div>
        )}

        {thread.workspace !== null && (
          <>
            <LivePanel
              thread={thread}
              live={state.live[thread.id]}
              running={running}
              approvals={state.approvals[thread.id] ?? []}
              queue={queue}
              onContinue={model ? () => send('Continue de onde parou.') : undefined}
              onSendNow={sendQueuedNow}
              onRemove={(index) => updateQueue(queue.filter((_, position) => position !== index))}
            />
            <Composer
              ref={composer}
              model={thread.model ?? (prefs.autoModel ? null : model)}
              autoModel={prefs.autoModel}
              models={listing.models}
              profile={prefs.performanceProfile ?? (prefs.economyMode ? 'economy' : 'balanced')}
              onProfileChange={(performanceProfile) => void store.setPrefs({ performanceProfile, economyMode: performanceProfile === 'economy' })}
              effort={prefs.effort}
              permission={prefs.permissionMode}
              running={running}
              hasTools={toolCount > 0}
              meter={<ContextMeter messages={thread.messages} models={listing.models} model={listing.models.find((entry) => model && modelKey(entry) === modelKey(model))} effort={prefs.effort} />}
              onPickModel={openPicker}
              onEffortChange={(effort) => void store.setPrefs({ effort })}
              onPermissionChange={(next: PermissionMode) => void store.setPrefs({ permissionMode: next })}
              onSend={send}
              onQueue={(text, attachments) => updateQueue([...queue, { text, attachments }])}
              onStop={() => void api.chat.stop(thread.id)}
            />
          </>
        )}
      </main>

      {showPanel && <ProjectPanel threadId={thread.id} workspace={thread.workspace!} running={running} commitModel={commitModel} onRunScript={async (path) => {
        const session = await api.terminal.create(thread.id, path)
        if (activeThreadId.current === session.threadId) setTerminalOpen(true)
      }} onClose={() => setPanelOpen(false)} />}

      <TerminalPanel threadId={thread.id} open={showTerminals} projectOpen={showPanel} onToggleProject={() => setPanelOpen(!showPanel)} onClose={() => setTerminalOpen(false)} />

      {pickerOpen && (
        <ModelPicker
          listing={listing}
          loading={state.loadingModels}
          title="Quem continua a conversa?"
          current={model}
          inConversation={inConversation}
          task={taskFrom(thread.messages, listing.models, pickerDraft.text, pickerDraft.hasImages)}
          auto={{ on: prefs.autoModel, profile: prefs.performanceProfile ?? (prefs.economyMode ? 'economy' : 'balanced'), onSelect: () => void store.setPrefs({ autoModel: true }) }}
          onSelect={chooseModel}
          onRefresh={() => void store.refreshModels(true)}
          onClose={() => {
            setPickerOpen(false)
            composer.current?.focus()
          }}
          onOpenSettings={() => {
            setPickerOpen(false)
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
