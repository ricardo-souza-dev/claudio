import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

it('builds without electron-builder publishing and uploads only through the controlled draft step', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  const uploader = await readFile('scripts/upload-release.ps1', 'utf8')
  expect(workflow).toContain('electron-builder --win nsis --x64 --publish never')
  expect(workflow).not.toContain('--publish always')
  expect(workflow).toContain('run: ./scripts/upload-release.ps1')
  expect(uploader).toContain('if ($releases.Count -gt 1)')
  expect(uploader).toContain('if (!$release.draft -or $release.prerelease)')
  expect(uploader).toContain('if ($existing.Count -eq 1)')
  expect(uploader).not.toContain('--clobber')
})

// Exercise the real Windows PowerShell 5.1 parser and control flow, never GitHub or git pushes.
describe.skipIf(process.platform !== 'win32')('Windows release script', () => {
  let root: string
  let statePath: string
  let bin: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudio release test '))
    bin = path.join(root, 'bin')
    statePath = path.join(root, 'state.json')
    await mkdir(bin)
    await mkdir(path.join(root, '.github/workflows'), { recursive: true })
    await copyFile('build-project-win.ps1', path.join(root, 'build-project-win.ps1'))
    await copyFile('electron-builder.yml', path.join(root, 'electron-builder.yml'))
    await copyFile('.github/workflows/release.yml', path.join(root, '.github/workflows/release.yml'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.1' }))
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.1', packages: { '': { version: '0.1.1' } } }))
    const fixture = path.resolve('tests/fixtures/release-cli.cjs')
    for (const tool of ['git', 'npm', 'gh']) {
      await writeFile(path.join(bin, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${fixture}" ${tool} %*\r\n`)
    }
    await writeFile(statePath, JSON.stringify({ scenario: 'success' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  function run(extra: string[] = []) {
    const script = path.join(root, 'build-project-win.ps1').replaceAll("'", "''")
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -Version 1.0.1 -Confirm:$false ${extra.join(' ')}`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDIO_RELEASE_TEST_STATE: statePath }
    })
    return { status: result.status, text: `${result.stdout}\n${result.stderr}` }
  }
  async function calls(): Promise<string[][]> {
    const text = await readFile(`${statePath}.calls`, 'utf8').catch(() => '')
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : []
  }
  async function scenario(name: string, resume = false) {
    await writeFile(statePath, JSON.stringify({ scenario: name, resume }))
  }

  it('WhatIf changes nothing and never invokes git, npm or gh', async () => {
    const result = run(['-Publish', '-WhatIf'])
    expect(result.status, result.text).toBe(0)
    expect(result.text).toContain('What if:')
    expect(await calls()).toEqual([])
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
  })

  it('builds a verified draft by default and pushes main + tag atomically, without force', async () => {
    const result = run()
    expect(result.status, result.text).toBe(0)
    const log = await calls()
    expect(log).toContainEqual(['npm', 'version', '1.0.1', '--no-git-tag-version', '--ignore-scripts'])
    expect(log).toContainEqual(['git', 'commit', '--only', '-m', 'chore: release 1.0.1', '--', 'package.json', 'package-lock.json'])
    expect(log).toContainEqual(['git', 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.0.1:refs/tags/v1.0.1'])
    expect(log.some((args) => args.includes('--force'))).toBe(false)
    expect(log.some((args) => args[0] === 'gh' && args[1] === 'release' && args[2] === 'edit')).toBe(false)
    expect(await readFile(path.join(root, 'dist/releases/v1.0.1/latest.yml'), 'utf8')).toContain('version: 1.0.1')
    expect(result.text).toContain('Nada foi publicado')
  })

  it('publishes only with Publish and generates release notes after validating assets', async () => {
    const result = run(['-Publish'])
    expect(result.status, result.text).toBe(0)
    const log = await calls()
    const publish = log.find((args) => args[0] === 'gh' && args[1] === 'release' && args[2] === 'edit')!
    expect(publish).toContain('--draft=false')
    expect(publish).toContain('--prerelease=false')
    expect(publish).toContain('--latest')
    expect(publish).toContain('--notes-file')
    expect(JSON.parse(await readFile(statePath, 'utf8')).published).toBe(true)
  })

  it('uses reviewed UTF-8 release notes instead of generating replacements', async () => {
    const notesFile = path.join(root, 'reviewed notes.md')
    await writeFile(notesFile, '## Novidades\nTerminal integrado e correções.')
    const result = run(['-Publish', '-NotesFile', `'${notesFile.replaceAll("'", "''")}'`])
    expect(result.status, result.text).toBe(0)
    expect(JSON.parse(await readFile(statePath, 'utf8')).notes).toContain('correções')
    expect((await calls()).some((args) => args[0] === 'gh' && args[1] === 'api')).toBe(false)
  })

  it('rejects mismatched lockfile versions before invoking release commands', async () => {
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.1', packages: { '': { version: '0.1.0' } } }))
    const result = run()
    expect(result.status, result.text).not.toBe(0)
    expect(await calls()).toEqual([])
  })

  it('resumes an existing draft without bumping, committing, tagging or pushing again', async () => {
    await scenario('success', true)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }))
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1', packages: { '': { version: '1.0.1' } } }))
    const result = run(['-Resume', '-Publish'])
    expect(result.status, result.text).toBe(0)
    const log = await calls()
    expect(log.some((args) => args[0] === 'npm')).toBe(false)
    expect(log.some((args) => args[0] === 'git' && ['push', 'commit', 'add'].includes(args[1]))).toBe(false)
    expect(JSON.parse(await readFile(statePath, 'utf8')).published).toBe(true)
  })

  it.each(['dirty', 'branch', 'origin', 'auth', 'remote-tag', 'newer-tag', 'published', 'duplicate-draft'])('refuses unsafe preconditions: %s', async (name) => {
    await scenario(name)
    const result = run(['-Publish'])
    expect(result.status, result.text).not.toBe(0)
    const log = await calls()
    expect(log.some((args) => args[0] === 'npm' || (args[0] === 'git' && ['push', 'commit', 'add'].includes(args[1])))).toBe(false)
    expect(log.some((args) => args[0] === 'gh' && args[1] === 'release' && args[2] === 'edit')).toBe(false)
  })

  it.each(['diverged', 'npm-failure', 'push-failure', 'workflow-failure', 'missing-asset', 'hash-mismatch', 'bad-file-entry', 'newer-during-build'])('never publishes after a failed stage: %s', async (name) => {
    await scenario(name)
    const result = run(['-Publish'])
    expect(result.status, result.text).not.toBe(0)
    expect((await calls()).some((args) => args[0] === 'gh' && args[1] === 'release' && args[2] === 'edit')).toBe(false)
    if (name === 'npm-failure') expect((await calls()).some((args) => args[0] === 'git' && args[1] === 'push')).toBe(false)
  })
})
