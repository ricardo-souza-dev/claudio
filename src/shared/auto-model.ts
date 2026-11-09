import { modelKey, type ModelInfo, type ModelRef } from './types'

export type TaskWeight = 'light' | 'normal' | 'heavy'

/** What is known about the next message and the conversation it continues. */
export interface TaskInfo {
  text: string
  /** Tokens already in the conversation. */
  contextTokens?: number
  hasImages?: boolean
  /** Tool calls in the latest turns: a conversation doing real work isn't small talk. */
  recentToolCalls?: number
}

const HEAVY_WORDS =
  /\b(refator\w*|refactor\w*|arquitetur\w*|architect\w*|migr[ae]\w*|depur\w*|debug\w*|investig\w*|implement\w*|otimiz\w*|optimi[sz]\w*|redesenh\w*|redesign\w*|reescrev\w*|rewrite|segurança|security|concorrência|concurrency)\b/i
const WORK_WORDS =
  /\b(corrij\w*|corrig\w*|crie|criar|adicion\w*|alter\w*|mude|mudar|edite|editar|escrev\w*|teste\w*|fix|add|create|change|update|build|explique|explain|revis\w*|review)\b/i
const HAS_CODE = /```|`[^`]+`|\b[\w-]+\.(ts|tsx|js|jsx|py|go|rs|java|cs|php|rb|c|cpp|sql|json|ya?ml|md)\b/i
const LIGHT_LENGTH = 80
const HEAVY_LENGTH = 600
const ACTIVE_TOOL_CALLS = 3
const BUSY_CONTEXT_TOKENS = 30_000
const LARGE_CONTEXT_TOKENS = 150_000

// Not general-purpose chat models, or pinned copies of one that is already listed.
const NOT_GENERAL = /preview|search|audio|realtime|deep-research|image|tts|transcri|latest$|:free$/i
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/
// Without this, a request for maximum strength could land on a model priced many times higher.
const HEAVY_OUTPUT_PRICE_CAP = 30
const RECENT_DAYS = 540
const DAY_MS = 86_400_000
/** Leaves room for the answer and for tool results. */
const CONTEXT_MARGIN = 0.8

/** A typical answer for each kind of task, for estimates only. */
const OUTPUT_GUESS: Record<TaskWeight, number> = { light: 300, normal: 1500, heavy: 5000 }
const CHARS_PER_TOKEN = 4

function weightOfText(text: string): TaskWeight {
  const trimmed = text.trim()
  if (trimmed.length > HEAVY_LENGTH || HEAVY_WORDS.test(trimmed)) return 'heavy'
  if (trimmed.length <= LIGHT_LENGTH && !WORK_WORDS.test(trimmed) && !HAS_CODE.test(trimmed)) return 'light'
  return 'normal'
}

/** A short question in a conversation deep into a task is still part of that task. */
export function weighTask(task: TaskInfo): TaskWeight {
  const weight = weightOfText(task.text)
  if (weight === 'heavy' || (task.contextTokens ?? 0) >= LARGE_CONTEXT_TOKENS) return 'heavy'
  if ((task.recentToolCalls ?? 0) >= ACTIVE_TOOL_CALLS || (task.contextTokens ?? 0) >= BUSY_CONTEXT_TOKENS) return 'normal'
  return task.hasImages && weight === 'light' ? 'normal' : weight
}

export function inputTokensOf(task: TaskInfo): number {
  return (task.contextTokens ?? 0) + Math.ceil(task.text.length / CHARS_PER_TOKEN)
}

/** Why this model can't take this task, if it can't. */
export function unfitReason(model: ModelInfo, task: TaskInfo): string | null {
  if (task.hasImages && model.imageInput === false) return 'não lê imagens'
  const needed = inputTokensOf(task)
  if (model.contextWindow && needed > model.contextWindow * CONTEXT_MARGIN) {
    return needed > model.contextWindow
      ? 'contexto já não cabe'
      : `contexto não cabe (sobram ${model.contextWindow - needed} tokens)`
  }
  return null
}

/** How close the current conversation is to the model's limit, when the limit is known. */
export interface ContextFit {
  remaining: number
  /** 0 to 1, how much of the limit the conversation already uses. */
  fraction: number
}

export function contextFit(model: ModelInfo, task: TaskInfo): ContextFit | null {
  if (!model.contextWindow) return null
  const used = inputTokensOf(task)
  return { remaining: model.contextWindow - used, fraction: used / model.contextWindow }
}

export interface TurnEstimate {
  /** US dollars, or null when the price is unknown. */
  cost: number | null
  /** Seconds, or null until this model has been measured here. */
  seconds: number | null
}

/** Rough on purpose: the real answer's length isn't known until it is written. */
export function estimateTurn(model: ModelInfo, task: TaskInfo): TurnEstimate {
  const output = OUTPUT_GUESS[weighTask(task)]
  const cost = model.pricing ? (inputTokensOf(task) * model.pricing.input + output * model.pricing.output) / 1_000_000 : null
  const seconds = model.speed ? model.speed.firstTokenMs / 1000 + output / model.speed.tokensPerSecond : null
  return { cost, seconds }
}

function candidates(models: ModelInfo[], task: TaskInfo): ModelInfo[] {
  const usable = models.filter(
    (model) => (model.pricing?.output ?? 0) > 0 && model.supportsTools !== false && !NOT_GENERAL.test(model.id) && !SNAPSHOT.test(model.id) && !unfitReason(model, task)
  )
  const dates = usable.flatMap((model) => (model.released ? [Date.parse(model.released)] : []))
  const newest = dates.length > 0 ? Math.max(...dates) : null
  const recent = usable.filter((model) => newest === null || (model.released && newest - Date.parse(model.released) <= RECENT_DAYS * DAY_MS))
  return recent.sort((a, b) => a.pricing!.output - b.pricing!.output)
}

function reasonFor(task: TaskInfo, weight: TaskWeight): string {
  if (task.hasImages) return 'mensagem com imagem'
  if ((task.contextTokens ?? 0) >= LARGE_CONTEXT_TOKENS) return 'conversa longa'
  if (weightOfText(task.text) !== weight && weight !== 'heavy') return 'conversa em andamento'
  return { light: 'pedido simples', normal: 'tarefa comum', heavy: 'tarefa complexa' }[weight]
}

export interface AutoChoice {
  model: ModelRef
  weight: TaskWeight
  reason: string
  note: string
}

export interface AutoModelOptions {
  /** Spend less aggressively: choose cheaper tiers and allow stepping down for light/normal work. */
  economy?: boolean
  profile?: 'economy' | 'balanced' | 'performance'
}

/**
 * Picks by the task, the conversation so far and price, using data about the models rather
 * than a fixed list: the cheapest for light work, the middle of the range for normal work,
 * the strongest within the price cap for heavy work. Models that can't take the task are out.
 * It normally avoids stepping down within a conversation because switching loses the prompt cache.
 * Economy mode may still step down for light and normal work when the active model is much costlier.
 */
export function chooseAutoModel(models: ModelInfo[], task: TaskInfo, current: ModelRef | null, options: AutoModelOptions = {}): AutoChoice | null {
  const choices = candidates(models, task)
  if (choices.length === 0) return null
  const weight = weighTask(task)
  const profile = options.profile ?? (options.economy ? 'economy' : 'balanced')
  const economy = profile === 'economy'
  let chosen = choices[0]
  if (profile === 'performance') {
    chosen = choices.filter((model) => model.pricing!.output <= HEAVY_OUTPUT_PRICE_CAP).at(-1) ?? choices[0]
  } else if (economy) {
    if (weight === 'normal') chosen = choices[Math.min(1, choices.length - 1)]
    if (weight === 'heavy') chosen = choices.filter((model) => model.pricing!.output <= HEAVY_OUTPUT_PRICE_CAP / 2).at(-1) ?? choices[0]
  } else {
    if (weight === 'normal') chosen = choices[Math.floor((choices.length - 1) / 2)]
    if (weight === 'heavy') chosen = choices.filter((model) => model.pricing!.output <= HEAVY_OUTPUT_PRICE_CAP).at(-1) ?? choices[0]
  }

  const reason = reasonFor(task, weight)
  const active = current && models.find((model) => modelKey(model) === modelKey(current))
  const canKeepActive =
    active?.pricing &&
    active.pricing.output >= chosen.pricing!.output &&
    !unfitReason(active, task) &&
    (!economy || weight === 'heavy' || active.pricing.output <= chosen.pricing!.output * 2)
  if (canKeepActive) {
    return { model: current!, weight, reason, note: `Automático: mantive ${active.label} (${reason}).` }
  }
  const suffix = economy ? ' em modo econômico' : profile === 'performance' ? ' em modo desempenho' : ''
  return { model: { provider: chosen.provider, id: chosen.id }, weight, reason, note: `Automático${suffix}: escolhi ${chosen.label} (${reason}).` }
}
