import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { config } from '../config.ts';
import { isOwnPhoto, type ImageOrigin, type Product } from '../domain/product.ts';
import type { ValidationIssue } from '../channels/types.ts';

/** Erro de imagem: as rotas traduzem em 400 com a mensagem para o usuario. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

/** Os originais ficam aqui para permitir refazer o tratamento ou desfazer a edicao de IA. */
export const originalsDir = join(config.uploadsDir, 'originals');
mkdirSync(originalsDir, { recursive: true });

/** O que chega do navegador. HEIC entra porque e o padrao do iPhone; o sharp converte. */
export const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
]);

const EXT_BY_FORMAT: Record<string, string> = {
  jpeg: '.jpg', png: '.png', webp: '.webp', heif: '.heic', avif: '.avif', gif: '.gif', tiff: '.tif',
};

export interface ProcessedImage {
  filename: string;
  /** Nome do arquivo intacto em uploads/originals, vazio quando nao foi possivel guardar. */
  originalFilename: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Trata a foto antes de gravar: corrige a orientacao pelo EXIF, reduz ao lado
 * maior configurado, converte para JPEG e **descarta todo metadado** -- foto de
 * celular carrega a coordenada GPS de onde foi tirada, e o arquivo servido aqui
 * fica publico para as plataformas baixarem.
 *
 * O arquivo original e guardado intacto em uploads/originals.
 */
export async function processUpload(input: Buffer, opts: { productId: string }): Promise<ProcessedImage> {
  if (input.length === 0) throw new ImageError('arquivo vazio');

  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ImageError('nao consegui ler esta imagem (arquivo corrompido ou formato nao suportado)');
  }
  if (!meta.format) throw new ImageError('o arquivo enviado nao e uma imagem');

  const base = `${opts.productId}-${randomUUID()}`;
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(input)
      // rotate() sem argumento aplica a orientacao do EXIF; sem isso a foto
      // do celular chega deitada nas plataformas.
      .rotate()
      .resize({
        width: config.image.maxSide,
        height: config.image.maxSide,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // Nao chamamos withMetadata(): e o que faz o EXIF (inclusive GPS) ficar fora.
      .jpeg({ quality: config.image.quality, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    const hint = meta.format === 'heif'
      ? ' (HEIC do iPhone: se persistir, troque para "Mais compativel" na camera ou envie em JPEG)'
      : '';
    throw new ImageError(`falha ao processar a imagem${hint}: ${(err as Error).message}`);
  }

  const filename = `${base}.jpg`;
  await writeFile(join(config.uploadsDir, filename), out.data);

  const originalFilename = `${base}${EXT_BY_FORMAT[meta.format] ?? '.bin'}`;
  await writeFile(join(originalsDir, originalFilename), input);

  return {
    filename,
    originalFilename,
    mime: 'image/jpeg',
    bytes: out.info.size,
    width: out.info.width,
    height: out.info.height,
  };
}

/** Limite de download: uma foto tratada pelo pipeline nunca chega perto disso. */
const REMOTE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Baixa uma imagem por URL (catalogo do Mercado Livre, link colado).
 * Recusa o que nao for http(s) ou nao responder com content-type de imagem.
 */
export async function fetchRemoteImage(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageError(`URL invalida: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImageError('a URL da imagem precisa comecar com http:// ou https://');
  }

  let res: Response;
  try {
    res = await fetch(parsed, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  } catch (err) {
    throw new ImageError(`nao consegui baixar ${parsed.host}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ImageError(`${parsed.host} respondeu ${res.status} ao baixar a imagem`);

  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new ImageError(`a URL nao devolveu imagem (content-type: ${type || 'ausente'})`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > REMOTE_MAX_BYTES) throw new ImageError('imagem remota maior que 15 MB');

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > REMOTE_MAX_BYTES) throw new ImageError('imagem remota maior que 15 MB');
  return buf;
}

/**
 * Minimos de resolucao por canal. Abaixo do minimo a plataforma recusa a foto;
 * abaixo do recomendado ela aceita mas o anuncio fica com zoom ruim.
 */
export const IMAGE_LIMITS = {
  mercadolivre: { min: 500, recommended: 1200 },
  olx: { min: 300, recommended: 1000 },
  facebook: { min: 500, recommended: 1000 },
} as const satisfies Record<string, { min: number; recommended: number }>;

export interface MeasuredImage {
  width: number;
  height: number;
  origin: ImageOrigin;
}

/**
 * Quantas fotos ficam abaixo do minimo e do recomendado de um canal.
 * Imagem antiga, gravada antes do tratamento automatico, tem dimensao 0 e
 * nao conta: nao sabemos o tamanho dela sem reprocessar.
 */
export function measureAgainst(channel: keyof typeof IMAGE_LIMITS, images: readonly MeasuredImage[]) {
  const { min, recommended } = IMAGE_LIMITS[channel];
  const known = images.filter((i) => i.width > 0 && i.height > 0);
  return {
    belowMin: known.filter((i) => Math.min(i.width, i.height) < min),
    belowRecommended: known.filter((i) => Math.min(i.width, i.height) < recommended),
    min,
    recommended,
  };
}

/**
 * Avisos e bloqueios de foto de um canal. Dois casos:
 *
 * - **resolucao**: abaixo do minimo a plataforma recusa a imagem; entre o minimo
 *   e o recomendado ela aceita, mas o zoom do anuncio fica ruim.
 * - **so foto ilustrativa**: anuncio sem nenhuma foto do item real e bloqueio.
 *   Mercado Livre e OLX derrubam anuncio de usado ilustrado so com foto de
 *   catalogo, e isso afeta a reputacao do vendedor.
 */
export function photoIssues(
  channel: keyof typeof IMAGE_LIMITS,
  product: Product,
  canalLabel: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (product.images.length === 0) return issues; // cada canal ja tem sua mensagem de "sem foto"

  if (!product.images.some(isOwnPhoto)) {
    issues.push({
      field: 'images',
      severity: 'error',
      message: `este produto so tem foto ilustrativa: ${canalLabel} exige pelo menos uma foto do item real`,
    });
  }

  const m = measureAgainst(channel, product.images);
  if (m.belowMin.length) {
    issues.push({
      field: 'images',
      severity: 'warn',
      message: `${m.belowMin.length} foto(s) abaixo de ${m.min}x${m.min} px: ${canalLabel} pode recusar`,
    });
  } else if (m.belowRecommended.length) {
    issues.push({
      field: 'images',
      severity: 'warn',
      message: `${m.belowRecommended.length} foto(s) abaixo dos ${m.recommended}px recomendados: o zoom fica ruim`,
    });
  }
  return issues;
}
