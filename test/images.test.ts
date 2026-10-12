import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// O servico de imagem le o config no import: aponte os diretorios antes.
const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-img-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const sharp = (await import('sharp')).default;
const { processUpload, ImageError, originalsDir, measureAgainst } = await import('../src/services/images.ts');
const { config } = await import('../src/config.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

/** Foto "de celular": maior que o limite, girada pelo EXIF e com GPS gravado. */
async function fotoDeCelular() {
  return sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#4477aa' } })
    // orientation 6 = retrato tirado com o celular de lado, como sai da camera.
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'Anuncios Test' },
      // No libvips o IFD3 e onde ficam os tags de GPS da camera.
      IFD3: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'W' },
    })
    .jpeg()
    .toBuffer();
}

// O GPS da camera mora dentro do bloco EXIF: garantir que nenhum EXIF sai no
// derivado e o que garante que a coordenada nao vaza para as plataformas.
test('a foto tratada sai sem EXIF (e por isso sem o GPS da camera)', async () => {
  const entrada = await fotoDeCelular();
  const antes = await sharp(entrada).metadata();
  assert.ok(antes.exif, 'a fixture precisa ter EXIF para o teste valer algo');

  const out = await processUpload(entrada, { productId: 'p1' });
  const depois = await sharp(await readFile(join(config.uploadsDir, out.filename))).metadata();

  assert.equal(depois.exif, undefined);
  assert.equal(depois.xmp, undefined);
});

test('reduz ao lado maior configurado e aplica a orientacao do EXIF', async () => {
  const out = await processUpload(await fotoDeCelular(), { productId: 'p1' });

  assert.equal(Math.max(out.width, out.height), config.image.maxSide);
  // Orientation 6 = girada 90 graus: a foto 3000x2000 vira retrato.
  assert.ok(out.height > out.width, `esperava retrato depois do rotate, veio ${out.width}x${out.height}`);
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.bytes > 0);
});

test('nao amplia foto pequena nem a converte em outra coisa', async () => {
  const pequena = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();

  const out = await processUpload(pequena, { productId: 'p2' });
  assert.deepEqual([out.width, out.height], [400, 300]);
  assert.match(out.filename, /\.jpg$/);
});

test('guarda o original intacto para permitir desfazer', async () => {
  const entrada = await fotoDeCelular();
  const out = await processUpload(entrada, { productId: 'p3' });

  const original = await readFile(join(originalsDir, out.originalFilename));
  assert.deepEqual(original, entrada);
  assert.match(out.originalFilename, /\.jpg$/);
});

test('recusa arquivo que nao e imagem', async () => {
  await assert.rejects(
    () => processUpload(Buffer.from('isto aqui e um pdf, juro'), { productId: 'p4' }),
    ImageError,
  );
  await assert.rejects(() => processUpload(Buffer.alloc(0), { productId: 'p4' }), ImageError);
});

test('measureAgainst separa abaixo do minimo e abaixo do recomendado', () => {
  const r = measureAgainst('mercadolivre', [
    { width: 1600, height: 1200, origin: 'upload' },
    { width: 800, height: 600, origin: 'upload' },
    { width: 300, height: 300, origin: 'upload' },
    { width: 0, height: 0, origin: 'upload' }, // foto antiga, sem dimensao conhecida
  ]);

  assert.equal(r.belowMin.length, 1);
  assert.equal(r.belowRecommended.length, 2);
});
