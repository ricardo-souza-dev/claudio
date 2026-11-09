import { ArrowUp, ChevronDown, FileText, Paperclip, Square, X } from 'lucide-react'
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { EFFORT_LEVELS, modelKey, type Effort, type ModelInfo, type ModelRef, type OutgoingAttachment, type PermissionMode } from '../../shared/types'
import { EFFORT_LABELS, formatFileSize, modelLabel } from './format'
import { PermissionPicker } from './PermissionPicker'

export interface ComposerHandle {
  focus(): void
  /** What is being written, for estimates about the next message. */
  draft(): { text: string; hasImages: boolean }
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Sent to models as they are. Anything else must be readable as text. */
const NATIVE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
    reader.readAsDataURL(file)
  })
}

interface Pending extends OutgoingAttachment {
  id: number
  size: number
}

interface ComposerProps {
  model: ModelRef | null
  autoModel: boolean
  models: ModelInfo[]
  effort: Effort | null
  permission: PermissionMode
  running: boolean
  hasTools: boolean
  meter: ReactNode
  onPickModel(): void
  onEffortChange(effort: Effort | null): void
  onPermissionChange(mode: PermissionMode): void
  onSend(text: string, attachments: OutgoingAttachment[]): void
  onQueue(text: string, attachments: OutgoingAttachment[]): void
  onStop(): void
}

const MAX_HEIGHT = 240

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { model, autoModel, models, effort, permission, running, hasTools } = props
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [attachProblem, setAttachProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)

  useImperativeHandle(
    ref,
    () => ({
      focus: () => area.current?.focus(),
      draft: () => ({ text, hasImages: pending.some((file) => file.mediaType.startsWith('image/')) })
    }),
    [text, pending]
  )

  const attach = async (files: File[]): Promise<void> => {
    setAttachProblem(null)
    const added: Pending[] = []
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachProblem(`“${file.name}” é grande demais para anexar.`)
        continue
      }
      // Caught here so the message being written isn't lost to an error after sending.
      if (!NATIVE_TYPES.has(file.type) && new Uint8Array(await file.slice(0, 8000).arrayBuffer()).includes(0)) {
        setAttachProblem(`“${file.name}” é um arquivo binário. Anexe imagens, PDFs ou arquivos de texto.`)
        continue
      }
      // A pasted screenshot arrives with a generic name.
      const name = file.name && file.name !== 'image.png' ? file.name : `print-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`
      added.push({ id: nextId.current++, name, mediaType: file.type || 'text/plain', data: await readAsBase64(file), size: file.size })
    }
    setPending((current) => [...current, ...added])
  }

  const onPaste = (event: ClipboardEvent): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    void attach(files)
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    void attach([...event.dataTransfer.files])
  }

  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const auto = autoModel
  const blocker = !model && !auto ? 'Escolha um modelo' : null
  const hasText = text.trim().length > 0
  const hasContent = hasText || pending.length > 0
  const canSend = hasContent && !blocker

  const submit = (): void => {
    if (!canSend) return
    const files = pending.map(({ name, mediaType, data }) => ({ name, mediaType, data }))
    if (running) props.onQueue(text, files)
    else props.onSend(text, files)
    setText('')
    setPending([])
    setAttachProblem(null)
  }

  // Under "Automático" the model isn't known yet, so every level is offered and each model takes its closest.
  const current = models.find((entry) => model && modelKey(entry) === modelKey(model))
  const efforts = auto ? EFFORT_LEVELS : (current?.efforts ?? [])
  const placeholder = running ? 'Enter adiciona à fila' : 'O que vamos fazer?'

  return (
    <div className={`composer${running ? ' running' : ''}`}>
      <span className={`node composer-node${running ? ' pulse' : ''}`} aria-hidden />
      <div
        className={`composer-box${dragging ? ' dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {pending.length > 0 && (
          <ul className="attachments" aria-label="Anexos">
            {pending.map((file) => (
              <li key={file.id} className="attachment" title={`${file.name} · ${formatFileSize(file.size)}`}>
                {file.mediaType.startsWith('image/') ? <img src={`data:${file.mediaType};base64,${file.data}`} alt="" /> : <FileText size={14} aria-hidden />}
                <span className="attachment-name">{file.name}</span>
                <button aria-label={`Remover anexo ${file.name}`} onClick={() => setPending((current) => current.filter((entry) => entry.id !== file.id))}>
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Mensagem"
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-bar">
          <button className="icon-button" aria-label="Anexar arquivos" title="Anexar arquivos. Você também pode colar um print ou arrastar para cá." onClick={() => picker.current?.click()}>
            <Paperclip size={15} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Escolher arquivos"
            onChange={(event) => {
              void attach([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          <div className="composer-spacer" />

          {running && hasContent ? (
            <button className="send" onClick={submit} aria-label="Adicionar à fila" title="Adicionar à fila (Enter)">
              <ArrowUp size={16} />
            </button>
          ) : running ? (
            <button className="send stop" onClick={props.onStop} aria-label="Interromper" title="Interromper">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send" disabled={!canSend} onClick={submit} aria-label="Enviar" title={blocker ?? 'Enviar (Enter)'}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>

      {attachProblem && (
        <p className="result failed attach-problem" role="alert">
          {attachProblem}
        </p>
      )}

      <div className="composer-status">
        <button className="model-chip" onClick={props.onPickModel} title="Trocar de modelo (Ctrl+K)">
          {auto && <span className="model-chip-auto">Automático</span>}
          {(!auto || model) && <span className="model-chip-label">{model ? modelLabel(model, models) : 'Escolher modelo'}</span>}
          <ChevronDown size={13} aria-hidden />
        </button>

        {efforts.length > 0 && (
          <select
            className="status-select"
            aria-label="Força do modelo"
            title="Força do modelo: mais força costuma dar mais qualidade, com mais tempo e custo"
            value={effort ?? ''}
            onChange={(event) => props.onEffortChange((event.target.value || null) as Effort | null)}
          >
            <option value="">Força padrão</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABELS[level]}
              </option>
            ))}
          </select>
        )}

        {hasTools && (
          <PermissionPicker value={permission} disabled={running} onChange={props.onPermissionChange} />
        )}

        {props.meter}
      </div>
    </div>
  )
})
