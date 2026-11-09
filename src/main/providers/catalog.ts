import type { Protocol } from '../../shared/types'
import { createAnthropicAdapter } from './anthropic'
import { createGeminiAdapter } from './gemini'
import { createChatAdapter } from './openai-chat'
import { createResponsesAdapter } from './openai-responses'
import type { ProviderAdapter, ProviderConnection } from './types'

export interface ProviderDefinition {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  envKey?: string
  keyUrl?: string
  local?: boolean
  quirks?: ProviderConnection['quirks']
}

/**
 * Each list comes from the provider's own API (the built-in OpenAI and Anthropic
 * integrations additionally curate selectable IDs). Adding a vendor that speaks one of the four
 * protocols is one line, and anyone else can be added as a custom provider.
 */
export const PROVIDER_CATALOG: ProviderDefinition[] = [
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI', protocol: 'openai-chat', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', keyUrl: 'https://console.x.ai' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'mistral', name: 'Mistral', protocol: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', quirks: { noStreamOptions: true, shortToolIds: true } },
  { id: 'groq', name: 'Groq', protocol: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys' },
  { id: 'together', name: 'Together AI', protocol: 'openai-chat', baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'com4', name: 'COM4', protocol: 'openai-chat', baseUrl: 'https://llm.com4.com.br/v1' },
  { id: 'ollama', name: 'Ollama (local)', protocol: 'openai-chat', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', name: 'LM Studio (local)', protocol: 'openai-chat', baseUrl: 'http://localhost:1234/v1', local: true }
]

export function createAdapter(connection: ProviderConnection): ProviderAdapter {
  switch (connection.protocol) {
    case 'anthropic':
      return createAnthropicAdapter(connection)
    case 'openai-responses':
      return createResponsesAdapter(connection)
    case 'gemini':
      return createGeminiAdapter(connection)
    case 'openai-chat':
      return createChatAdapter(connection)
  }
}
