import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The static website intentionally ships plain browser JavaScript.
import { windowsRelease, loadRelease } from '../site/releases.js'

const url = 'https://github.com/ricardo-souza-dev/claudio/releases/download/v0.1.0/Claudio-Setup-0.1.0-x64.exe'
function release() {
  return { tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [{ name: 'Claudio-Setup-0.1.0-x64.exe', browser_download_url: url, size: 104857600 }] }
}
function doc() {
  const elements = { 'release-status': { textContent: '' }, download: { hidden: true, href: '' } }
  return { elements, getElementById: (id: keyof typeof elements) => elements[id] }
}
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
    expect(document.elements['release-status'].textContent).toContain('100 MB')
  })
  it('does not invent a download before the first release', async () => {
    const document = doc()
    await loadRelease(document, vi.fn(async () => ({ status: 404 })))
    expect(document.elements.download.hidden).toBe(true)
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
