# Claudio

Uma só conversa, memória e caixa de ferramentas para qualquer modelo de IA.

O Claudio é um projeto independente, sem vínculo com a Anthropic nem com os outros fornecedores que ele conecta.

Em ferramentas como o Codex e o Claude Code, a conversa fica presa a um fornecedor. Aqui, ela pertence a você: comece com um modelo, passe para outro no meio do trabalho, e o novo modelo continua de onde o anterior parou, com o mesmo histórico, as mesmas instruções e as mesmas ferramentas.

## O que "unicidade" significa aqui

| | |
|---|---|
| **Uma conversa** | Todo modelo lê e continua o mesmo histórico, inclusive as chamadas de ferramenta feitas por outro fornecedor. |
| **Uma memória** | A memória global e os arquivos `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` e `.cursorrules` chegam iguais a todos os modelos. |
| **Uma caixa de ferramentas** | Arquivos, comandos e servidores MCP ficam disponíveis para qualquer modelo que aceite ferramentas, mesmo sem suporte próprio a MCP. |
| **Uma resposta** | No modo Conselho, vários modelos respondem em paralelo e um deles une tudo em uma única resposta. Só ela entra no histórico. |

## Como rodar

Requer Node.js 22 ou mais recente.

```bash
npm install
```

```bash
npm run dev
```

Depois, abra **Ajustes → Provedores** e cole uma chave de API. A lista de modelos vem da API de cada provedor, então modelos novos aparecem sem atualizar o app. Ollama e LM Studio são detectados sozinhos se estiverem rodando.

Atalhos: `Ctrl+K` troca de modelo, `Ctrl+N` abre uma conversa nova, `Enter` envia e `Shift+Enter` quebra a linha.

## Provedores

Prontos para usar: Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral, Groq, Together AI, OpenRouter, Ollama e LM Studio. O OpenRouter, sozinho, dá acesso a centenas de modelos de outros fornecedores.

Qualquer outro serviço que fale um dos quatro protocolos (Anthropic Messages, OpenAI Responses, compatível com OpenAI ou Gemini) pode ser adicionado em **Ajustes**, sem escrever código.

## Segurança

- As chaves ficam criptografadas pelo sistema operacional e nunca chegam à interface. Uma chave vinda de variável de ambiente só é enviada ao endereço oficial do fornecedor dela.
- As ferramentas só alcançam a pasta escolhida, e links simbólicos não escapam dela.
- Alterar arquivos, executar comandos e usar MCP pedem confirmação, a menos que você escolha outro modo. Arquivos que costumam guardar segredos, como `.env`, sempre pedem.
- Comandos não recebem as chaves de API do ambiente do app, e a resposta de um modelo não vira HTML nem carrega imagens remotas.
- **Não há sandbox:** um comando aprovado roda com as suas permissões. Leia antes de permitir.

## Arquitetura

```
src/shared/types.ts      O formato canônico da conversa e o contrato entre os processos
src/main/providers/      Um adaptador por protocolo, traduzindo de e para o formato canônico
src/main/agent/          O ciclo do agente, o Conselho e as permissões em ação
src/main/tools/          Ferramentas internas e cliente MCP
src/main/store.ts        Chaves criptografadas e conversas em arquivos JSON
src/renderer/            A interface (React), sem acesso a Node
```

A decisão central está em `Message`: cada mensagem guarda as partes canônicas, que qualquer modelo entende, e também o formato original do provedor (`raw`). Quando o mesmo provedor continua a conversa, o original é reenviado byte a byte, o que preserva raciocínio assinado e cache de prompt. Quando outro provedor assume, ele recebe a versão canônica, com ids e assinaturas ajustados às regras dele.

Para adicionar um fornecedor compatível, basta uma linha em `src/main/providers/catalog.ts`.

## Testes

```bash
npm test
```

```bash
npm run test:e2e
```

Os testes usam um servidor local que simula os quatro protocolos, passando pelos SDKs oficiais de verdade, e um servidor MCP real. Os testes `e2e` abrem o Electron. Nenhum deles chama APIs reais, então não geram custo.

## Limitações atuais

- Só modelos de texto: geração de imagem, áudio e vídeo ainda não entram, e também não há anexos.
- MCP remoto funciona com cabeçalhos fixos. OAuth ainda não é suportado.
- Usa chaves de API, cobradas à parte das assinaturas como ChatGPT Plus ou Claude Max.
- Conversas muito longas ainda não são compactadas.
- Ainda não há instalador.
