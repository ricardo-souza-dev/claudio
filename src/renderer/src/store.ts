import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  type ApprovalRequest,
  type McpStatus,
  type ModelListing,
  type ModelRef,
  type Preferences,
  type ProviderView,
  type QuestionRequest,
  type SendRequest,
  type Thread,
  type ThreadSummary,
  type UniApi,
  type UniEvent
} from '../../shared/types'
import { remoteErrorMessage } from './format'

declare global {
  interface Window {
    uni: UniApi
  }
}

export const api = window.uni

export interface LiveStream {
  text: string
  reasoning: string
}

export interface LiveTurn extends LiveStream {
  startedAt: number
}

const EMPTY_STREAM: LiveStream = { text: '', reasoning: '' }
const EMPTY_LIVE: LiveTurn = { ...EMPTY_STREAM, startedAt: 0 }

export interface AppState {
  ready: boolean
  prefs: Preferences
  providers: ProviderView[]
  listing: ModelListing
  loadingModels: boolean
  mcp: McpStatus[]
  summaries: ThreadSummary[]
  activeId: string | null
  thread: Thread | null
  running: Record<string, boolean>
  live: Record<string, LiveTurn>
  approvals: Record<string, ApprovalRequest[]>
  questions: Record<string, QuestionRequest[]>
  notices: Record<string, string[]>
  errors: Record<string, string | undefined>
}

const INITIAL: AppState = {
  ready: false,
  prefs: { theme: 'system', memory: '', lastModel: null, permissionMode: 'ask', effort: null, autoModel: false },
  providers: [],
  listing: { models: [], errors: {} },
  loadingModels: false,
  mcp: [],
  summaries: [],
  activeId: null,
  thread: null,
  running: {},
  live: {},
  approvals: {},
  questions: {},
  notices: {},
  errors: {}
}

interface Delta {
  threadId: string
  kind: 'text' | 'reasoning'
  text: string
}

type Action =
  | { type: 'event'; event: UniEvent }
  | { type: 'deltas'; deltas: Delta[] }
  | { type: 'patch'; patch: Partial<AppState> }
  | { type: 'open'; thread: Thread | null }

function liveOf(state: AppState, threadId: string): LiveTurn {
  return state.live[threadId] ?? EMPTY_LIVE
}

function withLive(state: AppState, threadId: string, live: LiveTurn): AppState {
  return { ...state, live: { ...state.live, [threadId]: live } }
}

function applyEvent(state: AppState, event: UniEvent): AppState {
  switch (event.type) {
    case 'thread': {
      const { thread } = event
      // A snapshot holds everything streamed so far, so the live overlay starts over.
      const live = liveOf(state, thread.id)
      const next = withLive(state, thread.id, { ...live, ...EMPTY_STREAM })
      const summary = { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, workspace: thread.workspace }
      return {
        ...next,
        thread: state.activeId === thread.id ? thread : state.thread,
        summaries: state.summaries.map((entry) => (entry.id === thread.id ? summary : entry))
      }
    }
    case 'threads':
      return { ...state, summaries: event.threads }
    case 'run':
      return {
        ...state,
        running: { ...state.running, [event.threadId]: event.running },
        // Marked busy here first, and again when the main process confirms: the clock starts once.
        live: event.running
          ? { ...state.live, [event.threadId]: { ...EMPTY_LIVE, startedAt: state.running[event.threadId] ? (state.live[event.threadId]?.startedAt ?? Date.now()) : Date.now() } }
          : state.live,
        notices: event.running ? { ...state.notices, [event.threadId]: [] } : state.notices,
        errors: event.running ? { ...state.errors, [event.threadId]: undefined } : state.errors,
        approvals: event.running ? state.approvals : { ...state.approvals, [event.threadId]: [] },
        questions: event.running ? state.questions : { ...state.questions, [event.threadId]: [] }
      }
    case 'question':
      return { ...state, questions: { ...state.questions, [event.threadId]: [...(state.questions[event.threadId] ?? []), event.request] } }
    case 'question-done':
      return { ...state, questions: { ...state.questions, [event.threadId]: (state.questions[event.threadId] ?? []).filter((entry) => entry.id !== event.id) } }
    case 'reset':
      return withLive(state, event.threadId, { ...liveOf(state, event.threadId), ...EMPTY_STREAM })
    case 'approval':
      return {
        ...state,
        approvals: { ...state.approvals, [event.threadId]: [...(state.approvals[event.threadId] ?? []), event.approval] }
      }
    case 'approval-done':
      return {
        ...state,
        approvals: { ...state.approvals, [event.threadId]: (state.approvals[event.threadId] ?? []).filter((entry) => entry.id !== event.id) }
      }
    case 'notice': {
      const current = state.notices[event.threadId] ?? []
      if (current.includes(event.text)) return state
      return { ...state, notices: { ...state.notices, [event.threadId]: [...current, event.text] } }
    }
    case 'error':
      return { ...state, errors: { ...state.errors, [event.threadId]: event.text } }
    case 'mcp':
      return { ...state, mcp: event.servers }
    case 'update':
    case 'models-changed':
      return state
    case 'delta':
      return applyDeltas(state, [event])
  }
}

function applyDeltas(state: AppState, deltas: Delta[]): AppState {
  let next = state
  for (const { threadId, kind, text } of deltas) {
    const live = liveOf(next, threadId)
    next = withLive(next, threadId, { ...live, [kind]: live[kind] + text })
  }
  return next
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event)
    case 'deltas':
      return applyDeltas(state, action.deltas)
    case 'patch':
      return { ...state, ...action.patch }
    case 'open':
      return { ...state, thread: action.thread, activeId: action.thread?.id ?? null }
  }
}

export function useAppStore() {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const pending = useRef<Delta[]>([])
  const frame = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (pending.current.length === 0) return
    const deltas = pending.current
    pending.current = []
    dispatch({ type: 'deltas', deltas })
  }, [])

  const refreshModels = useCallback(async (refresh = false) => {
    dispatch({ type: 'patch', patch: { loadingModels: true } })
    try {
      const listing = await api.models.list(refresh)
      dispatch({ type: 'patch', patch: { listing } })
    } finally {
      dispatch({ type: 'patch', patch: { loadingModels: false } })
    }
  }, [])

  const openThread = useCallback(async (id: string) => {
    dispatch({ type: 'open', thread: await api.threads.get(id) })
  }, [])

  useEffect(() => {
    const unsubscribe = api.on((event) => {
      if (event.type === 'delta') {
        // Tokens arrive far faster than a screen refreshes.
        pending.current.push(event)
        frame.current ??= requestAnimationFrame(flush)
        return
      }
      flush()
      if (event.type === 'models-changed') void refreshModels()
      dispatch({ type: 'event', event })
    })

    let cancelled = false
    void (async () => {
      const [prefs, providers, mcp, summaries] = await Promise.all([
        api.prefs.get(),
        api.providers.list(),
        api.mcp.list(),
        api.threads.list()
      ])
      if (cancelled) return
      let list = summaries
      let thread: Thread | null = null
      if (list[0]) {
        thread = await api.threads.get(list[0].id)
      } else {
        thread = await api.threads.create(null, prefs.lastModel)
        list = [{ id: thread.id, title: thread.title, updatedAt: thread.updatedAt, workspace: null }]
      }
      if (cancelled) return
      dispatch({ type: 'patch', patch: { prefs, providers, mcp, summaries: list, thread, activeId: thread?.id ?? null, ready: true } })
      void refreshModels()
    })()

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [flush, refreshModels])

  const setPrefs = useCallback(async (patch: Partial<Preferences>) => {
    dispatch({ type: 'patch', patch: { prefs: await api.prefs.set(patch) } })
  }, [])

  const setProviders = useCallback((providers: ProviderView[]) => {
    dispatch({ type: 'patch', patch: { providers } })
    void refreshModels()
  }, [refreshModels])

  const setMcp = useCallback((mcp: McpStatus[]) => dispatch({ type: 'patch', patch: { mcp } }), [])

  const newThread = useCallback(async (model: ModelRef | null, workspace: string | null = null) => {
    const thread = await api.threads.create(workspace, model)
    dispatch({ type: 'patch', patch: { summaries: await api.threads.list() } })
    dispatch({ type: 'open', thread })
  }, [])

  const removeThread = useCallback(
    async (id: string, activeId: string | null, model: ModelRef | null, workspace: string | null) => {
      const summaries = await api.threads.remove(id)
      dispatch({ type: 'patch', patch: { summaries } })
      if (id !== activeId) return
      if (summaries[0]) await openThread(summaries[0].id)
      else await newThread(model, workspace)
    },
    [newThread, openThread]
  )

  const patchThread = useCallback((thread: Thread) => dispatch({ type: 'event', event: { type: 'thread', thread } }), [])

  /** Marks the conversation busy at once, so nothing can act on it before the main process confirms the run. */
  const send = useCallback((request: SendRequest) => {
    const { threadId } = request
    dispatch({ type: 'event', event: { type: 'run', threadId, running: true } })
    api.chat.send(request).catch((error: unknown) => {
      dispatch({ type: 'event', event: { type: 'run', threadId, running: false } })
      dispatch({ type: 'event', event: { type: 'error', threadId, text: remoteErrorMessage(error) } })
    })
  }, [])

  return { state, refreshModels, openThread, setPrefs, setProviders, setMcp, newThread, removeThread, patchThread, send }
}
