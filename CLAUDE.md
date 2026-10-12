# Como trabalhar neste repositório

## Processo

- **Commit e push direto na `main`. Não abrir pull request** — foi o combinado com o dono do projeto.
- Depois de cada push, a mudança só entra no ar com um **Deploy no Easypanel** (ou com Auto Deploy ligado em Source). Lembre disso ao responder.

## Antes de dar push

```bash
npm run typecheck && npm test
```

Mudança de interface (`public/`, página do celular em `src/routes/pages.ts`) se testa no navegador, não só por leitura: há Chromium em `/opt/pw-browsers` e `playwright-core` resolve o resto.

## Decisões que já foram tomadas e não devem ser revertidas sem conversa

- **Nenhuma foto sai sem passar por `processUpload`** (`src/services/images.ts`): foto de celular carrega GPS no EXIF e o arquivo em `/uploads` é público.
- **A capa do anúncio é sempre foto do item real.** Foto de catálogo do Mercado Livre é ilustrativa, entra depois e obriga a nota na descrição (`illustrativeNote` em `src/services/templates.ts`). ML e OLX derrubam anúncio de usado ilustrado só com foto de divulgação.
- **`/uploads`, `/feeds`, `/produtos/:id`, `/oauth/*` e `/m/*` ficam fora do basic auth de propósito** (`src/lib/auth.ts`): é por `/uploads` que as plataformas baixam as fotos. Não "corrigir" isso.
- **A edição de foto por IA não pode esconder defeito** (`src/services/imageAi.ts`): o prompt proíbe, e é o que mantém o anúncio honesto.
