# Claudio

Uma só conversa, memória e caixa de ferramentas para qualquer modelo de IA.

O Claudio é um projeto independente, sem vínculo com a Anthropic nem com os outros fornecedores que ele conecta.

Em ferramentas como o Codex e o Claude Code, a conversa fica presa a um fornecedor. Aqui, ela pertence a você: comece com um modelo, passe para outro no meio do trabalho, e o novo modelo continua de onde o anterior parou, com o mesmo histórico, as mesmas instruções e as mesmas ferramentas.

Toda conversa parte de uma pasta no seu computador, para que qualquer modelo trabalhe com o contexto geral do projeto. O Git é opcional: se a pasta for um repositório, um painel à direita reúne alterações, branches, commits e PRs, inclusive de submódulos e de outros repositórios dentro da pasta.

## O que "unicidade" significa aqui

| | |
|---|---|
| **Uma conversa** | Todo modelo lê e continua o mesmo histórico, inclusive as chamadas de ferramenta feitas por outro fornecedor. |
| **Um projeto** | Branch, endereço do repositório, nomes dos arquivos dos dois primeiros níveis e README chegam iguais a todos os modelos desde a primeira mensagem. |
| **Uma memória** | A memória global e os arquivos `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` e `.cursorrules` também chegam iguais a todos. |
| **Uma caixa de ferramentas** | Arquivos, comandos e servidores MCP ficam disponíveis para qualquer modelo que aceite ferramentas, mesmo sem suporte próprio a MCP. |

## Downloads e atualizações

O site de apresentação fica em `site/`. Para visualizar: `npm run site:dev`. A captura da interface usa apenas dados fictícios; para atualizá-la com o app atual, rode `npm run site:screenshot` (o script cria e remove um perfil e um projeto temporários, sem usar suas conversas ou chaves).

O instalador para Windows x64 é gerado com `npm run dist:win`, em `dist/`. A distribuição é uma versão de testes; um download público só existe depois de publicar uma release no GitHub. macOS e Linux ainda não estão disponíveis.

O app instalado verifica novas versões e permite baixar e reiniciar para atualizar, sem instalar automaticamente ao fechar. A instalação é bloqueada durante execuções do agente. Conversas e configurações ficam fora da pasta do programa.

Para criar uma release Windows pelo GitHub Actions, use `.\build-project-win.ps1 -Version 1.0.1` na raiz. O script confere a versão, envia commit/tag, acompanha os testes e baixa os arquivos para revisão. Depois de testar, use `-Resume -Publish` para publicar, com confirmação final. `-WhatIf` mostra o plano sem alterar nada.

Veja [o guia de distribuição](docs/distribuicao.md) para os pré-requisitos do script, publicar o site, configurar assinatura e validar atualizações. O instalador local atual não tem assinatura de código; a atualização entre duas versões instaladas ainda precisa de validação.

## Como rodar em desenvolvimento

Requer Node.js 22 ou mais recente.

```bash
npm install
```

```bash
npm run dev
```

Depois, escolha a pasta do projeto, abra **Ajustes → Provedores** e cole uma chave de API. O COM4 já vem configurado com `https://llm.com4.com.br/v1`; basta informar a chave dele. A lista de modelos vem da API de cada provedor, então modelos novos aparecem sem atualizar o app. Ollama e LM Studio são detectados sozinhos se estiverem rodando.

Atalhos: `Ctrl+K` troca de modelo, `Ctrl+N` abre uma conversa nova, `Enter` envia e `Shift+Enter` quebra a linha.

## Enquanto o modelo trabalha

- **Modelo:** escolha um, ou deixe em **Automático** para o Claudio decidir a cada mensagem, pelo pedido, pelo tamanho do contexto, pelas imagens anexadas e pelo preço. O seletor recomenda um modelo e mostra custo, força e tempo aproximados de cada um. O tempo é medido nas suas próprias respostas.
- **Anexos:** clique no clipe, arraste ou cole um print direto na caixa de mensagem. Imagens, PDFs e arquivos de texto ficam disponíveis para qualquer modelo que continuar a conversa.
- **Força:** de Baixa a Máxima, nos modelos que aceitam esse ajuste.
- **Medidor de contexto:** mostra quanto do limite já foi usado. Ao clicar, traz tokens de entrada, saída e cache, além do custo estimado. Limites e preços vêm do [models.dev](https://models.dev) e podem variar.
- **Execução:** tempo, tokens, lista de tarefas e fila de mensagens ficam sempre à vista.

### Modos de permissão

O menu **Modo**, abaixo da mensagem, oferece:

- **Automático:** usa regras locais; aceita leituras e edições comuns, mas confirma comandos e ferramentas externas. Não usa outro modelo para avaliar ações.
- **Manual:** pergunta antes de alterar arquivos, executar comandos ou usar ferramentas externas, respeitando autorizações de “Sempre nesta conversa”.
- **Aceitar edições:** aceita edições comuns automaticamente; comandos e ferramentas externas ainda pedem confirmação.
- **Plano:** permite investigar com ferramentas de leitura e apresenta um plano. **Aprovar e executar** libera as edições daquela execução; comandos e ferramentas externas seguem as regras do Automático. Negar ou interromper não libera a execução. A próxima mensagem continua no modo Plano.
- **Ignorar permissões:** exige um aviso de ativação e dispensa confirmações comuns, inclusive de comandos e ferramentas externas. Não oferece sandbox; comandos rodam com suas permissões.

Arquivos sensíveis acessados pelas ferramentas de arquivo continuam pedindo confirmação em todos os modos. O limite da pasta dessas ferramentas também permanece. O modo fica salvo e só pode ser trocado entre execuções. Os atalhos **1–4** funcionam com o menu aberto.

Automático e Aceitar edições têm, nesta versão, as mesmas regras de autorização. Preferências antigas de Somente leitura continuam funcionando, mas esse modo não é oferecido no novo menu.

## Git

O painel à direita reúne alterações com diff, preparar, descartar, commit, branches, fetch, pull e push, sempre sem forçar nada. Submódulos e outros repositórios dentro da pasta aparecem cada um com seus próprios controles.

O botão de IA na caixa de commit lê o que está preparado, ou tudo quando nada está, e escreve a mensagem no padrão Conventional Commits, no idioma dos commits recentes. Você revisa antes de confirmar. O conteúdo de arquivos que costumam guardar segredos, como `.env`, não é enviado ao modelo.

Para listar e criar PRs, instale o [GitHub CLI](https://cli.github.com). Em uma pasta sem Git, o painel mostra só os arquivos e oferece iniciar um repositório.

## Terminal integrado

O botão **Terminal** no topo abre um painel lateral com PowerShell no Windows, já na pasta do projeto. Ele pode ficar aberto junto com a coluna de **Arquivos/Git**: a conversa, o terminal e o projeto aparecem lado a lado, com controles independentes para ocultar cada painel. Em janelas estreitas, os dois painéis flutuam lado a lado, sem cobrir um ao outro. Use **+** para abrir outras abas (até 16 sessões no app). A entrada é interativa e a saída aparece ao vivo, inclusive para servidores e comandos que continuam rodando.

Na aba **Arquivos**, os arquivos `.ps1` têm um botão **▶** à direita, inclusive nos resultados do filtro. Ele executa o script em uma nova aba PowerShell, na pasta do projeto, com saída ao vivo e entrada interativa. O terminal permanece aberto ao terminar. O botão não ignora a política de execução do PowerShell; se ela bloquear o script, o erro aparece no terminal. Nomes com espaços e aspas são passados como argumentos, sem virar um comando de shell.

Cada conversa mantém suas próprias sessões. Ocultar o painel ou trocar de conversa não encerra os processos; fechar uma aba encerra aquela sessão e seus processos. As sessões não são restauradas depois de fechar o app. Alterar o projeto de uma conversa ainda vazia ou apagá-la também encerra seus terminais.

O terminal é operado por você, separado das ferramentas do agente, e executa comandos com suas permissões, sem sandbox. Chaves de API do ambiente do app não são repassadas ao shell.

## Navegador

Em **Ajustes → Ferramentas MCP**, os atalhos de Chrome conectam um servidor de navegador que qualquer modelo com ferramentas pode usar. As ações pedem confirmação pelas regras do modo escolhido; Ignorar permissões dispensa essas perguntas. Use com cuidado: uma página pode tentar dar ordens ao modelo.

## Provedores

Prontos para usar: Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral, Groq, Together AI, OpenRouter, Ollama e LM Studio. O OpenRouter, sozinho, dá acesso a centenas de modelos de outros fornecedores.

Na integração OpenAI, o seletor fica restrito a `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` e `gpt-5.6`, somente quando retornados pela API da sua conta. O Luna aparece uma vez; a força é escolhida no controle separado. Preços e limites continuam vindo da API e do catálogo, sem valores fixos para esses modelos.

Na integração Anthropic, o seletor oferece apenas Sonnet 5.5, Haiku 5.5, Opus 5.5, Fable 5.1, Haiku 4.5 e Sonnet 4.6, quando retornados pela API. São aceitos os IDs-base (`claude-sonnet-5-5`, por exemplo) e os IDs dessas versões com sufixo de data. Força, capacidades e limites continuam seguindo os dados da API e do catálogo.

Qualquer outro serviço que fale um dos quatro protocolos (Anthropic Messages, OpenAI Responses, compatível com OpenAI ou Gemini) pode ser adicionado em **Ajustes**, sem escrever código. Provedores personalizados não recebem os filtros das integrações OpenAI e Anthropic.

## Segurança

- As chaves ficam criptografadas pelo sistema operacional e nunca chegam à interface. Uma chave vinda de variável de ambiente só é enviada ao endereço oficial do fornecedor dela.
- As ferramentas só alcançam o projeto escolhido, e links simbólicos não escapam dele. O contexto enviado aos modelos traz nomes de arquivos e o README, nunca o conteúdo do código, e remove credenciais do endereço do repositório.
- Alterar arquivos, executar comandos e usar MCP pedem confirmação, a menos que você escolha outro modo. Arquivos que costumam guardar segredos, como `.env`, sempre pedem.
- Comandos não recebem as chaves de API do ambiente do app, e a resposta de um modelo não vira HTML nem carrega imagens remotas.
- **Não há sandbox:** um comando aprovado roda com as suas permissões. Leia antes de permitir.

## Arquitetura

```
src/shared/types.ts      O formato canônico da conversa e o contrato entre os processos
src/main/providers/      Um adaptador por protocolo, traduzindo de e para o formato canônico
src/main/agent/          O ciclo do agente e as permissões em ação
src/main/tools/          Ferramentas internas e cliente MCP
src/main/project.ts      Raiz do projeto e contexto geral enviado aos modelos
src/main/git.ts          O que o painel faz com git e gh
src/main/commit-message.ts  A mensagem de commit escrita por um modelo
src/main/attachments.ts  Anexos, guardados fora do arquivo da conversa
src/main/model-facts.ts  Limites, preços e capacidades vindos do models.dev
src/main/store.ts        Chaves criptografadas e conversas em arquivos JSON
src/renderer/            A interface (React), sem acesso a Node
resources/               Ícones, gerados por scripts/make-icons.mjs
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

- Só modelos de texto: geração de imagem, áudio e vídeo ainda não entram.
- Ainda não dá para desfazer de uma vez o que um modelo alterou. Use o Git para isso.
- Conversas muito longas ainda não são compactadas.
- A saída de um comando só aparece quando ele termina.
- Imagens devolvidas por ferramentas MCP são omitidas, inclusive capturas de tela do navegador.
- MCP remoto funciona com cabeçalhos fixos. OAuth ainda não é suportado.
- Usa chaves de API, cobradas à parte das assinaturas como ChatGPT Plus ou Claude Max.
- Instalador disponível para gerar localmente apenas no Windows x64; assinatura, publicação e atualização entre versões instaladas ainda precisam de validação.
