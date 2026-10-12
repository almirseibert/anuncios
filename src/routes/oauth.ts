import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authorizeUrl, exchangeCode, newPkcePair } from '../channels/mercadolivre/auth.ts';
import { logEvent } from '../services/events.ts';

/**
 * Autorizacoes comecadas nesta execucao do servidor. O state protege o callback
 * contra CSRF; o verifier do PKCE fica guardado aqui, so no servidor, e e
 * consumido na troca do code pelo token.
 */
interface Pending {
  verifier: string;
  startedAt: number;
}
const pending = new Map<string, Pending>();

const TTL_MS = 10 * 60_000;

function issueState() {
  const state = randomBytes(16).toString('hex');
  const { verifier, challenge } = newPkcePair();
  pending.set(state, { verifier, startedAt: Date.now() });
  for (const [key, p] of pending) {
    if (Date.now() - p.startedAt > TTL_MS) pending.delete(key);
  }
  return { state, challenge };
}

export async function registerOauthRoutes(app: FastifyInstance) {
  app.get('/mercadolivre/start', async (_req, reply) => {
    const { state, challenge } = issueState();
    return reply.redirect(authorizeUrl(state, challenge));
  });

  app.get('/mercadolivre/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query as Record<string, string | undefined>;

    if (error) {
      logEvent('error', `autorizacao recusada no Mercado Livre: ${desc ?? error}`, { channel: 'mercadolivre' });
      return reply.type('text/html').send(page('Autorizacao recusada', desc ?? error));
    }
    if (!code) return reply.status(400).type('text/html').send(page('Faltou o code', 'Tente conectar novamente.'));

    const started = state ? pending.get(state) : undefined;
    if (!state || !started) {
      return reply.status(400).type('text/html').send(page(
        'Autorizacao expirada',
        'Inicie a conexao pelo painel. Se o servidor reiniciou no meio do processo (um Deploy, por exemplo), '
        + 'clique em Conectar de novo.',
      ));
    }
    pending.delete(state);

    const account = await exchangeCode(code, started.verifier);
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
