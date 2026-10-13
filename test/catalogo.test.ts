import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-cat-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { catalogQuery, rankCatalog, searchCatalog } = await import('../src/channels/mercadolivre/catalog.ts');
const { saveAccount } = await import('../src/services/accounts.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

// O que o catalogo devolveu em producao para o titulo inteiro do PS4.
const ventoinhas = Array.from({ length: 6 }, (_, i) => ({
  id: `MLB-FAN${i}`, name: 'Ventilador Interno de Substituição Compatível com Ps4 500gb',
}));
const ps4 = { id: 'MLB-PS4', name: 'Sony PlayStation 4 Slim 500GB Standard cor preto onyx' };

test('a busca usa marca + modelo, nao o titulo cheio do que acompanha o item', () => {
  const titulo = 'PS4 500GB CUH-22115A 2 Controles, Suporte e Jogos';
  assert.equal(catalogQuery({ title: titulo, attrs: { brand: 'Sony', model: 'PlayStation 4 Slim 500GB' } }),
    'Sony PlayStation 4 Slim 500GB');
  // sem modelo: so o comeco do titulo, antes do que vem "junto"
  assert.equal(catalogQuery({ title: titulo, attrs: { brand: 'Sony' } }), 'Sony PS4 500GB CUH-22115A 2 Controles');
  assert.equal(catalogQuery({ title: 'Geladeira Brastemp 375L com freezer', attrs: {} }), 'Geladeira Brastemp 375L');
});

test('peca "compativel com" sai do resultado; o produto fica', () => {
  const r = rankCatalog('Sony PS4 500GB', [...ventoinhas, ps4]);
  assert.deepEqual(r.map((x) => x.id), ['MLB-PS4']);
});

test('acessorio no comeco do nome sai, mas palavra de acessorio no meio nao derruba o produto', () => {
  const r = rankCatalog('Dell Inspiron 15', [
    { id: 'capa', name: 'Capa Para Notebook Dell Inspiron 15' },
    { id: 'note', name: 'Notebook Dell Inspiron 15 3520 Tela 15,6 8GB' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['note']);
});

test('quando a busca pede o acessorio, ele nao e filtrado', () => {
  const r = rankCatalog('Controle DualShock 4 PS4', [{ id: 'ds4', name: 'Controle Sony DualShock 4 Preto' }]);
  assert.equal(r.length, 1);
});

test('mais palavras em comum vem primeiro', () => {
  const r = rankCatalog('Sony PlayStation 4 Slim 1TB', [
    { id: 'pro', name: 'Sony PlayStation 4 Pro 1TB' },
    { id: 'slim', name: 'Sony PlayStation 4 Slim 1TB Standard' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['slim', 'pro']);
});

// ---- fluxo contra um ML falso ----

let chamadas: URL[] = [];
const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });

function stub(responder: (u: URL) => unknown) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    chamadas.push(u);
    return new Response(JSON.stringify(responder(u)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  saveAccount({ channel: 'mercadolivre', accessToken: 'T', refreshToken: 'R',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
});

test('com codigo de barras, busca pelo codigo e acha o modelo exato', async () => {
  stub((u) => u.searchParams.get('product_identifier') ? { results: [ps4] } : { results: ventoinhas });
  const r = await searchCatalog({ title: 'PS4', attrs: { brand: 'Sony', model: 'PS4', gtin: '0711719541028' } });
  assert.deepEqual(r.map((x) => x.id), ['MLB-PS4']);
  assert.equal(chamadas.length, 1);
});

test('sem codigo, busca dentro do dominio do produto e filtra pecas', async () => {
  stub((u) => {
    if (u.pathname.includes('domain_discovery')) return [{ domain_id: 'MLB-GAME_CONSOLES', category_id: 'MLB11172' }];
    return { results: u.searchParams.get('domain_id') ? [ps4] : [...ventoinhas, ps4] };
  });
  const r = await searchCatalog({ title: 'PS4 500GB CUH-22115A 2 Controles, Suporte e Jogos', attrs: { brand: 'Sony', model: 'PS4 500GB' } });
  assert.deepEqual(r.map((x) => x.id), ['MLB-PS4']);
  const busca = chamadas.find((u) => u.pathname === '/products/search')!;
  assert.equal(busca.searchParams.get('q'), 'Sony PS4 500GB');
  assert.equal(busca.searchParams.get('domain_id'), 'MLB-GAME_CONSOLES');
});

test('se o dominio nao achar nada, tenta sem dominio (ainda filtrando pecas)', async () => {
  stub((u) => {
    if (u.pathname.includes('domain_discovery')) return [{ domain_id: 'MLB-X' }];
    return { results: u.searchParams.get('domain_id') ? [] : [...ventoinhas, ps4] };
  });
  const r = await searchCatalog({ title: 'PS4', attrs: { brand: 'Sony', model: 'PS4 500GB' } });
  assert.deepEqual(r.map((x) => x.id), ['MLB-PS4']);
});

test('codigo de barras do catalogo: so sugere produtos que tem GTIN, sem pecas, com todos os codigos', async () => {
  const { findGtinCandidates } = await import('../src/channels/mercadolivre/catalog.ts');
  stub((u) => {
    if (u.pathname.includes('domain_discovery')) return [{ domain_id: 'MLB-GAME_CONSOLES' }];
    if (u.pathname === '/products/search') return { results: [...ventoinhas, ps4, { id: 'MLB-SEM', name: 'Sony PS4 500GB Mega Pack' }] };
    if (u.pathname === '/products/MLB-PS4') {
      return { id: 'MLB-PS4', name: ps4.name, permalink: '', pictures: [{ url: 'https://x/p.jpg' }],
        attributes: [{ id: 'GTIN', value_name: '0711719541028,711719541028', values: [{ name: '0711719541028' }] }] };
    }
    return { id: 'MLB-SEM', name: 'Sem codigo', attributes: [{ id: 'BRAND', value_name: 'Sony' }] };
  });
  const r = await findGtinCandidates({ title: 'PS4', attrs: { brand: 'Sony', model: 'PS4 500GB' } });
  assert.deepEqual(r, [{
    productId: 'MLB-PS4', name: ps4.name, gtins: ['0711719541028', '711719541028'],
    picture: 'https://x/p.jpg', permalink: 'https://www.mercadolivre.com.br/p/MLB-PS4',
  }]);
  // a busca ignora o GTIN do cadastro (e justamente o que se procura)
  assert.equal(chamadas.some((u) => u.searchParams.has('product_identifier')), false);
});
