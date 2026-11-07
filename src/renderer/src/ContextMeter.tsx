import { useEffect, useRef, useState } from 'react'
import type { Effort, Message, ModelInfo } from '../../shared/types'
import { summarizeUsage } from '../../shared/usage'
import { EFFORT_LABELS, formatTokens, formatUsd } from './format'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const WARNING_AT = 0.8

function Ring({ fraction }: { fraction: number }) {
  return (
    <svg className="meter-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle className="meter-track" cx="8" cy="8" r={RADIUS} />
      <circle
        className="meter-fill"
        cx="8"
        cy="8"
        r={RADIUS}
        strokeDasharray={`${Math.max(fraction, 0.02) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

interface ContextMeterProps {
  messages: Message[]
  models: ModelInfo[]
  model: ModelInfo | undefined
  effort: Effort | null
}

/** How full the context is, and everything a developer wants to know about what the conversation has used. */
export function ContextMeter({ messages, models, model, effort }: ContextMeterProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const usage = summarizeUsage(messages, models)
  const limit = model?.contextWindow
  const fraction = limit ? Math.min(usage.context / limit, 1) : null
  const percent = fraction === null ? null : fraction > 0 && fraction < 0.01 ? '<1%' : `${Math.round(fraction * 100)}%`

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="meter" ref={root}>
      <button
        className={`meter-button${fraction !== null && fraction >= WARNING_AT ? ' warning' : ''}`}
        aria-expanded={open}
        aria-label={`Uso da conversa: contexto em ${percent ?? formatTokens(usage.context) + ' tokens'}`}
        title="Uso da conversa"
        onClick={() => setOpen(!open)}
      >
        <Ring fraction={fraction ?? 0} />
        <span>{percent ?? formatTokens(usage.context)}</span>
      </button>
      {open && (
        <div className="meter-panel" role="dialog" aria-label="Uso da conversa">
          <dl>
            {model && (
              <>
                <dt>Modelo</dt>
                <dd>{model.label}</dd>
              </>
            )}
            <dt>Força</dt>
            <dd>{effort ? EFFORT_LABELS[effort] : 'Padrão do modelo'}</dd>
            <dt>Contexto em uso</dt>
            <dd>{limit ? `${formatTokens(usage.context)} de ${formatTokens(limit)} (${percent})` : `${formatTokens(usage.context)} (limite desconhecido)`}</dd>
            {model?.maxOutput ? (
              <>
                <dt>Resposta máxima</dt>
                <dd>{formatTokens(model.maxOutput)} tokens</dd>
              </>
            ) : null}
            <dt>Entrada na conversa</dt>
            <dd>{formatTokens(usage.input)} tokens</dd>
            <dt>Saída na conversa</dt>
            <dd>{formatTokens(usage.output)} tokens</dd>
            {usage.cached > 0 && (
              <>
                <dt>Lidos do cache</dt>
                <dd>{formatTokens(usage.cached)} tokens</dd>
              </>
            )}
            <dt>Custo estimado</dt>
            <dd>
              {formatUsd(usage.cost)}
              {usage.costComplete ? '' : ' (parcial)'}
            </dd>
            {model?.pricing && (
              <>
                <dt>Preço do modelo</dt>
                <dd>
                  {formatUsd(model.pricing.input)} entrada · {formatUsd(model.pricing.output)} saída, por milhão
                </dd>
              </>
            )}
          </dl>
          <p className="meter-note">Tokens informados pelos provedores. Limites e preços vêm do models.dev e podem variar.</p>
        </div>
      )}
    </div>
  )
}
