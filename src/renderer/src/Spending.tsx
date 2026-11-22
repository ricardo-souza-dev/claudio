import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { BUDGET_WARNING, type SpendingReport } from '../../shared/spending'
import type { ModelInfo, Preferences } from '../../shared/types'
import { folderName, formatTokens, formatUsd, modelLabel, remoteErrorMessage } from './format'
import { api } from './store'

/** Accepts "2,5" as well as "2.5". Null means the text is not an amount. An empty field means no limit. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function dayLabel(day: string): string {
  const [, month, date] = day.split('-')
  return `${date}/${month}`
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="spend-tile">
      <dt>{label}</dt>
      <dd>{formatUsd(value)}</dd>
    </div>
  )
}

function DayChart({ days }: { days: SpendingReport['days'] }) {
  const peak = Math.max(...days.map((entry) => entry.cost), 0)
  return (
    <div className="spend-chart" role="img" aria-label={`Gasto por dia nos últimos ${days.length} dias. Maior dia: ${formatUsd(peak)}.`}>
      {days.map((entry) => (
        <span key={entry.day} className="spend-bar-slot" title={`${dayLabel(entry.day)}: ${formatUsd(entry.cost)}`}>
          <span className="spend-bar" style={{ height: `${peak > 0 ? Math.max((entry.cost / peak) * 100, entry.cost > 0 ? 3 : 0) : 0}%` }} />
        </span>
      ))}
    </div>
  )
}

/** A money field that saves when the person leaves it, and says so when the text is not an amount. */
function AmountField({ id, label, value, onSave }: { id?: string; label: string; value: number; onSave(value: number): void }) {
  const shown = (amount: number): string => (amount > 0 ? String(amount).replace('.', ',') : '')
  const [text, setText] = useState(shown(value))
  useEffect(() => setText(shown(value)), [value])
  const parsed = parseAmount(text)
  const commit = (): void => {
    if (parsed !== null && parsed !== value) onSave(parsed)
  }
  return (
    <input
      id={id}
      className="amount-input"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={parsed === null}
      placeholder="Sem limite"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function Progress({ spent, limit }: { spent: number; limit: number }) {
  const fraction = limit > 0 ? spent / limit : 0
  const state = fraction >= 1 ? 'over' : fraction >= BUDGET_WARNING ? 'near' : 'ok'
  return (
    <div className={`budget-bar ${state}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spent, limit)} aria-label={`${Math.round(fraction * 100)}% do orçamento`}>
      <span style={{ width: `${Math.min(fraction, 1) * 100}%` }} />
    </div>
  )
}

interface SpendingProps {
  prefs: Preferences
  models: ModelInfo[]
  /** Project folders from the conversation list, so a project can get a limit before it has spent anything. */
  projects: string[]
  onPrefs(patch: Partial<Preferences>): Promise<void>
}

export function Spending({ prefs, models, projects, onPrefs }: SpendingProps) {
  const [report, setReport] = useState<SpendingReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setProblem(null)
    try {
      setReport(await api.spending.report())
    } catch (error) {
      setProblem(remoteErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => void load(), [load])

  const monthOf = (workspace: string): number => report?.byProject.find((entry) => entry.workspace === workspace)?.month ?? 0
  const folders = [...new Set([...projects, ...(report?.byProject.flatMap((entry) => (entry.workspace ? [entry.workspace] : [])) ?? []), ...Object.keys(prefs.projectBudgetsUsd)])]
    .sort((a, b) => monthOf(b) - monthOf(a) || folderName(a).localeCompare(folderName(b)))
  const withoutProject = report?.byProject.find((entry) => entry.workspace === null)
  const monthName = report ? new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(report.monthStart) : 'do mês'

  const setProjectLimit = (workspace: string, value: number): void => {
    const next = { ...prefs.projectBudgetsUsd }
    if (value > 0) next[workspace] = value
    else delete next[workspace]
    void onPrefs({ projectBudgetsUsd: next })
  }

  return (
    <>
      <h3>Orçamentos</h3>
      <p className="hint">Quando uma conversa ou um projeto chega ao limite, o Claudio para antes do próximo passo. Aos {Math.round(BUDGET_WARNING * 100)}% ele avisa. Para continuar, aumente o limite e tente de novo. Deixe em branco para não limitar.</p>
      <div className="budget-row">
        <label htmlFor="conversation-budget">Limite por conversa</label>
        <span className="budget-unit">US$</span>
        <AmountField id="conversation-budget" label="Limite por conversa, em dólares" value={prefs.conversationBudgetUsd} onSave={(value) => void onPrefs({ conversationBudgetUsd: value })} />
      </div>
      {folders.length > 0 && (
        <>
          <h4 className="spend-subtitle">Limite mensal por projeto</h4>
          <ul className="budget-list">
            {folders.map((workspace) => {
              const limit = prefs.projectBudgetsUsd[workspace] ?? 0
              const spent = monthOf(workspace)
              return (
                <li key={workspace} className="budget-project">
                  <div className="budget-row">
                    <span className="budget-name" title={workspace}>
                      {folderName(workspace)}
                      <small className="budget-spent">{formatUsd(spent)} em {monthName}</small>
                    </span>
                    <span className="budget-unit">US$</span>
                    <AmountField label={`Limite mensal de ${folderName(workspace)}, em dólares`} value={limit} onSave={(value) => setProjectLimit(workspace, value)} />
                  </div>
                  {limit > 0 && <Progress spent={spent} limit={limit} />}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <div className="spend-heading">
        <h3>Gasto</h3>
        <button className="button" onClick={() => void load()} disabled={loading} aria-label="Atualizar gasto">
          <RefreshCw size={13} aria-hidden /> {loading ? 'Atualizando' : 'Atualizar'}
        </button>
      </div>
      {problem && <p className="result failed">{problem}</p>}
      {report && (
        <>
          <dl className="spend-tiles">
            <Tile label="Hoje" value={report.today} />
            <Tile label="7 dias" value={report.last7Days} />
            <Tile label={`Em ${monthName}`} value={report.month} />
            <Tile label="Total" value={report.total} />
          </dl>
          {report.total === 0 && report.unpricedThisMonth === 0 ? (
            <p className="hint">Nada gasto ainda. Os valores aparecem depois da primeira resposta de um modelo com preço conhecido.</p>
          ) : (
            <>
              <DayChart days={report.days} />
              <div className="spend-axis" aria-hidden>
                <span>{dayLabel(report.days[0].day)}</span>
                <span>hoje</span>
              </div>
            </>
          )}
          {report.byModel.length > 0 && (
            <>
              <h4 className="spend-subtitle">Por modelo, em {monthName}</h4>
              <table className="spend-table">
                <tbody>
                  {report.byModel.map((entry) => (
                    <tr key={`${entry.model.provider}/${entry.model.id}`}>
                      <th scope="row">{modelLabel(entry.model, models)}</th>
                      <td>{formatTokens(entry.input + entry.output)} tokens</td>
                      <td>{formatUsd(entry.month)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {withoutProject && withoutProject.total > 0 && <p className="hint">Conversas antigas sem pasta de projeto somam {formatUsd(withoutProject.total)}.</p>}
          {report.unpricedThisMonth > 0 && (
            <p className="hint">
              {report.unpricedThisMonth} {report.unpricedThisMonth === 1 ? 'resposta' : 'respostas'} deste mês {report.unpricedThisMonth === 1 ? 'veio' : 'vieram'} de modelos sem preço no catálogo e não {report.unpricedThisMonth === 1 ? 'entra' : 'entram'} nos valores, nem nos limites.
            </p>
          )}
          <p className="hint">Valores estimados com os tokens informados pelos provedores e os preços atuais do catálogo. Conversas apagadas deixam de contar.</p>
        </>
      )}
    </>
  )
}
