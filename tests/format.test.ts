import { describe, expect, it } from 'vitest'
import { toolActivity } from '../src/renderer/src/format'

describe('compact tool activities', () => {
  it('names file work without including file contents', () => {
    expect(toolActivity('read_file', { path: 'src/renderer/Transcript.tsx' })).toBe('Leitura de Transcript.tsx')
    expect(toolActivity('edit_file', { path: 'src/styles.css', old_string: 'private', new_string: 'other' })).toBe('Edição de styles.css')
    expect(toolActivity('write_file', { path: 'C:\\project\\notes.txt', content: 'private' })).toBe('Gravação de notes.txt')
    expect(toolActivity('list_dir', {})).toBe('Arquivos de projeto')
    expect(toolActivity('search', { pattern: 'tool-row' })).toBe('Busca por “tool-row”')
  })

  it('summarizes common validation commands without claiming a current subprocess', () => {
    expect(toolActivity('run_command', { command: 'npm run typecheck; if ($LASTEXITCODE -eq 0) { npm run build }; npm test' })).toBe('Validação: tipos, build, testes')
    expect(toolActivity('run_command', { command: 'npm run test:e2e' })).toBe('Validação: testes')
    expect(toolActivity('run_command', { command: 'npx playwright test -g tools' })).toBe('Validação: testes')
    expect(toolActivity('run_command', { command: 'pnpm build' })).toBe('Validação: build')
    expect(toolActivity('run_command', { command: 'echo hello' })).toBe('Comando: echo hello')
  })

  it('handles external tools, missing inputs and long commands', () => {
    expect(toolActivity('mcp__chrome__browser_navigate', { url: 'https://example.com' })).toBe('chrome · browser_navigate · https://example.com')
    expect(toolActivity('read_file', null)).toBe('Leitura de arquivo')
    expect(toolActivity('run_command', { command: 'echo ' + 'x'.repeat(200) })).toHaveLength(99)
    expect(toolActivity('run_command', { command: 'echo first\nsecond' })).not.toContain('\n')
    expect(toolActivity('ask_user', {})).toBe('Perguntas para você')
  })
})
