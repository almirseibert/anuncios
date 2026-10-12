import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '../src/domain/product.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-gtin-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { gtinValido, geralAttrs } = await import('../src/domain/product.ts');
const { buildItem } = await import('../src/channels/mercadolivre/map.ts');
const { dicaDoErro, atributosFaltando } = await import('../src/channels/mercadolivre/errors.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('gtinValido aceita codigos reais e recusa digito trocado', () => {
  for (const ok of ['4006381333931', '0711719541028', '96385074', '036000291452', '10012345000017']) {
    assert.equal(gtinValido(ok), true, ok);
  }
  // mesmo codigo com o ultimo digito trocado: e o erro de digitacao mais comum
  assert.equal(gtinValido('4006381333932'), false);
  assert.equal(gtinValido('123'), false);
  assert.equal(gtinValido('abcdefghijklm'), false);
});

test('o cadastro tolera espacos e tracos e guarda so os digitos', () => {
  const a = geralAttrs.parse({ gtin: '4006381 33393-1' });
  assert.equal(a.gtin, '4006381333931');
});

test('o cadastro recusa codigo com digito verificador errado, com mensagem clara', () => {
  const r = geralAttrs.safeParse({ gtin: '4006381333932' });
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0]!.message, /codigo de barras invalido/);
});

function produto(attrs: Record<string, unknown>): Product {
  return {
    id: 'p1', kind: 'geral', title: 'Playstation 4 Slim', description: 'x', priceCents: 100000,
    condition: 'usado', quantity: 1, acceptsTrade: false, cep: '', city: '', uf: '', neighborhood: '',
    attrs: { brand: 'Sony', model: 'PS4 Slim', ...attrs }, archived: false, images: [],
    createdAt: '', updatedAt: '',
  };
}

test('com codigo, vai GTIN para o ML', () => {
  const item = buildItem(produto({ gtin: '0711719541028' }), 'MLB11172');
  assert.deepEqual(item.attributes.find((a) => a.id === 'GTIN'), { id: 'GTIN', value_name: '0711719541028' });
  assert.equal(item.attributes.some((a) => a.id === 'EMPTY_GTIN_REASON'), false);
});

test('sem codigo e com motivo declarado, vai EMPTY_GTIN_REASON com o id do ML', () => {
  const item = buildItem(produto({ gtin: '', gtinMissingReason: 'kit' }), 'MLB11172');
  assert.deepEqual(
    item.attributes.find((a) => a.id === 'EMPTY_GTIN_REASON'),
    { id: 'EMPTY_GTIN_REASON', value_id: '17055159' },
  );
});

test('sem codigo e sem motivo, o sistema nao declara nada pelo vendedor', () => {
  const item = buildItem(produto({ gtin: '', gtinMissingReason: '' }), 'MLB11172');
  assert.equal(item.attributes.some((a) => a.id === 'GTIN' || a.id === 'EMPTY_GTIN_REASON'), false);
});

// A resposta exata que o Mercado Livre devolveu em producao.
const erroReal = {
  cause: [{
    department: 'supply', cause_id: 7810, type: 'error',
    code: 'item.attribute.missing_conditional_required', references: ['item.attributes'],
    message: 'The attributes [GTIN] are required for category [MLB11172]. Check the attribute is present '
      + "in the attributes list or in all variation's attributes_combination or attributes.",
  }],
  message: 'Validation error', error: 'validation_error', status: 400,
};

test('o erro real do ML vira instrucao de qual campo preencher', () => {
  assert.deepEqual(atributosFaltando(erroReal), ['GTIN']);
  assert.match(dicaDoErro(erroReal)!, /Código de barras \(EAN\)/);
});

test('atributo que o formulario nao tem e dito com honestidade', () => {
  const erro = { cause: [{ code: 'item.attribute.missing_required', message: 'The attributes [STORAGE_CAPACITY] are required' }] };
  assert.match(dicaDoErro(erro)!, /STORAGE_CAPACITY.*formulário ainda não tem/);
});

test('erro de outro tipo nao ganha dica inventada', () => {
  assert.equal(dicaDoErro({ cause: [], message: 'body.invalid_fields' }), undefined);
  assert.equal(dicaDoErro(undefined), undefined);
});

test('a dica vem antes do texto do ML, e o detalhe cru e preservado', async () => {
  const { comDica } = await import('../src/channels/mercadolivre/errors.ts');
  const { ChannelError } = await import('../src/channels/types.ts');
  const err = comDica(new ChannelError('api.mercadolibre.com respondeu 400: Validation error', erroReal)) as InstanceType<typeof ChannelError>;
  assert.match(err.message, /^Preencha no cadastro do produto: "Código de barras/);
  assert.match(err.message, /Resposta do ML: api\.mercadolibre\.com respondeu 400/);
  assert.equal(err.detail, erroReal);
});
