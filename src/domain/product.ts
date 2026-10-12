import { z } from 'zod';

export const KINDS = ['geral', 'veiculo', 'imovel'] as const;
export type Kind = (typeof KINDS)[number];

const str = (max: number) => z.string().trim().max(max);

/**
 * Digito verificador GS1 (mod 10), o mesmo para EAN-8, UPC-12, EAN-13 e GTIN-14.
 * Um digito trocado na digitacao vira outro produto no catalogo do Mercado
 * Livre -- melhor recusar no formulario do que publicar no produto errado.
 */
export function gtinValido(gtin: string) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin)) return false;
  const digitos = [...gtin].map(Number);
  const verificador = digitos.pop()!;
  const soma = digitos.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === verificador;
}

/** Motivos aceitos pelo ML quando o produto nao tem codigo de barras (EMPTY_GTIN_REASON). */
export const GTIN_MISSING_REASONS = ['', 'nao_registrado', 'kit', 'artesanal', 'outro'] as const;

/** Atributos extras de item avulso (movel, eletronico, ferramenta...). */
export const geralAttrs = z.object({
  brand: str(60).default(''),
  model: str(60).default(''),
  wear: z.enum(['novo', 'seminovo', 'bom', 'usado_marcas', 'para_reparo']).default('bom'),
  warranty: str(80).default(''),
  /**
   * Codigo de barras (EAN/GTIN). Vem SEMPRE do vendedor, nunca da IA: um
   * codigo inventado casa o anuncio com outro produto no catalogo do ML.
   * Espacos e tracos sao tolerados na digitacao e removidos aqui.
   */
  gtin: z.preprocess(
    (v) => String(v ?? '').replace(/[\s.-]/g, ''),
    z.string().refine((v) => v === '' || gtinValido(v), {
      message: 'codigo de barras invalido: confira os digitos (EAN tem 8 ou 13, UPC tem 12)',
    }),
  ).default(''),
  gtinMissingReason: z.enum(GTIN_MISSING_REASONS).default(''),
});

export const veiculoAttrs = z.object({
  vehicleType: z.enum(['carro', 'moto', 'caminhao', 'onibus', 'outro']).default('carro'),
  brand: str(40),
  model: str(80),
  version: str(80).default(''),
  yearManufacture: z.coerce.number().int().min(1900).max(2100),
  yearModel: z.coerce.number().int().min(1900).max(2100),
  km: z.coerce.number().int().min(0).max(3_000_000),
  fuel: z.enum(['flex', 'gasolina', 'etanol', 'diesel', 'gnv', 'eletrico', 'hibrido']).default('flex'),
  transmission: z.enum(['manual', 'automatico', 'automatizado', 'cvt']).default('manual'),
  color: str(30).default(''),
  doors: z.coerce.number().int().min(0).max(6).default(4),
  plateEnd: str(1).default(''),
  licensed: z.boolean().default(true),
  singleOwner: z.boolean().default(false),
  features: z.array(str(40)).default([]),
});

export const imovelAttrs = z.object({
  operation: z.enum(['venda', 'aluguel', 'temporada']).default('venda'),
  propertyType: z.enum(['apartamento', 'casa', 'terreno', 'comercial', 'rural', 'galpao']).default('apartamento'),
  usableAreaM2: z.coerce.number().min(0).max(1_000_000).default(0),
  totalAreaM2: z.coerce.number().min(0).max(1_000_000).default(0),
  bedrooms: z.coerce.number().int().min(0).max(30).default(0),
  suites: z.coerce.number().int().min(0).max(30).default(0),
  bathrooms: z.coerce.number().int().min(0).max(30).default(0),
  parkingSpots: z.coerce.number().int().min(0).max(30).default(0),
  condoFeeCents: z.coerce.number().int().min(0).default(0),
  iptuCents: z.coerce.number().int().min(0).default(0),
  furnished: z.boolean().default(false),
  features: z.array(str(40)).default([]),
});

export const attrsByKind = {
  geral: geralAttrs,
  veiculo: veiculoAttrs,
  imovel: imovelAttrs,
} satisfies Record<Kind, z.ZodTypeAny>;

const base = z.object({
  title: str(120).min(5, 'titulo precisa de pelo menos 5 caracteres'),
  description: str(8000).default(''),
  priceCents: z.coerce.number().int().min(0),
  condition: z.enum(['novo', 'usado']).default('usado'),
  quantity: z.coerce.number().int().min(1).max(9999).default(1),
  acceptsTrade: z.boolean().default(false),
  cep: str(9).default(''),
  city: str(80).default(''),
  uf: str(2).default(''),
  neighborhood: str(80).default(''),
});

export const productInput = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('geral'), attrs: geralAttrs.default({}) }),
  base.extend({ kind: z.literal('veiculo'), attrs: veiculoAttrs }),
  base.extend({ kind: z.literal('imovel'), attrs: imovelAttrs.default({}) }),
]);

export type ProductInput = z.infer<typeof productInput>;

/**
 * De onde a foto veio:
 * - `upload`  foto sua, tirada do item real. A unica que pode ser capa.
 * - `catalogo` foto oficial do catalogo do Mercado Livre: ilustra o modelo.
 * - `url`     foto sua baixada de um link que voce colou (Drive, Fotos, nuvem).
 * - `ia`      versao tratada por IA de uma foto sua.
 */
export type ImageOrigin = 'upload' | 'catalogo' | 'url' | 'ia';

/**
 * Fotos que NAO mostram o item real: entram como ilustrativas, nunca como capa,
 * e exigem o aviso na descricao. So o catalogo cai aqui -- link colado e foto
 * sua que estava na nuvem, e a versao de IA sai de uma foto sua.
 */
export const ILLUSTRATIVE_ORIGINS: readonly ImageOrigin[] = ['catalogo'];

export function isOwnPhoto(image: Pick<ProductImage, 'origin'>) {
  return !ILLUSTRATIVE_ORIGINS.includes(image.origin);
}

export interface ProductImage {
  id: string;
  filename: string;
  mime: string;
  position: number;
  url: string;
  width: number;
  height: number;
  origin: ImageOrigin;
  /** Para `catalogo`/`url`, a origem da imagem; para `ia`, a foto de onde ela saiu. */
  sourceUrl: string;
  /** Rotulo legivel da fonte, ex. o nome do produto no catalogo do ML. */
  sourceLabel: string;
  /** Arquivo intacto em uploads/originals. */
  originalFilename: string;
}

/** Produto como o resto do sistema consome: campos normalizados + imagens resolvidas. */
export interface Product {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  priceCents: number;
  condition: 'novo' | 'usado';
  quantity: number;
  acceptsTrade: boolean;
  cep: string;
  city: string;
  uf: string;
  neighborhood: string;
  attrs: Record<string, unknown>;
  archived: boolean;
  images: ProductImage[];
  createdAt: string;
  updatedAt: string;
}

export function formatBRL(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function kmFormat(km: number) {
  return `${km.toLocaleString('pt-BR')} km`;
}
