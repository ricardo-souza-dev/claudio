import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron'
import type { ApprovalDecision, ApprovalRequest, GitAction, ModelRef, Protocol, QuestionAnswer, QuestionRequest, SendRequest, UniEvent } from '../shared/types'
import { Runner } from './agent/runner'
import { AttachmentStore } from './attachments'
import { generateCommitMessage } from './commit-message'
import { discoverRepositories, GitService } from './git'
import { ModelFactsStore } from './model-facts'
import { ModelDirectory } from './models'
import { resolveProjectRoot } from './project'
import { SettingsStore, ThreadStore, type Vault } from './store'
import { resolveInside, workspaceTools } from './tools/builtin'
import { McpManager, parseMcpJson } from './tools/mcp'
import electronUpdater from 'electron-updater'
import { UpdateService } from './updates'

const DARK = { background: '#1e1e1e', symbols: '#ececec' }
const LIGHT = { background: '#f7f7f7', symbols: '#1a1a1a' }
const TITLE_BAR_HEIGHT = 40
const ICON = join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

const vault: Vault = {
  async encrypt(text) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Este sistema não oferece armazenamento seguro, então a chave não foi salva. Use uma variável de ambiente.')
    }
    return (await safeStorage.encryptStringAsync(text)).toString('base64')
  },
  decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data, 'base64'))).result
}

let window: BrowserWindow | null = null

function palette() {
  return nativeTheme.shouldUseDarkColors ? DARK : LIGHT
}

function createWindow(): void {
  const colors = palette()
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: ICON,
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: colors.background, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    window = null
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function emit(event: UniEvent): void {
  window?.webContents.send('uni:event', event)
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const trusted = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
  if (!trusted) throw new Error('Origem não autorizada.')
}

function handle<Args extends unknown[], Result>(channel: string, fn: (...args: Args) => Result | Promise<Result>): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return fn(...(args as Args))
  })
}

async function start(): Promise<void> {
  const dataDir = app.getPath('userData')
  const settings = new SettingsStore(dataDir, vault)
  const threads = new ThreadStore(dataDir)
  await settings.load()
  nativeTheme.themeSource = settings.prefs().theme
  await threads.load()

  const attachments = new AttachmentStore(dataDir)
  const facts = new ModelFactsStore(dataDir, undefined, () => emit({ type: 'models-changed' }))
  await facts.load()
  const models = new ModelDirectory(settings, facts)
  const mcp = new McpManager((servers) => emit({ type: 'mcp', servers }))
  for (const server of await settings.mcpServers()) mcp.connect(server)

  const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
  const pendingQuestions = new Map<string, (answers: QuestionAnswer[] | null) => void>()

  const toolsFor = (workspace: string | null) => [...(workspace ? workspaceTools(workspace) : []), ...mcp.tools()]

  const runner = new Runner({
    resolveModel: (ref) => models.resolve(ref),
    toolsFor,
    memory: () => settings.prefs().memory,
    emit,
    save: (thread) => threads.save(thread),
    saveAttachments: (files) => attachments.save(files),
    loadAttachments: (messages, model) => attachments.load(messages, model),
    recordSpeed: (ref, firstTokenMs, generatingMs, outputTokens) => settings.recordSpeed(ref, firstTokenMs, generatingMs, outputTokens),
    requestApproval: (threadId: string, request: ApprovalRequest, signal: AbortSignal) =>
      new Promise<ApprovalDecision>((resolve) => {
        const finish = (decision: ApprovalDecision): void => {
          pendingApprovals.delete(request.id)
          signal.removeEventListener('abort', onAbort)
          emit({ type: 'approval-done', threadId, id: request.id })
          resolve(decision)
        }
        const onAbort = (): void => finish('deny')
        signal.addEventListener('abort', onAbort, { once: true })
        pendingApprovals.set(request.id, finish)
        emit({ type: 'approval', threadId, approval: request })
      }),
    askUser: (threadId: string, request: QuestionRequest, signal: AbortSignal) =>
      new Promise<QuestionAnswer[] | null>((resolve) => {
        const finish = (answers: QuestionAnswer[] | null): void => {
          pendingQuestions.delete(request.id)
          signal.removeEventListener('abort', onAbort)
          emit({ type: 'question-done', threadId, id: request.id })
          resolve(answers)
        }
        const onAbort = (): void => finish(null)
        signal.addEventListener('abort', onAbort, { once: true })
        pendingQuestions.set(request.id, finish)
        emit({ type: 'question', threadId, request })
      })
  })

  const updates = new UpdateService(electronUpdater.autoUpdater, app.getVersion(), app.isPackaged && process.platform === 'win32', () => runner.hasActiveRuns, (status) => emit({ type: 'update', status }))
  handle('updates.status', () => updates.status())
  handle('updates.check', () => updates.check())
  handle('updates.download', () => updates.download())
  handle('updates.install', () => updates.install())
  if (app.isPackaged && process.platform === 'win32') {
    const initial = setTimeout(() => void updates.check(), 20_000)
    const periodic = setInterval(() => void updates.check(), 6 * 60 * 60 * 1000)
    app.on('before-quit', () => { clearTimeout(initial); clearInterval(periodic) })
  }

  handle('prefs.get', () => settings.prefs())
  handle('prefs.set', async (patch: Parameters<SettingsStore['setPrefs']>[0]) => {
    const prefs = await settings.setPrefs(patch)
    nativeTheme.themeSource = prefs.theme
    return prefs
  })

  handle('providers.list', () => settings.providers())
  handle('providers.setKey', async (id: string, key: string | null) => {
    await settings.setKey(id, key)
    models.invalidate(id)
    return settings.providers()
  })
  handle('providers.setBaseUrl', async (id: string, baseUrl: string | null) => {
    await settings.setBaseUrl(id, baseUrl)
    models.invalidate(id)
    return settings.providers()
  })
  handle('providers.addCustom', async (input: { name: string; protocol: Protocol; baseUrl: string; key?: string }) => {
    await settings.addCustom(input)
    return settings.providers()
  })
  handle('providers.removeCustom', async (id: string) => {
    await settings.removeCustom(id)
    models.invalidate(id)
    return settings.providers()
  })
  handle('providers.test', (id: string) => models.test(id))
  handle('models.list', (refresh?: boolean) => models.list(refresh))

  handle('threads.list', () => threads.list())
  handle('threads.get', (id: string) => threads.get(id))
  handle('threads.create', async (workspace: string | null, model: ModelRef | null) => {
    // A project that was moved or deleted sends the new conversation back to the project chooser.
    const root = workspace ? await resolveProjectRoot(workspace).catch(() => null) : null
    return threads.create(root, model)
  })
  handle('threads.remove', async (id: string) => {
    runner.stop(id)
    await threads.remove(id)
    return threads.list()
  })
  handle('threads.rename', async (id: string, title: string) => {
    const thread = await threads.get(id)
    if (!thread || !title.trim()) return
    thread.title = title.trim().slice(0, 120)
    await threads.save(thread)
    emit({ type: 'threads', threads: threads.list() })
  })
  handle('threads.setWorkspace', async (id: string, workspace: string | null) => {
    const thread = await threads.get(id)
    if (!thread) throw new Error('Conversa não encontrada.')
    // The folder is part of the frozen context the models were told about.
    if (thread.system !== null) throw new Error('O projeto só pode mudar antes da primeira mensagem.')
    thread.workspace = workspace ? await resolveProjectRoot(workspace) : null
    await threads.save(thread)
    return thread
  })
  handle('threads.setModel', async (id: string, model: ModelRef) => {
    const thread = await threads.get(id)
    if (!thread) return
    thread.model = model
    await threads.save(thread)
  })

  handle('chat.send', async (request: SendRequest) => {
    const thread = await threads.get(request.threadId)
    if (!thread) throw new Error('Conversa não encontrada.')
    if (!thread.workspace) throw new Error('Toda conversa precisa de um projeto. Abra uma conversa nova em uma pasta.')
    await resolveProjectRoot(thread.workspace)
    if (updates.isInstalling) throw new Error('O Claudio está reiniciando para atualizar. Aguarde a reabertura.')
    if (runner.isRunning(thread.id)) throw new Error('Esta conversa já está em andamento.')
    void runner.send(thread, request).then(() => emit({ type: 'threads', threads: threads.list() }))
  })
  handle('chat.stop', (threadId: string) => runner.stop(threadId))
  handle('chat.respond', (_threadId: string, approvalId: string, decision: ApprovalDecision) => {
    pendingApprovals.get(approvalId)?.(decision)
  })
  handle('chat.answer', (_threadId: string, requestId: string, answers: unknown) => {
    // Only lists of words go back to the model, whatever the page sends.
    const clean = Array.isArray(answers)
      ? answers.map((answer: { chosen?: unknown; other?: unknown } | null) => ({
          chosen: Array.isArray(answer?.chosen) ? answer.chosen.map(String) : [],
          ...(typeof answer?.other === 'string' ? { other: answer.other } : {})
        }))
      : null
    pendingQuestions.get(requestId)?.(clean)
  })

  // Each request names a conversation, and the project folder comes from it, not from the page.
  const workspaceOf = async (threadId: string): Promise<string> => {
    const thread = await threads.get(threadId)
    if (!thread?.workspace) throw new Error('Esta conversa não tem um projeto.')
    return thread.workspace
  }
  const gitFor = async (threadId: string, repo = ''): Promise<GitService> => {
    const workspace = await workspaceOf(threadId)
    const gh = process.env.CLAUDIO_GH_COMMAND ? (JSON.parse(process.env.CLAUDIO_GH_COMMAND) as string[]) : undefined
    return new GitService(repo ? await resolveInside(workspace, repo) : workspace, gh)
  }
  handle('attachments.preview', (ref: string) => attachments.preview(ref))
  handle('project.repos', async (threadId: string) => discoverRepositories(await workspaceOf(threadId)))
  handle('project.git', async (threadId: string, repo: string) => (await gitFor(threadId, repo)).status())
  handle('project.act', async (threadId: string, repo: string, action: GitAction) => {
    const git = await gitFor(threadId, repo)
    await git.act(action)
    return git.status()
  })
  handle('project.diff', async (threadId: string, repo: string, file: string, staged: boolean) => (await gitFor(threadId, repo)).diff(file, staged))
  handle('project.prs', async (threadId: string, repo: string) => (await gitFor(threadId, repo)).pullRequests())
  handle('project.createPr', async (threadId: string, repo: string, input: { title: string; body: string }) => (await gitFor(threadId, repo)).createPullRequest(input))
  handle('project.checkoutPr', async (threadId: string, repo: string, number: number) => {
    const git = await gitFor(threadId, repo)
    await git.checkoutPullRequest(number)
    return git.status()
  })
  handle('project.commitMessage', async (threadId: string, repo: string, ref: ModelRef) => {
    const changes = await (await gitFor(threadId, repo)).changesForMessage()
    const { adapter, info } = await models.resolve(ref)
    return generateCommitMessage(adapter, info, changes)
  })
  handle('project.files', async (threadId: string) => (await gitFor(threadId)).listFiles())
  handle('project.read', async (threadId: string, file: string) => (await gitFor(threadId)).read(file))

  handle('mcp.list', () => mcp.status())
  handle('mcp.add', async (json: string) => {
    const incoming = parseMcpJson(json)
    const kept = (await settings.mcpServers()).filter((server) => !incoming.some((entry) => entry.name === server.name))
    await settings.setMcpServers([...kept, ...incoming])
    for (const server of incoming) mcp.connect(server)
    return mcp.status()
  })
  handle('mcp.remove', async (name: string) => {
    await settings.setMcpServers((await settings.mcpServers()).filter((server) => server.name !== name))
    await mcp.remove(name)
    return mcp.status()
  })
  handle('mcp.reconnect', async (name: string) => {
    const server = (await settings.mcpServers()).find((entry) => entry.name === name)
    if (server) mcp.connect(server)
    return mcp.status()
  })

  handle('system.pickFolder', async () => {
    const options: Electron.OpenDialogOptions = { title: 'Escolha a pasta do projeto', properties: ['openDirectory'] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('system.openExternal', async (url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
  handle('system.toolCount', (workspace: string | null) => toolsFor(workspace).length)

  nativeTheme.on('updated', () => {
    const colors = palette()
    window?.setBackgroundColor(colors.background)
    if (process.platform !== 'darwin') {
      window?.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT })
    }
  })

  app.on('before-quit', () => {
    runner.stopAll()
    void mcp.closeAll()
  })

  createWindow()
}

// Lets a separate data folder run in isolation, as the end-to-end tests do.
if (process.env.CLAUDIO_DATA_DIR) app.setPath('userData', process.env.CLAUDIO_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  // Gives the taskbar its own entry for this app, instead of grouping it with other Electron apps.
  if (process.platform === 'win32') app.setAppUserModelId('dev.claudio.app')
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (!window) createWindow()
  })
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    if (process.platform === 'darwin') app.dock?.setIcon(ICON)
    return start()
  })
}
