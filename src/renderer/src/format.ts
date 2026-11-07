import { modelKey, type ModelInfo, type ModelRef, type Usage } from '../../shared/types'

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

export function formatTokens(count: number): string {
  return compact.format(count)
}

export function usageLabel(usage: Usage | undefined): string | null {
  if (!usage) return null
  return `${formatTokens(usage.input)} entrada · ${formatTokens(usage.output)} saída`
}

export function modelLabel(ref: ModelRef | null | undefined, models: ModelInfo[]): string {
  if (!ref) return 'Escolher modelo'
  return models.find((model) => modelKey(model) === modelKey(ref))?.label ?? ref.id
}

export function providerLabel(ref: ModelRef | null | undefined, models: ModelInfo[]): string {
  if (!ref) return ''
  return models.find((model) => model.provider === ref.provider)?.providerName ?? ref.provider
}

export function folderName(path: string | null): string {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function relativeDay(timestamp: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const days = Math.floor((startOfToday - new Date(timestamp).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return 'Hoje'
  if (days === 1) return 'Ontem'
  if (days < 7) return 'Esta semana'
  if (days < 31) return 'Este mês'
  return 'Antes'
}

/** The most telling argument of a tool call, for its one-line summary. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'path', 'pattern', 'query', 'url', 'name']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  const first = Object.values(record).find((value) => typeof value === 'string' || typeof value === 'number')
  return first === undefined ? '' : String(first)
}

export function shortToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? `${match[1]} · ${match[2]}` : name
}
