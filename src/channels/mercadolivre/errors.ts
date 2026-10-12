import { ChannelError } from '../types.ts';

/**
 * Onde cada atributo do ML e preenchido no nosso formulario. Quando a categoria
 * exige um atributo, a resposta do ML diz so o ID ("[GTIN]"); isto traduz para
 * o campo que o vendedor precisa preencher.
 */
const CAMPO_DO_ATRIBUTO: Record<string, string> = {
  GTIN: 'Código de barras (EAN) — fica na caixa ou na etiqueta do produto',
  BRAND: 'Marca',
  MODEL: 'Modelo',
};

interface MlCause { code?: string; message?: string }

/** Atributos que o ML disse estarem faltando, extraidos de "The attributes [A, B] are required...". */
export function atributosFaltando(detail: unknown): string[] {
  const causas = (detail as { cause?: MlCause[] } | undefined)?.cause ?? [];
  const ids = new Set<string>();
  for (const c of causas) {
    // O ML usa as duas formas: "item.attribute.missing_conditional_required"
    // (GTIN) e "item.attributes.missing_required" (VOLTAGE).
    if (!/^item\.attributes?\.missing/.test(c.code ?? '')) continue;
    const lista = /\[([^\]]+)\]/.exec(c.message ?? '')?.[1];
    for (const id of (lista ?? '').split(',').map((s) => s.trim()).filter(Boolean)) ids.add(id);
  }
  return [...ids];
}

/** Frase em portugues dizendo o que preencher, ou undefined se o erro nao for desse tipo. */
export function dicaDoErro(detail: unknown): string | undefined {
  const faltando = atributosFaltando(detail);
  if (!faltando.length) return undefined;
  const doCadastro = faltando.filter((id) => CAMPO_DO_ATRIBUTO[id]);
  const daCategoria = faltando.filter((id) => !CAMPO_DO_ATRIBUTO[id]);
  const frases: string[] = [];
  if (doCadastro.length) {
    frases.push(`Preencha no cadastro do produto: ${doCadastro.map((id) => `"${CAMPO_DO_ATRIBUTO[id]}"`).join('; ')}.`);
  }
  if (daCategoria.length) {
    // atributos proprios da categoria: o painel pergunta ao ML e mostra o campo
    frases.push(`Abra "Atributos do Mercado Livre" no produto e preencha: ${daCategoria.join(', ')}.`);
  }
  return frases.join(' ');
}

/**
 * Devolve o mesmo erro com a dica NA FRENTE da mensagem -- o texto do ML vem em
 * ingles e longo, e o que o vendedor precisa ler primeiro e o que fazer. O
 * detalhe cru continua inteiro no bloco "Resposta da plataforma".
 */
export function comDica(err: unknown): unknown {
  if (!(err instanceof ChannelError)) return err;
  const dica = dicaDoErro(err.detail);
  return dica ? new ChannelError(`${dica} Resposta do ML: ${err.message}`, err.detail) : err;
}
