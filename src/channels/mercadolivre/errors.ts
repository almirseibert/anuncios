import { ChannelError, type ListingStatus } from '../types.ts';

/**
 * Onde cada atributo do ML e preenchido no nosso formulario. Quando a categoria
 * exige um atributo, a resposta do ML diz so o ID ("[GTIN]"); isto traduz para
 * o campo que o vendedor precisa preencher.
 */
const CAMPO_DO_ATRIBUTO: Record<string, string> = {
  GTIN: 'Código de barras (EAN) — fica na caixa ou na etiqueta do produto; sem a caixa, use "Procurar no catálogo do ML" ao lado do campo',
  BRAND: 'Marca',
  MODEL: 'Modelo',
};

interface MlCause { code?: string; message?: string; department?: string; type?: string }

function causas(detail: unknown): MlCause[] {
  const c = (detail as { cause?: unknown } | undefined)?.cause;
  return Array.isArray(c) ? (c as MlCause[]) : [];
}

const ATIVAR_ENVIOS = 'confira se o Mercado Envios esta ativo na sua conta do ML (Minha conta > Configuracoes > '
  + 'Preferencias de venda > Formas de entrega)';

/**
 * Erros que nao sao de atributo, em portugues. Inclui avisos (type "warning"):
 * o ML ja recusou anuncio com um "warning" como unica causa
 * (shipping.lost_me1_by_user), entao aviso tambem pode bloquear.
 */
function outrasDicas(detail: unknown): string[] {
  const dicas = new Set<string>();
  for (const c of causas(detail)) {
    const code = c.code ?? '';
    const msg = c.message ?? '';
    if (code === 'shipping.lost_me1_by_user' || /has not mode me1/i.test(msg)) {
      dicas.add('O ML tentou usar um modo de envio (me1) que sua conta nao tem. O sistema agora manda o modo '
        + `da sua conta (Mercado Envios, me2); se o erro continuar, ${ATIVAR_ENVIOS}.`);
    } else if (/me2 adoption is mandatory|has not mode me2/i.test(msg)) {
      dicas.add(`O ML exige Mercado Envios para esta conta ou categoria: ${ATIVAR_ENVIOS}.`);
    } else if (code.startsWith('shipping.') || c.department === 'shipping' || code.startsWith('item.shipping')) {
      dicas.add(`Problema no envio ("${msg || code}"): ${ATIVAR_ENVIOS}.`);
    } else if (code.startsWith('item.location')) {
      dicas.add('O ML nao aceitou a localizacao: confira cidade e UF (sigla, ex.: RS) no cadastro do produto.');
    } else if (code.includes('listing_type')) {
      dicas.add('O tipo de anuncio nao esta disponivel para sua conta nesta categoria.');
    } else if (code.startsWith('item.pictures') || code.includes('picture')) {
      dicas.add('O ML nao conseguiu usar as fotos: confira se PUBLIC_URL e o endereco publico (https) do sistema '
        + 'e se as fotos abrem no navegador sem senha.');
    } else if (code.startsWith('item.price')) {
      dicas.add('O preco nao foi aceito pelo ML para esta categoria.');
    } else if (code.includes('seller') || code.includes('user.')) {
      dicas.add('O ML recusou por causa da conta do vendedor: abra o Mercado Livre, em Minha conta, e veja se ha '
        + 'pendencia de cadastro (endereco, documento, telefone).');
    }
  }
  return [...dicas];
}

/** Atributos que o ML disse estarem faltando, extraidos de "The attributes [A, B] are required...". */
export function atributosFaltando(detail: unknown): string[] {
  const ids = new Set<string>();
  for (const c of causas(detail)) {
    // O ML usa as duas formas: "item.attribute.missing_conditional_required"
    // (GTIN) e "item.attributes.missing_required" (VOLTAGE).
    if (!/^item\.attributes?\.missing/.test(c.code ?? '')) continue;
    const lista = /\[([^\]]+)\]/.exec(c.message ?? '')?.[1];
    for (const id of (lista ?? '').split(',').map((s) => s.trim()).filter(Boolean)) ids.add(id);
  }
  return [...ids];
}

/**
 * Frase em portugues dizendo o que fazer, ou undefined se o erro nao for de um
 * tipo conhecido. `jaAvisados` sao atributos que a pre-checagem ja mandou
 * preencher (pelo nome): nao repete.
 */
export function dicaDoErro(detail: unknown, jaAvisados: ReadonlySet<string> = new Set()): string | undefined {
  const faltando = atributosFaltando(detail).filter((id) => !jaAvisados.has(id));
  const doCadastro = faltando.filter((id) => CAMPO_DO_ATRIBUTO[id]);
  const daCategoria = faltando.filter((id) => !CAMPO_DO_ATRIBUTO[id]);
  const frases: string[] = [];
  if (doCadastro.length) {
    frases.push(`Preencha no cadastro do produto: ${doCadastro.map((id) => `"${CAMPO_DO_ATRIBUTO[id]}"`).join('; ')}.`);
  }
  if (daCategoria.length) {
    // atributos proprios da categoria: o painel pergunta ao ML e mostra o campo
    frases.push(`Em "Editar" no produto, preencha em "Atributos do Mercado Livre": ${daCategoria.join(', ')}.`);
  }
  frases.push(...outrasDicas(detail));
  return frases.length ? frases.join(' ') : undefined;
}

/**
 * Devolve o mesmo erro com a dica NA FRENTE da mensagem -- o texto do ML vem em
 * ingles e longo, e o que o vendedor precisa ler primeiro e o que fazer. O
 * detalhe cru continua inteiro no bloco "Resposta da plataforma".
 */
export function comDica(err: unknown, jaAvisados?: ReadonlySet<string>): unknown {
  if (!(err instanceof ChannelError)) return err;
  const dica = dicaDoErro(err.detail, jaAvisados);
  return dica ? new ChannelError(`${dica}\nResposta do ML: ${err.message}`, err.detail) : err;
}

/**
 * O que o status do anuncio no ML significa aqui. Criar nao e o mesmo que
 * estar no ar: veiculo nasce "payment_required" (a tarifa do anuncio e paga no
 * site do ML), e qualquer anuncio pode cair em revisao. Nesses casos o listing
 * fica como rascunho, com o aviso do que fazer -- "publicado" seria mentira.
 */
export function situacaoNoMl(status: string | undefined): { status: ListingStatus; aviso?: string } {
  switch (status) {
    case undefined:
    case '':
    case 'active':
      return { status: 'publicado' };
    case 'payment_required':
      return {
        status: 'rascunho',
        aviso: 'O ML criou o anuncio, mas ele so vai ao ar depois que voce pagar a tarifa de publicacao '
          + '(cobrada em anuncio de veiculo). No site do ML, abra Vendas > Anuncios (ou o link do anuncio) '
          + 'e conclua o pagamento.',
      };
    case 'under_review':
      return { status: 'rascunho', aviso: 'O ML esta revisando o anuncio; ele entra no ar quando a revisao terminar.' };
    case 'paused':
      return { status: 'pausado', aviso: 'O anuncio esta pausado no ML.' };
    case 'closed':
      return { status: 'encerrado', aviso: 'O anuncio esta encerrado no ML.' };
    default:
      return { status: 'rascunho', aviso: `O anuncio existe, mas nao esta ativo no ML (status "${status}"): confira no site.` };
  }
}
