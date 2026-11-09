import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const powershells = process.platform === 'win32'
  ? ['powershell.exe', ...(spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0 ? ['pwsh'] : [])]
  : []

describe.skipIf(process.platform !== 'win32')('release upload', () => {
  for (const shell of powershells) {
    async function run(scenario: string) {
      const root = await mkdtemp(path.join(tmpdir(), 'claudio-upload-'))
      try {
        await mkdir(path.join(root, 'dist'))
        await copyFile('scripts/upload-release.ps1', path.join(root, 'upload.ps1'))
        for (const name of ['Claudio-Setup-1.0.1-x64.exe', 'Claudio-Setup-1.0.1-x64.exe.blockmap', 'latest.yml']) {
          await writeFile(path.join(root, 'dist', name), 'fixture')
        }
        await writeFile(path.join(root, 'mock.cjs'), `
const fs = require('node:fs')
const args = process.argv.slice(2), scenario = process.env.SCENARIO
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n')
const draft = { id: 42, tag_name: 'v1.0.1', draft: true, prerelease: false }
const other = { id: 1, tag_name: 'v0.9.0', draft: false, prerelease: false }
if (args[0] !== 'api') process.exit(1)
const endpoint = args[1]
if (endpoint.includes('/git/ref/tags/')) console.log('{}')
else if (endpoint === 'repos/test/repo/releases' && args.includes('POST')) {
  console.log(JSON.stringify(draft))
} else if (endpoint.includes('/releases?')) {
  const page = Number(new URL('https://example.com/' + endpoint).searchParams.get('page'))
  let releases = [other]
  if (scenario === 'existing' || scenario === 'digest' || scenario === 'mismatch' || scenario === 'published') releases.push({...draft, draft: scenario !== 'published'})
  if (scenario === 'duplicate') releases.push(draft, {...draft, id: 43})
  if (scenario === 'pages') releases = page === 1 ? Array.from({length: 100}, (_, id) => ({...other, id})) : [draft]
  console.log(JSON.stringify(releases))
} else if (endpoint.includes('/assets?')) {
  const asset = {id: 55, name: 'latest.yml', size: 7, digest: 'sha256:' + (scenario === 'mismatch' ? '0'.repeat(64) : process.env.FIXTURE_HASH)}
  console.log(JSON.stringify(scenario === 'digest' || scenario === 'mismatch' ? [asset] : []))
} else if (endpoint.startsWith('https://uploads.github.com/')) console.log('{}')
else process.exit(1)
`)
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `function gh { & '${process.execPath.replaceAll("'", "''")}' ./mock.cjs @args }; & ./upload.ps1`], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: {
            ...process.env,
            // Actions runs npm from PowerShell 7; restore the Windows PowerShell
            // module directory for the 5.1 child, which inherits its parent's path.
            PSModulePath: shell === 'powershell.exe'
              ? `${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}${path.delimiter}${process.env.PSModulePath || ''}`
              : process.env.PSModulePath,
            SCENARIO: scenario, FIXTURE_HASH: createHash('sha256').update('fixture').digest('hex'), GITHUB_REF_NAME: 'v1.0.1', GITHUB_REPOSITORY: 'test/repo'
          }
        })
        const calls = (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
        return { result, calls }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    it(`${shell}: uses the creation response even if the list has not caught up`, async () => {
      const { result, calls } = await run('create')
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(calls.filter((args) => args[1]?.includes('/releases?'))).toHaveLength(1)
      expect(calls.some((args) => args[1]?.includes('/git/ref/tags/v1.0.1'))).toBe(true)
      expect(calls.filter((args) => args[1] === 'repos/test/repo/releases' && args.includes('POST'))).toHaveLength(1)
      const uploads = calls.filter((args) => args[1]?.startsWith('https://uploads.github.com/'))
      expect(uploads).toHaveLength(3)
      expect(uploads.every((args) => args[1].includes('/releases/42/assets?name='))).toBe(true)
    })

    it(`${shell}: finds an existing draft among multiple releases and across pages`, async () => {
      for (const scenario of ['existing', 'pages']) {
        const { result, calls } = await run(scenario)
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(calls.some((args) => args[1] === 'repos/test/repo/releases' && args.includes('POST'))).toBe(false)
        expect(calls.some((args) => args[1]?.includes('/releases/42/assets'))).toBe(true)
        if (scenario === 'pages') expect(calls.some((args) => args[1]?.includes('page=2'))).toBe(true)
      }
    })

    it(`${shell}: refuses duplicate and published releases`, async () => {
      for (const scenario of ['duplicate', 'published']) {
        const { result, calls } = await run(scenario)
        expect(result.status).not.toBe(0)
        expect(calls.some((args) => args[1]?.startsWith('https://uploads.github.com/'))).toBe(false)
      }
    })

    it(`${shell}: checks an existing asset digest and refuses mismatches`, async () => {
      const good = await run('digest')
      expect(good.result.status, good.result.stdout + good.result.stderr).toBe(0)
      expect(good.calls.filter((args) => args[1]?.startsWith('https://uploads.github.com/'))).toHaveLength(2)
      const bad = await run('mismatch')
      expect(bad.result.status).not.toBe(0)
      expect(bad.result.stderr).toContain('hash diferente')
    })
  }
})
