import { config } from '../../config.ts';
import { request } from '../../lib/http.ts';
import type { Product } from '../../domain/product.ts';
import type { Channel, PublishContext, PublishResult, ValidationIssue } from '../types.ts';
import { CHANNEL_ID, ML_API, ensureToken } from './auth.ts';
import { buildItem, predictCategory } from './map.ts';

function validate(product: Product): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (product.images.length === 0) {
    issues.push({ field: 'images', severity: 'error', message: 'o Mercado Livre exige pelo menos 1 foto' });
  }
  if (product.title.length > 60) {
    issues.push({ field: 'title', severity: 'warn', message: 'titulo sera cortado em 60 caracteres' });
  }
  if (product.priceCents <= 0) {
    issues.push({ field: 'priceCents', severity: 'error', message: 'preco precisa ser maior que zero' });
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(config.publicUrl)) {
    issues.push({
      field: 'images', severity: 'warn',
      message: 'PUBLIC_URL aponta para localhost: o Mercado Livre nao conseguira baixar as fotos. Use um tunel (ngrok/cloudflared).',
    });
  }
  if (product.kind === 'veiculo') {
    const a = product.attrs as Record<string, unknown>;
    if (!a.brand || !a.model) {
      issues.push({ field: 'attrs.brand', severity: 'error', message: 'marca e modelo sao obrigatorios para veiculos' });
    }
  }
  return issues;
}

async function publish(ctx: PublishContext): Promise<PublishResult> {
  const { product } = ctx;

  if (ctx.dryRun) {
    return {
      status: 'rascunho',
      payload: buildItem(product, '(categoria definida na publicacao real)'),
      message: 'DRY_RUN ligado: payload montado, nada enviado ao Mercado Livre.',
    };
  }

  const account = await ensureToken();
  const token = account.accessToken!;
  const categoryId = await predictCategory(product.title, token);
  const payload = buildItem(product, categoryId);

  const created = await request<{ id: string; permalink: string; status: string }>(`${ML_API}/items`, {
    method: 'POST',
    json: payload,
    headers: { authorization: `Bearer ${token}` },
  });

  return {
    status: 'publicado',
    externalId: created.id,
    permalink: created.permalink,
    payload,
    result: created,
    message: `anuncio ${created.id} criado`,
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
