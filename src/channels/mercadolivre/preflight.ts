import { request } from '../../lib/http.ts';
import type { Product } from '../../domain/product.ts';
import { ML_API } from './auth.ts';
import { fetchCategoryAttributes, requiredFields } from './categoryAttrs.ts';
import { allAttributes, formAttributeIds, type MlShipping } from './map.ts';

/**
 * Pre-checagem da conta e da categoria antes de montar o anuncio.
 *
 * O /items/validate do ML devolve um erro de cada vez, e cada rodada revelava
 * uma regra nova (secao 3 do docs/ANDAMENTO.md). Aqui o sistema pergunta ao
 * ML, de uma vez, tudo o que depende da conta do vendedor e da categoria:
 *
 * - a conta pode anunciar? (GET /users/me -> status.list / status.sell)
 * - que modos de envio a conta tem? (GET /users/:id/shipping_preferences)
 *   Anuncio sem `shipping` faz o ML escolher um modo sozinho, e ele escolheu
 *   me1, que a conta nao tem: "shipping.lost_me1_by_user".
 * - que tipos de anuncio a conta pode usar nesta categoria?
 *   (GET /users/:id/available_listing_types?category_id=)
 * - que atributos obrigatorios da categoria ainda faltam?
 *
 * Uma consulta que falhar nao bloqueia nada: quem da a palavra final e o
 * /items/validate. A pre-checagem so serve para escolher o certo e avisar tudo
 * de uma vez.
 */

/** Acima disto o ML obriga frete gratis no Mercado Envios (MLB), pago em parte pelo vendedor. */
export const FRETE_GRATIS_OBRIGATORIO_CENTS = 7900;

export interface Preflight {
  shipping?: MlShipping;
  listingTypeId?: string;
  /** Impedem a publicacao: o vendedor precisa resolver antes. */
  problemas: string[];
  /** Informam o que foi escolhido e o que custa. */
  avisos: string[];
  /** IDs de atributo ja cobrados em `problemas`, para o erro do ML nao repeti-los. */
  atributosCobrados: string[];
}

interface MlUser {
  id: number;
  status?: {
    list?: { allow?: boolean; codes?: string[] };
    sell?: { allow?: boolean; codes?: string[] };
  };
}

/** Motivos que o ML devolve em status.list/sell.codes, em portugues. */
const MOTIVO_CONTA: Record<string, string> = {
  address_pending: 'endereco pendente',
  address_empty: 'endereco nao cadastrado',
  phone_pending: 'telefone pendente',
  identification_pending: 'documento (CPF) nao confirmado',
  identity_pending: 'identidade nao validada',
  user_not_verified: 'conta nao verificada',
  pending_terms_and_conditions: 'termos de uso nao aceitos',
  user_restricted: 'conta com restricao',
};

const PREFERENCIA_TIPO = ['gold_special', 'gold_pro'];

async function tentar<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}

/**
 * Escolhe o envio a partir dos modos que a conta tem. Exportado para teste.
 *
 * - me2 (Mercado Envios): o normal. `free_methods: []` vai explicito, como no
 *   payload documentado do ML (outro integrador relatou o mesmo
 *   lost_me1_by_user com me2 escolhido e sem esse campo).
 * - sem me2: "a combinar" (not_specified), com retirada no local. Em muitas
 *   categorias o ML exige Mercado Envios; a mensagem diz como ativar.
 */
export function chooseShipping(
  product: Product,
  prefs: { modes?: string[]; local_pick_up?: boolean } | undefined,
): { shipping?: MlShipping; problemas: string[]; avisos: string[] } {
  const problemas: string[] = [];
  const avisos: string[] = [];
  if (product.kind !== 'geral') return { problemas, avisos };

  const modos = Array.isArray(prefs?.modes) ? prefs.modes : undefined;
  // Sem conseguir ler as preferencias, me2 e o que quase toda conta brasileira tem.
  if (!modos || modos.includes('me2')) {
    const freteGratis = product.priceCents >= FRETE_GRATIS_OBRIGATORIO_CENTS;
    if (freteGratis) {
      avisos.push('Envio pelo Mercado Envios com frete gratis: acima de R$ 79 o ML obriga, e cobra parte do '
        + 'frete de voce na venda. Considere isso no preco.');
    }
    return {
      shipping: {
        mode: 'me2',
        local_pick_up: Boolean(prefs?.local_pick_up),
        free_shipping: freteGratis,
        free_methods: [],
      },
      problemas,
      avisos,
    };
  }

  const ativar = 'Ative o Mercado Envios na sua conta do ML (Minha conta > Configuracoes > Preferencias de '
    + 'venda > Formas de entrega) e tente de novo.';
  if (modos.includes('not_specified')) {
    avisos.push(`Sua conta nao tem Mercado Envios: o anuncio sai com frete a combinar e retirada no local. `
      + `Se o ML recusar por isso, ${ativar.charAt(0).toLowerCase()}${ativar.slice(1)}`);
    return {
      shipping: { mode: 'not_specified', local_pick_up: true, free_shipping: false },
      problemas,
      avisos,
    };
  }
  problemas.push(`Sua conta do ML nao tem nenhum modo de envio que permita publicar (tem: ${modos.join(', ') || 'nenhum'}). ${ativar}`);
  return { problemas, avisos };
}

/** Escolhe o tipo de anuncio entre os que a conta pode usar na categoria. Exportado para teste. */
export function chooseListingType(desejado: string, disponiveis: string[] | undefined) {
  if (!disponiveis?.length || disponiveis.includes(desejado)) return { id: desejado };
  const id = [desejado, ...PREFERENCIA_TIPO].find((t) => disponiveis.includes(t)) ?? disponiveis[0]!;
  return { id, aviso: `O tipo de anuncio "${desejado}" nao esta disponivel para sua conta nesta categoria; vai como "${id}".` };
}

/**
 * Atributos obrigatorios da categoria que nem o cadastro nem o painel
 * preencheram, separados por onde o vendedor os preenche. ITEM_CONDITION o ML
 * tira de `condition`.
 */
export function missingRequired(product: Product, attrs: Parameters<typeof requiredFields>[0]) {
  const preenchidos = new Set([...allAttributes(product).map((a) => a.id), 'ITEM_CONDITION']);
  const faltando = requiredFields(attrs, preenchidos).filter((f) => f.required);
  const doCadastro = formAttributeIds(product);
  return {
    cadastro: faltando.filter((f) => doCadastro.has(f.id)),
    painel: faltando.filter((f) => !doCadastro.has(f.id)),
  };
}

export async function preflight(
  product: Product,
  categoryId: string | undefined,
  listingTypeDesejado: string,
  token: string,
): Promise<Preflight> {
  const headers = { authorization: `Bearer ${token}` };
  const problemas: string[] = [];
  const avisos: string[] = [];

  const me = await tentar(() => request<MlUser>(`${ML_API}/users/me`, { headers }));
  for (const [acao, st] of [['anunciar', me?.status?.list], ['vender', me?.status?.sell]] as const) {
    if (st?.allow === false) {
      const motivos = (st.codes ?? []).map((c) => MOTIVO_CONTA[c] ?? c).join(', ');
      problemas.push(`O ML nao deixa esta conta ${acao}${motivos ? ` (${motivos})` : ''}. `
        + 'Resolva no site do Mercado Livre, em Minha conta, e tente de novo.');
    }
  }

  const [prefs, tipos, atributos] = await Promise.all([
    me ? tentar(() => request<{ modes?: string[]; local_pick_up?: boolean }>(
      `${ML_API}/users/${me.id}/shipping_preferences`, { headers })) : undefined,
    me && categoryId ? tentar(() => request<{ available?: Array<{ id: string }> }>(
      `${ML_API}/users/${me.id}/available_listing_types`, { headers, query: { category_id: categoryId } })) : undefined,
    categoryId && product.kind === 'geral'
      ? tentar(() => fetchCategoryAttributes(categoryId, token)) : undefined,
  ]);

  const envio = chooseShipping(product, prefs);
  problemas.push(...envio.problemas);
  avisos.push(...envio.avisos);

  const tipo = chooseListingType(
    listingTypeDesejado,
    Array.isArray(tipos?.available) ? tipos.available.map((t) => t.id) : undefined,
  );
  if (tipo.aviso) avisos.push(tipo.aviso);

  const atributosCobrados: string[] = [];
  if (Array.isArray(atributos)) {
    const { cadastro, painel } = missingRequired(product, atributos);
    atributosCobrados.push(...cadastro.map((f) => f.id), ...painel.map((f) => f.id));
    if (cadastro.length) {
      problemas.push(`Preencha no cadastro do produto: ${cadastro.map((f) => f.name).join(', ')}.`);
    }
    if (painel.length) {
      problemas.push('Abra "Atributos do Mercado Livre" no produto e preencha: '
        + `${painel.map((f) => f.name).join(', ')}.`);
    }
  }

  return { shipping: envio.shipping, listingTypeId: tipo.id, problemas, avisos, atributosCobrados };
}
