import path from 'node:path'
import { budgetLimits, budgetStates, monthStart, spendEntries, type BudgetGuard } from '../shared/spending'
import type { ModelInfo, Preferences, Thread } from '../shared/types'

interface GuardOptions {
  thread: Thread
  prefs: Pick<Preferences, 'conversationBudgetUsd' | 'projectBudgetsUsd'>
  /** Read only when a budget is set, because listing models can reach the providers. */
  models(): Promise<ModelInfo[]>
  /** Every saved conversation, one at a time. */
  threads(): AsyncIterable<Thread>
  now?: () => number
}

/**
 * Budget for one run. The other conversations of the project are summed once, here, and the
 * running conversation is summed again at every check, so a long run never rereads the disk.
 * Returns null when no budget applies, which keeps the common case free of any work.
 */
export async function createBudgetGuard(options: GuardOptions): Promise<BudgetGuard | null> {
  const { thread } = options
  const now = options.now ?? Date.now
  const limits = budgetLimits(options.prefs, thread.workspace)
  if (limits.conversation === 0 && limits.project === 0) return null

  const models = await options.models()
  const from = monthStart(now())
  let others = 0
  if (limits.project > 0) {
    for await (const other of options.threads()) {
      if (other.id === thread.id || other.workspace !== thread.workspace) continue
      for (const entry of spendEntries(other, models)) if (entry.at >= from) others += entry.cost
    }
  }
  return {
    projectName: thread.workspace ? path.basename(thread.workspace) : null,
    check: () => {
      const own = spendEntries(thread, models)
      return budgetStates(
        { conversation: own.reduce((sum, entry) => sum + entry.cost, 0), project: others + own.reduce((sum, entry) => (entry.at >= from ? sum + entry.cost : sum), 0) },
        limits
      )
    }
  }
}
