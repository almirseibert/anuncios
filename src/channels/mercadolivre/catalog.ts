import { request } from '../../lib/http.ts';
import { config } from '../../config.ts';
import { ChannelError } from '../types.ts';
import { ML_API, ensureToken } from './auth.ts';

/**
 * Fotos oficiais de produto, vindas do catalogo do proprio Mercado Livre.
 *
 * Por que daqui e nao de uma busca de imagens: a foto do catalogo e a imagem
 * oficial que o ML ja usa para aquele modelo (fundo limpo, varios angulos), em
 * vez de um arquivo de dono desconhecido achado na web. Ela ilustra o modelo --
 * **nao** e foto do seu item, e por isso entra no fim da galeria e nunca como
 * capa (ver isOwnPhoto/addImage).
 *
 * Cobre produto de linha (eletronico, eletrodomestico, instrumento). Veiculo e
 * imovel nao tem catalogo: cada um e unico.
 */

export interface CatalogCandidate {
  /** URL da imagem, ja na melhor resolucao que o ML expoe. */
  url: string;
  /** Nome do produto no catalogo -- vira o rotulo da fonte na galeria. */
  label: string;
  /** Pagina do produto no catalogo, guardada como procedencia da imagem. */
  sourceUrl: string;
}

interface SearchResponse {
  results?: Array<{ id?: string; name?: string; status?: string }>;
}

interface ProductResponse {
  id?: string;
  name?: string;
  permalink?: string;
  pictures?: Array<{ id?: string; url?: string; max_width?: number }>;
}

/**
 * O ML serve a mesma imagem em vários tamanhos pelo sufixo do nome do arquivo
 * (`...-V.jpg`, `...-F.jpg`, `...-O.jpg`), sendo `-O` a original. A API nem
 * sempre devolve a maior, então tentamos a original primeiro -- mas sem confiar
 * nela: quem baixa usa esta lista em ordem e cai para a URL original da API se
 * a variante não existir. Chutar sufixo sem fallback daria 404.
 */
export function urlVariants(url: string): string[] {
  const original = url.replace(/-[A-Z](\.(jpg|jpeg|png|webp))$/i, '-O$1');
  return original === url ? [url] : [original, url];
}

/** Busca produtos do catalogo pelo titulo do anuncio. */
export async function searchCatalog(title: string, limit = 3) {
  const query = title.trim();
  if (query.length < 3) throw new ChannelError('escreva o titulo do produto antes de buscar fotos');

  const account = await ensureToken();
  const res = await request<SearchResponse>(`${ML_API}/products/search`, {
    headers: { authorization: `Bearer ${account.accessToken}` },
    query: { site_id: config.channels.mercadolivre.siteId, status: 'active', q: query },
  });
  return (res.results ?? [])
    .filter((r): r is { id: string; name?: string } => typeof r.id === 'string')
    .slice(0, limit);
}

/** Fotos de um produto do catalogo, prontas para virar candidatas na galeria. */
export async function catalogPictures(productId: string): Promise<CatalogCandidate[]> {
  const account = await ensureToken();
  const res = await request<ProductResponse>(`${ML_API}/products/${encodeURIComponent(productId)}`, {
    headers: { authorization: `Bearer ${account.accessToken}` },
  });

  const label = res.name?.trim() || productId;
  const sourceUrl = res.permalink ?? `https://www.mercadolivre.com.br/p/${productId}`;
  return (res.pictures ?? [])
    .map((p) => p.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((url) => ({ url, label, sourceUrl }));
}

/**
 * Candidatas para um titulo: junta as fotos dos primeiros produtos que o
 * catalogo devolve, sem repetir URL.
 */
export async function findCatalogImages(title: string, { maxProducts = 3, maxImages = 12 } = {}) {
  const produtos = await searchCatalog(title, maxProducts);
  const out: CatalogCandidate[] = [];
  const vistas = new Set<string>();

  for (const p of produtos) {
    let fotos: CatalogCandidate[];
    try {
      fotos = await catalogPictures(p.id);
    } catch {
      continue; // produto do catalogo sem detalhe acessivel nao derruba a busca
    }
    for (const f of fotos) {
      if (vistas.has(f.url)) continue;
      vistas.add(f.url);
      out.push(f);
      if (out.length >= maxImages) return out;
    }
  }
  return out;
}
