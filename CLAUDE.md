# Claudio

App desktop em Electron para desenvolvedores que reúne vários provedores de IA em torno do conceito de **unicidade**: uma só conversa, memória e caixa de ferramentas, com qualquer modelo assumindo no meio do trabalho, sempre dentro de uma pasta de projeto.

**Meta do produto:** ser a ferramenta preferida dos desenvolvedores. Na hora de priorizar, pese o que faz um dev confiar e adotar: instalação, poder desfazer, sessões longas e custo visível.

**Situação em 2026-11-22:** versão 1.0.18, tudo publicado na branch `main` (último commit em 2026-11-09). O agente foi testado de ponta a ponta contra um servidor simulado. **Com APIs reais, há confirmação de pouco:** listar modelos da Anthropic e da OpenAI, e modelos da OpenAI lendo o projeto e rodando comandos. **Nenhum modelo real editou um arquivo ainda.** Desde 2026-11-07 entraram instalador e atualizador para Windows, site, terminais interativos, perfis do modelo automático e avisos de contexto.

## Comandos

```bash
npm install          # também baixa o binário do Electron (postinstall)
npm run dev          # interface com recarga automática; o app reinicia se o processo principal mudar
npm run build        # compila para out/
npm start            # roda a versão compilada
npm run typecheck
npm test             # testes de unidade e integração (Vitest)
npm run test:e2e     # compila e dirige o Electron real (Playwright)
npm run icons        # regenera resources/icon.png e icon.ico
npm run dist:win     # instalador NSIS para Windows x64, em dist/
npm run site:dev     # site estático em site/ (site:build gera dist/site/)
```

O e2e em Linux precisa de display: `xvfb-run -a npm run test:e2e -- --trace off`. Detalhes de release, site e atualizações estão em `docs/distribuicao.md`.

Variáveis de ambiente usadas para isolar e testar:

- `CLAUDIO_DATA_DIR=<pasta>` isola os dados do app, inclusive conversas e chaves.
- `CLAUDIO_MODEL_FACTS_URL=<url>` troca a origem do catálogo de modelos.
- `CLAUDIO_GH_COMMAND='["node","script"]'` troca o comando do GitHub CLI.
- `E2E_SHOTS=<pasta>` faz o `test:e2e` salvar capturas de tela.

Nenhum teste chama API real nem gera custo.

## Organização do código

| Caminho | O que tem |
|---|---|
| `src/shared/types.ts` | Formato canônico da conversa e contrato entre os processos (`UniApi`, `UniEvent`) |
| `src/shared/usage.ts` | Soma de tokens, contexto em uso e custo estimado (`messageCost`, `formatUsd`) |
| `src/shared/spending.ts` | Lançamentos de gasto, relatório, limites e mensagens de orçamento |
| `src/shared/auto-model.ts` | Escolha automática de modelo e estimativas de custo e tempo |
| `src/main/index.ts` | Janela, segurança do Electron e canais IPC |
| `src/main/store.ts` | Chaves criptografadas, preferências e conversas em JSON |
| `src/main/models.ts` | Lista de modelos de todos os provedores conectados |
| `src/main/model-facts.ts` | Limites, preços e capacidades vindos do models.dev |
| `src/main/project.ts` | Raiz do projeto e contexto geral enviado aos modelos |
| `src/main/git.ts` | Tudo que o painel faz com `git` e `gh`, inclusive achar submódulos e outros repositórios |
| `src/main/commit-message.ts` | Mensagem de commit escrita por um modelo |
| `src/main/budget.ts` | Guarda de orçamento de uma execução (`createBudgetGuard`) |
| `src/main/checkpoints.ts` | Pontos de restauração dos arquivos que o agente grava (`CheckpointStore`) |
| `src/main/terminals.ts` | Terminais interativos (node-pty) operados só pela pessoa |
| `src/main/updates.ts` | Política de atualização (`electron-updater`), testável sem o GitHub |
| `src/main/attachments.ts` | Anexos guardados fora do arquivo da conversa |
| `src/main/providers/catalog.ts` | Provedores prontos e escolha do adaptador |
| `src/main/providers/history.ts` | Regras de contexto: chamadas sem resposta, histórico em texto e ids |
| `src/main/providers/anthropic.ts` | Protocolo Anthropic Messages |
| `src/main/providers/openai-responses.ts` | Protocolo OpenAI Responses |
| `src/main/providers/openai-chat.ts` | Servidores compatíveis com OpenAI |
| `src/main/providers/gemini.ts` | Protocolo Google Gemini |
| `src/main/agent/runner.ts` | Ciclo do agente e permissões em ação |
| `src/main/agent/context.ts` | Prompt de sistema e arquivos de instrução do projeto |
| `src/main/tools/builtin.ts` | Ferramentas de arquivo, busca, comando e lista de tarefas |
| `src/main/tools/mcp.ts` | Cliente MCP |
| `src/main/tools/types.ts` | Interface das ferramentas e regra de permissão |
| `src/preload/index.ts` | Ponte estreita entre a interface e o processo principal |
| `src/renderer/src/App.tsx` | Estrutura da tela, projetos, fila e modelo automático |
| `src/renderer/src/Composer.tsx` | Caixa de mensagem, anexos, modelo, força e permissões |
| `src/renderer/src/ModelPicker.tsx` | Seletor de modelos, com recomendação e estimativas |
| `src/renderer/src/LivePanel.tsx` | Tarefas, status e fila durante a execução |
| `src/renderer/src/ContextMeter.tsx` | Medidor de contexto, tokens e custo |
| `src/renderer/src/ProjectPanel.tsx` | Painel direito: Git, PRs, arquivos e visualizador |
| `src/renderer/src/ProfilePicker.tsx`, `EffortPicker.tsx` | Perfil (econômico, equilibrado, desempenho) e força do modelo |
| `src/renderer/src/TerminalPanel.tsx` | Painel de terminais, ao lado do painel do projeto |
| `src/renderer/src/Settings.tsx`, `Updates.tsx` | Ajustes, MCP e atualizações |
| `src/renderer/src/Spending.tsx` | Orçamentos e painel de gasto, na aba Custos |
| `src/renderer/src/Changes.tsx` | Cartão "Alterou N arquivos", com revisar e desfazer |
| `resources/` | Ícones, gerados por `scripts/make-icons.mjs` |
| `site/`, `scripts/build-site.mjs`, `vercel.json` | Site estático, com downloads lidos do GitHub Releases |
| `.github/workflows/` | `release.yml` (instalador Windows por tag `v*`) e `site.yml` (Pages) |
| `scripts/upload-release.ps1`, `build-project-win.ps1` | Rascunho único de release, com assets conferidos por tamanho e SHA-256 |
| `docs/distribuicao.md` | Site, instaladores, atualizações e como publicar |
| `tests/fixtures/mock-llm.ts` | Servidor local que simula os quatro protocolos e o catálogo de modelos |
| `tests/fixtures/mcp-server.mjs` | Servidor MCP real usado nos testes |
| `tests/fixtures/fake-gh.mjs` | Substituto do GitHub CLI usado nos testes |

## Regras de que o código depende

Estas decisões não são óbvias lendo o código, e quebrá-las causa falhas só com APIs reais.

### Projeto

- **Toda conversa tem uma pasta de projeto, e o Git é opcional.** O processo principal recusa enviar mensagem sem projeto. Conversas antigas sem pasta continuam legíveis, mas não podem seguir.
- **Uma subpasta de repositório abre a raiz dele,** porque o contexto é o projeto inteiro.
- **O modelo começa sabendo do projeto:** pasta, branch, endereço do repositório sem credenciais, nomes de arquivos de dois níveis e README (`describeProject`). O conteúdo do código só chega pelas ferramentas.

### Histórico e troca de modelo

- **O histórico só cresce.** Nunca edite, reordene ou remova mensagens antigas. O raciocínio assinado da Anthropic é invalidado se algo anterior mudar, e o cache de prompt se perde.
- **Toda mensagem tem duas formas.** As partes canônicas servem a qualquer modelo. O campo `raw` guarda o formato original e é reenviado sem alteração quando o mesmo provedor continua. A Anthropic aceita `raw` entre modelos dela; OpenAI e Gemini, só para o mesmo modelo.
- **O prompt de sistema é escrito uma vez por conversa** e fica em `thread.system`. Não coloque nele nome de modelo nem dados que mudam a cada pedido. Por isso a pasta só muda antes da primeira mensagem, e a memória editada só vale para conversas novas.
- **Toda chamada de ferramenta precisa de resposta**, senão os provedores rejeitam o histórico. O agente grava o resultado ao cancelar, e `contextOf` cobre o caso de o app fechar no meio.
- **Turnos recusados ficam marcados com `excluded`:** aparecem na tela, mas nunca voltam para modelo nenhum.
- **Sem ferramentas, o histórico vira texto** (`flattenHistory`), e `raw` não é enviado. Isso vale para modelos que rejeitam ferramentas. O que a pessoa escreveu e anexou continua como está.

### Provedores

- **A lista vem da API de cada provedor.** Exceção de curadoria: a integração `openai` só oferece os IDs `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol` e `gpt-5.6` que a API retornar (`OPENAI_SELECTION`). O Luna aparece uma vez e usa o controle separado de força. A integração `anthropic` só oferece Sonnet 5.5, Haiku 5.5, Opus 5.5, Fable 5.1, Haiku 4.5 e Sonnet 4.6: IDs-base e sufixos de data com oito dígitos (`SELECTABLE_MODELS`). Os filtros não afetam provedores personalizados e não impedem a resolução de referências antigas de conversas. O que a API não informa vem do models.dev, com a API sempre tendo prioridade. Sem o catálogo (offline, por exemplo), tudo continua funcionando, só sem limites, preços e escolha automática.
- **Use os SDKs oficiais** dos três fornecedores. Os construtores fixam `authToken`, `organization` e `vertexai` para que variáveis de ambiente não mudem a conexão nem vazem dados para outro endereço.
- **Anthropic:** usa `client.beta.messages.stream`, raciocínio adaptativo com `display: "summarized"`, `prefix_mismatch_behavior: "drop_block"` e esforço padrão `high`. O fallback de recusa (`fallbacks: "default"`) só é ligado no endpoint oficial, nos modelos listados em `MODELS_WITH_SERVER_FALLBACK`.
- **OpenAI oficial:** usa Responses com `store: false`, reenviando os itens de raciocínio criptografados.
- **Gemini:** aceita só um subconjunto de JSON Schema (`toGeminiSchema`). Chamadas vindas de outro modelo levam a assinatura `context_engineering_is_the_way_to_go`, documentada pelo Google.
- **Força do modelo:** um único ajuste vira `output_config.effort`, `reasoning.effort`, `reasoning_effort` ou `thinkingConfig`, conforme o protocolo. `clampEffort` usa o nível mais próximo aceito. Se o provedor rejeitar, o turno segue sem o ajuste, com aviso, porque o catálogo pode errar.
- **Ids e nomes de ferramenta:** `safeToolId` é determinístico, para o mesmo histórico gerar sempre os mesmos bytes, e a Mistral exige 9 caracteres. `mcpToolName` respeita o limite de 64 caracteres. Na tela, resultados são associados pela posição, porque há servidores que podem repetir ids.
- **Ao interromper,** o SDK da OpenAI encerra a iteração sem lançar erro, então o adaptador de chat confere `signal.aborted` depois do laço.

### Modelo automático

`chooseAutoModel` pesa o pedido (`weighTask`) pelo texto, pelo tamanho do contexto e pelas ferramentas usadas há pouco, e escolhe por preço entre modelos recentes com ferramentas: o mais barato, o do meio ou o mais forte até US$ 30 por milhão de tokens de saída. `unfitReason` descarta quem não comporta o contexto ou não lê as imagens anexadas. **Nunca desce de modelo dentro da conversa,** porque trocar perde o cache de prompt. Em uma conversa sem resposta ainda, não há o que perder, então essa regra não vale. O motivo da escolha aparece na conversa.

**Perfis:** `economy`, `balanced` e `performance` (`AutoModelOptions.profile`; `economyMode` antigo vira `economy`). Economia escolhe uma faixa mais barata e pode descer de modelo em trabalho leve ou normal quando o ativo custa mais que o dobro. Desempenho usa o mais forte dentro do teto. **Só no automático com perfil econômico** o pedido leva a instrução de resposta compacta (`COMPACT_RESPONSE_CONTEXT`) e a saída de comandos é reduzida. A força do modelo é independente do perfil.

O seletor usa a mesma regra para recomendar, desabilita modelos que não cabem (com a razão e quantos tokens faltam, via `contextShortfall`) e avisa antes de o contexto chegar ao limite. `estimateTurn` calcula custo e tempo aproximados. A velocidade vem das respostas reais de cada modelo (`recordSpeed`). A classificação é por palavras-chave e tamanho, então é simples de propósito.

### Anexos

- Os bytes ficam em `attachments/<sha256>`, fora do JSON da conversa, que é regravado a cada etapa. A conversa guarda só a referência.
- `AttachmentStore.load` preenche os bytes a cada pedido. Por serem nomeados pelo conteúdo, o reenvio é sempre idêntico.
- O que um modelo não consegue ler vira uma nota em texto, sem erro, e o arquivo continua disponível para o próximo modelo.
- Limites: imagem 5 MB, PDF 20 MB, texto 1 MB e 10 arquivos por mensagem. Binários são recusados.

### Segurança

- As chaves nunca chegam à interface. Variável de ambiente só é usada no endereço oficial do fornecedor dela.
- Ferramentas ficam presas à pasta de trabalho (`resolveInside`), inclusive contra links simbólicos.
- Comandos não recebem variáveis `*_API_KEY`, `*_AUTH_TOKEN` e `*_SECRET` do ambiente.
- Arquivos que costumam guardar segredos sempre pedem confirmação. Nem o modo do agente nem um "sempre permitir" anterior dispensam a pergunta.
- Argumentos de ferramenta são validados com Ajv antes de rodar. Chamadas de uma resposta cortada ou recusada nunca rodam.
- O cartão de aprovação não recebe foco: um Enter destinado à caixa de mensagem não pode aprovar uma ação.
- A CSP entra só no build de produção e bloqueia imagens remotas, para que o texto de um modelo não consiga enviar dados para fora. HTML escrito por um modelo nunca é renderizado.
- Remova credenciais de endereços de repositório antes de enviá-los a um modelo (`withoutCredentials`).

### Git

- O painel executa o que a pessoa clica, e os modelos não têm acesso a ele. Modelos só chegam ao Git por `run_command`, que pede confirmação.
- Argumentos nunca passam por um shell. Nomes de branch são validados com `git check-ref-format`, e caminhos vêm depois de `--`.
- **Nada é forçado:** push sem `--force`, e pull só com `--ff-only`. Descartar alterações pede um segundo clique.
- O status vem de `git status --porcelain=v2 -z`, que trata caminhos com espaços (`parseStatus`).
- `GIT_TERMINAL_PROMPT=0` evita travar esperando credenciais em um terminal que não existe.
- PRs usam o GitHub CLI. Sem ele instalado, o painel explica como instalar, e o resto funciona normalmente.
- Submódulos e repositórios dentro da pasta aparecem separados, cada um com seus controles (`discoverRepositories`). Um submódulo não baixado aparece na lista de arquivos, mas é uma pasta vazia.
- **A mensagem de commit só vai ao modelo quando a pessoa clica.** Ele recebe o que está preparado, ou tudo quando nada está, sem ferramentas e com o diff tratado como dado (`changesForMessage`). Arquivos que costumam guardar segredos são citados pelo nome, e o conteúdo fica de fora.

### Orçamento e gasto

- **O gasto vem das conversas salvas, não de um registro à parte.** `spendEntries` soma cada resposta com `usage` pelo preço **atual** do catálogo (`messageCost`). Por isso apagar uma conversa tira o gasto dela dos valores e dos limites, e uma mudança de preço no models.dev reescreve o passado. É uma estimativa, e a tela diz isso.
- **Modelo sem preço custa zero e é contado à parte** (`unpricedThisMonth`). Um limite não protege o que o Claudio não consegue precificar.
- **Dois limites, em dólares, 0 = sem limite:** por conversa (`conversationBudgetUsd`) e mensal por pasta de projeto (`projectBudgetsUsd`, chave é o caminho em `thread.workspace`). O mês é o calendário local. O processo principal valida os valores em `setPrefs`, porque vêm da página.
- **Quem aplica é o processo principal,** no início de cada passo do `Runner`, antes de chamar o modelo. A guarda soma as outras conversas do projeto uma vez por execução e a conversa em curso a cada passo, então uma execução longa não relê o disco. Sem limite configurado, a guarda é `null` e nada é lido.
- **Parar não corrompe o histórico:** a checagem fica depois de todo resultado de ferramenta já gravado e antes da próxima chamada, então qualquer modelo retoma dali. A mensagem da pessoa fica salva, e "Tentar de novo" continua sem redigitar. Pode haver estouro de um passo, porque o custo só é conhecido depois da resposta.
- **A parada é um erro** (`lastRun: 'error'`), então a fila de mensagens espera por "Enviar agora". Aos 75% sai um aviso uma vez por execução e por tipo de limite.

### Desfazer alterações

- **Cobre só `write_file` e `edit_file`.** O `Runner` envolve essas duas ferramentas em `CheckpointStore.track`: lê os bytes antes, deixa a ferramenta rodar, lê depois e, se mudou, guarda o conteúdo anterior em `checkpoints/blobs/<sha256>`. O que `run_command` ou uma ferramenta MCP altera **não é desfeito**; `noteCommand` só conta os comandos, para o cartão avisar. Não depende de Git.
- **Um ponto de restauração por mensagem da pessoa** (`id` = id dessa mensagem, a última de `user` quando a execução começa). Uma nova tentativa sem mensagem nova cai no mesmo ponto. A execução liga-se a ele por `thread.runs[].checkpointId`, e o cartão aparece depois da última execução que o usa. Vários arquivos, ou o mesmo arquivo várias vezes, ficam no mesmo ponto, que mantém sempre o **primeiro** original.
- **Nunca sobrescreve o que a pessoa escreveu depois.** O registro guarda o hash do arquivo como o agente o deixou (`after`). Se o arquivo atual não é nem esse nem o original, o estado é `changed`: fica desmarcado e só volta com `force`, que a interface envia quando a pessoa marca o arquivo de propósito. Arquivo apagado pela pessoa conta como `changed`.
- **O processo principal decide, não a página.** `restore` só mexe em arquivos registrados naquele ponto, resolve cada caminho com `resolveInside` (links simbólicos não saem da pasta) e recusa durante uma execução.
- **Sem cópia, sem edição.** Um arquivo acima de 20 MB não é alterado pelo agente, porque ficaria sem desfazer. Se a cópia não puder ser gravada, a ferramenta nem roda.
- **O histórico não é reescrito.** Depois de desfazer, `noteRestored` põe um aviso em `thread.revertNotes`, que entra como parte `appContext: 'undo'` na **próxima** mensagem da pessoa (uma nova tentativa sem mensagem o mantém). Assim nenhum modelo continua achando que suas edições estão lá, e as mensagens antigas ficam idênticas byte a byte.
- **Armazenamento:** `checkpoints/<id da conversa>.json` mais os blobs, que são guardados uma vez por conteúdo. As cópias ficam sem criptografia na pasta de dados, como as próprias conversas. Apagar a conversa apaga o índice e os blobs que nenhuma outra conversa usa (`forget`).

### Terminais e atualizações

- **Terminais são só da pessoa:** `TerminalService` não é ferramenta do agente. O ambiente do shell perde `*_API_KEY`, `*_AUTH_TOKEN`, `*_SECRET`, `ELECTRON_*` e `CLAUDIO_*`. O diretório inicial passa por `resolveInside`, o limite é de 16 sessões e elas acompanham a conversa: fecham quando o projeto muda.
- **Atualização é por clique:** `autoDownload` e `autoInstallOnAppQuit` ficam desligados, pré-lançamentos e rascunhos não entram no canal, e a instalação é recusada enquanto qualquer agente trabalha, inclusive durante a gravação final da conversa.
- **Release:** a tag precisa ser `v` + a versão estável do `package.json`. O upload cria ou reaproveita um único rascunho e nunca sobrescreve assets.

### Execução na tela

- `update_plan` é a lista de tarefas que o modelo mantém. Ela aparece fixa acima da caixa de mensagem, não como ferramenta na conversa, e não volta para os modelos.
- Tokens exatos só chegam quando cada etapa termina. Durante a etapa, o contador é uma estimativa de 4 caracteres por token.
- Mensagens na fila saem sozinhas quando a execução termina bem. Depois de erro ou interrupção, esperam por "Enviar agora".
- Abaixo de 1100 px, o painel do projeto só abre quando pedido. Até 980 px ele flutua sobre a conversa, cobre o botão que o abriu e por isso tem o próprio botão de fechar.

## Convenções

- Textos da interface e documentação em português do Brasil. Código e comentários em inglês.
- Instruções enviadas aos modelos ficam em inglês, em `src/main/agent/context.ts`, e pedem resposta no idioma do usuário.
- Mudança de comportamento leva teste. Fluxo visível na tela leva teste em `tests/e2e/app.spec.ts`.
- Antes de considerar pronto: `npm run typecheck`, `npm test` e `npm run test:e2e`.

## O que já foi feito

**Modelos**
- 12 provedores prontos: Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral, Groq, Together AI, OpenRouter, COM4, Ollama e LM Studio
- Provedores personalizados em qualquer um dos quatro protocolos, sem escrever código
- Troca de modelo no meio da conversa, com histórico, instruções e ferramentas preservados
- Modelo automático ou manual, e força do modelo de Baixa a Máxima
- Seletor que recomenda um modelo e mostra custo, força e tempo aproximados, com velocidade medida
- Perfis econômico, equilibrado e desempenho no modelo automático, e avisos antes de o contexto acabar
- Desfazer o que o agente gravou: cartão por resposta, revisão arquivo a arquivo, proteção do que a pessoa escreveu depois e aviso ao próximo modelo
- Orçamento por conversa e mensal por projeto, com aviso aos 75% e parada no limite, e painel de gasto (hoje, 7 dias, mês, total, por dia, projeto e modelo) em Ajustes → Custos
- Modelos sem suporte a ferramentas continuam só com texto, com aviso

**Agente e ferramentas**
- `read_file`, `list_dir`, `search`, `write_file`, `edit_file`, `run_command` e `update_plan`
- Modos Perguntar, Editar sem perguntar e Somente leitura, mais "sempre nesta conversa"
- Prévia do comando ou da alteração antes de aprovar
- Interrupção que preserva o que já foi escrito e mata a árvore de processos
- Cliente MCP por stdio e HTTP, com configuração colada no formato `mcpServers`
- Atalhos de MCP para Chrome, Claude Code e Codex

**Execução**
- Medidor de contexto com limite máximo, tokens de entrada, saída e cache, e custo estimado
- Tempo, tokens e atividade atual enquanto o modelo trabalha
- Lista de tarefas e fila de mensagens
- Anexos por clipe, arrastar ou colar um print, disponíveis para qualquer modelo seguinte

**Projeto e Git**
- Toda conversa em uma pasta, com contexto geral enviado a todos os modelos
- Conversas agrupadas por projeto, com projetos recentes
- Alterações, diff, preparar, descartar e commit
- Mensagem de commit escrita por um modelo, em Conventional Commits
- Submódulos e outros repositórios dentro da pasta
- Branches, fetch, pull e push
- Lista de PRs, criação e troca para a branch do PR
- Árvore de arquivos com filtro e visualizador
- Iniciar Git em uma pasta sem repositório
- Terminais interativos com saída ao vivo, várias abas, ao lado do painel do projeto

**Distribuição**
- Instalador NSIS para Windows x64, por usuário, e atualizador com verificação 20 s após abrir e a cada 6 h
- Workflows de release (por tag) e de site, rascunho único de release com assets verificados por SHA-256
- Site estático com downloads lidos do GitHub Releases (Vercel ou Pages)

**Interface**
- Renomear conversas na barra lateral
- Conversas persistentes, com gravação atômica, e tema claro e escuro conforme o sistema, em cinzas neutros com destaque azul
- Ícone próprio em todos os tamanhos
- Linha contínua que marca onde cada modelo assumiu
- Erros com "Tentar de novo" e "Trocar de modelo"
- Chaves e segredos do MCP criptografados com `safeStorage`

## O que foi verificado e o que não foi

**Verificado no Windows (até 2026-11-07):** 144 testes de unidade e integração e 14 de ponta a ponta no Electron real, passando pelos SDKs oficiais contra o servidor simulado, com `git` real em repositórios temporários. Também foram confirmados `npm ci` em pasta vazia e `npm run dev`.

**Verificado em Linux (container de nuvem, 2026-11-22):** na versão 1.0.18, `npm run typecheck` sem erros; `npm test` com 193 aprovados e 22 pulados (os do script de release e do upload, que exigem Windows PowerShell); `npm run test:e2e` com `xvfb-run` com 27 aprovados, 1 pulado (scripts PowerShell) e 1 falho, o de MCP (veja abaixo). Com o orçamento e o painel de gasto, a mesma bateria deu `typecheck` sem erros, 214 aprovados e 22 pulados nos testes de unidade, e 29 aprovados e 1 pulado no e2e, com o teste de MCP passando. Com o desfazer, mais 21 testes de unidade em `tests/checkpoints.test.ts`, 5 no `Runner` e 1 e2e, e a bateria ficou em 240 aprovados e 22 pulados nos testes de unidade, e 30 aprovados e 1 pulado no e2e. Os testes e2e do Linux provam a interface no Electron real, não o uso do app por uma pessoa.

**Com APIs reais, feito pelo usuário:** listagem de modelos da Anthropic (13) e da OpenAI (50). O gpt-4o e o gpt-6.1-sol, pelo protocolo Responses, chamaram `list_dir`, `read_file`, `search`, `run_command` e `update_plan` (64 chamadas, todas com resultado gravado), contadas nas conversas salvas.

**Ainda não verificado:**
- **Um modelo real editando arquivos:** nenhum chamou `write_file` nem `edit_file` ainda. Este é o maior risco do projeto.
- **Ferramentas fora da OpenAI e troca de modelo com ferramentas no meio:** Anthropic e Gemini com ferramentas nunca rodaram contra a API real.
- **Anexos em APIs reais:** o envio foi provado até o pedido ao servidor simulado. A resposta real de um modelo a uma imagem ou PDF ainda falta.
- **Mensagem de commit com um modelo real.**
- **Força do modelo nas APIs reais:** em especial os níveis do Gemini.
- **Atalhos de Chrome:** o teste foi bloqueado porque baixaria pacotes externos via `npx`. Nomes e opções vêm de pesquisa, e a opção `--autoConnect` do Chrome DevTools só tem fontes de terceiros.
- **Atalhos de Claude Code e Codex** (`claude mcp serve` e `codex mcp-server`): vieram de fontes da comunidade, e os dois CLIs não estavam instalados aqui.
- **GitHub CLI real:** os PRs foram testados com um substituto, porque o `gh` não está instalado aqui.
- **Fetch, pull e push em um remoto de verdade:** os testes usam um repositório local como remoto.
- **MCP por HTTP e SSE:** só o transporte stdio foi exercitado contra um servidor real.
- **Fallback de recusa:** só o formato do pedido foi testado, não a resposta real da API.
- **macOS:** o app nunca rodou nele. **Linux:** só os testes automáticos rodaram; não há instalador nem uso manual.
- **Primeira execução dos workflows no GitHub** (release e site), instalador e atualizador entre versões instaladas, e a assinatura do app.
- **Terminais no macOS e Linux:** o painel foi pensado para PowerShell, e o `node-pty` só foi exercitado pelos testes.

**Falha intermitente em aberto (MCP):** em `MCP: a real server becomes available to any model, with approval`, a suíte completa no Linux falhou uma vez em `getByText('2 ferramentas')` no passo em que o app é reaberto e o servidor MCP salvo precisa reconectar (`tests/e2e/app.spec.ts:804`). Sozinho, o teste passou 3 de 3. A causa não foi investigada: pode ser corrida na reconexão sob carga ou o tempo de 20 s. Se aparecer em uso real, o sintoma seria o servidor não voltar depois de reabrir o app.

**Falha intermitente em aberto (Ctrl+K):** em `one thread through four providers`, o `Ctrl+K` não abriu a busca de modelos uma vez na suíte completa. A causa não foi identificada. O erro não voltou em 40 repetições, e agora o teste registra o estado da tela se falhar.

## O que falta

Em ordem de prioridade:

1. **Testar a edição com um modelo real,** em uma pasta descartável com Git, e depois com Anthropic e Gemini. Vem primeiro porque pode invalidar partes do que já existe.
2. **Desfazer, o que falta.** Os arquivos gravados por `write_file` e `edit_file` já voltam, com ou sem Git. Falta cobrir o que `run_command` e as ferramentas MCP mudam (hoje o cartão só avisa), mostrar o diff antes de desfazer, refazer, e testar com um modelo real.
3. **Conversas longas.** Hoje não há compactação, então uma conversa extensa acaba em erro ao atingir o limite de contexto do modelo.
4. **Saída de comandos ao vivo.** Os terminais da pessoa já mostram a saída ao vivo, mas o `run_command` do agente só devolve o resultado quando o comando termina.
5. **Chrome de primeira classe.** Validar os atalhos, repassar imagens de ferramentas MCP aos modelos, que hoje são omitidas, e avaliar uma extensão própria, com permissão por site e capturas de tela na conversa.
6. **Sandbox para comandos.** Hoje um comando aprovado roda com as permissões do usuário.
7. **Distribuição, o que falta.** O instalador e o atualizador do Windows existem, mas os workflows nunca rodaram no GitHub e ainda não há release publicada. Falta assinar o app e validar macOS e Linux.
8. **Uso pelo terminal.** Uma versão em linha de comando sobre o mesmo núcleo, porque é onde boa parte dos devs trabalha.
9. **Git mais completo.** Revisar e aprovar PRs, resolver conflitos e editar arquivos direto no painel.
10. **OAuth para MCP remoto.** Hoje só há cabeçalhos fixos, e muitos servidores remotos exigem OAuth.
11. **Outros tipos de modelo.** Geração de imagem, áudio e vídeo. Faz parte do pedido original de reunir todos os tipos de modelo.
12. **Mais conexões nativas.** Amazon Bedrock, Vertex AI e Azure, que hoje dependem de um gateway compatível, além de suporte ao proxy do sistema.

**Ajustes menores:**
- O Electron avisa que `safeStorage.encryptString` e `decryptString` serão removidos. É preciso migrar para as versões assíncronas.
- A lista de modelos só aparece quando todos os provedores respondem, então um provedor lento atrasa os outros.
- O resumo de raciocínio da OpenAI não é pedido nem exibido.
- A classificação do modelo automático é simples e precisa ser avaliada com uso real.
- `window.uni`, `UniApi` e `UniEvent` são nomes internos que vieram do nome antigo do projeto.

## Decisões em aberto

- **Licença:** o repositório é público e não tem licença, então ninguém pode usar o código legalmente. Precisa ser escolhida antes de divulgar.
- **Nome:** "Claudio" é muito parecido com "Claude", marca da Anthropic, e o produto é neutro entre fornecedores. Vale consultar um especialista em marcas antes de divulgar. O `README.md` já diz que o projeto é independente.
