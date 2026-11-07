// The canonical model of a conversation. Every provider adapter translates to
// and from these types, which is what lets one thread pass between models.

export type Protocol = 'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini'

export interface ModelRef {
  provider: string
  id: string
}

/** How hard a model should work, from fastest and cheapest to most thorough. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

/** The strongest supported level that doesn't exceed the one asked for. */
export function clampEffort(wanted: Effort, supported: readonly Effort[]): Effort | undefined {
  const rank = EFFORT_LEVELS.indexOf(wanted)
  return supported.filter((level) => EFFORT_LEVELS.indexOf(level) <= rank).at(-1) ?? supported[0]
}

/** US dollars per million tokens. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
}

export interface ModelInfo extends ModelRef {
  label: string
  providerName: string
  contextWindow?: number
  maxOutput?: number
  /** The model can stream a readable summary of its reasoning. */
  thinking?: boolean
  /** Effort levels the model accepts, weakest first. */
  efforts?: Effort[]
  pricing?: ModelPricing
  reasoning?: boolean
  supportsTools?: boolean
  imageInput?: boolean
  released?: string
  /** Measured on this computer, from this model's earlier answers. */
  speed?: ModelSpeed
}

export interface ModelSpeed {
  tokensPerSecond: number
  firstTokenMs: number
}

export interface PlanItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface Usage {
  input: number
  output: number
  cached?: number
}

export type StopReason = 'end' | 'tool_use' | 'length' | 'refusal' | 'aborted' | 'error'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}
export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  input: unknown
  /** Set when the model produced arguments that could not be parsed. */
  invalid?: string
}
export interface ToolResultPart {
  type: 'tool_result'
  callId: string
  name: string
  content: string
  isError?: boolean
  /** Stopped by the user or by the permission mode, rather than failing. */
  denied?: boolean
}
/** A file the user attached. The bytes live on disk under `ref`, and `data` is only filled in to send. */
export interface AttachmentPart {
  type: 'attachment'
  name: string
  mediaType: string
  size: number
  ref: string
  data?: string
}
export type Part = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | AttachmentPart

/** A file on its way from the message box, as base64. */
export interface OutgoingAttachment {
  name: string
  mediaType: string
  data: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  parts: Part[]
  createdAt: number
  /** The model that actually wrote this message. */
  model?: ModelRef
  usage?: Usage
  stop?: StopReason
  /**
   * The provider's own wire format, replayed verbatim when the same provider
   * (and for some protocols, the same model) continues the thread. It carries
   * what the canonical parts cannot: signed thinking and encrypted reasoning.
   */
  raw?: { provider: string; model: string; data: unknown }
  /** A refused turn is shown to the user but never replayed to any model. */
  excluded?: boolean
}

export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspace: string | null
  model: ModelRef | null
  /** Rendered once at the first send and then frozen, so every model sees the same bytes. */
  system: string | null
  contextFiles: string[]
  /** Tools the user allowed for the rest of this conversation. */
  allowedTools: string[]
  messages: Message[]
  /** The task list the current model keeps while it works. Never sent back to models. */
  plan?: PlanItem[]
}

export interface ThreadSummary {
  id: string
  title: string
  updatedAt: number
  workspace: string | null
}

export type PermissionMode = 'ask' | 'auto-edit' | 'read-only'
export type Risk = 'read' | 'sensitive' | 'write' | 'exec' | 'external'
export type ApprovalDecision = 'allow' | 'allow-always' | 'deny'

export type ApprovalPreview =
  | { kind: 'command'; command: string; cwd?: string }
  | { kind: 'edit'; path: string; before: string; after: string }
  | { kind: 'write'; path: string; content: string; truncated: boolean }
  | { kind: 'path'; path: string }
  | { kind: 'json'; json: string }

export interface ApprovalRequest {
  id: string
  callId: string
  tool: string
  risk: Risk
  preview: ApprovalPreview
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  options: QuestionOption[]
  /** More than one option can be chosen. */
  multiple?: boolean
}

/** Questions a model asks with options to click, instead of in the text of its reply. */
export interface QuestionRequest {
  id: string
  callId: string
  questions: Question[]
}

/** One per question, in order: the options chosen and, when written, the person's own words. */
export interface QuestionAnswer {
  chosen: string[]
  other?: string
}

export type SendRequest = {
  threadId: string
  /** Empty means: run again from the last user message. */
  text: string
  permissionMode: PermissionMode
  /** Null or absent leaves the choice to the model's own default. */
  effort?: Effort | null
  /** Shown to the user when the run starts, such as why a model was chosen. */
  note?: string
  attachments?: OutgoingAttachment[]
  model: ModelRef
}

export interface UpdateStatus {
  state: 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

export type UniEvent =
  | { type: 'update'; status: UpdateStatus }
  | { type: 'thread'; thread: Thread }
  | { type: 'threads'; threads: ThreadSummary[] }
  | { type: 'run'; threadId: string; running: boolean }
  | { type: 'delta'; threadId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'reset'; threadId: string }
  | { type: 'approval'; threadId: string; approval: ApprovalRequest }
  | { type: 'approval-done'; threadId: string; id: string }
  | { type: 'question'; threadId: string; request: QuestionRequest }
  | { type: 'question-done'; threadId: string; id: string }
  | { type: 'notice'; threadId: string; text: string }
  | { type: 'error'; threadId: string; text: string }
  | { type: 'mcp'; servers: McpStatus[] }
  | { type: 'models-changed' }

export const NEW_THREAD_TITLE = 'Nova conversa'
/** The task list a model keeps while it works. The interface draws it instead of a tool row. */
export const PLAN_TOOL = 'update_plan'
/** Questions with options to click. The interface draws a card, and the answer is the tool's result. */
export const ASK_TOOL = 'ask_user'

export interface ProviderView {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  defaultBaseUrl: string
  custom: boolean
  local: boolean
  needsKey: boolean
  keySource: 'saved' | 'env' | null
  envKey?: string
  keyUrl?: string
}

export interface ProviderTest {
  ok: boolean
  count?: number
  error?: string
}

export interface ModelListing {
  models: ModelInfo[]
  errors: Record<string, string>
}

export interface McpStatus {
  name: string
  transport: 'stdio' | 'http'
  /** The command line or URL, with no secret values. */
  target: string
  secretNames: string[]
  status: 'connecting' | 'connected' | 'error'
  error?: string
  tools: { name: string; description: string }[]
}

export interface GitFile {
  path: string
  /** Porcelain codes: the staged state and the working tree state. "." means unchanged. */
  index: string
  worktree: string
  renamedFrom?: string
  untracked?: boolean
  conflicted?: boolean
  /** A submodule inside this repository. Its own changes belong to its own repository. */
  submodule?: boolean
}

/** A repository inside the project. `path` is relative to the project, and empty for its root. */
export interface RepoRef {
  path: string
  name: string
  kind: 'root' | 'submodule' | 'nested'
}

export interface ProjectRepos {
  repos: RepoRef[]
  /** Submodules declared by the root repository that haven't been downloaded. */
  uninitializedSubmodules: string[]
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  /** Seconds since the epoch. */
  at: number
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
  files: GitFile[]
  branches: GitBranch[]
  commits: GitCommit[]
}

export type GitAction =
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'discard'; paths: string[] }
  | { type: 'commit'; message: string }
  | { type: 'switch'; branch: string }
  | { type: 'create-branch'; branch: string }
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push' }
  | { type: 'sync' }
  | { type: 'init' }
  | { type: 'init-submodules' }

export interface PullRequest {
  number: number
  title: string
  branch: string
  url: string
  author: string
  draft: boolean
  review: string | null
}

export interface PrListing {
  /** False when the GitHub CLI isn't installed. */
  available: boolean
  prs: PullRequest[]
  error?: string
}

export interface ProjectFile {
  text: string
  truncated: boolean
  binary: boolean
}

export interface Preferences {
  theme: 'system' | 'light' | 'dark'
  memory: string
  lastModel: ModelRef | null
  permissionMode: PermissionMode
  effort: Effort | null
  /** Let Claudio choose the model for each message. */
  autoModel: boolean
}

/** Everything the renderer may ask of the main process. Secrets only ever flow inward. */
export interface UniApi {
  platform: string
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateStatus>
    install(): Promise<void>
  }
  prefs: {
    get(): Promise<Preferences>
    set(patch: Partial<Preferences>): Promise<Preferences>
  }
  providers: {
    list(): Promise<ProviderView[]>
    setKey(id: string, key: string | null): Promise<ProviderView[]>
    setBaseUrl(id: string, baseUrl: string | null): Promise<ProviderView[]>
    addCustom(input: { name: string; protocol: Protocol; baseUrl: string; key?: string }): Promise<ProviderView[]>
    removeCustom(id: string): Promise<ProviderView[]>
    test(id: string): Promise<ProviderTest>
  }
  models: {
    list(refresh?: boolean): Promise<ModelListing>
  }
  threads: {
    list(): Promise<ThreadSummary[]>
    get(id: string): Promise<Thread | null>
    create(workspace: string | null, model: ModelRef | null): Promise<Thread>
    remove(id: string): Promise<ThreadSummary[]>
    rename(id: string, title: string): Promise<void>
    setWorkspace(id: string, workspace: string | null): Promise<Thread>
    setModel(id: string, model: ModelRef): Promise<void>
  }
  chat: {
    send(request: SendRequest): Promise<void>
    stop(threadId: string): Promise<void>
    respond(threadId: string, approvalId: string, decision: ApprovalDecision): Promise<void>
    /** Null means the person skipped the questions. */
    answer(threadId: string, requestId: string, answers: QuestionAnswer[] | null): Promise<void>
  }
  mcp: {
    list(): Promise<McpStatus[]>
    /** Accepts the common { "mcpServers": { ... } } JSON format. */
    add(json: string): Promise<McpStatus[]>
    remove(name: string): Promise<McpStatus[]>
    reconnect(name: string): Promise<McpStatus[]>
  }
  attachments: {
    /** A data URL for showing a stored image. */
    preview(ref: string): Promise<string | null>
  }
  project: {
    repos(threadId: string): Promise<ProjectRepos>
    git(threadId: string, repo: string): Promise<GitStatus>
    act(threadId: string, repo: string, action: GitAction): Promise<GitStatus>
    diff(threadId: string, repo: string, path: string, staged: boolean): Promise<string>
    prs(threadId: string, repo: string): Promise<PrListing>
    createPr(threadId: string, repo: string, input: { title: string; body: string }): Promise<string>
    checkoutPr(threadId: string, repo: string, number: number): Promise<GitStatus>
    /** Has a model read the changes and write the commit message. */
    commitMessage(threadId: string, repo: string, model: ModelRef): Promise<string>
    files(threadId: string): Promise<string[]>
    read(threadId: string, path: string): Promise<ProjectFile>
  }
  system: {
    pickFolder(): Promise<string | null>
    openExternal(url: string): Promise<void>
    toolCount(workspace: string | null): Promise<number>
  }
  on(listener: (event: UniEvent) => void): () => void
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id
}
