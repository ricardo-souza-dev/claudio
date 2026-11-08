import { modelKey, type Effort, type ModelInfo, type ModelRef, type Usage } from '../../shared/types'

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

export const EFFORT_LABELS: Record<Effort, string> = { low: 'Baixa', medium: 'Média', high: 'Alta', xhigh: 'Extra', max: 'Máxima' }

export function formatUsd(amount: number): string {
  return usd.format(amount)
}

export function formatEstimatedUsd(amount: number): string {
  if (amount > 0 && amount < 0.001) return '<US$ 0,001'
  return `~${usd.format(Number(amount.toPrecision(2)))}`
}

export function formatEstimatedSeconds(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))}s`
  return `~${Math.round(seconds / 60)}min`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto', style: 'short' })

export function timeAgo(epochSeconds: number): string {
  const seconds = Math.round(Date.now() / 1000 - epochSeconds)
  if (seconds < 60) return 'agora'
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), 'hour')
  if (seconds < 2_592_000) return relative.format(-Math.floor(seconds / 86_400), 'day')
  return new Date(epochSeconds * 1000).toLocaleDateString('pt-BR')
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}min ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}min`
}

/** Number and unit stay together ("2,5mil"), so a row of figures reads as pairs. */
export function formatTokens(count: number): string {
  return compact.format(count).replace(/\s/g, '')
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

/** Electron wraps errors from the main process in a technical prefix the user shouldn't see. */
export function remoteErrorMessage(error: unknown): string {
  return ((error as Error).message ?? String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
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

/** Local, bounded labels: never send tool arguments to another model just to name an action. */
export function toolActivity(name: string, input: unknown): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const value = (key: string): string => typeof record[key] === 'string' ? (record[key] as string).replace(/\s+/g, ' ').trim() : ''
  const brief = (text: string): string => text.length > 90 ? `${text.slice(0, 89)}…` : text
  const path = value('path')
  switch (name) {
    case 'read_file': return `Leitura de ${folderName(path) || 'arquivo'}`
    case 'edit_file': return `Edição de ${folderName(path) || 'arquivo'}`
    case 'write_file': return `Gravação de ${folderName(path) || 'arquivo'}`
    case 'list_dir': return `Arquivos de ${path ? folderName(path) : 'projeto'}`
    case 'search': return `Busca${value('pattern') ? ` por “${brief(value('pattern'))}”` : ' no projeto'}`
    case 'ask_user': return 'Perguntas para você'
    case 'run_command': {
      const command = value('command')
      const tasks: string[] = []
      if (/\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?typecheck\b/i.test(command)) tasks.push('tipos')
      if (/\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?build\b/i.test(command)) tasks.push('build')
      if (/\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:npx\s+)?(?:vitest|playwright)\s+(?:run|test)\b/i.test(command)) tasks.push('testes')
      if (tasks.length) return `Validação: ${tasks.join(', ')}`
      return `Comando${command ? `: ${brief(command)}` : ''}`
    }
    default: {
      const detail = toolSummary(input).replace(/\s+/g, ' ').trim()
      return brief(`${shortToolName(name)}${detail ? ` · ${detail}` : ''}`)
    }
  }
}

export function shortToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? `${match[1]} · ${match[2]}` : name
}
