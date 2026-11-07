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
    const files: Record<string, [string, string]> = { '/': ['site/index.html', 'text/html'], '/style.css': ['site/style.css', 'text/css'], '/releases.js': ['site/releases.js', 'text/javascript'], '/favicon.svg': ['site/favicon.svg', 'image/svg+xml'], '/facts.json': ['', 'application/json'] }
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
    let available = true
    await page.route('https://api.github.com/**', (route) => route.fulfill({ status: available ? 200 : 404, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.1.0', assets: [{ name: 'Claudio-Setup-0.1.0-x64.exe', size: 104857600, browser_download_url: 'https://github.com/ricardo-souza-dev/claudio/releases/download/v0.1.0/Claudio-Setup-0.1.0-x64.exe' }] }) }))
    await page.goto(url)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Troque o modelo.Não a conversa.')
    await expect(page.locator('#download')).toBeVisible()
    await expect(page.locator('#download')).toHaveAttribute('href', /github.com\/ricardo-souza-dev\/claudio\/releases\/download\//)
    await page.getByText('Como o aplicativo é atualizado?', { exact: true }).click()
    await expect(page.getByText('O app instalado consulta novas versões', { exact: false })).toBeVisible()
    await page.screenshot({ path: 'test-results/site-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/site-mobile.png', fullPage: true })
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
