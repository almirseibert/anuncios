# Publicar no Easypanel, do zero

A ordem aqui importa. O Mercado Livre exige uma URL **HTTPS** para o retorno do login, e as três plataformas **baixam as fotos** pela `PUBLIC_URL` — então o endereço público tem que existir **antes** de você criar a aplicação no Mercado Livre. Faça este documento primeiro e só depois o [CREDENCIAIS.md](CREDENCIAIS.md).

Tempo: cerca de 40 minutos, quase tudo esperando o servidor.

---

## 1. O servidor

Qualquer VPS Linux com **2 GB de RAM** e Ubuntu 22.04/24.04 serve. O sistema é leve: um processo Node e um arquivo SQLite. As fotos é que ocupam espaço — 20 GB de disco aguentam alguns milhares de anúncios.

Opções comuns no Brasil: Hetzner (CX22, ~€4/mês, data center na Alemanha), Contabo, DigitalOcean, Hostinger VPS. Latência não importa aqui; é um painel que só você usa.

Ao criar, anote o **IP** e guarde a senha de root.

## 2. Instalar o Easypanel

Entre por SSH (`ssh root@SEU_IP`) e rode:

```bash
curl -sSL https://get.easypanel.io | sh
```

Ele instala o Docker e sobe o painel. Ao terminar, abra no navegador:

```
http://SEU_IP:3000
```

Crie a conta de administrador nessa primeira tela — ela é de quem abrir primeiro, então faça isso agora e não deixe o servidor parado com essa tela aberta.

O aviso de "conexão não segura" nesse primeiro acesso é esperado: ainda não há certificado, você está entrando por IP.

> **Aviso de porta:** o painel do Easypanel usa a porta 3000, e o nosso app também escuta 3000 *dentro do contêiner*. Não há conflito, porque quem publica o app para fora é o proxy do Easypanel — nunca mapeie a porta 3000 do host para o contêiner.

Em **Settings**, preencha o e-mail do Let's Encrypt. É com ele que os certificados HTTPS são emitidos e renovados.

## 3. Criar o serviço

1. **Project** → `+ Create Project` → nome `anuncios`.
2. Dentro do projeto: `+ Service` → **App** → nome `app`.

## 4. Fonte do código

Na aba **Source** do serviço:

- **GitHub** → autorize o Easypanel na sua conta → repositório `almirseibert/anuncios` → branch `main`.
  Se o trabalho mais recente ainda estiver numa branch de desenvolvimento, ou você junta ela na `main` antes
  (pull request no GitHub) ou informa o nome dessa branch aqui — o Easypanel publica a branch que você apontar.
- Se preferir não conectar o GitHub: escolha **Git** e informe a URL pública do repositório.

Na aba **Build**, escolha **Dockerfile** (o arquivo já está na raiz do repositório). Não use Nixpacks: o `Dockerfile` daqui já fixa a imagem com as bibliotecas de imagem que o tratamento de fotos precisa.

## 5. O endereço público

Aba **Domains** → `Add Domain`.

O Easypanel já sugere um domínio próprio no formato `anuncios-app.<id>.easypanel.host`. Use esse — é o que você escolheu, não custa nada e já vem com HTTPS.

- **Host**: o domínio sugerido.
- **Port**: `3000` (a porta em que o processo escuta dentro do contêiner).
- **HTTPS**: ligado, resolver `letsencrypt`.
- Marque como **primary**.

Anote o endereço completo com `https://` — ele vai ser sua `PUBLIC_URL` e aparece em três lugares depois: no `.env`, no redirect do Mercado Livre e na URL do feed da OLX.

> Se o domínio gratuito não estiver disponível no seu plano do Easypanel, a alternativa é um domínio próprio: registre qualquer `.com.br`/`.com` (ou use um que já tenha), aponte um registro **A** para o IP do servidor, e informe esse host aqui. O resto do documento é idêntico. **Não dá para usar só o IP:** o Mercado Livre recusa redirect sem HTTPS, e não existe certificado para IP.

## 6. O volume (o passo que mais dói esquecer)

Aba **Mounts** → `Add Mount` → tipo **Volume**:

- **Name**: `data`
- **Mount path**: `/app/data`

É aqui que ficam **o banco de dados e todas as fotos**. Sem esse volume, cada redeploy começa com o sistema vazio: produtos, histórico e imagens somem sem aviso.

## 7. As variáveis de ambiente

Aba **Environment**. Cole o conteúdo abaixo, trocando o que está em maiúsculas:

```
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=https://SEU-DOMINIO
DRY_RUN=true

ADMIN_USER=almir
ADMIN_PASS=UMA_SENHA_LONGA_E_ALEATORIA

SELLER_NAME=Seu Nome
SELLER_PHONE=51999998888
SELLER_CITY=Sua Cidade
SELLER_UF=RS
SELLER_CEP=00000000
```

Duas coisas sobre isso:

- **`ADMIN_PASS` não é opcional aqui.** O app não tem tela de login própria; essa senha é a única coisa entre a internet e o seu painel. Gere algo longo (`openssl rand -base64 24`) e guarde no gerenciador de senhas.
- **`DRY_RUN=true`** continua ligado. Você desliga no fim, depois de testar as credenciais.

As chaves de Gemini, Mercado Livre, OLX e Meta entram **depois**, à medida que você as cria seguindo o [CREDENCIAIS.md](CREDENCIAIS.md). Cada vez que adicionar uma, o Easypanel reinicia o serviço — é o esperado.

## 8. Deploy

Botão **Deploy**. A primeira build leva alguns minutos (ela instala as dependências e compila a biblioteca de imagem). Acompanhe em **Logs**; no fim deve aparecer:

```
Server listening at http://0.0.0.0:3000
DRY_RUN ligado: as publicacoes montam o payload mas nao chamam as plataformas.
```

## 9. Conferir que ficou de pé

Faça os quatro na ordem — o terceiro é o que costuma pegar.

1. Abra `https://SEU-DOMINIO`. O navegador tem de **pedir usuário e senha** e, depois, mostrar o painel. Se abrir sem pedir, `ADMIN_PASS` não chegou ao contêiner.
2. Crie um produto qualquer e envie uma foto.
3. Copie o endereço da foto (botão direito → copiar endereço da imagem, algo como `https://SEU-DOMINIO/uploads/xxxx.jpg`) e abra numa **janela anônima**. A foto tem de aparecer **sem pedir senha**. É exatamente assim que o Mercado Livre, a OLX e a Meta baixam suas imagens — se aqui pedir senha ou der erro, nenhuma plataforma vai conseguir publicar suas fotos.
4. Marque os canais e clique em **Publicar**. Em dry-run, cada canal mostra o JSON que *seria* enviado. Nada sai para fora.

## 10. Dia a dia

- **Atualizar o sistema**: a cada `git push` na branch, clique em **Deploy** no Easypanel (ou ligue o deploy automático em Source → Auto Deploy).
- **Logs**: aba Logs do serviço. É onde aparece o erro íntegro que a plataforma devolveu.
- **Backup**: o que importa é `/app/data` — `anuncios.db` e `uploads/`. Pelo terminal do servidor:

  ```bash
  docker run --rm -v anuncios_data:/data -v /root:/backup alpine \
    tar czf /backup/anuncios-$(date +%F).tar.gz -C /data .
  ```

  (confira o nome real do volume com `docker volume ls`). Guarde esse `.tar.gz` fora do servidor. Sem ele, perder o VPS é perder o histórico e todas as fotos.
- **Espaço em disco**: as fotos são tratadas no upload (lado maior de 1600 px, ~200-400 KB cada), então o crescimento é lento. O original de cada foto também é guardado, em `uploads/originals`, para permitir desfazer tratamentos — se o disco apertar, é a primeira pasta a arquivar.

## 11. Quando desligar a simulação

Só depois de: Mercado Livre conectado na aba Canais, um dry-run limpo e o teste da foto em janela anônima funcionando. Então troque `DRY_RUN=false` no Environment e publique **um** produto de teste real, conferindo o anúncio no site do Mercado Livre antes de seguir com o resto.
