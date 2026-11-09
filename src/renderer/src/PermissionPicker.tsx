import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '../../shared/types'

const MODES = [
  { value: 'auto', label: 'Automático', description: 'Regras locais: aceita edições; confirma comandos e acesso externo' },
  { value: 'ask', label: 'Manual', description: 'Perguntar antes de fazer alterações' },
  { value: 'auto-edit', label: 'Aceitar edições', description: 'Aceitar todas as edições comuns automaticamente' },
  { value: 'plan', label: 'Plano', description: 'Investigar e apresentar um plano para você aprovar antes de executar' }
] as const

export function PermissionPicker({ value, disabled, onChange }: { value: PermissionMode; disabled: boolean; onChange(value: PermissionMode): void }) {
  const [open, setOpen] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = MODES.find((mode) => mode.value === value)?.label ?? (value === 'bypass' ? 'Ignorar permissões' : 'Somente leitura')
  const close = () => { setOpen(false); setConfirmBypass(false) }
  const choose = (mode: PermissionMode) => { onChange(mode); close(); trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  useEffect(() => {
    if (disabled) close()
  }, [disabled])

  return (
    <div className="permission-picker" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus() }
      if (!open || confirmBypass) return
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
      const shortcut = Number(event.key) - 1
      if (shortcut >= 0 && shortcut < MODES.length) { event.preventDefault(); choose(MODES[shortcut].value) }
    }}>
      <button ref={trigger} type="button" className="permission-trigger" aria-label={`Modo: ${current}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title={disabled ? 'O modo pode ser alterado quando a execução terminar' : 'Modo de permissões'}
        onClick={() => { setConfirmBypass(false); setOpen(!open) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
          }
        }}>
        {current}<ChevronDown size={12} aria-hidden />
      </button>
      {open && !confirmBypass && (
        <div className="permission-menu" role="menu" aria-label="Modo">
          <div className="permission-menu-title">Modo</div>
          {MODES.map((mode, index) => (
            <button key={mode.value} type="button" role="menuitemradio" aria-checked={value === mode.value} onClick={() => choose(mode.value)}>
              <span><span className="permission-mode-label">{mode.label}</span><span className="permission-mode-description">{mode.description}</span></span>
              {value === mode.value && <Check size={16} className="permission-check" aria-hidden />}
              <span className="permission-shortcut" aria-hidden>{index + 1}</span>
            </button>
          ))}
          <button type="button" className="permission-bypass" role="menuitemradio" aria-checked={value === 'bypass'} onClick={() => {
            if (value === 'bypass') choose('ask')
            else setConfirmBypass(true)
          }}>
            <span>Ignorar permissões</span><span className="permission-shortcut">{value === 'bypass' ? 'Desativar' : 'Ativar'}</span>
          </button>
        </div>
      )}
      {open && confirmBypass && (
        <div className="permission-menu permission-warning" role="alertdialog" aria-labelledby="bypass-title" aria-describedby="bypass-description">
          <strong id="bypass-title">Ignorar permissões?</strong>
          <p id="bypass-description">Comandos e ferramentas externas poderão agir sem confirmação, com as suas permissões e sem sandbox. Arquivos sensíveis continuam pedindo confirmação. As ferramentas de arquivo permanecem limitadas ao projeto.</p>
          <div className="permission-warning-actions">
            <button className="button" onClick={() => { close(); trigger.current?.focus() }}>Cancelar</button>
            <button className="button primary" onClick={() => choose('bypass')}>Ativar mesmo assim</button>
          </div>
        </div>
      )}
    </div>
  )
}
