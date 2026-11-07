import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AttachmentPart, Message, ModelInfo, OutgoingAttachment } from '../shared/types'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PDF_TYPE = 'application/pdf'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_PER_MESSAGE = 10
const TEXT_TYPE = 'text/plain'

const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

/**
 * Attachments stay out of the conversation file, which is rewritten on every step, so a few
 * screenshots don't slow everything down. They're named by their content, which also means
 * that re-reading one always gives back the same bytes, as replaying a conversation requires.
 */
export class AttachmentStore {
  private dir: string

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'attachments')
  }

  async save(attachments: OutgoingAttachment[]): Promise<AttachmentPart[]> {
    if (attachments.length > MAX_PER_MESSAGE) throw new Error(`Anexe até ${MAX_PER_MESSAGE} arquivos por mensagem.`)
    await mkdir(this.dir, { recursive: true })
    const parts: AttachmentPart[] = []
    for (const attachment of attachments) {
      const bytes = Buffer.from(attachment.data, 'base64')
      const mediaType = this.classify(attachment, bytes)
      const ref = createHash('sha256').update(bytes).digest('hex')
      await writeFile(path.join(this.dir, ref), bytes)
      parts.push({ type: 'attachment', name: attachment.name, mediaType, size: bytes.length, ref })
    }
    return parts
  }

  private classify(attachment: OutgoingAttachment, bytes: Buffer): string {
    const { name, mediaType } = attachment
    const limit = (max: number): void => {
      if (bytes.length > max) throw new Error(`“${name}” passa do limite de ${megabytes(max)}.`)
    }
    if (IMAGE_TYPES.has(mediaType)) {
      limit(MAX_IMAGE_BYTES)
      return mediaType
    }
    if (mediaType === PDF_TYPE) {
      limit(MAX_PDF_BYTES)
      return PDF_TYPE
    }
    // Anything else counts as text, as long as it really is: code files have no reliable media type.
    if (bytes.subarray(0, 8000).includes(0)) throw new Error(`“${name}” é um arquivo binário. Anexe imagens, PDFs ou arquivos de texto.`)
    limit(MAX_TEXT_BYTES)
    return TEXT_TYPE
  }

  private fileFor(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Referência de anexo inválida.')
    return path.join(this.dir, ref)
  }

  async preview(ref: string): Promise<string | null> {
    const bytes = await readFile(this.fileFor(ref)).catch(() => null)
    if (!bytes) return null
    const signature = bytes.subarray(0, 4).toString('hex')
    const type = signature === '89504e47' ? 'image/png' : signature.startsWith('ffd8') ? 'image/jpeg' : signature === '47494638' ? 'image/gif' : 'image/webp'
    return `data:${type};base64,${bytes.toString('base64')}`
  }

  /**
   * Fills in the bytes for one request. What a model can't read becomes a note, so the
   * conversation carries on rather than failing, and the file stays for models that can.
   */
  async load(messages: Message[], model: ModelInfo): Promise<Message[]> {
    return Promise.all(
      messages.map(async (message) => {
        if (!message.parts.some((part) => part.type === 'attachment')) return message
        const parts = await Promise.all(
          message.parts.map(async (part) => {
            if (part.type !== 'attachment') return part
            if (part.mediaType.startsWith('image/') && model.imageInput === false) {
              return { type: 'text' as const, text: `[Imagem anexada: ${part.name}. Este modelo não lê imagens.]` }
            }
            const bytes = await readFile(this.fileFor(part.ref)).catch(() => null)
            if (!bytes) return { type: 'text' as const, text: `[Anexo indisponível: ${part.name}]` }
            return { ...part, data: bytes.toString('base64') }
          })
        )
        return { ...message, parts }
      })
    )
  }
}
