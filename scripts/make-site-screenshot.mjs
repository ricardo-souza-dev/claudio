// Capture the real, built app with disposable fictional data. Never open the user's profile.
import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporary = await mkdtemp(path.join(tmpdir(), 'claudio-site-capture-'))
const data = path.join(temporary, 'profile')
const workspace = path.join(temporary, 'projeto-exemplo')
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end('{}')
})
let app
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await mkdir(path.join(data, 'threads'), { recursive: true })
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(path.join(workspace, 'tests'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: workspace, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(temporary, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Pessoa Exemplo', GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: 'Pessoa Exemplo', GIT_COMMITTER_EMAIL: 'dev@example.invalid' } })
  git('init', '-q', '-b', 'main')
  const commits = [
    ['README.md', '# Projeto exemplo\n\nUma API de tarefas fictícia para demonstrar o Claudio.\n', 'docs: documentar o projeto'],
    ['package.json', '{"name":"projeto-exemplo","private":true}\n', 'chore: iniciar a API de tarefas'],
    ['src/tasks.ts', 'export const tasks = []\n', 'feat: adicionar listagem de tarefas'],
    ['src/auth.ts', 'export const authenticate = () => false\n', 'feat: preparar autenticação'],
    ['tests/auth.test.ts', '// Fictional authentication tests.\n', 'test: cobrir acesso sem sessão']
  ]
  for (const [file, content, message] of commits) {
    await writeFile(path.join(workspace, file), content)
    git('add', '--', file)
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message)
  }
  await writeFile(path.join(workspace, 'src/auth.ts'), 'export const authenticate = (session) => Boolean(session?.userId)\n')
  await writeFile(path.join(workspace, 'tests/auth.test.ts'), '// Fictional tests: valid, missing and expired sessions.\n')

  const aurora = { provider: 'demo', id: 'Aurora' }
  const atlas = { provider: 'demo', id: 'Atlas' }
  const now = Date.now()
  const message = (role, parts, model) => ({ id: randomUUID(), role, parts, createdAt: now, ...(model ? { model, stop: 'end' } : {}) })
  const text = (value) => ({ type: 'text', text: value })
  const thread = {
    id: randomUUID(), title: 'Autenticação da API', createdAt: now, updatedAt: now,
    workspace, model: atlas, system: null, contextFiles: [], allowedTools: [], lastRun: 'completed',
    messages: [
      message('user', [text('Revise a autenticação e cubra os cenários de sessão expirada.')]),
      message('assistant', [text('Vou conferir a implementação e os testes antes de alterar o código.'), { type: 'tool_call', id: 'read-auth', name: 'read_file', input: { path: 'src/auth.ts' } }], aurora),
      message('tool', [{ type: 'tool_result', callId: 'read-auth', name: 'read_file', content: 'export const authenticate = () => false' }]),
      message('user', [text('Continue de onde paramos e prepare os testes.')]),
      { ...message('assistant', [text('Tenho o histórico e o arquivo já lido. Vou continuar a revisão, sem recomeçar a análise.\n\n### Próximos ajustes\n- Validar a sessão antes de liberar as rotas protegidas.\n- Tratar sessões ausentes ou expiradas com uma resposta clara.\n- Cobrir os três cenários nos testes de autenticação.\n\nAs alterações estão no painel Git para você revisar antes do commit.')], atlas), usage: { input: 6400, output: 320, cached: 4200 } }
    ]
  }
  for (const [index, title] of ['Autenticação da API', 'Revisão de testes', 'Ideias para o projeto'].entries()) {
    const item = index === 0 ? thread : { ...thread, id: randomUUID(), title, updatedAt: now - index * 1000, messages: [] }
    await writeFile(path.join(data, 'threads', `${item.id}.json`), JSON.stringify(item))
  }
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ keys: {}, baseUrls: {}, custom: [], mcp: null, prefs: { theme: 'dark', memory: '', lastModel: atlas, permissionMode: 'ask', effort: null, autoModel: false } }))
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', CLAUDIO_DATA_DIR: data, CLAUDIO_MODEL_FACTS_URL: `http://127.0.0.1:${server.address().port}/facts.json` }
  delete env.ELECTRON_RUN_AS_NODE
  // No credential from the development environment may reach the disposable app.
  for (const key of Object.keys(env)) if (/(?:API_KEY|AUTH_TOKEN|SECRET|^GH_TOKEN$|^GITHUB_TOKEN$)/i.test(key)) delete env[key]
  app = await electron.launch({ args: [path.resolve('out/main/index.js')], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 820 })
  await expect(page.getByText('Próximos ajustes', { exact: true })).toBeVisible()
  await expect(page.getByText('Revise a autenticação e cubra os cenários de sessão expirada.', { exact: true })).toBeInViewport()
  await expect(page.getByText('As alterações estão no painel Git para você revisar antes do commit.', { exact: true })).toBeInViewport()
  await expect(page.getByText('test: cobrir acesso sem sessão', { exact: true })).toBeVisible()
  await expect(page.getByText('Pessoa Exemplo', { exact: true }).first()).toBeVisible()
  await page.evaluate(async () => {
    await document.fonts.ready
    document.activeElement?.blur()
  })
  await page.screenshot({ path: 'site/app-screenshot.png', animations: 'disabled' })
  console.log('Captura do app com dados fictícios pronta em site/app-screenshot.png')
} finally {
  if (app) await app.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
