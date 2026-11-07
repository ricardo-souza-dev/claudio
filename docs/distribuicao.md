# Site, instaladores e atualizações

## O que existe agora

- Site estático em `site/`, sem backend, com apresentação, perguntas frequentes e downloads consultados no GitHub Releases.
- Instalador NSIS para **Windows x64**, por usuário, sem exigir Node.js instalado.
- Atualizador com `electron-updater`. O app verifica 20 segundos depois de abrir e a cada seis horas. Também existe **Ajustes → Atualizações**.
- Download e instalação dependem de cliques separados. Não instala ao fechar o app nem reinicia sozinho. A instalação é recusada enquanto qualquer agente estiver trabalhando, inclusive durante a gravação final da conversa.
- Rascunhos e releases marcadas como pré-lançamento não entram no canal atual. A prévia usa versões numéricas, como `0.1.0`, publicadas como releases normais e identificadas como versão de testes no texto.

**Preparado não significa publicado:** é necessário enviar o código ao GitHub, habilitar Pages e publicar uma release antes de oferecer download. Os workflows ainda precisam de uma primeira execução no GitHub.

## Ver o site localmente

```powershell
npm run site:dev
```

Abra o endereço mostrado pelo Vite. Para gerar os arquivos finais:

```powershell
npm run site:build
```

A saída fica em `dist/site/`. Pode ser hospedada em qualquer serviço estático. Os caminhos são relativos, então também funciona no subdiretório de um GitHub Pages de projeto.

A ilustração da página é marcada como **ilustração do fluxo**, não como captura real do aplicativo. Substitua por capturas reais quando houver material adequado à divulgação.

O site consulta a API pública do GitHub, sem token. Se não existir release, não inventa link de download. Se houver indisponibilidade ou limite de consultas da API, mantém o link para a página de lançamentos. A consulta faz o navegador entrar em contato com o GitHub; não foram adicionados analytics nem cookies pelo site.

## Publicar o site na Vercel

O `vercel.json` na raiz configura um build estático sem instalar as dependências do Electron.

1. Envie as alterações, incluindo `vercel.json`, para o GitHub.
2. Na Vercel, escolha **Add New → Project** e importe `ricardo-souza-dev/claudio`.
3. Mantenha **Root Directory** na raiz do repositório, não em `site/`.
4. O preset deve ser **Other**. O arquivo de configuração define o build `node scripts/build-site.mjs`, a saída `dist/site` e a instalação sem dependências.
5. Não configure chaves de API de modelos, tokens GitHub ou outras variáveis: o site não precisa delas.
6. Clique em **Deploy**. A Vercel fornece um endereço `*.vercel.app` com HTTPS.
7. Confira a branch de produção `main`. Novos pushes nela passam a atualizar o site automaticamente.
8. Para domínio próprio, use **Settings → Domains** e configure o DNS conforme indicado pela Vercel.

Os instaladores e o feed de atualização continuam no GitHub Releases, independentemente do domínio do site. Não é preciso habilitar GitHub Pages para usar Vercel. Se o workflow **Site** do Pages já estiver habilitado e você não quiser a segunda hospedagem, desative-o em **GitHub → Actions → Site → Disable workflow**.

A publicação na conta Vercel ainda depende da conexão com o GitHub e do primeiro deploy; criar a configuração local não publica o site.

## Publicar o site no GitHub Pages (alternativa)

1. Envie o código para `main` no repositório `ricardo-souza-dev/claudio`.
2. No GitHub, abra **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Execute o workflow **Site**, ou envie uma alteração nos arquivos do site.
4. O endereço esperado é `https://ricardo-souza-dev.github.io/claudio/`.
5. Domínio próprio é opcional: configure o domínio no Pages e os registros DNS seguindo a documentação do GitHub. HTTPS deve estar habilitado.

Nenhum domínio foi comprado ou configurado por esta implementação. Não coloque instaladores no Pages: eles ficam no Releases.

## Gerar o instalador localmente

```powershell
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run dist:win
```

Arquivos em `dist/`:

| Arquivo | Uso |
| --- | --- |
| `Claudio-Setup-0.1.0-x64.exe` | Instalador entregue à pessoa |
| `Claudio-Setup-0.1.0-x64.exe.blockmap` | Dados usados para download diferencial |
| `latest.yml` | Versão, nome do instalador e hash SHA-512 |
| `win-unpacked/` | App empacotado, útil para smoke test; não é o instalador |

O empacotador baixa Electron e ferramentas NSIS se ainda não estiverem no cache. O primeiro build precisa de internet. `dist:win` **não publica** arquivos.

## Publicar uma versão

Antes da primeira distribuição pública:

- Escolha a licença. Repositório público sem licença não equivale a código livre.
- Avalie o nome e a apresentação da marca.
- Valide edição de arquivos com APIs reais e explicite os limites da prévia.
- Defina assinatura de código e teste instalação/atualização em ambiente Windows descartável.
- Proteja a conta GitHub, os tokens e as permissões de publicação: o repositório controla o canal de atualização.

Para cada versão:

1. Atualize a versão e o lockfile juntos, por exemplo: `npm version 0.1.1 --no-git-tag-version`.
2. Revise as mudanças, execute as validações e faça o commit.
3. Crie uma tag que corresponda exatamente à versão: `git tag v0.1.1`.
4. Envie o commit e a tag ao GitHub, quando estiver pronto para publicar.
5. O workflow **Instalador Windows** valida tipos, testes e Electron, gera o instalador e envia os arquivos para uma release em **rascunho**.
6. Revise a release no GitHub: confirme `.exe`, `.blockmap` e `latest.yml`, escreva as notas e teste os arquivos numa máquina de testes.
7. Publique a release como versão normal, sem marcar **pre-release**. Só então o site e o app instalado passam a oferecê-la.

O pipeline usa o token temporário do Actions com permissão de escrita em releases. Não coloque token no código, no site nem no aplicativo. A configuração pública de download não requer token, pois o repositório é público.

Não substitua arquivos de uma versão já publicada: publique uma nova versão. Uma versão ruim deve ser corrigida com número maior; não foi implementado downgrade automático.

## Assinatura de código

O build local atual é **sem assinatura**. O Windows pode mostrar alertas, e SmartScreen também considera a reputação do certificado/arquivo; assinatura não garante ausência de alertas.

O workflow já aceita os segredos `WINDOWS_CSC_LINK` e `WINDOWS_CSC_KEY_PASSWORD`, consumidos pelo electron-builder. Eles são aplicáveis a certificados que possam ser usados por esse mecanismo. Certificados em token/hardware e serviços de assinatura remota podem exigir outro passo de assinatura. Configure conforme o serviço escolhido, sem expor a chave privada.

Antes de distribuir builds assinados:

- Configure o certificado/serviço real e a identidade do editor.
- Confira o `publisherName` gerado em `resources/app-update.yml` do app empacotado e a assinatura do `.exe`.
- Considere tornar a assinatura obrigatória no pipeline com `forceCodeSigning: true` depois de provisionar as credenciais.
- Mantenha a identidade do editor compatível entre releases e planeje a renovação do certificado.

O updater verifica o hash do arquivo descrito no feed e usa HTTPS. **Isso não substitui assinatura:** na configuração sem certificado não há verificação de identidade Authenticode do editor. Não trate o build sem assinatura como distribuição final endurecida.

## O que acontece com os dados

Os dados ficam no diretório `app.getPath('userData')`, separado do programa. No Windows instalado, normalmente `%APPDATA%\Claudio`:

- conversas em JSON;
- anexos;
- preferências e chaves protegidas pelo armazenamento seguro do sistema.

A configuração mantém os dados ao desinstalar (`deleteAppDataOnUninstall: false`). Atualizar o programa não deve removê-los. A pasta de projeto também fica fora da instalação.

Não mude `appId`, `productName` ou a localização de `userData` sem planejar uma migração. Chaves criptografadas não são necessariamente portáveis para outra conta ou computador. Antes de alterar o formato dos dados, implemente uma migração compatível e um backup; esta mudança não introduziu um mecanismo genérico de migração nem de restauração.

## Validar uma atualização real

Ainda é necessário provar uma atualização **instalada → instalada**. Testes automatizados de política e interface não substituem isso:

1. Em VM ou conta Windows descartável, instale a versão A usando o instalador.
2. Crie uma conversa, salve uma preferência e conecte um provedor de testes.
3. Publique uma versão B, com número maior, num canal/repositório de testes separado. Não publique uma versão fictícia no canal das pessoas.
4. Verifique que A detecta B, só baixa após consentimento e não instala ao simplesmente fechar.
5. Durante um agente em execução, confirme a recusa de instalação.
6. Termine o trabalho, escolha **Reiniciar e atualizar** e confira a versão B, os dados e as chaves.
7. Teste interrupção de download, rede indisponível, arquivo inválido e, com assinatura configurada, editor incorreto.

Para testar um feed local, mantenha a substituição restrita a uma build de testes; não foi adicionado override de feed por variável de ambiente no app distribuído.

## O que foi validado nesta implementação

- Checagem TypeScript e testes unitários/integração.
- Electron real com servidor de modelos simulado.
- Site em Chromium do Electron, com resposta de release simulada, layout desktop/mobile e ausência de primeira release.
- Geração local do instalador Windows x64 e dos metadados.
- Abertura de `dist/win-unpacked/Claudio.exe`, leitura de versão e disponibilidade do atualizador empacotado, com dados isolados.

**Não validado:** execução dos workflows no GitHub, publicação efetiva no Pages/Releases, certificado real, instalação via assistente NSIS e atualização instalada entre duas versões. macOS/Linux continuam fora do primeiro lançamento.

As dependências de produção não apresentaram vulnerabilidades no `npm audit --omit=dev` nesta implementação. O audit completo apontou seis ocorrências moderadas na cadeia de desenvolvimento do empacotador; avalie os avisos e as correções compatíveis antes de liberar o pipeline, sem aplicar downgrade automático ou `npm audit fix --force` às cegas.
