import { config } from '../config.ts';
import { buildWhatsappPitch } from '../services/templates.ts';
import type { Channel, PublishContext, PublishResult } from './types.ts';

export const CHANNEL_ID = 'whatsapp';

/** Gera a mensagem e o link wa.me para divulgacao em listas e status. */
export const whatsapp: Channel = {
  id: CHANNEL_ID,
  label: 'WhatsApp (manual)',
  mode: 'manual',
  kinds: ['geral', 'veiculo', 'imovel'],
  docsUrl: 'https://faq.whatsapp.com/',
  requiredEnv: [],
  isConfigured: () => true,
  validate: () => [],
  async publish(ctx: PublishContext): Promise<PublishResult> {
    const text = buildWhatsappPitch(ctx.product);
    const phone = config.seller.phone.replace(/\D/g, '');
    const link = `https://wa.me/${phone ? `55${phone.replace(/^55/, '')}` : ''}?text=${encodeURIComponent(text)}`;
    return {
      status: 'rascunho',
      payload: { text, link },
      manualKit: {
        headline: ctx.product.title,
        text,
        imageUrls: ctx.product.images.map((i) => i.url),
        steps: [
          'Copie a mensagem abaixo.',
          'Envie nas suas listas de transmissao ou publique no status.',
          phone ? `Link de contato direto: ${link}` : 'Preencha SELLER_PHONE no .env para gerar o link wa.me.',
        ],
      },
      message: 'mensagem pronta para enviar',
    };
  },
};
