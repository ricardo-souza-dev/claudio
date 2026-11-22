import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBudgetGuard } from '../src/main/budget'
import { SettingsStore, ThreadStore, type Vault } from '../src/main/store'
import { budgetLimits, budgetStates, buildReport, monthStart, spendEntries } from '../src/shared/spending'
import type { Message, ModelInfo, ModelRef, Thread } from '../src/shared/types'

const CHEAP: ModelRef = { provider: 'a', id: 'barato' }
const COSTLY: ModelRef = { provider: 'b', id: 'caro' }
const UNKNOWN: ModelRef = { provider: 'c', id: 'sem-preco' }
const MODELS: ModelInfo[] = [
  { ...CHEAP, label: 'Barato', providerName: 'A', pricing: { input: 1, output: 2 } },
  { ...COSTLY, label: 'Caro', providerName: 'B', pricing: { input: 10, output: 20, cacheRead: 1 } },
  { ...UNKNOWN, label: 'Sem preço', providerName: 'C' }
]
const NOW = new Date(2026, 10, 22, 15, 0).getTime()
const at = (month: number, day: number, hour = 12): number => new Date(2026, month, day, hour).getTime()

function answer(model: ModelRef, when: number, input: number, output: number, cached?: number): Message {
  return { id: `m${when}${input}`, role: 'assistant', parts: [{ type: 'text', text: 'x' }], createdAt: when, model, usage: { input, output, ...(cached ? { cached } : {}) }, stop: 'end' }
}

function thread(id: string, workspace: string | null, messages: Message[]): Thread {
  return { id, title: id, createdAt: 0, updatedAt: 0, workspace, model: null, system: null, contextFiles: [], allowedTools: [], messages }
}

describe('lançamentos de gasto', () => {
  it('prices each answer with its own model, counting cached input at the cache price', () => {
    const entries = spendEntries(thread('t', '/p', [answer(CHEAP, NOW, 1_000_000, 1_000_000), answer(COSTLY, NOW, 1_000_000, 0, 500_000)]), MODELS)
    expect(entries.map((entry) => entry.cost)).toEqual([3, 5.5])
    expect(entries.every((entry) => entry.priced)).toBe(true)
  })

  it('marks answers from models without a price instead of guessing', () => {
    const [entry] = spendEntries(thread('t', '/p', [answer(UNKNOWN, NOW, 1000, 1000)]), MODELS)
    expect(entry).toMatchObject({ cost: 0, priced: false })
  })

  it('ignores messages that are not answers with usage', () => {
    const user: Message = { id: 'u', role: 'user', parts: [], createdAt: NOW }
    const interrupted: Message = { ...answer(CHEAP, NOW, 1, 1), usage: undefined }
    expect(spendEntries(thread('t', '/p', [user, interrupted]), MODELS)).toEqual([])
  })
})

describe('relatório', () => {
  const entries = [
    ...spendEntries(thread('a', '/projeto-a', [answer(CHEAP, at(10, 22), 1_000_000, 0), answer(CHEAP, at(10, 3), 2_000_000, 0), answer(CHEAP, at(9, 30), 4_000_000, 0)]), MODELS),
    ...spendEntries(thread('b', '/projeto-b', [answer(COSTLY, at(10, 20), 1_000_000, 0), answer(UNKNOWN, at(10, 21), 5, 5)]), MODELS),
    ...spendEntries(thread('c', null, [answer(CHEAP, at(10, 22), 500_000, 0)]), MODELS)
  ]
  const report = buildReport(entries, NOW)

  it('separates today, the last 7 days, the month and everything', () => {
    expect(report.today).toBeCloseTo(1.5)
    expect(report.last7Days).toBeCloseTo(11.5)
    expect(report.month).toBeCloseTo(13.5)
    expect(report.total).toBeCloseTo(17.5)
  })

  it('starts the month on the 1st, local time', () => {
    expect(report.monthStart).toBe(monthStart(NOW))
    expect(new Date(report.monthStart).getDate()).toBe(1)
  })

  it('ranks projects by this month, with the total beside it', () => {
    expect(report.byProject.map((entry) => [entry.workspace, entry.month, entry.total])).toEqual([
      ['/projeto-b', 10, 10],
      ['/projeto-a', 3, 7],
      [null, 0.5, 0.5]
    ])
  })

  it('ranks models by this month', () => {
    expect(report.byModel.map((entry) => entry.model.id)).toEqual(['caro', 'barato', 'sem-preco'])
  })

  it('reports answers it could not price, so the figures are not mistaken for complete', () => {
    expect(report.unpricedThisMonth).toBe(1)
  })

  it('gives 30 days ending today, with zeros between', () => {
    expect(report.days).toHaveLength(30)
    expect(report.days.at(-1)).toEqual({ day: '2026-11-22', cost: 1.5 })
    expect(report.days.find((entry) => entry.day === '2026-11-21')?.cost).toBe(0)
    expect(report.days.find((entry) => entry.day === '2026-11-20')?.cost).toBe(10)
  })

  it('is empty and complete when nothing was spent', () => {
    expect(buildReport([], NOW)).toMatchObject({ month: 0, total: 0, byProject: [], byModel: [], unpricedThisMonth: 0 })
  })
})

describe('limites', () => {
  it('reads the project limit by folder and ignores anything that is not a positive amount', () => {
    const prefs = { conversationBudgetUsd: 2, projectBudgetsUsd: { '/p': 30, '/ruim': -1 } }
    expect(budgetLimits(prefs, '/p')).toEqual({ conversation: 2, project: 30 })
    expect(budgetLimits(prefs, '/ruim')).toEqual({ conversation: 2, project: 0 })
    expect(budgetLimits(prefs, null)).toEqual({ conversation: 2, project: 0 })
    expect(budgetLimits({ conversationBudgetUsd: Number.NaN, projectBudgetsUsd: {} }, '/p')).toEqual({ conversation: 0, project: 0 })
  })

  it('reports only the budgets that are set, as a share of each limit', () => {
    expect(budgetStates({ conversation: 1, project: 9 }, { conversation: 0, project: 10 })).toEqual([{ scope: 'project', spent: 9, limit: 10, fraction: 0.9 }])
    expect(budgetStates({ conversation: 1, project: 9 }, { conversation: 0, project: 0 })).toEqual([])
  })
})

describe('guarda de orçamento', () => {
  const prefs = { conversationBudgetUsd: 0, projectBudgetsUsd: { '/p': 10 } }
  async function* saved(): AsyncGenerator<Thread> {
    yield thread('outra', '/p', [answer(CHEAP, at(10, 2), 3_000_000, 0), answer(CHEAP, at(9, 30), 100_000_000, 0)])
    yield thread('noutro-projeto', '/q', [answer(CHEAP, at(10, 2), 50_000_000, 0)])
    yield thread('esta', '/p', [answer(CHEAP, at(10, 5), 99_000_000, 0)])
  }

  it('counts the project this month, from other conversations, and never from another project or an earlier month', async () => {
    const own = thread('esta', '/p', [answer(CHEAP, at(10, 5), 2_000_000, 0)])
    const guard = await createBudgetGuard({ thread: own, prefs, models: async () => MODELS, threads: saved, now: () => NOW })
    expect(guard!.check()).toEqual([{ scope: 'project', spent: 5, limit: 10, fraction: 0.5 }])
  })

  it('sees the running conversation grow without rereading the disk', async () => {
    const own = thread('esta', '/p', [])
    const guard = await createBudgetGuard({ thread: own, prefs, models: async () => MODELS, threads: saved, now: () => NOW })
    expect(guard!.check()[0].spent).toBe(3)
    own.messages.push(answer(CHEAP, NOW, 8_000_000, 0))
    expect(guard!.check()[0]).toMatchObject({ spent: 11, fraction: 1.1 })
  })

  it('is null, and touches neither models nor disk, when nothing is limited', async () => {
    const guard = await createBudgetGuard({
      thread: thread('esta', '/p', []),
      prefs: { conversationBudgetUsd: 0, projectBudgetsUsd: {} },
      models: async () => { throw new Error('não deveria listar modelos') },
      threads: () => { throw new Error('não deveria ler conversas') }
    })
    expect(guard).toBeNull()
  })
})

describe('armazenamento', () => {
  let root: string
  const vault: Vault = { encrypt: async (text) => text, decrypt: async (data) => data }
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'uni-spending-')) })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('keeps valid budgets and drops anything that is not a positive amount', async () => {
    const store = new SettingsStore(root, vault, {})
    expect(store.prefs()).toMatchObject({ conversationBudgetUsd: 0, projectBudgetsUsd: {} })
    await store.setPrefs({ conversationBudgetUsd: 2.5, projectBudgetsUsd: { '/a': 30, '/b': 0, '/c': -4, '/d': Number.NaN, '/e': '9' as unknown as number } })
    expect(store.prefs().conversationBudgetUsd).toBe(2.5)
    expect(store.prefs().projectBudgetsUsd).toEqual({ '/a': 30 })
    await store.setPrefs({ conversationBudgetUsd: -1 })
    expect(store.prefs().conversationBudgetUsd).toBe(0)
    const reopened = new SettingsStore(root, vault, {})
    await reopened.load()
    expect(reopened.prefs().projectBudgetsUsd).toEqual({ '/a': 30 })
  })

  it('reads every saved conversation, one at a time, with a damaged file costing only itself', async () => {
    const created = new ThreadStore(root)
    await created.load()
    const first = await created.create('/p', null)
    const second = await created.create('/q', null)
    const third = await created.create('/r', null)

    // A new store has only what is on disk, as after a restart.
    const reopened = new ThreadStore(root)
    await reopened.load()
    await writeFile(path.join(root, 'threads', `${second.id}.json`), '{ quebrado')
    const seen: string[] = []
    for await (const entry of reopened.each()) seen.push(entry.id)
    expect(seen.sort()).toEqual([first.id, third.id].sort())
  })
})
