import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authorizeUrl, exchangeCode } from '../channels/mercadolivre/auth.ts';
import { logEvent } from '../services/events.ts';

/** States emitidos nesta execucao do servidor; protegem o callback contra CSRF. */
const pendingStates = new Map<string, number>();

function issueState() {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  // Limpa states com mais de 10 minutos.
  for (const [key, ts] of pendingStates) {
    if (Date.now() - ts > 10 * 60_000) pendingStates.delete(key);
  }
  return state;
}

export async function registerOauthRoutes(app: FastifyInstance) {
  app.get('/mercadolivre/start', async (_req, reply) => {
    return reply.redirect(authorizeUrl(issueState()));
  });

  app.get('/mercadolivre/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query as Record<string, string | undefined>;

    if (error) {
      logEvent('error', `autorizacao recusada no Mercado Livre: ${desc ?? error}`, { channel: 'mercadolivre' });
      return reply.type('text/html').send(page('Autorizacao recusada', desc ?? error));
    }
    if (!code) return reply.status(400).type('text/html').send(page('Faltou o code', 'Tente conectar novamente.'));
    if (!state || !pendingStates.delete(state)) {
      return reply.status(400).type('text/html').send(page('State invalido', 'Inicie a conexao pelo painel.'));
    }

    const account = await exchangeCode(code);
    logEvent('info', `Mercado Livre conectado como ${account.label}`, { channel: 'mercadolivre' });
    return reply.type('text/html').send(
      page('Mercado Livre conectado', `Conta: ${account.label}. Voce pode fechar esta aba.`),
    );
  });
}

function page(title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Voltar ao painel</a></p>`;
}
