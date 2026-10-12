import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { request } from '../lib/http.ts';
import { ChannelError } from '../channels/types.ts';
import { addImage, getImage, getProduct, imageUrl } from './products.ts';
import { ImageError, processUpload } from './images.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const ENHANCE_MODES = {
  fundo: {
    label: 'Fundo limpo',
    prompt: 'Substitua apenas o fundo por um fundo cinza-claro liso e uniforme, de estudio. '
      + 'Mantenha o produto exatamente igual, no mesmo angulo, com as mesmas proporcoes e sombra natural.',
  },
  luz: {
    label: 'Corrigir luz',
    prompt: 'Corrija exposicao, contraste e equilibrio de branco desta foto, como um ajuste de revelacao. '
      + 'Nao recorte, nao mude o fundo e nao altere as cores reais do produto.',
  },
  enquadrar: {
    label: 'Enquadrar quadrado',
    prompt: 'Reenquadre a imagem em formato quadrado com o produto centralizado e uma margem pequena e uniforme, '
      + 'completando o fundo existente quando necessario. Nao corte parte nenhuma do produto.',
  },
} as const;

export type EnhanceMode = keyof typeof ENHANCE_MODES;

/**
 * O que o modelo NAO pode fazer. Foto que esconde avaria vira reclamacao, e no
 * Mercado Livre reclamacao atinge a reputacao do vendedor -- o ganho de uma
 * foto bonita nao paga isso. Por isso o pedido e sempre de revelacao, nunca de
 * recriacao do produto.
 */
const GUARDA = 'Regras absolutas: nao remova nem disfarce arranhao, amassado, mancha, desgaste, poeira ou '
  + 'qualquer defeito visivel; nao adicione, remova nem substitua peca, acessorio, cabo ou embalagem; '
  + 'nao mude cor, modelo, marca, texto ou etiqueta do produto; nao insira logotipo, marca d\'agua, '
  + 'moldura nem texto na imagem. O produto tem de continuar reconhecivel como o mesmo objeto fotografado, '
  + 'com os mesmos defeitos.';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiImageResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

export function imageAiConfigured() {
  return Boolean(config.gemini.apiKey);
}

function extractImage(res: GeminiImageResponse) {
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (data) return Buffer.from(data, 'base64');
  }
  return undefined;
}

/**
 * Gera uma versao tratada de uma foto sua. A original **nao** e sobrescrita: a
 * versao de IA entra como imagem nova (origin 'ia', apontando para a foto de
 * origem), entao desfazer e apagar a nova.
 */
export async function enhanceImage(imageId: string, mode: EnhanceMode) {
  if (!imageAiConfigured()) {
    throw new ChannelError('GEMINI_API_KEY nao configurada: pegue a chave em https://aistudio.google.com/apikey');
  }
  const spec = ENHANCE_MODES[mode];
  if (!spec) throw new ImageError(`modo de melhoria desconhecido: ${mode}`);

  const row = getImage(imageId);
  if (!row) throw new ImageError('imagem nao encontrada');
  const product = getProduct(row.product_id);
  if (!product) throw new ImageError('produto da imagem nao encontrado');

  const original = await readFile(join(config.uploadsDir, row.filename));

  const res = await request<GeminiImageResponse>(
    `${ENDPOINT}/${config.gemini.imageModel}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': config.gemini.apiKey },
      timeoutMs: 120_000,
      json: {
        contents: [{
          role: 'user',
          parts: [
            { text: `${spec.prompt}\n\n${GUARDA}` },
            { inline_data: { mime_type: row.mime, data: original.toString('base64') } },
          ],
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      },
    },
  );

  if (res.promptFeedback?.blockReason) {
    throw new ChannelError(`o Gemini recusou tratar esta foto (${res.promptFeedback.blockReason})`);
  }
  const generated = extractImage(res);
  if (!generated) {
    const motivo = res.candidates?.[0]?.finishReason ?? 'resposta sem imagem';
    throw new ChannelError(`o Gemini nao devolveu imagem (${motivo}). Tente outra foto ou outro modo.`);
  }

  const processed = await processUpload(generated, { productId: product.id });
  const newId = addImage(product.id, {
    ...processed,
    origin: 'ia',
    sourceUrl: imageUrl(row.filename),
    sourceLabel: `${spec.label} (IA) a partir da sua foto`,
  });

  return { imageId: newId, mode, product: getProduct(product.id)! };
}
