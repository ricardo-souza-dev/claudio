import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const SHOTS = process.env.E2E_SHOTS
let llm: MockLlm
let dataDir: string
let workspace: string
const running: { app: ElectronApplication; page: Page; problems: string[] }[] = []

async function launch(): Promise<{ app: ElectronApplication; page: Page; problems: string[] }> {
  const app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, CLAUDIO_DATA_DIR: dataDir } as Record<string, string>
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
      prefs: { memory: 'Prefiro respostas curtas.', lastModel: null, councilVoices: [], permissionMode: 'ask' }
    })
  )
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('Mensagem')
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

const idle = (page: Page) => expect(page.getByRole('button', { name: 'Enviar' })).toBeVisible({ timeout: 20_000 })

test.beforeAll(async () => {
  llm = await startMockLlm()
})
test.afterAll(() => llm.close())
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'uni-e2e-data-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'uni-e2e-work-'))
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

  await expect(page.getByRole('heading', { name: 'Uma conversa. Qualquer modelo.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Conectar o primeiro provedor' })).toBeVisible()
  await shot(page, '01-primeira-abertura')

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
  await page.keyboard.press('Escape')

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
  const { app, page, problems } = await launch()

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
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, workspace)

  await page.getByRole('button', { name: 'Sem pasta' }).click()
  await expect(page.getByRole('button', { name: path.basename(workspace) })).toBeVisible()
  await pickModel(page, 'Claude Simulado')

  // Denied: nothing is written.
  await send(page, 'ferramenta: write_file {"path":"negado.txt","content":"não"}')
  await expect(page.getByText('Alterar este arquivo?')).toBeVisible({ timeout: 15_000 })
  // The card never takes focus: an Enter meant for the message box can't approve anything.
  await expect(page.getByLabel('Mensagem')).toBeFocused()
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

test('council: voices stream side by side and close into one answer', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()

  await pickModel(page, 'Claude Simulado')
  await page.getByRole('radio', { name: 'Conselho' }).click()
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeDisabled()

  await page.getByRole('button', { name: 'Vozes' }).click()
  const dialog = page.getByRole('dialog')
  for (const name of ['gpt-mock', 'Gemini Simulado', 'chat-mock']) {
    await dialog.getByRole('button', { name, exact: false }).first().click()
  }
  await shot(page, '07-escolha-de-vozes')
  await dialog.getByRole('button', { name: /Concluir \(3\)/ }).click()

  await send(page, 'Qual caminho devo seguir?')
  await expect(page.locator('.council-chips')).toBeVisible({ timeout: 20_000 })
  await idle(page)
  await expect(page.locator('.council-count')).toHaveText('3 vozes')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[anthropic]')
  await shot(page, '08-conselho')

  // Each voice stays available to read.
  await page.locator('.council-chips .chip', { hasText: 'Gemini Simulado' }).click()
  await expect(page.locator('.council-voice')).toContainText('[gemini]')
  await shot(page, '09-voz-aberta')

  // The next model inherits one voice.
  await page.getByRole('radio', { name: 'Agente' }).click()
  await pickModel(page, 'chat-mock')
  await send(page, 'E agora?')
  await expect(page.locator('.turn.assistant .markdown').last()).toContainText('[openai-chat]', { timeout: 15_000 })
  await idle(page)
  const history = JSON.stringify(llm.last('openai-chat')!.body.messages)
  expect(history).toContain('[anthropic]')
  expect(history).not.toContain('Several models answered')

  expect(problems).toEqual([])
  await app.close()
})

test('council shows voices live while they are still answering', async () => {
  await seedProviders()
  const { app, page } = await launch()
  await pickModel(page, 'Claude Simulado')
  await page.getByRole('radio', { name: 'Conselho' }).click()
  await page.getByRole('button', { name: 'Vozes' }).click()
  const dialog = page.getByRole('dialog')
  for (const name of ['gpt-mock', 'chat-mock', 'Gemini Simulado']) await dialog.getByRole('button', { name }).first().click()
  await dialog.getByRole('button', { name: /Concluir/ }).click()

  await send(page, 'lento')
  await expect(page.locator('.council-live .voice')).toHaveCount(3, { timeout: 15_000 })
  await expect(page.locator('.voice .markdown').first()).toBeVisible({ timeout: 10_000 })
  await shot(page, '10-conselho-ao-vivo')
  await page.getByRole('button', { name: 'Interromper' }).click()
  await idle(page)
  await expect(page.locator('.council-live')).toHaveCount(0)
  await app.close()
})

test('MCP: a real server becomes available to any model, with approval', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()

  await page.getByRole('button', { name: 'Ajustes' }).click()
  await page.getByRole('button', { name: 'Ferramentas MCP' }).click()

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

test('conversation management: new, switch, delete, shortcuts, narrow window, light and dark', async () => {
  await seedProviders()
  const { app, page, problems } = await launch()
  await pickModel(page, 'chat-mock')
  await send(page, 'Conversa número um')
  await idle(page)

  await page.keyboard.press('Control+n')
  await expect(page.getByRole('heading', { name: 'Uma conversa. Qualquer modelo.' })).toBeVisible()
  await send(page, 'Conversa número dois')
  await idle(page)
  await expect(page.locator('.thread-item')).toHaveCount(2)

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
  await expect(page.getByRole('heading', { name: 'Uma conversa. Qualquer modelo.' })).toBeVisible()

  await send(page, 'Conversa para ver a tela')
  await idle(page)

  await page.emulateMedia({ colorScheme: 'light' })
  await shot(page, '13-claro')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, '14-escuro')

  // The smallest window the app allows, with the busiest composer it can show.
  await page.setViewportSize({ width: 760, height: 520 })
  await page.getByRole('radio', { name: 'Conselho' }).click()
  await page.getByRole('button', { name: 'Vozes' }).click()
  const dialog = page.getByRole('dialog')
  for (const name of ['gpt-mock', 'Gemini Simulado', 'chat-mock']) await dialog.getByRole('button', { name }).first().click()
  await dialog.getByRole('button', { name: /Concluir/ }).click()
  await shot(page, '15-janela-estreita')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeInViewport()

  expect(problems).toEqual([])
  await app.close()
})
