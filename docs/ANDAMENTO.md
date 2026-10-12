# Andamento do projeto — onde paramos e como continuar

> Última atualização: 12/10/2026 · versão no ar: **0.2.0** · correção mais recente: envio (me2) e pré-checagem da conta
>
> **Objetivo imediato:** publicar o primeiro anúncio real no Mercado Livre (um Playstation 4 Slim). Faltam poucos passos, listados na seção 1.

---

## 1. Para retomar: faça isto, nesta ordem

1. **Deploy no Easypanel.** O código mais recente está na `main`, mas só entra no ar depois de clicar em **Deploy** no serviço — ou com **Auto Deploy** ligado em Source.
2. **Confira que a versão nova subiu:** abra `https://SEU-DOMINIO/m/teste`. Tem de aparecer *"Este link expirou"*. Se vier erro de rota, o deploy não pegou.
3. **No produto do PS4**, vá em Canais → Mercado Livre → **"Atributos do Mercado Livre"**:
   - **Voltagem:** *Bivolt* (o PS4 Slim aceita de 100 a 240V; confirme na etiqueta embaixo do console).
   - **Capacidade**, se aparecer: *1 TB* (ou o que for o seu).
   - Salve.
4. Marque só o Mercado Livre, deixe **"simular (dry-run)" marcado** e clique em Publicar.
   - Com a conta conectada, o dry-run não é simulação nossa: o payload vai para o **endpoint de validação do próprio ML**, que diz se o anúncio seria aceito.
5. Leia o resultado. Agora a mensagem traz **tudo o que falta de uma vez**, numerado (conta, envio, atributos) e, embaixo, um bloco **"Atenção"** com o que foi escolhido (ex.: frete grátis obrigatório acima de R$ 79):
   - **"o Mercado Livre validou este anúncio"** → desmarque a simulação e publique de verdade. Depois, **confira no site do ML que título ele montou** (veja a seção 4).
   - **"Sua conta não tem Mercado Envios"** ou erro de envio → no site do ML, *Minha conta > Configurações > Preferências de venda > Formas de entrega*, ative o Mercado Envios e repita.
   - **Atributo faltando** → a mensagem começa dizendo o que preencher, e há o botão **"Preencher atributos do ML agora"**. Preencha e repita o passo 4.
   - **Outro erro** → copie o bloco **"Resposta da plataforma"** (tem botão Copiar) e leve para a próxima sessão. Ele traz o motivo exato.

Para a sessão do Claude que continuar: o `CLAUDE.md` na raiz tem as regras de trabalho (commit direto na `main`, sem pull request) e as decisões que não podem ser desfeitas. Este arquivo tem o contexto.

---

## 2. O que existe e funciona

Sistema de cadastro único de produto que vira anúncio em várias plataformas. Fastify + SQLite (`node:sqlite`), painel em HTML/JS sem build, rodando em Docker no Easypanel.

| Área | Situação |
|---|---|
| Cadastro de produto (geral, veículo, imóvel) | funcionando |
| Redação do anúncio com Gemini | funcionando (precisa de `GEMINI_API_KEY`) |
| Login do painel (Basic Auth) | funcionando; o servidor **recusa subir** exposto sem senha |
| Tratamento de fotos (EXIF/GPS removido, 1600 px, JPEG, original guardado) | funcionando |
| Envio de fotos pelo celular (QR Code, câmera **ou** galeria) | funcionando |
| Fotos de referência do catálogo do ML (nunca como capa) | funcionando, depende do ML conectado |
| Galeria arrastável, selos de capa/ilustrativa | funcionando |
| "Melhorar foto" com IA (Gemini) | **não verificado** com chave real |
| Mercado Livre — conexão (OAuth com PKCE) | **funcionando em produção** |
| Mercado Livre — publicação | **quase**: último erro foi o modo de envio (`lost_me1_by_user`), já resolvido no código |
| OLX | não configurado (exige parceria, normalmente negada a pessoa física) |
| Catálogo Meta (Facebook/Instagram) | não configurado |
| Grupos do Facebook / WhatsApp | funcionando como kit manual (não existe API) |

Testes: **71 automatizados** (`npm test`), todos passando, mais verificação em navegador real a cada mudança de interface.

---

## 3. A saga da publicação no Mercado Livre

O ML mudou bastante a API de publicação, e cada tentativa revelou uma regra nova. Fica registrado para não repetir o caminho:

| # | Erro do ML | Causa | Correção |
|---|---|---|---|
| 1 | `code_verifier is a required parameter` | OAuth passou a exigir **PKCE** | verifier/challenge S256 no login (`e02d03d`) |
| 2 | `body ... [family_name]` | Produtos migraram para o modelo **User Products**: exige o nome do produto | `family_name` = marca + modelo (`429df35`) |
| 3 | `body.invalid_fields` (sem causa) | `description` não é aceita no corpo do item desde 2021 | descrição em chamada separada, `/items/:id/description` (`a9365ee`) |
| 4 | — | o painel escondia o detalhe do erro | bloco **"Resposta da plataforma"** com o JSON completo (`052ed8a`) |
| 5 | `The fields [title] are invalid` | no modelo de produto, `title` e `family_name` não convivem: **o ML monta o título** | produto manda só `family_name`; veículo/imóvel mandam só `title` (`a9c6e70`) |
| 6 | `The attributes [GTIN] are required` | categoria exige **código de barras** | campo EAN no cadastro, com conferência do dígito verificador (`6dda794`) |
| 7 | `The attributes [VOLTAGE] are required` | cada categoria tem **atributos próprios** | painel que pergunta ao ML o que a categoria exige e monta os campos (`7636ef0`) |
| 8 | `shipping.lost_me1_by_user` — *"User has not mode me1"* (veio como `warning`, mas foi a única causa do 400) | o anúncio ia **sem bloco `shipping`**, e o ML escolheu sozinho o me1, que a conta não tem | **pré-checagem** (`preflight.ts`) lê os modos de envio da conta e manda `shipping` explícito: `me2` com `free_methods: []`; sem me2, "a combinar" com aviso de como ativar |

O que mudou de método no caminho, e vale manter:

- **Dry-run valida no próprio ML** (`POST /items/validate`) quando a conta está conectada. É o jeito de descobrir o que falta sem criar anúncio.
- **Erro de atributo vira instrução em português**, na frente da mensagem, dizendo qual campo preencher.
- **Pré-checagem antes de cada envio** (`preflight.ts`), para não descobrir uma regra por rodada. Pergunta ao ML, de uma vez: a conta pode anunciar (`/users/me` → `status.list/sell`), que modos de envio ela tem (`/users/:id/shipping_preferences`), que tipos de anúncio pode usar na categoria (`/users/:id/available_listing_types`) e que atributos obrigatórios faltam (`/categories/:id/attributes`). Consulta que falha não bloqueia: a palavra final é do `/items/validate`.
- **`warning` do ML também pode bloquear** — o tradutor de erros (`errors.ts`) trata envio, tipo de anúncio, fotos, preço e conta, não só atributo.
- **Atributos de categoria não viram campo fixo.** O painel os busca em `/categories/:id/attributes`. Não acrescente um campo no formulário para cada atributo novo que o ML cobrar.

---

## 4. Decisões e consequências que você precisa saber

- **No ML, em produtos, o título é montado pela plataforma**, a partir do nome do produto (marca + modelo) e dos atributos. O título que você escreve vale na OLX, na Meta, nos grupos e no WhatsApp, decide a categoria no ML — e é o título de verdade em **veículos e imóveis**. Ficou combinado: começar com marca + modelo e, se o título exibido ficar ruim, testar usar o seu título como nome do produto, com o resultado real na mão.
- **Preencher marca e modelo importa muito** — é deles que sai o nome do produto no ML.
- **Código de barras vem sempre de você**, nunca da IA. Um código inventado casa o anúncio com outro produto. O motivo "sem código" (kit, artesanal, não registrado, outro) **não é aceito pelo ML para todas as marcas**.
- **Envio:** no Mercado Envios (me2), produto de **R$ 79 ou mais vai com frete grátis** — o ML obriga e cobra parte do frete do vendedor na venda; o painel avisa. Retirada no local segue a preferência da conta. Abaixo de R$ 79, sem frete grátis.
- **Sem garantia informada, vai "Sem garantia"** — exigência do ML e a verdade num usado de pessoa física.
- **A foto abre sem senha, de propósito.** `/uploads` fica fora do login porque é por ali que ML, OLX e Meta baixam as imagens.
- **A capa é sempre foto sua.** Foto de catálogo entra depois, com aviso na descrição.

---

## 5. Pendências e pontos não verificados

Não verificados contra o serviço real (este ambiente de desenvolvimento não alcança `api.mercadolibre.com` nem o Gemini com chave real):

- [ ] **Publicação real no ML** — falta o passo da seção 1.
- [ ] **Título que o ML gera** a partir do `family_name` — conferir no primeiro anúncio publicado.
- [ ] **Envio me2 contra o ML real** — formato de `/users/:id/shipping_preferences` e `available_listing_types` veio da documentação; o limite de R$ 79 do frete grátis obrigatório é o vigente conhecido, conferir na primeira publicação.
- [ ] **Dimensões do pacote** — se a categoria exigir (`SELLER_PACKAGE_*`), o painel de atributos já as mostra, porque vêm marcadas como obrigatórias.
- [ ] **Veículo e imóvel no ML** — ainda no modelo antigo (com `title`); nunca testados contra a API real.
- [ ] **"Melhorar foto" (Gemini de imagem)** — a chamada só foi testada até a validação da chave.
- [ ] **Build do Docker** com a base `node:22-bookworm-slim` — validado na prática pelo deploy no Easypanel, que está funcionando.

Ainda não configurados:

- [ ] **Meta (catálogo Facebook/Instagram)** — passo a passo em `docs/CREDENCIAIS.md`. Exige Business Manager.
- [ ] **OLX** — exige parceria; se for negada, publicar à mão.

Ideias levantadas, não feitas:

- [ ] Marca d'água nas fotos **só dos canais manuais** (grupos, WhatsApp). O ML proíbe.
- [ ] Buscar o GTIN automaticamente no catálogo do ML por marca + modelo, com confirmação antes de salvar.
- [ ] Sincronizar de volta perguntas, vendas e pausas feitas direto no ML.
- [ ] Ícone do site (`/favicon.ico` dá 404 nos logs — inofensivo).

---

## 6. Referência rápida

**Documentos do repositório**

| Arquivo | Para quê |
|---|---|
| `CLAUDE.md` | regras de trabalho e decisões que não podem ser desfeitas |
| `docs/DEPLOY-EASYPANEL.md` | servidor, Easypanel, domínio HTTPS, volume, backup |
| `docs/CREDENCIAIS.md` | Gemini, Mercado Livre, Meta, OLX, passo a passo |
| `README.md` | visão geral, fotos, API, limitações conhecidas |
| `.env.example` | todas as variáveis de ambiente, comentadas |

**Variáveis que precisam estar no Environment do Easypanel**

`HOST=0.0.0.0`, `PORT=3000`, `PUBLIC_URL=https://SEU-DOMINIO`, `DRY_RUN`, `ADMIN_USER`, `ADMIN_PASS`, `SELLER_*`, `GEMINI_API_KEY`, `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI=https://SEU-DOMINIO/oauth/mercadolivre/callback`. E o **volume montado em `/app/data`** — sem ele, cada deploy apaga produtos e fotos.

**Arquivos centrais do Mercado Livre**

| Arquivo | O que faz |
|---|---|
| `src/channels/mercadolivre/auth.ts` | OAuth com PKCE, renovação do token |
| `src/channels/mercadolivre/map.ts` | monta o payload (`family_name` × `title`, GTIN, garantia, atributos) |
| `src/channels/mercadolivre/index.ts` | validação, dry-run no `/items/validate`, publicação + descrição |
| `src/channels/mercadolivre/preflight.ts` | pré-checagem: conta, modo de envio, tipo de anúncio, atributos faltando |
| `src/channels/mercadolivre/categoryAttrs.ts` | atributos exigidos por categoria |
| `src/channels/mercadolivre/errors.ts` | traduz erro do ML em instrução |
| `src/channels/mercadolivre/catalog.ts` | fotos oficiais do catálogo |

**Como testar localmente**

```bash
npm install
npm run typecheck && npm test
npm run dev        # http://127.0.0.1:3000
```

Para testar o fluxo do ML sem a API real, `ML_API_BASE` aponta o adapter para um ML falso (foi assim que cada correção da seção 3 foi verificada).
