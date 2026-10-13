import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '../src/domain/product.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-loc-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');
process.env.ML_CLIENT_ID = 'app';
process.env.ML_CLIENT_SECRET = 'secret';
process.env.ML_REDIRECT_URI = 'https://exemplo.host/oauth/mercadolivre/callback';

const { resolveLocation, limparCacheLocalizacao, normalizar } = await import('../src/channels/mercadolivre/location.ts');
const { mercadoLivre } = await import('../src/channels/mercadolivre/index.ts');
const { saveAccount } = await import('../src/services/accounts.ts');
after(() => rmSync(sandbox, { recursive: true, force: true }));

// Recorte do que /classified_locations devolve.
const ML: Record<string, unknown> = {
  '/classified_locations/countries/BR': { id: 'BR', name: 'Brasil', states: [
    { id: 'TUxCUFJJT0xmMjNj', name: 'Rio Grande do Sul' }, { id: 'TUxCUFNBT08xMjM', name: 'São Paulo' },
  ] },
  '/classified_locations/states/TUxCUFJJT0xmMjNj': { cities: [
    { id: 'TUxCQ0xBSjY0NjQ', name: 'Lajeado' }, { id: 'TUxCQ1BPUjQ', name: 'Porto Alegre' },
  ] },
  '/classified_locations/states/TUxCUFNBT08xMjM': { cities: [{ id: 'TUxCQ1NBTzU', name: 'São Paulo' }] },
  '/classified_locations/cities/TUxCQ0xBSjY0NjQ': { neighborhoods: [{ id: 'TUxCQkNFTjE', name: 'Centro' }] },
};

let chamadas: Array<{ path: string; body: any }> = [];
const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const raw = init?.body;
  chamadas.push({ path: u.pathname, body: typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw });
  if (u.pathname.includes('domain_discovery')) return Response.json([{ category_id: 'MLB1472' }]);
  if (u.pathname === '/items/validate') return new Response(null, { status: 204 });
  const corpo = ML[u.pathname];
  return corpo ? Response.json(corpo) : Response.json({ message: 'nao simulado' }, { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  chamadas = [];
  limparCacheLocalizacao();
  saveAccount({ channel: 'mercadolivre', accessToken: 'T', refreshToken: 'R',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
});

const imovel = (over: Partial<Product> = {}): Product => ({
  id: 'p1', kind: 'imovel', title: 'Casa 3 quartos no Centro de Lajeado', description: 'x', priceCents: 50000000,
  condition: 'usado', quantity: 1, acceptsTrade: false, cep: '95900-000', city: 'Lajeado', uf: 'RS',
  neighborhood: 'Centro', attrs: { operation: 'venda', propertyType: 'casa' }, channelAttrs: {}, archived: false,
  images: [], createdAt: '', updatedAt: '', ...over,
});

test('nomes comparados sem acento, caixa ou espaco extra', () => {
  assert.equal(normalizar('  SÃO  Paulo '), 'sao paulo');
});

test('Lajeado/RS vira os IDs do ML ate o bairro (o erro era: requires up to city level)', async () => {
  const loc = await resolveLocation(imovel(), 'T');
  assert.deepEqual(loc, {
    address_line: 'Centro, Lajeado',
    zip_code: '95900000',
    country: { id: 'BR', name: 'Brasil' },
    state: { id: 'TUxCUFJJT0xmMjNj', name: 'Rio Grande do Sul' },
    city: { id: 'TUxCQ0xBSjY0NjQ', name: 'Lajeado' },
    neighborhood: { id: 'TUxCQkNFTjE', name: 'Centro' },
  });
});

test('acento e caixa diferentes no cadastro ainda acham a cidade', async () => {
  const loc = await resolveLocation(imovel({ city: 'sao paulo', uf: 'sp', neighborhood: '' }), 'T');
  assert.equal(loc.city.id, 'TUxCQ1NBTzU');
  assert.equal(loc.neighborhood, undefined);
});

test('bairro que o ML nao conhece nao bloqueia: vai ate a cidade', async () => {
  const loc = await resolveLocation(imovel({ neighborhood: 'Bairro Inventado' }), 'T');
  assert.equal(loc.city.name, 'Lajeado');
  assert.equal(loc.neighborhood, undefined);
});

test('cidade inexistente explica o que corrigir', async () => {
  await assert.rejects(resolveLocation(imovel({ city: 'Lajedo' }), 'T'), /cidade "Lajedo" nao encontrada.*RS/);
});

test('sem cidade/UF, pede para preencher', async () => {
  await assert.rejects(resolveLocation(imovel({ city: '', uf: '' }), 'T'), /preencha cidade e UF/);
});

test('o payload do classificado leva a localizacao em IDs', async () => {
  const r = await mercadoLivre.publish({ product: imovel(), dryRun: true });
  assert.equal(r.status, 'rascunho', r.message);
  const enviado = chamadas.find((c) => c.path === '/items/validate')!.body;
  assert.equal(enviado.location.country.id, 'BR');
  assert.equal(enviado.location.state.id, 'TUxCUFJJT0xmMjNj');
  assert.equal(enviado.location.city.id, 'TUxCQ0xBSjY0NjQ');
  // produto comum nao leva location
  const comum = await mercadoLivre.publish({ product: imovel({ kind: 'geral', attrs: {} }), dryRun: true });
  assert.ok(comum.status);
  assert.equal('location' in chamadas.filter((c) => c.path === '/items/validate').at(-1)!.body, false);
});
