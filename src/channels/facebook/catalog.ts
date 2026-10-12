import { config } from '../../config.ts';
import { request } from '../../lib/http.ts';
import { buildDescription } from '../../services/templates.ts';
import type { Product } from '../../domain/product.ts';
import type { Channel, PublishContext, PublishResult, ValidationIssue } from '../types.ts';

export const CHANNEL_ID = 'facebook_catalog';

const CATEGORY: Record<Product['kind'], string> = {
  geral: 'home_goods',
  veiculo: 'vehicle',
  imovel: 'home_listing',
};

/** Item do Commerce/Catalog da Meta (alimenta Marketplace e lojas do Facebook/Instagram). */
export function buildCatalogItem(product: Product) {
  return {
    retailer_id: product.id,
    name: product.title.slice(0, 150),
    description: buildDescription(product).slice(0, 5000),
    availability: product.quantity > 0 ? 'in stock' : 'out of stock',
    condition: product.condition === 'novo' ? 'new' : 'used',
    price: `${(product.priceCents / 100).toFixed(2)} BRL`,
    currency: 'BRL',
    url: `${config.publicUrl}/produtos/${product.id}`,
    image_url: product.images[0]?.url ?? '',
    additional_image_urls: product.images.slice(1, 10).map((i) => i.url),
    brand: String((product.attrs as Record<string, unknown>).brand ?? config.seller.name ?? '').slice(0, 70),
    category: CATEGORY[product.kind],
    custom_label_0: product.kind,
  };
}

function validate(product: Product): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (product.images.length === 0) {
    issues.push({ field: 'images', severity: 'error', message: 'o catalogo da Meta exige image_url' });
  }
  if (!config.channels.facebook.catalogId || !config.channels.facebook.accessToken) {
    issues.push({
      severity: 'error',
      message: 'defina FB_CATALOG_ID e FB_ACCESS_TOKEN (token de system user do Business Manager)',
    });
  }
  issues.push({
    severity: 'warn',
    message: 'o catalogo publica como loja/negocio. Marketplace de pessoa fisica nao tem API: use o canal "Grupos do Facebook".',
  });
  return issues;
}

async function publish(ctx: PublishContext): Promise<PublishResult> {
  const item = buildCatalogItem(ctx.product);
  const { catalogId, accessToken, apiVersion } = config.channels.facebook;

  if (ctx.dryRun) {
    return { status: 'rascunho', payload: item, message: 'DRY_RUN ligado: payload montado, nada enviado a Meta.' };
  }

  const result = await request<{ handles?: string[] }>(
    `https://graph.facebook.com/${apiVersion}/${catalogId}/batch`,
    {
      method: 'POST',
      json: { requests: [{ method: 'UPDATE', retailer_id: item.retailer_id, data: item }] },
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );

  return {
    status: 'publicado',
    externalId: item.retailer_id,
    payload: item,
    result,
    message: 'item enviado ao catalogo; a Meta processa em alguns minutos',
  };
}

export const facebookCatalog: Channel = {
  id: CHANNEL_ID,
  label: 'Facebook / Instagram (catalogo)',
  mode: 'api',
  kinds: ['geral', 'veiculo', 'imovel'],
  docsUrl: 'https://developers.facebook.com/docs/marketing-api/catalog',
  requiredEnv: ['FB_CATALOG_ID', 'FB_ACCESS_TOKEN'],
  isConfigured() {
    return Boolean(config.channels.facebook.catalogId && config.channels.facebook.accessToken);
  },
  validate,
  publish,
};
