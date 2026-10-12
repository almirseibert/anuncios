# Credenciais de cada canal, passo a passo

Faça o [DEPLOY-EASYPANEL.md](DEPLOY-EASYPANEL.md) primeiro: quase todo passo aqui pede o seu endereço público (`https://SEU-DOMINIO`), e o Mercado Livre recusa endereço sem HTTPS.

Nada aqui é obrigatório para o sistema funcionar: com `DRY_RUN=true` tudo roda sem credencial nenhuma, montando os payloads. **Configure um canal por vez e teste antes de passar ao próximo** — assim, quando algo falhar, você sabe exatamente o que mudou.

Cada variável que você preencher vai na aba **Environment** do serviço no Easypanel (ou no `.env`, se estiver rodando local). O serviço reinicia sozinho a cada alteração.

Ordem recomendada: **Gemini → Mercado Livre → Meta → OLX**. Gemini porque destrava a redação e o tratamento de fotos na hora; Mercado Livre porque é o canal que publica de verdade e o que mais dá retorno; OLX por último porque depende de aprovação deles, que pode não vir.

---

## 1. Gemini — redação do anúncio e melhoria das fotos

É o que escreve título e descrição a partir do que você digita em linguagem solta, e o que alimenta o botão "Melhorar foto".

1. Abra <https://aistudio.google.com/apikey> com a conta Google que tem o crédito.
2. **Create API key** e escolha o projeto do Google Cloud onde está o crédito — a cobrança vai para o projeto vinculado. Confira este passo se quiser usar crédito que já tem.
3. Preencha:

```
GEMINI_API_KEY=sua_chave
GEMINI_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
```

4. No painel, o bloco **Gerar com IA** no formulário de produto fica habilitado.

Custo: um anúncio de texto gasta centenas de tokens — frações de centavo. A melhoria de foto é cobrada por imagem gerada e custa bem mais que o texto, por isso ela só roda quando você clica no botão, uma foto por vez. `gemini-2.5-flash` é o padrão pelo custo; `gemini-2.5-pro` escreve um pouco melhor.

A chave fica apenas no servidor — o navegador nunca a recebe.

---

## 2. Mercado Livre — comece por aqui

É o único canal que publica, pausa e encerra sozinho. E é também o que fornece as **fotos oficiais de catálogo** usadas pelo botão "Buscar fotos do catálogo" — a mesma credencial serve para as duas coisas.

1. Entre no [DevCenter](https://developers.mercadolivre.com.br/devcenter) com a conta que vai **vender** (não crie com uma conta secundária: o anúncio sai na conta que autorizar).
2. **Criar aplicação**:
   - *URI de redirect*: `https://SEU-DOMINIO/oauth/mercadolivre/callback` — exatamente igual, com `https`, sem barra no fim. Qualquer diferença de caractere faz o login falhar com `invalid_redirect_uri`.
   - *Escopos*: `read`, `write` e **`offline_access`**. O último é o que deixa o sistema renovar o acesso sozinho; sem ele você teria de reconectar a cada 6 horas.
   - *Tópicos de notificação*: deixe vazio (o sistema não recebe webhooks hoje).
3. Copie **App ID** e **Secret Key**:

```
ML_CLIENT_ID=seu_app_id
ML_CLIENT_SECRET=sua_secret
ML_REDIRECT_URI=https://SEU-DOMINIO/oauth/mercadolivre/callback
ML_SITE_ID=MLB
```

4. No painel, aba **Canais** → **Conectar** no Mercado Livre. Você autoriza na tela do ML e volta conectado.

Depois disso:

- **A autorização usa PKCE**, hoje obrigatório no Mercado Livre. Isso é interno ao sistema, você não configura nada — só precisa saber de um efeito prático: o processo tem de ser concluído na mesma execução do servidor. Se o Easypanel reiniciar entre clicar em "Conectar" e voltar da tela do ML (um Deploy no meio, por exemplo), a conexão falha com "Autorização expirada". É só clicar em Conectar de novo.
- O acesso vale 6 horas e é renovado automaticamente. Se a conexão cair dizendo "sem refresh_token", o escopo `offline_access` não foi marcado na aplicação — corrija lá e reconecte.
- **Com a conta conectada, o dry-run deixou de ser simulação:** o payload é enviado ao endpoint de validação do próprio Mercado Livre, que responde se o anúncio seria aceito e, se não, por quê. Use isso antes de desligar `DRY_RUN` — é a forma de descobrir o que falta sem criar anúncio nenhum.
- **O título que você escreve não vale no Mercado Livre.** Em produtos, o ML migrou para o modelo de *User Products*: o anúncio informa o **nome do produto** (`family_name`, algo como "Sony Playstation 4 Slim") e **o próprio ML monta o título exibido**, a partir desse nome e dos atributos. Mandar o seu título junto é recusado com *"The fields [title] are invalid"*. Por isso: preencha **marca e modelo** no formulário — é o que forma o nome do produto, e sem eles o sistema cai no seu título como último recurso. O título continua valendo em OLX, catálogo da Meta, grupos e WhatsApp, e continua sendo o que o ML usa para adivinhar a categoria. Em **veículos e imóveis** (classificados), o modelo é o antigo: o título é seu e é o que aparece.
- Sem garantia informada, o anúncio vai como **"Sem garantia"** — exigência do ML para a maioria das categorias de produto, e o que de fato vale num usado de pessoa física. Se você escrever a garantia no formato `3 meses`, ela vai como prazo; em texto livre, vai só como "garantia do vendedor" e o detalhe fica na descrição.
- A categoria do anúncio é adivinhada pelo título. Se cair na categoria errada, o ML recusa os atributos obrigatórios e o erro aparece inteiro no histórico; ajuste o título (marca + modelo primeiro) e tente de novo.
- **Foto real é exigência, não detalhe.** Anúncio de usado com foto só de catálogo é derrubado e prejudica a reputação. Por isso o sistema não deixa foto de catálogo ser a capa, e bloqueia a publicação de produto que não tenha nenhuma foto sua.

---

## 3. Meta — catálogo do Facebook e Instagram

Serve para quem vende como **negócio**. O **Marketplace de pessoa física não tem API** — para ele, e para os grupos, o sistema gera o kit pronto (item 5).

1. Crie um [Business Manager](https://business.facebook.com/) e, dentro dele, um **catálogo**: Commerce Manager → Catálogos → Criar.
2. Em [developers.facebook.com/apps](https://developers.facebook.com/apps), crie um app do tipo **Business**.
3. No Business Manager: Configurações → **Usuários do sistema** → criar um → dar a ele acesso ao catálogo com permissão de **gerenciar** → **Gerar token** com os escopos `catalog_management` e `business_management`.
4. Pegue o ID do catálogo no Commerce Manager e preencha:

```
FB_APP_ID=
FB_APP_SECRET=
FB_CATALOG_ID=
FB_ACCESS_TOKEN=token_do_usuario_do_sistema
FB_API_VERSION=v21.0
```

Token de **usuário do sistema** é o único que não expira em 60 dias — é por isso que o sistema usa esse tipo e não o token de usuário comum.

---

## 4. OLX — depende de aprovação, e normalmente não sai para pessoa física

A OLX não publica por chamada direta: ela **lê um XML seu** periodicamente (*autoupload*). Isso é oferecido a lojista, revenda e imobiliária; conta de pessoa física comum em geral **não** é aprovada. Se for o seu caso, deixe este canal desligado — o resto do sistema funciona igual, e o anúncio da OLX você publica à mão.

1. Solicite a integração pelo canal de parceiros/profissionais da OLX, informando o segmento (autos, imóveis ou produtos).
2. Defina um token para proteger a URL do feed:

```
OLX_FEED_TOKEN=uma_string_aleatoria_longa
```

   Isso não é opcional num app publicado: sem token, qualquer pessoa que descobrisse a URL leria seu catálogo inteiro. O sistema recusa servir o feed sem token quando o painel tem senha.
3. Informe à OLX a URL: `https://SEU-DOMINIO/feeds/olx.xml?token=SEU_TOKEN`
4. No painel, publicar no canal OLX significa **incluir o produto no feed**. A OLX cria o anúncio na próxima leitura (algumas horas).

Quando receber o manual oficial da OLX, os nomes de campo variam por vertical: ajuste **só** `src/channels/olx/feed.ts`, que é o único arquivo que conhece o formato.

---

## 5. Grupos do Facebook e WhatsApp — sem credencial

Não há o que configurar além dos seus dados, porque **não existe API**: a Meta removeu `publish_to_groups` em 2020 e não há substituto. Automatizar o navegador logado viola os Termos e costuma terminar em conta bloqueada — por isso o sistema entrega o conteúdo pronto e a postagem é sua.

```
SELLER_NAME=Seu Nome
SELLER_PHONE=51999998888
```

(`SELLER_PHONE` só dígitos, com DDD — é o que gera o link `wa.me`.)

No kit de cada canal manual você tem o botão de copiar o texto e o de baixar as fotos. Post com foto tem muito mais alcance nos grupos. Depois de postar, marque como publicado no painel para o histórico ficar correto.

---

## 6. Desligar a simulação

Com o canal conectado e um dry-run limpo:

```
DRY_RUN=false
```

Confira antes que `PUBLIC_URL` é o seu domínio HTTPS e que a foto abre em janela anônima (passo 9 do documento de deploy) — é por essa URL que as plataformas baixam as imagens. Publique **um** produto de teste primeiro e confira o anúncio no site da plataforma.
