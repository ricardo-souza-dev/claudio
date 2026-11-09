import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local server speaking all four wire protocols, used through each SDK's real
 * HTTP path. Behavior follows the last user text:
 *   "ferramenta: <tool> <json>"  asks for a tool call, then answers after the result
 *   "lento"                      streams slowly, so a test can interrupt it
 *   "recuse"                     returns a refusal
 *   "falhe"                      returns HTTP 500
 *   anything else                echoes how much context the model received
 */

export interface RecordedRequest {
  protocol: 'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini'
  body: any
  headers: IncomingMessage['headers']
}

export interface MockLlm {
  url: string
  requests: RecordedRequest[]
  last(protocol: RecordedRequest['protocol']): RecordedRequest | undefined
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => (text += chunk))
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

function sse(res: ServerResponse, event: string | null, data: unknown): void {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Plan {
  kind: 'text' | 'tool' | 'slow' | 'refuse' | 'fail'
  text: string
  tool?: { name: string; input: unknown }
}

function plan(lastUserText: string, hasToolResult: boolean, label: string, contextChars: number): Plan {
  if (lastUserText.includes('plano-aprovavel')) return { kind: 'text', text: 'Plano: criar plano.txt com o conteúdo aprovado.' }
  if (lastUserText.startsWith('Plano aprovado.') && !hasToolResult) return { kind: 'tool', text: '', tool: { name: 'write_file', input: { path: 'plano.txt', content: 'aprovado' } } }
  if (hasToolResult) {
    if (lastUserText.includes('plano-interrompivel')) return { kind: 'slow', text: 'Continuando o trabalho planejado. '.repeat(20) }
    return { kind: 'text', text: `[${label}] ferramenta concluída.` }
  }
  if (lastUserText.includes('Changes to describe')) {
    return { kind: 'text', text: 'feat(painel): adiciona a segunda linha\n\nMostra o que mudou no README.' }
  }
  if (lastUserText.includes('markdown')) {
    return {
      kind: 'text',
      text: 'Texto em **negrito** com `código`.\n\n<img src=x onerror="window.__injetado=1">\n\n![rastreador](http://127.0.0.1:9/pixel.png)\n\n[um link](https://example.com)\n\n```ts\nconst a = 1\n```\n\n| Coluna | Valor |\n|---|---|\n| a | 1 |'
    }
  }
  if (lastUserText.includes('falhe')) return { kind: 'fail', text: '' }
  if (lastUserText.includes('recuse')) return { kind: 'refuse', text: '' }
  if (lastUserText.includes('lento')) return { kind: 'slow', text: 'Uma resposta lenta que será interrompida antes de terminar. '.repeat(20) }
  const match = /ferramenta: (\S+)\s*(\{.*\})?/s.exec(lastUserText)
  if (match) return { kind: 'tool', text: '', tool: { name: match[1], input: match[2] ? JSON.parse(match[2]) : {} } }
  return { kind: 'text', text: `[${label}] li ${contextChars} caracteres de contexto.` }
}

function chunks(text: string): string[] {
  return text.match(/.{1,12}/gs) ?? []
}

/** Text of the last user turn, and whether a tool result came after it, for any protocol. */
function inspect(protocol: RecordedRequest['protocol'], body: any): { text: string; hasToolResult: boolean } {
  if (protocol === 'anthropic') {
    const last = body.messages.at(-1)
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
    const user = body.messages.findLast((message: any) => message.role === 'user' && (typeof message.content === 'string' || message.content.some((part: any) => part.type === 'text')))
    const userBlocks = typeof user?.content === 'string' ? [{ type: 'text', text: user.content }] : user?.content ?? []
    return {
      text: userBlocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '),
      hasToolResult: blocks.some((b: any) => b.type === 'tool_result')
    }
  }
  if (protocol === 'openai-chat') {
    const last = body.messages.at(-1)
    return { text: String(last.content ?? ''), hasToolResult: last.role === 'tool' }
  }
  if (protocol === 'openai-responses') {
    const last = body.input.at(-1)
    return { text: typeof last.content === 'string' ? last.content : '', hasToolResult: last.type === 'function_call_output' }
  }
  const last = body.contents.at(-1)
  return {
    text: last.parts.filter((p: any) => p.text).map((p: any) => p.text).join(' '),
    hasToolResult: last.parts.some((p: any) => p.functionResponse)
  }
}

const usageFor = (text: string) => Math.ceil(text.length / 4)

async function anthropic(res: ServerResponse, body: any, step: Plan, signal: AbortSignal): Promise<void> {
  if (step.kind === 'fail') return failure(res)
  res.writeHead(200, SSE_HEADERS)
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
  })
  let index = 0
  if (body.thinking) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'Pensando no pedido.' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'assinatura-mock' } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (step.text) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const piece of chunks(step.text)) {
      if (signal.aborted) return
      if (step.kind === 'slow') await wait(60)
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (step.tool) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_mock1', name: step.tool.name, input: {} } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  }
  const stop = step.kind === 'refuse' ? 'refusal' : step.tool ? 'tool_use' : 'end_turn'
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usageFor(step.text) + 1 } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

async function responses(res: ServerResponse, body: any, step: Plan, signal: AbortSignal): Promise<void> {
  if (step.kind === 'fail') return failure(res)
  res.writeHead(200, SSE_HEADERS)
  const output: any[] = [
    { type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'cifrado-mock' }
  ]
  if (step.kind === 'refuse') {
    output.push({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Não posso ajudar com isso.' }] })
  }
  if (step.text) {
    for (const piece of chunks(step.text)) {
      if (signal.aborted) return
      if (step.kind === 'slow') await wait(60)
      sse(res, null, { type: 'response.output_text.delta', delta: piece, item_id: 'msg_1', output_index: 1, content_index: 0, sequence_number: 1 })
    }
    output.push({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] })
  }
  if (step.tool) {
    output.push({ type: 'function_call', id: 'fc_1', call_id: 'call_mock1', name: step.tool.name, arguments: JSON.stringify(step.tool.input), status: 'completed' })
  }
  sse(res, null, {
    type: 'response.completed',
    sequence_number: 2,
    response: { id: 'resp_mock', object: 'response', model: body.model, output, status: 'completed', usage: { input_tokens: 10, output_tokens: usageFor(step.text) + 1, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
  })
  res.end()
}

async function chat(res: ServerResponse, body: any, step: Plan, signal: AbortSignal): Promise<void> {
  if (step.kind === 'fail') return failure(res)
  // Mirrors how a model without function calling answers, to exercise the fallback.
  if (String(body.model).includes('sem-ferramentas') && body.tools) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `${body.model} does not support tools` } }))
    return
  }
  // Mirrors a model the public catalog wrongly lists as accepting an effort level.
  if (String(body.model).includes('sem-forca') && body.reasoning_effort) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Unrecognized request argument: reasoning_effort' } }))
    return
  }
  res.writeHead(200, SSE_HEADERS)
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model }
  for (const piece of chunks(step.text)) {
    if (signal.aborted) return
    if (step.kind === 'slow') await wait(60)
    sse(res, null, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
  }
  if (step.tool) {
    const args = JSON.stringify(step.tool.input)
    sse(res, null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: step.tool.name, arguments: '' } }] }, finish_reason: null }] })
    sse(res, null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 4) } }] }, finish_reason: null }] })
    sse(res, null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(4) } }] }, finish_reason: null }] })
  }
  const finish = step.kind === 'refuse' ? 'content_filter' : step.tool ? 'tool_calls' : 'stop'
  sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
  sse(res, null, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: usageFor(step.text) + 1, total_tokens: 20 } })
  res.write('data: [DONE]\n\n')
  res.end()
}

async function gemini(res: ServerResponse, step: Plan, signal: AbortSignal): Promise<void> {
  if (step.kind === 'fail') return failure(res)
  res.writeHead(200, SSE_HEADERS)
  if (step.kind === 'refuse') {
    sse(res, null, { promptFeedback: { blockReason: 'SAFETY' } })
    res.end()
    return
  }
  for (const piece of chunks(step.text)) {
    if (signal.aborted) return
    if (step.kind === 'slow') await wait(60)
    sse(res, null, { candidates: [{ content: { role: 'model', parts: [{ text: piece }] } }] })
  }
  if (step.tool) {
    sse(res, null, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: step.tool.name, args: step.tool.input }, thoughtSignature: 'assinatura-gemini' }] } }] })
  }
  sse(res, null, {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: usageFor(step.text) + 1 }
  })
  res.end()
}

function failure(res: ServerResponse): void {
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'falha simulada', type: 'server_error' } }))
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function fact(context: number, output: number, input: number, price: number, reasoning: boolean, released: string, toolCall = true, images = false) {
  return {
    limit: { context, output },
    cost: { input, output: price, cache_read: input / 10 },
    reasoning,
    tool_call: toolCall,
    release_date: released,
    modalities: { input: images ? ['text', 'image'] : ['text'], output: ['text'] }
  }
}

/** The same shape as models.dev, with the prices spread so automatic choice has something to decide. */
const MODEL_FACTS = {
  anthropic: { models: { 'claude-mock': fact(200_000, 32_000, 3, 15, true, '2026-06-01', true, true) } },
  openai: { models: { 'gpt-mock': fact(128_000, 16_000, 1, 4, true, '2026-05-01', true, true) } },
  google: { models: { 'gemini-mock': fact(100_000, 8_000, 0.5, 2, true, '2026-04-01', true, true) } },
  outro: {
    models: {
      'chat-mock': fact(64_000, 8_000, 0.1, 0.4, false, '2026-03-01'),
      'chat-sem-ferramentas': fact(32_000, 4_000, 0.05, 0.2, false, '2026-03-01', false),
      'chat-sem-forca': fact(64_000, 8_000, 0.2, 0.8, true, '2026-03-01')
    }
  }
}

export async function startMockLlm(): Promise<MockLlm> {
  const requests: RecordedRequest[] = []

  const server: Server = createServer((req, res) => {
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    void (async () => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET') {
        if (path === '/anthropic/v1/models') {
          return json(res, {
            data: [
              { type: 'model', id: 'claude-mock', display_name: 'Claude Simulado', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 32000, capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } }
            ],
            has_more: false,
            first_id: 'claude-mock',
            last_id: 'claude-mock'
          })
        }
        if (path === '/openai/v1/models') return json(res, { object: 'list', data: [{ id: 'gpt-mock', object: 'model' }, { id: 'text-embedding-mock', object: 'model' }] })
        if (path === '/compat/v1/models') return json(res, { object: 'list', data: [{ id: 'chat-mock', object: 'model' }, { id: 'chat-sem-ferramentas', object: 'model' }, { id: 'chat-sem-forca', object: 'model' }] })
        if (path === '/facts.json') return json(res, MODEL_FACTS)
        if (/^\/gemini\/v1(beta)?\/models$/.test(path)) {
          return json(res, { models: [{ name: 'models/gemini-mock', displayName: 'Gemini Simulado', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000, outputTokenLimit: 8000 }] })
        }
        res.writeHead(404).end()
        return
      }

      const body = await readBody(req)
      let protocol: RecordedRequest['protocol'] | null = null
      if (path === '/anthropic/v1/messages') protocol = 'anthropic'
      else if (path === '/openai/v1/responses') protocol = 'openai-responses'
      else if (path === '/compat/v1/chat/completions') protocol = 'openai-chat'
      else if (/^\/gemini\/v1(beta)?\/models\/.+:streamGenerateContent$/.test(path)) protocol = 'gemini'
      if (!protocol) {
        res.writeHead(404).end()
        return
      }
      requests.push({ protocol, body, headers: req.headers })
      const { text, hasToolResult } = inspect(protocol, body)
      const step = plan(text, hasToolResult, protocol, JSON.stringify(body).length)
      if (protocol === 'anthropic') await anthropic(res, body, step, abort.signal)
      else if (protocol === 'openai-responses') await responses(res, body, step, abort.signal)
      else if (protocol === 'openai-chat') await chat(res, body, step, abort.signal)
      else await gemini(res, step, abort.signal)
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    last: (protocol) => requests.filter((request) => request.protocol === protocol).at(-1),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
