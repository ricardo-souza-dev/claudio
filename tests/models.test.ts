import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseAutoModel, contextShortfall, estimateTurn, unfitReason, weighTask, type TaskInfo } from '../src/shared/auto-model'
import { clampEffort, type Message, type ModelInfo, type ModelPricing } from '../src/shared/types'
import { outputSinceLastUser, summarizeUsage } from '../src/shared/usage'
import { defaultEfforts, ModelFactsStore, trimCatalog } from '../src/main/model-facts'

function model(id: string, pricing?: ModelPricing, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { provider: 'p', providerName: 'P', id, label: id, pricing, released: '2026-06-01', ...extra }
}

const price = (output: number): ModelPricing => ({ input: output / 4, output })

describe('força', () => {
  const levels = ['low', 'medium', 'high'] as const

  it('uses the strongest supported level at or below the one asked for', () => {
    expect(clampEffort('max', levels)).toBe('high')
    expect(clampEffort('medium', levels)).toBe('medium')
    expect(clampEffort('low', ['high'])).toBe('high')
    expect(clampEffort('high', [])).toBeUndefined()
  })

  it('offers default levels only where the provider does not report its own', () => {
    expect(defaultEfforts('openai-responses', true)).toEqual(['low', 'medium', 'high'])
    expect(defaultEfforts('openai-responses', false)).toBeUndefined()
    // A reasoning Anthropic model can still reject the effort setting, so only its own API decides.
    expect(defaultEfforts('anthropic', true)).toBeUndefined()
  })
})

describe('uso da conversa', () => {
  const message = (fields: Partial<Message>): Message => ({ id: 'm', role: 'assistant', parts: [], createdAt: 1, ...fields })
  const models = [model('a', { input: 2, output: 10, cacheRead: 0.2 })]

  it('adds up tokens and cost, charging cached input at its own rate', () => {
    const summary = summarizeUsage(
      [
        message({ role: 'user' }),
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 1_000_000, output: 100_000, cached: 500_000 } }),
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 2_000, output: 500 } })
      ],
      models
    )
    expect(summary.input).toBe(1_002_000)
    expect(summary.output).toBe(100_500)
    expect(summary.cached).toBe(500_000)
    expect(summary.cost).toBeCloseTo(1 + 0.1 + 1 + 0.004 + 0.005, 6)
    expect(summary.costComplete).toBe(true)
  })

  it('reports the context of the latest response, not the running total', () => {
    const summary = summarizeUsage(
      [
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 100, output: 50 } }),
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 400, output: 25 } })
      ],
      models
    )
    expect(summary.context).toBe(425)
  })

  it('says when a price is missing', () => {
    const summary = summarizeUsage([message({ model: { provider: 'p', id: 'sem-preco' }, usage: { input: 5, output: 5 } })], models)
    expect(summary.input).toBe(5)
    expect(summary.costComplete).toBe(false)
  })

  it('leaves a refused turn out of the context, since it is never replayed', () => {
    const summary = summarizeUsage(
      [
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 100, output: 0 } }),
        message({ model: { provider: 'p', id: 'a' }, usage: { input: 999, output: 0 }, excluded: true })
      ],
      models
    )
    expect(summary.context).toBe(100)
    expect(summary.input).toBe(1099)
  })

  it('counts output only since the last message from the user', () => {
    expect(
      outputSinceLastUser([
        message({ usage: { input: 1, output: 100 } }),
        message({ role: 'user' }),
        message({ usage: { input: 1, output: 7 } }),
        message({ role: 'tool' }),
        message({ usage: { input: 1, output: 5 } })
      ])
    ).toBe(12)
  })
})

describe('modelo automático', () => {
  const models = [
    model('barato', price(1)),
    model('medio', price(5)),
    model('forte', price(20)),
    model('carissimo', price(180)),
    model('sem-ferramentas', price(0.1), { supportsTools: false }),
    model('forte-2026-01-15', price(20)),
    model('novo-preview', price(2)),
    model('gratis:free', price(0)),
    model('antigo', price(0.5), { released: '2023-01-01' }),
    model('sem-preco')
  ]

  const task = (text: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({ text, ...extra })

  it('weighs tasks in Portuguese and English', () => {
    expect(weighTask(task('oi, tudo bem?'))).toBe('light')
    expect(weighTask(task('o que é um closure?'))).toBe('light')
    expect(weighTask(task('corrija o erro de digitação no README'))).toBe('normal')
    expect(weighTask(task('veja `src/main.ts`'))).toBe('normal')
    expect(weighTask(task('refatore a arquitetura de autenticação'))).toBe('heavy')
    expect(weighTask(task('debug this crash'))).toBe('heavy')
    expect(weighTask(task('a'.repeat(601)))).toBe('heavy')
  })

  it('reads the conversation so far, not only the last message', () => {
    expect(weighTask(task('ok, e agora?', { recentToolCalls: 5 }))).toBe('normal')
    expect(weighTask(task('ok, e agora?', { contextTokens: 40_000 }))).toBe('normal')
    expect(weighTask(task('ok, e agora?', { contextTokens: 200_000 }))).toBe('heavy')
    expect(weighTask(task('o que é isso?', { hasImages: true }))).toBe('normal')
  })

  it('matches the model to the weight of the task', () => {
    expect(chooseAutoModel(models, task('oi'), null)?.model.id).toBe('barato')
    expect(chooseAutoModel(models, task('corrija este teste'), null)?.model.id).toBe('medio')
    expect(chooseAutoModel(models, task('refatore tudo'), null)?.model.id).toBe('forte')
  })

  it('never picks a model above the price cap on its own', () => {
    expect(chooseAutoModel(models, task('refatore tudo'), null)?.model.id).not.toBe('carissimo')
  })

  it('spends less aggressively in economy mode', () => {
    expect(chooseAutoModel(models, task('corrija este teste'), null, { economy: true })?.model.id).toBe('medio')
    expect(chooseAutoModel(models, task('refatore tudo'), null, { economy: true })?.model.id).toBe('medio')
    expect(chooseAutoModel(models, task('oi'), { provider: 'p', id: 'forte' }, { economy: true })?.model.id).toBe('barato')
  })

  it('skips models without tools, snapshots, previews, free tiers, old models and unknown prices', () => {
    const skipped = ['sem-ferramentas', 'forte-2026-01-15', 'novo-preview', 'gratis:free', 'antigo', 'sem-preco']
    for (const text of ['oi', 'corrija este teste', 'refatore tudo']) {
      expect(skipped).not.toContain(chooseAutoModel(models, task(text), null)?.model.id)
    }
  })

  it('moves up for heavier work but never down, which would lose the prompt cache', () => {
    const current = { provider: 'p', id: 'forte' }
    const kept = chooseAutoModel(models, task('oi'), current)
    expect(kept?.model).toEqual(current)
    expect(kept?.note).toContain('mantive')
    const raised = chooseAutoModel(models, task('refatore tudo'), { provider: 'p', id: 'barato' })
    expect(raised?.model.id).toBe('forte')
    expect(raised?.note).toContain('escolhi')
  })

  it('leaves out models the task does not fit, even the current one', () => {
    const mixed = [
      model('pequeno-sem-imagem', price(1), { contextWindow: 10_000, imageInput: false }),
      model('grande', price(5), { contextWindow: 1_000_000, imageInput: true })
    ]
    const current = { provider: 'p', id: 'pequeno-sem-imagem' }
    expect(chooseAutoModel(mixed, task('oi', { hasImages: true }), current)?.model.id).toBe('grande')
    expect(chooseAutoModel(mixed, task('oi', { contextTokens: 50_000 }), current)?.model.id).toBe('grande')
    expect(unfitReason(mixed[0], task('oi', { hasImages: true }))).toBe('não lê imagens')
    expect(unfitReason(mixed[0], task('oi', { contextTokens: 50_000 }))).toBe('contexto não cabe (faltam 40001 tokens)')
    expect(unfitReason(mixed[1], task('oi', { hasImages: true, contextTokens: 50_000 }))).toBeNull()
  })

  it('says how much context is left before the limit, and that it is gone', () => {
    const small = model('pequeno', price(1), { contextWindow: 100_000 })
    // 50k of the 100k window used: within 80% of the limit, so the model still fits.
    expect(unfitReason(small, task('oi', { contextTokens: 50_000 }))).toBeNull()
    // 85k used: over the margin but under the limit, so the fit shows the slack.
    expect(unfitReason(small, task('oi', { contextTokens: 85_000 }))).toBe('contexto não cabe')
    // Past the limit entirely.
    expect(unfitReason(small, task('oi', { contextTokens: 120_000 }))).toBe('contexto não cabe (faltam 20001 tokens)')
    expect(contextShortfall(small, task('oi', { contextTokens: 120_000 }))).toBe(20001)
    expect(contextShortfall(small, task('oi', { contextTokens: 85_000 }))).toBeNull()
  })

  it('declines to choose when no model has a known price', () => {
    expect(chooseAutoModel([model('a'), model('b')], task('oi'), null)).toBeNull()
  })

  it('estimates cost from the context, and time only from what was measured here', () => {
    const measured = model('m', { input: 2, output: 10 }, { speed: { tokensPerSecond: 100, firstTokenMs: 2000 } })
    const estimate = estimateTurn(measured, task('oi', { contextTokens: 10_000 }))
    // Light task: 300 tokens of answer.
    expect(estimate.cost).toBeCloseTo((10_001 * 2 + 300 * 10) / 1_000_000, 6)
    expect(estimate.seconds).toBeCloseTo(2 + 300 / 100, 6)

    const unknown = estimateTurn(model('u'), task('oi'))
    expect(unknown).toEqual({ cost: null, seconds: null })
    // A longer conversation costs more for the same message.
    const longer = estimateTurn(measured, task('oi', { contextTokens: 100_000 }))
    expect(longer.cost!).toBeGreaterThan(estimate.cost!)
  })
})

describe('catálogo público de modelos', () => {
  const CATALOG = {
    openai: {
      models: {
        'gpt-x': { limit: { context: 128000, output: 16000 }, cost: { input: 2, output: 8, cache_read: 1 }, reasoning: true, tool_call: true, release_date: '2026-01-01', modalities: { output: ['text'] } },
        'gpt-imagem': { limit: { context: 1000 }, cost: { input: 5, output: 40 }, modalities: { output: ['image'] } }
      }
    },
    revendedor: { models: { 'gpt-x': { limit: { context: 1 } }, 'modelo-unico': { limit: { context: 9000 }, cost: { input: 1, output: 2 } } } },
    togetherai: { models: { llama: { limit: { context: 8000 } } } },
    quebrado: 'não é um objeto'
  }

  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'uni-facts-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const url = `data:application/json,${encodeURIComponent(JSON.stringify(CATALOG))}`
  const loaded = async (): Promise<ModelFactsStore> =>
    new Promise((resolve) => {
      const store: ModelFactsStore = new ModelFactsStore(dir, url, () => resolve(store))
      void store.load()
    })

  it('keeps only the fields in use, tolerating malformed entries', () => {
    const trimmed = trimCatalog(CATALOG)
    expect(trimmed.openai['gpt-x']).toEqual({
      context: 128000,
      output: 16000,
      pricing: { input: 2, output: 8, cacheRead: 1 },
      reasoning: true,
      tools: true,
      imageInput: undefined,
      released: '2026-01-01',
      textOutput: true
    })
    expect(trimmed.openai['gpt-imagem'].textOutput).toBe(false)
    expect(trimmed.quebrado).toBeUndefined()
    expect(trimCatalog(null)).toEqual({})
  })

  it('finds a model by provider, or by id across providers for custom endpoints', async () => {
    const store = await loaded()
    expect(store.lookup('openai', 'gpt-x')?.context).toBe(128000)
    expect(store.lookup('together', 'llama')?.context).toBe(8000)
    expect(store.lookup('custom-123', 'modelo-unico')?.context).toBe(9000)
    // An entry with a price beats a reseller's bare copy of the same model.
    expect(store.lookup('custom-123', 'gpt-x')?.pricing?.output).toBe(8)
    expect(store.lookup('openai', 'nao-existe')).toBeUndefined()
  })

  it('saves a trimmed copy and uses it on the next launch, without the network', async () => {
    await loaded()
    await expect.poll(() => readFile(path.join(dir, 'model-facts.json'), 'utf8').catch(() => '')).toContain('gpt-x')
    const offline = new ModelFactsStore(dir, 'http://127.0.0.1:1/indisponivel')
    await offline.load()
    expect(offline.lookup('openai', 'gpt-x')?.context).toBe(128000)
  })

  it('keeps working when the catalog is unreachable or broken', async () => {
    const offline = new ModelFactsStore(dir, 'http://127.0.0.1:1/indisponivel')
    await expect(offline.load()).resolves.toBeUndefined()
    expect(offline.lookup('openai', 'gpt-x')).toBeUndefined()

    await writeFile(path.join(dir, 'model-facts.json'), '{ quebrado')
    await expect(new ModelFactsStore(dir, 'http://127.0.0.1:1/indisponivel').load()).resolves.toBeUndefined()
  })
})
