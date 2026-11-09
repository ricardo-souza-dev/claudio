import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')('finds a newly created draft through the release list, never the tag endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudio-upload-'))
  try {
    await mkdir(path.join(root, 'dist'))
    await mkdir(path.join(root, 'bin'))
    await copyFile('scripts/upload-release.ps1', path.join(root, 'upload.ps1'))
    for (const name of ['Claudio-Setup-1.0.1-x64.exe', 'Claudio-Setup-1.0.1-x64.exe.blockmap', 'latest.yml']) {
      await writeFile(path.join(root, 'dist', name), 'fixture')
    }
    await writeFile(path.join(root, 'mock.cjs'), `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n')
if (args[0] === 'api') {
  if (args[1].includes('/tags/')) process.exit(1)
  if (args[1].includes('/assets?')) console.log('[]')
  else console.log(fs.existsSync('created') ? JSON.stringify([{id: 42, tag_name: 'v1.0.1', draft: true, prerelease: false}]) : '[]')
} else if (args[1] === 'create') {
  fs.writeFileSync('created', '')
  console.log('https://github.com/test/repo/releases/tag/untagged-example')
}
`)
    await writeFile(path.join(root, 'bin', 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(root, 'mock.cjs')}" "%~1" "%~2"\r\n`)
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `function gh { & '${process.execPath.replaceAll("'", "''")}' ./mock.cjs @args }; & ./upload.ps1`], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, GITHUB_REF_NAME: 'v1.0.1', GITHUB_REPOSITORY: 'test/repo', PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` }
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const calls = (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls.filter((args) => args[1]?.includes('/releases?'))).toHaveLength(2)
    expect(calls.filter((args) => args[1] === 'upload')).toHaveLength(3)
    expect(calls.some((args) => args[1]?.includes('/releases/42/assets'))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
