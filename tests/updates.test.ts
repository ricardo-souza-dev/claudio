import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateService } from '../src/main/updates'

function setup(enabled = true) {
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  })
  let busy = false
  const emit = vi.fn()
  const service = new UpdateService(engine, '0.1.0', enabled, () => busy, emit)
  return { engine, service, emit, setBusy: (value: boolean) => { busy = value } }
}

describe('update policy', () => {
  it('does not contact the network outside packaged Windows', async () => {
    const { service, engine } = setup(false)
    await service.check()
    await service.download()
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(service.status().state).toBe('unavailable')
  })
  it('checks once, waits for download consent, then requires install consent', async () => {
    const { service, engine, emit } = setup()
    expect(engine.autoDownload).toBe(false)
    expect(engine.autoInstallOnAppQuit).toBe(false)
    expect(engine.allowPrerelease).toBe(false)
    await service.check()
    await service.check()
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
    engine.emit('update-available', { version: '0.2.0' })
    expect(service.status().version).toBe('0.2.0')
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    await service.download()
    engine.emit('download-progress', { percent: 57.2 })
    expect(service.status().percent).toBe(57)
    engine.emit('update-downloaded', { version: '0.2.0' })
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    service.install()
    expect(engine.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(emit).toHaveBeenCalled()
  })
  it('blocks installation before download or while any agent is working', () => {
    const { service, engine, setBusy } = setup()
    expect(() => service.install()).toThrow('Baixe')
    engine.emit('update-downloaded', { version: '0.2.0' })
    setBusy(true)
    expect(() => service.install()).toThrow('Espere')
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    setBusy(false)
    service.install()
    expect(engine.quitAndInstall).toHaveBeenCalledTimes(1)
  })
  it('recovers from offline checks without exposing internal errors', async () => {
    const { service, engine } = setup()
    engine.checkForUpdates.mockRejectedValueOnce(new Error('private URL'))
    expect((await service.check()).state).toBe('error')
    expect(service.status().message).not.toContain('private URL')
    engine.checkForUpdates.mockImplementationOnce(async () => { engine.emit('update-not-available') })
    expect((await service.check()).state).toBe('idle')
  })
  it('handles failed downloads and protects snapshots from mutation', async () => {
    const { service, engine } = setup()
    engine.emit('update-available', { version: '0.2.0' })
    engine.downloadUpdate.mockRejectedValueOnce(new Error('offline'))
    expect((await service.download()).state).toBe('error')
    const snapshot = service.status()
    snapshot.state = 'downloaded'
    expect(service.status().state).toBe('error')
  })
})
