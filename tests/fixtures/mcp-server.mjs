// A small real MCP server over stdio, for tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'servidor-teste', version: '1.0.0' })

server.registerTool(
  'somar',
  {
    description: 'Soma dois números.',
    inputSchema: { a: z.number(), b: z.number() }
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
)

server.registerTool(
  'falhar',
  { description: 'Sempre falha.', inputSchema: {} },
  async () => ({ isError: true, content: [{ type: 'text', text: 'falhou de propósito' }] })
)

await server.connect(new StdioServerTransport())
