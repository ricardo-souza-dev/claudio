// Release data is untrusted. Only an installer belonging to this repository is linked.
export function windowsRelease(release) {
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') return null
  const asset = release.assets?.find((item) => /^Claudio-Setup-\d+\.\d+\.\d+-x64\.exe$/.test(item.name))
  if (!asset || typeof asset.browser_download_url !== 'string') return null
  try {
    const url = new URL(asset.browser_download_url)
    const prefix = `/ricardo-souza-dev/claudio/releases/download/${encodeURIComponent(release.tag_name)}/`
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || url.pathname !== `${prefix}${asset.name}` || url.search || url.hash) return null
    return { version: release.tag_name, url: url.href, size: Math.round(asset.size / 1024 / 1024) }
  } catch { return null }
}

export async function loadRelease(doc = document, request = fetch) {
  const status = doc.getElementById('release-status')
  const download = doc.getElementById('download')
  const heroDownload = doc.getElementById('hero-download')
  try {
    const response = await request('https://api.github.com/repos/ricardo-souza-dev/claudio/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) })
    if (response.status === 404) {
      status.textContent = 'O primeiro instalador ainda não foi publicado. Acompanhe os lançamentos no GitHub.'
      return
    }
    if (!response.ok) throw new Error('Release unavailable')
    const release = windowsRelease(await response.json())
    if (!release) {
      status.textContent = 'Ainda não há instalador Windows x64 nesta versão. Consulte os lançamentos no GitHub.'
      return
    }
    status.textContent = `${release.version} · ${release.size} MB · versão de testes`
    download.href = release.url
    download.hidden = false
    if (heroDownload) heroDownload.href = release.url
  } catch {
    status.textContent = 'Não foi possível consultar o download agora. Confira os lançamentos no GitHub.'
  }
}

if (typeof document !== 'undefined') void loadRelease()
