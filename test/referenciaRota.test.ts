import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-refrota-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');
mkdirSync(join(sandbox, 'uploads', 'originals'), { recursive: true });

const { default: Fastify } = await import('fastify');
const { registerApiRoutes } = await import('../src/routes/api.ts');
const { createProduct, getProduct } = await import('../src/services/products.ts');

const app = Fastify({ logger: false });
await app.register(registerApiRoutes, { prefix: '/api' });
after(async () => { await app.close(); rmSync(sandbox, { recursive: true, force: true }); });

const jpeg = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#fff' } }).jpeg().toBuffer();
const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });
// CDN do ML falsa: "quebrada" responde 404 em todas as variantes
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  return url.includes('quebrada')
    ? new Response('nao achei', { status: 404, headers: { 'content-type': 'text/plain' } })
    : new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}) as typeof fetch;

const novo = () => createProduct({
  kind: 'geral', title: 'Playstation 4 Slim 500GB', description: '', priceCents: 100000, condition: 'usado',
  quantity: 1, acceptsTrade: false, cep: '', city: '', uf: '', neighborhood: '',
  attrs: { brand: 'Sony', model: 'PS4', wear: 'bom', warranty: '', gtin: '', gtinMissingReason: '' },
});

test('as 12 candidatas do painel, com permalink vazio, entram (era o 400)', async () => {
  const p = novo();
  const images = Array.from({ length: 12 }, (_, i) => ({
    url: `https://http2.mlstatic.com/D_NQ_${i}-F.jpg`, label: 'Sony PlayStation 4 Slim', sourceUrl: '',
  }));
  const res = await app.inject({ method: 'POST', url: `/api/products/${p.id}/reference-images`, payload: { images } });
  assert.equal(res.statusCode, 201, res.body);
  const fotos = getProduct(p.id)!.images;
  assert.equal(fotos.length, 12);
  assert.ok(fotos.every((f) => f.origin === 'catalogo'));
  // sem procedencia valida, guarda a propria URL da imagem
  assert.match(fotos[0]!.sourceUrl, /^https:\/\/http2\.mlstatic\.com\//);
});

test('uma foto que nao baixa nao derruba as outras, e a falha volta para o painel', async () => {
  const p = novo();
  const res = await app.inject({
    method: 'POST', url: `/api/products/${p.id}/reference-images`,
    payload: { images: [{ url: 'https://http2.mlstatic.com/boa-F.jpg' }, { url: 'https://http2.mlstatic.com/quebrada-F.jpg' }] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const corpo = res.json();
  assert.equal(corpo.adicionadas, 1);
  assert.equal(corpo.falhas.length, 1);
  assert.match(corpo.falhas[0].error, /404/);
});

test('se nenhuma baixar, a resposta diz o motivo', async () => {
  const p = novo();
  const res = await app.inject({
    method: 'POST', url: `/api/products/${p.id}/reference-images`,
    payload: { images: [{ url: 'https://http2.mlstatic.com/quebrada-F.jpg' }] },
  });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /nenhuma foto do catalogo pode ser baixada: .*404/);
  assert.equal(getProduct(p.id)!.images.length, 0);
});
