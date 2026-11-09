import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ApprovalPreview } from '../../shared/types'
import { ASK_TOOL, PLAN_TOOL, type Tool, type ToolResult } from './types'

const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 1000
const MAX_OUTPUT_CHARS = 30_000
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_FILE_BYTES = 1_000_000
const MAX_LIST_ENTRIES = 300
const PREVIEW_CHARS = 20_000
const COMMAND_HEAD_CHARS = 8000
const COMMAND_TAIL_CHARS = 4000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.venv', '__pycache__', 'target', '.cache'])
const SENSITIVE_FILE =
  /(^|[\\/])(\.env(\.(?!example$|sample$|template$)[^\\/]+)?|[^\\/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc|secrets?\.(json|ya?ml|toml))$/i

class ToolFailure extends Error {}

export function isSensitivePath(file: string): boolean {
  return SENSITIVE_FILE.test(file)
}

/** Follows symlinks on the deepest part of the path that exists, so a link can't escape the folder. */
export async function resolveInside(root: string, requested: string): Promise<string> {
  const absolute = path.resolve(root, requested)
  let existing = absolute
  let real: string
  for (;;) {
    try {
      real = await realpath(existing)
      break
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) throw new ToolFailure(`Caminho inválido: ${requested}`)
      existing = parent
    }
  }
  const final = path.join(real, path.relative(existing, absolute))
  const relative = path.relative(await realpath(root), final)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolFailure(`Fora da pasta de trabalho: ${requested}`)
  }
  return final
}

function asString(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? (input[key] as string) : ''
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[… ${text.length - MAX_OUTPUT_CHARS} caracteres omitidos]`
}

function globToRegex(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'i')
}

export async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function truncatedPreview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n[… prévia cortada]` : text
}

/** Stops API keys in the app's own environment from reaching commands a model chose to run. */
function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/(_API_KEY|_AUTH_TOKEN|_SECRET)$/i.test(name))
  )
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    // taskkill alone can miss a child created while it enumerates the tree.
    // Visit both the pre-kill snapshot and orphaned children after each parent dies.
    const script = [
      '$pending = [System.Collections.Generic.Queue[int]]::new()',
      '$seen = [System.Collections.Generic.HashSet[int]]::new()',
      `$pending.Enqueue(${pid})`,
      'while ($pending.Count -gt 0) {',
      '  $targetId = $pending.Dequeue()',
      '  if (-not $seen.Add($targetId)) { continue }',
      '  $before = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetId" -ErrorAction SilentlyContinue)',
      '  & "$env:SystemRoot\\System32\\taskkill.exe" /PID $targetId /T /F 2>$null | Out-Null',
      '  $after = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetId" -ErrorAction SilentlyContinue)',
      '  foreach ($descendant in ($before + $after)) { $pending.Enqueue([int]$descendant.ProcessId) }',
      '}'
    ].join('\n')
    const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore', env: commandEnvironment() })
    killer.on('error', () => {
      // Best effort if the helper cannot start; never let its error crash Electron.
      try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return Promise.resolve({ content: 'Cancelado pelo usuário.', isError: true })
  return new Promise((resolve) => {
    const windows = process.platform === 'win32'
    const child = windows
      ? spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`],
          { cwd, windowsHide: true, env: commandEnvironment() }
        )
      : spawn(process.env.SHELL || '/bin/bash', ['-c', command], { cwd, detached: true, env: commandEnvironment() })

    let head = ''
    let tail = ''
    let dropped = 0
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (head.length < COMMAND_HEAD_CHARS) {
        const room = COMMAND_HEAD_CHARS - head.length
        head += text.slice(0, room)
        tail += text.slice(room)
      } else {
        tail += text
      }
      if (tail.length > COMMAND_TAIL_CHARS) {
        dropped += tail.length - COMMAND_TAIL_CHARS
        tail = tail.slice(-COMMAND_TAIL_CHARS)
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let ending: string | null = null
    const end = (reason: string): void => {
      ending = reason
      killTree(child.pid)
    }
    const timer = setTimeout(() => end(`Tempo esgotado após ${timeoutMs} ms.`), timeoutMs)
    const onAbort = (): void => end('Cancelado pelo usuário.')
    signal.addEventListener('abort', onAbort, { once: true })

    const finish = (result: ToolResult): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    child.on('error', (error) => finish({ content: `Não foi possível executar: ${error.message}`, isError: true }))
    child.on('close', (code) => {
      const output = dropped > 0 ? `${head}\n[… ${dropped} caracteres omitidos]\n${tail}` : head + tail
      const status = ending ?? (code === 0 ? '' : `Código de saída: ${code}`)
      finish({ content: [output.trimEnd(), status].filter(Boolean).join('\n') || '(sem saída)', isError: ending !== null || code !== 0 })
    })
  })
}

const pathPreview = (input: Record<string, unknown>): ApprovalPreview => ({ kind: 'path', path: asString(input, 'path') })

/** The tools every model gets when a conversation has a folder. */
export function workspaceTools(root: string): Tool[] {
  const tools: Tool[] = [
    {
      name: PLAN_TOOL,
      description:
        'Show the user a short task list while you work. Use it for work with three or more steps: send the whole list each time, keep exactly one step in_progress, and update it as steps finish.',
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'The step, in a few words, in the language of the conversation.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['items']
      },
      risk: () => 'read',
      preview: (input) => ({ kind: 'json', json: JSON.stringify(input, null, 2) }),
      run: async () => ({ content: 'Lista atualizada.' })
    },
    {
      name: ASK_TOOL,
      description:
        'Ask the user one to four questions, each with two to four options to click, and wait for the answers. Whenever you need a decision or a preference from the user, use this instead of asking in the text of your reply: choosing is faster than typing. Put the option you recommend first and say so in its label, in the language of the conversation. The user can also answer in their own words, or skip.',
      schema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The complete question, in the language of the conversation.' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'The choice, in one to five words.' },
                      description: { type: 'string', description: 'What choosing it means, in one short sentence.' }
                    },
                    required: ['label']
                  }
                },
                multiple: { type: 'boolean', description: 'True when more than one option can be chosen.' }
              },
              required: ['question', 'options']
            }
          }
        },
        required: ['questions']
      },
      risk: () => 'read',
      preview: (input) => ({ kind: 'json', json: JSON.stringify(input, null, 2) }),
      // The run loop shows the questions and waits. This only answers where nobody can.
      run: async () => ({ content: 'Não há como mostrar perguntas agora. Pergunte no texto da resposta.', isError: true })
    },
    {
      name: 'read_file',
      description: `Read a text file in the working folder. Returns up to ${MAX_READ_LINES} lines; use offset and limit for more.`,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working folder.' },
          offset: { type: 'integer', minimum: 1, description: 'First line to read, starting at 1.' },
          limit: { type: 'integer', minimum: 1, description: 'Number of lines to read.' }
        },
        required: ['path']
      },
      risk: (input) => (isSensitivePath(asString(input, 'path')) ? 'sensitive' : 'read'),
      preview: pathPreview,
      async run(input) {
        const file = await resolveInside(root, asString(input, 'path'))
        const buffer = await readFile(file)
        if (buffer.subarray(0, 8000).includes(0)) throw new ToolFailure('Arquivo binário: não é possível ler como texto.')
        const lines = buffer.toString('utf8').split(/\r?\n/)
        const offset = Math.max(1, Number(input.offset) || 1)
        const limit = Math.min(MAX_READ_LINES, Number(input.limit) || MAX_READ_LINES)
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const footer = offset - 1 + limit < lines.length ? `\n[Mostrando linhas ${offset}-${offset + slice.length - 1} de ${lines.length}]` : ''
        return { content: clip(slice.join('\n') + footer) }
      }
    },
    {
      name: 'list_dir',
      description: 'List the files and folders in a directory of the working folder. Folders end with a slash.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to the working folder. Defaults to its root.' } }
      },
      risk: () => 'read',
      preview: pathPreview,
      async run(input) {
        const dir = await resolveInside(root, asString(input, 'path') || '.')
        const entries = await readdir(dir, { withFileTypes: true })
        const names = entries
          .filter((entry) => entry.name !== '.git')
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b))
        const shown = names.slice(0, MAX_LIST_ENTRIES)
        const more = names.length > shown.length ? `\n[… mais ${names.length - shown.length} itens]` : ''
        return { content: (shown.join('\n') || '(pasta vazia)') + more }
      }
    },
    {
      name: 'search',
      description: 'Search file contents with a regular expression. Skips dependency folders, binaries and files that usually hold secrets.',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Case-insensitive regular expression.' },
          path: { type: 'string', description: 'Directory to search, relative to the working folder.' },
          glob: { type: 'string', description: 'Only files whose relative path matches, such as src/**/*.ts' }
        },
        required: ['pattern']
      },
      risk: () => 'read',
      preview: (input) => ({ kind: 'path', path: asString(input, 'pattern') }),
      async run(input, signal) {
        let pattern: RegExp
        try {
          pattern = new RegExp(asString(input, 'pattern'), 'i')
        } catch (error) {
          throw new ToolFailure(`Expressão regular inválida: ${(error as Error).message}`)
        }
        const start = await resolveInside(root, asString(input, 'path') || '.')
        const realRoot = await realpath(root)
        const glob = asString(input, 'glob') ? globToRegex(asString(input, 'glob')) : null
        const matches: string[] = []
        for await (const file of walk(start)) {
          if (signal.aborted || matches.length >= MAX_SEARCH_MATCHES) break
          const relative = path.relative(realRoot, file).replaceAll('\\', '/')
          if (isSensitivePath(relative) || (glob && !glob.test(relative))) continue
          const info = await stat(file).catch(() => null)
          if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue
          const buffer = await readFile(file).catch(() => null)
          if (!buffer || buffer.subarray(0, 8000).includes(0)) continue
          const lines = buffer.toString('utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
            if (pattern.test(lines[i])) matches.push(`${relative}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
          }
        }
        const more = matches.length >= MAX_SEARCH_MATCHES ? `\n[Limite de ${MAX_SEARCH_MATCHES} resultados atingido]` : ''
        return { content: clip((matches.join('\n') || 'Nenhum resultado.') + more) }
      }
    },
    {
      name: 'write_file',
      description: 'Create a file or replace its whole content. Prefer edit_file for changes to an existing file.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working folder.' },
          content: { type: 'string', description: 'The full content of the file.' }
        },
        required: ['path', 'content']
      },
      risk: (input) => (isSensitivePath(asString(input, 'path')) ? 'sensitive' : 'write'),
      preview: (input) => {
        const content = asString(input, 'content')
        return { kind: 'write', path: asString(input, 'path'), content: truncatedPreview(content), truncated: content.length > PREVIEW_CHARS }
      },
      async run(input) {
        const file = await resolveInside(root, asString(input, 'path'))
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, asString(input, 'content'), 'utf8')
        return { content: `Arquivo gravado: ${asString(input, 'path')}` }
      }
    },
    {
      name: 'edit_file',
      description: 'Replace an exact piece of text in a file. old_string must match exactly and appear once, unless replace_all is true.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working folder.' },
          old_string: { type: 'string', description: 'The exact text to find, with enough context to be unique.' },
          new_string: { type: 'string', description: 'The text to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' }
        },
        required: ['path', 'old_string', 'new_string']
      },
      risk: (input) => (isSensitivePath(asString(input, 'path')) ? 'sensitive' : 'write'),
      preview: (input) => ({
        kind: 'edit',
        path: asString(input, 'path'),
        before: truncatedPreview(asString(input, 'old_string')),
        after: truncatedPreview(asString(input, 'new_string'))
      }),
      async run(input) {
        const file = await resolveInside(root, asString(input, 'path'))
        const oldText = asString(input, 'old_string')
        if (!oldText) throw new ToolFailure('old_string não pode ser vazio.')
        const current = await readFile(file, 'utf8')
        const count = current.split(oldText).length - 1
        if (count === 0) throw new ToolFailure('old_string não foi encontrado no arquivo.')
        if (count > 1 && input.replace_all !== true) {
          throw new ToolFailure(`old_string aparece ${count} vezes. Inclua mais contexto ou use replace_all.`)
        }
        // Function replacers keep "$&" and friends in new_string literal.
        const newText = asString(input, 'new_string')
        const updated = input.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText)
        await writeFile(file, updated, 'utf8')
        return { content: `Arquivo editado: ${asString(input, 'path')} (${count} ${count === 1 ? 'troca' : 'trocas'})` }
      }
    },
    {
      name: 'run_command',
      description: `Run a shell command in the working folder (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'}). Output is returned when the command ends.`,
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          timeout_ms: { type: 'integer', minimum: 1000, description: `Time limit in milliseconds, up to ${MAX_TIMEOUT_MS}. Defaults to ${DEFAULT_TIMEOUT_MS}.` }
        },
        required: ['command']
      },
      risk: () => 'exec',
      preview: (input) => ({ kind: 'command', command: asString(input, 'command'), cwd: root }),
      run: (input, signal) =>
        runCommand(asString(input, 'command'), root, Math.min(MAX_TIMEOUT_MS, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS), signal)
    }
  ]
  return tools.map((tool) => ({ ...tool, run: guard(tool.run) }))
}

/** Failures go back to the model as results it can act on, not as crashes of the run. */
function guard(run: Tool['run']): Tool['run'] {
  return async (input, signal) => {
    try {
      return await run(input, signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { content: 'Arquivo ou pasta não encontrado.', isError: true }
      return { content: (error as Error).message, isError: true }
    }
  }
}
