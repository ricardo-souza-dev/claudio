import { modelKey, type Message, type ModelInfo, type ModelRef, type Usage } from './types'

export interface UsageSummary {
  input: number
  output: number
  cached: number
  /** Tokens the next request will carry, as of the last response. */
  context: number
  /** Estimated US dollars, counting only models whose prices are known. */
  cost: number
  /** False when some model in the conversation has no known price. */
  costComplete: boolean
}

/** Every adapter reports `input` as all prompt tokens, cached or not, so one formula fits all. */
export function summarizeUsage(messages: Message[], models: ModelInfo[]): UsageSummary {
  const prices = new Map(models.map((model) => [modelKey(model), model.pricing]))
  const summary: UsageSummary = { input: 0, output: 0, cached: 0, context: 0, cost: 0, costComplete: true }

  const count = (model: ModelRef | undefined, usage: Usage): void => {
    const cached = usage.cached ?? 0
    summary.input += usage.input
    summary.output += usage.output
    summary.cached += cached
    const price = model ? prices.get(modelKey(model)) : undefined
    if (!price) {
      summary.costComplete = false
      return
    }
    summary.cost +=
      ((usage.input - cached) * price.input + cached * (price.cacheRead ?? price.input) + usage.output * price.output) / 1_000_000
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (message.usage) {
      count(message.model, message.usage)
      if (!message.excluded) summary.context = message.usage.input + message.usage.output
    }
  }
  return summary
}

/** Output tokens of the work since the last user message. */
export function outputSinceLastUser(messages: Message[]): number {
  let total = 0
  for (const message of messages.toReversed()) {
    if (message.role === 'user') break
    if (message.role === 'assistant') total += message.usage?.output ?? 0
  }
  return total
}
