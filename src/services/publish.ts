import { randomUUID } from 'node:crypto';
import { all, get, nowIso, run } from '../db/index.ts';
import { config } from '../config.ts';
import { getChannel } from '../channels/registry.ts';
import { getAccount } from './accounts.ts';
import { logEvent } from './events.ts';
import { getProduct } from './products.ts';
import { ChannelError, type ListingStatus, type ManualKit, type ValidationIssue } from '../channels/types.ts';

export interface ListingRow {
  id: string; product_id: string; channel: string; status: ListingStatus;
  external_id: string | null; permalink: string | null; payload_json: string | null;
  result_json: string | null; error: string | null; published_at: string | null; updated_at: string;
}

export interface Listing {
  id: string; productId: string; channel: string; status: ListingStatus;
  externalId: string | null; permalink: string | null;
  payload: unknown; result: unknown; error: string | null;
  publishedAt: string | null; updatedAt: string;
}

function toListing(r: ListingRow): Listing {
  return {
    id: r.id, productId: r.product_id, channel: r.channel, status: r.status,
    externalId: r.external_id, permalink: r.permalink,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    error: r.error, publishedAt: r.published_at, updatedAt: r.updated_at,
  };
}

export function listingsFor(productId: string): Listing[] {
  return all<ListingRow>('SELECT * FROM listings WHERE product_id = ? ORDER BY channel', productId).map(toListing);
}

export function allListings(): Listing[] {
  return all<ListingRow>('SELECT * FROM listings ORDER BY updated_at DESC').map(toListing);
}

export function getListing(productId: string, channel: string): Listing | undefined {
  const row = get<ListingRow>('SELECT * FROM listings WHERE product_id = ? AND channel = ?', productId, channel);
  return row ? toListing(row) : undefined;
}

function upsertListing(productId: string, channel: string, patch: Partial<ListingRow>) {
  const existing = get<ListingRow>('SELECT id FROM listings WHERE product_id=? AND channel=?', productId, channel);
  const id = existing?.id ?? randomUUID();
  if (!existing) {
    run(
      'INSERT INTO listings (id, product_id, channel, status, updated_at) VALUES (?,?,?,?,?)',
      id, productId, channel, patch.status ?? 'rascunho', nowIso(),
    );
  }
  run(
    `UPDATE listings SET status=COALESCE(?,status), external_id=COALESCE(?,external_id),
       permalink=COALESCE(?,permalink), payload_json=COALESCE(?,payload_json),
       result_json=COALESCE(?,result_json), error=?, published_at=COALESCE(?,published_at), updated_at=?
     WHERE id=?`,
    patch.status ?? null, patch.external_id ?? null, patch.permalink ?? null,
    patch.payload_json ?? null, patch.result_json ?? null, patch.error ?? null,
    patch.published_at ?? null, nowIso(), id,
  );
  return get<ListingRow>('SELECT * FROM listings WHERE id = ?', id)!;
}

export interface PublishOutcome {
  channel: string;
  status: ListingStatus;
  message?: string;
  issues: ValidationIssue[];
  manualKit?: ManualKit;
  permalink?: string | null;
  externalId?: string | null;
  payload?: unknown;
  dryRun: boolean;
}

/** Valida e publica um produto em um canal, gravando o listing e o evento de auditoria. */
export async function publishToChannel(
  productId: string,
  channelId: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<PublishOutcome> {
  const product = getProduct(productId);
  if (!product) throw new ChannelError(`produto ${productId} nao encontrado`);
  const channel = getChannel(channelId);
  if (!channel) throw new ChannelError(`canal ${channelId} nao existe`);
  if (!channel.kinds.includes(product.kind)) {
    throw new ChannelError(`${channel.label} nao aceita produtos do tipo ${product.kind}`);
  }

  const dryRun = opts.dryRun ?? config.dryRun;
  const issues = channel.validate(product);
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length > 0 && !opts.force) {
    upsertListing(productId, channelId, {
      status: 'erro',
      error: blocking.map((i) => i.message).join('; '),
    });
    logEvent('warn', 'publicacao bloqueada na validacao', { productId, channel: channelId, data: blocking });
    return { channel: channelId, status: 'erro', issues, dryRun, message: 'corrija os erros de validacao' };
  }

  upsertListing(productId, channelId, { status: 'publicando', error: null });

  try {
    const result = await channel.publish({ product, account: getAccount(channelId), dryRun });
    const row = upsertListing(productId, channelId, {
      status: result.status,
      external_id: result.externalId ?? null,
      permalink: result.permalink ?? null,
      payload_json: result.payload === undefined ? null : JSON.stringify(result.payload),
      result_json: result.result === undefined ? null : JSON.stringify(result.result),
      error: null,
      published_at: result.status === 'publicado' ? nowIso() : null,
    });
    logEvent('info', result.message ?? 'publicado', { productId, channel: channelId });
    return {
      channel: channelId,
      status: row.status,
      message: result.message,
      issues,
      manualKit: result.manualKit,
      permalink: row.permalink,
      externalId: row.external_id,
      payload: result.payload,
      dryRun,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    upsertListing(productId, channelId, { status: 'erro', error: message });
    logEvent('error', message, {
      productId,
      channel: channelId,
      data: err instanceof ChannelError ? err.detail : undefined,
    });
    return { channel: channelId, status: 'erro', message, issues, dryRun };
  }
}

/** Publica em varios canais em sequencia: uma plataforma por vez evita rate limit. */
export async function publishToChannels(
  productId: string,
  channelIds: string[],
  opts: { dryRun?: boolean; force?: boolean } = {},
) {
  const results: PublishOutcome[] = [];
  for (const id of channelIds) {
    results.push(await publishToChannel(productId, id, opts));
  }
  return results;
}

export async function changeListingStatus(productId: string, channelId: string, action: 'pause' | 'close') {
  const channel = getChannel(channelId);
  const listing = getListing(productId, channelId);
  const product = getProduct(productId);
  if (!channel || !product) throw new ChannelError('canal ou produto inexistente');
  if (!listing?.externalId) throw new ChannelError('anuncio ainda nao publicado neste canal');

  const fn = action === 'pause' ? channel.pause : channel.close;
  if (!fn) {
    // Canal sem API de status: registramos a intencao para o operador concluir na mao.
    const status: ListingStatus = action === 'pause' ? 'pausado' : 'encerrado';
    upsertListing(productId, channelId, { status });
    return { channel: channelId, status, manual: true };
  }

  const result = await fn({
    product,
    dryRun: config.dryRun,
    account: getAccount(channelId),
    externalId: listing.externalId,
  });
  upsertListing(productId, channelId, {
    status: result.status,
    result_json: result.result === undefined ? null : JSON.stringify(result.result),
  });
  logEvent('info', `status alterado para ${result.status}`, { productId, channel: channelId });
  return { channel: channelId, status: result.status, manual: false };
}
