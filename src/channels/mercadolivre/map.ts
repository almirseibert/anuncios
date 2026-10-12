import { config } from '../../config.ts';
import { request } from '../../lib/http.ts';
import { buildDescription } from '../../services/templates.ts';
import type { Product } from '../../domain/product.ts';
import { ML_API } from './auth.ts';

const FUEL: Record<string, string> = {
  flex: 'Flex', gasolina: 'Gasolina', etanol: 'Etanol/Alcool', diesel: 'Diesel',
  gnv: 'GNV', eletrico: 'Eletrico', hibrido: 'Hibrido',
};
const TRANS: Record<string, string> = {
  manual: 'Manual', automatico: 'Automatica', automatizado: 'Automatica sequencial', cvt: 'CVT',
};
const PROPERTY: Record<string, string> = {
  apartamento: 'Apartamento', casa: 'Casa', terreno: 'Terrenos e lotes',
  comercial: 'Comercial', rural: 'Chacaras e sitios', galpao: 'Galpao',
};
const OPERATION: Record<string, string> = { venda: 'Venda', aluguel: 'Aluguel', temporada: 'Aluguel por temporada' };

export interface MlAttribute { id: string; value_name: string }

/** Pergunta ao ML qual categoria melhor descreve o titulo (domain discovery). */
export async function predictCategory(title: string, token: string): Promise<string | undefined> {
  const res = await request<Array<{ category_id?: string }>>(
    `${ML_API}/sites/${config.channels.mercadolivre.siteId}/domain_discovery/search`,
    { query: { q: title, limit: 1 }, headers: { authorization: `Bearer ${token}` } },
  );
  return res?.[0]?.category_id;
}

function attrs(product: Product): MlAttribute[] {
  const a = product.attrs as Record<string, unknown>;
  const out: MlAttribute[] = [];
  const push = (id: string, value: unknown) => {
    if (value === undefined || value === null || value === '' || value === 0) return;
    out.push({ id, value_name: String(value) });
  };

  if (product.kind === 'veiculo') {
    push('BRAND', a.brand);
    push('MODEL', a.model);
    push('TRIM', a.version);
    push('VEHICLE_YEAR', a.yearModel);
    push('MANUFACTURING_YEAR', a.yearManufacture);
    push('KILOMETERS', typeof a.km === 'number' ? `${a.km} km` : undefined);
    push('FUEL_TYPE', FUEL[String(a.fuel)]);
    push('TRANSMISSION', TRANS[String(a.transmission)]);
    push('COLOR', a.color);
    push('DOORS', a.doors);
  } else if (product.kind === 'imovel') {
    push('OPERATION', OPERATION[String(a.operation)]);
    push('PROPERTY_TYPE', PROPERTY[String(a.propertyType)]);
    push('TOTAL_AREA', a.totalAreaM2 ? `${a.totalAreaM2} m²` : undefined);
    push('COVERED_AREA', a.usableAreaM2 ? `${a.usableAreaM2} m²` : undefined);
    push('BEDROOMS', a.bedrooms);
    push('FULL_BATHROOMS', a.bathrooms);
    push('SUITES', a.suites);
    push('PARKING_LOTS', a.parkingSpots);
    push('MAINTENANCE_FEE', a.condoFeeCents ? (a.condoFeeCents as number) / 100 : undefined);
  } else {
    push('BRAND', a.brand);
    push('MODEL', a.model);
  }
  return out;
}

/**
 * Nome generico da familia do produto, obrigatorio no modelo de publicacao
 * atual do Mercado Livre (sem ele a API responde
 * "body does not contains ... [family_name]").
 *
 * Diferente do titulo: o titulo e o anuncio deste item ("Playstation 4 Slim
 * 1TB com 2 controles, pouco uso"), a familia e o produto em si ("Sony
 * Playstation 4 Slim"). E o que agrupa variacoes do mesmo produto.
 */
export function familyName(product: Product): string {
  const a = product.attrs as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? '').trim();
  let partes: string[];

  if (product.kind === 'veiculo') {
    partes = [str(a.brand), str(a.model), str(a.version)];
  } else if (product.kind === 'imovel') {
    partes = [PROPERTY[str(a.propertyType)] ?? str(a.propertyType), product.city || config.seller.city];
  } else {
    partes = [str(a.brand), str(a.model)];
  }

  const nome = partes.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  // Sem marca/modelo preenchidos, o titulo e a melhor descricao que temos.
  return (nome || product.title).slice(0, 60).trim();
}

/**
 * Garantia. O Mercado Livre exige WARRANTY_TYPE na maioria das categorias de
 * produto -- anuncio sem isso e recusado por sale_terms. "Sem garantia" e o
 * valor correto para usado de pessoa fisica, e e o que vale quando voce nao
 * preencheu nada; dizer outra coisa seria prometer o que voce nao ofereceu.
 *
 * Classificados (veiculo, imovel) nao usam sale_terms.
 */
export function saleTerms(product: Product): MlAttribute[] {
  if (product.kind !== 'geral') return [];
  const garantia = String((product.attrs as Record<string, unknown>).warranty ?? '').trim();
  if (!garantia) return [{ id: 'WARRANTY_TYPE', value_name: 'Sem garantia' }];

  const termos: MlAttribute[] = [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }];
  // O ML so aceita prazo no formato "N dias/meses/anos"; texto livre fica de fora
  // (vai na descricao, que o comprador le de qualquer jeito).
  const prazo = /^(\d+)\s*(dias?|m[eê]s|meses|anos?)$/i.exec(garantia);
  if (prazo) termos.push({ id: 'WARRANTY_TIME', value_name: `${prazo[1]} ${prazo[2]!.toLowerCase()}` });
  return termos;
}

/** Tipo de exposicao: veiculos e imoveis usam listagens de classificados. */
function listingTypeId(product: Product) {
  return product.kind === 'geral' ? 'gold_special' : 'silver';
}

export interface MlItemPayload {
  title: string;
  /** Nome do produto (familia). Obrigatorio na API de items desde 2025. */
  family_name: string;
  category_id?: string;
  price: number;
  currency_id: 'BRL';
  available_quantity: number;
  buying_mode: 'buy_it_now' | 'classified';
  condition: 'new' | 'used';
  listing_type_id: string;
  description: { plain_text: string };
  pictures: Array<{ source: string }>;
  attributes: MlAttribute[];
  sale_terms?: MlAttribute[];
  location?: Record<string, unknown>;
}

export function buildItem(product: Product, categoryId?: string): MlItemPayload {
  const isClassified = product.kind !== 'geral';
  return {
    title: product.title.slice(0, 60),
    family_name: familyName(product),
    category_id: categoryId,
    price: product.priceCents / 100,
    currency_id: 'BRL',
    available_quantity: isClassified ? 1 : product.quantity,
    buying_mode: isClassified ? 'classified' : 'buy_it_now',
    condition: product.condition === 'novo' ? 'new' : 'used',
    listing_type_id: listingTypeId(product),
    description: { plain_text: buildDescription(product) },
    pictures: product.images.map((i) => ({ source: i.url })),
    attributes: attrs(product),
    ...(isClassified ? {} : { sale_terms: saleTerms(product) }),
    ...(isClassified
      ? {
          location: {
            address_line: [product.neighborhood, product.city].filter(Boolean).join(', '),
            zip_code: (product.cep || config.seller.cep).replace(/\D/g, ''),
            city: { name: product.city || config.seller.city },
            state: { name: product.uf || config.seller.uf },
            neighborhood: { name: product.neighborhood },
          },
        }
      : {}),
  };
}
