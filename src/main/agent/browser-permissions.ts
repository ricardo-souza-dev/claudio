import type { Tool } from '../tools/types'

/** A deliberately narrow, standalone navigation request, not a URL merely mentioned in prose/code. */
export function requestedNavigation(text: string): string | null {
  const match = text.trim().match(/^(?:por favor[, ]+|please\s+)?(?:abra|abre|abrir|acesse|acessa|acessar|entre|entra|entrar|visite|visita|visitar|navegue|navegar|open|visit|navigate to|go to)\s+(?:(?:n[ao]|ness[ae]|nest[ae]|ess[ae]|est[ae]|o|a|the|this)\s+)*(?:(?:site|página|pagina|tela|endereço|endereco|link|url|page|website)\s*:?\s*)?(https?:\/\/[^\s<>"`]+)$/iu)
  if (!match) return null
  return navigationUrl(match[1])
}

function navigationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch { return null }
}

/** Kept in memory for one run, consumed even on failure. Never inferred from history or tool output. */
export class NavigationGrant {
  private url: string | null

  constructor(requestText: string) {
    this.url = requestedNavigation(requestText)
  }

  consume(tool: Tool, input: Record<string, unknown>): boolean {
    if (!this.url || !tool.explicitNavigation || Object.keys(input).length !== 1) return false
    if (navigationUrl(input.url) !== this.url) return false
    this.url = null
    return true
  }
}
