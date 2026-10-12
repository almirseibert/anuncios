import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '../src/domain/product.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-mlpub-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');
process.env.ML_CLIENT_ID = 'app';
process.env.ML_CLIENT_SECRET = 'secret';
process.env.ML_REDIRECT_URI = 'https://exemplo.host/oauth/mercadolivre/callback';

const { mercadoLivre } = await import('../src/channels/mercadolivre/index.ts');
const { saveAccount } = await import('../src/services/accounts.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

const produto: Product = {
  id: 'p1', kind: 'geral', title: 'Playstation 4 Slim 1TB com 2 controles',
  description: 'Console conservado, sempre em casa.', priceCents: 120000, condition: 'usado',
  quantity: 1, acceptsTrade: false, cep: '90000000', city: 'Porto Alegre', uf: 'RS',
  neighborhood: 'Centro', attrs: { brand: 'Sony', model: 'PS4 Slim' }, archived: false,
  images: [{
    id: 'i1', filename: 'a.jpg', mime: 'image/jpeg', position: 0, url: 'https://exemplo.com/a.jpg',
    width: 1600, height: 1200, origin: 'upload', sourceUrl: '', sourceLabel: '', originalFilename: '',
  }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

let chamadas: Array<{ method: string; url: string; body: unknown }> = [];
const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });

/** Finge a API do ML: `responder` decide o que cada rota devolve. */
function stubMl(responder: (url: string) => { status: number; body?: unknown }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body;
    chamadas.push({
      method: init?.method ?? 'GET',
      url,
      body: typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw,
    });
    const r = responder(url);
    // 204 nao pode carregar corpo nenhum: tem de ser null, nem string vazia.
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  saveAccount({
    channel: 'mercadolivre',
    label: 'VENDEDOR',
    accessToken: 'TOKEN',
    refreshToken: 'REFRESH',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});

test('em dry-run com a conta conectada, quem valida e o proprio Mercado Livre', async () => {
  stubMl((url) => url.includes('domain_discovery')
    ? { status: 200, body: [{ category_id: 'MLB1144' }] }
    : { status: 204 });

  const r = await mercadoLivre.publish({ product: produto, dryRun: true });

  assert.equal(r.status, 'rascunho');
  assert.match(r.message!, /validou/);
  const rotas = chamadas.map((c) => c.method + ' ' + new URL(c.url).pathname);
  assert.ok(rotas.includes('POST /items/validate'), rotas.join(' | '));
  // validar nao pode criar anuncio nenhum
  assert.equal(rotas.includes('POST /items'), false);
});

test('quando o ML recusa em dry-run, o erro dele chega inteiro ao painel', async () => {
  stubMl((url) => {
    if (url.includes('domain_discovery')) return { status: 200, body: [{ category_id: 'MLB1144' }] };
    return {
      status: 400,
      body: { message: 'body.invalid_fields', error: 'validation_error', cause: [{ code: 'item.title.invalid' }] },
    };
  });

  const r = await mercadoLivre.publish({ product: produto, dryRun: true });

  assert.equal(r.status, 'erro');
  assert.match(r.message!, /recusaria/);
  assert.match(r.message!, /body\.invalid_fields/);
  assert.deepEqual((r.result as { cause: unknown[] }).cause, [{ code: 'item.title.invalid' }]);
});

test('publicando de verdade, a descricao vai numa chamada propria depois do item', async () => {
  stubMl((url) => {
    if (url.includes('domain_discovery')) return { status: 200, body: [{ category_id: 'MLB1144' }] };
    if (url.endsWith('/items')) return { status: 201, body: { id: 'MLB123', permalink: 'https://ml/MLB123' } };
    return { status: 201, body: { id: 'MLB123-desc' } };
  });

  const r = await mercadoLivre.publish({ product: produto, dryRun: false });

  assert.equal(r.status, 'publicado');
  assert.equal(r.externalId, 'MLB123');
  const rotas = chamadas.map((c) => c.method + ' ' + new URL(c.url).pathname);
  assert.deepEqual(rotas.slice(-2), ['POST /items', 'POST /items/MLB123/description']);

  const criacao = chamadas.find((c) => new URL(c.url).pathname === '/items')!;
  const corpo = criacao.body as Record<string, unknown>;
  assert.equal('description' in corpo, false, 'o ML recusa description no corpo do item');
  assert.equal('title' in corpo, false, 'o ML recusa title quando vai family_name');
  assert.equal(corpo.family_name, 'Sony PS4 Slim');

  const descricao = chamadas.at(-1)!.body as { plain_text: string };
  assert.match(descricao.plain_text, /Console conservado/);
});

test('se so a descricao falhar, o anuncio criado nao se perde e o aviso aparece', async () => {
  stubMl((url) => {
    if (url.includes('domain_discovery')) return { status: 200, body: [{ category_id: 'MLB1144' }] };
    if (url.endsWith('/items')) return { status: 201, body: { id: 'MLB999', permalink: 'https://ml/MLB999' } };
    return { status: 400, body: { message: 'The description must be in plain text' } };
  });

  const r = await mercadoLivre.publish({ product: produto, dryRun: false });

  assert.equal(r.status, 'publicado');
  assert.equal(r.externalId, 'MLB999');
  assert.match(r.message!, /descricao nao subiu/);
  assert.match(r.message!, /plain text/);
});
