import { request } from '../../lib/http.ts';
import { config } from '../../config.ts';
import { productInput, type ChannelAttrValue, type ProductInput } from '../../domain/product.ts';
import type { ListingStatus } from '../types.ts';
import { ML_API, ensureToken } from './auth.ts';
import { urlVariants } from './catalog.ts';

/**
 * Importa os anuncios que ja estao na conta do Mercado Livre, para melhorar
 * texto e fotos aqui e atualizar o MESMO anuncio depois (ver update.ts).
 *
 * - GET /users/:id/items/search?status=... -> ids (ativos, pausados, encerrados)
 * - GET /items?ids=...                      -> ate 20 itens por chamada
 * - GET /items/:id/description             -> texto do anuncio
 *
 * Este modulo so le o ML e monta o produto; gravar (produto, fotos, listing) e
 * com o servico de importacao, que passa cada foto por processUpload.
 */

export const STATUS_IMPORTADOS = ['active', 'paused', 'closed'] as const;

export interface MlItem {
  id: string;
  title?: string;
  family_name?: string;
  category_id?: string;
  price?: number;
  available_quantity?: number;
  sold_quantity?: number;
  condition?: string;
  status?: string;
  permalink?: string;
  buying_mode?: string;
  listing_type_id?: string;
  date_created?: string;
  pictures?: Array<{ url?: string; secure_url?: string }>;
  attributes?: Array<{ id: string; value_id?: string | null; value_name?: string | null }>;
  sale_terms?: Array<{ id: string; value_name?: string | null }>;
  variations?: unknown[];
  seller_address?: {
    city?: { name?: string };
    state?: { id?: string; name?: string };
    zip_code?: string;
    neighborhood?: { name?: string };
  };
}

/** Status do ML -> status do listing aqui. */
export function listingStatusFrom(status: string | undefined): ListingStatus {
  if (status === 'active') return 'publicado';
  if (status === 'paused') return 'pausado';
  if (status === 'closed') return 'encerrado';
  return 'erro'; // under_review, inactive: aparece no painel para voce olhar
}

/** Atributos que o cadastro ja guarda em campos proprios (ou que o ML calcula). */
const DO_CADASTRO = new Set(['BRAND', 'MODEL', 'GTIN', 'EMPTY_GTIN_REASON', 'ITEM_CONDITION', 'SELLER_SKU']);

/** Veiculo e imovel tem cadastro proprio e muito mais campos: ficam fora da importacao por enquanto. */
function tipoNaoSuportado(item: MlItem): string | undefined {
  const ids = new Set((item.attributes ?? []).map((a) => a.id));
  if (ids.has('VEHICLE_YEAR') || ids.has('KILOMETERS')) return 'veiculo';
  if (ids.has('PROPERTY_TYPE') || ids.has('OPERATION')) return 'imovel';
  return undefined;
}

const attr = (item: MlItem, id: string) =>
  (item.attributes ?? []).find((a) => a.id === id)?.value_name?.trim() ?? '';

/** Garantia do anuncio em texto, ou '' quando e "Sem garantia" (o padrao daqui). */
function garantia(item: MlItem): string {
  const termos = item.sale_terms ?? [];
  const tipo = termos.find((t) => t.id === 'WARRANTY_TYPE')?.value_name ?? '';
  const prazo = termos.find((t) => t.id === 'WARRANTY_TIME')?.value_name ?? '';
  if (!tipo || /sem garantia/i.test(tipo)) return '';
  return prazo || tipo;
}

/** UF a partir do estado do ML ("BR-RS" ou o nome). */
function uf(item: MlItem): string {
  const id = item.seller_address?.state?.id ?? '';
  return /^BR-[A-Z]{2}$/.test(id) ? id.slice(3) : config.seller.uf;
}

export interface ImportDraft {
  input: ProductInput;
  /** Atributos da categoria (VOLTAGE...), no formato do painel "Atributos do Mercado Livre". */
  mlAttributes: Record<string, ChannelAttrValue>;
  categoryId?: string;
  pictureUrls: string[][];
  listing: { status: ListingStatus; externalId: string; permalink?: string; publishedAt?: string };
}

/**
 * Converte um item do ML no produto daqui. Devolve o motivo em vez do rascunho
 * quando o item nao da para importar. Exportado para teste.
 */
export function draftFromItem(item: MlItem, descricao: string): ImportDraft | { pulado: string } {
  const tipo = tipoNaoSuportado(item);
  if (tipo) return { pulado: `${tipo} ainda nao e importado (cadastre pelo formulario)` };

  const titulo = (item.title || item.family_name || '').trim();
  const bruto = {
    kind: 'geral' as const,
    title: titulo.length >= 5 ? titulo : `${titulo} (importado)`.trim(),
    description: descricao.trim(),
    priceCents: Math.round((item.price ?? 0) * 100),
    condition: item.condition === 'new' ? 'novo' as const : 'usado' as const,
    quantity: Math.max(1, item.available_quantity ?? 1),
    acceptsTrade: false,
    cep: (item.seller_address?.zip_code ?? config.seller.cep).replace(/\D/g, '').slice(0, 9),
    city: item.seller_address?.city?.name ?? config.seller.city,
    uf: uf(item),
    neighborhood: item.seller_address?.neighborhood?.name ?? '',
    attrs: {
      brand: attr(item, 'BRAND').slice(0, 60),
      model: attr(item, 'MODEL').slice(0, 60),
      wear: item.condition === 'new' ? 'novo' : 'bom',
      warranty: garantia(item).slice(0, 80),
      gtin: attr(item, 'GTIN').split(/[,;\s]/)[0] ?? '',
      gtinMissingReason: '',
    },
  };
  let parsed = productInput.safeParse(bruto);
  if (!parsed.success) {
    // codigo de barras com digito invalido no ML nao impede a importacao
    parsed = productInput.safeParse({ ...bruto, attrs: { ...bruto.attrs, gtin: '' } });
  }
  if (!parsed.success) return { pulado: `dados fora do formato esperado: ${parsed.error.issues[0]?.message}` };

  const mlAttributes: Record<string, ChannelAttrValue> = {};
  for (const a of item.attributes ?? []) {
    if (DO_CADASTRO.has(a.id) || (!a.value_id && !a.value_name)) continue;
    mlAttributes[a.id] = {
      ...(a.value_id ? { value_id: a.value_id } : {}),
      ...(a.value_name ? { value_name: a.value_name } : {}),
    };
  }

  return {
    input: parsed.data,
    mlAttributes,
    categoryId: item.category_id,
    pictureUrls: (item.pictures ?? [])
      .map((p) => p.secure_url || p.url)
      .filter((u): u is string => Boolean(u))
      .map((u) => urlVariants(u)),
    listing: {
      status: listingStatusFrom(item.status),
      externalId: item.id,
      permalink: item.permalink,
      publishedAt: item.date_created,
    },
  };
}

async function userId(token: string, salvo: unknown): Promise<number> {
  if (typeof salvo === 'number' || (typeof salvo === 'string' && salvo)) return Number(salvo);
  const me = await request<{ id: number }>(`${ML_API}/users/me`, { headers: { authorization: `Bearer ${token}` } });
  return me.id;
}

/** Ids de todos os anuncios da conta nos status importados. */
export async function listSellerItemIds(): Promise<string[]> {
  const account = await ensureToken();
  const token = account.accessToken!;
  const headers = { authorization: `Bearer ${token}` };
  const id = await userId(token, account.meta?.userId);

  const ids = new Set<string>();
  for (const status of STATUS_IMPORTADOS) {
    // offset vai ate 1000 no ML; conta de pessoa fisica nao chega perto disso.
    for (let offset = 0; offset < 1000; offset += 50) {
      const res = await request<{ results?: string[]; paging?: { total?: number } }>(
        `${ML_API}/users/${id}/items/search`, { headers, query: { status, offset, limit: 50 } },
      );
      for (const r of res.results ?? []) ids.add(r);
      if (!res.results?.length || offset + 50 >= (res.paging?.total ?? 0)) break;
    }
  }
  return [...ids];
}

/** Itens completos, 20 por chamada (limite do multiget do ML), com a descricao de cada um. */
export async function fetchItemsWithDescription(ids: string[]) {
  const account = await ensureToken();
  const headers = { authorization: `Bearer ${account.accessToken}` };
  const out: Array<{ item: MlItem; descricao: string }> = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = await request<Array<{ code: number; body: MlItem }>>(
      `${ML_API}/items`, { headers, query: { ids: ids.slice(i, i + 20).join(',') } },
    );
    for (const r of lote ?? []) {
      if (r.code !== 200 || !r.body?.id) continue;
      let descricao = '';
      try {
        const d = await request<{ plain_text?: string; text?: string }>(
          `${ML_API}/items/${r.body.id}/description`, { headers },
        );
        descricao = d?.plain_text || (d?.text ?? '').replace(/<[^>]+>/g, ' ');
      } catch {
        // anuncio sem descricao: importa assim mesmo
      }
      out.push({ item: r.body, descricao });
    }
  }
  return out;
}
