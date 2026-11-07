import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/types'
import { api } from './store'
import { remoteErrorMessage } from './format'

export function Updates({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const off = api.on((event) => { if (event.type === 'update') setStatus(event.status) })
    void api.updates.status().then(setStatus).catch(() => setError('Não foi possível consultar a versão.'))
    return off
  }, [])
  if (!status || (compact && !['available', 'downloading', 'downloaded'].includes(status.state))) return null
  const run = async (action: () => Promise<unknown>) => {
    setError('')
    try { await action() } catch (failure) { setError(remoteErrorMessage(failure)) }
  }
  return (
    <section className={compact ? 'update-banner' : 'update-settings'} aria-label="Atualizações" aria-live="polite">
      {!compact && <><h2>Atualizações</h2><p>Claudio {status.currentVersion}</p></>}
      {status.state === 'unavailable' && <p>Atualizações automáticas estão disponíveis no app instalado para Windows. Nesta execução de desenvolvimento, elas estão desativadas.</p>}
      {status.state === 'idle' && <p>Nenhuma atualização pendente. Verifique para consultar a versão publicada.</p>}
      {status.state === 'checking' && <p>Verificando atualizações…</p>}
      {status.state === 'available' && <><span>Claudio {status.version} disponível. </span><button className="button" onClick={() => void run(() => api.updates.download())}>Baixar atualização</button></>}
      {status.state === 'downloading' && <span>Baixando atualização… {status.percent ?? 0}%</span>}
      {status.state === 'downloaded' && <><span>Atualização pronta. Termine suas execuções antes de reiniciar. </span><button className="button" onClick={() => void run(() => api.updates.install())}>Reiniciar e atualizar</button></>}
      {status.state === 'error' && <p role="alert">{status.message}</p>}
      {!compact && ['idle', 'error', 'available'].includes(status.state) && <button className="button" onClick={() => void run(() => api.updates.check())}>Verificar atualizações</button>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
