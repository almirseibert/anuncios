import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-ref-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { createProduct, addImage, getProduct, reorderImages } = await import('../src/services/products.ts');
const { illustrativeNote } = await import('../src/services/templates.ts');
const { photoIssues } = await import('../src/services/images.ts');
const { ImageError } = await import('../src/services/images.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

function novoProduto() {
  return createProduct({
    kind: 'geral',
    title: 'Playstation 4 Slim 1TB com 2 controles',
    description: 'Console conservado, sempre em casa.',
    priceCents: 120000,
    condition: 'usado',
    quantity: 1,
    acceptsTrade: false,
    cep: '90000000',
    city: 'Porto Alegre',
    uf: 'RS',
    neighborhood: 'Centro',
    attrs: { brand: 'Sony', model: 'PS4 Slim', wear: 'bom', warranty: '' },
  });
}

const foto = (n: string) => ({ filename: n, mime: 'image/jpeg', bytes: 1000, width: 1600, height: 1200 });

test('foto de catalogo nunca ocupa a capa, mesmo sendo a primeira a entrar', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('cat.jpg'), origin: 'catalogo', sourceLabel: 'PS4 Slim 1TB' });

  const imagens = getProduct(p.id)!.images;
  assert.equal(imagens.length, 1);
  assert.equal(imagens[0]!.position, 1, 'a posicao 0 fica reservada para a foto do item real');
});

test('a foto sua entra na capa e a de catalogo fica atras dela', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('minha.jpg'), origin: 'upload' });
  addImage(p.id, { ...foto('cat.jpg'), origin: 'catalogo' });

  const imagens = getProduct(p.id)!.images;
  assert.deepEqual(imagens.map((i) => i.origin), ['upload', 'catalogo']);
});

test('reordenar nao deixa foto de catalogo virar capa', () => {
  const p = novoProduto();
  const minha = addImage(p.id, { ...foto('minha.jpg'), origin: 'upload' });
  const cat = addImage(p.id, { ...foto('cat.jpg'), origin: 'catalogo' });

  assert.throws(() => reorderImages(p.id, [cat, minha]), ImageError);
  // a ordem no banco continua intacta
  assert.deepEqual(getProduct(p.id)!.images.map((i) => i.origin), ['upload', 'catalogo']);

  reorderImages(p.id, [minha, cat]); // a ordem valida passa
  assert.deepEqual(getProduct(p.id)!.images.map((i) => i.filename), ['minha.jpg', 'cat.jpg']);
});

test('reordenar recusa id que nao e do produto', () => {
  const p = novoProduto();
  const minha = addImage(p.id, { ...foto('minha.jpg'), origin: 'upload' });
  assert.throws(() => reorderImages(p.id, [minha, 'id-de-outro-produto']), ImageError);
});

test('link colado conta como foto sua: pode ser capa e nao vira ilustrativa', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('do-drive.jpg'), origin: 'url', sourceUrl: 'https://exemplo.com/a.jpg' });

  const produto = getProduct(p.id)!;
  assert.equal(produto.images[0]!.position, 0);
  assert.equal(illustrativeNote(produto), undefined);
  assert.deepEqual(photoIssues('mercadolivre', produto, 'o Mercado Livre'), []);
});

test('produto so com foto de catalogo e bloqueio de publicacao', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('cat.jpg'), origin: 'catalogo' });

  const issues = photoIssues('mercadolivre', getProduct(p.id)!, 'o Mercado Livre');
  const bloqueios = issues.filter((i) => i.severity === 'error');
  assert.equal(bloqueios.length, 1);
  assert.match(bloqueios[0]!.message, /foto do item real/);
});

test('a nota de foto ilustrativa conta as fotos certas', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('a.jpg'), origin: 'upload' });
  addImage(p.id, { ...foto('b.jpg'), origin: 'upload' });
  addImage(p.id, { ...foto('c.jpg'), origin: 'catalogo' });

  const nota = illustrativeNote(getProduct(p.id)!)!;
  assert.match(nota, /A ultima foto e ilustrativa/);
  assert.match(nota, /As 2 primeiras fotos sao do item real/);
});

test('foto abaixo do minimo do canal gera aviso, nao bloqueio', () => {
  const p = novoProduto();
  addImage(p.id, { ...foto('pequena.jpg'), width: 320, height: 240, origin: 'upload' });

  const issues = photoIssues('mercadolivre', getProduct(p.id)!, 'o Mercado Livre');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, 'warn');
  assert.match(issues[0]!.message, /500x500/);
});

const { urlVariants } = await import('../src/channels/mercadolivre/catalog.ts');

test('urlVariants tenta a original do ML e mantem a URL da API como reserva', () => {
  assert.deepEqual(
    urlVariants('https://http2.mlstatic.com/D_NQ_NP_123456-MLA7-V.jpg'),
    ['https://http2.mlstatic.com/D_NQ_NP_123456-MLA7-O.jpg', 'https://http2.mlstatic.com/D_NQ_NP_123456-MLA7-V.jpg'],
  );
  // URL fora do padrao fica como esta, sem chute de sufixo
  assert.deepEqual(urlVariants('https://exemplo.com/foto.jpg'), ['https://exemplo.com/foto.jpg']);
});
