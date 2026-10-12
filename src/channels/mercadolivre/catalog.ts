import { request } from '../../lib/http.ts';
import { config } from '../../config.ts';
import type { Product } from '../../domain/product.ts';
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

/**
 * O que procurar no catalogo. O titulo do anuncio e ruim para isso: "PS4 500GB
 * CUH-22115A 2 Controles, Suporte e Jogos" traz palavras do que acompanha o
 * item, e a busca devolvia ventoinha de PS4. Marca + modelo descrevem o
 * produto; sem eles, vale o comeco do titulo, antes do que vem "junto".
 */
export function catalogQuery(product: Pick<Product, 'title' | 'attrs'>): string {
  const a = product.attrs as Record<string, unknown>;
  const marcaModelo = [a.brand, a.model].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  if (String(a.model ?? '').trim()) return marcaModelo;
  const cabeca = product.title.split(/,|\s+(?:com|c\/|\+|e|-|–|\|)\s+/i)[0]!.trim();
  return [a.brand, cabeca].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * Sinais de que o produto do catalogo e peca ou acessorio de outro, nao o
 * produto: "Ventilador Interno de Substituicao Compativel com Ps4 500gb".
 *
 * - palavra de peca em qualquer lugar do nome (compativel, substituicao...);
 * - ou o nome COMECA por um acessorio ("Capa...", "Controle...", "Cabo..."),
 *   porque o ML poe o tipo do produto primeiro. Num "Notebook ... Tela 15,6"
 *   a tela nao e o produto, e ele fica.
 *
 * Nada disso vale quando a propria busca pediu a palavra.
 */
const PECA = ['compativel', 'substituicao', 'reposicao', 'peca', 'pecas', 'replacement', 'generico'];
const ACESSORIO_NO_INICIO = [
  'ventilador', 'ventoinha', 'cooler', 'capa', 'case', 'pelicula', 'skin', 'adesivo', 'cabo', 'carregador',
  'fonte', 'suporte', 'base', 'controle', 'joystick', 'bateria', 'tela', 'display', 'placa', 'carcaca',
  'botao', 'refil', 'kit', 'protetor', 'bolsa', 'mochila', 'dock',
];

const tokens = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/**
 * Ordena os produtos do catalogo pelo quanto o nome bate com a busca, e tira os
 * que parecem peca ou acessorio quando a busca nao pediu um. Exportado para
 * teste.
 */
export function rankCatalog<T extends { name?: string }>(query: string, results: T[]): T[] {
  const q = new Set(tokens(query));
  return results
    .map((r, i) => {
      const nome = tokens(r.name ?? '');
      const acerto = nome.filter((t) => q.has(t)).length;
      const peca = nome.some((t) => PECA.includes(t) && !q.has(t))
        || (ACESSORIO_NO_INICIO.includes(nome[0] ?? '') && !q.has(nome[0]!));
      return { r, i, acerto, peca };
    })
    .filter((x) => !x.peca)
    // mais palavras em comum primeiro; empate fica na ordem do ML
    .sort((x, y) => y.acerto - x.acerto || x.i - y.i)
    .map((x) => x.r);
}

/** Dominio do ML para a busca (ex.: MLB-GAME_CONSOLES), para nao misturar produto com peca dele. */
async function predictDomain(query: string, token: string): Promise<string | undefined> {
  try {
    const res = await request<Array<{ domain_id?: string }>>(
      `${ML_API}/sites/${config.channels.mercadolivre.siteId}/domain_discovery/search`,
      { query: { q: query, limit: 1 }, headers: { authorization: `Bearer ${token}` } },
    );
    return res?.[0]?.domain_id;
  } catch {
    return undefined;
  }
}

/**
 * Busca produtos do catalogo para este item, do mais certeiro ao mais amplo:
 *
 * 1. codigo de barras (product_identifier): casa o modelo exato;
 * 2. marca + modelo, dentro do dominio do produto (console, celular...);
 * 3. a mesma busca sem dominio, se a anterior nao achar nada.
 *
 * Em 2 e 3 o resultado ainda passa pelo rankCatalog, que tira pecas e acessorios.
 */
export async function searchCatalog(product: Pick<Product, 'title' | 'attrs'>, limit = 3) {
  const query = catalogQuery(product);
  if (query.length < 3) throw new ChannelError('escreva o titulo do produto antes de buscar fotos');

  const account = await ensureToken();
  const token = account.accessToken!;
  const site = config.channels.mercadolivre.siteId;
  const buscar = async (extra: Record<string, string | undefined>) => {
    const res = await request<SearchResponse>(`${ML_API}/products/search`, {
      headers: { authorization: `Bearer ${token}` },
      query: { site_id: site, status: 'active', limit: 20, ...extra },
    });
    return (res.results ?? []).filter((r): r is { id: string; name?: string } => typeof r.id === 'string');
  };

  const gtin = String((product.attrs as Record<string, unknown>).gtin ?? '').trim();
  if (gtin) {
    try {
      const exato = await buscar({ product_identifier: gtin });
      if (exato.length) return exato.slice(0, limit);
    } catch {
      // codigo fora do catalogo: segue pela busca por nome
    }
  }

  const domain = await predictDomain(query, token);
  let achados = domain ? rankCatalog(query, await buscar({ q: query, domain_id: domain })) : [];
  if (!achados.length) achados = rankCatalog(query, await buscar({ q: query }));
  return achados.slice(0, limit);
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
 * Candidatas para um produto: junta as fotos dos produtos do catalogo que mais
 * se parecem com ele, sem repetir URL.
 */
export async function findCatalogImages(
  product: Pick<Product, 'title' | 'attrs'>,
  { maxProducts = 3, maxImages = 12 } = {},
) {
  const produtos = await searchCatalog(product, maxProducts);
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
