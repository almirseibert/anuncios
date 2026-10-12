import { config } from '../../config.ts';
import type { Product } from '../../domain/product.ts';
import type { Channel, PublishContext, PublishResult, ValidationIssue } from '../types.ts';
import { buildOlxAd } from './feed.ts';
import { photoIssues } from '../../services/images.ts';

export const CHANNEL_ID = 'olx';

function validate(product: Product): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (product.images.length === 0) {
    issues.push({ field: 'images', severity: 'error', message: 'a OLX exige pelo menos 1 foto' });
  }
  issues.push(...photoIssues('olx', product, 'a OLX'));
  if (!(product.cep || config.seller.cep)) {
    issues.push({ field: 'cep', severity: 'error', message: 'CEP e obrigatorio na OLX (define a regiao do anuncio)' });
  }
  if (product.title.length > 90) {
    issues.push({ field: 'title', severity: 'warn', message: 'titulo sera cortado em 90 caracteres' });
  }
  if (!config.olxFeedToken) {
    issues.push({
      severity: 'warn',
      message: 'OLX_FEED_TOKEN vazio: a URL do feed fica publica. Defina um token no .env.',
    });
  }
  return issues;
}

/**
 * A OLX nao cria anuncio por chamada direta: ela agenda a leitura do feed de
 * autoupload. "Publicar" aqui significa incluir o produto no feed e devolver a
 * URL que a OLX deve consumir.
 */
async function publish(ctx: PublishContext): Promise<PublishResult> {
  const feedUrl = `${config.publicUrl}/feeds/olx.xml${config.olxFeedToken ? `?token=${config.olxFeedToken}` : ''}`;
  return {
    status: 'publicado',
    externalId: ctx.product.id,
    payload: { feedUrl, ad: buildOlxAd(ctx.product) },
    message: `incluido no feed de autoupload. A OLX publica na proxima leitura de ${feedUrl}`,
  };
}

export const olx: Channel = {
  id: CHANNEL_ID,
  label: 'OLX (autoupload)',
  mode: 'feed',
  kinds: ['geral', 'veiculo', 'imovel'],
  docsUrl: 'https://ajuda.olx.com.br/',
  requiredEnv: ['OLX_FEED_TOKEN'],
  isConfigured() {
    return true; // o feed funciona sem credencial; a OLX precisa apenas cadastrar a URL.
  },
  validate,
  publish,
};
