import type { ApprovalPreview, PermissionMode, Risk } from '../../shared/types'
import type { ToolSpec } from '../providers/types'

export { PLAN_TOOL } from '../../shared/types'

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool extends ToolSpec {
  risk(input: Record<string, unknown>): Risk
  preview(input: Record<string, unknown>): ApprovalPreview
  run(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
}

export function permissionFor(risk: Risk, mode: PermissionMode, alwaysAllowed: boolean): 'allow' | 'ask' | 'deny' {
  if (risk === 'read') return 'allow'
  // Secrets leave the machine once a model reads them, so nothing skips this question:
  // not the mode, and not an earlier "always" given for the same tool on ordinary files.
  if (risk === 'sensitive') return 'ask'
  if (alwaysAllowed) return 'allow'
  if (mode === 'read-only') return 'deny'
  if (risk === 'write' && mode === 'auto-edit') return 'allow'
  return 'ask'
}
