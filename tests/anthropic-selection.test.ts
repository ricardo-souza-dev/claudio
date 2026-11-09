import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnthropicAdapter } from '../src/main/providers/anthropic'
import type { ProviderConnection } from '../src/main/providers/types'

const allowed = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-4-6']
const dated = allowed.map((id) => `${id}-20261001`)
const excluded = ['claude-opus-5', 'claude-sonnet-4-5', 'claude-haiku-5-6', 'claude-fable-5-1-preview', 'claude-sonnet-5-5-latest', 'claude-haiku-4-5-202610', 'other-claude-opus-5-5']

describe('Anthropic model selection', () => {
  let server: Server
  let baseUrl: string
  let ids: string[]

  beforeEach(async () => {
    ids = [...allowed, ...dated, ...excluded]
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: ids.map((id) => ({
          id, type: 'model', display_name: `Name: ${id}`, created_at: '2026-10-01T00:00:00Z',
          max_input_tokens: 200000, max_tokens: 32000,
          capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, high: { supported: true } } }
        })),
        has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function adapter(id = 'anthropic') {
    const connection: ProviderConnection = {
      id, name: 'Anthropic', protocol: 'anthropic', baseUrl, official: false, apiKey: 'fake'
    }
    return createAnthropicAdapter(connection)
  }

  it('offers only the six versions and their dated IDs returned by the API', async () => {
    const models = await adapter().listModels()
    expect(models.map((model) => model.id)).toEqual([...allowed, ...dated])
    expect(models[0]).toMatchObject({
      label: `Name: ${allowed[0]}`, contextWindow: 200000, maxOutput: 32000, thinking: true, efforts: ['low', 'high']
    })
  })

  it('never fabricates missing models or falls back to excluded versions', async () => {
    ids = ['claude-haiku-4-5-20261001', 'claude-opus-5']
    expect((await adapter().listModels()).map((model) => model.id)).toEqual(['claude-haiku-4-5-20261001'])
    ids = excluded
    expect(await adapter().listModels()).toEqual([])
  })

  it('does not restrict custom Anthropic-protocol providers', async () => {
    expect((await adapter('custom-anthropic').listModels()).map((model) => model.id)).toEqual(ids)
  })
})
