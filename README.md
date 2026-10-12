# Anúncios Multiplataforma

Cadastro único de produto que vira anúncio em várias plataformas de venda: você preenche uma vez, o sistema adapta título, descrição, atributos e fotos ao formato de cada canal e publica (ou entrega o conteúdo pronto, nos canais que não têm API).

Suporta três tipos de anúncio com campos próprios: **itens usados**, **veículos** e **imóveis**.

## Canais

| Canal | Modo | Como funciona |
|---|---|---|
| Mercado Livre | `api` | Publica sozinho via API oficial (OAuth2). Cria, pausa e encerra anúncios. |
| OLX | `feed` | O sistema expõe um XML de autoupload; a OLX lê a URL e publica. Requer aprovação de parceiro. |
| Facebook / Instagram (catálogo) | `api` | Envia itens ao Catalog da Meta. Exige Business Manager — publica como loja, não como pessoa física. |
| Grupos do Facebook | `manual` | **Não existe API.** O sistema gera o post pronto (texto + hashtags + fotos) para você colar. |
| WhatsApp | `manual` | Gera a mensagem de divulgação e o link `wa.me`. |

### Por que grupos do Facebook é manual

A Meta descontinuou a publicação programática em grupos (a permissão `publish_to_groups` saiu em 2020) e o Marketplace de pessoa física nunca teve API pública. Automatizar o navegador logado viola os Termos da plataforma e costuma terminar em conta bloqueada — por isso o sistema entrega o conteúdo pronto em vez de postar sozinho.

## Geração do anúncio com IA (Gemini)

No formulário de produto há o painel **Gerar com IA**. Você escreve em linguagem solta o que está vendendo e o sistema devolve título, descrição e atributos preenchidos:

> `Playstation 4 slim 1TB com 2 controles, vendo porque comprei o PS5. Pouco uso, sempre em casa.`

O modelo recebe instruções para:

- **usar só os fatos que você deu** — não inventa nota fiscal, caixa, garantia, quilometragem ou acessório que você não citou;
- **deduzir o que decorre do que foi dito** — "comprei o PS5" vira "console conservado, em estado de novo, vendido só porque troquei por um modelo mais novo", que é exatamente o que tranquiliza o comprador;
- escrever **título de até 60 caracteres começando pelos termos de busca** (é assim que o anúncio aparece no Mercado Livre e na OLX);
- evitar o tom de panfleto (`IMPERDÍVEL!!!`), que derruba a confiança.

A resposta vem com três listas que aparecem abaixo do texto gerado:

| Lista | Para que serve |
|---|---|
| **Pontos fortes usados** | o que o anúncio está destacando |
| **Deduções da IA** | tudo que foi inferido e você não disse literalmente — confira antes de salvar |
| **Informe isto para vender mais rápido** | o que faltou (tem a caixa? quantos controles? km real?) |

Editando um produto que já existe, o mesmo botão vira **Reescrever anúncio**: ele melhora o texto preservando os fatos atuais, e o campo livre aceita instruções (`destaque que tem 2 controles e caixa original`).

A saída é validada contra um schema antes de chegar ao formulário — se o modelo responder fora do formato, nada é preenchido e o erro aparece na tela. **Nada é salvo sozinho:** o rascunho preenche os campos e você revisa antes de clicar em Salvar.

Configure com `GEMINI_API_KEY` no `.env` (chave em <https://aistudio.google.com/apikey>). Sem a chave o painel aparece desabilitado e o resto do sistema funciona normalmente. O padrão é `gemini-2.5-flash`; `GEMINI_MODEL=gemini-2.5-pro` escreve um pouco melhor e custa mais por anúncio.

## Rodando

```bash
npm install
cp .env.example .env
npm run dev
```

Abra <http://127.0.0.1:3000>. Requer Node 22.5 ou maior (usa o SQLite embutido do Node, sem dependência nativa).

Com Docker:

```bash
docker compose up --build
```

### Dois ajustes antes de publicar de verdade

1. **`DRY_RUN=true`** (padrão) monta o payload e grava tudo, mas não chama as plataformas. Deixe ligado até validar as credenciais; a tela de publicação mostra o JSON exato que seria enviado.
2. **`PUBLIC_URL`** precisa ser uma URL que a internet alcança — as plataformas **baixam as fotos** por ela. Com `localhost` nenhuma foto chega. Em desenvolvimento use um túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

e coloque a URL gerada em `PUBLIC_URL`.

## Fluxo de uso

1. **Novo produto** → escolha o tipo, preencha os campos e salve.
2. Envie as fotos (a primeira é a principal).
3. Marque os canais e clique em **Publicar nos canais marcados**.
4. Canais `api`/`feed` publicam; canais `manual` abrem o **kit**: botão para copiar o texto e baixar as fotos.
5. O histórico registra cada tentativa, com erro da plataforma quando houver.

A validação roda antes do envio e separa **bloqueios** (sem foto, sem preço, sem marca em veículo) de **avisos** (título que será cortado, `PUBLIC_URL` local). Bloqueio impede a publicação, a menos que você marque "ignorar bloqueios".

## Publicando na internet

As plataformas **baixam as fotos** pela `PUBLIC_URL` e o Mercado Livre exige HTTPS no retorno do login — então o sistema precisa de um endereço público antes de publicar de verdade. O passo a passo completo (VPS, Easypanel, domínio com HTTPS, volume das fotos, backup) está em [docs/DEPLOY-EASYPANEL.md](docs/DEPLOY-EASYPANEL.md).

Exposto na internet, o painel passa a pedir usuário e senha: preencha `ADMIN_USER` e `ADMIN_PASS`. Ficam livres de senha, de propósito, as rotas que precisam disso para funcionar — `/uploads` (as plataformas baixam as fotos), `/feeds` (tem token próprio), `/produtos/:id` (página pública do anúncio), `/oauth/*` (callback) e `/m/*` (envio de fotos pelo celular). Sem `ADMIN_PASS` o sistema roda sem senha, como antes, para uso local.

## Credenciais

Nenhuma é obrigatória para usar o sistema em dry-run. O passo a passo de cada plataforma está em [docs/CREDENCIAIS.md](docs/CREDENCIAIS.md).

## Estrutura

```
src/
  config.ts              leitura do .env
  domain/product.ts      schemas por tipo de anúncio (zod)
  db/                    SQLite (node:sqlite) e schema
  channels/              um adapter por plataforma
    types.ts             o contrato Channel que todos implementam
    registry.ts          lista de canais ativos
  services/
    ai.ts                geração de texto via Gemini (prompt + schema de saída)
    products.ts          CRUD e imagens
    publish.ts           orquestra validação → publicação → listing → evento
    templates.ts         geração de texto (descrição, post de grupo, WhatsApp)
  routes/                API REST, OAuth, feed XML, página pública do produto
public/                  painel (HTML/CSS/JS sem build)
```

### Adicionando uma plataforma

Implemente a interface `Channel` (`src/channels/types.ts`) e registre em `src/channels/registry.ts`. Nada mais no sistema precisa mudar — validação, publicação, histórico e interface são genéricos. Candidatos naturais: Shopee, Amazon, Magalu, Webmotors e iCarros (veículos), ZAP/VivaReal (imóveis).

## API

| Método | Rota | O quê |
|---|---|---|
| `GET` | `/api/products` | lista com os anúncios de cada canal |
| `POST` | `/api/products` | cria produto |
| `PUT` | `/api/products/:id` | atualiza |
| `POST` | `/api/products/:id/images` | upload (multipart, jpeg/png/webp, 15 MB) |
| `POST` | `/api/products/:id/publish` | `{ channels, dryRun?, force? }` |
| `GET` | `/api/products/:id/kit/:channel` | kit de publicação manual |
| `POST` | `/api/products/:id/listings/:channel/pause\|close` | pausa/encerra |
| `POST` | `/api/ai/draft` | gera anúncio: `{ kind, input, priceCents?, city?, uf? }` |
| `POST` | `/api/products/:id/ai/improve` | reescreve o anúncio existente: `{ input? }` |
| `GET` | `/api/ai/status` | se a chave do Gemini está configurada |
| `GET` | `/api/channels` | status e conexão de cada canal |
| `GET` | `/api/events` | histórico |
| `GET` | `/feeds/olx.xml?token=...` | feed de autoupload |
| `GET` | `/produtos/:id` | página pública do anúncio |

## Limitações conhecidas

- A autenticação é um Basic Auth de usuário único (`ADMIN_USER`/`ADMIN_PASS`). Serve para um painel pessoal; não há múltiplos usuários, perfis nem registro de quem fez o quê.
- O schema do feed da OLX está em `src/channels/olx/feed.ts` e segue a estrutura pública do autoupload. A OLX entrega o manual definitivo com a aprovação da integração e os nomes de campo variam por vertical: ajuste **só esse arquivo**.
- A categoria do Mercado Livre é adivinhada pelo título (`domain_discovery`). Se cair na categoria errada, a API recusa atributos obrigatórios — o erro aparece íntegro no histórico.
- O texto gerado pela IA é um rascunho: ele parte do que você escreveu, e o que foi deduzido fica listado em "Deduções da IA". Confira antes de publicar — anúncio com informação errada gera reclamação e, no Mercado Livre, prejudica a reputação.
- Não há sincronização de volta: perguntas, vendas e pausas feitas direto na plataforma não voltam para o painel.
