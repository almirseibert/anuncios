import { z } from 'zod';
import { config } from '../config.ts';
import { request } from '../lib/http.ts';
import { ChannelError } from '../channels/types.ts';
import type { Kind, Product } from '../domain/product.ts';
import { formatBRL } from '../domain/product.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Schema que o Gemini deve devolver. Mantido deliberadamente estreito: o modelo
 * escreve o texto, mas quem valida o produto continua sendo o zod do dominio.
 */
const draftSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(20),
  highlights: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  attrs: z.record(z.unknown()).default({}),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});

export type AiDraft = z.infer<typeof draftSchema>;

/** Campos de attrs que o modelo pode preencher, por tipo de anuncio. */
const ATTR_FIELDS: Record<Kind, Record<string, { type: string; enum?: string[]; description: string }>> = {
  geral: {
    brand: { type: 'string', description: 'marca, vazio se nao informada' },
    model: { type: 'string', description: 'modelo, vazio se nao informado' },
    wear: {
      type: 'string',
      enum: ['novo', 'seminovo', 'bom', 'usado_marcas', 'para_reparo'],
      description: 'estado de conservacao inferido do que o vendedor contou',
    },
    warranty: { type: 'string', description: 'garantia restante, vazio se nao informada' },
  },
  veiculo: {
    vehicleType: { type: 'string', enum: ['carro', 'moto', 'caminhao', 'onibus', 'outro'], description: 'tipo' },
    brand: { type: 'string', description: 'marca' },
    model: { type: 'string', description: 'modelo' },
    version: { type: 'string', description: 'versao/acabamento, vazio se nao informado' },
    color: { type: 'string', description: 'cor, vazio se nao informada' },
    fuel: {
      type: 'string',
      enum: ['flex', 'gasolina', 'etanol', 'diesel', 'gnv', 'eletrico', 'hibrido'],
      description: 'combustivel',
    },
    transmission: {
      type: 'string',
      enum: ['manual', 'automatico', 'automatizado', 'cvt'],
      description: 'cambio',
    },
  },
  imovel: {
    operation: { type: 'string', enum: ['venda', 'aluguel', 'temporada'], description: 'operacao' },
    propertyType: {
      type: 'string',
      enum: ['apartamento', 'casa', 'terreno', 'comercial', 'rural', 'galpao'],
      description: 'tipo do imovel',
    },
  },
};

function responseSchema(kind: Kind) {
  const attrProps: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(ATTR_FIELDS[kind])) {
    attrProps[key] = spec.enum
      ? { type: 'STRING', enum: spec.enum, description: spec.description }
      : { type: 'STRING', description: spec.description };
  }
  return {
    type: 'OBJECT',
    properties: {
      title: {
        type: 'STRING',
        description: 'titulo de ate 60 caracteres, com os termos que o comprador digita na busca',
      },
      description: { type: 'STRING', description: 'descricao completa do anuncio, pronta para publicar' },
      highlights: { type: 'ARRAY', items: { type: 'STRING' }, description: '3 a 6 pontos fortes curtos' },
      keywords: { type: 'ARRAY', items: { type: 'STRING' }, description: 'termos de busca relacionados' },
      attrs: { type: 'OBJECT', properties: attrProps },
      assumptions: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'o que foi deduzido e nao foi dito literalmente pelo vendedor',
      },
      questions: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'informacoes que faltam e aumentariam a chance de venda',
      },
    },
    required: ['title', 'description', 'highlights', 'keywords', 'attrs', 'assumptions', 'questions'],
  };
}

const SYSTEM = `Voce escreve anuncios de venda para marketplaces brasileiros (Mercado Livre, OLX, grupos do Facebook).

Objetivo: anuncio que vende rapido, que passa confianca e que aparece na busca.

REGRAS DE CONTEUDO
- Use SOMENTE fatos que o vendedor informou. Nunca invente acessorios, nota fiscal, caixa, garantia, quilometragem, ano, metragem ou defeito que nao foram ditos.
- Deduzir a partir do que foi dito e permitido e desejavel. Se o vendedor diz que esta vendendo porque comprou um modelo mais novo, isso indica que o produto foi bem cuidado e esta em otimo estado, e o motivo da venda tranquiliza o comprador: escreva isso de forma natural.
- Toda deducao que nao foi dita literalmente entra em "assumptions", para o vendedor conferir.
- O que falta e ajudaria a vender (ex: quantidade de controles, se tem caixa, km real) entra em "questions".

ESTILO
- Portugues do Brasil, direto, honesto, sem exagero publicitario ("IMPERDIVEL!!!", "OPORTUNIDADE UNICA") e sem emojis em excesso.
- Primeira linha da descricao: o que e o produto e em que estado esta.
- Depois: um bloco curto de caracteristicas, o motivo da venda quando informado, e o que esta incluso.
- Fecho com uma linha convidando ao contato, sem prometer condicao de pagamento ou entrega que o vendedor nao citou.
- Nada de preco dentro da descricao: o preco e campo separado.
- Titulo: ate 60 caracteres, comecando pelo que se busca (marca + modelo + caracteristica principal). Sem CAIXA ALTA inteira e sem pontuacao decorativa.`;

export interface DraftRequest {
  kind: Kind;
  /** O que o vendedor escreveu: nome do produto e qualquer contexto livre. */
  input: string;
  priceCents?: number;
  city?: string;
  uf?: string;
  /** Anuncio ja existente, quando o pedido e de melhoria. */
  current?: Pick<Product, 'title' | 'description' | 'attrs'>;
}

function buildPrompt(req: DraftRequest) {
  const lines = [
    `Tipo de anuncio: ${req.kind}.`,
    `O vendedor informou: """${req.input.trim()}"""`,
  ];
  if (req.priceCents) lines.push(`Preco pedido: ${formatBRL(req.priceCents)} (nao repita o preco na descricao).`);
  if (req.city || req.uf) lines.push(`Regiao: ${[req.city, req.uf].filter(Boolean).join('/')}.`);
  if (req.current) {
    lines.push(
      'Existe um anuncio atual que deve ser melhorado, mantendo os fatos dele:',
      `titulo atual: ${req.current.title}`,
      `descricao atual: """${req.current.description}"""`,
      `atributos atuais: ${JSON.stringify(req.current.attrs)}`,
    );
  }
  lines.push('Gere o anuncio no formato JSON pedido.');
  return lines.join('\n');
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export function aiConfigured() {
  return Boolean(config.gemini.apiKey);
}

/** Chama o Gemini e devolve o rascunho ja validado. */
export async function generateDraft(req: DraftRequest): Promise<AiDraft> {
  if (!aiConfigured()) {
    throw new ChannelError('GEMINI_API_KEY nao configurada no .env: pegue a chave em https://aistudio.google.com/apikey');
  }
  if (req.input.trim().length < 3) {
    throw new ChannelError('descreva o que voce esta vendendo (pelo menos o nome do produto)');
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(req) }] }],
    generationConfig: {
      temperature: 0.8,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(req.kind),
    },
  };

  const res = await request<GeminiResponse>(
    `${ENDPOINT}/${config.gemini.model}:generateContent`,
    {
      method: 'POST',
      json: body,
      headers: { 'x-goog-api-key': config.gemini.apiKey },
      timeoutMs: 60_000,
    },
  );

  if (res.promptFeedback?.blockReason) {
    throw new ChannelError(`o Gemini recusou o pedido (${res.promptFeedback.blockReason})`);
  }
  const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) {
    throw new ChannelError(`o Gemini nao retornou texto (finishReason: ${res.candidates?.[0]?.finishReason ?? 'desconhecido'})`);
  }

  return parseDraft(text);
}

/** Exportado para teste: valida o JSON do modelo e normaliza os attrs vazios. */
export function parseDraft(text: string): AiDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ChannelError('o Gemini devolveu um JSON invalido', text.slice(0, 500));
  }
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChannelError('resposta do Gemini fora do formato esperado', parsed.error.issues);
  }
  const attrs = Object.fromEntries(
    Object.entries(parsed.data.attrs).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
  return { ...parsed.data, title: parsed.data.title.slice(0, 120), attrs };
}
