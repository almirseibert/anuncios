import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '../src/domain/product.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-ml-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { buildItem, familyName } = await import('../src/channels/mercadolivre/map.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

function produto(over: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    kind: 'geral',
    title: 'Playstation 4 Slim 1TB com 2 controles, pouco uso',
    description: 'Console conservado, sempre em casa.',
    priceCents: 120000,
    condition: 'usado',
    quantity: 1,
    acceptsTrade: false,
    cep: '90000000',
    city: 'Porto Alegre',
    uf: 'RS',
    neighborhood: 'Centro',
    attrs: { brand: 'Sony', model: 'Playstation 4 Slim' },
    archived: false,
    images: [{
      id: 'i1', filename: 'a.jpg', mime: 'image/jpeg', position: 0, url: 'https://exemplo.com/a.jpg',
      width: 1600, height: 1200, origin: 'upload', sourceUrl: '', sourceLabel: '', originalFilename: '',
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('produto vai com family_name e SEM title: o ML recusa os dois juntos', () => {
  const item = buildItem(produto(), 'MLB1144');
  assert.equal(item.family_name, 'Sony Playstation 4 Slim');
  assert.equal(item.title, undefined, 'title e invalido no modelo de produto do ML');
  assert.equal(item.buying_mode, 'buy_it_now');
});

test('classificado vai com title e SEM family_name: modelo antigo do ML', () => {
  const item = buildItem(produto({
    kind: 'veiculo',
    title: 'Fiat Argo Drive 1.3 2021 completo, unico dono',
    attrs: { brand: 'Fiat', model: 'Argo' },
  }), 'MLB1744');
  assert.equal(item.title, 'Fiat Argo Drive 1.3 2021 completo, unico dono');
  assert.equal(item.family_name, undefined);
  assert.equal(item.buying_mode, 'classified');
});

test('o titulo do classificado e cortado em 60 caracteres', () => {
  const item = buildItem(produto({
    kind: 'imovel',
    title: 'Apartamento de 2 dormitorios com suite, vaga coberta e sacada no centro historico',
    attrs: { propertyType: 'apartamento' },
  }), 'MLB1459');
  assert.equal(item.title!.length, 60);
});

test('family_name usa marca e modelo; sem eles, cai no titulo', () => {
  assert.equal(familyName(produto({ attrs: { brand: 'Sony', model: 'PS4 Slim' } })), 'Sony PS4 Slim');
  assert.equal(familyName(produto({ attrs: { brand: 'Sony', model: '' } })), 'Sony');
  assert.equal(
    familyName(produto({ attrs: {} })),
    'Playstation 4 Slim 1TB com 2 controles, pouco uso',
  );
});

test('family_name de veiculo junta marca, modelo e versao', () => {
  const v = produto({
    kind: 'veiculo',
    title: 'Fiat Argo Drive 1.3 2021 completo, unico dono',
    attrs: { brand: 'Fiat', model: 'Argo', version: 'Drive 1.3' },
  });
  assert.equal(familyName(v), 'Fiat Argo Drive 1.3');
});

test('family_name de imovel descreve tipo e cidade', () => {
  const i = produto({
    kind: 'imovel',
    title: 'Apartamento 2 dormitorios no Centro',
    attrs: { propertyType: 'apartamento', operation: 'venda' },
  });
  assert.equal(familyName(i), 'Apartamento Porto Alegre');
});

test('family_name respeita o limite de 60 caracteres do ML', () => {
  const longo = familyName(produto({
    attrs: { brand: 'Marca Com Nome Absurdamente Longo Para Um Fabricante', model: 'Modelo Igualmente Interminavel' },
  }));
  assert.ok(longo.length <= 60, `veio com ${longo.length}`);
  assert.equal(longo.endsWith(' '), false, 'nao pode terminar com espaco solto do corte');
});

test('produto sem garantia informada vai como "Sem garantia" (o ML exige o termo)', () => {
  const item = buildItem(produto(), 'MLB1144');
  assert.deepEqual(item.sale_terms, [{ id: 'WARRANTY_TYPE', value_name: 'Sem garantia' }]);
});

test('garantia com prazo reconhecido vira WARRANTY_TIME', () => {
  const item = buildItem(produto({ attrs: { brand: 'Sony', model: 'PS4', warranty: '3 meses' } }), 'MLB1144');
  assert.deepEqual(item.sale_terms, [
    { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
    { id: 'WARRANTY_TIME', value_name: '3 meses' },
  ]);
});

test('garantia em texto livre nao inventa prazo', () => {
  const item = buildItem(produto({ attrs: { brand: 'Sony', warranty: 'resta garantia da loja' } }), 'MLB1144');
  assert.deepEqual(item.sale_terms, [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }]);
});

test('classificado (veiculo/imovel) nao leva sale_terms', () => {
  const item = buildItem(produto({ kind: 'veiculo', attrs: { brand: 'Fiat', model: 'Argo' } }), 'MLB1744');
  assert.equal(item.sale_terms, undefined);
  assert.equal(item.buying_mode, 'classified');
});

test('a descricao nao vai mais no corpo do item (o ML desativou o campo em 2021)', () => {
  const item = buildItem(produto(), 'MLB1144') as unknown as Record<string, unknown>;
  assert.equal('description' in item, false);
  assert.equal(Array.isArray(item.pictures), true);
});
