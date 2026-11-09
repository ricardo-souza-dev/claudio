import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

let server: Server
let url: string

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const name = new URL(request.url!, 'http://localhost').pathname
    const files: Record<string, [string, string]> = {
      '/': ['site/index.html', 'text/html'],
      '/style.css': ['site/style.css', 'text/css'],
      '/releases.js': ['site/releases.js', 'text/javascript'],
      '/experience.js': ['site/experience.js', 'text/javascript'],
      '/favicon.svg': ['site/favicon.svg', 'image/svg+xml'],
      '/social.png': ['site/social.png', 'image/png'],
      '/app-screenshot.png': ['site/app-screenshot.png', 'image/png'],
      '/fonts/sans-regular.woff2': ['site/fonts/sans-regular.woff2', 'font/woff2'],
      '/fonts/sans-medium.woff2': ['site/fonts/sans-medium.woff2', 'font/woff2'],
      '/fonts/sans-semibold.woff2': ['site/fonts/sans-semibold.woff2', 'font/woff2'],
      '/facts.json': ['', 'application/json']
    }
    const file = files[name]
    if (!file) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', file[1])
    response.end(file[0] ? await readFile(file[0]) : '{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
test.afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

test('website: release download, mobile layout and unavailable release', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'claudio-site-'))
  const app = await electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...process.env, ELECTRON_RENDERER_URL: '', CLAUDIO_DATA_DIR: dataDir, CLAUDIO_MODEL_FACTS_URL: `${url}/facts.json` } as Record<string, string> })
  try {
    await app.firstWindow()
    const nextWindow = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }) => { void new BrowserWindow({ width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }).loadURL('about:blank') })
    const page = await nextWindow
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (response.url().startsWith(`${url}/`) && response.status() >= 400) errors.push(`Missing site asset: ${response.url()}`)
    })
    let available = true
    await page.route('https://api.github.com/**', (route) => route.fulfill({ status: available ? 200 : 404, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.1.0', assets: [{ name: 'Claudio-Setup-0.1.0-x64.exe', size: 104857600, browser_download_url: 'https://github.com/ricardo-souza-dev/claudio/releases/download/v0.1.0/Claudio-Setup-0.1.0-x64.exe' }] }) }))
    await page.goto(url)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Troque o modelo.Não a conversa.')
    await expect(page.locator('#download')).toBeVisible()
    await expect(page.locator('#download')).toHaveAttribute('href', /github.com\/ricardo-souza-dev\/claudio\/releases\/download\//)
    const screenshot = page.getByRole('img', { name: /Interface do Claudio em tema escuro/ })
    await expect(screenshot).toBeVisible()
    await expect.poll(() => screenshot.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1400 && image.naturalHeight === 820)).toBe(true)
    await expect(page.getByText('INTERFACE REAL · DADOS FICTÍCIOS', { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.fonts.check('400 16px Plex') && document.fonts.check('500 16px Plex'))).toBe(true)
    await expect(page.getByRole('tab', { name: '01 Abra seu projeto' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '03 Troque sem recomeçar' }).click()
    await expect(page.getByRole('tabpanel')).toContainText('Outro modelo assume')
    await expect(page.locator('#demonstracao')).toHaveAttribute('data-active-step', '2')
    await page.getByRole('tab', { name: '03 Troque sem recomeçar' }).press('ArrowLeft')
    await expect(page.getByRole('tab', { name: '02 Construa o contexto' })).toBeFocused()
    await expect(page.getByRole('tabpanel')).toContainText('Arquivos lidos')
    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: '01 Abra seu projeto' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab', { name: '03 Troque sem recomeçar' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'step-switch')
    await page.locator('summary').filter({ hasText: 'Como o aplicativo é atualizado?' }).click()
    await expect(page.getByText('O app instalado consulta novas versões', { exact: false })).toBeVisible()
    await page.locator('summary').filter({ hasText: 'Como o aplicativo é atualizado?' }).click()
    await page.screenshot({ path: 'test-results/site-desktop.png', fullPage: true })
    for (const width of [320, 390, 620, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      const layout = await page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= window.innerWidth,
        overflowing: Array.from(document.querySelectorAll('body *')).filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).map((element) => element.className)
      }))
      expect(layout.fits, `no horizontal overflow at ${width}px: ${layout.overflowing.join(', ')}`).toBe(true)
      const bounds = await screenshot.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBeLessThanOrEqual(width)
      expect(bounds!.width / bounds!.height).toBeCloseTo(1400 / 820, 2)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: '02 Construa o contexto' }).click()
    await expect(page.getByRole('tabpanel')).toContainText('Arquivos lidos')
    await page.screenshot({ path: 'test-results/site-mobile.png', fullPage: true })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto')
    await page.getByRole('link', { name: 'Baixar Claudio', exact: false }).click()
    await expect(page.locator('#downloads')).toBeInViewport()
    await expect(page.locator('#download')).toBeVisible()
    expect((await page.request.get(`${url}/social.png`)).ok()).toBe(true)
    available = false
    await page.reload()
    await expect(page.locator('#release-status')).toContainText('ainda não foi publicado')
    await expect(page.locator('#download')).toBeHidden()
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
