import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The static website intentionally ships plain browser JavaScript.
import { windowsRelease, loadRelease } from '../site/releases.js'

const url = 'https://github.com/ricardo-souza-dev/claudio/releases/download/v0.1.0/Claudio-Setup-0.1.0-x64.exe'
function release() {
  return { tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [{ name: 'Claudio-Setup-0.1.0-x64.exe', browser_download_url: url, size: 104857600 }] }
}
function doc() {
  const elements = { 'release-status': { textContent: '' }, download: { hidden: true, href: '' }, 'hero-download': { href: '#downloads' } }
  return { elements, getElementById: (id: keyof typeof elements) => elements[id] }
}
describe('website presentation', () => {
  it('ships local fonts, their license and a full-size social preview', async () => {
    const html = await readFile('site/index.html', 'utf8')
    const css = await readFile('site/style.css', 'utf8')
    expect(html).toContain('INTERFACE REAL · DADOS FICTÍCIOS')
    expect(html).toContain('src="./app-screenshot.png"')
    expect(html).not.toContain('class="mock-app"')
    const screenshot = await readFile('site/app-screenshot.png')
    expect(screenshot.subarray(1, 4).toString()).toBe('PNG')
    expect(screenshot.readUInt32BE(16)).toBe(1400)
    expect(screenshot.readUInt32BE(20)).toBe(820)
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('property="og:image" content="https://claudio-mu.vercel.app/social.png"')
    expect(css).toContain('prefers-reduced-motion:reduce')
    expect(css).not.toMatch(/https?:\/\//)
    for (const font of ['regular', 'medium', 'semibold']) {
      const bytes = await readFile(`site/fonts/sans-${font}.woff2`)
      expect(bytes.toString('ascii', 0, 4)).toBe('wOF2')
    }
    expect(await readFile('site/fonts/LICENSE.txt', 'utf8')).toContain('SIL OPEN FONT LICENSE')
    const image = await readFile('site/social.png')
    expect(image.subarray(1, 4).toString()).toBe('PNG')
    expect(image.readUInt32BE(16)).toBe(1200)
    expect(image.readUInt32BE(20)).toBe(630)
  })
})

describe('website downloads', () => {
  it('accepts only Windows installers in this repository', () => {
    expect(windowsRelease(release())).toEqual({ version: 'v0.1.0', url, size: 100 })
    for (const badUrl of ['javascript:alert(1)', url.replace('github.com', 'evil.test'), url.replace('ricardo-souza-dev', 'someone'), `${url}?redirect=1`]) {
      const data = release()
      data.assets[0].browser_download_url = badUrl
      expect(windowsRelease(data)).toBeNull()
    }
    expect(windowsRelease({ ...release(), draft: true })).toBeNull()
    expect(windowsRelease({ ...release(), prerelease: true })).toBeNull()
    expect(windowsRelease({ ...release(), assets: [] })).toBeNull()
  })
  it('shows a real download only when a release exists', async () => {
    const document = doc()
    await loadRelease(document, vi.fn(async () => ({ ok: true, json: async () => release() })))
    expect(document.elements.download.hidden).toBe(false)
    expect(document.elements.download.href).toBe(url)
    expect(document.elements['hero-download'].href).toBe(url)
    expect(document.elements['release-status'].textContent).toContain('100 MB')
  })
  it('does not invent a download before the first release', async () => {
    const document = doc()
    await loadRelease(document, vi.fn(async () => ({ status: 404 })))
    expect(document.elements.download.hidden).toBe(true)
    expect(document.elements['hero-download'].href).toBe('#downloads')
    expect(document.elements['release-status'].textContent).toContain('ainda não foi publicado')
  })
  it('keeps the GitHub fallback on API failures or missing installers', async () => {
    for (const request of [async () => { throw new Error('offline') }, async () => ({ ok: false, status: 403 }), async () => ({ ok: true, json: async () => ({ ...release(), assets: [] }) })]) {
      const document = doc()
      await loadRelease(document, request)
      expect(document.elements.download.hidden).toBe(true)
      expect(document.elements['release-status'].textContent).toContain('GitHub')
    }
  })
})
