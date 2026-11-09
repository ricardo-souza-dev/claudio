import { Check, RefreshCw, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { chooseAutoModel, contextFit, estimateTurn, unfitReason, type TaskInfo } from '../../shared/auto-model'
import { modelKey, type ModelInfo, type ModelListing, type ModelRef } from '../../shared/types'
import { EFFORT_LABELS, formatEstimatedSeconds, formatEstimatedUsd, formatTokens } from './format'

interface ModelPickerProps {
  listing: ModelListing
  loading: boolean
  title: string
  current: ModelRef | null
  /** The model already writing this conversation, which is costly to step down from. */
  inConversation: ModelRef | null
  /** The message being written and the conversation so far, which the estimates are for. */
  task: TaskInfo
  /** Present when Claudio may choose the model by itself, for each message. */
  auto?: { on: boolean; profile: 'economy' | 'balanced' | 'performance'; onSelect(): void }
  onSelect(model: ModelRef): void
  onRefresh(): void
  onClose(): void
  onOpenSettings(): void
}

function groupByProvider(models: ModelInfo[]): { name: string; models: ModelInfo[] }[] {
  const groups = new Map<string, { name: string; models: ModelInfo[] }>()
  for (const model of models) {
    const group = groups.get(model.provider) ?? { name: model.providerName, models: [] }
    group.models.push(model)
    groups.set(model.provider, group)
  }
  return [...groups.values()]
}

function effortRange(model: ModelInfo): string {
  if (!model.efforts?.length) return '—'
  return `até ${EFFORT_LABELS[model.efforts.at(-1)!]}`
}

/** Warns before the limit is reached, so there is still room to switch or start over. */
const NEAR_LIMIT_FRACTION = 0.75

function FitWarning({ model, task }: { model: ModelInfo; task: TaskInfo }) {
  const fit = contextFit(model, task)
  if (!fit || fit.fraction < NEAR_LIMIT_FRACTION) return null
  return (
    <span className="picker-warn" title="A conversa já usa quase todo o contexto deste modelo">
      perto do limite ({formatTokens(fit.remaining)} de espaço)
    </span>
  )
}

/** The columns of a model row. */
function Figures({ model, task }: { model: ModelInfo; task: TaskInfo }) {
  const unfit = unfitReason(model, task)
  const { cost, seconds } = estimateTurn(model, task)
  if (unfit) return <span className="picker-unfit">{unfit}</span>
  return (
    <>
      <span className="picker-figure" title="Força máxima que este modelo aceita">
        {effortRange(model)}
      </span>
      <span className="picker-figure" title={model.pricing ? `Por milhão de tokens: US$ ${model.pricing.input} de entrada e US$ ${model.pricing.output} de saída` : 'Preço desconhecido'}>
        {cost === null ? '—' : formatEstimatedUsd(cost)}
      </span>
      <span className="picker-figure" title={seconds === null ? 'Aparece depois que este modelo responder aqui pela primeira vez' : 'Medido nas respostas anteriores deste modelo'}>
        {seconds === null ? '—' : formatEstimatedSeconds(seconds)}
      </span>
      <span className="picker-figure" title="Tamanho máximo do contexto">
        {model.contextWindow ? formatTokens(model.contextWindow) : '—'}
      </span>
    </>
  )
}

export function ModelPicker({ listing, loading, title, current, inConversation, task, auto, onSelect, onRefresh, onClose, onOpenSettings }: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => input.current?.focus(), [])

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return listing.models.filter((model) => {
      const haystack = `${model.label} ${model.id} ${model.providerName}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [listing.models, query])
  const groups = useMemo(() => groupByProvider(filtered), [filtered])
  // Rows are numbered in display order, so the arrow keys follow what is on screen.
  const ordered = useMemo(() => groups.flatMap((group) => group.models), [groups])
  const currentKey = current ? modelKey(current) : null

  const recommendation = useMemo(() => {
    const choice = chooseAutoModel(listing.models, task, inConversation, { profile: auto?.profile })
    const model = choice && listing.models.find((entry) => modelKey(entry) === modelKey(choice.model))
    return choice && model ? { model, reason: choice.reason } : null
  }, [listing.models, task, inConversation, auto?.profile])

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    list.current?.querySelector('.picker-row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (model: ModelInfo | undefined): void => {
    if (!model) return
    onSelect({ provider: model.provider, id: model.id })
    onClose()
  }

  const errors = Object.entries(listing.errors)
  let row = -1

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picker-search">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={query}
            placeholder={title}
            aria-label={title}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor(Math.min(cursor + 1, ordered.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor(Math.max(cursor - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(ordered[cursor])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
          />
          <button className="icon-button" onClick={onRefresh} aria-label="Atualizar lista de modelos" title="Atualizar lista">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>

        {errors.map(([id, message]) => (
          <button className="picker-error" key={id} onClick={onOpenSettings}>
            {message.split('\n')[0]}
          </button>
        ))}

        {auto && !query && (
          <button
            className={`picker-auto${auto.on ? ' selected' : ''}`}
            onClick={() => {
              auto.onSelect()
              onClose()
            }}
          >
            <span className="picker-check" aria-hidden>
              {auto.on && <Check size={13} />}
            </span>
            <span className="picker-label">Automático</span>
            <span className="picker-id">escolhe pela tarefa, pelo contexto e pelo preço, a cada mensagem</span>
          </button>
        )}

        {recommendation && !query && (
          <button className="picker-row picker-recommended" onClick={() => choose(recommendation.model)}>
            <span className="picker-check" aria-hidden>
              <Sparkles size={13} />
            </span>
            <span className="picker-name">
              <span className="picker-label">{recommendation.model.label}</span>
              <span className="picker-id">recomendado: {recommendation.reason}</span>
            <FitWarning model={recommendation.model} task={task} />
            </span>
            <Figures model={recommendation.model} task={task} />
          </button>
        )}

        <div className="picker-columns" aria-hidden>
          <span />
          <span />
          <span>Força</span>
          <span>Custo</span>
          <span>Tempo</span>
          <span>Contexto</span>
        </div>

        <div className="picker-list" ref={list}>
          {groups.map((group) => (
            <div key={group.name}>
              <div className="picker-group">{group.name}</div>
              {group.models.map((model) => {
                row += 1
                const position = row
                const key = modelKey(model)
                return (
                  <button
                    key={key}
                    className={`picker-row${position === cursor ? ' cursor' : ''}${key === currentKey ? ' selected' : ''}`}
                    onMouseMove={() => setCursor(position)}
                    onClick={() => choose(model)}
                  >
                    <span className="picker-check" aria-hidden>
                      {key === currentKey && !auto?.on && <Check size={13} />}
                    </span>
                    <span className="picker-name">
                      <span className="picker-label">{model.label}</span>
                      {model.label !== model.id && <span className="picker-id">{model.id}</span>}
                    </span>
                    <Figures model={model} task={task} />
                  </button>
                )
              })}
            </div>
          ))}

          {ordered.length === 0 && (
            <div className="picker-empty">
              {listing.models.length === 0 ? (
                <>
                  <p>{loading ? 'Buscando modelos…' : 'Nenhum modelo conectado ainda.'}</p>
                  {!loading && (
                    <button className="button primary" onClick={onOpenSettings}>
                      Conectar um provedor
                    </button>
                  )}
                </>
              ) : (
                <p>Nenhum modelo com “{query}”.</p>
              )}
            </div>
          )}
        </div>

        <div className="picker-footer">
          <span>Custo e tempo são estimativas para a próxima mensagem. O tempo vem das respostas já dadas aqui.</span>
        </div>
      </div>
    </div>
  )
}
