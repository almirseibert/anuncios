import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '../src/domain/product.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-mlattr-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { requiredFields } = await import('../src/channels/mercadolivre/categoryAttrs.ts');
const { buildItem, formAttributeIds } = await import('../src/channels/mercadolivre/map.ts');
const { createProduct, setChannelAttrs, updateProduct, getProduct } = await import('../src/services/products.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

// Recorte do que /categories/MLB11172/attributes devolve para consoles.
const atributosConsole = [
  { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
  { id: 'GTIN', name: 'Código universal de produto', value_type: 'string', tags: { conditional_required: true } },
  { id: 'VOLTAGE', name: 'Voltagem', value_type: 'list', tags: { required: true },
    values: [{ id: '1', name: '110V' }, { id: '2', name: '220V' }, { id: '3', name: 'Bivolt' }] },
  { id: 'IS_PORTABLE', name: 'É portátil', value_type: 'boolean', tags: { conditional_required: true } },
  { id: 'STORAGE_CAPACITY', name: 'Capacidade de armazenamento', value_type: 'number_unit',
    tags: { required: true }, allowed_units: [{ id: 'GB', name: 'GB' }, { id: 'TB', name: 'TB' }], default_unit: 'GB' },
  { id: 'COLOR', name: 'Cor', value_type: 'string', tags: {} },
  { id: 'ITEM_CONDITION', name: 'Condição', value_type: 'list', tags: { required: true } },
  { id: 'SALE_FORMAT', name: 'Formato', value_type: 'list', tags: { required: true, read_only: true } },
];

function produto(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', kind: 'geral', title: 'Playstation 4 Slim', description: 'x', priceCents: 100000,
    condition: 'usado', quantity: 1, acceptsTrade: false, cep: '', city: '', uf: '', neighborhood: '',
    attrs: { brand: 'Sony', model: 'PS4 Slim', gtin: '0711719541028' }, channelAttrs: {},
    archived: false, images: [], createdAt: '', updatedAt: '', ...over,
  };
}

test('o painel pede so o obrigatorio que o cadastro ainda nao cobre', () => {
  const campos = requiredFields(atributosConsole, formAttributeIds(produto()));
  assert.deepEqual(campos.map((c) => c.id), ['VOLTAGE', 'STORAGE_CAPACITY', 'IS_PORTABLE']);
  // BRAND/GTIN ja vem do cadastro; COLOR e opcional; ITEM_CONDITION vem da condicao; SALE_FORMAT e read_only
});

test('obrigatorio aparece antes do condicional, e cada um com o tipo certo', () => {
  const [voltagem, capacidade, portatil] = requiredFields(atributosConsole, formAttributeIds(produto()));
  assert.equal(voltagem!.type, 'list');
  assert.deepEqual(voltagem!.values.map((v) => v.name), ['110V', '220V', 'Bivolt']);
  assert.equal(voltagem!.required, true);
  assert.equal(capacidade!.type, 'number_unit');
  assert.equal(capacidade!.defaultUnit, 'GB');
  assert.equal(portatil!.type, 'boolean');
  assert.equal(portatil!.required, false);
  assert.deepEqual(portatil!.values.map((v) => v.name), ['Sim', 'Não']);
});

test('o valor escolhido no painel vai no payload; opcao de lista vai pelo id', () => {
  const item = buildItem(produto({
    channelAttrs: { mercadolivre: { categoryId: 'MLB11172', attributes: {
      VOLTAGE: { value_id: '3', value_name: 'Bivolt' },
      STORAGE_CAPACITY: { value_name: '1 TB' },
      VAZIO: { value_name: '   ' },
    } } },
  }), 'MLB11172');
  const porId = Object.fromEntries(item.attributes.map((a) => [a.id, a]));
  assert.deepEqual(porId.VOLTAGE, { id: 'VOLTAGE', value_id: '3' });
  assert.deepEqual(porId.STORAGE_CAPACITY, { id: 'STORAGE_CAPACITY', value_name: '1 TB' });
  assert.equal(porId.VAZIO, undefined, 'campo em branco nao vai');
  assert.deepEqual(porId.GTIN, { id: 'GTIN', value_name: '0711719541028' }, 'o do cadastro continua');
});

test('salvar o formulario do produto NAO apaga os atributos do ML', () => {
  const p = createProduct({
    kind: 'geral', title: 'Playstation 4 Slim', description: 'x', priceCents: 100000, condition: 'usado',
    quantity: 1, acceptsTrade: false, cep: '', city: '', uf: '', neighborhood: '',
    attrs: { brand: 'Sony', model: 'PS4', wear: 'bom', warranty: '', gtin: '', gtinMissingReason: '' },
  });
  setChannelAttrs(p.id, 'mercadolivre', { categoryId: 'MLB11172', attributes: { VOLTAGE: { value_id: '3' } } });

  updateProduct(p.id, {
    kind: 'geral', title: 'Playstation 4 Slim 1TB', description: 'editado', priceCents: 110000, condition: 'usado',
    quantity: 1, acceptsTrade: true, cep: '', city: '', uf: '', neighborhood: '',
    attrs: { brand: 'Sony', model: 'PS4 Slim', wear: 'bom', warranty: '', gtin: '', gtinMissingReason: '' },
  });

  const depois = getProduct(p.id)!;
  assert.equal(depois.title, 'Playstation 4 Slim 1TB');
  assert.deepEqual(depois.channelAttrs.mercadolivre?.attributes, { VOLTAGE: { value_id: '3' } });
});
