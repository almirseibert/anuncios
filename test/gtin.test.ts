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
    attrs: { brand: 'Sony', model: 'PS4 Slim', ...attrs }, channelAttrs: {}, archived: false, images: [],
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

test('atributo da categoria manda para o painel de atributos do ML', () => {
  // resposta real do ML para o console, depois do GTIN resolvido
  const erro = { cause: [{
    code: 'item.attributes.missing_required',
    message: 'The attributes [VOLTAGE] are required for category MLB11172 and channel marketplace.',
  }] };
  assert.deepEqual(atributosFaltando(erro), ['VOLTAGE']);
  assert.match(dicaDoErro(erro)!, /Atributos do Mercado Livre.*VOLTAGE/);
});

test('cadastro e categoria juntos geram as duas instrucoes', () => {
  const erro = { cause: [
    { code: 'item.attribute.missing_conditional_required', message: 'The attributes [GTIN] are required' },
    { code: 'item.attributes.missing_required', message: 'The attributes [VOLTAGE, COLOR] are required' },
  ] };
  const dica = dicaDoErro(erro)!;
  assert.match(dica, /Código de barras/);
  assert.match(dica, /VOLTAGE, COLOR/);
});

test('aviso do ML tambem bloqueia: lost_me1_by_user, unica causa de um 400 real, vira instrucao', () => {
  // resposta exata do ML em producao: "warning", mas o anuncio foi recusado
  const soAviso = {
    cause: [{
      department: 'shipping', cause_id: 4053, type: 'warning', code: 'shipping.lost_me1_by_user',
      references: ['user.shipping_preferences.modes'], message: 'User has not mode me1',
    }],
    message: 'Validation error', error: 'validation_error', status: 400,
  };
  assert.match(dicaDoErro(soAviso)!, /modo de envio \(me1\).*Mercado Envios/);
});

test('atributo que a pre-checagem ja cobrou nao aparece duas vezes', () => {
  const erro = { cause: [{ code: 'item.attributes.missing_required', message: 'The attributes [VOLTAGE] are required' }] };
  assert.equal(dicaDoErro(erro, new Set(['VOLTAGE'])), undefined);
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

test('erro de localizacao (real, de um classificado) vira instrucao', () => {
  const erro = { cause: [{ department: 'items', cause_id: 187, type: 'error', code: 'item.location.invalid',
    references: ['item.location'],
    message: "Field 'location' requires up to city level. [country.name: , state.name: RS, city.name: Lajeado]" }] };
  assert.match(dicaDoErro(erro)!, /confira cidade e UF/);
});
