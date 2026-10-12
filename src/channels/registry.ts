import type { Kind } from '../domain/product.ts';
import { facebookCatalog } from './facebook/catalog.ts';
import { facebookGroups } from './facebook/groups.ts';
import { mercadoLivre } from './mercadolivre/index.ts';
import { olx } from './olx/index.ts';
import { whatsapp } from './whatsapp.ts';
import type { Channel } from './types.ts';

export const channels: Channel[] = [mercadoLivre, olx, facebookCatalog, facebookGroups, whatsapp];

export function getChannel(id: string): Channel | undefined {
  return channels.find((c) => c.id === id);
}

export function channelsFor(kind: Kind) {
  return channels.filter((c) => c.kinds.includes(kind));
}

/** Resumo para a tela de canais: quem esta pronto para publicar e o que falta. */
export function channelStatus() {
  return channels.map((c) => ({
    id: c.id,
    label: c.label,
    mode: c.mode,
    kinds: c.kinds,
    docsUrl: c.docsUrl,
    requiredEnv: c.requiredEnv,
    configured: c.isConfigured(),
    needsOauth: c.id === 'mercadolivre',
  }));
}
