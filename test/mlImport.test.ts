import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-imp-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');
process.env.ML_CLIENT_ID = 'app';
process.env.ML_CLIENT_SECRET = 'secret';
process.env.ML_REDIRECT_URI = 'https://exemplo.host/oauth/mercadolivre/callback';
mkdirSync(join(sandbox, 'uploads', 'originals'), { recursive: true });

const { draftFromItem } = await import('../src/channels/mercadolivre/importer.ts');
const { importFromMercadoLivre } = await import('../src/services/mlImport.ts');
const { saveAccount } = await import('../src/services/accounts.ts');
const { getProduct, listProducts } = await import('../src/services/products.ts');
const { getListing, publishToChannel } = await import('../src/services/publish.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#357' } }).jpeg().toBuffer();

// Recorte de um item real do ML (GET /items?ids=...).
const ps4 = {
  id: 'MLB111', title: 'Playstation 4 Slim 500gb 2 Controles', category_id: 'MLB11172', price: 1500,
  available_quantity: 1, sold_quantity: 0, condition: 'used', status: 'paused',
  permalink: 'https://produto.mercadolivre.com.br/MLB-111', listing_type_id: 'gold_special',
  date_created: '2025-03-01T10:00:00.000Z',
  pictures: [{ secure_url: 'https://http2.mlstatic.com/D_NQ_1-F.jpg' }, { secure_url: 'https://http2.mlstatic.com/D_NQ_2-F.jpg' }],
  attributes: [
    { id: 'BRAND', value_name: 'Sony' }, { id: 'MODEL', value_name: 'PS4 Slim' },
    { id: 'GTIN', value_name: '0711719541028' }, { id: 'ITEM_CONDITION', value_id: '2230581', value_name: 'Usado' },
    { id: 'VOLTAGE', value_id: '3', value_name: 'Bivolt' }, { id: 'COLOR', value_id: null, value_name: null },
  ],
  sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }, { id: 'WARRANTY_TIME', value_name: '30 dias' }],
  seller_address: { city: { name: 'Porto Alegre' }, state: { id: 'BR-RS' }, zip_code: '90000-000' },
};
const fogao = { ...ps4, id: 'MLB222', title: 'Fogao 4 bocas', status: 'closed', pictures: [],
  attributes: [{ id: 'BRAND', value_name: 'Brastemp' }] };
const carro = { ...ps4, id: 'MLB333', title: 'Gol 2010', status: 'active',
  attributes: [{ id: 'VEHICLE_YEAR', value_name: '2010' }] };

test('item do ML vira produto com marca, modelo, codigo, garantia e atributos da categoria', () => {
  const d = draftFromItem(ps4, 'Console conservado.');
  assert.ok(!('pulado' in d));
  assert.equal(d.input.title, 'Playstation 4 Slim 500gb 2 Controles');
  assert.equal(d.input.priceCents, 150000);
  assert.equal(d.input.condition, 'usado');
  assert.equal(d.input.description, 'Console conservado.');
  assert.equal(d.input.uf, 'RS');
  assert.deepEqual(
    { ...d.input.attrs },
    { brand: 'Sony', model: 'PS4 Slim', wear: 'bom', warranty: '30 dias', gtin: '0711719541028', gtinMissingReason: '' },
  );
  // VOLTAGE vai para o painel do ML; marca/modelo/codigo/condicao ja tem campo; vazio nao entra
  assert.deepEqual(d.mlAttributes, { VOLTAGE: { value_id: '3', value_name: 'Bivolt' } });
  assert.equal(d.categoryId, 'MLB11172');
  assert.deepEqual(d.pictureUrls[0], ['https://http2.mlstatic.com/D_NQ_1-O.jpg', 'https://http2.mlstatic.com/D_NQ_1-F.jpg']);
  assert.deepEqual(d.listing, { status: 'pausado', externalId: 'MLB111', permalink: ps4.permalink, publishedAt: ps4.date_created });
});

test('codigo de barras invalido no ML nao impede a importacao', () => {
  const d = draftFromItem({ ...ps4, attributes: [{ id: 'GTIN', value_name: '123' }] }, '');
  assert.ok(!('pulado' in d));
  assert.equal((d.input.attrs as Record<string, unknown>).gtin, '');
});

test('veiculo fica de fora, com o motivo', () => {
  const d = draftFromItem(carro, '');
  assert.ok('pulado' in d && /veiculo/.test(d.pulado));
});

// ---- ML falso ----

let chamadas: Array<{ method: string; url: URL; body: any }> = [];
let rotas: Record<string, (u: URL, body: any) => { status: number; body?: unknown }> = {};
const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const raw = init?.body;
  const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw;
  const method = init?.method ?? 'GET';
  chamadas.push({ method, url, body });
  if (url.host === 'http2.mlstatic.com') {
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  const chave = `${method} ${url.pathname}`;
  const r = rotas[chave]?.(url, body) ?? { status: 404, body: { message: `nao simulado: ${chave}` } };
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
    status: r.status, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

beforeEach(() => {
  chamadas = [];
  saveAccount({ channel: 'mercadolivre', label: 'V', accessToken: 'T', refreshToken: 'R',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), meta: { userId: 42 } });
  const porStatus: Record<string, string[]> = { active: ['MLB333'], paused: ['MLB111'], closed: ['MLB222'] };
  const itens: Record<string, unknown> = { MLB111: ps4, MLB222: fogao, MLB333: carro };
  rotas = {
    'GET /users/42/items/search': (u) => {
      const r = porStatus[u.searchParams.get('status')!] ?? [];
      return { status: 200, body: { results: r, paging: { total: r.length } } };
    },
    'GET /items': (u) => ({ status: 200, body: u.searchParams.get('ids')!.split(',').map((id) => ({ code: 200, body: itens[id] })) }),
    'GET /items/MLB111/description': () => ({ status: 200, body: { plain_text: 'Console conservado.' } }),
    'GET /items/MLB222/description': () => ({ status: 404, body: { message: 'not found' } }),
  };
});

test('importa ativos, pausados e encerrados; fotos tratadas; rodar de novo nao duplica', async () => {
  const r = await importFromMercadoLivre();
  assert.equal(r.encontrados, 3);
  assert.deepEqual(r.importados.map((i) => i.externalId).sort(), ['MLB111', 'MLB222']);
  assert.deepEqual(r.pulados.map((p) => p.externalId), ['MLB333']);

  const imp = r.importados.find((i) => i.externalId === 'MLB111')!;
  assert.equal(imp.fotos, 2);
  const produto = getProduct(imp.productId)!;
  assert.equal(produto.images.length, 2);
  assert.equal(produto.images[0]!.origin, 'url', 'foto do proprio anuncio e foto sua: pode ser capa');
  assert.equal(produto.images[0]!.width, 1200);
  assert.deepEqual(produto.channelAttrs.mercadolivre?.attributes.VOLTAGE, { value_id: '3', value_name: 'Bivolt' });
  const listing = getListing(imp.productId, 'mercadolivre')!;
  assert.equal(listing.externalId, 'MLB111');
  assert.equal(listing.status, 'pausado');
  // os tres status foram pedidos
  const status = chamadas.filter((c) => c.url.pathname.endsWith('/items/search')).map((c) => c.url.searchParams.get('status'));
  assert.deepEqual(status, ['active', 'paused', 'closed']);

  const total = listProducts().length;
  const deNovo = await importFromMercadoLivre();
  assert.equal(deNovo.importados.length, 0);
  assert.equal(deNovo.jaImportados, 2);
  assert.equal(listProducts().length, total);
});

const importado = (externalId: string) =>
  listProducts().find((p) => getListing(p.id, 'mercadolivre')?.externalId === externalId)!;

test('publicar um importado atualiza o MESMO anuncio (PUT), descricao incluida, e reativa o pausado', async () => {
  rotas['GET /items/MLB111'] = () => ({ status: 200, body: ps4 });
  rotas['PUT /items/MLB111'] = () => ({ status: 200, body: { id: 'MLB111' } });
  rotas['PUT /items/MLB111/description'] = () => ({ status: 200, body: {} });
  const p = importado('MLB111');

  const r = await publishToChannel(p.id, 'mercadolivre', { dryRun: false });

  assert.equal(r.status, 'publicado', r.message);
  assert.equal(r.externalId, 'MLB111');
  const rotasChamadas = chamadas.map((c) => `${c.method} ${c.url.pathname}`);
  assert.equal(rotasChamadas.includes('POST /items'), false, 'nao pode criar anuncio novo');
  const puts = chamadas.filter((c) => c.method === 'PUT' && c.url.pathname === '/items/MLB111');
  assert.equal(puts[0]!.body.price, 1500);
  assert.equal(puts[0]!.body.title, 'Playstation 4 Slim 500gb 2 Controles', 'sem vendas, o titulo pode mudar');
  assert.equal(puts[0]!.body.pictures.length, 2);
  assert.ok(puts[0]!.body.attributes.some((a: { id: string }) => a.id === 'VOLTAGE'));
  assert.deepEqual(puts.at(-1)!.body, { status: 'active' });
  assert.match(r.message!, /voltou a ficar ativo/);
  assert.ok(rotasChamadas.includes('PUT /items/MLB111/description'));
  assert.equal(getListing(p.id, 'mercadolivre')!.status, 'publicado');
});

test('anuncio com venda nao tenta trocar o titulo', async () => {
  rotas['GET /items/MLB111'] = () => ({ status: 200, body: { ...ps4, status: 'active', sold_quantity: 1 } });
  rotas['PUT /items/MLB111'] = () => ({ status: 200, body: {} });
  rotas['PUT /items/MLB111/description'] = () => ({ status: 200, body: {} });
  await publishToChannel(importado('MLB111').id, 'mercadolivre', { dryRun: false });
  const put = chamadas.find((c) => c.method === 'PUT' && c.url.pathname === '/items/MLB111')!;
  assert.equal('title' in put.body, false);
});

test('se o ML recusar atributo/titulo, preco e fotos sobem assim mesmo, com aviso', async () => {
  rotas['GET /items/MLB111'] = () => ({ status: 200, body: { ...ps4, status: 'active' } });
  rotas['PUT /items/MLB111'] = (_u, body) => body.attributes
    ? { status: 400, body: { message: 'attribute VOLTAGE is not modifiable' } }
    : { status: 200, body: {} };
  rotas['PUT /items/MLB111/description'] = () => ({ status: 200, body: {} });
  const r = await publishToChannel(importado('MLB111').id, 'mercadolivre', { dryRun: false });
  assert.equal(r.status, 'publicado');
  assert.match(r.message!, /nao aceitou mudar titulo\/atributos/);
});

test('encerrado volta pelo relist e a atualizacao segue no numero novo', async () => {
  rotas['GET /items/MLB222'] = () => ({ status: 200, body: fogao });
  rotas['POST /items/MLB222/relist'] = () => ({ status: 201, body: { id: 'MLB999', permalink: 'https://ml/MLB999' } });
  rotas['PUT /items/MLB999'] = () => ({ status: 200, body: {} });
  rotas['PUT /items/MLB999/description'] = () => ({ status: 200, body: {} });
  const p = importado('MLB222');

  const r = await publishToChannel(p.id, 'mercadolivre', { dryRun: false, force: true }); // sem foto: forca

  assert.equal(r.status, 'publicado', r.message);
  assert.equal(r.externalId, 'MLB999');
  assert.match(r.message!, /republicou com o numero MLB999/);
  const relist = chamadas.find((c) => c.url.pathname === '/items/MLB222/relist')!;
  assert.deepEqual(relist.body, { price: 1500, quantity: 1, listing_type_id: 'gold_special' });
  assert.equal(getListing(p.id, 'mercadolivre')!.externalId, 'MLB999');
});
