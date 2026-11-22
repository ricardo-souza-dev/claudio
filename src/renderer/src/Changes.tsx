import { FilePen, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Checkpoint, CheckpointPreview, CheckpointPreviewFile, RestoreResult } from '../../shared/types'
import { remoteErrorMessage } from './format'
import { api } from './store'

interface ChangesProps {
  threadId: string
  checkpoint: Checkpoint
  /** The agent could still be writing, so nothing can be put back yet. */
  running: boolean
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function describe(file: CheckpointPreviewFile): string {
  if (file.restored && file.state !== 'ready') return 'desfeito'
  if (file.state === 'changed') return 'mudou depois do agente: desfazer apaga o que você escreveu'
  if (file.state === 'unchanged') return 'já está como antes'
  return file.kind === 'created' ? 'criado: desfazer apaga o arquivo' : 'alterado'
}

/** What the agent changed in response to one message, with a way to put it back. */
export function Changes({ threadId, checkpoint, running }: ChangesProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<RestoreResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const loaded = await api.checkpoints.preview(threadId, checkpoint.id)
      setPreview(loaded)
      // What is safe to undo starts selected. A file the person changed since never does.
      setSelected(new Set(loaded.files.filter((file) => file.state === 'ready' && !file.restored).map((file) => file.path)))
      setProblem(null)
    } catch (error) {
      setProblem(remoteErrorMessage(error))
    }
  }, [threadId, checkpoint.id])

  useEffect(() => {
    if (open) void load()
  }, [open, load, checkpoint])

  const total = checkpoint.files.length
  const allRestored = checkpoint.files.every((file) => file.restored)
  const toggle = (path: string): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const undo = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setProblem(null)
    try {
      // Ticking a file the person changed since is the confirmation to overwrite it.
      const selection = preview.files.filter((file) => selected.has(file.path)).map((file) => ({ path: file.path, force: file.state === 'changed' }))
      const outcome = await api.checkpoints.restore(threadId, checkpoint.id, selection)
      setResults(outcome.results)
      await load()
    } catch (error) {
      setProblem(remoteErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const restoredNow = results?.filter((result) => result.outcome === 'restored').length ?? 0
  const failures = results?.filter((result) => result.outcome === 'failed' || result.outcome === 'changed') ?? []

  return (
    <section className="changes" aria-label="Alterações do agente">
      <div className="changes-head">
        {allRestored ? <Undo2 size={14} aria-hidden /> : <FilePen size={14} aria-hidden />}
        <span>{allRestored ? `Alterações desfeitas (${plural(total, 'arquivo', 'arquivos')})` : `Alterou ${plural(total, 'arquivo', 'arquivos')} nesta resposta`}</span>
        {!allRestored && (
          <button className="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Fechar' : 'Revisar e desfazer'}
          </button>
        )}
      </div>
      {checkpoint.commands > 0 && !allRestored && (
        <p className="hint">
          Esta resposta também rodou {plural(checkpoint.commands, 'comando', 'comandos')}. O que {checkpoint.commands === 1 ? 'ele mudou' : 'eles mudaram'} não pode ser desfeito aqui.
        </p>
      )}
      {open && !allRestored && (
        <div className="changes-body">
          {preview && (
            <ul className="changes-list">
              {preview.files.map((file) => {
                const disabled = file.state === 'unchanged' || file.restored || busy
                return (
                  <li key={file.path} className={file.state === 'changed' && !file.restored ? 'conflict' : undefined}>
                    <label>
                      <input type="checkbox" checked={selected.has(file.path)} disabled={disabled} onChange={() => toggle(file.path)} aria-label={`Desfazer ${file.path}`} />
                      <span className="changes-path">{file.path}</span>
                    </label>
                    <small>{describe(file)}</small>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="row-actions">
            <button className="button primary" disabled={busy || running || selected.size === 0} onClick={() => void undo()}>
              <Undo2 size={13} aria-hidden /> {busy ? 'Desfazendo' : `Desfazer ${plural(selected.size, 'arquivo', 'arquivos')}`}
            </button>
            {running && <span className="hint">Aguarde a resposta terminar.</span>}
          </div>
          {results && restoredNow > 0 && <p className="result ok">{plural(restoredNow, 'arquivo restaurado', 'arquivos restaurados')}. O próximo modelo será avisado.</p>}
          {failures.map((failure) => (
            <p className="result failed" key={failure.path}>
              {failure.path}: {failure.outcome === 'changed' ? 'mudou depois do agente e foi mantido.' : failure.error}
            </p>
          ))}
          {problem && <p className="result failed">{problem}</p>}
        </div>
      )}
    </section>
  )
}
