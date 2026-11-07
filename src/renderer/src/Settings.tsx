import { ArrowLeft, ChevronDown, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { McpStatus, ModelInfo, Preferences, Protocol, ProviderTest, ProviderView } from '../../shared/types'
import { remoteErrorMessage } from './format'
import { api } from './store'

import { Updates } from './Updates'

type Tab = 'providers' | 'mcp' | 'memory' | 'updates'

interface SettingsProps {
  providers: ProviderView[]
  models: ModelInfo[]
  errors: Record<string, string>
  mcp: McpStatus[]
  prefs: Preferences
  onProviders(providers: ProviderView[]): void
  onMcp(servers: McpStatus[]): void
  onPrefs(patch: Partial<Preferences>): Promise<void>
  onClose(): void
}

const PROTOCOL_NAMES: Record<Protocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'Compatível com OpenAI',
  gemini: 'Google Gemini'
}

const MCP_PRESETS: { label: string; note: string; json: unknown }[] = [
  {
    label: 'Chrome (perfil separado)',
    note: 'Abre um Chrome próprio, sem os seus logins. É o jeito mais seguro de começar.',
    json: { mcpServers: { chrome: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser', 'chrome'] } } }
  },
  {
    label: 'Chrome (seus logins)',
    note: 'Usa as abas e os logins do seu Chrome. Instale antes a extensão Playwright MCP Bridge e só permita o que precisar: o modelo agirá nas suas contas.',
    json: { mcpServers: { 'chrome-logado': { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--extension'] } } }
  },
  {
    label: 'Chrome DevTools',
    note: 'Conecta ao Chrome aberto para inspecionar páginas, rede, console e desempenho. Requer uma versão recente do Chrome.',
    json: { mcpServers: { 'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'] } } }
  },
  { label: 'Claude Code', note: 'Requer o CLI claude instalado', json: { mcpServers: { 'claude-code': { command: 'claude', args: ['mcp', 'serve'] } } } },
  { label: 'Codex', note: 'Requer o CLI codex instalado', json: { mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } } },
  { label: 'Sistema de arquivos', note: 'Troque o caminho no final', json: { mcpServers: { arquivos: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/caminho/da/pasta'] } } } }
]

function firstLine(text: string): string {
  return text.split('\n')[0]
}

function ProviderRow({ provider, models, error, onProviders, onDone }: { provider: ProviderView; models: ModelInfo[]; error?: string; onProviders(list: ProviderView[]): void; onDone(): void }) {
  const count = models.filter((model) => model.provider === provider.id).length
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<ProviderTest | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => setBaseUrl(provider.baseUrl), [provider.baseUrl])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (failure) {
      setProblem(remoteErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const connected = count > 0
  const state = error ? 'error' : connected ? 'connected' : provider.keySource ? 'idle' : 'off'
  const stateText = error
    ? 'Com erro'
    : connected
      ? `${count} ${count === 1 ? 'modelo' : 'modelos'}`
      : provider.local
        ? 'Não detectado'
        : provider.keySource
          ? 'Chave salva'
          : 'Sem chave'

  const saveAndTest = () =>
    run(async () => {
      if (key.trim()) {
        onProviders(await api.providers.setKey(provider.id, key))
        setKey('')
      }
      if (baseUrl.trim() !== provider.baseUrl) onProviders(await api.providers.setBaseUrl(provider.id, baseUrl))
      setTest(await api.providers.test(provider.id))
      onProviders(await api.providers.list())
    })

  return (
    <div className={`provider${open ? ' open' : ''}`}>
      <button className="provider-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`status-dot ${state}`} aria-hidden />
        <span className="provider-name">{provider.name}</span>
        <span className="provider-state">{stateText}</span>
        <ChevronDown size={14} className="provider-chevron" aria-hidden />
      </button>
      {open && (
        <div className="provider-body">
          {provider.keySource === 'env' && <p className="hint">Usando {provider.envKey} do seu ambiente. Uma chave salva aqui tem prioridade.</p>}
          {!provider.local && (
            <label className="field">
              <span>
                Chave de API
                {provider.keyUrl && (
                  <a
                    className="field-link"
                    href={provider.keyUrl}
                    onClick={(event) => {
                      event.preventDefault()
                      void api.system.openExternal(provider.keyUrl!)
                    }}
                  >
                    Obter uma chave <ExternalLink size={11} aria-hidden />
                  </a>
                )}
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={provider.keySource === 'saved' ? '•••••••• salva e criptografada' : 'Cole sua chave'}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>Endereço</span>
            <input spellCheck={false} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <div className="row-actions">
            <button className="button primary" disabled={busy} onClick={() => void saveAndTest()}>
              {busy ? 'Conectando…' : key.trim() ? 'Salvar e conectar' : 'Testar conexão'}
            </button>
            {provider.keySource === 'saved' && (
              <button className="button quiet" disabled={busy} onClick={() => void run(async () => onProviders(await api.providers.setKey(provider.id, null)))}>
                Remover chave
              </button>
            )}
            {provider.custom && (
              <button className="button quiet" disabled={busy} onClick={() => void run(async () => onProviders(await api.providers.removeCustom(provider.id)))}>
                Remover provedor
              </button>
            )}
            {test?.ok && <span className="result ok">Conectado: {test.count} modelos</span>}
          </div>
          {test?.ok && (
            <button className="button start-chat" onClick={onDone}>
              Começar a conversar
            </button>
          )}
          {(test?.error || problem || error) && <p className="result failed">{firstLine(problem ?? test?.error ?? error ?? '')}</p>}
        </div>
      )}
    </div>
  )
}

function CustomProviderForm({ onProviders }: { onProviders(list: ProviderView[]): void }) {
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('openai-chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setProblem(null)
    try {
      onProviders(await api.providers.addCustom({ name, protocol, baseUrl, key }))
      setName('')
      setBaseUrl('')
      setKey('')
    } catch (failure) {
      setProblem(remoteErrorMessage(failure))
    }
  }

  return (
    <div className="custom-form">
      <h3>Adicionar outro provedor</h3>
      <p className="hint">Qualquer serviço que fale um destes protocolos funciona aqui, inclusive gateways da sua empresa.</p>
      <div className="form-grid">
        <label className="field">
          <span>Nome</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Meu gateway" />
        </label>
        <label className="field">
          <span>Protocolo</span>
          <select value={protocol} onChange={(event) => setProtocol(event.target.value as Protocol)}>
            {Object.entries(PROTOCOL_NAMES).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Endereço</span>
          <input spellCheck={false} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://exemplo.com/v1" />
        </label>
        <label className="field">
          <span>Chave de API (opcional)</span>
          <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
        </label>
      </div>
      <div className="row-actions">
        <button className="button" disabled={!name.trim() || !baseUrl.trim()} onClick={() => void add()}>
          Adicionar
        </button>
        {problem && <span className="result failed">{problem}</span>}
      </div>
    </div>
  )
}

function ProvidersTab({ providers, models, errors, onProviders, onClose }: Pick<SettingsProps, 'providers' | 'models' | 'errors' | 'onProviders' | 'onClose'>) {
  const row = (provider: ProviderView) => <ProviderRow key={provider.id} provider={provider} models={models} error={errors[provider.id]} onProviders={onProviders} onDone={onClose} />
  const cloud = providers.filter((provider) => !provider.local && !provider.custom)
  const local = providers.filter((provider) => provider.local)
  const custom = providers.filter((provider) => provider.custom)
  return (
    <>
      <h2>Provedores</h2>
      <p className="lede">Cada modelo vem direto da API do provedor, então a lista se atualiza sozinha. As chaves ficam criptografadas neste computador e só vão para o provedor delas.</p>
      <div className="provider-list">{cloud.map(row)}</div>
      <h3>Na sua máquina</h3>
      <div className="provider-list">{local.map(row)}</div>
      {custom.length > 0 && (
        <>
          <h3>Seus provedores</h3>
          <div className="provider-list">{custom.map(row)}</div>
        </>
      )}
      <CustomProviderForm onProviders={onProviders} />
    </>
  )
}

function McpTab({ mcp, onMcp }: Pick<SettingsProps, 'mcp' | 'onMcp'>) {
  const [json, setJson] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [presetNote, setPresetNote] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setProblem(null)
    try {
      onMcp(await api.mcp.add(json))
      setJson('')
    } catch (failure) {
      setProblem(remoteErrorMessage(failure))
    }
  }

  return (
    <>
      <h2>Ferramentas MCP</h2>
      <p className="lede">Um servidor conectado aqui fica disponível para todos os modelos, mesmo os que não têm suporte próprio a MCP. Cada uso pede a sua confirmação.</p>
      {mcp.length > 0 && (
        <div className="provider-list">
          {mcp.map((server) => (
            <div className="mcp-server" key={server.name}>
              <div className="mcp-head">
                <span className={`status-dot ${server.status === 'connected' ? 'connected' : server.status === 'error' ? 'error' : 'idle'}`} aria-hidden />
                <span className="provider-name">{server.name}</span>
                <span className="provider-state">
                  {server.status === 'connected' ? `${server.tools.length} ${server.tools.length === 1 ? 'ferramenta' : 'ferramentas'}` : server.status === 'connecting' ? 'Conectando…' : 'Com erro'}
                </span>
                <button className="icon-button" aria-label={`Reconectar ${server.name}`} title="Reconectar" onClick={() => void api.mcp.reconnect(server.name).then(onMcp)}>
                  <RefreshCw size={13} />
                </button>
                <button className="icon-button" aria-label={`Remover ${server.name}`} title="Remover" onClick={() => void api.mcp.remove(server.name).then(onMcp)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <code className="mcp-target">{server.target}</code>
              {server.secretNames.length > 0 && <p className="hint">Segredos guardados: {server.secretNames.join(', ')}</p>}
              {server.error && <p className="result failed">{server.error}</p>}
            </div>
          ))}
        </div>
      )}
      <h3>Adicionar servidor</h3>
      <p className="hint">Cole o mesmo JSON que você usaria em outros clientes MCP. Só adicione servidores em que confia: eles rodam com as suas permissões.</p>
      <div className="preset-row">
        {MCP_PRESETS.map((preset) => (
          <button
            className="chip"
            key={preset.label}
            title={preset.note}
            onClick={() => {
              setJson(JSON.stringify(preset.json, null, 2))
              setPresetNote(preset.note)
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {presetNote && <p className="hint preset-note">{presetNote}</p>}
      <p className="hint">No navegador, uma página pode tentar dar ordens ao modelo. Por isso, cada ação pede a sua confirmação.</p>
      <textarea
        className="json-input"
        aria-label="Configuração MCP em JSON"
        spellCheck={false}
        rows={7}
        value={json}
        placeholder={'{\n  "mcpServers": {\n    "meu-servidor": { "command": "npx", "args": ["-y", "pacote"] }\n  }\n}'}
        onChange={(event) => setJson(event.target.value)}
      />
      <div className="row-actions">
        <button className="button primary" disabled={!json.trim()} onClick={() => void add()}>
          Conectar
        </button>
        {problem && <span className="result failed">{problem}</span>}
      </div>
    </>
  )
}

function MemoryTab({ prefs, onPrefs }: Pick<SettingsProps, 'prefs' | 'onPrefs'>) {
  const [memory, setMemory] = useState(prefs.memory)
  const [saved, setSaved] = useState(false)
  const dirty = memory !== prefs.memory
  return (
    <>
      <h2>Memória</h2>
      <p className="lede">O que você escrever aqui vai para todos os modelos, em toda conversa nova. Arquivos AGENTS.md, CLAUDE.md, GEMINI.md e .cursorrules da pasta de trabalho entram junto, então instruções escritas para uma ferramenta passam a valer para todas.</p>
      <textarea
        className="memory-input"
        aria-label="Memória global"
        rows={12}
        value={memory}
        placeholder="Ex.: Trabalho com TypeScript. Prefiro respostas curtas, em português."
        onChange={(event) => {
          setMemory(event.target.value)
          setSaved(false)
        }}
      />
      <div className="row-actions">
        <button
          className="button primary"
          disabled={!dirty}
          onClick={() =>
            void onPrefs({ memory }).then(() => {
              setSaved(true)
            })
          }
        >
          Salvar
        </button>
        {saved && !dirty && <span className="result ok">Salvo. Vale a partir da próxima conversa.</span>}
      </div>
    </>
  )
}

export function Settings(props: SettingsProps) {
  const [tab, setTab] = useState<Tab>('providers')
  const { onClose } = props

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabs: [Tab, string][] = [
    ['providers', 'Provedores'],
    ['mcp', 'Ferramentas MCP'],
    ['memory', 'Memória'],
    ['updates', 'Atualizações']
  ]

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Ajustes">
      <nav className="settings-nav">
        <div className="settings-top">
          <button className="settings-back" onClick={onClose} title="Voltar (Esc)">
            <ArrowLeft size={14} aria-hidden /> Voltar à conversa
          </button>
        </div>
        <div className="settings-title">Ajustes</div>
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-page">
          {tab === 'providers' && <ProvidersTab providers={props.providers} models={props.models} errors={props.errors} onProviders={props.onProviders} onClose={onClose} />}
          {tab === 'mcp' && <McpTab mcp={props.mcp} onMcp={props.onMcp} />}
          {tab === 'memory' && <MemoryTab prefs={props.prefs} onPrefs={props.onPrefs} />}
          {tab === 'updates' && <Updates />}
        </div>
      </div>
    </div>
  )
}
