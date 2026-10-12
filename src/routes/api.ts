import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { productInput } from '../domain/product.ts';
import { channelStatus, getChannel } from '../channels/registry.ts';
import { ChannelError } from '../channels/types.ts';
import { disconnectAccount, getAccount } from '../services/accounts.ts';
import { logEvent, recentEvents } from '../services/events.ts';
import {
  addImage, archiveProduct, createProduct, deleteProduct, getImage, getProduct,
  listProducts, removeImage, reorderImages, updateProduct,
} from '../services/products.ts';
import { allListings, changeListingStatus, listingsFor, publishToChannels } from '../services/publish.ts';
import { aiConfigured, generateDraft } from '../services/ai.ts';
import { ACCEPTED_MIME, ImageError, fetchRemoteImage, originalsDir, processUpload } from '../services/images.ts';
import { findCatalogImages, urlVariants } from '../channels/mercadolivre/catalog.ts';

const referenceBody = z.object({
  images: z.array(z.object({
    url: z.string().url(),
    label: z.string().max(200).optional(),
    sourceUrl: z.string().url().optional(),
  })).min(1).max(10),
});

const fromUrlBody = z.object({ url: z.string().url() });

const draftBody = z.object({
  kind: z.enum(['geral', 'veiculo', 'imovel']),
  input: z.string().min(3).max(4000),
  priceCents: z.coerce.number().int().min(0).optional(),
  city: z.string().max(80).optional(),
  uf: z.string().max(2).optional(),
});

const publishBody = z.object({
  channels: z.array(z.string()).min(1),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

/** Garante que o caminho resolvido continua dentro de uploadsDir. */
/** Baixa a primeira URL que responder imagem; se nenhuma responder, propaga o ultimo erro. */
async function firstAvailable(urls: string[]) {
  let last: unknown;
  for (const url of urls) {
    try {
      return await fetchRemoteImage(url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function uploadPath(filename: string) {
  const full = resolve(config.uploadsDir, filename);
  if (!full.startsWith(resolve(config.uploadsDir))) throw new ChannelError('caminho de arquivo invalido');
  return full;
}

export async function registerApiRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, dryRun: config.dryRun, publicUrl: config.publicUrl }));

  app.get('/config', async () => ({
    dryRun: config.dryRun,
    publicUrl: config.publicUrl,
    publicUrlIsLocal: /^https?:\/\/(127\.0\.0\.1|localhost)/.test(config.publicUrl),
    seller: config.seller,
    aiConfigured: aiConfigured(),
    aiModel: config.gemini.model,
    olxFeedUrl: `${config.publicUrl}/feeds/olx.xml${config.olxFeedToken ? `?token=${config.olxFeedToken}` : ''}`,
  }));

  app.get('/channels', async () => ({
    channels: channelStatus().map((c) => {
      const account = getAccount(c.id);
      return {
        ...c,
        connected: Boolean(account?.accessToken),
        accountLabel: account?.label ?? null,
        expiresAt: account?.expiresAt ?? null,
      };
    }),
  }));

  app.delete('/channels/:id/account', async (req) => {
    const { id } = req.params as { id: string };
    if (!getChannel(id)) throw new ChannelError('canal inexistente');
    disconnectAccount(id);
    return { ok: true };
  });

  // ---- produtos ----

  app.get('/products', async (req) => {
    const q = req.query as { archived?: string };
    const products = listProducts({ includeArchived: q.archived === '1' });
    const listings = allListings();
    return {
      products: products.map((p) => ({
        ...p,
        listings: listings.filter((l) => l.productId === p.id),
      })),
    };
  });

  app.get('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = getProduct(id);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    const channels = channelStatus().filter((c) => c.kinds.includes(product.kind));
    return {
      product,
      listings: listingsFor(id),
      channels: channels.map((c) => ({
        ...c,
        issues: getChannel(c.id)!.validate(product),
      })),
    };
  });

  app.post('/products', async (req, reply) => {
    const parsed = productInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'dados invalidos', issues: parsed.error.issues });
    return reply.status(201).send({ product: createProduct(parsed.data) });
  });

  app.put('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = productInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'dados invalidos', issues: parsed.error.issues });
    const product = updateProduct(id, parsed.data);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    return { product };
  });

  app.post('/products/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    const { archived } = (req.body ?? {}) as { archived?: boolean };
    archiveProduct(id, archived ?? true);
    return { ok: true };
  });

  app.delete('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = getProduct(id);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    deleteProduct(id);
    await Promise.allSettled([
      ...product.images.map((i) => unlink(uploadPath(i.filename))),
      ...product.images
        .filter((i) => i.originalFilename)
        .map((i) => unlink(join(originalsDir, i.originalFilename))),
    ]);
    return { ok: true };
  });

  // ---- imagens ----

  app.post('/products/:id/images', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) return reply.status(404).send({ error: 'produto nao encontrado' });

    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!ACCEPTED_MIME.has(part.mimetype)) {
        return reply.status(400).send({
          error: `tipo nao aceito: ${part.mimetype} (use jpeg, png, webp ou heic)`,
        });
      }
      const buf = await part.toBuffer();
      if (part.file.truncated) return reply.status(413).send({ error: 'imagem maior que 15 MB' });
      const processed = await processUpload(buf, { productId: id });
      addImage(id, { ...processed, origin: 'upload' });
      saved.push(processed.filename);
    }
    if (saved.length === 0) return reply.status(400).send({ error: 'nenhuma imagem recebida' });
    return reply.status(201).send({ product: getProduct(id) });
  });

  app.delete('/images/:imageId', async (req, reply) => {
    const { imageId } = req.params as { imageId: string };
    const image = getImage(imageId);
    if (!image) return reply.status(404).send({ error: 'imagem nao encontrada' });
    removeImage(imageId);
    await unlink(uploadPath(image.filename)).catch(() => {});
    if (image.original_filename) {
      await unlink(join(originalsDir, image.original_filename)).catch(() => {});
    }
    return { ok: true };
  });

  /**
   * Fotos oficiais do catalogo do Mercado Livre para o titulo do produto.
   * Nao grava nada: devolve candidatas para voce aprovar.
   */
  app.get('/products/:id/reference-images', async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = getProduct(id);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    if (product.kind !== 'geral') {
      return reply.send({
        candidates: [],
        message: 'o catalogo do Mercado Livre cobre produtos de linha. Veiculo e imovel sao unicos: use suas proprias fotos.',
      });
    }
    const candidates = await findCatalogImages(product.title);
    return {
      candidates,
      message: candidates.length ? undefined : 'nenhum produto parecido no catalogo. Tente um titulo com marca e modelo.',
    };
  });

  /** Grava as candidatas que voce aprovou, como foto ilustrativa (nunca capa). */
  app.post('/products/:id/reference-images', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) return reply.status(404).send({ error: 'produto nao encontrado' });
    const parsed = referenceBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'dados invalidos', issues: parsed.error.issues });

    for (const item of parsed.data.images) {
      // Tenta a variante de maior resolucao e cai para a URL que a API deu.
      const buf = await firstAvailable(urlVariants(item.url));
      const processed = await processUpload(buf, { productId: id });
      addImage(id, {
        ...processed,
        origin: 'catalogo',
        sourceUrl: item.sourceUrl ?? item.url,
        sourceLabel: item.label ?? '',
      });
    }
    logEvent('info', `${parsed.data.images.length} foto(s) de catalogo adicionadas`, { productId: id });
    return reply.status(201).send({ product: getProduct(id) });
  });

  /** Importa uma foto de um link que voce colou (Drive, Fotos, anuncio antigo). */
  app.post('/products/:id/images/from-url', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) return reply.status(404).send({ error: 'produto nao encontrado' });
    const parsed = fromUrlBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'informe uma URL de imagem valida' });

    const buf = await fetchRemoteImage(parsed.data.url);
    const processed = await processUpload(buf, { productId: id });
    addImage(id, { ...processed, origin: 'url', sourceUrl: parsed.data.url });
    return reply.status(201).send({ product: getProduct(id) });
  });

  app.put('/products/:id/images/order', async (req) => {
    const { id } = req.params as { id: string };
    const { ids } = req.body as { ids: string[] };
    reorderImages(id, ids ?? []);
    return { product: getProduct(id) };
  });

  // ---- publicacao ----

  app.post('/products/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = publishBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'informe os canais', issues: parsed.error.issues });
    const results = await publishToChannels(id, parsed.data.channels, {
      dryRun: parsed.data.dryRun,
      force: parsed.data.force,
    });
    return { results, listings: listingsFor(id) };
  });

  app.post('/products/:id/listings/:channel/:action', async (req, reply) => {
    const { id, channel, action } = req.params as { id: string; channel: string; action: string };
    if (action !== 'pause' && action !== 'close') {
      return reply.status(400).send({ error: 'acao deve ser pause ou close' });
    }
    return changeListingStatus(id, channel, action);
  });

  /** Kit de publicacao manual (texto + fotos) sem registrar publicacao. */
  app.get('/products/:id/kit/:channel', async (req, reply) => {
    const { id, channel } = req.params as { id: string; channel: string };
    const product = getProduct(id);
    const ch = getChannel(channel);
    if (!product || !ch) return reply.status(404).send({ error: 'produto ou canal nao encontrado' });
    const result = await ch.publish({ product, dryRun: true, account: getAccount(channel) });
    return { kit: result.manualKit ?? null, payload: result.payload };
  });

  // ---- geracao de texto (Gemini) ----

  app.get('/ai/status', async () => ({ configured: aiConfigured(), model: config.gemini.model }));

  /** Escreve um anuncio novo a partir do nome do produto e do contexto livre. */
  app.post('/ai/draft', async (req, reply) => {
    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'dados invalidos', issues: parsed.error.issues });
    const draft = await generateDraft(parsed.data);
    logEvent('info', 'rascunho gerado pelo Gemini', { data: { kind: parsed.data.kind, title: draft.title } });
    return { draft };
  });

  /** Reescreve o anuncio de um produto que ja existe, preservando os fatos dele. */
  app.post('/products/:id/ai/improve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = getProduct(id);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    const { input } = (req.body ?? {}) as { input?: string };

    const draft = await generateDraft({
      kind: product.kind,
      input: input?.trim() || `${product.title}. ${product.description}`,
      priceCents: product.priceCents,
      city: product.city,
      uf: product.uf,
      current: { title: product.title, description: product.description, attrs: product.attrs },
    });
    logEvent('info', 'anuncio reescrito pelo Gemini', { productId: id });
    return { draft };
  });

  app.get('/events', async (req) => {
    const { limit } = req.query as { limit?: string };
    return { events: recentEvents(Math.min(Number(limit ?? 100), 500)) };
  });
}
