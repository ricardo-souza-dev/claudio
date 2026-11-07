import { cp, mkdir, rm } from 'node:fs/promises'

await rm('dist/site', { recursive: true, force: true })
await mkdir('dist/site', { recursive: true })
await cp('site', 'dist/site', { recursive: true })
await cp('resources/icon.png', 'dist/site/icon.png')
console.log('Site pronto em dist/site')
