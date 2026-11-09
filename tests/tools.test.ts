import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '../src/shared/types'
import { buildSystemPrompt } from '../src/main/agent/context'
import { describeProject, resolveProjectRoot, withoutCredentials } from '../src/main/project'
import { buildAnthropicRequest } from '../src/main/providers/anthropic'
import { createAdapter } from '../src/main/providers/catalog'
import { toGeminiSchema } from '../src/main/providers/gemini'
import { contextOf, flattenHistory, safeToolId } from '../src/main/providers/history'
import { isSensitivePath, resolveInside, workspaceTools } from '../src/main/tools/builtin'
import { mcpToolName, McpManager, parseMcpJson } from '../src/main/tools/mcp'
import { permissionFor, type Tool } from '../src/main/tools/types'
import { SettingsStore, ThreadStore, type Vault } from '../src/main/store'
import { startMockLlm } from './fixtures/mock-llm'

let root: string
let tools: Tool[]
const signal = new AbortController().signal
const tool = (name: string) => tools.find((entry) => entry.name === name)!

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'uni-tools-'))
  tools = workspaceTools(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('pasta de trabalho', () => {
  it('refuses paths outside the folder', async () => {
    await expect(resolveInside(root, '../fora.txt')).rejects.toThrow('Fora da pasta')
    await expect(resolveInside(root, path.resolve(root, '..', 'fora.txt'))).rejects.toThrow('Fora da pasta')
    await expect(resolveInside(root, 'sub/../../fora.txt')).rejects.toThrow('Fora da pasta')
    expect(await resolveInside(root, 'novo/arquivo.txt')).toContain('arquivo.txt')
  })

  it('refuses a symlink that leaves the folder', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'uni-outside-'))
    await writeFile(path.join(outside, 'segredo.txt'), 'x')
    try {
      await symlink(outside, path.join(root, 'atalho'), 'junction')
    } catch {
      await rm(outside, { recursive: true, force: true })
      return // Creating links needs privileges on some systems.
    }
    await expect(resolveInside(root, 'atalho/segredo.txt')).rejects.toThrow('Fora da pasta')
    const result = await tool('read_file').run({ path: 'atalho/segredo.txt' }, signal)
    expect(result.isError).toBe(true)
    await rm(outside, { recursive: true, force: true })
  })

  it('reads, writes and edits', async () => {
    await tool('write_file').run({ path: 'a/b.txt', content: 'um\ndois\ntrês' }, signal)
    expect((await tool('read_file').run({ path: 'a/b.txt', offset: 2, limit: 1 }, signal)).content).toContain('dois')

    const edit = await tool('edit_file').run({ path: 'a/b.txt', old_string: 'dois', new_string: '$& literal' }, signal)
    expect(edit.isError).toBeUndefined()
    expect(await readFile(path.join(root, 'a/b.txt'), 'utf8')).toBe('um\n$& literal\ntrês')
  })

  it('keeps read results short unless the model asks for more', async () => {
    await writeFile(path.join(root, 'long.txt'), Array.from({ length: 600 }, (_, index) => `linha ${index + 1}`).join('\n'))
    const defaultRead = await tool('read_file').run({ path: 'long.txt' }, signal)
    expect(defaultRead.content).toContain('linha 400')
    expect(defaultRead.content).not.toContain('linha 401')
    expect(defaultRead.content).toContain('[Mostrando linhas 1-400 de 600]')

    const explicitRead = await tool('read_file').run({ path: 'long.txt', limit: 450 }, signal)
    expect(explicitRead.content).toContain('linha 450')
  })

  it('requires an unambiguous match to edit', async () => {
    await writeFile(path.join(root, 'r.txt'), 'x x')
    const ambiguous = await tool('edit_file').run({ path: 'r.txt', old_string: 'x', new_string: 'y' }, signal)
    expect(ambiguous.isError).toBe(true)
    expect(await readFile(path.join(root, 'r.txt'), 'utf8')).toBe('x x')
    await tool('edit_file').run({ path: 'r.txt', old_string: 'x', new_string: 'y', replace_all: true }, signal)
    expect(await readFile(path.join(root, 'r.txt'), 'utf8')).toBe('y y')
  })

  it('searches but skips secrets and dependencies', async () => {
    await mkdir(path.join(root, 'node_modules'))
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src/a.ts'), 'const chave = 1')
    await writeFile(path.join(root, 'src/b.md'), 'chave aqui')
    await writeFile(path.join(root, '.env'), 'chave=segredo')
    await writeFile(path.join(root, 'node_modules/x.js'), 'chave')
    const all = await tool('search').run({ pattern: 'chave' }, signal)
    expect(all.content).toContain('src/a.ts:1')
    expect(all.content).not.toContain('segredo')
    expect(all.content).not.toContain('node_modules')
    const scoped = await tool('search').run({ pattern: 'chave', glob: 'src/**/*.ts' }, signal)
    expect(scoped.content).toContain('a.ts')
    expect(scoped.content).not.toContain('b.md')
  })

  it('limits broad searches to protect the context', async () => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src/many.txt'), Array.from({ length: 80 }, (_, index) => `hit ${index + 1}`).join('\n'))
    const found = await tool('search').run({ pattern: 'hit', path: 'src' }, signal)
    expect(found.content.split('\n').filter((line) => line.startsWith('src/many.txt:')).length).toBe(50)
    expect(found.content).toContain('[Limite de 50 resultados atingido]')
  })

  it('reports a missing file without throwing', async () => {
    expect(await tool('read_file').run({ path: 'nao.txt' }, signal)).toEqual({ content: 'Arquivo ou pasta não encontrado.', isError: true })
  })

  it('recognizes files that usually hold secrets', () => {
    for (const file of ['.env', '.env.local', 'a/.env.production', 'servidor.pem', 'chave.key', 'id_rsa', 'config/secrets.yml', '.npmrc']) {
      expect(isSensitivePath(file), file).toBe(true)
    }
    for (const file of ['.env.example', '.env.sample', 'envelope.ts', 'keyboard.ts', 'README.md']) {
      expect(isSensitivePath(file), file).toBe(false)
    }
  })
})

describe('projeto', () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })

  it('resolves any folder inside a repository to its root', async () => {
    git('init', '-q')
    await mkdir(path.join(root, 'src', 'interno'), { recursive: true })
    expect(await resolveProjectRoot(path.join(root, 'src', 'interno'))).toBe(path.resolve(root))
    expect(await resolveProjectRoot(root)).toBe(path.resolve(root))
  })

  it('accepts worktrees and submodules, where .git is a file', async () => {
    await mkdir(path.join(root, 'sub'))
    await writeFile(path.join(root, '.git'), 'gitdir: ../outro/.git/worktrees/x')
    expect(await resolveProjectRoot(path.join(root, 'sub'))).toBe(path.resolve(root))
  })

  it('accepts a folder without Git as it is, and refuses one that does not exist', async () => {
    await mkdir(path.join(root, 'sem-git'))
    expect(await resolveProjectRoot(path.join(root, 'sem-git'))).toBe(path.resolve(root, 'sem-git'))
    await expect(resolveProjectRoot(path.join(root, 'nao-existe'))).rejects.toThrow('A pasta não existe')
  })

  it('describes a project without Git too', async () => {
    await writeFile(path.join(root, 'a.txt'), '')
    const description = await describeProject(root)
    expect(description).toContain('a.txt')
    expect(description).not.toContain('Branch')
  })

  it('removes credentials from remote addresses', () => {
    expect(withoutCredentials('https://usuario:ghp_segredo@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(withoutCredentials('https://ghp_segredo@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(withoutCredentials('https://github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(withoutCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
  })

  it('describes the project: branch, origin, files and README, with no credentials', async () => {
    git('init', '-q', '-b', 'principal')
    git('remote', 'add', 'origin', 'https://usuario:ghp_segredo@github.com/a/b.git')
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, 'node_modules', 'pacote'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'conteudo-do-codigo')
    await writeFile(path.join(root, 'README.md'), '# Meu projeto\nExplicação.')

    const description = await describeProject(root)
    expect(description).toContain('Branch when this conversation started: principal')
    expect(description).toContain('Origin: https://github.com/a/b.git')
    expect(description).not.toContain('ghp_segredo')
    expect(description).toContain('src/a.ts')
    expect(description).toContain('README.md')
    expect(description).toContain('# Meu projeto')
    // Names only, and nothing from inside dependency folders or .git.
    expect(description).not.toContain('conteudo-do-codigo')
    expect(description).toContain('node_modules/')
    expect(description).not.toContain('node_modules/pacote')
    expect(description).not.toContain('.git/')
  })

  it('keeps the description to a bounded size on a huge project', async () => {
    await mkdir(path.join(root, 'muitos'))
    await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(path.join(root, 'muitos', `arquivo-${index}.txt`), '')))
    await writeFile(path.join(root, 'README.md'), 'x'.repeat(50_000))
    const description = await describeProject(root)
    expect((description.match(/arquivo-/g) ?? []).length).toBeLessThanOrEqual(150)
    expect(description.length).toBeLessThan(20_000)
  })

  it('reaches every model through the system prompt', async () => {
    await writeFile(path.join(root, 'README.md'), 'Contexto geral do projeto.')
    const { system } = await buildSystemPrompt(root, '')
    expect(system).toContain('Contexto geral do projeto.')
    expect(system).toContain(`<project name="${path.basename(root)}">`)
  })
})

describe('comandos', () => {
  it('runs a command and returns its output and accents intact', async () => {
    const result = await tool('run_command').run({ command: 'echo "olá mundo"' }, signal)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('olá mundo')
  }, 20_000)

  it('reports a failing exit code', async () => {
    const result = await tool('run_command').run({ command: 'exit 3' }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('3')
  }, 20_000)

  it('does not expose API keys from the app environment to commands', async () => {
    process.env.TESTE_CLAUDIO_API_KEY = 'vazou'
    const command = process.platform === 'win32' ? 'echo "[$env:TESTE_CLAUDIO_API_KEY]"' : 'echo "[$TESTE_CLAUDIO_API_KEY]"'
    const result = await tool('run_command').run({ command }, signal)
    delete process.env.TESTE_CLAUDIO_API_KEY
    expect(result.content).not.toContain('vazou')
  }, 20_000)

  it('never starts a command whose signal was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const command = process.platform === 'win32' ? 'Set-Content cancelado.txt executou' : 'echo executou > cancelado.txt'
    const result = await tool('run_command').run({ command }, controller.signal)
    expect(result).toEqual({ content: 'Cancelado pelo usuário.', isError: true })
    await expect(readFile(path.join(root, 'cancelado.txt'))).rejects.toThrow()
  })

  it('stops a command when interrupted', async () => {
    const controller = new AbortController()
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const started = Date.now()
    const running = tool('run_command').run({ command }, controller.signal)
    setTimeout(() => controller.abort(), 1500)
    const result = await running
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cancelado')
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 25_000)

  it('enforces its time limit', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const result = await tool('run_command').run({ command, timeout_ms: 1500 }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Tempo esgotado')
  }, 25_000)
})

describe('permissões', () => {
  it('keeps local automatic rules, bypass protection, and planning restrictions explicit', () => {
    expect(permissionFor('write', 'auto', false)).toBe('allow')
    expect(permissionFor('exec', 'auto', false)).toBe('ask')
    expect(permissionFor('external', 'auto', false)).toBe('ask')
    for (const risk of ['read', 'write', 'exec', 'external'] as const) {
      expect(permissionFor(risk, 'bypass', false)).toBe('allow')
    }
    expect(permissionFor('sensitive', 'bypass', true)).toBe('ask')
    for (const risk of ['write', 'exec', 'external'] as const) {
      expect(permissionFor(risk, 'plan', true)).toBe('deny')
      expect(permissionFor(risk, 'read-only', true)).toBe('deny')
    }
    expect(permissionFor('read', 'plan', false)).toBe('allow')
    expect(permissionFor('sensitive', 'plan', true)).toBe('ask')
  })

  it('follows the mode', () => {
    expect(permissionFor('read', 'read-only', false)).toBe('allow')
    expect(permissionFor('write', 'ask', false)).toBe('ask')
    expect(permissionFor('write', 'auto-edit', false)).toBe('allow')
    expect(permissionFor('exec', 'auto-edit', false)).toBe('ask')
    expect(permissionFor('external', 'auto-edit', false)).toBe('ask')
    expect(permissionFor('write', 'read-only', false)).toBe('deny')
    expect(permissionFor('sensitive', 'auto-edit', false)).toBe('ask')
    expect(permissionFor('sensitive', 'read-only', false)).toBe('ask')
    expect(permissionFor('exec', 'ask', true)).toBe('allow')
  })

  it('never lets an earlier "always" cover files that hold secrets', () => {
    expect(permissionFor('sensitive', 'ask', true)).toBe('ask')
    expect(permissionFor('sensitive', 'auto-edit', true)).toBe('ask')
  })
})

describe('tradução entre provedores', () => {
  it('maps tool ids deterministically to what each provider accepts', () => {
    expect(safeToolId('toolu_01abc')).toBe('toolu_01abc')
    const weird = safeToolId('fc.123:456/789')
    expect(weird).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(safeToolId('fc.123:456/789')).toBe(weird)
    expect(safeToolId('toolu_01abc', 'short')).toMatch(/^[a-zA-Z0-9]{9}$/)
    expect(safeToolId('x'.repeat(100))).toHaveLength(37)
  })

  it('reduces JSON Schema to the subset Gemini accepts', () => {
    expect(
      toGeminiSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: ['string', 'null'], default: 'x', description: 'd' },
          b: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { c: { const: 1 } } } }
        },
        required: ['a']
      })
    ).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true, description: 'd' },
        b: { type: 'array', items: { type: 'object', properties: { c: { enum: [1] } } } }
      },
      required: ['a']
    })
  })

  it('leaves a tool result in place when flattening', () => {
    const flat = flattenHistory([
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'oi' }], createdAt: 1 },
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'segredo do raciocínio' },
          { type: 'tool_call', id: 'c', name: 'read_file', input: { path: 'a' } }
        ],
        createdAt: 2,
        raw: { provider: 'p', model: 'm', data: [] }
      },
      { id: '3', role: 'tool', parts: [{ type: 'tool_result', callId: 'c', name: 'read_file', content: 'x'.repeat(5000) }], createdAt: 3 }
    ])
    expect(flat.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(flat)).not.toContain('segredo do raciocínio')
    expect(flat[1].raw).toBeUndefined()
    expect(JSON.stringify(flat[2])).toContain('omitidos')
  })

  it('removes refused turns from context', () => {
    const context = contextOf([
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'oi' }], createdAt: 1 },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'não' }], createdAt: 2, excluded: true }
    ])
    expect(context).toHaveLength(1)
  })
})

describe('recursos da Anthropic', () => {
  const request = (model: Partial<ModelInfo> & { id: string }) =>
    ({
      model: { provider: 'anthropic', providerName: 'Anthropic', label: model.id, ...model },
      system: 's',
      messages: [],
      tools: [],
      replayRaw: true,
      signal
    }) as Parameters<typeof buildAnthropicRequest>[0]

  it('enables refusal fallback only for supported models on the official endpoint', () => {
    const official = buildAnthropicRequest(request({ id: 'claude-opus-5-5', thinking: true }), true) as any
    expect(official.fallbacks).toBe('default')
    expect(official.betas).toEqual(['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01'])

    expect((buildAnthropicRequest(request({ id: 'claude-opus-5-5' }), false) as any).fallbacks).toBeUndefined()
    expect((buildAnthropicRequest(request({ id: 'claude-haiku-5-5' }), true) as any).fallbacks).toBeUndefined()
  })

  it('sends only what the model says it supports', () => {
    const plain = buildAnthropicRequest(request({ id: 'modelo-desconhecido' }), true) as any
    expect(plain.thinking).toBeUndefined()
    expect(plain.output_config).toBeUndefined()
    expect(plain.betas).toBeUndefined()
    expect(plain.max_tokens).toBe(8192)
    expect(buildAnthropicRequest(request({ id: 'x', maxOutput: 128000 }), true).max_tokens).toBe(64000)
  })
})

describe('descoberta de modelos', () => {
  it('reads each provider’s own list and keeps only text models', async () => {
    const llm = await startMockLlm()
    try {
      const base = { official: false, apiKey: 'k' }
      const list = async (id: string, protocol: Parameters<typeof createAdapter>[0]['protocol'], baseUrl: string) =>
        createAdapter({ id, name: id, protocol, baseUrl, ...base }).listModels()

      const anthropic = await list('a', 'anthropic', `${llm.url}/anthropic`)
      expect(anthropic[0]).toMatchObject({ id: 'claude-mock', label: 'Claude Simulado', thinking: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], maxOutput: 32000 })

      const openai = await list('o', 'openai-responses', `${llm.url}/openai/v1`)
      expect(openai.map((model) => model.id)).toEqual(['gpt-mock'])

      const gemini = await list('g', 'gemini', `${llm.url}/gemini`)
      expect(gemini[0]).toMatchObject({ id: 'gemini-mock', label: 'Gemini Simulado', maxOutput: 8000 })

      const compat = await list('c', 'openai-chat', `${llm.url}/compat/v1`)
      expect(compat.map((model) => model.id)).toContain('chat-mock')
    } finally {
      await llm.close()
    }
  })
})

describe('MCP', () => {
  const FIXTURE = path.resolve('tests/fixtures/mcp-server.mjs')

  it('parses the common config format', () => {
    const servers = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'abc' } },
          remoto: { url: 'https://exemplo.com/mcp', headers: { Authorization: 'Bearer y' } }
        }
      })
    )
    expect(servers[0]).toMatchObject({ name: 'local', transport: 'stdio', command: 'npx', env: { TOKEN: 'abc' } })
    expect(servers[1]).toMatchObject({ name: 'remoto', transport: 'http', url: 'https://exemplo.com/mcp' })
    expect(() => parseMcpJson('{')).toThrow('JSON inválido')
    expect(() => parseMcpJson('{}')).toThrow('mcpServers')
    expect(() => parseMcpJson('{"mcpServers":{"a":{}}}')).toThrow('command')
    expect(() => parseMcpJson('{"mcpServers":{"a":{"url":"file:///etc/passwd"}}}')).toThrow('command')
  })

  it('names tools within every provider’s limits', () => {
    expect(mcpToolName('git hub', 'criar.issue')).toBe('mcp__git_hub__criar_issue')
    const long = mcpToolName('s'.repeat(40), 't'.repeat(40))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).not.toBe(mcpToolName('s'.repeat(40), `${'t'.repeat(39)}u`))
  })

  it('connects to a real server over stdio, lists and calls its tools', async () => {
    const changes: string[] = []
    const manager = new McpManager((servers) => changes.push(servers[0]?.status ?? 'none'))
    manager.connect({ name: 'teste', transport: 'stdio', command: process.execPath, args: [FIXTURE] })
    await expect.poll(() => manager.status()[0].status, { timeout: 15_000 }).toBe('connected')

    const soma = manager.tools().find((entry) => entry.name === 'mcp__teste__somar')!
    expect(soma.risk({})).toBe('external')
    expect(soma.schema.type).toBe('object')
    expect(await soma.run({ a: 2, b: 3 }, signal)).toEqual({ content: '5', isError: false })

    const falha = manager.tools().find((entry) => entry.name === 'mcp__teste__falhar')!
    expect(await falha.run({}, signal)).toEqual({ content: 'falhou de propósito', isError: true })

    await manager.remove('teste')
    expect(manager.tools()).toEqual([])
    expect(changes).toContain('connected')
  }, 25_000)

  it('reports a server that cannot start, without affecting others', async () => {
    const manager = new McpManager(() => undefined)
    manager.connect({ name: 'quebrado', transport: 'stdio', command: 'comando-que-nao-existe-xyz', args: [] })
    await expect.poll(() => manager.status()[0].status, { timeout: 15_000 }).toBe('error')
    expect(manager.status()[0].error).toBeTruthy()
    expect(manager.tools()).toEqual([])
    await manager.closeAll()
  }, 25_000)

  it('does not expose secret values in its status', async () => {
    const manager = new McpManager(() => undefined)
    manager.connect({ name: 'x', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer segredo' } })
    const status = manager.status()[0]
    expect(JSON.stringify(status)).not.toContain('segredo')
    expect(status.secretNames).toEqual(['Authorization'])
    await manager.closeAll()
  })
})

describe('armazenamento', () => {
  const vault: Vault = {
    encrypt: async (text) => `cifrado:${Buffer.from(text).toString('base64')}`,
    decrypt: async (data) => Buffer.from(data.replace('cifrado:', ''), 'base64').toString()
  }

  it('defaults old preferences to the system theme and persists a manual choice', async () => {
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ prefs: { memory: 'old memory' } }))
    const store = new SettingsStore(root, vault, {})
    await store.load()
    expect(store.prefs().theme).toBe('system')
    expect(store.prefs().memory).toBe('old memory')
    expect(store.prefs().autoModel).toBe(true)
    expect(store.prefs().economyMode).toBe(true)
    expect(store.prefs().warnCostUsd).toBe(1)
    await store.setPrefs({ theme: 'dark' })
    const reopened = new SettingsStore(root, vault, {})
    await reopened.load()
    expect(reopened.prefs().theme).toBe('dark')
  })

  it('encrypts keys on disk and never lists them', async () => {
    const store = new SettingsStore(root, vault, {})
    await store.setKey('anthropic', 'sk-segredo')
    const disk = await readFile(path.join(root, 'settings.json'), 'utf8')
    expect(disk).not.toContain('sk-segredo')
    expect(JSON.stringify((await store.providers()))).not.toContain('sk-segredo')
    expect((await store.providers()).find((provider) => provider.id === 'anthropic')?.keySource).toBe('saved')

    const reopened = new SettingsStore(root, vault, {})
    await reopened.load()
    expect((await reopened.connection('anthropic'))?.apiKey).toBe('sk-segredo')
  })

  it('never sends an environment key to a custom endpoint', async () => {
    const store = new SettingsStore(root, vault, { OPENAI_API_KEY: 'do-ambiente' })
    expect((await store.connection('openai'))?.apiKey).toBe('do-ambiente')
    expect((await store.providers()).find((provider) => provider.id === 'openai')?.keySource).toBe('env')
    await store.setBaseUrl('openai', 'https://outro.exemplo.com/v1')
    expect((await store.connection('openai'))?.apiKey).toBeNull()
    expect((await store.connection('openai'))?.official).toBe(false)
  })

  it('stores MCP secrets encrypted', async () => {
    const store = new SettingsStore(root, vault, {})
    await store.setMcpServers(parseMcpJson('{"mcpServers":{"a":{"command":"x","env":{"TOKEN":"segredo-mcp"}}}}'))
    expect(await readFile(path.join(root, 'settings.json'), 'utf8')).not.toContain('segredo-mcp')
    expect((await store.mcpServers())[0].env).toEqual({ TOKEN: 'segredo-mcp' })
  })

  it('adds and removes custom providers', async () => {
    const store = new SettingsStore(root, vault, {})
    await expect(store.addCustom({ name: 'x', protocol: 'openai-chat', baseUrl: 'ftp://y' })).rejects.toThrow('http')
    await store.addCustom({ name: 'Meu', protocol: 'openai-chat', baseUrl: 'https://y.com/v1/', key: 'k' })
    const custom = (await store.providers()).find((provider) => provider.custom)!
    expect(custom.baseUrl).toBe('https://y.com/v1')
    expect((await store.connection(custom.id))?.apiKey).toBe('k')
    await store.removeCustom(custom.id)
    expect((await store.connection(custom.id))).toBeNull()
  })

  it('persists threads and refuses ids that could escape its folder', async () => {
    const store = new ThreadStore(root)
    await store.load()
    const thread = await store.create(null, null)
    thread.title = 'Título'
    await store.save(thread)

    const reopened = new ThreadStore(root)
    await reopened.load()
    expect(reopened.list()[0]).toMatchObject({ id: thread.id, title: 'Título' })
    expect((await reopened.get(thread.id))?.title).toBe('Título')

    await expect(reopened.get('../../settings')).rejects.toThrow('inválido')
    await reopened.remove(thread.id)
    expect(reopened.list()).toEqual([])
    expect(await reopened.get(thread.id)).toBeNull()
  })

  it('does not bring back a conversation deleted while a run was ending', async () => {
    const store = new ThreadStore(root)
    await store.load()
    const thread = await store.create(null, null)
    await store.remove(thread.id)
    await store.save(thread)
    const reopened = new ThreadStore(root)
    await reopened.load()
    expect(reopened.list()).toEqual([])
  })

  it('survives a corrupt thread file', async () => {
    const store = new ThreadStore(root)
    await store.load()
    await writeFile(path.join(root, 'threads', 'quebrado.json'), '{ nao é json')
    const reopened = new ThreadStore(root)
    await expect(reopened.load()).resolves.toBeUndefined()
    expect(reopened.list()).toEqual([])
  })
})
