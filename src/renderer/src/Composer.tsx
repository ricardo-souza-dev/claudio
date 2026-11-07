import { ArrowUp, ChevronDown, Plus, Square, X } from 'lucide-react'
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { modelKey, type ModelInfo, type ModelRef, type PermissionMode } from '../../shared/types'
import { modelLabel } from './format'

export type ComposerMode = 'agent' | 'council'

export interface ComposerHandle {
  focus(): void
}

interface ComposerProps {
  mode: ComposerMode
  model: ModelRef | null
  voices: ModelRef[]
  models: ModelInfo[]
  permission: PermissionMode
  running: boolean
  hasTools: boolean
  onModeChange(mode: ComposerMode): void
  onPickModel(): void
  onPickVoices(): void
  onRemoveVoice(voice: ModelRef): void
  onPermissionChange(mode: PermissionMode): void
  onSend(text: string): void
  onStop(): void
}

const MAX_HEIGHT = 240

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { mode, model, voices, models, permission, running, hasTools } = props
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), [])

  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const councilReady = mode !== 'council' || voices.length >= 2
  const blocker = !model ? 'Escolha um modelo' : !councilReady ? 'Escolha pelo menos duas vozes' : null
  const canSend = text.trim().length > 0 && !running && !blocker

  const send = (): void => {
    if (!canSend) return
    props.onSend(text)
    setText('')
  }

  return (
    <div className={`composer${running ? ' running' : ''}`}>
      <span className={`node composer-node${running ? ' pulse' : ''}`} aria-hidden />
      <div className="composer-box">
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={mode === 'council' ? 'O que perguntar ao conselho?' : 'O que vamos fazer?'}
          aria-label="Mensagem"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-bar">
          <div className="segmented" role="radiogroup" aria-label="Modo">
            <button role="radio" aria-checked={mode === 'agent'} className={mode === 'agent' ? 'on' : ''} onClick={() => props.onModeChange('agent')}>
              Agente
            </button>
            <button role="radio" aria-checked={mode === 'council'} className={mode === 'council' ? 'on' : ''} onClick={() => props.onModeChange('council')}>
              Conselho
            </button>
          </div>

          {mode === 'council' && (
            <div className="voices" aria-label="Vozes do conselho">
              {voices.map((voice) => (
                <span className="chip removable" key={modelKey(voice)}>
                  {modelLabel(voice, models)}
                  <button aria-label={`Remover ${modelLabel(voice, models)}`} onClick={() => props.onRemoveVoice(voice)}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              <button className="chip add" onClick={props.onPickVoices}>
                <Plus size={12} aria-hidden /> {voices.length === 0 ? 'Vozes' : 'Voz'}
              </button>
            </div>
          )}

          <button className="model-chip" onClick={props.onPickModel} title="Trocar de modelo (Ctrl+K)">
            {mode === 'council' && <span className="model-chip-prefix">Síntese</span>}
            <span className="model-chip-label">{model ? modelLabel(model, models) : 'Escolher modelo'}</span>
            <ChevronDown size={13} aria-hidden />
          </button>

          <div className="composer-spacer" />

          {hasTools && mode === 'agent' && (
            <select
              className="permission"
              aria-label="Permissões"
              value={permission}
              onChange={(event) => props.onPermissionChange(event.target.value as PermissionMode)}
            >
              <option value="ask">Perguntar antes de agir</option>
              <option value="auto-edit">Editar sem perguntar</option>
              <option value="read-only">Somente leitura</option>
            </select>
          )}

          {running ? (
            <button className="send stop" onClick={props.onStop} aria-label="Interromper" title="Interromper">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send" disabled={!canSend} onClick={send} aria-label="Enviar" title={blocker ?? 'Enviar (Enter)'}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
