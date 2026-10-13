import { config, isLocalUrl } from '../../config.ts';
import { request } from '../../lib/http.ts';
import type { Product } from '../../domain/product.ts';
import { ChannelError, type Channel, type PublishContext, type PublishResult, type ValidationIssue } from '../types.ts';
import { buildDescription } from '../../services/templates.ts';
import { comDica, situacaoNoMl } from './errors.ts';
import { CHANNEL_ID, ML_API, ensureToken } from './auth.ts';
import { buildItem, listingTypeId, predictCategory } from './map.ts';
import { preflight, type Preflight } from './preflight.ts';
import { updateExisting } from './update.ts';
import { resolveLocation } from './location.ts';
import { photoIssues } from '../../services/images.ts';

function validate(product: Product): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (product.images.length === 0) {
    issues.push({ field: 'images', severity: 'error', message: 'o Mercado Livre exige pelo menos 1 foto' });
  }
  issues.push(...photoIssues('mercadolivre', product, 'o Mercado Livre'));
  if (product.title.length > 60) {
    issues.push({ field: 'title', severity: 'warn', message: 'titulo sera cortado em 60 caracteres' });
  }
  if (product.priceCents <= 0) {
    issues.push({ field: 'priceCents', severity: 'error', message: 'preco precisa ser maior que zero' });
  }
  if (isLocalUrl(config.publicUrl)) {
    issues.push({
      field: 'images', severity: 'warn',
      message: 'PUBLIC_URL aponta para localhost: o Mercado Livre nao conseguira baixar as fotos. Use um tunel (ngrok/cloudflared).',
    });
  }
  if (product.kind === 'geral') {
    const a = product.attrs as Record<string, unknown>;
    if (!a.gtin && !a.gtinMissingReason) {
      issues.push({
        field: 'attrs.gtin',
        severity: 'warn',
        message: 'sem codigo de barras (EAN): boa parte das categorias do ML exige. Ele fica na caixa '
          + 'ou na etiqueta do produto. Se nao houver, informe o motivo no cadastro.',
      });
    }
  }
  if (product.kind === 'veiculo') {
    const a = product.attrs as Record<string, unknown>;
    if (!a.brand || !a.model) {
      issues.push({ field: 'attrs.brand', severity: 'error', message: 'marca e modelo sao obrigatorios para veiculos' });
    }
  }
  return issues;
}

/** Lista numerada para a mensagem do painel (que mostra as quebras de linha). */
function lista(titulo: string, itens: string[]) {
  return itens.length ? `\n${titulo}\n${itens.map((t, i) => `(${i + 1}) ${t}`).join('\n')}` : '';
}

/**
 * Prepara o anuncio: categoria, pre-checagem da conta (envio, tipo de anuncio,
 * atributos) e o payload ja com as escolhas certas para esta conta.
 */
async function preparar(product: Product, token: string) {
  // Se os atributos foram preenchidos numa categoria, publica nela: outra
  // categoria exigiria outros atributos.
  const categoryId = product.channelAttrs?.mercadolivre?.categoryId
    ?? await predictCategory(product.title, token);
  const pf = await preflight(product, categoryId, listingTypeId(product), token);
  // Classificado (veiculo, imovel) vai com a localizacao em IDs do ML; sem ela o ML recusa.
  const location = product.kind === 'geral' ? undefined : await resolveLocation(product, token);
  const payload = buildItem(product, categoryId, { shipping: pf.shipping, listingTypeId: pf.listingTypeId, location });
  return { pf, payload };
}

/**
 * Mensagem de recusa: tudo o que precisa ser resolvido de uma vez -- o que a
 * pre-checagem achou e o que o ML respondeu, traduzido.
 */
function recusa(prefixo: string, erro: unknown, pf: Preflight) {
  const err = comDica(erro, new Set(pf.atributosCobrados));
  const msg = (err as Error).message;
  return {
    err,
    message: pf.problemas.length
      ? `${prefixo}.${lista('Resolva tudo isto antes de tentar de novo:', pf.problemas)}\n${msg}`
      : `${prefixo}: ${msg}`,
  };
}

/**
 * Em dry-run, quando a conta esta conectada, quem diz se o anuncio esta valido
 * e o proprio Mercado Livre: POST /items/validate aceita o payload inteiro e
 * devolve os erros sem criar anuncio nenhum. Isso evita descobrir cada regra
 * nova do ML uma por vez, tentando publicar de verdade.
 */
async function dryRun(product: PublishContext['product']): Promise<PublishResult> {
  let token: string;
  try {
    token = (await ensureToken()).accessToken!;
  } catch {
    return {
      status: 'rascunho',
      payload: buildItem(product, '(categoria definida na publicacao real)'),
      message: 'DRY_RUN ligado: payload montado, nada enviado. Conecte o Mercado Livre na aba Canais '
        + 'para que o proprio ML confira o anuncio antes de voce publicar.',
    };
  }

  const { pf, payload } = await preparar(product, token);
  try {
    const result = await request(`${ML_API}/items/validate`, {
      method: 'POST',
      json: payload,
      headers: { authorization: `Bearer ${token}` },
    });
    // O ML tem a palavra final: validou, pode publicar. O que a pre-checagem
    // achou vai como atencao.
    return {
      status: 'rascunho',
      payload,
      result,
      message: 'o Mercado Livre validou este anuncio: pode publicar (desligue DRY_RUN).'
        + lista('Atencao:', [...pf.problemas, ...pf.avisos]),
    };
  } catch (erro) {
    const { err, message } = recusa('o Mercado Livre recusaria este anuncio', erro, pf);
    return {
      status: 'erro',
      payload,
      result: err instanceof ChannelError ? err.detail : undefined,
      message: message + lista('Atencao:', pf.avisos),
    };
  }
}

async function publish(ctx: PublishContext): Promise<PublishResult> {
  const { product } = ctx;
  if (ctx.dryRun) return dryRun(product);

  const account = await ensureToken();
  const token = account.accessToken!;

  // Produto que ja tem anuncio no ML (importado ou publicado daqui): atualiza
  // o mesmo anuncio. So cria outro se o antigo nao puder mais voltar.
  let antes = '';
  if (ctx.externalId) {
    const r = await updateExisting(product, ctx.externalId, token);
    if ('result' in r) return r.result;
    antes = `o anuncio ${ctx.externalId} estava encerrado e o ML nao deixou republica-lo (${r.semVolta}); `
      + 'foi criado um anuncio novo. ';
  }

  const { pf, payload } = await preparar(product, token);

  let created: { id: string; permalink: string; status: string };
  try {
    created = await request(`${ML_API}/items`, {
      method: 'POST',
      json: payload,
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (erro) {
    const { err, message } = recusa('o Mercado Livre recusou o anuncio', erro, pf);
    throw err instanceof ChannelError ? new ChannelError(message, err.detail) : err;
  }

  // A descricao deixou de ser aceita no corpo do item (o ML desativou o campo
  // em 2021): ela vai numa chamada propria, depois que o anuncio existe.
  let aviso = '';
  try {
    await request(`${ML_API}/items/${created.id}/description`, {
      method: 'POST',
      json: { plain_text: buildDescription(product) },
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // O anuncio ja existe: nao da para desfazer por causa da descricao.
    aviso = ` -- ATENCAO: a descricao nao subiu (${(err as Error).message}). `
      + 'Edite a descricao no painel do Mercado Livre ou publique de novo.';
  }

  const situacao = situacaoNoMl(created.status);
  return {
    status: situacao.status,
    externalId: created.id,
    permalink: created.permalink,
    payload,
    result: created,
    message: `${antes}anuncio ${created.id} criado${aviso}`
      + lista('Atencao:', [...(situacao.aviso ? [situacao.aviso] : []), ...pf.avisos]),
  };
}

async function changeStatus(
  ctx: PublishContext & { externalId: string },
  status: 'paused' | 'closed',
): Promise<PublishResult> {
  if (ctx.dryRun) {
    return { status: status === 'paused' ? 'pausado' : 'encerrado', message: 'DRY_RUN ligado: nada enviado.' };
  }
  const account = await ensureToken();
  const result = await request(`${ML_API}/items/${ctx.externalId}`, {
    method: 'PUT',
    json: { status },
    headers: { authorization: `Bearer ${account.accessToken}` },
  });
  return { status: status === 'paused' ? 'pausado' : 'encerrado', externalId: ctx.externalId, result };
}

export const mercadoLivre: Channel = {
  id: CHANNEL_ID,
  label: 'Mercado Livre',
  mode: 'api',
  kinds: ['geral', 'veiculo', 'imovel'],
  docsUrl: 'https://developers.mercadolivre.com.br/pt_br/produto-publicacao-de-produtos',
  requiredEnv: ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_REDIRECT_URI'],
  isConfigured() {
    const c = config.channels.mercadolivre;
    return Boolean(c.clientId && c.clientSecret && c.redirectUri);
  },
  validate,
  publish,
  pause: (ctx) => changeStatus(ctx, 'paused'),
  close: (ctx) => changeStatus(ctx, 'closed'),
};
