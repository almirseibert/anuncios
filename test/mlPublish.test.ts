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
  neighborhood: 'Centro', attrs: { brand: 'Sony', model: 'PS4 Slim' }, channelAttrs: {}, archived: false,
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

// ---- pre-checagem: envio, tipo de anuncio, conta e atributos -------------

const { chooseListingType, chooseShipping } = await import('../src/channels/mercadolivre/preflight.ts');

/** ML falso de uma conta comum: me2 ativo, tudo liberado. `over` troca rotas pelo final do caminho. */
function contaMl(over: Record<string, { status: number; body?: unknown }> = {}) {
  const rotas: Record<string, { status: number; body?: unknown }> = {
    '/domain_discovery/search': { status: 200, body: [{ category_id: 'MLB11172' }] },
    '/users/me': { status: 200, body: { id: 42, status: { list: { allow: true, codes: [] }, sell: { allow: true, codes: [] } } } },
    '/users/42/shipping_preferences': { status: 200, body: { modes: ['custom', 'not_specified', 'me2'], local_pick_up: true } },
    '/users/42/available_listing_types': { status: 200, body: { available: [{ id: 'gold_special' }, { id: 'free' }] } },
    '/categories/MLB11172/attributes': { status: 200, body: [] },
    '/items/validate': { status: 204 },
    ...over,
  };
  stubMl((url) => {
    const path = new URL(url).pathname;
    const chave = Object.keys(rotas).find((k) => path.endsWith(k));
    return chave ? rotas[chave]! : { status: 404, body: { message: 'rota nao simulada ' + path } };
  });
}

const enviadoAoValidate = () =>
  chamadas.find((c) => new URL(c.url).pathname === '/items/validate')!.body as Record<string, any>;

test('o anuncio vai com o envio da conta (me2) -- sem ele o ML caiu no me1 e recusou', async () => {
  contaMl();
  const r = await mercadoLivre.publish({ product: produto, dryRun: true });

  assert.equal(r.status, 'rascunho', r.message);
  const corpo = enviadoAoValidate();
  assert.deepEqual(corpo.shipping, { mode: 'me2', local_pick_up: true, free_shipping: true, free_methods: [] });
  assert.equal(corpo.listing_type_id, 'gold_special');
  // R$ 1.200: acima de R$ 79 o frete gratis e obrigatorio, e o vendedor e avisado do custo
  assert.match(r.message!, /frete gratis/);
});

test('produto barato no me2 nao promete frete gratis', async () => {
  contaMl();
  await mercadoLivre.publish({ product: { ...produto, priceCents: 5000 }, dryRun: true });
  assert.equal(enviadoAoValidate().shipping.free_shipping, false);
});

test('conta sem Mercado Envios: frete a combinar, com aviso de como ativar', async () => {
  contaMl({ '/users/42/shipping_preferences': { status: 200, body: { modes: ['custom', 'not_specified'] } } });
  const r = await mercadoLivre.publish({ product: produto, dryRun: true });

  assert.deepEqual(enviadoAoValidate().shipping, { mode: 'not_specified', local_pick_up: true, free_shipping: false });
  assert.match(r.message!, /nao tem Mercado Envios/);
});

test('se nao der para ler as preferencias de envio, vai me2 (o que quase toda conta tem)', async () => {
  contaMl({ '/users/42/shipping_preferences': { status: 500, body: { message: 'boom' } } });
  const r = await mercadoLivre.publish({ product: produto, dryRun: true });
  assert.equal(r.status, 'rascunho');
  assert.equal(enviadoAoValidate().shipping.mode, 'me2');
});

test('a recusa real do ML (lost_me1_by_user) chega traduzida', async () => {
  contaMl({
    '/items/validate': {
      status: 400,
      body: {
        cause: [{ department: 'shipping', cause_id: 4053, type: 'warning', code: 'shipping.lost_me1_by_user',
          references: ['user.shipping_preferences.modes'], message: 'User has not mode me1' }],
        message: 'Validation error', error: 'validation_error', status: 400,
      },
    },
  });
  const r = await mercadoLivre.publish({ product: produto, dryRun: true });
  assert.equal(r.status, 'erro');
  assert.match(r.message!, /^o Mercado Livre recusaria este anuncio: O ML tentou usar um modo de envio \(me1\)/);
  assert.match(r.message!, /User has not mode me1/);
});

test('tudo o que falta aparece de uma vez: conta, atributo da categoria e o erro do ML', async () => {
  contaMl({
    '/users/me': { status: 200, body: { id: 42, status: { list: { allow: false, codes: ['address_pending'] } } } },
    '/categories/MLB11172/attributes': { status: 200, body: [
      { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
      { id: 'VOLTAGE', name: 'Voltagem', value_type: 'list', tags: { required: true } },
      { id: 'COLOR', name: 'Cor', value_type: 'string', tags: {} },
    ] },
    '/items/validate': { status: 400, body: { message: 'Validation error', cause: [
      { code: 'item.attributes.missing_required', message: 'The attributes [VOLTAGE] are required' },
      { code: 'item.price.invalid', message: 'price too low' },
    ] } },
  });
  const r = await mercadoLivre.publish({ product: produto, dryRun: true });

  assert.equal(r.status, 'erro');
  assert.match(r.message!, /\(1\) O ML nao deixa esta conta anunciar \(endereco pendente\)/);
  assert.match(r.message!, /\(2\) Em "Editar" no produto, preencha em "Atributos do Mercado Livre": Voltagem\./);
  assert.match(r.message!, /preco nao foi aceito/);
  // VOLTAGE ja foi cobrado pela pre-checagem: nao repete com o id cru
  assert.equal(/preencha: VOLTAGE/.test(r.message!), false, r.message);
  // BRAND ja vem do cadastro (Sony): nao e cobrado
  assert.equal(/Marca/.test(r.message!), false);
});

test('publicacao real tambem leva o envio escolhido', async () => {
  contaMl({
    '/items': { status: 201, body: { id: 'MLB777', permalink: 'https://ml/MLB777' } },
    '/items/MLB777/description': { status: 201, body: {} },
  });
  const r = await mercadoLivre.publish({ product: produto, dryRun: false });
  assert.equal(r.status, 'publicado', r.message);
  const criacao = chamadas.find((c) => new URL(c.url).pathname === '/items')!.body as Record<string, any>;
  assert.equal(criacao.shipping.mode, 'me2');
});

test('tipo de anuncio indisponivel na conta: cai no melhor disponivel e avisa', () => {
  assert.deepEqual(chooseListingType('gold_special', undefined), { id: 'gold_special' });
  assert.deepEqual(chooseListingType('gold_special', ['gold_special', 'free']), { id: 'gold_special' });
  const r = chooseListingType('gold_special', ['free', 'gold_pro']);
  assert.equal(r.id, 'gold_pro');
  assert.match(r.aviso!, /nao esta disponivel/);
});

test('veiculo e imovel nao levam shipping', () => {
  const r = chooseShipping({ ...produto, kind: 'veiculo' }, { modes: ['me2'] });
  assert.equal(r.shipping, undefined);
});

test('conta sem nenhum modo utilizavel e bloqueio explicado', () => {
  const r = chooseShipping(produto, { modes: ['me1'] });
  assert.equal(r.shipping, undefined);
  assert.match(r.problemas[0]!, /Ative o Mercado Envios/);
});

test('motivo "sem codigo" recusado pelo ML: a mensagem diz que o codigo e obrigatorio aqui', async () => {
  contaMl({
    '/items/validate': { status: 400, body: { message: 'Validation error', cause: [{
      department: 'supply', cause_id: 7810, type: 'error', code: 'item.attribute.missing_conditional_required',
      references: ['item.attributes'],
      message: 'The attributes [GTIN] are required for category [MLB118902]. Check the attribute is present in the attributes list',
    }] } },
  });
  const comMotivo = { ...produto, attrs: { ...produto.attrs, gtin: '', gtinMissingReason: 'nao_registrado' } };
  const r = await mercadoLivre.publish({ product: comMotivo, dryRun: true });
  assert.equal(r.status, 'erro');
  assert.match(r.message!, /nao aceita "sem codigo de barras" nesta categoria/);
  assert.match(r.message!, /Procurar no catalogo do ML/);

  // sem motivo declarado, so a instrucao normal
  const semMotivo = await mercadoLivre.publish({ product: produto, dryRun: true });
  assert.equal(/nao aceita "sem codigo/.test(semMotivo.message!), false);
  assert.match(semMotivo.message!, /Código de barras \(EAN\)/);
});
