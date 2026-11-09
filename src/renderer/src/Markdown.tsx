import { Check, Copy } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './store'

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object' && 'props' in node) return textContent((node.props as { children?: ReactNode }).children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const copy = async (): Promise<void> => {
    try {
      await api.system.copyText(textContent(children).replace(/\n$/, ''))
      setStatus('copied')
    } catch {
      setStatus('error')
    }
    setTimeout(() => setStatus('idle'), 1500)
  }
  return (
    <div className="code-block">
      <button className="code-copy" onClick={() => void copy()} aria-label={status === 'copied' ? 'Copiado' : status === 'error' ? 'Não foi possível copiar' : 'Copiar código'} title={status === 'error' ? 'Não foi possível copiar' : status === 'copied' ? 'Copiado' : 'Copiar'}>
        {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

// react-markdown does not render raw HTML, so model output can't inject markup.
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault()
        if (href) void api.system.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  // Remote images would phone home with whatever a prompt injection put in the URL.
  img: ({ alt, src }) => <span className="blocked-image" title={src}>[imagem: {alt || 'sem descrição'}]</span>
}

const remarkPlugins = [remarkGfm]

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
