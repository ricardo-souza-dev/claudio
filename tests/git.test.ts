import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverRepositories, GitService, parseStatus } from '../src/main/git'

const FAKE_GH = [process.execPath, path.resolve('tests/fixtures/fake-gh.mjs')]

let root: string
let remoteRoot: string | null = null
let service: GitService

const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const fileOf = async (name: string) => (await service.status()).files.find((file) => file.path === name)

async function commitBase(): Promise<void> {
  git('init', '-q', '-b', 'principal')
  git('config', 'user.name', 'Teste')
  git('config', 'user.email', 'teste@example.com')
  git('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(root, 'README.md'), 'um\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Primeiro commit')
}

async function addRemote(): Promise<void> {
  remoteRoot = await mkdtemp(path.join(tmpdir(), 'uni-git-remoto-'))
  execFileSync('git', ['init', '-q', '--bare', remoteRoot])
  git('remote', 'add', 'origin', remoteRoot)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'uni-git-'))
  service = new GitService(root, FAKE_GH)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  if (remoteRoot) await rm(remoteRoot, { recursive: true, force: true }).catch(() => undefined)
  remoteRoot = null
})

describe('leitura do status', () => {
  it('understands every kind of entry, including paths with spaces', () => {
    const output = [
      '# branch.oid abc',
      '# branch.head principal',
      '# branch.upstream origin/principal',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a b src/com espaco.ts',
      '1 A. N... 000000 100644 100644 0 b novo.ts',
      '2 R. N... 100644 100644 100644 a b R100 depois.ts',
      'antes.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflito.ts',
      '? solto.txt',
      ''
    ].join('\0')
    const status = parseStatus(output)
    expect(status).toMatchObject({ branch: 'principal', upstream: 'origin/principal', ahead: 2, behind: 1 })
    expect(status.files).toEqual([
      { path: 'src/com espaco.ts', index: '.', worktree: 'M' },
      { path: 'novo.ts', index: 'A', worktree: '.' },
      { path: 'depois.ts', index: 'R', worktree: '.', renamedFrom: 'antes.ts' },
      { path: 'conflito.ts', index: 'U', worktree: 'U', conflicted: true },
      { path: 'solto.txt', index: '.', worktree: '?', untracked: true }
    ])
  })

  it('reports a detached HEAD as no branch', () => {
    expect(parseStatus('# branch.head (detached)\0').branch).toBeNull()
  })
})

describe('projeto sem Git', () => {
  it('reports it, lists files without dependency folders, and can start a repository', async () => {
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'x', 'y.js'), '')
    await writeFile(path.join(root, 'a.txt'), 'oi')
    expect((await service.status()).isRepo).toBe(false)
    expect(await service.listFiles()).toEqual(['a.txt'])

    await service.act({ type: 'init' })
    expect((await service.status()).isRepo).toBe(true)
  })
})

describe('alterações', () => {
  beforeEach(commitBase)

  it('follows a file from changed, to staged, to committed', async () => {
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await writeFile(path.join(root, 'novo.txt'), 'novo\n')
    expect(await fileOf('README.md')).toMatchObject({ index: '.', worktree: 'M' })
    expect(await fileOf('novo.txt')).toMatchObject({ untracked: true })

    await service.act({ type: 'stage', paths: ['README.md', 'novo.txt'] })
    expect(await fileOf('README.md')).toMatchObject({ index: 'M', worktree: '.' })
    expect(await fileOf('novo.txt')).toMatchObject({ index: 'A' })

    await service.act({ type: 'unstage', paths: ['novo.txt'] })
    expect(await fileOf('novo.txt')).toMatchObject({ untracked: true })

    await service.act({ type: 'commit', message: 'Muda o README' })
    const status = await service.status()
    expect(status.commits[0].subject).toBe('Muda o README')
    expect(status.commits[0].author).toBe('Teste')
    expect(status.files.map((file) => file.path)).toEqual(['novo.txt'])
  })

  it('shows diffs for changed, staged and brand-new files', async () => {
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await writeFile(path.join(root, 'novo.txt'), 'primeira\nsegunda')
    expect(await service.diff('README.md', false)).toContain('+dois')
    expect(await service.diff('novo.txt', false)).toBe('+primeira\n+segunda')
    await service.act({ type: 'stage', paths: ['README.md'] })
    expect(await service.diff('README.md', true)).toContain('-um')
    await expect(service.diff('../fora.txt', false)).rejects.toThrow('Fora da pasta')
  })

  it('discards changes of every kind', async () => {
    await writeFile(path.join(root, 'README.md'), 'alterado\n')
    await writeFile(path.join(root, 'solto.txt'), 'x')
    await writeFile(path.join(root, 'preparado.txt'), 'y')
    await service.act({ type: 'stage', paths: ['preparado.txt'] })
    await service.act({ type: 'discard', paths: ['README.md', 'solto.txt', 'preparado.txt'] })

    expect((await readFile(path.join(root, 'README.md'), 'utf8')).replaceAll('\r\n', '\n')).toBe('um\n')
    expect((await service.status()).files).toEqual([])
    await expect(readFile(path.join(root, 'solto.txt'))).rejects.toThrow()
    await expect(readFile(path.join(root, 'preparado.txt'))).rejects.toThrow()
  })

  it('refuses a commit with no message, and reports git errors', async () => {
    await expect(service.act({ type: 'commit', message: '   ' })).rejects.toThrow('Escreva o texto')
    await expect(service.act({ type: 'commit', message: 'nada preparado' })).rejects.toThrow()
  })

  it('unstages in a repository with no commits yet', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true })
    git('init', '-q')
    await writeFile(path.join(root, 'a.txt'), 'oi')
    await service.act({ type: 'stage', paths: ['a.txt'] })
    expect(await fileOf('a.txt')).toMatchObject({ index: 'A' })
    await service.act({ type: 'unstage', paths: ['a.txt'] })
    expect(await fileOf('a.txt')).toMatchObject({ untracked: true })
  })

  it('treats a path that looks like an option as a path', async () => {
    await writeFile(path.join(root, '--force'), 'x')
    await service.act({ type: 'stage', paths: ['--force'] })
    expect(await fileOf('--force')).toMatchObject({ index: 'A' })
  })

  it('lists tracked and new files, following .gitignore, and reads them', async () => {
    await writeFile(path.join(root, '.gitignore'), 'ignorado.txt\n')
    await writeFile(path.join(root, 'ignorado.txt'), 'x')
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'a.ts'), 'conteúdo')
    await writeFile(path.join(root, 'binario.bin'), Buffer.from([1, 0, 2]))
    const files = await service.listFiles()
    expect(files).toEqual(['.gitignore', 'binario.bin', 'README.md', 'src/a.ts'].sort((a, b) => a.localeCompare(b)))

    expect(await service.read('src/a.ts')).toEqual({ text: 'conteúdo', truncated: false, binary: false })
    expect((await service.read('binario.bin')).binary).toBe(true)
    await expect(service.read('../fora.txt')).rejects.toThrow('Fora da pasta')

    // A submodule that was never downloaded is an empty folder listed like a file.
    await mkdir(path.join(root, 'nao-baixado'))
    await expect(service.read('nao-baixado')).rejects.toThrow('git submodule update --init')
  })
})

describe('branches', () => {
  beforeEach(commitBase)

  it('creates and switches branches', async () => {
    await service.act({ type: 'create-branch', branch: 'recurso/novo' })
    let status = await service.status()
    expect(status.branch).toBe('recurso/novo')
    expect(status.branches.map((branch) => [branch.name, branch.current])).toEqual([
      ['principal', false],
      ['recurso/novo', true]
    ])
    await service.act({ type: 'switch', branch: 'principal' })
    status = await service.status()
    expect(status.branch).toBe('principal')
  })

  it('refuses names that git would not accept, or that look like options', async () => {
    await expect(service.act({ type: 'create-branch', branch: 'nome com espaço' })).rejects.toThrow('inválido')
    await expect(service.act({ type: 'create-branch', branch: '-f' })).rejects.toThrow('inválido')
    await expect(service.act({ type: 'switch', branch: '--detach' })).rejects.toThrow('inválido')
    expect((await service.status()).branch).toBe('principal')
  })

  it('reports why a switch failed, keeping the work in place', async () => {
    await service.act({ type: 'create-branch', branch: 'outra' })
    await writeFile(path.join(root, 'README.md'), 'na outra\n')
    await service.act({ type: 'stage', paths: ['README.md'] })
    await service.act({ type: 'commit', message: 'Na outra' })
    await service.act({ type: 'switch', branch: 'principal' })
    await writeFile(path.join(root, 'README.md'), 'em andamento\n')
    await expect(service.act({ type: 'switch', branch: 'outra' })).rejects.toThrow()
    expect((await readFile(path.join(root, 'README.md'), 'utf8')).replaceAll('\r\n', '\n')).toBe('em andamento\n')
  })
})

describe('remoto', () => {
  beforeEach(commitBase)

  it('explains when there is no remote', async () => {
    expect((await service.status()).hasRemote).toBe(false)
    await expect(service.act({ type: 'push' })).rejects.toThrow('não tem um remoto')
  })

  it('publishes a new branch, then pushes, pulls and fetches', async () => {
    await addRemote()
    let status = await service.status()
    expect(status.hasRemote).toBe(true)
    expect(status.upstream).toBeNull()

    await service.act({ type: 'push' })
    status = await service.status()
    expect(status.upstream).toBe('origin/principal')
    expect(status.ahead).toBe(0)

    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await service.act({ type: 'stage', paths: ['README.md'] })
    await service.act({ type: 'commit', message: 'Segundo' })
    expect((await service.status()).ahead).toBe(1)
    await service.act({ type: 'push' })
    expect((await service.status()).ahead).toBe(0)

    await service.act({ type: 'fetch' })
    await service.act({ type: 'pull' })
    expect((await service.status()).commits[0].subject).toBe('Segundo')
  })

  it('never forces a push over remote history', async () => {
    await addRemote()
    await service.act({ type: 'push' })
    await writeFile(path.join(root, 'README.md'), 'dois\n')
    await service.act({ type: 'stage', paths: ['README.md'] })
    await service.act({ type: 'commit', message: 'Remoto' })
    await service.act({ type: 'push' })

    git('reset', '-q', '--hard', 'HEAD~1')
    await writeFile(path.join(root, 'README.md'), 'divergente\n')
    await service.act({ type: 'stage', paths: ['README.md'] })
    await service.act({ type: 'commit', message: 'Divergente' })

    await expect(service.act({ type: 'push' })).rejects.toThrow()
    expect(execFileSync('git', ['-C', remoteRoot!, 'log', '-1', '--format=%s', 'principal'], { encoding: 'utf8' }).trim()).toBe('Remoto')
  })
})

describe('vários repositórios', () => {
  // Git refuses local paths for submodules unless told otherwise.
  const addSubmodule = (source: string, where: string) => git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, where)
  const sources: string[] = []

  async function makeSource(name: string): Promise<string> {
    const source = await mkdtemp(path.join(tmpdir(), `uni-git-${name}-`))
    sources.push(source)
    const inSource = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { stdio: 'ignore' })
    inSource('init', '-q', '-b', 'trunk')
    inSource('config', 'user.name', 'Teste')
    inSource('config', 'user.email', 'teste@example.com')
    inSource('config', 'commit.gpgsign', 'false')
    await writeFile(path.join(source, 'lib.txt'), 'biblioteca\n')
    inSource('add', '.')
    inSource('commit', '-q', '-m', 'Base da biblioteca')
    return source
  }

  afterEach(async () => {
    await Promise.all(sources.splice(0).map((source) => rm(source, { recursive: true, force: true }).catch(() => undefined)))
  })

  it('finds the root, its submodules and clones kept in subfolders', async () => {
    await commitBase()
    addSubmodule(await makeSource('sub'), 'libs/sub')
    git('commit', '-q', '-m', 'Adiciona submódulo')
    await mkdir(path.join(root, 'apps', 'clone'), { recursive: true })
    execFileSync('git', ['-C', path.join(root, 'apps', 'clone'), 'init', '-q'])
    await mkdir(path.join(root, 'node_modules', 'pacote'), { recursive: true })
    execFileSync('git', ['-C', path.join(root, 'node_modules', 'pacote'), 'init', '-q'])

    const { repos, uninitializedSubmodules } = await discoverRepositories(root)
    expect(repos.map(({ path: where, kind, name }) => [where, kind, name])).toEqual([
      ['', 'root', path.basename(root)],
      ['apps/clone', 'nested', 'clone'],
      ['libs/sub', 'submodule', 'sub']
    ])
    expect(uninitializedSubmodules).toEqual([])
  })

  it('finds repositories inside a folder that is not one itself, as in a workspace', async () => {
    for (const name of ['api', 'web']) {
      await mkdir(path.join(root, name))
      execFileSync('git', ['-C', path.join(root, name), 'init', '-q'])
    }
    await writeFile(path.join(root, 'api', 'a.ts'), '')
    await writeFile(path.join(root, 'solto.txt'), '')
    const { repos } = await discoverRepositories(root)
    expect(repos.map((repo) => [repo.path, repo.kind])).toEqual([
      ['api', 'nested'],
      ['web', 'nested']
    ])
    expect(await service.listFiles()).toEqual(expect.arrayContaining(['api/a.ts', 'solto.txt']))
  })

  it('finds nothing in a project without Git', async () => {
    await writeFile(path.join(root, 'a.txt'), '')
    expect(await discoverRepositories(root)).toEqual({ repos: [], uninitializedSubmodules: [] })
  })

  it('reports submodules not downloaded yet, and can download them', async () => {
    await commitBase()
    addSubmodule(await makeSource('sub'), 'libs/sub')
    git('commit', '-q', '-m', 'Adiciona submódulo')
    git('submodule', 'deinit', '-q', '-f', 'libs/sub')
    expect((await discoverRepositories(root)).uninitializedSubmodules).toEqual(['libs/sub'])

    git('config', 'protocol.file.allow', 'always')
    await service.act({ type: 'init-submodules' })
    const found = await discoverRepositories(root)
    expect(found.uninitializedSubmodules).toEqual([])
    expect(found.repos.map((repo) => repo.path)).toContain('libs/sub')
  })

  it('works inside a submodule on its own, and flags it in the parent', async () => {
    await commitBase()
    addSubmodule(await makeSource('sub'), 'libs/sub')
    git('commit', '-q', '-m', 'Adiciona submódulo')
    const inner = path.join(root, 'libs', 'sub')
    execFileSync('git', ['-C', inner, 'config', 'user.name', 'Teste'])
    execFileSync('git', ['-C', inner, 'config', 'user.email', 'teste@example.com'])
    execFileSync('git', ['-C', inner, 'config', 'commit.gpgsign', 'false'])
    const submodule = new GitService(inner, FAKE_GH)
    expect((await submodule.status()).branch).toBe('trunk')

    await writeFile(path.join(inner, 'lib.txt'), 'alterada\n')
    expect((await submodule.status()).files[0]).toMatchObject({ path: 'lib.txt', worktree: 'M' })
    expect((await service.status()).files[0]).toMatchObject({ path: 'libs/sub', submodule: true })

    await submodule.act({ type: 'stage', paths: ['lib.txt'] })
    await submodule.act({ type: 'commit', message: 'Muda a biblioteca' })
    expect((await submodule.status()).commits[0].subject).toBe('Muda a biblioteca')
    // The parent records the new commit as a change of its own.
    expect((await service.status()).files[0]).toMatchObject({ path: 'libs/sub', worktree: 'M', submodule: true })
    await service.act({ type: 'stage', paths: ['libs/sub'] })
    await service.act({ type: 'commit', message: 'Atualiza o submódulo' })
    expect((await service.status()).files).toEqual([])
  })

  it('lists files from submodules and clones without a stray folder entry', async () => {
    await commitBase()
    addSubmodule(await makeSource('sub'), 'libs/sub')
    git('commit', '-q', '-m', 'Adiciona submódulo')
    await mkdir(path.join(root, 'clone'))
    execFileSync('git', ['-C', path.join(root, 'clone'), 'init', '-q'])
    await writeFile(path.join(root, 'clone', 'c.txt'), '')
    const files = await service.listFiles()
    expect(files).toEqual(expect.arrayContaining(['README.md', 'libs/sub/lib.txt', 'clone/c.txt']))
    expect(files.some((file) => file.endsWith('/'))).toBe(false)
    expect(files).not.toContain('libs/sub')
  })
})

describe('pull requests', () => {
  beforeEach(commitBase)

  it('says when the GitHub CLI is not installed', async () => {
    const without = new GitService(root, ['comando-que-nao-existe-xyz'])
    expect(await without.pullRequests()).toEqual({ available: false, prs: [] })
  })

  it('lists open pull requests', async () => {
    const { prs, available } = await service.pullRequests()
    expect(available).toBe(true)
    expect(prs[0]).toEqual({ number: 42, title: 'Corrige o login', branch: 'corrige-login', url: 'https://github.com/a/b/pull/42', author: 'ana', draft: false, review: 'APPROVED' })
    expect(prs[1]).toMatchObject({ draft: true, review: null })
  })

  it('shows why listing failed, such as not being logged in', async () => {
    process.env.FAKE_GH_FAIL = '1'
    const listing = await service.pullRequests()
    delete process.env.FAKE_GH_FAIL
    expect(listing.available).toBe(true)
    expect(listing.error).toContain('gh auth login')
  })

  it('publishes the branch before creating a pull request', async () => {
    await addRemote()
    await service.act({ type: 'create-branch', branch: 'minha-pr' })
    const log = path.join(root, '..', `gh-${path.basename(root)}.log`)
    process.env.FAKE_GH_LOG = log
    const url = await service.createPullRequest({ title: 'Título com "aspas" e; ponto', body: 'Descrição' })
    delete process.env.FAKE_GH_LOG
    expect(url).toBe('https://github.com/a/b/pull/44')
    expect((await service.status()).upstream).toBe('origin/minha-pr')
    expect(JSON.parse((await readFile(log, 'utf8')).trim())).toEqual(['pr', 'create', '--title', 'Título com "aspas" e; ponto', '--body', 'Descrição'])
    await rm(log, { force: true })
  })

  it('refuses to create one without a title', async () => {
    await expect(service.createPullRequest({ title: ' ', body: '' })).rejects.toThrow('título')
  })
})
