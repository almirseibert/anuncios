import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config, isLocalUrl } from '../config.ts';

/**
 * Rotas que NAO pedem senha, de proposito:
 * - /uploads: e por esta URL que o Mercado Livre, a OLX e a Meta baixam as fotos;
 *   com senha aqui, nenhuma foto chega na plataforma.
 * - /feeds: a OLX le o XML sem credencial; a protecao e o OLX_FEED_TOKEN na query.
 * - /produtos: pagina publica do anuncio, feita para o comprador abrir.
 * - /oauth: o retorno do Mercado Livre chega sem o header de autenticacao.
 * - /m: envio de fotos pelo celular, autenticado pelo token do link.
 */
const PUBLIC_PREFIXES = ['/uploads/', '/feeds/', '/produtos/', '/oauth/', '/m/'];

function sameString(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** true quando o painel esta protegido por senha. */
export function authEnabled() {
  return Boolean(config.admin.pass);
}

/**
 * Basic auth no painel inteiro.
 *
 * Sem ADMIN_PASS o hook nao e registrado, para o uso local continuar simples --
 * mas so quando o app de fato e local. Com PUBLIC_URL publica e sem senha o
 * servidor **recusa iniciar**: um painel exposto sem senha deixa qualquer um
 * criar, editar e publicar anuncio na sua conta, e isso passa despercebido por
 * meses. Quem realmente quiser esse modo usa ALLOW_NO_AUTH=true.
 */
export function registerBasicAuth(app: FastifyInstance) {
  const { user, pass, allowNoAuth } = config.admin;
  if (!pass) {
    if (!isLocalUrl(config.publicUrl) && !allowNoAuth) {
      throw new Error(
        `ADMIN_PASS vazio com PUBLIC_URL publica (${config.publicUrl}): o painel ficaria aberto na internet. `
        + 'Defina ADMIN_USER e ADMIN_PASS nas variaveis de ambiente '
        + '(no Easypanel: servico > Environment) ou, se isso e mesmo o que voce quer, ALLOW_NO_AUTH=true.',
      );
    }
    app.log.warn('ADMIN_PASS vazio: o painel esta SEM senha. Nao exponha este app na internet assim.');
    return;
  }

  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;

    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const gotUser = sep === -1 ? decoded : decoded.slice(0, sep);
      const gotPass = sep === -1 ? '' : decoded.slice(sep + 1);
      if (sameString(gotUser, user) && sameString(gotPass, pass)) return;
    }

    return reply
      .status(401)
      .header('www-authenticate', 'Basic realm="Anuncios", charset="UTF-8"')
      .send({ error: 'autenticacao necessaria' });
  });
}
