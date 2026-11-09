// Offline stand-ins for git, npm and gh. Unknown commands fail closed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [tool, ...args] = process.argv.slice(2)
const statePath = process.env.CLAUDIO_RELEASE_TEST_STATE
if (!statePath) throw new Error('Missing test state')
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.appendFileSync(`${statePath}.calls`, `${JSON.stringify([tool, ...args])}\n`)
const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
const output = (value = '') => console.log(typeof value === 'string' ? value : JSON.stringify(value))
const fail = () => { console.error(`Mock failure: ${tool} ${args.join(' ')}`); process.exit(9) }
const head = 'a'.repeat(40)
const tag = 'v1.0.1'
const installer = 'Claudio-Setup-1.0.1-x64.exe'
const bytes = Buffer.from('offline fake installer, never execute')
const value = (flag) => args[args.indexOf(flag) + 1]
const is = (...prefix) => prefix.every((arg, index) => args[index] === arg)

if (tool === 'git') {
  if (is('status')) output(state.scenario === 'dirty' ? ' M README.md' : '')
  else if (is('branch')) output(state.scenario === 'branch' ? 'feature' : 'main')
  else if (is('remote', 'get-url')) output(state.scenario === 'origin' ? 'https://github.com/other/repo.git' : 'https://github.com/ricardo-souza-dev/claudio.git')
  else if (is('rev-parse')) output(head)
  else if (is('tag', '--list')) output(state.resume || state.tagCreated ? tag : '')
  else if (is('ls-remote')) {
    if (state.resume || state.scenario === 'remote-tag') output(`${head}\trefs/tags/${tag}`)
    else if (state.scenario === 'newer-tag') output(`${head}\trefs/tags/v2.0.0`)
    else output()
  }
  else if (is('fetch') || is('merge-base') || is('add') || is('commit')) {
    if (is('merge-base') && state.scenario === 'diverged') fail()
    output()
  }
  else if (is('tag', tag)) { state.tagCreated = true; save() }
  else if (is('push')) {
    if (state.scenario === 'push-failure') fail()
    state.pushed = true; save()
  }
  else fail()
} else if (tool === 'npm') {
  if (!is('version', '1.0.1') || state.scenario === 'npm-failure') fail()
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
  pkg.version = lock.version = lock.packages[''].version = '1.0.1'
  fs.writeFileSync('package.json', JSON.stringify(pkg))
  fs.writeFileSync('package-lock.json', JSON.stringify(lock))
  output('v1.0.1')
} else if (tool === 'gh') {
  if (is('auth', 'status')) { if (state.scenario === 'auth') fail(); output('authenticated') }
  else if (is('repo', 'view')) output('ricardo-souza-dev/claudio')
  else if (is('release', 'list')) {
    if (state.scenario === 'duplicate-draft') output([{ tagName: tag, isDraft: true, isPrerelease: false }, { tagName: tag, isDraft: true, isPrerelease: false }])
    else if (state.scenario === 'published') output([{ tagName: tag, isDraft: false, isPrerelease: false }])
    else if (state.scenario === 'newer-during-build' && state.pushed) output([{ tagName: 'v2.0.0', isDraft: false, isPrerelease: false }])
    else if (state.resume) output([{ tagName: 'v1.0.0', isDraft: false, isPrerelease: false }, { tagName: tag, isDraft: true, isPrerelease: false }])
    else output([])
  }
  else if (is('run', 'list')) output([{ databaseId: 1, headBranch: 'v0.1.0' }, { databaseId: 42, headBranch: tag }])
  else if (is('run', 'view')) {
    if (args[2] !== '42') fail()
    output({ status: 'completed', conclusion: state.scenario === 'workflow-failure' ? 'failure' : 'success', url: 'https://github.com/example/actions/runs/42' })
  }
  else if (is('release', 'view')) output({
    isDraft: true, isPrerelease: false, url: `https://github.com/example/releases/tag/${tag}`,
    assets: (state.scenario === 'missing-asset' ? [installer] : [installer, `${installer}.blockmap`, 'latest.yml']).map((name) => ({ name, size: 100 }))
  })
  else if (is('release', 'download')) {
    const dir = value('--dir')
    fs.writeFileSync(path.join(dir, installer), bytes)
    fs.writeFileSync(path.join(dir, `${installer}.blockmap`), 'fake blockmap')
    const sha512 = state.scenario === 'hash-mismatch' ? 'AAAAAAAA' : crypto.createHash('sha512').update(bytes).digest('base64')
    const fileHash = state.scenario === 'bad-file-entry' ? 'AAAAAAAA' : sha512
    fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 1.0.1\nfiles:\n  - url: ${installer}\n    sha512: ${fileHash}\n    size: ${bytes.length}\npath: ${installer}\nsha512: ${sha512}\n`)
  }
  else if (is('api')) output({ body: '## Novidades\n\nNotas simuladas, sem publicar nada.' })
  else if (is('release', 'edit')) {
    if (!args.includes('--draft=false') || !args.includes('--latest')) fail()
    state.notes = fs.readFileSync(value('--notes-file'), 'utf8')
    state.published = true; save()
  }
  else fail()
} else fail()
