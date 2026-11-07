import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalDecision, ApprovalRequest, ModelInfo, ModelRef, PermissionMode, Thread, UniEvent } from '../src/shared/types'
import { Runner } from '../src/main/agent/runner'
import { createAdapter } from '../src/main/providers/catalog'
import { textOf } from '../src/main/providers/history'
import type { ProviderConnection } from '../src/main/providers/types'
import { workspaceTools } from '../src/main/tools/builtin'
import { startMockLlm, type MockLlm } from './fixtures/mock-llm'

const CLAUDE: ModelRef = { provider: 'anthropic', id: 'claude-mock' }
const GPT: ModelRef = { provider: 'openai', id: 'gpt-mock' }
const GEMINI: ModelRef = { provider: 'google', id: 'gemini-mock' }
const COMPAT: ModelRef = { provider: 'compat', id: 'chat-mock' }

let llm: MockLlm
let workspace: string

beforeAll(async () => {
  llm = await startMockLlm()
})
afterAll(() => llm.close())
beforeEach(async () => {
  llm.requests.length = 0
  workspace = await mkdtemp(path.join(tmpdir(), 'uni-runner-'))
})
afterEach(() => rm(workspace, { recursive: true, force: true }))

function connection(ref: ModelRef): ProviderConnection {
  const table: Record<string, Pick<ProviderConnection, 'protocol' | 'baseUrl' | 'name'>> = {
    anthropic: { protocol: 'anthropic', baseUrl: `${llm.url}/anthropic`, name: 'Anthropic' },
    openai: { protocol: 'openai-responses', baseUrl: `${llm.url}/openai/v1`, name: 'OpenAI' },
    google: { protocol: 'gemini', baseUrl: `${llm.url}/gemini`, name: 'Google' },
    compat: { protocol: 'openai-chat', baseUrl: `${llm.url}/compat/v1`, name: 'Compatível' }
  }
  return { id: ref.provider, official: false, apiKey: 'chave-teste', ...table[ref.provider] }
}

function info(ref: ModelRef): ModelInfo {
  const base = { ...ref, label: ref.id, providerName: ref.provider }
  return ref.provider === 'anthropic'
    ? { ...base, thinking: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], maxOutput: 32000 }
    : { ...base, efforts: ['low', 'medium', 'high'] }
}

interface Harness {
  runner: Runner
  events: UniEvent[]
  approvals: ApprovalRequest[]
  decision: ApprovalDecision
  onApproval?: () => void
}

function harness(decision: ApprovalDecision = 'allow', useWorkspace = true): Harness {
  const state: Harness = {
    events: [],
    approvals: [],
    decision,
    runner: new Runner({
      resolveModel: async (ref) => ({ adapter: createAdapter(connection(ref)), info: info(ref) }),
      toolsFor: () => (useWorkspace ? workspaceTools(workspace) : []),
      memory: () => 'O usuário prefere respostas curtas.',
      emit: (event) => state.events.push(event),
      save: async () => undefined,
      requestApproval: async (_threadId, request) => {
        state.approvals.push(request)
        state.onApproval?.()
        return state.decision
      }
    })
  }
  return state
}

function newThread(): Thread {
  const now = Date.now()
  return { id: '00000000-0000-4000-8000-000000000001', title: 'x', createdAt: now, updatedAt: now, workspace, model: null, system: null, contextFiles: [], allowedTools: [], messages: [] }
}

const agent = (thread: Thread, text: string, model: ModelRef, permissionMode: PermissionMode = 'ask') =>
  ({ threadId: thread.id, text, model, permissionMode })

const errorsOf = (h: Harness) => h.events.flatMap((event) => (event.type === 'error' ? [event.text] : []))
const noticesOf = (h: Harness) => h.events.flatMap((event) => (event.type === 'notice' ? [event.text] : []))
const lastAssistant = (thread: Thread) => thread.messages.filter((message) => message.role === 'assistant').at(-1)!

describe('uma conversa, vários modelos', () => {
  it('passes the same thread through all four protocols', async () => {
    const h = harness()
    const thread = newThread()

    await h.runner.send(thread, agent(thread, 'Primeira pergunta', CLAUDE))
    await h.runner.send(thread, agent(thread, 'Segunda pergunta', GPT))
    await h.runner.send(thread, agent(thread, 'Terceira pergunta', GEMINI))
    await h.runner.send(thread, agent(thread, 'Quarta pergunta', COMPAT))
    await h.runner.send(thread, agent(thread, 'Quinta pergunta', CLAUDE))

    expect(errorsOf(h)).toEqual([])
    expect(thread.messages.filter((message) => message.role === 'assistant').map((message) => message.model?.id)).toEqual([
      'claude-mock', 'gpt-mock', 'gemini-mock', 'chat-mock', 'claude-mock'
    ])

    // Each model received what the others wrote.
    const chat = JSON.stringify(llm.last('openai-chat')!.body.messages)
    expect(chat).toContain('Primeira pergunta')
    expect(chat).toContain('[anthropic]')
    expect(chat).toContain('[openai-responses]')
    expect(chat).toContain('[gemini]')

    // Signed thinking reaches Anthropic again, and no other provider ever sees it.
    const anthropicAgain = JSON.stringify(llm.last('anthropic')!.body.messages)
    expect(anthropicAgain).toContain('assinatura-mock')
    expect(chat).not.toContain('assinatura-mock')
    expect(JSON.stringify(llm.last('openai-responses')!.body.input)).not.toContain('assinatura-mock')
    expect(JSON.stringify(llm.last('gemini')!.body.contents)).not.toContain('assinatura-mock')
  })

  it('sends every model byte-identical system prompt and keeps it frozen', async () => {
    const h = harness()
    const thread = newThread()
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Use tabs.')
    await writeFile(path.join(workspace, 'CLAUDE.md'), 'Escreva testes.')

    await h.runner.send(thread, agent(thread, 'um', CLAUDE))
    const frozen = thread.system!
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Mudou depois.')
    await h.runner.send(thread, agent(thread, 'dois', GPT))
    await h.runner.send(thread, agent(thread, 'três', GEMINI))
    await h.runner.send(thread, agent(thread, 'quatro', COMPAT))

    expect(thread.contextFiles).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(frozen).toContain('Use tabs.')
    expect(frozen).toContain('Escreva testes.')
    expect(frozen).toContain('respostas curtas')
    expect(llm.last('anthropic')!.body.system).toBe(frozen)
    expect(llm.last('openai-responses')!.body.instructions).toBe(frozen)
    expect(llm.last('openai-chat')!.body.messages[0].content).toBe(frozen)
    expect(llm.last('gemini')!.body.systemInstruction.parts[0].text).toBe(frozen)
  })

  it('replays earlier turns byte-identically to Anthropic after other models intervene', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'um', CLAUDE))
    const first = llm.last('anthropic')!.body.messages
    await h.runner.send(thread, agent(thread, 'dois', GPT))
    await h.runner.send(thread, agent(thread, 'três', CLAUDE))
    const second = llm.last('anthropic')!.body.messages

    // Append-only is what keeps thinking valid and the prompt cache warm.
    expect(JSON.stringify(second).startsWith(JSON.stringify(first).slice(0, -1))).toBe(true)
  })

  it('hands a tool call started by one provider to any other', async () => {
    await writeFile(path.join(workspace, 'nota.txt'), 'conteúdo importante')
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: read_file {"path":"nota.txt"}', CLAUDE))
    expect(errorsOf(h)).toEqual([])
    const result = thread.messages.find((message) => message.role === 'tool')!.parts[0]
    expect(result).toMatchObject({ type: 'tool_result', name: 'read_file', content: 'conteúdo importante' })

    await h.runner.send(thread, agent(thread, 'continue', GEMINI))
    await h.runner.send(thread, agent(thread, 'continue', GPT))
    await h.runner.send(thread, agent(thread, 'continue', COMPAT))
    expect(errorsOf(h)).toEqual([])

    // Google's documented signature for calls Gemini didn't generate.
    const geminiBody = llm.last('gemini')!.body
    const call = geminiBody.contents.flatMap((entry: any) => entry.parts).find((part: any) => part.functionCall)
    expect(call.thoughtSignature).toBe('context_engineering_is_the_way_to_go')
    const response = geminiBody.contents.flatMap((entry: any) => entry.parts).find((part: any) => part.functionResponse)
    expect(response.functionResponse).toEqual({ name: 'read_file', response: { output: 'conteúdo importante' } })

    const responsesInput = llm.last('openai-responses')!.body.input
    expect(responsesInput.find((item: any) => item.type === 'function_call')).toMatchObject({ call_id: 'toolu_mock1', name: 'read_file' })
    expect(responsesInput.find((item: any) => item.type === 'function_call_output')).toMatchObject({ call_id: 'toolu_mock1' })

    const chat = llm.last('openai-chat')!.body.messages
    expect(chat.find((entry: any) => entry.tool_calls)?.tool_calls[0].function.name).toBe('read_file')
    expect(chat.find((entry: any) => entry.role === 'tool')).toMatchObject({ tool_call_id: 'toolu_mock1' })
  })

  it('replays Gemini and OpenAI wire data only to the model that wrote it', async () => {
    const h = harness()
    const thread = newThread()
    await writeFile(path.join(workspace, 'a.txt'), 'a')
    await h.runner.send(thread, agent(thread, 'ferramenta: read_file {"path":"a.txt"}', GEMINI))
    expect(JSON.stringify(llm.last('gemini')!.body.contents)).toContain('assinatura-gemini')
    await h.runner.send(thread, agent(thread, 'mais', { provider: 'google', id: 'gemini-outro' }))
    const other = JSON.stringify(llm.last('gemini')!.body.contents)
    expect(other).not.toContain('assinatura-gemini')
    expect(other).toContain('context_engineering_is_the_way_to_go')

    const second = newThread()
    await h.runner.send(second, agent(second, 'olá', GPT))
    await h.runner.send(second, agent(second, 'de novo', GPT))
    expect(JSON.stringify(llm.last('openai-responses')!.body.input)).toContain('cifrado-mock')
    await h.runner.send(second, agent(second, 'outro', { provider: 'openai', id: 'gpt-outro' }))
    expect(JSON.stringify(llm.last('openai-responses')!.body.input)).not.toContain('cifrado-mock')
  })

  it('uses the Anthropic features the model advertises', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'oi', CLAUDE))
    const { body, headers } = llm.last('anthropic')!
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(32000)
    expect(body.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools.every((tool: any) => tool.eager_input_streaming === true)).toBe(true)
    expect(String(headers['anthropic-beta'])).toContain('thinking-binding-controls-2026-08-01')
    // Fallback routing is only for Anthropic's own endpoint, not this custom base URL.
    expect(body.fallbacks).toBeUndefined()
  })

  it('offers the same tools, by name, to every protocol', async () => {
    const h = harness()
    const thread = newThread()
    for (const model of [CLAUDE, GPT, GEMINI, COMPAT]) await h.runner.send(thread, agent(thread, 'oi', model))
    const names = [
      llm.last('anthropic')!.body.tools.map((tool: any) => tool.name),
      llm.last('openai-responses')!.body.tools.map((tool: any) => tool.name),
      llm.last('gemini')!.body.tools[0].functionDeclarations.map((tool: any) => tool.name),
      llm.last('openai-chat')!.body.tools.map((tool: any) => tool.function.name)
    ]
    for (const list of names) expect(list).toEqual(names[0])
    expect(names[0]).toContain('run_command')
  })
})

describe('força do modelo', () => {
  const withEffort = (thread: Thread, text: string, model: ModelRef, effort: 'low' | 'high' | 'xhigh' | 'max') => ({ ...agent(thread, text, model), effort })

  it('translates one setting into what each protocol understands', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, withEffort(thread, 'oi', CLAUDE, 'xhigh'))
    expect(llm.last('anthropic')!.body.output_config).toEqual({ effort: 'xhigh' })

    await h.runner.send(thread, withEffort(thread, 'oi', GPT, 'low'))
    expect(llm.last('openai-responses')!.body.reasoning).toEqual({ effort: 'low' })

    await h.runner.send(thread, withEffort(thread, 'oi', COMPAT, 'high'))
    expect(llm.last('openai-chat')!.body.reasoning_effort).toBe('high')

    await h.runner.send(thread, withEffort(thread, 'oi', GEMINI, 'low'))
    expect(llm.last('gemini')!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' })

    await h.runner.send(thread, withEffort(thread, 'oi', { provider: 'google', id: 'gemini-2.5-mock' }, 'low'))
    expect(llm.last('gemini')!.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024 })
    expect(errorsOf(h)).toEqual([])
  })

  it('gives each model the closest level it supports', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, withEffort(thread, 'oi', GPT, 'max'))
    expect(llm.last('openai-responses')!.body.reasoning).toEqual({ effort: 'high' })
  })

  it('leaves the setting out when the user chose the default', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'oi', GPT))
    await h.runner.send(thread, agent(thread, 'oi', COMPAT))
    expect(llm.last('openai-responses')!.body.reasoning).toBeUndefined()
    expect(llm.last('openai-chat')!.body.reasoning_effort).toBeUndefined()
  })

  it('finishes the turn when a model rejects the setting', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, withEffort(thread, 'oi', { provider: 'compat', id: 'chat-sem-forca' }, 'high'))
    expect(errorsOf(h)).toEqual([])
    expect(noticesOf(h).some((notice) => notice.includes('não aceita ajuste de força'))).toBe(true)
    expect(lastAssistant(thread).stop).toBe('end')
  })
})

describe('tarefas em andamento', () => {
  const PLAN = '{"items":[{"content":"Ler","status":"completed"},{"content":"Corrigir","status":"in_progress"}]}'

  it('keeps the list a model sends, and clears it on the next request', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, `ferramenta: update_plan ${PLAN}`, COMPAT, 'read-only'))
    expect(h.approvals).toHaveLength(0)
    expect(thread.plan).toEqual([
      { content: 'Ler', status: 'completed' },
      { content: 'Corrigir', status: 'in_progress' }
    ])
    await h.runner.send(thread, agent(thread, 'outra coisa', COMPAT))
    expect(thread.plan).toEqual([])
  })

  it('ignores a malformed list', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: update_plan {"items":[{"content":"Sem status"}]}', COMPAT))
    expect(thread.plan).toEqual([])
    expect(thread.messages.find((message) => message.role === 'tool')!.parts[0]).toMatchObject({ isError: true })
  })

  it('shows a note about the choice of model when the run starts', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, { ...agent(thread, 'oi', COMPAT), note: 'Automático: escolhi este.' })
    expect(noticesOf(h)).toContain('Automático: escolhi este.')
  })
})

describe('segurança das ferramentas', () => {
  it('asks before writing and honors a denial', async () => {
    const h = harness('deny')
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: write_file {"path":"novo.txt","content":"x"}', COMPAT))
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]).toMatchObject({ tool: 'write_file', risk: 'write' })
    expect(thread.messages.find((message) => message.role === 'tool')!.parts[0]).toMatchObject({ isError: true, content: 'O usuário negou esta ação.' })
    await expect(import('node:fs/promises').then((fs) => fs.readFile(path.join(workspace, 'novo.txt')))).rejects.toThrow()
  })

  it('remembers "always in this conversation"', async () => {
    const h = harness('allow-always')
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: write_file {"path":"a.txt","content":"1"}', COMPAT))
    await h.runner.send(thread, agent(thread, 'ferramenta: write_file {"path":"b.txt","content":"2"}', COMPAT))
    expect(h.approvals).toHaveLength(1)
    expect(thread.allowedTools).toEqual(['write_file'])
  })

  it('blocks writes in read-only mode without asking', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: run_command {"command":"echo oi"}', COMPAT, 'read-only'))
    expect(h.approvals).toHaveLength(0)
    expect(thread.messages.find((message) => message.role === 'tool')!.parts[0]).toMatchObject({ isError: true })
  })

  it('asks before reading a secrets file, even in auto-edit mode', async () => {
    await writeFile(path.join(workspace, '.env'), 'SEGREDO=1')
    const h = harness('deny')
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: read_file {"path":".env"}', COMPAT, 'auto-edit'))
    expect(h.approvals[0]).toMatchObject({ risk: 'sensitive' })
    expect(JSON.stringify(thread.messages)).not.toContain('SEGREDO')
  })

  it('rejects arguments that do not match the schema before running anything', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: write_file {"path":"a.txt"}', COMPAT))
    expect(h.approvals).toHaveLength(0)
    const result = thread.messages.find((message) => message.role === 'tool')!.parts[0]
    expect(result).toMatchObject({ isError: true })
    expect((result as { content: string }).content).toContain('content')
  })

  it('reports an unknown tool to the model instead of crashing', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'ferramenta: nao_existe', COMPAT))
    expect(errorsOf(h)).toEqual([])
    expect(thread.messages.find((message) => message.role === 'tool')!.parts[0]).toMatchObject({ isError: true })
  })
})

describe('interrupções e falhas', () => {
  for (const model of [CLAUDE, GPT, GEMINI, COMPAT]) {
    it(`keeps what ${model.provider} streamed when interrupted, and the thread stays usable`, async () => {
      const h = harness()
      const thread = newThread()
      const run = h.runner.send(thread, agent(thread, 'lento', model))
      await expect.poll(() => h.events.some((event) => event.type === 'delta' && event.kind === 'text')).toBe(true)
      h.runner.stop(thread.id)
      await run

      expect(errorsOf(h)).toEqual([])
      const partial = lastAssistant(thread)
      expect(partial.stop).toBe('aborted')
      expect(partial.raw).toBeUndefined()
      expect(textOf(partial.parts).length).toBeGreaterThan(0)

      await h.runner.send(thread, agent(thread, 'continue', model))
      expect(errorsOf(h)).toEqual([])
      expect(lastAssistant(thread).stop).toBe('end')
    })
  }

  it('answers a dangling tool call so the next provider accepts the history', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'olá', CLAUDE))
    // As if the app had closed between the tool call and its result.
    thread.messages.push({
      id: 'm_x',
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'toolu_orfao', name: 'read_file', input: { path: 'x' } }],
      createdAt: Date.now(),
      model: CLAUDE
    })
    await h.runner.send(thread, agent(thread, 'continue', COMPAT))
    const messages = llm.last('openai-chat')!.body.messages
    expect(messages.find((entry: any) => entry.role === 'tool' && entry.tool_call_id === 'toolu_orfao')).toBeTruthy()
  })

  it('surfaces a provider failure and lets another model take over from the same point', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'falhe', GEMINI))
    expect(errorsOf(h).length).toBe(1)
    expect(thread.messages.at(-1)?.role).toBe('user')
    expect(h.runner.isRunning(thread.id)).toBe(false)
  }, 15_000)

  it('runs again from the last user message when sent empty', async () => {
    const h = harness()
    const thread = newThread()
    thread.messages.push({ id: 'm_1', role: 'user', parts: [{ type: 'text', text: 'pergunta pendente' }], createdAt: 1 })
    await h.runner.send(thread, agent(thread, '', COMPAT))
    expect(thread.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(lastAssistant(thread).stop).toBe('end')
  })

  it('shows a refusal but never replays it to any model', async () => {
    const h = harness()
    const thread = newThread()
    await h.runner.send(thread, agent(thread, 'recuse', GPT))
    const refused = lastAssistant(thread)
    expect(refused.excluded).toBe(true)
    expect(refused.raw).toBeUndefined()
    expect(noticesOf(h).some((notice) => notice.includes('recusou'))).toBe(true)

    await h.runner.send(thread, agent(thread, 'tudo bem', COMPAT))
    expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).not.toContain('Não posso ajudar')
  })

  it('continues without tools when the model does not accept them', async () => {
    const h = harness()
    const thread = newThread()
    await writeFile(path.join(workspace, 'a.txt'), 'a')
    await h.runner.send(thread, agent(thread, 'ferramenta: read_file {"path":"a.txt"}', CLAUDE))
    await h.runner.send(thread, agent(thread, 'resuma', { provider: 'compat', id: 'chat-sem-ferramentas' }))
    expect(errorsOf(h)).toEqual([])
    expect(noticesOf(h).some((notice) => notice.includes('não aceita ferramentas'))).toBe(true)
    const body = llm.last('openai-chat')!.body
    expect(body.tools).toBeUndefined()
    expect(JSON.stringify(body.messages)).toContain('Resultado de read_file')
    expect(body.messages.some((entry: any) => entry.role === 'tool')).toBe(false)
  })
})

