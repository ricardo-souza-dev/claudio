import { ArrowDown, ArrowDownUp, ArrowUp, Check, CheckCircle2, ChevronRight, CloudUpload, ExternalLink, FileText, Folder, FolderGit2, GitBranch as BranchIcon, GitPullRequest, Loader2, Minus, MoreHorizontal, Plus, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitAction, GitFile, GitStatus, ModelRef, PrListing, ProjectFile, ProjectRepos, RepoRef } from '../../shared/types'
import { folderName, remoteErrorMessage, timeAgo } from './format'
import { api } from './store'

const POLL_MS = 5000

/** The model that writes commit messages, and how to name it on the button. */
export interface CommitModel {
  ref: ModelRef
  label: string
}

type Viewing = { kind: 'diff'; repo: string; path: string; staged: boolean } | { kind: 'file'; path: string }

const STATUS_NAMES: Record<string, string> = {
  M: 'Modificado',
  A: 'Adicionado',
  D: 'Removido',
  R: 'Renomeado',
  C: 'Copiado',
  T: 'Tipo alterado',
  U: 'Novo, ainda fora do Git',
  '!': 'Em conflito'
}

function fileCode(file: GitFile, staged: boolean): string {
  if (file.conflicted) return '!'
  if (file.untracked) return 'U'
  return staged ? file.index : file.worktree
}

function StatusBadge({ code }: { code: string }) {
  return (
    <span className={`git-code code-${code === '!' ? 'conflict' : code}`} title={STATUS_NAMES[code] ?? code}>
      {code}
    </span>
  )
}

function FileLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  return (
    <span className="git-file-label" title={path}>
      <span className="git-file-name">{path.slice(slash + 1)}</span>
      {slash > 0 && <span className="git-file-dir">{path.slice(0, slash)}</span>}
    </span>
  )
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="viewer-diff">
      {text.split('\n').map((line, index) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : /^(diff|index|---|\+\+\+) ?/.test(line) ? 'meta' : ''
        return (
          <span key={index} className={`viewer-line ${kind}`}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

function Viewer({ threadId, viewing, onClose }: { threadId: string; viewing: Viewing; onClose(): void }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const label = viewing.kind === 'diff' && viewing.repo ? `${viewing.repo}/${viewing.path}` : viewing.path

  useEffect(() => {
    let cancelled = false
    const load =
      viewing.kind === 'diff'
        ? api.project.diff(threadId, viewing.repo, viewing.path, viewing.staged).then((text) => !cancelled && setDiff(text))
        : api.project.read(threadId, viewing.path).then((content) => !cancelled && setFile(content))
    load.catch((error: unknown) => !cancelled && setProblem(remoteErrorMessage(error)))
    return () => {
      cancelled = true
    }
  }, [threadId, viewing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer" role="dialog" aria-modal="true" aria-label={label}>
        <header className="viewer-head">
          <span className="viewer-path">{label}</span>
          {viewing.kind === 'diff' && <span className="viewer-tag">{viewing.staged ? 'preparado' : 'alterações'}</span>}
          <button className="icon-button" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="viewer-body">
          {problem && <p className="result failed">{problem}</p>}
          {diff !== null && (diff ? <DiffView text={diff} /> : <p className="panel-empty">Nenhuma diferença.</p>)}
          {file && (file.binary ? <p className="panel-empty">Arquivo binário.</p> : <pre className="viewer-text">{file.text}</pre>)}
          {file?.truncated && <p className="panel-empty">Mostrando só o início do arquivo.</p>}
        </div>
      </div>
    </div>
  )
}

function Section({ title, count, actions, children }: { title: string; count?: number; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-section">
      <header className="panel-section-head">
        <h3 aria-label={count === undefined ? undefined : `${title} (${count})`}>
          {title}
          {count !== undefined && count > 0 && <span className="section-count" aria-hidden>{count}</span>}
        </h3>
        {actions}
      </header>
      {children}
    </section>
  )
}

function ChangeRow({ file, staged, onOpen, onAct }: { file: GitFile; staged: boolean; onOpen(): void; onAct(action: GitAction): void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="git-file" onMouseLeave={() => setConfirming(false)}>
      <button className="git-file-open" onClick={onOpen}>
        <FileLabel path={file.path} />
      </button>
      <span className="git-file-actions">
        {!staged &&
          !file.submodule &&
          (confirming ? (
            <button className="git-confirm" aria-label={`Confirmar: descartar alterações em ${file.path}`} onBlur={() => setConfirming(false)} onClick={() => onAct({ type: 'discard', paths: [file.path] })}>
              Descartar?
            </button>
          ) : (
            <button className="icon-button" aria-label={`Descartar alterações em ${file.path}`} title="Descartar alterações" onClick={() => setConfirming(true)}>
              <RotateCcw size={12} />
            </button>
          ))}
        <button
          className="icon-button"
          aria-label={staged ? `Tirar ${file.path} do commit` : `Preparar ${file.path}`}
          title={staged ? 'Tirar do commit' : 'Preparar para o commit'}
          onClick={() => onAct({ type: staged ? 'unstage' : 'stage', paths: [file.path] })}
        >
          {staged ? <Minus size={12} /> : <Plus size={12} />}
        </button>
      </span>
      <StatusBadge code={fileCode(file, staged)} />
    </li>
  )
}

function PullRequests({ threadId, repo, status, onStatus, onError }: { threadId: string; repo: string; status: GitStatus; onStatus(status: GitStatus): void; onError(message: string | null): void }) {
  const [listing, setListing] = useState<PrListing | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setListing(await api.project.prs(threadId, repo).catch((error: unknown) => ({ available: true, prs: [], error: remoteErrorMessage(error) })))
  }, [threadId, repo])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setBusy(true)
    onError(null)
    try {
      const url = await api.project.createPr(threadId, repo, { title, body })
      setCreating(false)
      setTitle('')
      setBody('')
      await load()
      onStatus(await api.project.git(threadId, repo))
      if (/^https?:\/\//.test(url)) void api.system.openExternal(url)
    } catch (error) {
      onError(remoteErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (number: number): Promise<void> => {
    onError(null)
    try {
      onStatus(await api.project.checkoutPr(threadId, repo, number))
    } catch (error) {
      onError(remoteErrorMessage(error))
    }
  }

  if (listing && !listing.available) {
    return (
      <Section title="Pull requests">
        <p className="panel-empty">
          Para ver e criar PRs, instale o{' '}
          <a
            href="https://cli.github.com"
            onClick={(event) => {
              event.preventDefault()
              void api.system.openExternal('https://cli.github.com')
            }}
          >
            GitHub CLI
          </a>{' '}
          e rode <code>gh auth login</code>.
        </p>
      </Section>
    )
  }

  return (
    <Section
      title="Pull requests"
      actions={
        <span className="panel-section-actions">
          <button className="icon-button" aria-label="Atualizar pull requests" title="Atualizar" onClick={() => void load()}>
            <RefreshCw size={12} />
          </button>
          {status.hasRemote && (
            <button
              className="icon-button"
              aria-label="Criar pull request"
              title="Criar pull request"
              onClick={() => {
                setTitle((current) => current || status.commits[0]?.subject || '')
                setCreating(!creating)
              }}
            >
              <Plus size={12} />
            </button>
          )}
        </span>
      }
    >
      {creating && (
        <div className="pr-form">
          <input aria-label="Título do PR" placeholder="Título" value={title} onChange={(event) => setTitle(event.target.value)} />
          <textarea aria-label="Descrição do PR" placeholder="Descrição" rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
          <button className="button primary" disabled={busy || !title.trim()} onClick={() => void create()}>
            {busy ? 'Criando…' : `Enviar ${status.branch ?? ''} e criar PR`}
          </button>
        </div>
      )}
      {listing?.error && <p className="panel-empty">{listing.error.split('\n')[0]}</p>}
      {listing && !listing.error && listing.prs.length === 0 && <p className="panel-empty pr-empty"><GitPullRequest size={14} aria-hidden /> Nenhum PR aberto.</p>}
      <ul className="pr-list">
        {listing?.prs.map((pr) => (
          <li key={pr.number} className={`pr${pr.branch === status.branch ? ' current' : ''}`}>
            <button className="pr-open" title={`Abrir no navegador: ${pr.url}`} onClick={() => void api.system.openExternal(pr.url)}>
              <GitPullRequest size={12} aria-hidden />
              <span className="pr-number">#{pr.number}</span>
              <span className="pr-title">{pr.title}</span>
              {pr.draft && <span className="pr-tag">rascunho</span>}
              {pr.review === 'APPROVED' && <span className="pr-tag ok">aprovado</span>}
              {pr.review === 'CHANGES_REQUESTED' && <span className="pr-tag warn">ajustes</span>}
              <ExternalLink size={11} aria-hidden className="pr-external" />
            </button>
            {pr.branch !== status.branch && (
              <button className="pr-checkout" aria-label={`Trocar para a branch do PR ${pr.number}`} title={`Trocar para ${pr.branch}`} onClick={() => void checkout(pr.number)}>
                <BranchIcon size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

const commitCount = (count: number): string => (count === 1 ? '1 commit' : `${count} commits`)

/** Fetch, bring and send commits in one click. The counts are from the last status read. */
function SyncButton({ status, busy, disabled = false, onSync }: { status: GitStatus; busy: boolean; disabled?: boolean; onSync(): void }) {
  const { upstream, ahead, behind } = status
  const moves = [behind > 0 ? `traz ${commitCount(behind)}` : '', ahead > 0 ? `envia ${commitCount(ahead)}` : ''].filter(Boolean)
  const label = upstream ? `Sincronizar com ${upstream}${moves.length > 0 ? `: ${moves.join(' e ')}` : ''}` : `Publicar ${status.branch} no remoto`
  return (
    <button className="sync-button" aria-label={label} title={label} disabled={busy || disabled} onClick={onSync}>
      {busy ? <Loader2 size={12} className="spin" aria-hidden /> : upstream ? <ArrowDownUp size={12} aria-hidden /> : <CloudUpload size={12} aria-hidden />}
      {upstream && behind > 0 && (
        <span className="sync-count">
          <ArrowDown size={10} aria-hidden />
          {behind}
        </span>
      )}
      {upstream && ahead > 0 && (
        <span className="sync-count">
          <ArrowUp size={10} aria-hidden />
          {ahead}
        </span>
      )}
    </button>
  )
}

const canSync = (status: GitStatus): boolean => status.hasRemote && status.branch !== null

function GitMenu({ status, busy, onAct, onNewBranch }: { status: GitStatus; busy: boolean; onAct(action: GitAction): void; onNewBranch(): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const choose = (action: () => void): void => {
    setOpen(false)
    trigger.current?.focus()
    action()
  }

  return (
    <div className="git-menu" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
    }}>
      <button ref={trigger} className="icon-button" aria-label="Mais ações do Git" title="Mais ações do Git" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={busy} onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
        }
      }}>
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div ref={menu} id={id} className="git-menu-items" role="menu" aria-label="Ações do Git" onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          let next: number
          if (event.key === 'ArrowDown') next = (index + 1) % items.length
          else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = items.length - 1
          else return
          event.preventDefault()
          items[next]?.focus()
        }}>
          <button role="menuitem" disabled={busy || !status.hasRemote || !status.upstream} onClick={() => choose(() => onAct({ type: 'pull' }))}>Pull</button>
          <button role="menuitem" disabled={busy || !canSync(status)} onClick={() => choose(() => onAct({ type: 'push' }))}>Push</button>
          <button role="menuitem" disabled={busy || !status.hasRemote} onClick={() => choose(() => onAct({ type: 'fetch' }))}>Fetch</button>
          <div role="separator" />
          <button role="menuitem" disabled={busy} onClick={() => choose(onNewBranch)}>Nova branch</button>
        </div>
      )}
    </div>
  )
}

function GitTab({
  threadId,
  repo,
  status,
  commitModel,
  withSync,
  onStatus,
  onView
}: {
  threadId: string
  repo: string
  status: GitStatus
  commitModel: CommitModel | null
  withSync: boolean
  onStatus(status: GitStatus): void
  onView(viewing: Viewing): void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [newBranch, setNewBranch] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const generateMessage = async (): Promise<void> => {
    if (!commitModel) return
    setGenerating(true)
    setProblem(null)
    try {
      setMessage(await api.project.commitMessage(threadId, repo, commitModel.ref))
    } catch (error) {
      setProblem(remoteErrorMessage(error))
    } finally {
      setGenerating(false)
    }
  }

  const act = useCallback(
    async (action: GitAction, onDone?: () => void) => {
      setBusy(action.type)
      setProblem(null)
      try {
        onStatus(await api.project.act(threadId, repo, action))
        onDone?.()
      } catch (error) {
        setProblem(remoteErrorMessage(error))
      } finally {
        setBusy(null)
      }
    },
    [threadId, repo, onStatus]
  )

  const staged = status.files.filter((file) => !file.untracked && !file.conflicted && file.index !== '.')
  const changed = status.files.filter((file) => file.untracked || file.conflicted || file.worktree !== '.')
  const pushPending = staged.length === 0 && canSync(status) && (status.ahead > 0 || (!status.upstream && status.commits.length > 0))
  const local = status.branches.filter((branch) => !branch.remote)
  const remote = status.branches.filter((branch) => branch.remote)

  return (
    <div className="git-workspace">
      <div className="git-branch">
        <BranchIcon size={13} aria-hidden />
        <select aria-label="Branch" value={status.branch ?? ''} disabled={busy !== null} onChange={(event) => void act({ type: 'switch', branch: event.target.value })}>
          {status.branch === null && <option value="">HEAD destacado</option>}
          {local.length === 0 && status.branch && <option value={status.branch}>{status.branch}</option>}
          {local.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}
            </option>
          ))}
          {remote.length > 0 && (
            <optgroup label="Remotas">
              {remote.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {status.hasRemote && !status.upstream && <span className="git-local">Só local</span>}
        {withSync && canSync(status) && <SyncButton status={status} busy={busy === 'sync'} disabled={busy !== null} onSync={() => void act({ type: 'sync' })} />}
        <GitMenu status={status} busy={busy !== null} onAct={(action) => void act(action)} onNewBranch={() => setNewBranch('')} />
      </div>
      {newBranch !== null && (
        <input
          className="panel-input"
          autoFocus
          aria-label="Nome da nova branch"
          placeholder="nome-da-branch"
          spellCheck={false}
          value={newBranch}
          onChange={(event) => setNewBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && newBranch.trim()) void act({ type: 'create-branch', branch: newBranch.trim() }, () => setNewBranch(null))
            if (event.key === 'Escape') {
              event.stopPropagation()
              setNewBranch(null)
            }
          }}
        />
      )}

      {busy && <p className="panel-empty">{busy === 'sync' ? 'Sincronizando…' : `Executando ${busy}…`}</p>}
      {problem && (
        <p className="result failed panel-problem" role="alert">
          {problem}
        </p>
      )}

      <div className="commit-form">
        <div className="commit-box">
          <textarea
            className="panel-input commit-message"
            aria-label="Texto do commit"
            placeholder="Mensagem do commit"
            rows={message.includes('\n') ? Math.min(6, message.split('\n').length) : 1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.ctrlKey && busy === null) {
                event.preventDefault()
                if (pushPending) void act({ type: 'push' })
                else if (staged.length > 0 && message.trim()) void act({ type: 'commit', message }, () => setMessage(''))
              }
            }}
          />
          <div className="commit-box-footer">
            <button
              className="commit-generate"
              disabled={generating || !commitModel || status.files.length === 0}
              aria-label="Gerar mensagem do commit com IA"
              title={
                !commitModel
                  ? 'Conecte um modelo para gerar a mensagem'
                  : status.files.length === 0
                    ? 'Não há alterações para descrever'
                    : `Gerar com ${commitModel.label}, lendo ${staged.length > 0 ? 'o que está preparado' : 'todas as alterações'}`
              }
              onClick={() => void generateMessage()}
            >
              {generating ? <Loader2 size={13} className="spin" aria-hidden /> : <Sparkles size={13} aria-hidden />}
            </button>
          </div>
        </div>
        <button
          className="button primary commit-button"
          aria-label={pushPending ? 'Push' : 'Fazer commit'}
          disabled={busy !== null || (!pushPending && (staged.length === 0 || !message.trim()))}
          onClick={() => pushPending ? void act({ type: 'push' }) : void act({ type: 'commit', message }, () => setMessage(''))}
        >
          {busy === 'commit' || busy === 'push' ? <Loader2 size={14} className="spin" aria-hidden /> : pushPending ? <ArrowUp size={14} aria-hidden /> : <Check size={14} aria-hidden />}
          <span>{busy === 'commit' ? 'Criando commit…' : busy === 'push' ? 'Enviando…' : pushPending ? 'Push' : 'Fazer commit'}</span>
          <kbd aria-hidden>Ctrl ↵</kbd>
        </button>
      </div>

      {staged.length > 0 && (
        <Section title="Preparadas" count={staged.length} actions={<button className="panel-link" onClick={() => void act({ type: 'unstage', paths: staged.map((file) => file.path) })}>Tirar todas</button>}>
          <ul className="git-files">
            {staged.map((file) => (
              <ChangeRow key={file.path} file={file} staged onOpen={() => onView({ kind: 'diff', repo, path: file.path, staged: true })} onAct={(action) => void act(action)} />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Alterações" count={changed.length} actions={changed.length > 0 ? <button className="panel-link" onClick={() => void act({ type: 'stage', paths: changed.map((file) => file.path) })}>Preparar todas</button> : undefined}>
        {changed.length === 0 ? (
          <div className="git-clean">
            <CheckCircle2 size={18} aria-hidden />
            <div>
              <strong>{staged.length > 0 ? 'Tudo preparado' : 'Tudo em dia'}</strong>
              <p>{staged.length > 0 ? 'Nenhuma alteração fora do commit.' : 'Nenhuma alteração pendente nesta pasta.'}</p>
            </div>
          </div>
        ) : (
          <ul className="git-files">
            {changed.map((file) => (
              <ChangeRow key={file.path} file={file} staged={false} onOpen={() => onView({ kind: 'diff', repo, path: file.path, staged: false })} onAct={(action) => void act(action)} />
            ))}
          </ul>
        )}
      </Section>

      <PullRequests threadId={threadId} repo={repo} status={status} onStatus={onStatus} onError={setProblem} />

      {status.commits.length > 0 && (
        <Section title="Commits recentes">
          <ul className="commit-list">
            {status.commits.map((commit) => (
              <li key={commit.hash} className="commit" title={`${commit.hash} · ${commit.author}`}>
                <span className="commit-subject">{commit.subject}</span>
                <div className="commit-meta">
                  <span className="commit-hash">{commit.hash.slice(0, 7)}</span>
                  <span className="commit-author">{commit.author}</span>
                  <span className="commit-when">{timeAgo(commit.at)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

interface TreeNode {
  name: string
  path: string
  children: TreeNode[] | null
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const file of paths) {
    let node = root
    const pieces = file.split('/')
    pieces.forEach((piece, index) => {
      const isFile = index === pieces.length - 1
      const path = pieces.slice(0, index + 1).join('/')
      let child = node.children!.find((entry) => entry.name === piece)
      if (!child) {
        child = { name: piece, path, children: isFile ? null : [] }
        node.children!.push(child)
      }
      node = child
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => Number(b.children !== null) - Number(a.children !== null) || a.name.localeCompare(b.name))
    nodes.forEach((node) => node.children && sort(node.children))
    return nodes
  }
  return sort(root.children!)
}

function TreeRows({ nodes, depth, codes, open, onToggle, onFile }: { nodes: TreeNode[]; depth: number; codes: Map<string, string>; open: Set<string>; onToggle(path: string): void; onFile(path: string): void }) {
  return (
    <>
      {nodes.map((node) => {
        const code = codes.get(node.path)
        if (node.children) {
          const expanded = open.has(node.path)
          const changedInside = [...codes.keys()].some((path) => path.startsWith(`${node.path}/`))
          return (
            <div key={node.path}>
              <button className="tree-row" style={{ paddingLeft: 6 + depth * 12 }} aria-expanded={expanded} onClick={() => onToggle(node.path)}>
                <ChevronRight size={12} className={`chevron${expanded ? ' rotated' : ''}`} aria-hidden />
                <Folder size={12} aria-hidden />
                <span className={`tree-name${changedInside ? ' changed' : ''}`}>{node.name}</span>
              </button>
              {expanded && <TreeRows nodes={node.children} depth={depth + 1} codes={codes} open={open} onToggle={onToggle} onFile={onFile} />}
            </div>
          )
        }
        return (
          <button key={node.path} className="tree-row" style={{ paddingLeft: 18 + depth * 12 }} onClick={() => onFile(node.path)}>
            <FileText size={12} aria-hidden />
            <span className={`tree-name${code ? ' changed' : ''}`}>{node.name}</span>
            {code && <StatusBadge code={code} />}
          </button>
        )
      })}
    </>
  )
}

function FilesTab({ threadId, statuses, refreshKey, onView }: { threadId: string; statuses: Record<string, GitStatus>; refreshKey: number; onView(viewing: Viewing): void }) {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void api.project.files(threadId).then((files) => !cancelled && setPaths(files))
    return () => {
      cancelled = true
    }
  }, [threadId, refreshKey])

  const codes = useMemo(() => {
    const map = new Map<string, string>()
    for (const [repo, status] of Object.entries(statuses)) {
      for (const file of status.files) map.set(repo ? `${repo}/${file.path}` : file.path, fileCode(file, file.worktree === '.'))
    }
    return map
  }, [statuses])
  const tree = useMemo(() => buildTree(paths ?? []), [paths])
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = terms.length > 0 ? (paths ?? []).filter((path) => terms.every((term) => path.toLowerCase().includes(term))) : null
  const openFile = (path: string): void => onView({ kind: 'file', path })

  return (
    <>
      <input className="panel-input" aria-label="Filtrar arquivos" placeholder="Filtrar arquivos" spellCheck={false} value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="tree">
        {matches ? (
          matches.length === 0 ? (
            <p className="panel-empty">Nenhum arquivo com “{filter}”.</p>
          ) : (
            matches.map((path) => (
              <button key={path} className="tree-row" onClick={() => openFile(path)}>
                <FileText size={12} aria-hidden />
                <FileLabel path={path} />
                {codes.get(path) && <StatusBadge code={codes.get(path)!} />}
              </button>
            ))
          )
        ) : (
          <TreeRows
            nodes={tree}
            depth={0}
            codes={codes}
            open={open}
            onFile={openFile}
            onToggle={(path) =>
              setOpen((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
          />
        )}
        {paths?.length === 0 && <p className="panel-empty">Pasta vazia.</p>}
      </div>
    </>
  )
}

const KIND_LABELS: Record<RepoRef['kind'], string> = { root: 'Repositório principal', submodule: 'Submódulo', nested: 'Repositório nesta pasta' }

/** One repository, collapsible when the project has several. Only what is open keeps polling. */
function RepoBlock({
  threadId,
  repo,
  alone,
  refreshKey,
  status,
  commitModel,
  onStatus,
  onView
}: {
  threadId: string
  repo: RepoRef
  alone: boolean
  refreshKey: number
  status: GitStatus | undefined
  commitModel: CommitModel | null
  onStatus(path: string, status: GitStatus): void
  onView(viewing: Viewing): void
}) {
  const [open, setOpen] = useState(repo.kind === 'root')
  const report = useCallback((next: GitStatus) => onStatus(repo.path, next), [onStatus, repo.path])

  useEffect(() => {
    void api.project.git(threadId, repo.path).then(report).catch(() => undefined)
  }, [threadId, repo.path, refreshKey, report])

  const expanded = alone || open
  useEffect(() => {
    if (!expanded) return
    const timer = setInterval(() => {
      if (document.hasFocus()) void api.project.git(threadId, repo.path).then(report).catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [expanded, threadId, repo.path, report])

  // Syncing works from the header too, with the repository closed.
  const [syncing, setSyncing] = useState(false)
  const [syncProblem, setSyncProblem] = useState<string | null>(null)
  const sync = async (): Promise<void> => {
    setSyncing(true)
    setSyncProblem(null)
    try {
      report(await api.project.act(threadId, repo.path, { type: 'sync' }))
    } catch (error) {
      setSyncProblem(remoteErrorMessage(error))
    } finally {
      setSyncing(false)
    }
  }

  const body = status ? <GitTab threadId={threadId} repo={repo.path} status={status} commitModel={commitModel} withSync={alone} onStatus={report} onView={onView} /> : null
  if (alone) return body

  const changes = status?.files.length ?? 0
  return (
    <section className={`repo-block${open ? ' open' : ''}`} aria-label={`Repositório ${repo.name}`}>
      <div className="repo-head">
        <button className="repo-toggle" aria-expanded={open} title={`${KIND_LABELS[repo.kind]}: ${repo.path || repo.name}`} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={`chevron${open ? ' rotated' : ''}`} aria-hidden />
          <FolderGit2 size={13} aria-hidden />
          <span className="repo-name">{repo.name}</span>
          {changes > 0 && (
            <span className="panel-count" title={changes === 1 ? '1 arquivo alterado sem commit' : `${changes} arquivos alterados sem commit`}>
              {changes}
            </span>
          )}
          <span className="repo-branch">{status?.branch ?? ''}</span>
        </button>
        {status && canSync(status) && <SyncButton status={status} busy={syncing} onSync={() => void sync()} />}
      </div>
      {syncProblem && (
        <p className="result failed panel-problem" role="alert">
          {syncProblem}
        </p>
      )}
      {open && <div className="repo-body">{body}</div>}
    </section>
  )
}

export function ProjectPanel({ threadId, workspace, running, commitModel, onClose }: { threadId: string; workspace: string; running: boolean; commitModel: CommitModel | null; onClose(): void }) {
  const [found, setFound] = useState<ProjectRepos | null>(null)
  const [statuses, setStatuses] = useState<Record<string, GitStatus>>({})
  const [tab, setTab] = useState<'git' | 'files'>('git')
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [initializing, setInitializing] = useState(false)

  const refresh = useCallback(async () => {
    const next = await api.project.repos(threadId).catch(() => null)
    if (next) setFound(next)
    setRefreshKey((key) => key + 1)
  }, [threadId])

  const reportStatus = useCallback((path: string, status: GitStatus) => {
    setStatuses((current) => ({ ...current, [path]: status }))
  }, [])

  // Stays current with what the agent changes, and with work done outside the app.
  useEffect(() => {
    setFound(null)
    setStatuses({})
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [threadId, workspace, refresh])

  useEffect(() => {
    if (!running) void refresh()
  }, [running, refresh])

  const repos = found?.repos ?? []
  const hasGit = repos.length > 0
  const activeTab = hasGit ? tab : 'files'
  const changes = repos.reduce((sum, repo) => sum + (statuses[repo.path]?.files.length ?? 0), 0)
  const missing = found?.uninitializedSubmodules ?? []

  const initialize = async (action: 'init' | 'init-submodules'): Promise<void> => {
    setProblem(null)
    setInitializing(true)
    try {
      await api.project.act(threadId, '', { type: action })
      setTab('git')
      await refresh()
    } catch (error) {
      setProblem(remoteErrorMessage(error))
    } finally {
      setInitializing(false)
    }
  }

  return (
    <aside className="project-panel" aria-label={`Projeto ${folderName(workspace)}`}>
      <header className="panel-head">
        <div className="panel-tabs" role="tablist">
          {hasGit && (
            <button role="tab" aria-selected={activeTab === 'git'} className={activeTab === 'git' ? 'on' : ''} onClick={() => setTab('git')}>
              Git
              {changes > 0 && <span className="panel-count">{changes}</span>}
            </button>
          )}
          <button role="tab" aria-selected={activeTab === 'files'} className={activeTab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            Arquivos
          </button>
        </div>
        <button className="icon-button" aria-label="Atualizar painel" title="Atualizar" onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-button panel-close" aria-label="Fechar painel" title="Fechar painel" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="panel-body">
        {found && !hasGit && (
          <div className="no-git">
            <p>Este projeto não usa Git.</p>
            <button className="git-button" disabled={initializing} onClick={() => void initialize('init')}>
              Iniciar Git
            </button>
          </div>
        )}
        {activeTab === 'git' && missing.length > 0 && (
          <div className="no-git">
            <p>
              {missing.length === 1 ? 'Um submódulo ainda não foi baixado' : `${missing.length} submódulos ainda não foram baixados`}: {missing.join(', ')}
            </p>
            <button className="git-button" disabled={initializing} onClick={() => void initialize('init-submodules')}>
              {initializing ? 'Baixando…' : 'Baixar submódulos'}
            </button>
          </div>
        )}
        {problem && (
          <p className="result failed panel-problem" role="alert">
            {problem}
          </p>
        )}
        {activeTab === 'git' &&
          repos.map((repo) => (
            <RepoBlock key={repo.path} threadId={threadId} repo={repo} alone={repos.length === 1} refreshKey={refreshKey} status={statuses[repo.path]} commitModel={commitModel} onStatus={reportStatus} onView={setViewing} />
          ))}
        {activeTab === 'files' && <FilesTab threadId={threadId} statuses={statuses} refreshKey={refreshKey} onView={setViewing} />}
      </div>
      {viewing && <Viewer threadId={threadId} viewing={viewing} onClose={() => setViewing(null)} />}
    </aside>
  )
}
