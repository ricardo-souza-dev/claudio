import { Check, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { modelKey, type ModelInfo, type ModelListing, type ModelRef } from '../../shared/types'
import { formatTokens } from './format'

interface ModelPickerProps {
  listing: ModelListing
  loading: boolean
  /** One choice closes the picker; several toggle, for the council's voices. */
  mode: 'single' | 'multiple'
  title: string
  selected: ModelRef[]
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

export function ModelPicker({ listing, loading, mode, title, selected, onSelect, onRefresh, onClose, onOpenSettings }: ModelPickerProps) {
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
  const selectedKeys = new Set(selected.map(modelKey))

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    list.current?.querySelector('.picker-row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (model: ModelInfo | undefined): void => {
    if (!model) return
    onSelect({ provider: model.provider, id: model.id })
    if (mode === 'single') onClose()
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
                    className={`picker-row${position === cursor ? ' cursor' : ''}${selectedKeys.has(key) ? ' selected' : ''}`}
                    onMouseMove={() => setCursor(position)}
                    onClick={() => choose(model)}
                  >
                    <span className="picker-check" aria-hidden>
                      {selectedKeys.has(key) && <Check size={13} />}
                    </span>
                    <span className="picker-label">{model.label}</span>
                    {model.label !== model.id && <span className="picker-id">{model.id}</span>}
                    {model.contextWindow ? <span className="picker-context">{formatTokens(model.contextWindow)}</span> : null}
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
          <span>
            {listing.models.length} {listing.models.length === 1 ? 'modelo' : 'modelos'}
          </span>
          {mode === 'multiple' ? (
            <button className="button primary" onClick={onClose}>
              Concluir ({selected.length})
            </button>
          ) : (
            <span>Enter escolhe · Esc fecha</span>
          )}
        </div>
      </div>
    </div>
  )
}
