// Stands in for the GitHub CLI in tests, recording how it was called.
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`)

if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.FAKE_GH_FAIL) {
    console.error('To get started with GitHub CLI, please run:  gh auth login')
    process.exit(4)
  }
  console.log(
    JSON.stringify([
      { number: 42, title: 'Corrige o login', headRefName: 'corrige-login', url: 'https://github.com/a/b/pull/42', author: { login: 'ana' }, isDraft: false, reviewDecision: 'APPROVED' },
      { number: 43, title: 'Rascunho do painel', headRefName: 'painel', url: 'https://github.com/a/b/pull/43', author: { login: 'bia' }, isDraft: true, reviewDecision: '' }
    ])
  )
} else if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/a/b/pull/44')
} else if (args[0] === 'pr' && args[1] === 'checkout') {
  process.exit(0)
} else {
  console.error(`unexpected: ${args.join(' ')}`)
  process.exit(1)
}
