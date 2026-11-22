import { modelKey, type ModelInfo, type ModelRef, type Preferences, type Thread } from './types'
import { formatUsd, messageCost } from './usage'

/** A conversation or project at this share of its limit gets a warning. */
export const BUDGET_WARNING = 0.75
const DAYS_SHOWN = 30

/** One answer from one model, priced with the catalog as it stands now. */
export interface SpendEntry {
  threadId: string
  workspace: string | null
  at: number
  model: ModelRef
  cost: number
  /** False when the model has no known price, so `cost` is zero and understates the spend. */
  priced: boolean
  input: number
  output: number
}

export function spendEntries(thread: Pick<Thread, 'id' | 'workspace' | 'messages'>, models: ModelInfo[]): SpendEntry[] {
  const prices = new Map(models.map((model) => [modelKey(model), model.pricing]))
  const entries: SpendEntry[] = []
  for (const message of thread.messages) {
    if (message.role !== 'assistant' || !message.usage || !message.model) continue
    const price = prices.get(modelKey(message.model))
    entries.push({
      threadId: thread.id,
      workspace: thread.workspace,
      at: message.createdAt,
      model: message.model,
      cost: price ? messageCost(message.usage, price) : 0,
      priced: !!price,
      input: message.usage.input,
      output: message.usage.output
    })
  }
  return entries
}

/** Budgets are monthly, on the calendar of this computer. */
export function monthStart(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function dayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface SpendingReport {
  generatedAt: number
  monthStart: number
  today: number
  last7Days: number
  month: number
  total: number
  /** Answers this month from models without a known price. Their cost is missing from every figure. */
  unpricedThisMonth: number
  byProject: { workspace: string | null; month: number; total: number }[]
  byModel: { model: ModelRef; month: number; input: number; output: number }[]
  /** The last 30 days, oldest first, with zeros for days without spending. */
  days: { day: string; cost: number }[]
}

export function buildReport(entries: SpendEntry[], now: number): SpendingReport {
  const monthFrom = monthStart(now)
  const todayFrom = dayStart(now)
  const weekFrom = todayFrom - 6 * 86_400_000
  const report: SpendingReport = {
    generatedAt: now,
    monthStart: monthFrom,
    today: 0,
    last7Days: 0,
    month: 0,
    total: 0,
    unpricedThisMonth: 0,
    byProject: [],
    byModel: [],
    days: []
  }
  const projects = new Map<string | null, { workspace: string | null; month: number; total: number }>()
  const models = new Map<string, { model: ModelRef; month: number; input: number; output: number }>()
  const days = new Map<string, number>()

  for (const entry of entries) {
    report.total += entry.cost
    const project = projects.get(entry.workspace) ?? { workspace: entry.workspace, month: 0, total: 0 }
    project.total += entry.cost
    projects.set(entry.workspace, project)
    days.set(dayKey(entry.at), (days.get(dayKey(entry.at)) ?? 0) + entry.cost)
    if (entry.at >= todayFrom) report.today += entry.cost
    if (entry.at >= weekFrom) report.last7Days += entry.cost
    if (entry.at < monthFrom) continue
    report.month += entry.cost
    project.month += entry.cost
    if (!entry.priced) report.unpricedThisMonth += 1
    const model = models.get(modelKey(entry.model)) ?? { model: entry.model, month: 0, input: 0, output: 0 }
    model.month += entry.cost
    model.input += entry.input
    model.output += entry.output
    models.set(modelKey(entry.model), model)
  }

  report.byProject = [...projects.values()].sort((a, b) => b.month - a.month || b.total - a.total)
  report.byModel = [...models.values()].sort((a, b) => b.month - a.month || b.output - a.output)
  for (let offset = DAYS_SHOWN - 1; offset >= 0; offset--) {
    const day = dayKey(todayFrom - offset * 86_400_000 + 12 * 3_600_000)
    report.days.push({ day, cost: days.get(day) ?? 0 })
  }
  return report
}

export type BudgetScope = 'conversation' | 'project'

export interface BudgetState {
  scope: BudgetScope
  spent: number
  limit: number
  /** Spent over limit. One or more means the limit is reached. */
  fraction: number
}

export interface BudgetLimits {
  /** Zero means no limit. */
  conversation: number
  /** Monthly, for the conversation's project. Zero means no limit. */
  project: number
}

export function budgetLimits(prefs: Pick<Preferences, 'conversationBudgetUsd' | 'projectBudgetsUsd'>, workspace: string | null): BudgetLimits {
  const project = workspace ? prefs.projectBudgetsUsd?.[workspace] : 0
  return { conversation: positive(prefs.conversationBudgetUsd), project: positive(project) }
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Only the budgets that are set. */
export function budgetStates(spent: { conversation: number; project: number }, limits: BudgetLimits): BudgetState[] {
  const states: BudgetState[] = []
  if (limits.conversation > 0) states.push({ scope: 'conversation', spent: spent.conversation, limit: limits.conversation, fraction: spent.conversation / limits.conversation })
  if (limits.project > 0) states.push({ scope: 'project', spent: spent.project, limit: limits.project, fraction: spent.project / limits.project })
  return states
}

/** Read before each step of an agent run. Computed from the conversation as it grows. */
export interface BudgetGuard {
  check(): BudgetState[]
  /** Folder name of the project, for the messages. */
  projectName: string | null
}

export function budgetStopMessage(state: BudgetState, projectName: string | null): string {
  const figures = `${formatUsd(state.spent)} de ${formatUsd(state.limit)}`
  return state.scope === 'conversation'
    ? `Limite de orçamento da conversa atingido: ${figures}. Aumente o limite em Ajustes → Custos e tente de novo.`
    : `Orçamento mensal do projeto${projectName ? ` ${projectName}` : ''} atingido: ${figures}. Aumente o limite em Ajustes → Custos e tente de novo.`
}

export function budgetWarningMessage(state: BudgetState, projectName: string | null): string {
  const figures = `${formatUsd(state.spent)} de ${formatUsd(state.limit)}`
  const percent = Math.floor(state.fraction * 100)
  return state.scope === 'conversation'
    ? `Você usou ${percent}% do orçamento da conversa (${figures}).`
    : `Você usou ${percent}% do orçamento mensal do projeto${projectName ? ` ${projectName}` : ''} (${figures}).`
}
