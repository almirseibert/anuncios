import { request } from '../../lib/http.ts';
import { config } from '../../config.ts';
import type { Product } from '../../domain/product.ts';
import { ChannelError } from '../types.ts';
import { ML_API } from './auth.ts';

/**
 * Localizacao de classificados (veiculo, imovel).
 *
 * O ML recusa o anuncio sem a localizacao completa ate a cidade --
 * "Field 'location' requires up to city level. [country.name: , state.name: RS,
 * city.name: Lajeado]" -- e ela vai com os IDs do proprio ML, do recurso
 * classified_locations: pais -> estado -> cidade -> bairro. Aqui o cadastro
 * (UF, cidade, bairro) e convertido nesses IDs, comparando os nomes.
 */

const UF_NOME: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

interface Lugar { id: string; name: string }

/** "São Paulo", "sao paulo", "SÃO  PAULO" -> "sao paulo". */
export const normalizar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function achar(lista: Lugar[] | undefined, nome: string): Lugar | undefined {
  const alvo = normalizar(nome);
  return alvo ? (lista ?? []).find((l) => normalizar(l.name) === alvo) : undefined;
}

export interface MlLocation {
  address_line: string;
  zip_code: string;
  country: Lugar;
  state: Lugar;
  city: Lugar;
  neighborhood?: Lugar;
}

// Estados e cidades quase nao mudam: guarda por processo, para nao repetir a consulta a cada publicacao.
const cache = new Map<string, unknown>();
async function buscar<T>(path: string, token: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(path, await request<T>(`${ML_API}${path}`, { headers: { authorization: `Bearer ${token}` } }));
  }
  return cache.get(path) as T;
}

/** Exportado para teste: esvazia o cache entre cenarios. */
export function limparCacheLocalizacao() { cache.clear(); }

export async function resolveLocation(product: Product, token: string): Promise<MlLocation> {
  const uf = (product.uf || config.seller.uf).trim().toUpperCase();
  const cidade = (product.city || config.seller.city).trim();
  const bairro = product.neighborhood.trim();
  if (!uf || !cidade) {
    throw new ChannelError('o Mercado Livre exige a localizacao do anuncio: preencha cidade e UF no cadastro do produto');
  }

  const pais = await buscar<{ id: string; name: string; states?: Lugar[] }>('/classified_locations/countries/BR', token);
  const estado = achar(pais.states, UF_NOME[uf] ?? uf);
  if (!estado) throw new ChannelError(`UF "${uf}" nao encontrada na lista de estados do Mercado Livre: confira a UF no cadastro`);

  const doEstado = await buscar<{ cities?: Lugar[] }>(`/classified_locations/states/${encodeURIComponent(estado.id)}`, token);
  const city = achar(doEstado.cities, cidade);
  if (!city) {
    throw new ChannelError(`cidade "${cidade}" nao encontrada no Mercado Livre para ${uf}: confira a grafia no cadastro do produto`);
  }

  // Bairro e opcional: se nao bater com a lista do ML, o anuncio vai so ate a cidade.
  let neighborhood: Lugar | undefined;
  if (bairro) {
    try {
      const daCidade = await buscar<{ neighborhoods?: Lugar[] }>(`/classified_locations/cities/${encodeURIComponent(city.id)}`, token);
      neighborhood = achar(daCidade.neighborhoods, bairro);
    } catch {
      // sem lista de bairros: fica na cidade
    }
  }

  return {
    address_line: [bairro, cidade].filter(Boolean).join(', '),
    zip_code: (product.cep || config.seller.cep).replace(/\D/g, ''),
    country: { id: pais.id || 'BR', name: pais.name || 'Brasil' },
    state: { id: estado.id, name: estado.name },
    city: { id: city.id, name: city.name },
    ...(neighborhood ? { neighborhood: { id: neighborhood.id, name: neighborhood.name } } : {}),
  };
}
