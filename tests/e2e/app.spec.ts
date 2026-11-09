import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
    // Tests must load the production build, even when launched from the running dev app.
    env: { ...process.env, ELECTRON_RENDERER_URL: '', CLAUDIO_DATA_DIR: dataDir, CLAUDIO_MODEL_FACTS_URL: `${llm.url}/facts.json`, ...extraEnv } as Record<string, string>
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

test('provider pickers curate OpenAI and Anthropic without restricting custom providers', async () => {
  await seedProviders()
  const allowed = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6']
  const anthropic = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20261001', 'claude-sonnet-4-6']
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/anthropic/')) {
      res.end(JSON.stringify({
        data: [...anthropic, 'claude-opus-5', 'claude-sonnet-5-5-preview'].map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-10-01T00:00:00Z' })),
        has_more: false
      }))
    } else {
      res.end(JSON.stringify({ data: [...allowed, 'gpt-other', 'gpt-6-luna-preview'].map((id) => ({ id })) }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await seedProviders()
    const settingsPath = path.join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    // Distinguish custom provider headings from the built-in integrations.
    settings.custom.find((provider: { id: string }) => provider.id === 'custom-o').name = 'OpenAI personalizado'
    settings.custom.find((provider: { id: string }) => provider.id === 'custom-a').name = 'Anthropic personalizado'
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    settings.baseUrls.openai = `${url}/v1`
    settings.baseUrls.anthropic = `${url}/anthropic`
    await writeFile(settingsPath, JSON.stringify(settings))
    const { app, page } = await launch()
    // Save only fake credentials; both providers point at the local test server.
    await page.evaluate(async () => {
      await window.uni.providers.setKey('openai', 'fake')
      await window.uni.providers.setKey('anthropic', 'fake')
    })
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Atualizar lista de modelos' }).click()
    await expect(dialog.getByText('gpt-6.1-terra', { exact: true })).toBeVisible()
    await dialog.getByRole('textbox').fill('OpenAI')
    await expect(page.locator('.picker-row')).toHaveCount(6)
    for (const id of [...allowed, 'gpt-mock']) {
      await expect(page.locator('.picker-row').filter({ hasText: id })).toHaveCount(1)
    }
    await expect(page.locator('.picker-row').filter({ hasText: 'gpt-other' })).toHaveCount(0)
    await expect(page.locator('.picker-row').filter({ hasText: 'preview' })).toHaveCount(0)
    await dialog.getByRole('textbox').fill('Anthropic')
    await expect(page.locator('.picker-row')).toHaveCount(7)
    for (const id of [...anthropic, 'claude-mock']) {
      await expect(page.locator('.picker-row').filter({ hasText: id })).toHaveCount(1)
    }
    await expect(page.locator('.picker-row').filter({ hasText: 'preview' })).toHaveCount(0)
    await expect(dialog.getByText('claude-opus-5', { exact: true })).toHaveCount(0)
    await app.close()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('collapsed project headings stay compact', async () => {
  const { app, page } = await launch()
  await openProject(app, page)
  const secondWorkspace = path.join(dataDir, 'second-project')
  await mkdir(secondWorkspace)
  // Seed two named conversations: an untouched new one is intentionally absent from the sidebar.
  await page.evaluate(async (folder) => {
    const first = (await window.uni.threads.list())[0]
    await window.uni.threads.rename(first.id, 'Primeiro projeto')
    const second = await window.uni.threads.create(folder, null)
    await window.uni.threads.rename(second.id, 'Segundo projeto')
  }, secondWorkspace)
  const groups = page.locator('.sidebar-project')
  await expect(groups).toHaveCount(2)
  for (const toggle of await groups.locator('.thread-group-toggle').all()) {
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
  }
  const gap = () => groups.evaluateAll((nodes) => {
    const first = nodes[0].querySelector('.thread-group')!.getBoundingClientRect()
    const second = nodes[1].querySelector('.thread-group')!.getBoundingClientRect()
    return second.top - first.bottom
  })
  await expect.poll(gap).toBe(2)
  await groups.first().locator('.thread-group-toggle').click()
  await expect(groups.first().locator('.thread-group-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(groups.nth(1)).toHaveCSS('margin-top', '10px')
  await app.close()
})

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

test('welcome: Claudio illustration sits above the title in both themes and compact windows', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  const illustration = page.getByRole('img', { name: 'Claudio, um programador de óculos e fones, sorrindo atrás de um notebook' })
  const heading = page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    for (const size of [{ width: 1240, height: 820 }, { width: 760, height: 600 }]) {
      await page.setViewportSize(size)
      await expect(illustration).toBeVisible()
      const imageBounds = await illustration.boundingBox()
      const titleBounds = await heading.boundingBox()
      const composerBounds = await page.getByLabel('Mensagem', { exact: true }).boundingBox()
      expect(imageBounds).not.toBeNull()
      expect(titleBounds).not.toBeNull()
      expect(composerBounds).not.toBeNull()
      expect(imageBounds!.y).toBeGreaterThanOrEqual(40)
      expect(imageBounds!.y + imageBounds!.height).toBeLessThanOrEqual(titleBounds!.y)
      expect(titleBounds!.y + titleBounds!.height).toBeLessThan(composerBounds!.y)
      await shot(page, `welcome-claudio-${theme}-${size.width}`)
    }
  }

  await pickModel(page, 'Claude Simulado')
  await send(page, 'Olá')
  await expect(illustration).toHaveCount(0)
  await idle(page)
  expect(problems).toEqual([])
  await app.close()
})

test('first run: locked-down renderer, empty state, connecting a provider through the UI', async () => {
  const { app, page, problems } = await launch()

  // Nothing happens outside a project: there is no message box yet, and the main process refuses too.
  const projectHeading = page.getByRole('heading', { name: 'Em qual projeto vamos trabalhar?' })
  await expect(projectHeading).toBeVisible()
  const mascot = page.getByRole('img', { name: 'Claudio, um programador de óculos e fones, sorrindo atrás de um notebook' })
  await expect(mascot).toBeVisible()
  const mascotBounds = await mascot.boundingBox()
  const headingBounds = await projectHeading.boundingBox()
  expect(mascotBounds).not.toBeNull()
  expect(headingBounds).not.toBeNull()
  expect(mascotBounds!.y + mascotBounds!.height).toBeLessThanOrEqual(headingBounds!.y)
  expect(mascotBounds!.width).toBeLessThan(216)
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
  const commandGroup = page.locator('.tool-group').last()
  await expect(commandGroup.locator('.tool-group-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(commandGroup.locator('.tool-group-toggle')).toContainText('1 chamada de ferramenta')
  await expect(commandGroup.locator('.tool-group-toggle')).toContainText('Concluído')
  await commandGroup.locator('.tool-group-toggle').click()
  await page.locator('.tool-row', { hasText: 'run_command' }).last().click()
  await expect(page.locator('.tool-output').last()).toContainText('saida-do-comando')
  await shot(page, '06-ferramentas')

  // Project instructions reached the model, whichever one it is.
  expect(llm.last('openai-chat')!.body.messages[0].content).toContain('Sempre escreva testes.')
  await expect(page.locator('.context-chip', { hasText: 'AGENTS.md' })).toBeVisible()

  // Legacy read-only preferences still refuse without asking, though no longer offered in the composer.
  await page.evaluate(() => window.uni.prefs.set({ permissionMode: 'read-only' }))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Modo: Somente leitura', exact: true })).toBeVisible()
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

test('permission modes: menu, persistence, bypass warning and approved planning', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'chat-mock')
  const mode = () => page.getByRole('button', { name: /^Modo:/ })
  await expect(mode()).toHaveText('Manual')
  await mode().click()
  await expect(page.getByRole('menu', { name: 'Modo', exact: true })).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    await page.setViewportSize({ width: 760, height: 600 })
    const bounds = await page.getByRole('menu', { name: 'Modo', exact: true }).boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760)
  }
  await page.setViewportSize({ width: 1240, height: 820 })
  await page.getByRole('menuitemradio', { name: /^Automático/ }).click()
  await expect(mode()).toHaveText('Automático')
  await send(page, 'ferramenta: write_file {"path":"automatico.txt","content":"ok"}')
  await idle(page)
  expect(await readFile(path.join(workspace, 'automatico.txt'), 'utf8')).toBe('ok')
  await page.reload()
  await expect(mode()).toHaveText('Automático')

  await mode().click()
  await page.getByRole('menuitemradio', { name: /^Ignorar permissões/ }).click()
  await expect(page.getByRole('alertdialog')).toContainText('sem sandbox')
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(mode()).toHaveText('Automático')
  await mode().click()
  await page.getByRole('menuitemradio', { name: /^Ignorar permissões/ }).click()
  await page.getByRole('button', { name: 'Ativar mesmo assim', exact: true }).click()
  await expect(mode()).toHaveText('Ignorar permissões')
  await send(page, 'ferramenta: run_command {"command":"echo bypass-ok"}')
  await idle(page)
  await expect(page.getByText('Executar este comando?')).toHaveCount(0)
  await writeFile(path.join(workspace, '.env'), 'SECRET=not-for-the-model')
  await send(page, 'ferramenta: read_file {"path":".env"}')
  await expect(page.locator('.approval')).toBeVisible({ timeout: 15_000 })
  await page.locator('.approval').getByRole('button', { name: 'Negar', exact: true }).click()
  await idle(page)
  expect(JSON.stringify(llm.requests)).not.toContain('SECRET=not-for-the-model')

  await mode().click()
  await page.getByRole('menuitemradio', { name: /^Plano/ }).click()
  await send(page, 'plano-aprovavel')
  const approval = page.getByRole('group', { name: 'Aprovar este plano?' })
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(mode()).toBeDisabled()
  await expect(approval.getByRole('button', { name: 'Sempre nesta conversa' })).toHaveCount(0)
  await expect(readFile(path.join(workspace, 'plano.txt'))).rejects.toThrow()
  await approval.getByRole('button', { name: 'Aprovar e executar' }).click()
  await idle(page)
  expect(await readFile(path.join(workspace, 'plano.txt'), 'utf8')).toBe('aprovado')
  await expect(page.getByText('Modo Plano · investigar e aguardar aprovação antes de executar', { exact: true })).toBeVisible()
  await rm(path.join(workspace, 'plano.txt'))

  await send(page, 'plano-aprovavel')
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await approval.getByRole('button', { name: 'Negar', exact: true }).click()
  await idle(page)
  await expect(page.getByText('Plano não aprovado. Não execute alterações.', { exact: true })).toBeVisible()
  await expect(readFile(path.join(workspace, 'plano.txt'))).rejects.toThrow()

  await mode().click()
  await page.getByRole('menuitemradio', { name: /^Manual/ }).focus()
  await page.keyboard.press('3')
  await expect(mode()).toHaveText('Aceitar edições')
  await mode().click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Modo', exact: true })).toHaveCount(0)
  expect(problems).toEqual([])
  await app.close()
})

test('tool groups: compact execution, manual expansion, errors and interruption', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'chat-mock')
  const command = 'node -e "setTimeout(() => console.log(123), 4000)"'
  const request = `ferramenta: run_command ${JSON.stringify({ command })}`

  await send(page, request)
  const group = page.locator('.tool-group').last()
  const toggle = group.locator('.tool-group-toggle')
  await expect(toggle).toContainText('Aguardando você', { timeout: 15_000 })
  await expect(page.getByLabel('Mensagem', { exact: true })).toBeFocused()
  await toggle.click()
  await expect(page.getByRole('button', { name: 'Permitir', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('Executando')
  await expect(group.locator('.tool-group-summary')).toContainText('Comando: node -e')
  await expect(group.locator('.tool-row')).toBeHidden()
  await idle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('Concluído')

  await send(page, request)
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await expect(toggle).toContainText('Executando')
  await toggle.click()
  await group.locator('.tool-row').click()
  await idle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('.tool-output')).toHaveText(/123/)
  // Collapsing the group doesn't discard manually opened details.
  await toggle.click()
  await toggle.click()
  await expect(group.locator('.tool-output')).toBeVisible()

  await send(page, 'ferramenta: read_file {"path":"missing-file.txt"}')
  await idle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toContainText('Com falha ou recusa')
  await expect(group.locator('.tool-output.failed')).toBeVisible()

  await send(page, request)
  await page.getByRole('button', { name: 'Permitir', exact: true }).click()
  await expect(toggle).toContainText('Executando')
  await page.getByRole('button', { name: 'Interromper', exact: true }).click()
  await idle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('.tool-output')).toBeVisible()
  await shot(page, 'ferramentas-compactas')
  expect(problems).toEqual([])
  await app.close()
})

test('tool groups: adjacent calls stay together, prose and repeated ids keep their order', async () => {
  await seedProviders()
  const id = '22222222-2222-4222-8222-222222222222'
  const model = { provider: 'custom-c', id: 'chat-mock' }
  const call = (id: string, path: string) => ({ type: 'tool_call', id, name: 'read_file', input: { path } })
  const result = (callId: string, content: string) => ({ type: 'tool_result', callId, content })
  await mkdir(path.join(dataDir, 'threads'), { recursive: true })
  await writeFile(path.join(dataDir, 'threads', `${id}.json`), JSON.stringify({
    id, title: 'Ferramentas agrupadas', createdAt: 1, updatedAt: 1, workspace, model, system: 'test', contextFiles: [], allowedTools: [],
    messages: [
      { id: 'u1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: 'Ler arquivos' }] },
      { id: 'a1', role: 'assistant', createdAt: 2, model, parts: [call('same', 'a.txt'), call('other', 'b.txt'), { type: 'text', text: 'Entre as chamadas.' }, call('third', 'c.txt')] },
      { id: 't1', role: 'tool', createdAt: 3, parts: [result('same', 'primeiro resultado'), result('other', 'segundo resultado'), result('third', 'terceiro resultado')] },
      { id: 'a2', role: 'assistant', createdAt: 4, model, parts: [call('same', 'd.txt')] },
      { id: 't2', role: 'tool', createdAt: 5, parts: [result('same', 'resultado seguinte')] }
    ]
  }))
  const { app, page, problems } = await launch()
  const groups = page.locator('.tool-group')
  await expect(groups).toHaveCount(3)
  await expect(groups.nth(0).locator('.tool-group-toggle')).toContainText('2 chamadas de ferramenta')
  await expect(groups.nth(0).locator('.tool-group-summary')).toHaveText('Leitura de a.txt · Leitura de b.txt')
  await expect(groups.nth(2).locator('.tool-group-summary')).toHaveText('Leitura de d.txt')
  await expect(groups.nth(1).locator('.tool-group-toggle')).toContainText('1 chamada de ferramenta')
  await expect(page.locator('.tool-group-toggle[aria-expanded="true"]')).toHaveCount(0)
  await expect(page.locator('.markdown', { hasText: 'Entre as chamadas.' })).toBeVisible()
  await groups.nth(0).locator('.tool-group-toggle').click()
  await groups.nth(0).locator('.tool-row').first().click()
  await expect(groups.nth(0).locator('.tool-output')).toHaveText('primeiro resultado')
  await groups.nth(2).locator('.tool-group-toggle').click()
  await groups.nth(2).locator('.tool-row').click()
  await expect(groups.nth(2).locator('.tool-output')).toHaveText('resultado seguinte')
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
  await page.locator('.tool-group-toggle').click()
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
  await expect(panel.getByText('Tudo em dia', { exact: true })).toBeVisible()
  await expect(panel.getByText('Nenhuma alteração pendente nesta pasta.')).toBeVisible()
  await expect(panel.getByText('Primeiro commit', { exact: true })).toBeVisible()
  await expect(panel.locator('.section-count')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Gerar mensagem do commit com IA' })).toBeDisabled()
  await expect(panel.locator('.commit-button')).toHaveAccessibleName('Push')
  await expect(panel.locator('.commit-button')).toBeEnabled()
  await expect(panel.locator('.commit-hash').first()).toHaveText(repo('rev-parse', '--short=7', 'HEAD'))
  // Secondary actions live in an accessible menu, not an extra toolbar row.
  const gitMenuButton = panel.getByRole('button', { name: 'Mais ações do Git' })
  await expect(panel.locator('.git-sync')).toHaveCount(0)
  await gitMenuButton.focus()
  await gitMenuButton.press('ArrowDown')
  const gitMenu = panel.getByRole('menu', { name: 'Ações do Git' })
  await expect(gitMenu).toBeVisible()
  await expect(gitMenu.getByRole('menuitem', { name: 'Pull', exact: true })).toBeDisabled()
  await expect(gitMenu.getByRole('menuitem', { name: 'Push', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(gitMenu.getByRole('menuitem', { name: 'Nova branch' })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(gitMenu.getByRole('menuitem', { name: 'Push', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(gitMenu.getByRole('menuitem', { name: 'Fetch', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(gitMenu).toHaveCount(0)
  await expect(gitMenuButton).toBeFocused()
  await gitMenuButton.click()
  await panel.getByLabel('Texto do commit').click({ position: { x: 8, y: 8 } })
  await expect(gitMenu).toHaveCount(0)
  await gitMenuButton.click()
  await gitMenu.getByRole('menuitem', { name: 'Fetch', exact: true }).click()
  await expect(gitMenu).toHaveCount(0)
  await expect(gitMenuButton).toBeEnabled()

  // The refined surfaces stay readable and contained in either system theme.
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(panel.locator('.git-clean')).toBeVisible()
    await expect(panel.locator('.commit-box')).toBeVisible()
    // Keep the empty commit form compact without hiding its controls.
    const commitBox = await panel.locator('.commit-box').boundingBox()
    expect(commitBox!.height).toBeLessThanOrEqual(34)
    const commitButton = await panel.locator('.commit-button').boundingBox()
    expect(commitButton!.height).toBeLessThanOrEqual(30)
    await expect(panel.getByRole('button', { name: 'Gerar mensagem do commit com IA' })).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await shot(page, `painel-premium-${colorScheme}`)
  }
  // With a remote but no upstream yet, the branch can be published in one click.
  await expect(panel.getByRole('button', { name: 'Publicar principal no remoto' })).toBeVisible()
  await panel.locator('.commit-button').click()
  await expect(panel.getByRole('button', { name: 'Fazer commit' })).toBeDisabled()
  expect(repo('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/principal')

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
  await expect(panel.getByRole('heading', { name: 'Preparadas (1)' }).locator('.section-count')).toHaveText('1')
  await expect(panel.getByText('Tudo preparado', { exact: true })).toBeVisible()
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
  await expect(panel.getByRole('heading', { name: 'Preparadas (0)' })).toHaveCount(0)
  await expect(panel.getByLabel('Texto do commit')).toHaveValue('')
  expect(repo('log', '-1', '--format=%s')).toBe('feat(painel): adiciona a segunda linha')
  expect(repo('log', '-1', '--format=%b')).toContain('Mostra o que mudou no README.')

  // The primary action becomes push, but never sends the commit automatically.
  const primaryAction = panel.locator('.commit-button')
  await expect(primaryAction).toHaveAccessibleName('Push')
  await expect(primaryAction).toBeEnabled()
  await expect(primaryAction.locator('kbd')).toHaveText('Ctrl ↵')
  const alignment = await primaryAction.evaluate((button) => {
    const outer = button.getBoundingClientRect()
    const label = button.querySelector('span')!.getBoundingClientRect()
    return Math.abs((label.left + label.right) / 2 - (outer.left + outer.right) / 2)
  })
  expect(alignment).toBeLessThan(2)
  expect(repo('rev-list', '--count', '@{upstream}..HEAD')).toBe('1')

  // Staging another change takes priority over a pending push.
  await writeFile(path.join(workspace, 'outro.txt'), 'outro\n')
  await panel.getByRole('button', { name: 'Atualizar painel' }).click()
  await panel.locator('.git-file', { hasText: 'outro.txt' }).hover()
  await expect(panel.getByRole('button', { name: 'Preparar outro.txt', exact: true })).toBeVisible()
  await expect(primaryAction).toHaveAccessibleName('Push')
  await panel.getByRole('button', { name: 'Preparar outro.txt', exact: true }).click()
  await expect(primaryAction).toHaveAccessibleName('Fazer commit')
  await expect(primaryAction).toBeDisabled()
  await panel.locator('.git-file', { hasText: 'outro.txt' }).hover()
  await panel.getByRole('button', { name: 'Tirar outro.txt do commit', exact: true }).click()
  await expect(primaryAction).toHaveAccessibleName('Push')
  await rm(path.join(workspace, 'outro.txt'))

  await panel.getByLabel('Texto do commit').press('Control+Enter')
  await expect(primaryAction).toHaveAccessibleName('Fazer commit')
  await expect(primaryAction).toBeDisabled()
  expect(repo('rev-parse', '@{upstream}')).toBe(repo('rev-parse', 'HEAD'))

  // New branch, then publish it.
  await panel.getByRole('button', { name: 'Mais ações do Git' }).click()
  await panel.getByRole('menuitem', { name: 'Nova branch' }).click()
  await panel.getByLabel('Nome da nova branch').fill('nome inválido')
  await panel.getByLabel('Nome da nova branch').press('Enter')
  await expect(panel.getByRole('alert')).toContainText('inválido')
  await panel.getByLabel('Nome da nova branch').fill('recurso/painel')
  await panel.getByLabel('Nome da nova branch').press('Enter')
  await expect(panel.getByLabel('Branch', { exact: true })).toHaveValue('recurso/painel')
  expect(repo('branch', '--show-current')).toBe('recurso/painel')
  await expect(panel.getByText('Só local')).toBeVisible()
  await expect(primaryAction).toHaveAccessibleName('Push')
  await primaryAction.click()
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
  // Only web has a remote, as a clone would.
  const webRemote = await mkdtemp(path.join(tmpdir(), 'uni-e2e-remoto-web-'))
  execFileSync('git', ['init', '-q', '--bare', webRemote])
  inRepo(web, 'remote', 'add', 'origin', webRemote)
  inRepo(web, 'push', '-q', '-u', 'origin', 'principal-web')

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
  await webBlock.locator('.repo-toggle').click()
  await webBlock.getByRole('button', { name: 'Preparar todas' }).click()
  await webBlock.getByLabel('Texto do commit').fill('Muda o web')
  await webBlock.getByRole('button', { name: 'Fazer commit' }).click()
  await expect(webBlock.locator('.commit-subject').first()).toHaveText('Muda o web')
  expect(inRepo(web, 'log', '-1', '--format=%s')).toBe('Muda o web')
  expect(inRepo(api, 'log', '-1', '--format=%s')).toBe('Início de principal-api')
  await shot(page, '28-varios-repositorios')

  // Next to the branch, one click syncs. Here it sends the new commit.
  await expect(apiBlock.locator('.sync-button')).toHaveCount(0)
  const syncWeb = webBlock.getByRole('button', { name: /^Sincronizar com origin\/principal-web/ })
  await expect(syncWeb).toHaveAccessibleName('Sincronizar com origin/principal-web: envia 1 commit')
  await shot(page, '34-sincronizar')
  await syncWeb.click()
  await expect(syncWeb).toHaveAccessibleName('Sincronizar com origin/principal-web')
  expect(inRepo(webRemote, 'log', '-1', '--format=%s', 'principal-web')).toBe('Muda o web')

  // And brings what someone else pushed.
  const colleague = await mkdtemp(path.join(tmpdir(), 'uni-e2e-colega-'))
  execFileSync('git', ['clone', '-q', '-b', 'principal-web', webRemote, colleague], { stdio: 'ignore' })
  inRepo(colleague, 'config', 'user.name', 'Colega')
  inRepo(colleague, 'config', 'user.email', 'colega@example.com')
  inRepo(colleague, 'config', 'commit.gpgsign', 'false')
  await writeFile(path.join(colleague, 'colega.txt'), 'oi\n')
  inRepo(colleague, 'add', '.')
  inRepo(colleague, 'commit', '-q', '-m', 'Do colega')
  inRepo(colleague, 'push', '-q')
  await syncWeb.click()
  await expect(webBlock.locator('.commit-subject').first()).toHaveText('Do colega')
  await rm(colleague, { recursive: true, force: true }).catch(() => undefined)
  await rm(webRemote, { recursive: true, force: true }).catch(() => undefined)

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
  await expect(page.locator('.tool-group-toggle')).toBeVisible({ timeout: 15_000 })
  await page.locator('.tool-group-toggle').click()
  await expect(page.locator('.tool-row', { hasText: 'read_file' })).toBeVisible()
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
  await expect(panel).toContainText('de 200mil')
  await expect(panel).toContainText('32mil tokens')
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
  await expect(page.locator('.plan .spin')).toHaveCount(0)
  await expect(page.locator('.plan-status')).toContainText('Nenhuma execução em andamento.')
  await shot(page, '21-tarefas')
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toBeEnabled()
  const pausedTitle = await page.locator('.topbar-title').innerText()
  await page.keyboard.press('Control+n')
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toHaveCount(0)
  await page.locator('.thread-open').filter({ hasText: pausedTitle }).click()
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.locator('.user-text').last()).toHaveText('Continue de onde parou.')
  await idle(page)
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toHaveCount(0)

  // Cancelling preserves unfinished tasks, but no longer makes them look active.
  await send(page, 'plano-interrompivel ferramenta: update_plan {"items":[{"content":"Revisar distribuição","status":"in_progress"},{"content":"Preparar macOS","status":"pending"}]}')
  await expect(page.locator('.plan .spin')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('.run-status')).toContainText('Escrevendo', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Interromper', exact: true }).click()
  await idle(page)
  await expect(page.locator('.plan-status')).toContainText('Execução interrompida.')
  await expect(page.locator('.plan .spin')).toHaveCount(0)
  await expect(page.locator('.run-status')).toHaveCount(0)
  await expect(page.locator('.plan-item')).toHaveCount(2)
  const cancelledThread = await page.evaluate(async () => {
    const summaries = await window.uni.threads.list()
    return window.uni.threads.get(summaries[0].id)
  })
  expect(cancelledThread?.lastRun).toBe('aborted')
  expect(cancelledThread?.plan?.map((item) => item.status)).toEqual(['in_progress', 'pending'])
  await page.reload()
  await expect(page.locator('.plan-status')).toContainText('Execução interrompida.')
  await expect(page.locator('.plan .spin')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.locator('.user-text').last()).toHaveText('Continue de onde parou.')
  await idle(page)
  expect(llm.last('anthropic')!.body.messages.at(-1).content).toEqual([{ type: 'text', text: 'Continue de onde parou.' }])
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toHaveCount(0)

  // Time and tokens count up while the model works.
  await pickModel(page, 'chat-mock')
  await send(page, 'lento')
  await expect(page.locator('.plan')).toHaveCount(0)
  await expect(page.locator('.run-status')).toContainText('Escrevendo', { timeout: 15_000 })
  await expect(page.locator('.run-status')).toContainText('tokens')
  await expect(page.locator('.run-status')).toContainText(/\d+s/)

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

  // Cancelling a tool approval must not send the next queued message automatically.
  await send(page, 'ferramenta: run_command {"command":"echo nao-executar"}')
  await expect(page.getByText('Executar este comando?')).toBeVisible({ timeout: 15_000 })
  await box.fill('fila depois de ferramenta cancelada')
  await box.press('Enter')
  await page.getByRole('button', { name: 'Interromper', exact: true }).click()
  await idle(page)
  await expect(page.getByText('Executar este comando?')).toHaveCount(0)
  await expect(page.locator('.plan-status')).toContainText('Execução interrompida.')
  await expect(page.locator('.queued-text')).toHaveText('fila depois de ferramenta cancelada')
  await expect(page.locator('.user-text').last()).toContainText('ferramenta: run_command')
  await page.getByRole('button', { name: 'Remover da fila: fila depois de ferramenta cancelada' }).click()
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
  await expect(claude).toContainText('200mil')
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
  await expect(row.locator('.picker-figure').nth(2)).toHaveText(/^~\d+s$/, { timeout: 10_000 })
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

test('appearance: sidebar theme controls apply immediately and survive a restart', async () => {
  const { app, page, problems } = await launch()
  const themes = page.getByRole('group', { name: 'Tema da aparência' })
  await expect(themes.getByRole('button', { name: 'Seguir tema do sistema' })).toHaveAttribute('aria-pressed', 'true')
  for (const [label, source, background] of [
    ['Tema claro', 'light', '#f7f7f7'],
    ['Tema escuro', 'dark', '#1e1e1e']
  ] as const) {
    await themes.getByRole('button', { name: label, exact: true }).click()
    await expect(themes.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe(background)
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(source)
  }
  await page.setViewportSize({ width: 760, height: 520 })
  await expect(page.getByRole('button', { name: 'Ajustes', exact: true })).toBeInViewport()
  await expect(themes).toBeInViewport()
  expect(await page.locator('.sidebar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(problems).toEqual([])
  await app.close()

  const restarted = await launch()
  const restored = restarted.page.getByRole('group', { name: 'Tema da aparência' })
  await expect(restored.getByRole('button', { name: 'Tema escuro', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await restarted.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await restored.getByRole('button', { name: 'Seguir tema do sistema' }).click()
  await expect(restored.getByRole('button', { name: 'Seguir tema do sistema' })).toHaveAttribute('aria-pressed', 'true')
  expect(await restarted.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  expect(restarted.problems).toEqual([])
  await restarted.app.close()
})

test('conversation management: new, switch, delete, shortcuts, narrow window, light and dark', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await pickModel(page, 'chat-mock')
  await send(page, 'Conversa número um')
  await idle(page)

  const sidebar = page.getByRole('complementary', { name: 'Navegação principal' })
  await expect(sidebar.getByRole('button', { name: 'Nova conversa', exact: true })).toBeVisible()
  await expect(sidebar.locator('.new-thread kbd')).toHaveText('Ctrl N')
  await expect(sidebar.locator('.sidebar-section-label')).toHaveText('Projetos')
  await expect(sidebar.locator('.thread-group-count')).toHaveText('1')
  await expect(sidebar.locator('.thread-open[aria-current="true"]')).toHaveText('Conversa número um')
  // Secondary actions remain keyboard-accessible without shifting the row on hover.
  const addInProject = sidebar.getByRole('button', { name: `Nova conversa em ${path.basename(workspace)}` })
  await addInProject.focus()
  await expect(addInProject).toBeFocused()
  await expect(addInProject).toHaveCSS('opacity', '1')
  await sidebar.locator('.thread-open').focus()
  await page.keyboard.press('Tab')
  const deleteFirst = sidebar.getByRole('button', { name: 'Apagar “Conversa número um”' })
  await expect(deleteFirst).toBeFocused()
  await expect(deleteFirst).toHaveCSS('opacity', '1')

  // The wider sidebar lets project headings toggle their conversations by mouse or keyboard.
  expect((await sidebar.boundingBox())!.width).toBe(280)
  const projectToggle = sidebar.getByRole('button', { name: `Conversas de ${path.basename(workspace)}`, exact: true })
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true')
  await projectToggle.click()
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.locator('.thread-open').first()).toBeHidden()
  await expect(sidebar.locator('.thread-group-count')).toHaveText('1')
  await projectToggle.press('Enter')
  await expect(sidebar.locator('.thread-open').first()).toBeVisible()
  await projectToggle.press('Space')
  await expect(sidebar.locator('.thread-open').first()).toBeHidden()

  // A new conversation reveals its project, even when the group was collapsed.
  await page.keyboard.press('Control+n')
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('heading', { name: 'Claudio, o queridinho dos devs.' })).toBeVisible()
  await send(page, 'Conversa número dois')
  await idle(page)
  await expect(page.locator('.thread-item')).toHaveCount(2)
  await expect(page.locator('.thread-group')).toHaveCount(1)
  await expect(page.locator('.thread-group-name')).toHaveText(path.basename(workspace))
  await expect(sidebar.locator('.thread-group-count')).toHaveText('2')
  await expect(sidebar.locator('.thread-open[aria-current="true"]')).toHaveText('Conversa número dois')

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
  await projectToggle.click()
  await expect(sidebar.locator('.thread-open', { hasText: 'Conversa número um' })).toBeHidden()
  await expect(sidebar.locator('.thread-open', { hasText: 'Conversa no outro projeto' })).toBeVisible()
  await projectToggle.click()
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

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(sidebar.locator('.thread-item.active')).toHaveCount(1)
    await expect(sidebar.locator('.sidebar-settings')).toBeInViewport()
    expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const selection = await sidebar.locator('.thread-item.active').evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      indicator: getComputedStyle(element, '::before').width
    }))
    expect(selection.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(selection.indicator).toBe('2px')
    await shot(page, colorScheme === 'light' ? '13-claro' : '14-escuro')
  }

  // The smallest window the app allows, with the busiest composer it can show.
  await page.setViewportSize({ width: 760, height: 520 })
  await expect(sidebar.getByRole('button', { name: 'Nova conversa', exact: true })).toBeInViewport()
  await expect(sidebar.getByRole('button', { name: 'Ajustes', exact: true })).toBeInViewport()
  expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
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
  await expect(page.getByRole('tab', { name: /^Git/ })).toBeVisible({ timeout: 15_000 })
  expect(await projectPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
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

test('update settings show installed version without network access in development', async () => {
  const { app, page } = await launch()
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click()
  await page.getByRole('button', { name: 'Atualizações', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Atualizações', exact: true })).toBeVisible()
  await expect(page.getByText('Nesta execução de desenvolvimento', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Verificar atualizações', exact: true })).toHaveCount(0)
  const status = await page.evaluate(() => window.uni.updates.check())
  expect(status.state).toBe('unavailable')
  await page.getByRole('button', { name: 'Voltar à conversa', exact: false }).click()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('uni:event', { type: 'update', status: { state: 'available', currentVersion: '0.1.0', version: '0.2.0' } })
  })
  await expect(page.getByRole('button', { name: 'Baixar atualização', exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('uni:event', { type: 'update', status: { state: 'downloaded', currentVersion: '0.1.0', version: '0.2.0' } })
  })
  await page.getByRole('button', { name: 'Reiniciar e atualizar', exact: true }).click()
  // Synthetic UI events cannot bypass the main process download requirement.
  await expect(page.getByRole('alert')).toContainText('Baixe a atualização antes de instalar.')
  await app.close()
})

test('interactive terminals: multiple shells, live output, hide, resize, and exit', async () => {
  const { app, page, problems } = await launch()
  await expect(page.getByRole('button', { name: 'Abrir painel de terminais' })).toHaveCount(0)
  const denied = await page.evaluate(async () => {
    const thread = (await window.uni.threads.list())[0]
    try { await window.uni.terminal.create(thread.id); return '' } catch (error) { return String(error) }
  })
  expect(denied).toContain('projeto')
  await openProject(app, page)
  await page.getByRole('button', { name: 'Abrir painel de terminais' }).click()
  const panel = page.getByRole('complementary', { name: 'Terminais do projeto' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  const input = panel.locator('.terminal-view:not([hidden]) textarea')
  await expect(input).toBeFocused()
  const first = await page.evaluate(async () => (await window.uni.terminal.list())[0])
  // Commands go through the actual terminal input, not a simulated subprocess.
  await input.fill('echo CLAUDIO_TERMINAL_OK')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(async (id) => (await window.uni.terminal.read(id)).data, first.id)).toContain('CLAUDIO_TERMINAL_OK')
  await expect(panel.locator('.terminal-view:not([hidden]) .xterm-rows')).toContainText('CLAUDIO_TERMINAL_OK')
  const output = await page.evaluate(async (id) => (await window.uni.terminal.read(id)).data, first.id)
  // The shell uses the resolved cwd; Windows TEMP can contain an 8.3 alias such as RUNNER~1.
  expect(output.toLowerCase()).toContain((await realpath(workspace)).toLowerCase())
  await page.getByRole('button', { name: 'Novo terminal', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await expect(panel.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
  await input.fill("node -e \"require('fs').writeFileSync('terminal-child.pid',String(process.pid));setInterval(()=>{},1000)\"")
  await input.press('Enter')
  const pidFile = path.join(workspace, 'terminal-child.pid')
  await expect.poll(() => readFile(pidFile, 'utf8').catch(() => '')).toMatch(/^\d+$/)
  const childPid = Number(await readFile(pidFile, 'utf8'))
  await page.getByRole('button', { name: 'Ocultar terminais', exact: true }).click()
  await expect(panel).toBeHidden()
  expect(await page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(2)
  await page.getByRole('button', { name: 'Abrir painel de terminais' }).click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await panel.getByRole('tab').first().click()
  await expect(input).toBeFocused()
  await page.setViewportSize({ width: 760, height: 600 })
  await expect(panel).toBeVisible()
  const bounds = await panel.boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(761)
  await input.fill('exit')
  await input.press('Enter')
  await expect(panel.getByRole('tab').first()).toContainText('encerrado (0)', { timeout: 15_000 })
  await panel.getByRole('button', { name: `Encerrar ${first.title}`, exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  const remaining = await page.evaluate(async () => (await window.uni.terminal.list())[0])
  await panel.getByRole('button', { name: `Encerrar ${remaining.title}`, exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(0)
  await expect.poll(() => app.evaluate(({}, pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  }, childPid)).toBe(false)
  expect(await page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(0)
  expect(problems).toEqual([])
  await app.close()
})

test('interactive terminals: sessions follow conversations and close when their project changes', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await openProject(app, page)
  await page.getByRole('button', { name: 'Abrir painel de terminais' }).click()
  const panel = page.getByRole('complementary', { name: 'Terminais do projeto' })
  await expect(panel.getByRole('tab')).toHaveCount(1)
  const first = await page.evaluate(async () => (await window.uni.terminal.list())[0])
  // An empty conversation can change project; its old shell must not stay attached to the new folder.
  const another = path.join(dataDir, 'terminal-project')
  await mkdir(another)
  await answerFolderDialog(app, another)
  await page.getByRole('button', { name: 'Abrir outro projeto' }).click()
  await expect.poll(() => page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(0)
  await page.getByRole('button', { name: 'Escolher a pasta do projeto' }).click()
  await page.getByRole('button', { name: 'Abrir terminal', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  const second = await page.evaluate(async () => (await window.uni.terminal.list())[0])
  expect(second.workspace).toBe(another)
  expect(second.id).not.toBe(first.id)
  await page.getByLabel('Mensagem', { exact: true }).click()
  await pickModel(page, 'Claude Simulado')
  await send(page, 'Olá')
  await idle(page)
  const oldThread = second.threadId
  await page.locator('.new-thread').click()
  await expect.poll(() => page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(2)
  const currentThread = await page.evaluate(async () => {
    const sessions = await window.uni.terminal.list()
    return sessions[sessions.length - 1].threadId
  })
  expect(currentThread).not.toBe(oldThread)
  // Returning to the first conversation restores its own tab instead of creating another shell.
  const summaries = await page.evaluate(() => window.uni.threads.list())
  const old = summaries.find((entry) => entry.id === oldThread)!
  await page.getByRole('button', { name: old.title, exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  expect(await page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(2)
  // Removing a conversation also terminates its shells.
  await page.evaluate((id) => window.uni.threads.remove(id), currentThread)
  await expect.poll(() => page.evaluate(async () => (await window.uni.terminal.list()).length)).toBe(1)
  expect(problems).toEqual([])
  await app.close()
})
