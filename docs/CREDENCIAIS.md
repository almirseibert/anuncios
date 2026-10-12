# Como obter as credenciais de cada canal

Nada aqui é obrigatório para rodar o sistema: com `DRY_RUN=true` tudo funciona sem credencial nenhuma, montando os payloads. Configure um canal por vez e teste antes de passar ao próximo.

---

## Gemini (geração do texto do anúncio)

1. Abra <https://aistudio.google.com/apikey> com a conta Google que tem o crédito.
2. **Create API key** e escolha o projeto do Google Cloud onde está o crédito — a cobrança vai para o projeto vinculado, então confira este passo se quiser usar o crédito que já tem.
3. Cole no `.env`:

```
GEMINI_API_KEY=sua_chave
GEMINI_MODEL=gemini-2.5-flash
```

4. Reinicie o servidor. O painel "Gerar com IA" no formulário de produto fica habilitado.

Um anúncio gasta pouco: o prompt tem algumas centenas de tokens e a resposta raramente passa de mil. `gemini-2.5-flash` é o padrão pelo custo; troque para `gemini-2.5-pro` se quiser texto mais caprichado.

A chave fica só no seu `.env` (que está no `.gitignore`) e é usada apenas pelo servidor — o navegador nunca a recebe.

---

## Mercado Livre — o mais completo, comece por ele

1. Entre no [DevCenter](https://developers.mercadolivre.com.br/devcenter) com a conta que vai vender.
2. **Criar aplicação**. Preencha:
   - *URI de redirect*: `http://127.0.0.1:3000/oauth/mercadolivre/callback`
   - *Escopos*: `read`, `write`, `offline_access` (o último é o que permite renovar o token sem logar de novo)
   - *Tópicos de notificação*: pode deixar vazio por enquanto.
3. Copie **App ID** e **Secret Key** para o `.env`:

```
ML_CLIENT_ID=seu_app_id
ML_CLIENT_SECRET=sua_secret
ML_REDIRECT_URI=http://127.0.0.1:3000/oauth/mercadolivre/callback
```

4. Reinicie o servidor, abra a aba **Canais** e clique em **Conectar**. Você autoriza na tela do Mercado Livre e volta conectado.

O token vale 6 horas e o sistema renova sozinho pelo refresh token. Se a conexão cair com "sem refresh_token", o escopo `offline_access` não foi marcado na aplicação.

**Atenção ao redirect em produção:** o Mercado Livre exige HTTPS em URIs que não sejam localhost.

---

## OLX — exige parceria aprovada

A OLX não publica por chamada direta: ela lê periodicamente um arquivo XML seu (*autoupload*).

1. Solicite a integração pelo canal de parceiros/profissionais da OLX, informando o segmento (autos, imóveis ou produtos). Contas de pessoa física comum normalmente **não** têm acesso — o autoupload é voltado a lojistas, revendas e imobiliárias.
2. Defina um token no `.env` para proteger a URL do feed:

```
OLX_FEED_TOKEN=uma_string_aleatoria_longa
```

3. Informe à OLX a URL `https://SEU_DOMINIO/feeds/olx.xml?token=SEU_TOKEN`.
4. No painel, publicar um produto no canal OLX significa **incluí-lo no feed**. A OLX cria o anúncio na próxima leitura.

Quando receber o manual da OLX, ajuste os nomes dos campos em `src/channels/olx/feed.ts` — é o único arquivo que conhece o formato.

---

## Facebook / Instagram (catálogo)

Serve para quem vende como **negócio**. O Marketplace de pessoa física não tem API.

1. Crie um [Business Manager](https://business.facebook.com/) e, dentro dele, um **catálogo** (Commerce Manager → Catálogos → Criar).
2. Em [developers.facebook.com](https://developers.facebook.com/apps), crie um app do tipo *Business*.
3. No Business Manager, crie um **usuário do sistema** (Configurações → Usuários do sistema), dê a ele acesso ao catálogo com permissão de gerenciamento e gere um token com os escopos `catalog_management` e `business_management`.
4. Pegue o ID do catálogo no Commerce Manager e preencha:

```
FB_APP_ID=
FB_APP_SECRET=
FB_CATALOG_ID=
FB_ACCESS_TOKEN=token_do_usuario_do_sistema
```

Tokens de usuário do sistema não expiram em 60 dias como os de usuário comum — é por isso que usamos esse tipo aqui.

---

## Grupos do Facebook — não há credencial

A Meta removeu `publish_to_groups` em 2020 e não há substituto. O sistema gera o post pronto; a publicação é sua. Automatizar o navegador logado viola os Termos e arrisca o bloqueio da conta.

Para render mais no manual:

- Preencha `SELLER_NAME` e `SELLER_PHONE` no `.env` — eles entram no rodapé do post.
- Use o botão **Baixar fotos** do kit e anexe os arquivos (grupos dão muito mais alcance a post com foto).
- Marque o anúncio como publicado no painel depois de postar, para o histórico ficar correto.

---

## WhatsApp

Só precisa de `SELLER_PHONE` no `.env` (apenas dígitos, com DDD) para gerar o link `wa.me`.

---

## Depois de configurar

Com um canal conectado e as credenciais testadas, desligue a simulação:

```
DRY_RUN=false
```

e confira que `PUBLIC_URL` é alcançável pela internet — é por essa URL que as plataformas baixam as fotos.
