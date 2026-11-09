import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResponsesAdapter } from '../src/main/providers/openai-responses'
import type { ProviderConnection } from '../src/main/providers/types'

const allowed = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6']

describe('OpenAI model selection', () => {
  let server: Server
  let baseUrl: string
  let ids: string[]

  beforeEach(async () => {
    ids = [...allowed, 'gpt-other', 'gpt-6-luna-2026-01-01', 'gpt-5.6-preview', 'text-embedding-mock']
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function adapter(id = 'openai') {
    const connection: ProviderConnection = {
      id, name: 'OpenAI', protocol: 'openai-responses', baseUrl, official: false, apiKey: 'fake'
    }
    return createResponsesAdapter(connection)
  }

  it('lists only the five exact allowed IDs returned by the API', async () => {
    expect((await adapter().listModels()).map((model) => model.id).sort()).toEqual([...allowed].sort())
  })

  it('does not fabricate missing models or fall back to disallowed ones', async () => {
    ids = ['gpt-6.1-sol', 'gpt-other']
    expect((await adapter().listModels()).map((model) => model.id)).toEqual(['gpt-6.1-sol'])
    ids = ['gpt-other']
    expect(await adapter().listModels()).toEqual([])
  })

  it('leaves custom Responses providers uncurated, still excluding non-text models', async () => {
    expect((await adapter('custom-openai').listModels()).map((model) => model.id).sort())
      .toEqual(ids.filter((id) => !id.includes('embedding')).sort())
  })
})
