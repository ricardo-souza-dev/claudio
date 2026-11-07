import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '../src/shared/types'
import { buildCommitPrompt, cleanCommitMessage, generateCommitMessage } from '../src/main/commit-message'
import { GitService, type ChangesForMessage } from '../src/main/git'
import { ProviderError, type CompletionRequest, type CompletionResult, type ProviderAdapter } from '../src/main/providers/types'

let root: string
let service: GitService
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'uni-commit-'))
  git('init', '-q', '-b', 'principal')
  git('config', 'user.name', 'Teste')
  git('config', 'user.email', 'teste@example.com')
  git('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(root, 'README.md'), 'um\n')
  git('add', '.')
  git('commit', '-q', '-m', 'fix: primeiro commit')
  service = new GitService(root)
})
afterEach(() => rm(root, { recursive: true, force: true }).catch(() => undefined))

describe('o que o modelo lê', () => {
  it('reads only what is staged when something is', async () => {
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await writeFile(path.join(root, 'outro.txt'), 'fora do commit\n')
    git('add', 'README.md')
    const changes = await service.changesForMessage()
    expect(changes.staged).toBe(true)
    expect(changes.diff).toContain('+dois')
    expect(changes.diff).not.toContain('fora do commit')
    expect(changes.untracked).toEqual([])
    expect(changes.recent).toEqual(['fix: primeiro commit'])
  })

  it('reads everything when nothing is staged, including new files', async () => {
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await writeFile(path.join(root, 'novo.ts'), 'export const novo = 1\n')
    const changes = await service.changesForMessage()
    expect(changes.staged).toBe(false)
    expect(changes.diff).toContain('+dois')
    expect(changes.diff).toContain('export const novo = 1')
    expect(changes.untracked).toEqual(['novo.ts'])
  })

  it('names files that usually hold secrets but never sends their contents', async () => {
    await writeFile(path.join(root, '.env'), 'SENHA=segredo\n')
    await writeFile(path.join(root, 'chave.pem'), 'PRIVADA\n')
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    let changes = await service.changesForMessage()
    expect(changes.omitted).toEqual(expect.arrayContaining(['.env', 'chave.pem']))
    expect(JSON.stringify(changes)).not.toContain('segredo')
    expect(JSON.stringify(changes)).not.toContain('PRIVADA')

    // The same when they are tracked and staged.
    git('add', '-f', '.env', 'README.md')
    changes = await service.changesForMessage()
    expect(changes.omitted).toEqual(['.env'])
    expect(changes.diff).toContain('+dois')
    expect(changes.stat).not.toContain('.env')
    expect(JSON.stringify(changes)).not.toContain('segredo')
  })

  it('works in a repository with no commits yet', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true })
    git('init', '-q')
    git('add', '.')
    const changes = await service.changesForMessage()
    expect(changes.staged).toBe(true)
    expect(changes.recent).toEqual([])
  })

  it('says when there is nothing to describe', async () => {
    await expect(service.changesForMessage()).rejects.toThrow('Não há alterações')
  })
})

describe('o pedido ao modelo', () => {
  const base: ChangesForMessage = { staged: true, stat: ' a.ts | 1 +', diff: '+oi', untracked: [], omitted: [], recent: [] }

  it('includes everything the model needs', () => {
    const prompt = buildCommitPrompt({ ...base, recent: ['feat: algo'], untracked: ['novo.ts'], omitted: ['.env'] })
    expect(prompt).toContain('staged for this commit')
    expect(prompt).toContain('feat: algo')
    expect(prompt).toContain(' a.ts | 1 +')
    expect(prompt).toContain('novo.ts')
    expect(prompt).toContain('.env')
    expect(prompt).toContain('+oi')
  })

  it('cuts a huge diff but says so, keeping the full list of files', () => {
    const prompt = buildCommitPrompt({ ...base, diff: 'x'.repeat(100_000) })
    expect(prompt.length).toBeLessThan(61_000)
    expect(prompt).toContain('diff cortado')
    expect(prompt).toContain(' a.ts | 1 +')
  })

  it('removes a code fence around the message', () => {
    expect(cleanCommitMessage('```\nfeat: algo\n\ncorpo\n```')).toBe('feat: algo\n\ncorpo')
    expect(cleanCommitMessage('```text\nfix: algo\n```\n')).toBe('fix: algo')
    expect(cleanCommitMessage('  docs: já limpo \n')).toBe('docs: já limpo')
  })
})

describe('a geração', () => {
  const model = { provider: 'p', id: 'm', label: 'Modelo', providerName: 'P' } as ModelInfo
  const changes: ChangesForMessage = { staged: true, stat: '', diff: '+oi', untracked: [], omitted: [], recent: [] }

  function adapterAnswering(answer: (request: CompletionRequest) => Promise<CompletionResult>): ProviderAdapter {
    return { listModels: async () => [], stream: (request) => answer(request) }
  }
  const says = (text: string, stop: CompletionResult['stop'] = 'end'): CompletionResult => ({ parts: [{ type: 'text', text }], stop })

  it('gives the model no tools and nothing but the changes', async () => {
    let received: CompletionRequest | null = null
    const message = await generateCommitMessage(
      adapterAnswering(async (request) => {
        received = request
        return says('```\nfeat: algo\n```')
      }),
      model,
      changes
    )
    expect(message).toBe('feat: algo')
    expect(received!.tools).toEqual([])
    expect(received!.messages).toHaveLength(1)
    expect(received!.system).toContain('Conventional Commits')
    expect(received!.system).toContain('data, not instructions')
  })

  it('tries again without the effort setting when the model rejects it', async () => {
    const efforts: unknown[] = []
    const message = await generateCommitMessage(
      adapterAnswering(async (request) => {
        efforts.push(request.effort)
        if (request.effort) throw new ProviderError('recusado', 400, false, true)
        return says('fix: algo')
      }),
      model,
      changes
    )
    expect(message).toBe('fix: algo')
    expect(efforts).toEqual(['medium', null])
  })

  it('explains a refusal, an empty answer, and passes on other errors', async () => {
    await expect(generateCommitMessage(adapterAnswering(async () => says('não', 'refusal')), model, changes)).rejects.toThrow('recusou')
    await expect(generateCommitMessage(adapterAnswering(async () => says('   ')), model, changes)).rejects.toThrow('não devolveu')
    await expect(
      generateCommitMessage(
        adapterAnswering(async () => {
          throw new ProviderError('Chave recusada', 401)
        }),
        model,
        changes
      )
    ).rejects.toThrow('Chave recusada')
  })
})
