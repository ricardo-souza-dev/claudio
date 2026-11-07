import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpStatus } from '../../shared/types'
import { normalizeSchema } from '../providers/history'
import type { Tool, ToolResult } from './types'

const CONNECT_TIMEOUT_MS = 60_000
const CALL_TIMEOUT_MS = 300_000
const MAX_RESULT_CHARS = 100_000
const MAX_TOOL_NAME = 64

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** Accepts the JSON format most MCP clients share, so existing configs can simply be pasted. */
export function parseMcpJson(json: string): McpServerConfig[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`JSON inválido: ${(error as Error).message}`)
  }
  const root = parsed as { mcpServers?: unknown } | null
  const servers = root?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('O JSON precisa ter um objeto "mcpServers".')
  }
  return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, entry]) => {
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`Nome de servidor inválido: ${name}`)
    if (typeof entry.command === 'string' && entry.command) {
      return {
        name,
        transport: 'stdio' as const,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: stringMap(entry.env),
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined
      }
    }
    if (typeof entry.url === 'string' && /^https?:\/\//.test(entry.url)) {
      return { name, transport: 'http' as const, url: entry.url, headers: stringMap(entry.headers) }
    }
    throw new Error(`"${name}" precisa de "command" ou de uma "url" http(s).`)
  })
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

/** One naming rule for every provider: the strictest charset and length among them. */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.length <= MAX_TOOL_NAME) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`
}

function resultText(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): ToolResult {
  const blocks = Array.isArray(result.content) ? (result.content as Record<string, any>[]) : []
  const pieces = blocks.map((block) => {
    if (block.type === 'text') return String(block.text)
    if (block.type === 'resource') return String(block.resource?.text ?? `[recurso: ${block.resource?.uri}]`)
    if (block.type === 'resource_link') return `[recurso: ${block.uri}]`
    return `[conteúdo ${block.type} omitido]`
  })
  if (pieces.length === 0 && result.structuredContent !== undefined) pieces.push(JSON.stringify(result.structuredContent))
  const text = pieces.join('\n') || '(sem conteúdo)'
  return {
    content: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[… resultado cortado]` : text,
    isError: result.isError === true
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

interface Connection {
  config: McpServerConfig
  status: McpStatus
  client?: Client
  tools: Tool[]
  /** Guards against a slow connect finishing after the server was removed or reconnected. */
  generation: number
}

export class McpManager {
  private connections = new Map<string, Connection>()

  constructor(private onChange: (servers: McpStatus[]) => void) {}

  status(): McpStatus[] {
    return [...this.connections.values()].map((connection) => connection.status)
  }

  tools(): Tool[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools)
  }

  has(name: string): boolean {
    return this.connections.has(name)
  }

  connect(config: McpServerConfig): void {
    const previous = this.connections.get(config.name)
    const generation = (previous?.generation ?? 0) + 1
    void previous?.client?.close().catch(() => undefined)
    const connection: Connection = {
      config,
      generation,
      tools: [],
      status: {
        name: config.name,
        transport: config.transport,
        target: config.transport === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : (config.url ?? ''),
        secretNames: Object.keys(config.env ?? config.headers ?? {}),
        status: 'connecting',
        tools: []
      }
    }
    this.connections.set(config.name, connection)
    this.onChange(this.status())
    void this.open(connection)
  }

  async remove(name: string): Promise<void> {
    const connection = this.connections.get(name)
    this.connections.delete(name)
    await connection?.client?.close().catch(() => undefined)
    this.onChange(this.status())
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.client?.close().catch(() => undefined)))
  }

  private isCurrent(connection: Connection): boolean {
    return this.connections.get(connection.config.name)?.generation === connection.generation
  }

  private update(connection: Connection, patch: Partial<McpStatus>): void {
    if (!this.isCurrent(connection)) return
    connection.status = { ...connection.status, ...patch }
    this.onChange(this.status())
  }

  private async open(connection: Connection): Promise<void> {
    const { config } = connection
    try {
      const client = await withTimeout(
        config.transport === 'stdio' ? this.openStdio(config) : this.openHttp(config),
        CONNECT_TIMEOUT_MS,
        'O servidor não respondeu a tempo.'
      )
      if (!this.isCurrent(connection)) {
        await client.close().catch(() => undefined)
        return
      }
      connection.client = client
      client.onclose = () => {
        connection.tools = []
        this.update(connection, { status: 'error', error: 'A conexão foi encerrada.', tools: [] })
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(connection).catch(() => undefined)
      })
      await this.refreshTools(connection)
    } catch (error) {
      this.update(connection, { status: 'error', error: (error as Error).message })
    }
  }

  private async openStdio(config: McpServerConfig): Promise<Client> {
    const client = new Client({ name: 'claudio', version: '0.1.0' })
    await client.connect(
      new StdioClientTransport({
        command: config.command!,
        args: config.args,
        cwd: config.cwd,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: 'ignore'
      })
    )
    return client
  }

  private async openHttp(config: McpServerConfig): Promise<Client> {
    const url = new URL(config.url!)
    const requestInit = config.headers ? { headers: config.headers } : undefined
    const client = new Client({ name: 'claudio', version: '0.1.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
      return client
    } catch {
      // Older servers only speak the SSE transport.
      const legacy = new Client({ name: 'claudio', version: '0.1.0' })
      await legacy.connect(new SSEClientTransport(url, { requestInit }))
      return legacy
    }
  }

  private async refreshTools(connection: Connection): Promise<void> {
    const client = connection.client!
    const listed: Awaited<ReturnType<Client['listTools']>>['tools'] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      listed.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)

    connection.tools = listed.map((tool) => {
      const name = mcpToolName(connection.config.name, tool.name)
      return {
        name,
        readOnly: false,
        description: tool.description ?? `Ferramenta ${tool.name} do servidor MCP ${connection.config.name}.`,
        schema: normalizeSchema(tool.inputSchema),
        // A server's own read-only annotation is only a claim, so it is not trusted.
        risk: () => 'external' as const,
        preview: (input: Record<string, unknown>) => ({ kind: 'json' as const, json: JSON.stringify(input, null, 2) }),
        run: async (input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> => {
          try {
            const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
              signal,
              timeout: CALL_TIMEOUT_MS
            })
            return resultText(result as Parameters<typeof resultText>[0])
          } catch (error) {
            return { content: `Falha em ${tool.name}: ${(error as Error).message}`, isError: true }
          }
        }
      }
    })
    this.update(connection, {
      status: 'connected',
      error: undefined,
      tools: connection.tools.map((tool) => ({ name: tool.name, description: tool.description }))
    })
  }
}
