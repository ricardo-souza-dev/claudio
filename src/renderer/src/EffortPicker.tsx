import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Effort } from '../../shared/types'
import { EFFORT_LABELS } from './format'

export function EffortPicker({ value, levels, onChange }: { value: Effort | null; levels: readonly Effort[]; onChange(value: Effort | null): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options: { value: Effort | null; label: string }[] = [
    { value: null, label: 'Força padrão' },
    ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))
  ]
  const close = () => setOpen(false)
  const choose = (next: Effort | null) => { onChange(next); close(); trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  return (
    <div className="effort-picker" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
    }} onKeyDown={(event) => {
      if (event.key === 'Escape' && open) { event.preventDefault(); close(); trigger.current?.focus(); return }
      if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
      <button ref={trigger} type="button" className="effort-trigger" aria-label="Força do modelo" aria-haspopup="menu" aria-expanded={open}
        title="Força do modelo: mais força costuma dar mais qualidade, com mais tempo e custo"
        onClick={() => setOpen(!open)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
          }
        }}>
        {value ? EFFORT_LABELS[value] : 'Força padrão'} <ChevronDown size={13} aria-hidden />
      </button>
      {open && <div className="effort-menu" role="menu" aria-label="Força do modelo">
        {options.map((option) => <button key={option.value ?? 'default'} type="button" role="menuitemradio" aria-checked={value === option.value} onClick={() => choose(option.value)}>
          <span>{option.label}</span>{value === option.value && <Check size={16} aria-hidden />}
        </button>)}
      </div>}
    </div>
  )
}
