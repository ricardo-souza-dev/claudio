import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const SHOTS = process.env.E2E_SHOTS
let llm: MockLlm
let dataDir: string
let workspace: string
const running: { app: ElectronApplication; page: Page; problems: string[] }[] = []

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; problems: string[] }> {
  const app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, CLAUDIO_DATA_DIR: dataDir, CLAUDIO_MODEL_FACTS_URL: `${llm.url}/facts.json`, ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1240, height: 820 }).catch(() => undefined)
  running.push({ app, page, problems })
  return { app, page, problems }
}

async function seedProviders(): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      keys: {},
      baseUrls: {},
      mcp: null,
      custom: [
        { id: 'custom-a', name: 'Anthropic', protocol: 'anthropic', baseUrl: `${llm.url}/anthropic` },
        { id: 'custom-o', name: 'OpenAI', protocol: 'openai-responses', baseUrl: `${llm.url}/openai/v1` },
        { id: 'custom-g', name: 'Google', protocol: 'gemini', baseUrl: `${llm.url}/gemini` },
        { id: 'custom-c', name: 'Compatível', protocol: 'openai-chat', baseUrl: `${llm.url}/compat/v1` }
      ],
      prefs: { memory: 'Prefiro respostas curtas.', lastModel: null, permissionMode: 'ask' }
    })
  )
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('Mensagem', { exact: true })
  await box.fill(text)
  await box.press('Enter')
}

async function pickModel(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog').getByRole('textbox')
  await search.fill(query)
  // The list arrives from the providers shortly after the app opens.
  await expect(page.locator('.picker-row').first()).toBeVisible({ timeout: 15_000 })
  await search.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Answers the system's folder dialog with this folder from now on. */
async function answerFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
  }, folder)
}

async function openProject(app: ElectronApplication, page: Page): Promise<void> {
  await answerFolderDialog(app, workspace)
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
}

const idle = (page: Page) => expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible({ timeout: 20_000 })

test.beforeAll(async () => {
  llm = await startMockLlm()
})
test.afterAll(() => llm.close())
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'uni-e2e-data-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'uni-e2e-work-'))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  llm.requests.length = 0
})
test.afterEach(async ({}, testInfo) => {
  // A failed test never reaches its own app.close(), and a window left open outlives the run.
  for (const instance of running.splice(0)) {
    if (testInfo.status !== testInfo.expectedStatus && instance.app.windows().length > 0) {
      const state = await instance.page
        .evaluate(() => ({
          text: document.body.innerText.slice(0, 600),
          focus: document.activeElement?.tagName,
          hasFocus: document.hasFocus(),
          dialogs: document.querySelectorAll('[role=dialog]').length,
          root: document.getElementById('root')?.childElementCount
        }))
        .catch((error: Error) => ({ unavailable: error.message }))
      await testInfo.attach('estado-da-pagina', { body: JSON.stringify({ state, problems: instance.problems }, null, 2), contentType: 'application/json' })
      console.log('ESTADO DA FALHA', JSON.stringify({ state, problems: instance.problems }))
      await instance.page.screenshot({ path: testInfo.outputPath('falha.png') }).catch(() => undefined)
    }
    await instance.app.close().catch(() => undefined)
  }
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
})

test('first run: locked-down renderer, empty state, connecting a provider through the UI', async () => {
  const { app, page, problems } = await launch()

  // Nothing happens outside a project: there is no message box yet, and the main process refuses too.
  await expect(page.getByRole('heading', { name: 'Em qual projeto vamos trabalhar?' })).toBeVisible()
  await expect(page.getByLabel('Mensagem', { exact: true })).toHaveCount(0)
  await shot(page, '00-escolher-projeto')
  const refused = await page.evaluate(async () => {
    const uni = (window as any).uni
    const [summary] = await uni.threads.list()
    return uni.chat
      .send({ threadId: summary.id, text: 'oi', mode: 'agent', model: { provider: 'x', id: 'y' }, permissionMode: 'ask' })
      .then(() => 'aceitou')
      .catch((error: Error) => error.message)
  })
  expect(refused).toContain('precisa de um projeto')

  // A folder that no longer exists is refused, with the reason in place.
  await answerFolderDialog(app, path.join(workspace, 'nao-existe'))
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await expect(page.getByRole('alert')).toContainText('A pasta não existe')
  await expect(page.getByLabel('Mensagem', { exact: true })).toHaveCount(0)

  // A subfolder opens the whole repository, because the context is the project.
  const subfolder = path.join(workspace, 'src', 'interno')
  await mkdir(subfolder, { recursive: true })
  await answerFolderDialog(app, subfolder)
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
  await expect(page.locator('.context-chip.action')).toContainText(path.basename(workspace))

  await expect(page.getByRole('button', { name: 'Conectar o primeiro provedor' })).toBeVisible()
  await shot(page, '01-primeira-abertura')

  // The icon the window asks for loads, in the format this system uses.
  const iconFile = path.resolve('resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  const icon = await app.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).isEmpty(), iconFile)
  expect(icon).toBe(false)

  // The page has the narrow bridge and nothing else.
  const surface = await page.evaluate(() => ({
    require: typeof (window as any).require,
    process: typeof (window as any).process,
    uni: typeof (window as any).uni,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  }))
  expect(surface).toMatchObject({ require: 'undefined', process: 'undefined', uni: 'object' })
  expect(surface.csp).toContain("img-src 'self' data:")

  const webPrefs = await app.evaluate(({ BrowserWindow }) => {
    const prefs = (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences()
    return { sandbox: prefs?.sandbox, contextIsolation: prefs?.contextIsolation, nodeIntegration: prefs?.nodeIntegration }
  })
  expect(webPrefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })

  await page.getByRole('button', { name: 'Conectar o primeiro provedor' }).click()
  await expect(page.getByRole('heading', { name: 'Provedores' })).toBeVisible()
  await shot(page, '02-provedores')

  // There is always a visible way back, and Esc works too.
  await page.getByRole('button', { name: 'Voltar à conversa' }).click()
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
  await page.getByRole('button', { name: 'Conectar o primeiro provedor' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Provedores' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Conectar o primeiro provedor' }).click()

  // A bad address is reported in place.
  await page.getByLabel('Nome').fill('Teste')
  await page.getByPlaceholder('https://exemplo.com/v1').fill('ftp://errado')
  await page.getByRole('button', { name: 'Adicionar' }).click()
  await expect(page.getByText('O endereço precisa começar com http:// ou https://')).toBeVisible()

  // Add a custom provider with a key, and confirm the key is not on disk in the clear.
  await page.getByPlaceholder('https://exemplo.com/v1').fill(`${llm.url}/compat/v1`)
  await page.locator('.custom-form input[type=password]').fill('sk-segredo-e2e')
  await page.getByRole('button', { name: 'Adicionar' }).click()
  await expect(page.getByRole('button', { name: /^Teste/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Teste.*modelos/ })).toBeVisible({ timeout: 15_000 })

  const disk = await readFile(path.join(dataDir, 'settings.json'), 'utf8')
  expect(disk).not.toContain('sk-segredo-e2e')
  expect(JSON.stringify(await page.evaluate(() => (window as any).uni.providers.list()))).not.toContain('sk-segredo-e2e')

  await page.getByRole('button', { name: /^Teste/ }).click()
  await page.getByRole('button', { name: 'Testar conexão' }).click()
  await expect(page.getByText(/Conectado: \d+ modelos/)).toBeVisible()
  await page.getByRole('button', { name: 'Começar a conversar' }).click()
  await expect(page.getByRole('heading', { name: 'Provedores' })).toHaveCount(0)

  // The saved key really reaches the provider.
  await pickModel(page, 'chat-mock')
  await send(page, 'olá')
  await expect(page.getByText('[openai-chat]')).toBeVisible({ timeout: 15_000 })
  expect(llm.last('openai-chat')!.headers.authorization).toBe('Bearer sk-segredo-e2e')

  expect(problems).toEqual([])
  await app.close()
})

test('one thread through four providers, with markdown rendered safely', async () => {
  await seedProviders()
  await writeFile(path.join(workspace, 'README.md'), 'Sobre o projeto de teste.')
  const { app, page, problems } = await launch()
  await openProject(app, page)

  await pickModel(page, 'Claude Simulado')
  await send(page, 'Primeira pergunta: como organizo este projeto?')
  await expect(page.getByText('[anthropic]')).toBeVisible({ timeout: 15_000 })
  await idle(page)

  await pickModel(page, 'gpt-mock')
  await send(page, 'Segunda pergunta, agora com outro modelo.')
  await expect(page.getByText('[openai-responses]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('assumiu aqui')).toHaveCount(1)
  await idle(page)

  await pickModel(page, 'Gemini Simulado')
  await send(page, 'Terceira pergunta.')
  await expect(page.getByText('[gemini]')).toBeVisible({ timeout: 15_000 })
  await idle(page)

  await pickModel(page, 'chat-mock')
  await send(page, 'Mostre markdown.')
  await expect(page.locator('.markdown strong', { hasText: 'negrito' })).toBeVisible({ timeout: 15_000 })
  await idle(page)
  await expect(page.getByText('assumiu aqui')).toHaveCount(3)

  // Every provider started from the same project context.
  expect(llm.last('anthropic')!.body.system).toContain('Sobre o projeto de teste.')
  expect(llm.last('openai-responses')!.body.instructions).toBe(llm.last('anthropic')!.body.system)
  expect(llm.last('gemini')!.body.systemInstruction.parts[0].text).toBe(llm.last('anthropic')!.body.system)
  expect(llm.last('openai-chat')!.body.messages[0].content).toBe(llm.last('anthropic')!.body.system)

  // Each provider got the others' words.
  expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).toContain('[gemini]')
  expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).toContain('[anthropic]')

  // Markup from a model never becomes live HTML, and no remote image loads.
  expect(await page.evaluate(() => (window as any).__injetado)).toBeUndefined()
  await expect(page.locator('.markdown img')).toHaveCount(0)
  await expect(page.locator('.blocked-image')).toContainText('rastreador')
  await expect(page.locator('.markdown table')).toBeVisible()
  await shot(page, '03-fio-quatro-modelos')

  // Links go to the system browser, not into the app.
  const opened = await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(shell as any).openExternal = async (url: string) => {
      calls.push(url)
    }
    ;(globalThis as any).__opened = calls
    return true
  })
  expect(opened).toBe(true)
  const before = page.url()
  await page.locator('.markdown a', { hasText: 'um link' }).click()
  expect(page.url()).toBe(before)
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toEqual(['https://example.com'])

  expect(problems).toEqual([])
  await app.close()

  // Everything is still there after a restart.
  const again = await launch()
  await expect(again.page.getByText('[gemini]')).toBeVisible({ timeout: 15_000 })
  await expect(again.page.getByText('assumiu aqui')).toHaveCount(3)
  await again.app.close()
})

test('agent: asks before acting, edits files, runs commands, and can be interrupted', async () => {
  await seedProviders()
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Sempre escreva testes.')
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await expect(page.locator('.context-chip.action')).toContainText(path.basename(workspace))
  await pickModel(page, 'Claude Simulado')

  // Denied: nothing is written.
  await send(page, 'ferramenta: write_file {"path":"negado.txt","content":"não"}')
  await expect(page.getByText('Alterar este arquivo?')).toBeVisible({ timeout: 15_000 })
  // The card never takes focus: an Enter meant for the message box can't approve anything.
  await expect(page.getByLabel('Mensagem', { exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Alterar este arquivo?')).toBeVisible()
  await page.getByRole('button', { name: 'Negar' }).click()
  await idle(page)
  await expect(readFile(path.join(workspace, 'negado.txt'))).rejects.toThrow()
  await expect(page.locator('.tool-denied .tool-status')).toHaveText('não permitido')

  // Allowed: the file exists.
  await send(page, 'ferramenta: write_file {"path":"novo.txt","content":"olá mundo\\nsegunda linha"}')
  await expect(page.getByText('Alterar este arquivo?')).toBeVisible({ timeout: 15_000 })
  await shot(page, '04-aprovacao')
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await expect(page.locator('.markdown', { hasText: 'ferramenta concluída' }).last()).toBeVisible({ timeout: 15_000 })
  await idle(page)
  expect(await readFile(path.join(workspace, 'novo.txt'), 'utf8')).toBe('olá mundo\nsegunda linha')

  // Another model continues the same work: it edits what the first one wrote.
  await pickModel(page, 'chat-mock')
  await send(page, 'ferramenta: edit_file {"path":"novo.txt","old_string":"mundo","new_string":"fio"}')
  await expect(page.locator('.diff')).toBeVisible({ timeout: 15_000 })
  await shot(page, '05-diff')
  await page.getByRole('button', { name: 'Sempre nesta conversa' }).click()
  await idle(page)
  expect(await readFile(path.join(workspace, 'novo.txt'), 'utf8')).toContain('olá fio')

  // Allowed for the conversation: no second question.
  await send(page, 'ferramenta: edit_file {"path":"novo.txt","old_string":"fio","new_string":"fio único"}')
  await expect(async () => {
    expect(await readFile(path.join(workspace, 'novo.txt'), 'utf8')).toContain('fio único')
  }).toPass({ timeout: 15_000 })
  await idle(page)

  // A command runs and its output can be inspected.
  await send(page, 'ferramenta: run_command {"command":"echo saida-do-comando"}')
  await expect(page.getByText('Executar este comando?')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await idle(page)
  await page.locator('.tool-row', { hasText: 'run_command' }).last().click()
  await expect(page.locator('.tool-output').last()).toContainText('saida-do-comando')
  await shot(page, '06-ferramentas')

  // Project instructions reached the model, whichever one it is.
  expect(llm.last('openai-chat')!.body.messages[0].content).toContain('Sempre escreva testes.')
  await expect(page.locator('.context-chip', { hasText: 'AGENTS.md' })).toBeVisible()

  // Read-only mode refuses without asking.
  await page.getByLabel('Permissões').selectOption('read-only')
  await send(page, 'ferramenta: write_file {"path":"bloqueado.txt","content":"x"}')
  await idle(page)
  await expect(page.getByText('Alterar este arquivo?')).toHaveCount(0)
  await expect(readFile(path.join(workspace, 'bloqueado.txt'))).rejects.toThrow()

  // Interrupting keeps what was already written.
  await send(page, 'lento')
  await expect(page.locator('.turn.live .markdown')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Interromper' }).click()
  await expect(page.getByText('Interrompido por você.')).toBeVisible({ timeout: 10_000 })
  await idle(page)
  await send(page, 'continuando depois da interrupção')
  await expect(page.getByText('continuando depois da interrupção')).toBeVisible()
  await idle(page)

  // The folder can't change once the conversation has begun.
  await expect(page.locator('.context-chip.action')).toBeDisabled()

  expect(problems).toEqual([])
  await app.close()
})

test('MCP: a real server becomes available to any model, with approval', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)

  await page.getByRole('button', { name: 'Ajustes' }).click()
  await page.getByRole('button', { name: 'Ferramentas MCP' }).click()

  // One click fills in a browser server, and says what it means for the user's accounts.
  await page.getByRole('button', { name: 'Chrome (seus logins)' }).click()
  await expect(page.getByLabel('Configuração MCP em JSON')).toHaveValue(/@playwright\/mcp@latest/)
  await expect(page.locator('.preset-note')).toContainText('o modelo agirá nas suas contas')

  // Malformed input is explained, not swallowed.
  await page.getByLabel('Configuração MCP em JSON').fill('{ quebrado')
  await page.getByRole('button', { name: 'Conectar' }).click()
  await expect(page.getByText(/JSON inválido/)).toBeVisible()

  const fixture = path.resolve('tests/fixtures/mcp-server.mjs')
  await page.getByLabel('Configuração MCP em JSON').fill(
    JSON.stringify({ mcpServers: { teste: { command: process.execPath, args: [fixture], env: { TOKEN_TESTE: 'segredo-mcp' } } } })
  )
  await page.getByRole('button', { name: 'Conectar' }).click()
  await expect(page.getByText('2 ferramentas')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Segredos guardados: TOKEN_TESTE')).toBeVisible()
  expect(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).not.toContain('segredo-mcp')
  await expect(page.locator('body')).not.toContainText('segredo-mcp')
  await shot(page, '11-mcp')
  await page.keyboard.press('Escape')

  // A model with no MCP support of its own uses it through the shared toolbox.
  await pickModel(page, 'Gemini Simulado')
  await send(page, 'ferramenta: mcp__teste__somar {"a":2,"b":3}')
  await expect(page.getByText('Usar esta ferramenta externa?')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await idle(page)
  await page.locator('.tool-row', { hasText: 'teste · somar' }).click()
  await expect(page.locator('.tool-output')).toHaveText('5')

  // And the connection comes back with the app.
  expect(problems).toEqual([])
  await app.close()
  const again = await launch()
  await again.page.getByRole('button', { name: 'Ajustes' }).click()
  await again.page.getByRole('button', { name: 'Ferramentas MCP' }).click()
  await expect(again.page.getByText('2 ferramentas')).toBeVisible({ timeout: 20_000 })
  await again.page.getByRole('button', { name: 'Remover teste' }).click()
  await expect(again.page.getByText('2 ferramentas')).toHaveCount(0)
  await again.app.close()
})

test('failures: a provider error offers another way forward; refusals stay out of context', async () => {
  await seedProviders()
  const { app, page } = await launch()
  await openProject(app, page)
  await pickModel(page, 'chat-mock')

  await send(page, 'falhe')
  await expect(page.getByRole('alert')).toContainText('instável', { timeout: 15_000 })
  await shot(page, '12-erro')

  // Another model picks up from the same message, without retyping it.
  await page.getByRole('button', { name: 'Trocar de modelo' }).click()
  const search = page.getByRole('dialog').getByRole('textbox')
  await search.fill('Claude Simulado')
  await search.press('Enter')
  llm.requests.length = 0
  // "falhe" is still the last message, so the simulated provider fails again, on its own protocol.
  await page.getByRole('button', { name: 'Tentar de novo' }).click()
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 })
  await idle(page)
  expect(llm.last('anthropic')).toBeTruthy()
  await expect(page.locator('.user-text')).toHaveCount(1)

  await pickModel(page, 'gpt-mock')
  await send(page, 'recuse isto')
  await expect(page.getByText('Esta resposta fica fora do contexto')).toBeVisible({ timeout: 15_000 })
  await idle(page)
  await send(page, 'tudo bem, siga')
  await idle(page)
  expect(JSON.stringify(llm.last('openai-responses')!.body.input)).not.toContain('Não posso ajudar')
  await app.close()
})

test('project panel: changes, diff, commit, branches, pull requests and files', async () => {
  await seedProviders()
  const repo = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  repo('checkout', '-q', '-b', 'principal')
  repo('config', 'user.name', 'Teste')
  repo('config', 'user.email', 'teste@example.com')
  repo('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(workspace, 'README.md'), 'um\n')
  await mkdir(path.join(workspace, 'src'))
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  repo('add', '.')
  repo('commit', '-q', '-m', 'Primeiro commit')
  const remote = await mkdtemp(path.join(tmpdir(), 'uni-e2e-remoto-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  repo('remote', 'add', 'origin', remote)

  const { app, page, problems } = await launch({ CLAUDIO_GH_COMMAND: JSON.stringify([process.execPath, path.resolve('tests/fixtures/fake-gh.mjs')]) })
  await openProject(app, page)
  const panel = page.getByRole('complementary', { name: /^Projeto/ })
  await expect(panel.getByLabel('Branch', { exact: true })).toHaveValue('principal')
  await expect(panel.getByText('Nada alterado.')).toBeVisible()
  await expect(panel.getByText('Primeiro commit')).toBeVisible()

  // Pull requests come from the GitHub CLI.
  await expect(panel.getByText('Corrige o login')).toBeVisible()
  await expect(panel.getByText('aprovado')).toBeVisible()
  await expect(panel.locator('.pr-tag', { hasText: 'rascunho' })).toBeVisible()

  // Changes appear, with their diff.
  await writeFile(path.join(workspace, 'README.md'), 'um\ndois\n')
  await writeFile(path.join(workspace, 'novo.txt'), 'novo\n')
  await panel.getByRole('button', { name: 'Atualizar painel' }).click()
  await expect(panel.locator('.git-file')).toHaveCount(2)
  await expect(panel.getByRole('tab', { name: /Git/ })).toContainText('2')
  await shot(page, '24-painel-git')
  await panel.locator('.git-file-open', { hasText: 'README.md' }).click()
  await expect(page.locator('.viewer-line.add')).toHaveText('+dois')
  await shot(page, '25-diff')
  await page.keyboard.press('Escape')
  await expect(page.locator('.viewer')).toHaveCount(0)

  // Discarding takes a second click.
  await panel.locator('.git-file', { hasText: 'novo.txt' }).hover()
  await panel.getByRole('button', { name: 'Descartar alterações em novo.txt' }).click()
  await panel.getByRole('button', { name: 'Confirmar: descartar alterações em novo.txt' }).click()
  await expect(panel.locator('.git-file')).toHaveCount(1)
  await expect(readFile(path.join(workspace, 'novo.txt'))).rejects.toThrow()

  // Prepare and commit.
  await expect(panel.getByRole('button', { name: 'Fazer commit' })).toBeDisabled()
  await panel.getByRole('button', { name: 'Preparar todas' }).click()
  await expect(panel.getByRole('heading', { name: 'Preparadas (1)' })).toBeVisible()

  // A model reads what is staged and writes the message.
  await pickModel(page, 'chat-mock')
  await writeFile(path.join(workspace, '.env'), 'SENHA=segredo-do-env\n')
  await panel.getByRole('button', { name: 'Atualizar painel' }).click()
  await expect(panel.locator('.git-file', { hasText: '.env' })).toBeVisible()
  await panel.getByRole('button', { name: 'Gerar mensagem do commit com IA' }).click()
  await expect(panel.getByLabel('Texto do commit')).toHaveValue(/^feat\(painel\): adiciona a segunda linha/)
  await shot(page, '32-mensagem-gerada')
  const asked = JSON.stringify(llm.last('openai-chat')!.body.messages)
  expect(asked).toContain('+dois')
  expect(asked).toContain('Primeiro commit')
  expect(asked).not.toContain('segredo-do-env')
  await rm(path.join(workspace, '.env'))

  await panel.getByRole('button', { name: 'Fazer commit' }).click()
  await expect(panel.locator('.commit-subject').first()).toHaveText('feat(painel): adiciona a segunda linha')
  await expect(panel.getByRole('heading', { name: 'Preparadas (0)' })).toBeVisible()
  await expect(panel.getByLabel('Texto do commit')).toHaveValue('')
  expect(repo('log', '-1', '--format=%s')).toBe('feat(painel): adiciona a segunda linha')
  expect(repo('log', '-1', '--format=%b')).toContain('Mostra o que mudou no README.')

  // New branch, then publish it.
  await panel.getByRole('button', { name: 'Nova branch' }).click()
  await panel.getByLabel('Nome da nova branch').fill('nome inválido')
  await panel.getByLabel('Nome da nova branch').press('Enter')
  await expect(panel.getByRole('alert')).toContainText('inválido')
  await panel.getByLabel('Nome da nova branch').fill('recurso/painel')
  await panel.getByLabel('Nome da nova branch').press('Enter')
  await expect(panel.getByLabel('Branch', { exact: true })).toHaveValue('recurso/painel')
  expect(repo('branch', '--show-current')).toBe('recurso/painel')
  await expect(panel.getByText('Só local')).toBeVisible()
  await panel.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(panel.getByText('Só local')).toHaveCount(0)
  expect(repo('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/recurso/painel')

  // Back to the first branch from the list.
  await panel.getByLabel('Branch', { exact: true }).selectOption('principal')
  await expect(panel.getByLabel('Branch', { exact: true })).toHaveValue('principal')
  expect(repo('branch', '--show-current')).toBe('principal')

  // Files the agent writes show up as soon as it finishes.
  await send(page, 'ferramenta: write_file {"path":"src/feito-pelo-agente.ts","content":"export {}"}')
  await page.getByRole('button', { name: 'Permitir', exact: true }).click({ timeout: 15_000 })
  await expect(panel.locator('.git-file', { hasText: 'feito-pelo-agente.ts' })).toBeVisible({ timeout: 15_000 })

  // File tree, with what changed marked, and a filter.
  await panel.getByRole('tab', { name: 'Arquivos' }).click()
  await expect(panel.locator('.tree-row', { hasText: 'README.md' })).toBeVisible()
  await panel.locator('.tree-row', { hasText: 'src' }).click()
  await expect(panel.locator('.tree-row', { hasText: 'feito-pelo-agente.ts' }).locator('.git-code')).toHaveText('U')
  await shot(page, '26-painel-arquivos')
  await panel.getByLabel('Filtrar arquivos').fill('a.ts')
  await expect(panel.locator('.tree-row')).toHaveCount(1)
  await panel.locator('.tree-row').click()
  await expect(page.locator('.viewer-text')).toHaveText('export const a = 1\n')
  await page.keyboard.press('Escape')

  // The panel can get out of the way.
  await page.getByRole('button', { name: 'Fechar painel do projeto' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: 'Abrir painel do projeto' }).click()
  await expect(panel).toBeVisible()

  expect(problems).toEqual([])
  await app.close()
  await rm(remote, { recursive: true, force: true }).catch(() => undefined)
})

test('a project with several repositories: each one with its own branch and commit', async () => {
  await seedProviders()
  const inRepo = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const seed = async (folder: string, branch: string): Promise<void> => {
    await mkdir(folder, { recursive: true })
    inRepo(folder, 'init', '-q', '-b', branch)
    inRepo(folder, 'config', 'user.name', 'Teste')
    inRepo(folder, 'config', 'user.email', 'teste@example.com')
    inRepo(folder, 'config', 'commit.gpgsign', 'false')
    await writeFile(path.join(folder, 'base.txt'), `${branch}\n`)
    inRepo(folder, 'add', '.')
    inRepo(folder, 'commit', '-q', '-m', `Início de ${branch}`)
  }
  await rm(path.join(workspace, '.git'), { recursive: true, force: true })
  const api = path.join(workspace, 'api')
  const web = path.join(workspace, 'web')
  await seed(api, 'principal-api')
  await seed(web, 'principal-web')

  const { app, page, problems } = await launch()
  await openProject(app, page)
  const panel = page.getByRole('complementary', { name: /^Projeto/ })
  const apiBlock = panel.getByRole('region', { name: 'Repositório api' })
  const webBlock = panel.getByRole('region', { name: 'Repositório web' })
  await expect(apiBlock.locator('.repo-branch')).toHaveText('principal-api')
  await expect(webBlock.locator('.repo-branch')).toHaveText('principal-web')
  await expect(panel.getByText('Este projeto não usa Git.')).toHaveCount(0)

  // A change counts in the block of the repository it belongs to.
  await writeFile(path.join(web, 'base.txt'), 'alterado\n')
  await panel.getByRole('button', { name: 'Atualizar painel' }).click()
  await expect(webBlock.locator('.repo-head .panel-count')).toHaveText('1')
  await expect(apiBlock.locator('.repo-head .panel-count')).toHaveCount(0)
  await expect(panel.getByRole('tab', { name: /Git/ })).toContainText('1')

  // Its commit stays in that repository.
  await webBlock.locator('.repo-head').click()
  await webBlock.getByRole('button', { name: 'Preparar todas' }).click()
  await webBlock.getByLabel('Texto do commit').fill('Muda o web')
  await webBlock.getByRole('button', { name: 'Fazer commit' }).click()
  await expect(webBlock.locator('.commit-subject').first()).toHaveText('Muda o web')
  expect(inRepo(web, 'log', '-1', '--format=%s')).toBe('Muda o web')
  expect(inRepo(api, 'log', '-1', '--format=%s')).toBe('Início de principal-api')
  await shot(page, '28-varios-repositorios')

  // The file tree covers them all.
  await panel.getByRole('tab', { name: 'Arquivos' }).click()
  await panel.getByLabel('Filtrar arquivos').fill('base.txt')
  await expect(panel.locator('.tree-row')).toHaveCount(2)

  expect(problems).toEqual([])
  await app.close()
})

test('a project without Git works normally, and can start using it', async () => {
  await seedProviders()
  const plain = await mkdtemp(path.join(tmpdir(), 'uni-e2e-sem-git-'))
  await writeFile(path.join(plain, 'notas.txt'), 'sem controle de versão')
  const { app, page, problems } = await launch()
  await answerFolderDialog(app, plain)
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
  await expect(page.locator('.context-chip.action')).toContainText(path.basename(plain))

  const panel = page.getByRole('complementary', { name: /^Projeto/ })
  await expect(panel.getByText('Este projeto não usa Git.')).toBeVisible()
  await expect(panel.getByRole('tab', { name: /Git/ })).toHaveCount(0)
  await expect(panel.locator('.tree-row', { hasText: 'notas.txt' })).toBeVisible()
  await shot(page, '27-sem-git')

  // The agent works here just the same.
  await pickModel(page, 'chat-mock')
  await send(page, 'ferramenta: read_file {"path":"notas.txt"}')
  await expect(page.locator('.tool-row', { hasText: 'read_file' })).toBeVisible({ timeout: 15_000 })
  await idle(page)
  expect(JSON.stringify(llm.last('openai-chat')!.body.messages)).toContain('sem controle de versão')

  await panel.getByRole('button', { name: 'Iniciar Git' }).click()
  await expect(panel.getByRole('tab', { name: /Git/ })).toBeVisible()
  await expect(panel.getByText('Este projeto não usa Git.')).toHaveCount(0)

  expect(problems).toEqual([])
  await app.close()
  await rm(plain, { recursive: true, force: true }).catch(() => undefined)
})

test('while working: context, tokens, strength of the model, task list and queue', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'Claude Simulado')

  // The strength of the model reaches the provider.
  await page.getByLabel('Força do modelo').selectOption('xhigh')
  await send(page, 'Primeira pergunta')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[anthropic]', { timeout: 15_000 })
  await idle(page)
  expect(llm.last('anthropic')!.body.output_config).toEqual({ effort: 'xhigh' })

  // A model that takes no strength setting offers no choice.
  await pickModel(page, 'chat-mock')
  await expect(page.getByLabel('Força do modelo')).toHaveCount(0)
  await pickModel(page, 'Claude Simulado')

  // Context, limits, tokens and cost are one click away, including limits the provider API doesn't report.
  await page.locator('.meter-button').click()
  const panel = page.locator('.meter-panel')
  await expect(panel).toContainText('Contexto em uso')
  await expect(panel).toContainText('de 200 mil')
  await expect(panel).toContainText('32 mil tokens')
  await expect(panel).toContainText('Extra')
  await expect(panel).toContainText('US$')
  await shot(page, '20-uso-da-conversa')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // The task list stays in sight, and isn't repeated as a tool in the transcript.
  await send(page, 'ferramenta: update_plan {"items":[{"content":"Ler o código","status":"completed"},{"content":"Corrigir o erro","status":"in_progress"},{"content":"Rodar os testes","status":"pending"}]}')
  await expect(page.locator('.plan-item')).toHaveCount(3, { timeout: 15_000 })
  await idle(page)
  await expect(page.locator('.tool-row', { hasText: 'update_plan' })).toHaveCount(0)
  await shot(page, '21-tarefas')

  // Time and tokens count up while the model works.
  await pickModel(page, 'chat-mock')
  await send(page, 'lento')
  await expect(page.locator('.plan')).toHaveCount(0)
  await expect(page.locator('.run-status')).toContainText('Escrevendo', { timeout: 15_000 })
  await expect(page.locator('.run-status')).toContainText('tokens')
  await expect(page.locator('.run-status')).toContainText(/\d+ s/)

  // A message written meanwhile waits its turn.
  const box = page.getByLabel('Mensagem', { exact: true })
  await box.fill('primeira da fila')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(page.locator('.queued-text')).toHaveText('primeira da fila')
  await shot(page, '22-em-execucao')

  // It goes out by itself when the run ends normally.
  await expect(page.locator('.user-text').last()).toHaveText('primeira da fila', { timeout: 30_000 })
  await expect(page.locator('.queued')).toHaveCount(0)
  await idle(page)

  // After an interruption it waits, because the person may have changed their mind.
  await send(page, 'lento')
  await expect(page.locator('.run-status')).toContainText('Escrevendo', { timeout: 15_000 })
  await box.fill('segunda da fila')
  await box.press('Enter')
  await page.getByRole('button', { name: 'Interromper' }).click()
  await expect(page.getByText('Interrompido por você.').last()).toBeVisible({ timeout: 10_000 })
  await idle(page)
  await expect(page.locator('.queued-text')).toHaveText('segunda da fila')

  await page.getByRole('button', { name: 'Remover da fila: segunda da fila' }).click()
  await expect(page.locator('.queued')).toHaveCount(0)

  // "Enviar agora" interrupts the work in progress and sends the message.
  await send(page, 'lento')
  await expect(page.locator('.run-status')).toContainText('Escrevendo', { timeout: 15_000 })
  await box.fill('terceira da fila')
  await box.press('Enter')
  await page.getByRole('button', { name: 'Enviar agora' }).click()
  await expect(page.locator('.user-text').last()).toHaveText('terceira da fila', { timeout: 15_000 })
  await idle(page)
  await expect(page.locator('.queued')).toHaveCount(0)

  expect(problems).toEqual([])
  await app.close()
})

test('automatic model: chooses by task and price, explains itself, and hands back control', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)

  await page.keyboard.press('Control+k')
  await expect(page.locator('.picker-row').first()).toBeVisible({ timeout: 15_000 })
  await shot(page, '23-escolher-automatico')
  await page.locator('.picker-auto').click()
  await expect(page.locator('.model-chip-auto')).toHaveText('Automático')

  await send(page, 'oi')
  await expect(page.locator('.notice')).toContainText('escolhi chat-mock', { timeout: 15_000 })
  await expect(page.locator('.author').last()).toHaveText('chat-mock')
  await idle(page)

  await send(page, 'refatore a arquitetura deste módulo')
  await expect(page.locator('.notice')).toContainText('escolhi Claude Simulado', { timeout: 15_000 })
  await expect(page.locator('.author').last()).toHaveText('Claude Simulado')
  await idle(page)

  // Stepping down would lose the prompt cache.
  await send(page, 'ok')
  await expect(page.locator('.notice')).toContainText('mantive Claude Simulado', { timeout: 15_000 })
  await idle(page)

  // Picking a model turns it off.
  await pickModel(page, 'gpt-mock')
  await expect(page.locator('.model-chip-auto')).toHaveCount(0)
  await send(page, 'oi de novo')
  await expect(page.locator('.author').last()).toHaveText('gpt-mock', { timeout: 15_000 })
  await idle(page)

  expect(problems).toEqual([])
  await app.close()
})

test('message box: paste a screenshot, attach files, and any model reads them', async () => {
  await seedProviders()
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'Claude Simulado')
  const box = page.getByLabel('Mensagem', { exact: true })

  // A file nobody can read is refused right there, without losing what was typed.
  await box.fill('texto que não pode se perder')
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'app.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 0, 2, 0]) })
  await expect(page.getByRole('alert')).toContainText('binário')
  await expect(box).toHaveValue('texto que não pode se perder')
  await box.fill('')

  // From the file picker.
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'nota.md', mimeType: 'text/markdown', buffer: Buffer.from('# Nota importante') })
  await expect(page.locator('.attachment')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)

  // Pasted from the clipboard.
  await box.evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, PNG)
  await expect(page.locator('.attachment')).toHaveCount(2)
  await expect(page.locator('.attachment img')).toHaveCount(1)
  await expect(page.locator('.attachment-name').last()).toContainText(/^print-/)

  // Dropped on the box.
  await page.locator('.composer-box').evaluate((element) => {
    const dropped = new DataTransfer()
    dropped.items.add(new File(['descartável'], 'descartar.txt', { type: 'text/plain' }))
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.attachment')).toHaveCount(3)
  await page.getByRole('button', { name: 'Remover anexo descartar.txt' }).click()
  await expect(page.locator('.attachment')).toHaveCount(2)
  await shot(page, '29-anexos')

  await send(page, 'O que tem aqui?')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[anthropic]', { timeout: 15_000 })
  await idle(page)
  await expect(page.locator('.attachment')).toHaveCount(0)
  await expect(page.locator('.sent-image')).toBeVisible()
  await expect(page.locator('.sent-file')).toContainText('nota.md')
  await shot(page, '30-anexos-enviados')

  const claude = JSON.stringify(llm.last('anthropic')!.body.messages)
  expect(claude).toContain(PNG)
  expect(claude).toContain('# Nota importante')
  expect(await readFile(path.join(dataDir, 'threads', (await readdir(path.join(dataDir, 'threads')))[0]), 'utf8')).not.toContain(PNG)

  // Another model sees the same files.
  await pickModel(page, 'gpt-mock')
  await send(page, 'E você, o que vê?')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[openai-responses]', { timeout: 15_000 })
  await idle(page)
  expect(JSON.stringify(llm.last('openai-responses')!.body.input)).toContain(PNG)

  // Only a file, with no text.
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'sozinho.txt', mimeType: 'text/plain', buffer: Buffer.from('só o arquivo') })
  await box.press('Enter')
  await expect(page.locator('.sent-file', { hasText: 'sozinho.txt' })).toBeVisible({ timeout: 15_000 })
  await idle(page)

  expect(problems).toEqual([])
  await app.close()
})

test('choosing a model: recommendation for the moment, with cost, strength and measured time', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)

  // The recommendation follows what is being written.
  await page.getByLabel('Mensagem', { exact: true }).fill('refatore a arquitetura deste módulo')
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.picker-row').first()).toBeVisible({ timeout: 15_000 })
  const recommended = dialog.locator('.picker-recommended')
  await expect(recommended).toContainText('Claude Simulado')
  await expect(recommended).toContainText('tarefa complexa')
  await shot(page, '31-escolher-modelo')

  // Each row shows strength, an estimated cost and the context limit.
  const claude = dialog.locator('.picker-row:not(.picker-recommended)', { hasText: 'Claude Simulado' })
  await expect(claude).toContainText('até Máxima')
  await expect(claude).toContainText('~US$')
  await expect(claude).toContainText('200 mil')
  await page.keyboard.press('Escape')

  await page.getByLabel('Mensagem', { exact: true }).fill('oi')
  await page.keyboard.press('Control+k')
  await expect(dialog.locator('.picker-recommended')).toContainText('chat-mock')
  await expect(dialog.locator('.picker-recommended')).toContainText('pedido simples')

  // Time appears once a model has answered here.
  const row = dialog.locator('.picker-row:not(.picker-recommended)', { hasText: 'chat-mock' })
  await expect(row.locator('.picker-figure').nth(2)).toHaveText('—')
  await dialog.locator('.picker-recommended').click()
  await send(page, 'oi')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[openai-chat]', { timeout: 15_000 })
  await idle(page)
  await page.keyboard.press('Control+k')
  await expect(row.locator('.picker-figure').nth(2)).toHaveText(/^~\d+ s$/, { timeout: 10_000 })
  await page.keyboard.press('Escape')

  // A model that can't read images says so when there is one to send.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'print.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') })
  await page.keyboard.press('Control+k')
  await expect(dialog.locator('.picker-row', { hasText: 'chat-mock' }).first()).toContainText('não lê imagens')
  await page.keyboard.press('Escape')

  expect(problems).toEqual([])
  await app.close()
})

test('a conversation from before projects were required stays readable but cannot continue', async () => {
  await seedProviders()
  const id = '11111111-1111-4111-8111-111111111111'
  await mkdir(path.join(dataDir, 'threads'), { recursive: true })
  await writeFile(
    path.join(dataDir, 'threads', `${id}.json`),
    JSON.stringify({
      id,
      title: 'Conversa antiga',
      createdAt: 1,
      updatedAt: 1,
      workspace: null,
      model: null,
      system: 'antigo',
      contextFiles: [],
      allowedTools: [],
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Mensagem antiga' }], createdAt: 1 }]
    })
  )
  const { app, page, problems } = await launch()
  await expect(page.locator('.user-text')).toHaveText('Mensagem antiga')
  await expect(page.locator('.thread-group-name')).toHaveText('Sem projeto')
  await expect(page.getByLabel('Mensagem', { exact: true })).toHaveCount(0)
  await shot(page, '18-conversa-sem-projeto')

  await page.getByRole('button', { name: 'Abrir um projeto' }).click()
  await openProject(app, page)
  await expect(page.locator('.thread-item')).toHaveCount(2)
  expect(problems).toEqual([])
  await app.close()
})

test('conversation management: new, switch, delete, shortcuts, narrow window, light and dark', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'chat-mock')
  await send(page, 'Conversa número um')
  await idle(page)

  // A new conversation stays in the same project, listed under its name.
  await page.keyboard.press('Control+n')
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
  await send(page, 'Conversa número dois')
  await idle(page)
  await expect(page.locator('.thread-item')).toHaveCount(2)
  await expect(page.locator('.thread-group')).toHaveCount(1)
  await expect(page.locator('.thread-group-name')).toHaveText(path.basename(workspace))

  // A second project gets its own group, and the first one stays one click away.
  const otherProject = await mkdtemp(path.join(tmpdir(), 'uni-e2e-outro-'))
  execFileSync('git', ['init', '-q'], { cwd: otherProject })
  await page.getByRole('button', { name: 'Abrir outro projeto' }).click()
  await expect(page.getByRole('heading', { name: 'Em qual projeto vamos trabalhar?' })).toBeVisible()
  await expect(page.locator('.recent-name')).toHaveText(path.basename(workspace))
  await shot(page, '16-projetos-recentes')
  await answerFolderDialog(app, otherProject)
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await send(page, 'Conversa no outro projeto')
  await idle(page)
  await expect(page.locator('.thread-group')).toHaveCount(2)
  await shot(page, '17-dois-projetos')
  await page.locator('.thread-item', { hasText: 'Conversa no outro projeto' }).hover()
  await page.getByRole('button', { name: 'Apagar “Conversa no outro projeto”' }).click()
  await page.getByRole('button', { name: /^Confirmar/ }).click()
  await expect(page.locator('.thread-group')).toHaveCount(1)
  await rm(otherProject, { recursive: true, force: true }).catch(() => undefined)

  await page.locator('.thread-open', { hasText: 'Conversa número um' }).click()
  await expect(page.locator('.user-text')).toHaveText('Conversa número um')

  // The picker works from the keyboard.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Deleting takes a second click, and moving away cancels it.
  const second = page.locator('.thread-item', { hasText: 'Conversa número dois' })
  await second.hover()
  await page.getByRole('button', { name: 'Apagar “Conversa número dois”' }).click()
  await expect(page.locator('.thread-item')).toHaveCount(2)
  await page.locator('.topbar-title').hover()
  await expect(second.getByRole('button', { name: /Confirmar/ })).toHaveCount(0)
  await second.hover()
  await page.getByRole('button', { name: 'Apagar “Conversa número dois”' }).click()
  await page.getByRole('button', { name: /Confirmar: apagar “Conversa número dois”/ }).click()
  await expect(page.locator('.thread-item')).toHaveCount(1)

  // Deleting the open conversation lands somewhere sensible.
  await page.locator('.thread-item').hover()
  await page.getByRole('button', { name: /^Apagar/ }).click()
  await page.getByRole('button', { name: /^Confirmar/ }).click()
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()

  await send(page, 'Conversa para ver a tela')
  await idle(page)

  await page.emulateMedia({ colorScheme: 'light' })
  await shot(page, '13-claro')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, '14-escuro')

  // The smallest window the app allows, with the busiest composer it can show.
  await page.setViewportSize({ width: 760, height: 520 })
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'um-nome-de-arquivo-bem-comprido-para-testar.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await shot(page, '15-janela-estreita')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeInViewport()

  // The panel steps aside instead of covering the message box, and opens again on request.
  const projectPanel = page.locator('.project-panel')
  await expect(projectPanel).toHaveCount(0)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click({ trial: true })
  await page.getByRole('button', { name: 'Abrir painel do projeto' }).click()
  await expect(projectPanel).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Git/ })).toBeVisible()
  await shot(page, '33-painel-flutuante')
  // Floating over the conversation, it has its own way out.
  await page.getByRole('button', { name: 'Fechar painel', exact: true }).click()
  await expect(projectPanel).toHaveCount(0)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click({ trial: true })

  // With room again it comes back. Closed by hand there, it stays closed through both sizes.
  await page.setViewportSize({ width: 1240, height: 820 })
  await expect(projectPanel).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fechar painel', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Fechar painel do projeto' }).click()
  await expect(projectPanel).toHaveCount(0)
  await page.setViewportSize({ width: 760, height: 520 })
  await page.setViewportSize({ width: 1240, height: 820 })
  await expect(projectPanel).toHaveCount(0)

  expect(problems).toEqual([])
  await app.close()
})
