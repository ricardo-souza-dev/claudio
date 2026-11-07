import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { GitAction, GitBranch, GitCommit, GitFile, GitStatus, PrListing, ProjectFile, ProjectRepos, PullRequest, RepoRef } from '../shared/types'
import { isSensitivePath, resolveInside, SKIPPED_DIRS, walk } from './tools/builtin'

export interface ChangesForMessage {
  staged: boolean
  stat: string
  diff: string
  untracked: string[]
  /** Changed files whose contents aren't sent, because they usually hold secrets. */
  omitted: string[]
  recent: string[]
}

const RECENT_SUBJECTS = 10
const NEW_FILES_SHOWN = 10
const NEW_FILE_CHARS = 8000
const MAX_REPOS = 50
const NESTED_SCAN_DEPTH = 3
const LOCAL_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 120_000
const MAX_FILES_LISTED = 5000
const MAX_STATUS_ENTRIES = 2000
const MAX_DIFF_CHARS = 200_000
const MAX_READ_BYTES = 300_000
const RECENT_COMMITS = 15
const MAX_BUFFER = 32 * 1024 * 1024

interface RunOptions {
  timeout?: number
}

function run(command: string, args: string[], cwd: string, options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: options.timeout ?? LOCAL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // Without a terminal to answer on, a credentials prompt would otherwise hang until the timeout.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const code = (error as NodeJS.ErrnoException).code
        const detail = String(stderr).trim() || String(stdout).trim() || error.message
        reject(Object.assign(new Error(detail), { code }))
      }
    )
  })
}

/** Reads `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const result: ReturnType<typeof parseStatus> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    if (entry.startsWith('# branch.head ')) {
      const head = entry.slice('# branch.head '.length)
      result.branch = head === '(detached)' ? null : head
    } else if (entry.startsWith('# branch.upstream ')) {
      result.upstream = entry.slice('# branch.upstream '.length)
    } else if (entry.startsWith('# branch.ab ')) {
      const [ahead, behind] = entry.slice('# branch.ab '.length).split(' ')
      result.ahead = Math.abs(Number(ahead))
      result.behind = Math.abs(Number(behind))
    } else if (result.files.length >= MAX_STATUS_ENTRIES) {
      continue
    } else if (entry.startsWith('? ')) {
      result.files.push({ path: entry.slice(2), index: '.', worktree: '?', untracked: true })
    } else if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
      // The path is whatever follows a fixed number of space-separated fields, and may hold spaces.
      const fields = entry[0] === '1' ? 8 : entry[0] === '2' ? 9 : 10
      const pieces = entry.split(' ')
      const file: GitFile = { path: pieces.slice(fields).join(' '), index: pieces[1][0], worktree: pieces[1][1] }
      if (pieces[2]?.startsWith('S')) file.submodule = true
      if (entry[0] === 'u') file.conflicted = true
      if (entry[0] === '2') file.renamedFrom = entries[++i]
      result.files.push(file)
    }
  }
  return result
}

/**
 * Finds every repository in the project: the root, its submodules (at any depth), and
 * independent clones kept in subfolders, as in a workspace folder holding several projects.
 */
export async function discoverRepositories(root: string): Promise<ProjectRepos> {
  const found = new Map<string, RepoRef>()
  const uninitialized: string[] = []
  const add = (relative: string, kind: RepoRef['kind']): void => {
    if (!found.has(relative)) found.set(relative, { path: relative, name: path.basename(relative) || path.basename(root), kind })
  }

  if (await stat(path.join(root, '.git')).catch(() => null)) {
    add('', 'root')
    const output = await run('git', ['-C', root, 'submodule', 'status', '--recursive'], root).catch(() => '')
    for (const line of output.split('\n')) {
      // Each line: a state character, the commit, the path, and sometimes a description in parentheses.
      const match = /^(.)[0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line)
      if (!match) continue
      if (match[1] === '-') uninitialized.push(match[2])
      else add(match[2], 'submodule')
    }
  }

  const scan = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name) || found.size >= MAX_REPOS) continue
      const child = path.join(dir, entry.name)
      if (await stat(path.join(child, '.git')).catch(() => null)) {
        add(path.relative(root, child).replaceAll('\\', '/'), 'nested')
      } else if (depth < NESTED_SCAN_DEPTH) {
        await scan(child, depth + 1)
      }
    }
  }
  await scan(root, 1)

  const repos = [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
  return { repos, uninitializedSubmodules: uninitialized }
}

/** Everything the project panel does with Git, with arguments never passing through a shell. */
export class GitService {
  constructor(
    private root: string,
    private ghCommand: string[] = ['gh']
  ) {}

  private git(args: string[], options?: RunOptions): Promise<string> {
    return run('git', ['-C', this.root, ...args], this.root, options)
  }

  private gh(args: string[], options?: RunOptions): Promise<string> {
    const [command, ...prefix] = this.ghCommand
    return run(command, [...prefix, ...args], this.root, options)
  }

  private async isRepo(): Promise<boolean> {
    return this.git(['rev-parse', '--is-inside-work-tree'])
      .then((output) => output.trim() === 'true')
      .catch(() => false)
  }

  private async hasHead(): Promise<boolean> {
    return this.git(['rev-parse', '--verify', '-q', 'HEAD'])
      .then(() => true)
      .catch(() => false)
  }

  private async remoteName(): Promise<string | null> {
    const remotes = (await this.git(['remote']).catch(() => '')).split('\n').map((name) => name.trim()).filter(Boolean)
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null)
  }

  /**
   * Git enters each submodule to tell whether it has changes of its own, and one it can't read,
   * such as a submodule whose HEAD is missing, fails the whole status. Then submodules are
   * compared by commit only: each one has its own block in the panel, where its error shows.
   */
  private async porcelain(extra: string[] = []): Promise<string> {
    const args = ['status', '--porcelain=v2', '--branch', '-z', ...extra]
    return this.git(args).catch(() => this.git([...args, '--ignore-submodules=dirty']))
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo())) {
      return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, hasRemote: false, files: [], branches: [], commits: [] }
    }
    const [statusOutput, branches, commits, remote] = await Promise.all([
      this.porcelain(['--untracked-files=all']),
      this.branches(),
      this.commits(),
      this.remoteName()
    ])
    return { isRepo: true, ...parseStatus(statusOutput), hasRemote: remote !== null, branches, commits }
  }

  private async branches(): Promise<GitBranch[]> {
    const output = await this.git(['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(HEAD)', 'refs/heads', 'refs/remotes']).catch(() => '')
    const all: GitBranch[] = []
    for (const line of output.split('\n')) {
      const [ref, name, head] = line.split('\0')
      if (!ref || ref.endsWith('/HEAD')) continue
      all.push({ name, current: head === '*', remote: ref.startsWith('refs/remotes/') })
    }
    // A remote branch that already exists locally would only be noise in the list.
    const local = new Set(all.filter((branch) => !branch.remote).map((branch) => branch.name))
    return all.filter((branch) => !branch.remote || !local.has(branch.name.split('/').slice(1).join('/')))
  }

  private async commits(): Promise<GitCommit[]> {
    const output = await this.git(['log', `-n${RECENT_COMMITS}`, '--format=%h%x00%s%x00%an%x00%at']).catch(() => '')
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, at] = line.split('\0')
        return { hash, subject, author, at: Number(at) }
      })
  }

  async diff(file: string, staged: boolean): Promise<string> {
    const absolute = await resolveInside(this.root, file)
    const output = await this.git(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file])
    if (output) return output.length > MAX_DIFF_CHARS ? `${output.slice(0, MAX_DIFF_CHARS)}\n[… diff cortado]` : output
    // An untracked file has no diff yet: show all of it as new.
    const content = await this.readAbsolute(absolute).catch(() => null)
    if (!content) return ''
    if (content.binary) return 'Arquivo binário.'
    return content.text.split(/\r?\n/).map((line) => `+${line}`).join('\n')
  }

  /**
   * What a model reads to write the commit message: what is staged, or everything when
   * nothing is. Files that usually hold secrets are named but their contents never leave.
   */
  async changesForMessage(): Promise<ChangesForMessage> {
    const names = async (args: string[]): Promise<string[]> => (await this.git(args)).split('\0').filter(Boolean)
    const stagedNames = await names(['diff', '--cached', '--name-only', '-z'])
    const staged = stagedNames.length > 0
    const changedNames = staged ? stagedNames : await names(['diff', '--name-only', '-z'])
    const newFiles = staged ? [] : await names(['ls-files', '-o', '--exclude-standard', '-z'])
    if (changedNames.length === 0 && newFiles.length === 0) throw new Error('Não há alterações para descrever.')

    const omitted = [...changedNames, ...newFiles].filter(isSensitivePath)
    const base = ['diff', '--no-color', ...(staged ? ['--cached'] : [])]
    const pathspec = ['--', '.', ...omitted.map((file) => `:(exclude,literal)${file}`)]
    const [stat, diff, log] = await Promise.all([
      this.git([...base, '--stat', ...pathspec]),
      this.git([...base, ...pathspec]),
      this.git(['log', `-n${RECENT_SUBJECTS}`, '--format=%s']).catch(() => '')
    ])

    // New files have no diff, so the first few are shown whole.
    const untracked = newFiles.filter((file) => !isSensitivePath(file))
    let shown = diff
    for (const file of untracked.slice(0, NEW_FILES_SHOWN)) {
      const content = await this.read(file).catch(() => null)
      if (content && !content.binary) shown += `\n--- /dev/null\n+++ ${file}\n${content.text.slice(0, NEW_FILE_CHARS)}\n`
    }
    return { staged, stat: stat.trim(), diff: shown.trim(), untracked, omitted, recent: log.split('\n').filter(Boolean) }
  }

  async act(action: GitAction): Promise<void> {
    switch (action.type) {
      case 'init':
        await this.git(['init'])
        return
      case 'init-submodules':
        await this.git(['submodule', 'update', '--init', '--recursive'], { timeout: NETWORK_TIMEOUT_MS })
        return
      case 'stage':
        await this.git(['add', '--', ...action.paths])
        return
      case 'unstage':
        if (await this.hasHead()) await this.git(['restore', '--staged', '--', ...action.paths])
        else await this.git(['rm', '--cached', '-q', '--', ...action.paths])
        return
      case 'discard':
        await this.discard(action.paths)
        return
      case 'commit':
        if (!action.message.trim()) throw new Error('Escreva o texto do commit.')
        await this.git(['commit', '-m', action.message])
        return
      case 'switch':
        await this.validateBranchName(action.branch)
        if ((await this.branches()).find((branch) => branch.name === action.branch)?.remote) {
          await this.git(['switch', '--track', action.branch])
        } else {
          await this.git(['switch', action.branch])
        }
        return
      case 'create-branch':
        await this.validateBranchName(action.branch)
        await this.git(['switch', '-c', action.branch])
        return
      case 'fetch':
        await this.git(['fetch', '--prune'], { timeout: NETWORK_TIMEOUT_MS })
        return
      case 'pull':
        // Fast-forward only: a merge the user didn't ask for is harder to undo than this error.
        await this.git(['pull', '--ff-only'], { timeout: NETWORK_TIMEOUT_MS })
        return
      case 'push':
        await this.push()
        return
      case 'sync':
        await this.sync()
        return
    }
  }

  /**
   * One click to be even with the remote: fetch, bring new commits by fast-forward, then send
   * local ones. When both sides have new commits it stops and says so, because choosing between
   * merge and rebase belongs to the person.
   */
  private async sync(): Promise<void> {
    if (!parseStatus(await this.porcelain()).upstream) {
      await this.push()
      return
    }
    await this.git(['fetch', '--prune'], { timeout: NETWORK_TIMEOUT_MS })
    const { upstream, ahead, behind } = parseStatus(await this.porcelain())
    const commits = (count: number): string => (count === 1 ? '1 commit' : `${count} commits`)
    if (ahead > 0 && behind > 0) {
      throw new Error(`Esta branch e ${upstream} divergiram: há ${commits(behind)} novo no remoto e ${commits(ahead)} aqui. Escolha entre merge e rebase no terminal e sincronize de novo.`)
    }
    if (behind > 0) await this.git(['pull', '--ff-only'], { timeout: NETWORK_TIMEOUT_MS })
    if (ahead > 0) await this.git(['push'], { timeout: NETWORK_TIMEOUT_MS })
  }

  private async validateBranchName(name: string): Promise<void> {
    await this.git(['check-ref-format', '--branch', name]).catch(() => {
      throw new Error(`Nome de branch inválido: ${name}`)
    })
  }

  private async discard(paths: string[]): Promise<void> {
    const files = parseStatus(await this.porcelain(['--untracked-files=all'])).files
    for (const file of paths) {
      const entry = files.find((candidate) => candidate.path === file)
      if (!entry) continue
      if (entry.untracked) await this.git(['clean', '-f', '-q', '--', file])
      else if (entry.index === 'A') await this.git(['rm', '-f', '-q', '--', file])
      else await this.git(['restore', '--source=HEAD', '--staged', '--worktree', '--', file])
    }
  }

  /** Never forced: rewriting remote history is something to do on purpose, in a terminal. */
  private async push(): Promise<void> {
    const { upstream } = parseStatus(await this.porcelain())
    if (upstream) {
      await this.git(['push'], { timeout: NETWORK_TIMEOUT_MS })
      return
    }
    const remote = await this.remoteName()
    if (!remote) throw new Error('Este repositório não tem um remoto configurado.')
    await this.git(['push', '-u', remote, 'HEAD'], { timeout: NETWORK_TIMEOUT_MS })
  }

  async pullRequests(): Promise<PrListing> {
    try {
      const output = await this.gh(['pr', 'list', '--limit', '30', '--json', 'number,title,headRefName,url,author,isDraft,reviewDecision'], { timeout: NETWORK_TIMEOUT_MS })
      const list = JSON.parse(output) as {
        number: number
        title: string
        headRefName: string
        url: string
        author?: { login?: string }
        isDraft?: boolean
        reviewDecision?: string
      }[]
      const prs: PullRequest[] = list.map((entry) => ({
        number: entry.number,
        title: entry.title,
        branch: entry.headRefName,
        url: entry.url,
        author: entry.author?.login ?? '',
        draft: entry.isDraft === true,
        review: entry.reviewDecision || null
      }))
      return { available: true, prs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, prs: [] }
      return { available: true, prs: [], error: (error as Error).message }
    }
  }

  /** The branch has to be on the remote first, and `gh` can't ask about that without a terminal. */
  async createPullRequest(input: { title: string; body: string }): Promise<string> {
    if (!input.title.trim()) throw new Error('Dê um título ao PR.')
    await this.push()
    const output = await this.gh(['pr', 'create', '--title', input.title, '--body', input.body], { timeout: NETWORK_TIMEOUT_MS })
    return output.trim().split('\n').at(-1) ?? ''
  }

  async checkoutPullRequest(number: number): Promise<void> {
    await this.gh(['pr', 'checkout', String(number)], { timeout: NETWORK_TIMEOUT_MS })
  }

  /** Project-relative paths with forward slashes. In a repository, follows its .gitignore. */
  async listFiles(): Promise<string[]> {
    if (!(await stat(path.join(this.root, '.git')).catch(() => null))) {
      const files: string[] = []
      for await (const file of walk(this.root)) {
        files.push(path.relative(this.root, file).replaceAll('\\', '/'))
        if (files.length >= MAX_FILES_LISTED) break
      }
      return files.sort((a, b) => a.localeCompare(b))
    }
    const [tracked, untracked, { repos }] = await Promise.all([
      this.git(['ls-files', '-c', '-z', '--recurse-submodules']),
      this.git(['ls-files', '-o', '--exclude-standard', '-z']),
      discoverRepositories(this.root)
    ])
    // A clone in a subfolder shows up here as a single "folder/" entry: its files come from it instead.
    const files = [...tracked.split('\0'), ...untracked.split('\0')].filter((file) => file && !file.endsWith('/'))
    for (const repo of repos.filter((entry) => entry.kind === 'nested')) {
      const inner = await new GitService(path.join(this.root, repo.path), this.ghCommand).listFiles().catch(() => [])
      files.push(...inner.map((file) => `${repo.path}/${file}`))
    }
    return [...new Set(files)].slice(0, MAX_FILES_LISTED).sort((a, b) => a.localeCompare(b))
  }

  async read(file: string): Promise<ProjectFile> {
    const absolute = await resolveInside(this.root, file)
    // A submodule that was never downloaded is listed like a file, but on disk it's an empty folder.
    if ((await stat(absolute)).isDirectory()) throw new Error('Isto é uma pasta, provavelmente um submódulo que ainda não foi baixado. Para ver os arquivos dele, rode: git submodule update --init')
    return this.readAbsolute(absolute)
  }

  private async readAbsolute(absolute: string): Promise<ProjectFile> {
    const buffer = await readFile(absolute)
    if (buffer.subarray(0, 8000).includes(0)) return { text: '', truncated: false, binary: true }
    const truncated = buffer.length > MAX_READ_BYTES
    return { text: buffer.subarray(0, MAX_READ_BYTES).toString('utf8'), truncated, binary: false }
  }
}
