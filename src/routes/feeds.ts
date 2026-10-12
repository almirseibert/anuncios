import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { buildOlxFeed } from '../channels/olx/feed.ts';
import { listProducts } from '../services/products.ts';
import { allListings } from '../services/publish.ts';

/**
 * O feed e isento do basic auth (a OLX le sem credencial), entao o token e a
 * unica protecao dele. Sem token configurado so liberamos quando o painel
 * tambem esta sem senha, isto e, uso local -- nunca num app exposto.
 */
function tokenOk(given: string | undefined) {
  if (!config.olxFeedToken) return !config.admin.pass;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.olxFeedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerFeedRoutes(app: FastifyInstance) {
  /**
   * Feed de autoupload da OLX. Cadastre esta URL no painel do parceiro:
   * a OLX le periodicamente e cria/atualiza/remove os anuncios conforme o conteudo.
   */
  app.get('/olx.xml', async (req, reply) => {
    const { token } = req.query as { token?: string };
    if (!tokenOk(token)) return reply.status(401).send({ error: 'token invalido' });

    const marked = new Set(
      allListings().filter((l) => l.channel === 'olx' && l.status === 'publicado').map((l) => l.productId),
    );
    const products = listProducts().filter((p) => marked.has(p.id));
    return reply.type('application/xml; charset=utf-8').send(buildOlxFeed(products));
  });
}
