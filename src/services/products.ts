import { randomUUID } from 'node:crypto';
import { all, get, nowIso, run, tx } from '../db/index.ts';
import { config } from '../config.ts';
import {
  isOwnPhoto, type ChannelAttrs, type ImageOrigin, type Product, type ProductInput, type ProductImage,
} from '../domain/product.ts';
import { ImageError } from './images.ts';

interface ProductRow {
  id: string; kind: Product['kind']; title: string; description: string;
  price_cents: number; condition: 'novo' | 'usado'; quantity: number;
  accepts_trade: number; cep: string; city: string; uf: string; neighborhood: string;
  attrs_json: string; channel_attrs_json: string; archived: number; created_at: string; updated_at: string;
}

interface ImageRow {
  id: string; product_id: string; filename: string; mime: string; position: number;
  width: number; height: number; origin: ImageOrigin; source_url: string;
  source_label: string; original_filename: string;
}

export function imageUrl(filename: string) {
  return `${config.publicUrl}/uploads/${filename}`;
}

function hydrate(row: ProductRow, images: ImageRow[]): Product {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    condition: row.condition,
    quantity: row.quantity,
    acceptsTrade: row.accepts_trade === 1,
    cep: row.cep,
    city: row.city,
    uf: row.uf,
    neighborhood: row.neighborhood,
    attrs: JSON.parse(row.attrs_json) as Record<string, unknown>,
    channelAttrs: JSON.parse(row.channel_attrs_json || '{}') as ChannelAttrs,
    archived: row.archived === 1,
    images: images
      .filter((i) => i.product_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map<ProductImage>((i) => ({
        id: i.id,
        filename: i.filename,
        mime: i.mime,
        position: i.position,
        url: imageUrl(i.filename),
        width: i.width,
        height: i.height,
        origin: i.origin,
        sourceUrl: i.source_url,
        sourceLabel: i.source_label,
        originalFilename: i.original_filename,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProducts(opts: { includeArchived?: boolean } = {}): Product[] {
  const rows = all<ProductRow>(
    `SELECT * FROM products ${opts.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`,
  );
  if (rows.length === 0) return [];
  const images = all<ImageRow>('SELECT * FROM images');
  return rows.map((r) => hydrate(r, images));
}

export function getProduct(id: string): Product | undefined {
  const row = get<ProductRow>('SELECT * FROM products WHERE id = ?', id);
  if (!row) return undefined;
  return hydrate(row, all<ImageRow>('SELECT * FROM images WHERE product_id = ?', id));
}

export function createProduct(input: ProductInput): Product {
  const id = randomUUID();
  const ts = nowIso();
  run(
    `INSERT INTO products (id, kind, title, description, price_cents, condition, quantity, accepts_trade,
       cep, city, uf, neighborhood, attrs_json, archived, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    id, input.kind, input.title, input.description, input.priceCents, input.condition, input.quantity,
    input.acceptsTrade ? 1 : 0, input.cep, input.city, input.uf, input.neighborhood,
    JSON.stringify(input.attrs ?? {}), ts, ts,
  );
  return getProduct(id)!;
}

export function updateProduct(id: string, input: ProductInput): Product | undefined {
  const existing = get<ProductRow>('SELECT id FROM products WHERE id = ?', id);
  if (!existing) return undefined;
  run(
    `UPDATE products SET kind=?, title=?, description=?, price_cents=?, condition=?, quantity=?,
       accepts_trade=?, cep=?, city=?, uf=?, neighborhood=?, attrs_json=?, updated_at=?
     WHERE id=?`,
    input.kind, input.title, input.description, input.priceCents, input.condition, input.quantity,
    input.acceptsTrade ? 1 : 0, input.cep, input.city, input.uf, input.neighborhood,
    JSON.stringify(input.attrs ?? {}), nowIso(), id,
  );
  return getProduct(id);
}

export function archiveProduct(id: string, archived: boolean) {
  run('UPDATE products SET archived=?, updated_at=? WHERE id=?', archived ? 1 : 0, nowIso(), id);
}

export function deleteProduct(id: string) {
  // images e listings caem por ON DELETE CASCADE; os arquivos sao limpos pelo chamador.
  return tx(() => run('DELETE FROM products WHERE id = ?', id));
}

export interface NewImage {
  filename: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  origin?: ImageOrigin;
  sourceUrl?: string;
  sourceLabel?: string;
  originalFilename?: string;
}

export function addImage(productId: string, img: NewImage) {
  const origin = img.origin ?? 'upload';
  const next = get<{ n: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM images WHERE product_id = ?', productId,
  );
  // A posicao 0 e a capa do anuncio e so foto sua pode ocupa-la: produto que
  // ainda nao tem foto propria recebe a ilustrativa a partir da posicao 1,
  // deixando a vaga da capa reservada.
  const position = Math.max(next?.n ?? 0, isOwnPhoto({ origin }) ? 0 : 1);
  const id = randomUUID();
  run(
    `INSERT INTO images (id, product_id, filename, mime, bytes, position, width, height,
       origin, source_url, source_label, original_filename, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, productId, img.filename, img.mime, img.bytes, position, img.width, img.height,
    origin, img.sourceUrl ?? '', img.sourceLabel ?? '', img.originalFilename ?? '', nowIso(),
  );
  run('UPDATE products SET updated_at=? WHERE id=?', nowIso(), productId);
  return id;
}

export function getImage(id: string) {
  return get<ImageRow>('SELECT * FROM images WHERE id = ?', id);
}

export function removeImage(id: string) {
  run('DELETE FROM images WHERE id = ?', id);
}

/**
 * Reordena a galeria. A primeira posicao e a capa do anuncio e so aceita foto
 * sua: Mercado Livre e OLX derrubam anuncio de usado cuja foto principal e de
 * catalogo, e o comprador que ve foto de divulgacao na capa reclama depois.
 */
export function reorderImages(productId: string, orderedIds: string[]) {
  const current = all<ImageRow>('SELECT * FROM images WHERE product_id = ?', productId);
  const byId = new Map(current.map((i) => [i.id, i]));

  const unknown = orderedIds.filter((id) => !byId.has(id));
  if (unknown.length) throw new ImageError('a ordem enviada tem imagem que nao e deste produto');

  const first = orderedIds[0] ? byId.get(orderedIds[0]) : undefined;
  if (first && !isOwnPhoto(first)) {
    throw new ImageError('a capa do anuncio tem de ser uma foto sua: foto de catalogo e ilustrativa e entra depois');
  }

  tx(() => {
    orderedIds.forEach((imgId, idx) => {
      run('UPDATE images SET position=? WHERE id=? AND product_id=?', idx, imgId, productId);
    });
    run('UPDATE products SET updated_at=? WHERE id=?', nowIso(), productId);
  });
}

/**
 * Grava os atributos de UMA plataforma, sem tocar nos das outras nem nos dados
 * do produto. Separado de updateProduct de proposito: salvar o formulario do
 * produto nao pode apagar o que foi preenchido para o Mercado Livre.
 */
export function setChannelAttrs<K extends keyof ChannelAttrs>(id: string, channel: K, value: ChannelAttrs[K]) {
  const row = get<{ channel_attrs_json: string }>('SELECT channel_attrs_json FROM products WHERE id = ?', id);
  if (!row) return undefined;
  const atual = JSON.parse(row.channel_attrs_json || '{}') as ChannelAttrs;
  atual[channel] = value;
  run('UPDATE products SET channel_attrs_json=?, updated_at=? WHERE id=?', JSON.stringify(atual), nowIso(), id);
  return getProduct(id);
}
