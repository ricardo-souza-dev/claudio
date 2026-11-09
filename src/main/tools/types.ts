import type { ApprovalPreview, PermissionMode, Risk } from '../../shared/types'
import type { ToolSpec } from '../providers/types'

export { ASK_TOOL, PLAN_TOOL } from '../../shared/types'

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool extends ToolSpec {
  /** Set locally only for the recognized Playwright MCP navigation tool, never from server annotations. */
  explicitNavigation?: true
  risk(input: Record<string, unknown>): Risk
  preview(input: Record<string, unknown>): ApprovalPreview
  run(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
}

export function permissionFor(risk: Risk, mode: PermissionMode, alwaysAllowed: boolean): 'allow' | 'ask' | 'deny' {
  if (risk === 'read') return 'allow'
  // Secrets leave the machine once a model reads them, so nothing skips this question:
  // not the mode, and not an earlier "always" given for the same tool on ordinary files.
  if (risk === 'sensitive') return 'ask'
  // Planning cannot inherit execution rights from an earlier turn.
  if (mode === 'plan' || mode === 'read-only') return 'deny'
  if (mode === 'bypass' || alwaysAllowed) return 'allow'
  if (risk === 'write' && (mode === 'auto-edit' || mode === 'auto')) return 'allow'
  return 'ask'
}
