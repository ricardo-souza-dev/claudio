import type { UpdateStatus } from '../shared/types'

/** Narrow boundary so update policy can be tested without contacting GitHub. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export class UpdateService {
  private current: UpdateStatus
  private installing = false

  get isInstalling(): boolean { return this.installing }

  constructor(private engine: UpdateEngine, version: string, enabled: boolean, private busy: () => boolean, private emit: (status: UpdateStatus) => void) {
    this.current = { state: enabled ? 'idle' : 'unavailable', currentVersion: version }
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.allowPrerelease = false
    engine.on('update-available', (info: { version: string }) => this.set({ state: 'available', version: info.version }))
    engine.on('update-not-available', () => this.set({ state: 'idle' }))
    engine.on('download-progress', (progress: { percent: number }) => this.set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }))
    engine.on('update-downloaded', (info: { version: string }) => this.set({ state: 'downloaded', version: info.version }))
    engine.on('error', () => this.fail())
  }

  status(): UpdateStatus { return { ...this.current } }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { currentVersion: this.current.currentVersion, ...patch } as UpdateStatus
    this.emit(this.status())
  }

  private fail(): void {
    this.set({ state: 'error', message: 'Não foi possível atualizar. Confira sua conexão e tente novamente. Você também pode baixar o instalador pelo site.' })
  }

  async check(): Promise<UpdateStatus> {
    if (!['idle', 'error', 'available'].includes(this.current.state)) return this.status()
    this.set({ state: 'checking' })
    try { await this.engine.checkForUpdates() } catch { this.fail() }
    return this.status()
  }

  async download(): Promise<UpdateStatus> {
    if (this.current.state !== 'available') return this.status()
    this.set({ state: 'downloading', version: this.current.version, percent: 0 })
    try { await this.engine.downloadUpdate() } catch { this.fail() }
    return this.status()
  }

  install(): void {
    if (this.current.state !== 'downloaded') throw new Error('Baixe a atualização antes de instalar.')
    if (this.busy()) throw new Error('Espere todas as execuções terminarem antes de atualizar.')
    if (this.installing) return
    this.installing = true
    try { this.engine.quitAndInstall(false, true) } catch (error) { this.installing = false; throw error }
  }
}
