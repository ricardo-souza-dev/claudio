// Generate a committed social preview. Deploying the static site needs no Electron.
import { _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporary = await mkdtemp(path.join(tmpdir(), 'claudio-social-'))
let app
try {
  const entry = path.join(temporary, 'main.cjs')
  await writeFile(entry, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1200, height: 630, show: false, webPreferences: { sandbox: true } });
  window.loadURL('about:blank');
});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [entry, `--user-data-dir=${path.join(temporary, 'data')}`], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1200, height: 630 })
  const font = (await readFile('site/fonts/sans-medium.woff2')).toString('base64')
  await page.setContent(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>
@font-face{font-family:Plex;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:500}
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#0c0e12;color:#eef0f6;font-family:Plex,sans-serif;padding:50px 70px;overflow:hidden;position:relative}
body:before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 80% 70%,#2e436944,transparent 65%);z-index:-1}.brand{font-size:31px;letter-spacing:-1.5px;display:flex;align-items:center;gap:14px}.tag{font-size:11px;color:#94a5c2;border:1px solid #ffffff24;border-radius:5px;padding:3px 9px;letter-spacing:0;margin-left:5px}.eyebrow{font-size:11px;letter-spacing:2px;color:#98abc9;margin:48px 0 15px}h1{font-size:86px;letter-spacing:-5px;font-weight:500;line-height:1.06;margin:0}h1 span{color:#b2c8ff}.bottom{margin-top:34px;font-size:18px;color:#929fb4}.symbol{position:absolute;right:155px;top:180px;color:#a7c1fc}.footer{position:absolute;bottom:40px;left:70px;right:70px;display:flex;justify-content:space-between;border-top:1px solid #ffffff16;padding-top:18px;color:#879ab8;font-size:12px}
</style><div class="brand"><svg width="24" height="34" viewBox="0 0 24 34"><path d="M12 0v34" stroke="#b2c8ff" stroke-width="1.5"/><circle cx="12" cy="17" r="6" fill="#b2c8ff"/></svg>claudio <span class="tag">PRÉVIA PARA WINDOWS</span></div><p class="eyebrow">SUA CONVERSA. QUALQUER MODELO.</p><h1>Troque o modelo.<br>Não a <span>conversa.</span></h1><div class="bottom">Seu projeto, memória e ferramentas vão com você.</div><svg class="symbol" width="90" height="260" viewBox="0 0 90 260"><path d="M45 0v260" stroke="currentColor" stroke-opacity=".3"/><circle cx="45" cy="130" r="24" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-opacity=".5"/><circle cx="45" cy="130" r="8" fill="currentColor"/></svg><div class="footer"><span>UM PROJETO INDEPENDENTE.</span><span>claudio-mu.vercel.app ↗</span></div></html>`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: 'site/social.png' })
  console.log('Imagem social pronta em site/social.png')
} finally {
  if (app) await app.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
