import type { Kind, Product } from '../domain/product.ts';

export type ChannelMode =
  | 'api'      // publica sozinho via API oficial
  | 'feed'     // a plataforma consome um feed que expomos
  | 'manual';  // sem API: geramos o kit de publicacao para o humano colar

export type ListingStatus = 'rascunho' | 'publicando' | 'publicado' | 'pausado' | 'encerrado' | 'erro';

export interface ValidationIssue {
  field?: string;
  message: string;
  severity: 'error' | 'warn';
}

/** Conteudo pronto para publicacao humana em canais sem API (grupos do Facebook, WhatsApp). */
export interface ManualKit {
  headline: string;
  text: string;
  imageUrls: string[];
  steps: string[];
}

export interface ChannelAccount {
  channel: string;
  label: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  meta: Record<string, unknown>;
  connectedAt: string | null;
}

export interface PublishContext {
  product: Product;
  account?: ChannelAccount;
  /** Em dryRun o adapter monta o payload mas nao chama a plataforma. */
  dryRun: boolean;
}

export interface PublishResult {
  status: ListingStatus;
  externalId?: string;
  permalink?: string;
  /** O que foi (ou seria) enviado a plataforma. Sempre gravado para auditoria. */
  payload?: unknown;
  result?: unknown;
  manualKit?: ManualKit;
  message?: string;
}

export interface Channel {
  id: string;
  label: string;
  mode: ChannelMode;
  /** Tipos de produto que o canal aceita. */
  kinds: readonly Kind[];
  docsUrl: string;
  /** Variaveis de ambiente obrigatorias para o canal sair do modo nao-configurado. */
  requiredEnv: readonly string[];
  /** true quando o canal tem credencial suficiente para tentar publicar de verdade. */
  isConfigured(): boolean;
  /** Avisos e bloqueios antes de publicar. Um issue 'error' impede a publicacao. */
  validate(product: Product): ValidationIssue[];
  publish(ctx: PublishContext): Promise<PublishResult>;
  pause?(ctx: PublishContext & { externalId: string }): Promise<PublishResult>;
  close?(ctx: PublishContext & { externalId: string }): Promise<PublishResult>;
}

export class ChannelError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ChannelError';
  }
}
