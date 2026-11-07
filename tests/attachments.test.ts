import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo, ModelRef, OutgoingAttachment, Thread, UniEvent } from '../src/shared/types'
import { Runner } from '../src/main/agent/runner'
import { AttachmentStore } from '../src/main/attachments'
import { createAdapter } from '../src/main/providers/catalog'
import type { ProviderConnection } from '../src/main/providers/types'
import { SettingsStore, type Vault } from '../src/main/store'
import { startMockLlm, type MockLlm } from './fixtures/mock-llm'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PDF = Buffer.from('%PDF-1.4 conteúdo').toString('base64')
const toBase64 = (text: string) => Buffer.from(text).toString('base64')

const image: OutgoingAttachment = { name: 'print.png', mediaType: 'image/png', data: PNG }
const pdf: OutgoingAttachment = { name: 'contrato.pdf', mediaType: 'application/pdf', data: PDF }
const code: OutgoingAttachment = { name: 'app.ts', mediaType: '', data: toBase64('export const app = 1') }

const CLAUDE: ModelRef = { provider: 'anthropic', id: 'claude-mock' }
const GPT: ModelRef = { provider: 'openai', id: 'gpt-mock' }
const GEMINI: ModelRef = { provider: 'google', id: 'gemini-mock' }
const COMPAT: ModelRef = { provider: 'compat', id: 'chat-mock' }

let llm: MockLlm
let dir: string
let store: AttachmentStore
let events: UniEvent[]
let imageInput: boolean | undefined

beforeAll(async () => {
  llm = await startMockLlm()
})
afterAll(() => llm.close())
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'uni-anexos-'))
  store = new AttachmentStore(dir)
  events = []
  imageInput = undefined
  llm.requests.length = 0
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function connection(ref: ModelRef): ProviderConnection {
  const table: Record<string, Pick<ProviderConnection, 'protocol' | 'baseUrl' | 'name'>> = {
    anthropic: { protocol: 'anthropic', baseUrl: `${llm.url}/anthropic`, name: 'Anthropic' },
    openai: { protocol: 'openai-responses', baseUrl: `${llm.url}/openai/v1`, name: 'OpenAI' },
    google: { protocol: 'gemini', baseUrl: `${llm.url}/gemini`, name: 'Google' },
    compat: { protocol: 'openai-chat', baseUrl: `${llm.url}/compat/v1`, name: 'Compatível' }
  }
  return { id: ref.provider, official: false, apiKey: 'k', ...table[ref.provider] }
}

function runner(): Runner {
  return new Runner({
    resolveModel: async (ref) => ({ adapter: createAdapter(connection(ref)), info: { ...ref, label: ref.id, providerName: ref.provider, imageInput } as ModelInfo }),
    toolsFor: () => [],
    memory: () => '',
    emit: (event) => events.push(event),
    save: async () => undefined,
    requestApproval: async () => 'deny',
    saveAttachments: (files) => store.save(files),
    loadAttachments: (messages, model) => store.load(messages, model)
  })
}

function newThread(): Thread {
  return { id: '00000000-0000-4000-8000-000000000002', title: 'x', createdAt: 1, updatedAt: 1, workspace: null, model: null, system: null, contextFiles: [], allowedTools: [], messages: [] }
}

const send = (r: Runner, thread: Thread, model: ModelRef, text: string, attachments: OutgoingAttachment[] = []) =>
  r.send(thread, { threadId: thread.id, text, model, permissionMode: 'ask', attachments })

const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.text] : []))

describe('anexos em cada protocolo', () => {
  const files = [image, pdf, code]

  it('sends Anthropic native image and document blocks, and text as text', async () => {
    const thread = newThread()
    await send(runner(), thread, CLAUDE, 'veja estes', files)
    expect(errors()).toEqual([])
    const content = llm.last('anthropic')!.body.messages[0].content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
    expect(content[1]).toEqual({ type: 'document', title: 'contrato.pdf', source: { type: 'base64', media_type: 'application/pdf', data: PDF } })
    expect(content[2].text).toContain('app.ts')
    expect(content[2].text).toContain('export const app = 1')
    expect(content[3]).toEqual({ type: 'text', text: 'veja estes' })
  })

  it('sends OpenAI input items', async () => {
    const thread = newThread()
    await send(runner(), thread, GPT, 'veja estes', files)
    expect(errors()).toEqual([])
    const content = llm.last('openai-responses')!.body.input[0].content
    expect(content[0]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' })
    expect(content[1]).toEqual({ type: 'input_file', filename: 'contrato.pdf', file_data: `data:application/pdf;base64,${PDF}` })
    expect(content[2].text).toContain('export const app = 1')
    expect(content[3]).toEqual({ type: 'input_text', text: 'veja estes' })
  })

  it('sends Gemini inline data', async () => {
    const thread = newThread()
    await send(runner(), thread, GEMINI, 'veja estes', files)
    expect(errors()).toEqual([])
    const parts = llm.last('gemini')!.body.contents[0].parts
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } })
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'application/pdf', data: PDF } })
    expect(parts[2].text).toContain('export const app = 1')
    expect(parts[3]).toEqual({ text: 'veja estes' })
  })

  it('sends OpenAI-compatible servers images, and says when a PDF cannot be read', async () => {
    const thread = newThread()
    await send(runner(), thread, COMPAT, 'veja estes', files)
    expect(errors()).toEqual([])
    const content = llm.last('openai-chat')!.body.messages.at(-1).content
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } })
    expect(content[1].text).toContain('Este provedor não lê PDFs')
    expect(content[1].text).toContain('export const app = 1')
    expect(content[1].text).toContain('veja estes')
  })

  it('keeps plain string content for servers when no image is attached', async () => {
    const thread = newThread()
    await send(runner(), thread, COMPAT, 'veja', [code])
    expect(typeof llm.last('openai-chat')!.body.messages.at(-1).content).toBe('string')
  })
})

describe('anexos na conversa', () => {
  it('stores files on disk rather than in the conversation', async () => {
    const thread = newThread()
    await send(runner(), thread, COMPAT, 'veja', [image])
    expect(JSON.stringify(thread.messages)).not.toContain(PNG)
    expect(thread.messages[0].parts[0]).toMatchObject({ type: 'attachment', name: 'print.png', mediaType: 'image/png' })
    expect(await readdir(path.join(dir, 'attachments'))).toHaveLength(1)
  })

  it('stays available to every model that continues the conversation', async () => {
    const r = runner()
    const thread = newThread()
    await send(r, thread, CLAUDE, 'veja', [image])
    await send(r, thread, GPT, 'e você?')
    await send(r, thread, GEMINI, 'e você?')
    await send(r, thread, COMPAT, 'e você?')
    expect(errors()).toEqual([])
    expect(JSON.stringify(llm.last('openai-responses')!.body.input)).toContain(PNG)
    expect(JSON.stringify(llm.last('gemini')!.body.contents)).toContain(PNG)
    expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).toContain(PNG)
  })

  it('sends only a file, with no text, and titles the conversation after it', async () => {
    const thread = newThread()
    await send(runner(), thread, COMPAT, '', [image])
    expect(errors()).toEqual([])
    expect(thread.title).toBe('print.png')
    expect(thread.messages[0].parts).toHaveLength(1)
  })

  it('tells a model that cannot read images about the file instead of failing', async () => {
    imageInput = false
    const thread = newThread()
    await send(runner(), thread, COMPAT, 'veja', [image])
    expect(errors()).toEqual([])
    const sent = JSON.stringify(llm.last('openai-chat')!.body.messages)
    expect(sent).not.toContain(PNG)
    expect(sent).toContain('Este modelo não lê imagens')
    // The file itself stays, for a model that can read it later.
    expect(thread.messages[0].parts[0]).toMatchObject({ type: 'attachment' })
  })

  it('reports a missing file without breaking the conversation', async () => {
    const r = runner()
    const thread = newThread()
    await send(r, thread, COMPAT, 'veja', [image])
    await rm(path.join(dir, 'attachments'), { recursive: true, force: true })
    await send(r, thread, COMPAT, 'de novo')
    expect(errors()).toEqual([])
    expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).toContain('Anexo indisponível: print.png')
  })
})

describe('validação de anexos', () => {
  it('refuses binary files, oversized files, and too many at once', async () => {
    await expect(store.save([{ name: 'app.exe', mediaType: 'application/octet-stream', data: Buffer.from([1, 0, 2]).toString('base64') }])).rejects.toThrow('binário')
    await expect(store.save([{ name: 'enorme.png', mediaType: 'image/png', data: Buffer.alloc(6 * 1024 * 1024).toString('base64') }])).rejects.toThrow('limite de 5 MB')
    await expect(store.save([{ name: 'enorme.txt', mediaType: 'text/plain', data: Buffer.alloc(2 * 1024 * 1024, 'a').toString('base64') }])).rejects.toThrow('limite de 1 MB')
    await expect(store.save(Array.from({ length: 11 }, () => code))).rejects.toThrow('até 10')
  })

  it('treats any file of readable text as text, whatever its declared type', async () => {
    const [part] = await store.save([{ name: 'Dockerfile', mediaType: 'application/x-unknown', data: toBase64('FROM node') }])
    expect(part.mediaType).toBe('text/plain')
  })

  it('previews stored images, and refuses references that could leave its folder', async () => {
    const [part] = await store.save([image])
    expect(await store.preview(part.ref)).toBe(`data:image/png;base64,${PNG}`)
    await expect(store.preview('../../settings.json')).rejects.toThrow('inválida')
  })

  it('stops a run whose attachment is refused, keeping the conversation unchanged', async () => {
    const thread = newThread()
    await send(runner(), thread, COMPAT, 'veja', [{ name: 'app.exe', mediaType: 'application/octet-stream', data: Buffer.from([1, 0, 2]).toString('base64') }])
    expect(errors()[0]).toContain('binário')
    expect(thread.messages).toEqual([])
    expect(llm.requests).toHaveLength(0)
  })
})

describe('velocidade medida', () => {
  const vault: Vault = { encrypt: async (text) => text, decrypt: async (text) => text }

  it('learns how fast a model is, weighing recent answers more, and survives a restart', async () => {
    const settings = new SettingsStore(dir, vault, {})
    const ref = { provider: 'p', id: 'm' }
    expect(settings.speedOf(ref)).toBeUndefined()

    settings.recordSpeed(ref, 1000, 2000, 200)
    expect(settings.speedOf(ref)).toEqual({ tokensPerSecond: 100, firstTokenMs: 1000 })

    settings.recordSpeed(ref, 2000, 1000, 200)
    const blended = settings.speedOf(ref)!
    expect(blended.tokensPerSecond).toBeCloseTo(130, 6)
    expect(blended.firstTokenMs).toBeCloseTo(1300, 6)

    // Too little output says nothing about speed.
    settings.recordSpeed(ref, 9000, 10, 1)
    expect(settings.speedOf(ref)).toEqual(blended)

    await expect.poll(async () => {
      const reopened = new SettingsStore(dir, vault, {})
      await reopened.load()
      return reopened.speedOf(ref)?.tokensPerSecond
    }).toBeCloseTo(130, 6)
  })

  it('is recorded from real answers', async () => {
    const recorded: unknown[] = []
    const r = new Runner({
      resolveModel: async (ref) => ({ adapter: createAdapter(connection(ref)), info: { ...ref, label: ref.id, providerName: ref.provider } as ModelInfo }),
      toolsFor: () => [],
      memory: () => '',
      emit: () => undefined,
      save: async () => undefined,
      requestApproval: async () => 'deny',
      recordSpeed: (ref, first, generating, output) => recorded.push({ ref: ref.id, first, generating, output })
    })
    const thread = newThread()
    await send(r, thread, COMPAT, 'oi')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ ref: 'chat-mock', first: expect.any(Number), generating: expect.any(Number), output: expect.any(Number) })
  })
})
