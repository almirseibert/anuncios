import { request } from '../../lib/http.ts';
import { ML_API } from './auth.ts';

/**
 * Atributos que cada categoria do Mercado Livre exige.
 *
 * Cada categoria tem a sua lista -- voltagem em console, cor em roupa,
 * capacidade em HD -- e o ML recusa o anuncio quando falta um. Em vez de um
 * campo fixo no formulario para cada caso (uma corrida sem fim), o painel
 * pergunta ao ML o que a categoria exige e monta os campos a partir disso,
 * com as opcoes que o proprio ML aceita.
 */

/** Atributo como /categories/:id/attributes devolve (so o que usamos). */
export interface MlCategoryAttribute {
  id: string;
  name: string;
  value_type?: string;
  values?: Array<{ id: string; name: string }>;
  allowed_units?: Array<{ id: string; name: string }>;
  default_unit?: string;
  tags?: Record<string, unknown>;
  hint?: string;
  tooltip?: string;
}

export type FieldType = 'list' | 'boolean' | 'number' | 'number_unit' | 'text';

/** Campo pronto para o painel desenhar. */
export interface FieldSpec {
  id: string;
  name: string;
  type: FieldType;
  /** true = obrigatorio sempre; false = obrigatorio so em alguns casos (conditional_required). */
  required: boolean;
  /** Opcoes do ML. Em `list`/`boolean` sao as unicas aceitas; em `text` sao sugestoes. */
  values: Array<{ id: string; name: string }>;
  units: Array<{ id: string; name: string }>;
  defaultUnit?: string;
  hint?: string;
}

const SIM_NAO = [{ id: '242085', name: 'Sim' }, { id: '242084', name: 'Não' }];

function tipo(a: MlCategoryAttribute): FieldType {
  switch (a.value_type) {
    case 'list': return 'list';
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'number_unit': return 'number_unit';
    default: return 'text';
  }
}

/**
 * Filtra os atributos obrigatorios (sempre ou condicionalmente) que ainda nao
 * foram preenchidos por outro caminho. `jaPreenchidos` sao os IDs que o
 * cadastro do produto ja manda (marca, modelo, GTIN...): mostra-los de novo
 * seria pedir a mesma informacao duas vezes.
 */
export function requiredFields(attrs: MlCategoryAttribute[], jaPreenchidos: ReadonlySet<string>): FieldSpec[] {
  return attrs
    .filter((a) => {
      const t = a.tags ?? {};
      if (t.read_only || t.hidden || t.fixed) return false;
      if (jaPreenchidos.has(a.id)) return false;
      return Boolean(t.required || t.conditional_required);
    })
    .map((a) => {
      const type = tipo(a);
      return {
        id: a.id,
        name: a.name,
        type,
        required: Boolean(a.tags?.required),
        values: type === 'boolean' && !a.values?.length ? SIM_NAO : (a.values ?? []),
        units: a.allowed_units ?? [],
        defaultUnit: a.default_unit,
        hint: a.hint ?? a.tooltip,
      };
    })
    // obrigatorios primeiro, depois os condicionais
    .sort((x, y) => Number(y.required) - Number(x.required));
}

export async function fetchCategory(categoryId: string, token: string) {
  const c = await request<{ id: string; name: string; path_from_root?: Array<{ name: string }> }>(
    `${ML_API}/categories/${encodeURIComponent(categoryId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return {
    id: c.id,
    name: c.name,
    path: (c.path_from_root ?? []).map((p) => p.name).join(' > ') || c.name,
  };
}

export async function fetchCategoryAttributes(categoryId: string, token: string) {
  return request<MlCategoryAttribute[]>(
    `${ML_API}/categories/${encodeURIComponent(categoryId)}/attributes`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}
