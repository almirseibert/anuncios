import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { config, isLocalUrl } from '../config.ts';
import { productInput } from '../domain/product.ts';
import { channelStatus, getChannel } from '../channels/registry.ts';
import { ChannelError } from '../channels/types.ts';
import { disconnectAccount, getAccount } from '../services/accounts.ts';
import { logEvent, recentEvents } from '../services/events.ts';
import {
  addImage, archiveProduct, createProduct, deleteProduct, getImage, getProduct,
  listProducts, removeImage, reorderImages, setChannelAttrs, updateProduct,
} from '../services/products.ts';
import {
  allListings, changeListingStatus, closeListingsBeforeDelete, listingsFor, publishToChannels,
} from '../services/publish.ts';
import { importFromMercadoLivre } from '../services/mlImport.ts';
import { aiConfigured, generateDraft } from '../services/ai.ts';
import { ENHANCE_MODES, enhanceImage, imageAiConfigured, type EnhanceMode } from '../services/imageAi.ts';
import { ACCEPTED_MIME, ImageError, fetchFirstImage, fetchRemoteImage, originalsDir, processUpload } from '../services/images.ts';
import { findCatalogImages, urlVariants } from '../channels/mercadolivre/catalog.ts';
import { fetchCategory, fetchCategoryAttributes, requiredFields } from '../channels/mercadolivre/categoryAttrs.ts';
import { formAttributeIds, predictCategory } from '../channels/mercadolivre/map.ts';
import { ensureToken } from '../channels/mercadolivre/auth.ts';
import { issueUploadToken, uploadLink } from '../services/uploadTokens.ts';
import { authEnabled } from '../lib/auth.ts';
import { toString as qrToString } from 'qrcode';

/**
 * Fotos de catalogo escolhidas no painel. So a `url` precisa ser valida: rotulo
 * e procedencia sao informativos e vem do ML como vierem (permalink vazio,
 * nome longo) -- recusar o lote por causa deles era o 400 ao usar as fotos.
 * O limite acompanha o painel, que mostra ate 12 candidatas.
 */
const referenceBody = z.object({
  images: z.array(z.object({
    url: z.string().url(),
    label: z.string().optional().transform((v) => (v ?? '').slice(0, 200)),
    sourceUrl: z.string().optional(),
  })).min(1).max(24),
});

const fromUrlBody = z.object({ url: z.string().url() });

const mlAttrsBody = z.object({
  categoryId: z.string().regex(/^[A-Z]{3}\d+$/, 'categoria do ML no formato MLB1234'),
  categoryName: z.string().max(200).optional(),
  attributes: z.record(
    z.string().regex(/^[A-Z0-9_]+$/),
    z.object({ value_id: z.string().max(40).optional(), value_name: z.string().max(255).optional() }),
  ),
});

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
/** "dados invalidos" sozinho esconde o que corrigir: junta as mensagens de cada campo. */
function invalidMessage(error: z.ZodError) {
  const partes = error.issues.map((i) => {
    const campo = i.path.filter((p) => p !== 'attrs').join('.');
    return campo ? `${campo}: ${i.message}` : i.message;
  });
  return `dados invalidos — ${partes.join('; ')}`;
}

/** Baixa a primeira URL que responder imagem; se nenhuma responder, propaga o ultimo erro. */
function uploadPath(filename: string) {
  const full = resolve(config.uploadsDir, filename);
  if (!full.startsWith(resolve(config.uploadsDir))) throw new ChannelError('caminho de arquivo invalido');
  return full;
}

export async function registerApiRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, dryRun: config.dryRun, publicUrl: config.publicUrl }));

  app.get('/config', async () => ({
    version: config.version,
    dryRun: config.dryRun,
    authEnabled: authEnabled(),
    publicUrl: config.publicUrl,
    publicUrlIsLocal: isLocalUrl(config.publicUrl),
    seller: config.seller,
    aiConfigured: aiConfigured(),
    aiModel: config.gemini.model,
    olxFeedUrl: `${config.publicUrl}/feeds/olx.xml${config.olxFeedToken ? `?token=${config.olxFeedToken}` : ''}`,
  }));

  /**
   * Traz os anuncios da conta do ML (ativos, pausados, encerrados) que ainda
   * nao estao aqui. Publicar um deles depois atualiza o mesmo anuncio.
   */
  app.post('/mercadolivre/import', async () => {
    const report = await importFromMercadoLivre();
    logEvent('info', `importacao do ML: ${report.importados.length} novo(s), ${report.jaImportados} ja estavam aqui`, {
      channel: 'mercadolivre', data: report,
    });
    return report;
  });

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
    if (!parsed.success) return reply.status(400).send({ error: invalidMessage(parsed.error), issues: parsed.error.issues });
    return reply.status(201).send({ product: createProduct(parsed.data) });
  });

  app.put('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = productInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: invalidMessage(parsed.error), issues: parsed.error.issues });
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
    // Excluir aqui encerra o anuncio no ML. Se nao der para encerrar, so exclui
    // com ?manterAnuncio=1 (o painel pergunta antes): o anuncio ficaria no ar.
    const manter = (req.query as { manterAnuncio?: string }).manterAnuncio === '1';
    const { encerrados, falhas } = await closeListingsBeforeDelete(id, { keepOnPlatform: manter });
    if (falhas.length) {
      return reply.status(409).send({
        error: `nao consegui encerrar ${falhas.map((f) => `${f.externalId} (${f.error})`).join('; ')}`,
        falhas,
      });
    }
    deleteProduct(id);
    logEvent('info', `produto excluido${encerrados.length ? `; anuncio(s) encerrado(s): ${encerrados.join(', ')}` : ''}`, {
      productId: id,
    });
    await Promise.allSettled([
      ...product.images.map((i) => unlink(uploadPath(i.filename))),
      ...product.images
        .filter((i) => i.originalFilename)
        .map((i) => unlink(join(originalsDir, i.originalFilename))),
    ]);
    return { ok: true, encerrados };
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
    const candidates = await findCatalogImages(product);
    return {
      candidates,
      message: candidates.length ? undefined : 'nenhum produto parecido no catalogo. Preencha marca e modelo (ou o codigo de barras) no cadastro.',
    };
  });

  /** Grava as candidatas que voce aprovou, como foto ilustrativa (nunca capa). */
  app.post('/products/:id/reference-images', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) return reply.status(404).send({ error: 'produto nao encontrado' });
    const parsed = referenceBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: invalidMessage(parsed.error), issues: parsed.error.issues });

    // Uma foto que nao baixa nao pode derrubar as outras: cada uma e tentada
    // por si, e as falhas voltam para o painel.
    const falhas: Array<{ url: string; error: string }> = [];
    let adicionadas = 0;
    for (const item of parsed.data.images) {
      try {
        // Tenta a variante de maior resolucao e cai para a URL que a API deu.
        const buf = await fetchFirstImage(urlVariants(item.url));
        const processed = await processUpload(buf, { productId: id });
        addImage(id, {
          ...processed,
          origin: 'catalogo',
          sourceUrl: /^https?:\/\//.test(item.sourceUrl ?? '') ? item.sourceUrl! : item.url,
          sourceLabel: item.label,
        });
        adicionadas++;
      } catch (err) {
        falhas.push({ url: item.url, error: (err as Error).message });
      }
    }
    if (!adicionadas) {
      return reply.status(502).send({
        error: `nenhuma foto do catalogo pode ser baixada: ${falhas.map((f) => f.error).join('; ')}`,
        falhas,
      });
    }
    logEvent('info', `${adicionadas} foto(s) de catalogo adicionadas`, { productId: id, data: falhas.length ? { falhas } : undefined });
    return reply.status(201).send({ product: getProduct(id), adicionadas, falhas });
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

  /**
   * QR Code para enviar fotos pelo celular. Devolve o SVG pronto e o link,
   * que vale 2 horas. O link e isento de senha: quem autoriza e o token.
   */
  app.get('/products/:id/upload-qr', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) return reply.status(404).send({ error: 'produto nao encontrado' });

    const { token, expiresAt } = issueUploadToken(id);
    const url = uploadLink(token);
    const svg = await qrToString(url, { type: 'svg', margin: 1, width: 240 });
    const local = isLocalUrl(config.publicUrl);
    return {
      url,
      expiresAt,
      svg,
      warning: local
        ? 'PUBLIC_URL aponta para localhost: o celular nao vai abrir este link. Use o endereco publico do servidor.'
        : undefined,
    };
  });

  /**
   * O que a categoria do Mercado Livre exige deste produto: a categoria (a ja
   * salva, a pedida em ?categoryId=, ou a que o ML adivinha pelo titulo), os
   * campos obrigatorios que o cadastro ainda nao cobre, com as opcoes que o ML
   * aceita, e o que ja foi preenchido.
   */
  app.get('/products/:id/ml-attributes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { categoryId: pedida } = req.query as { categoryId?: string };
    const product = getProduct(id);
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });

    const token = (await ensureToken()).accessToken!;
    const salvo = product.channelAttrs?.mercadolivre;
    const categoryId = pedida?.trim().toUpperCase() || salvo?.categoryId || await predictCategory(product.title, token);
    if (!categoryId) {
      return reply.status(422).send({
        error: 'o Mercado Livre nao achou categoria para este titulo. Coloque marca e modelo no titulo, ou informe a categoria.',
      });
    }

    const [category, atributos] = await Promise.all([
      fetchCategory(categoryId, token),
      fetchCategoryAttributes(categoryId, token),
    ]);
    return {
      category,
      fields: requiredFields(atributos, formAttributeIds(product)),
      // valores salvos so valem para a categoria em que foram escolhidos
      saved: salvo?.categoryId === category.id ? salvo.attributes : {},
    };
  });

  app.put('/products/:id/ml-attributes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = mlAttrsBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: invalidMessage(parsed.error), issues: parsed.error.issues });

    // campo deixado em branco nao vai para o ML
    const attributes = Object.fromEntries(
      Object.entries(parsed.data.attributes).filter(([, v]) => v.value_id || v.value_name?.trim()),
    );
    const product = setChannelAttrs(id, 'mercadolivre', {
      categoryId: parsed.data.categoryId,
      categoryName: parsed.data.categoryName,
      attributes,
    });
    if (!product) return reply.status(404).send({ error: 'produto nao encontrado' });
    return { product };
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

  app.get('/ai/status', async () => ({
    configured: aiConfigured(),
    model: config.gemini.model,
    image: {
      configured: imageAiConfigured(),
      model: config.gemini.imageModel,
      modes: Object.entries(ENHANCE_MODES).map(([id, m]) => ({ id, label: m.label })),
    },
  }));

  /**
   * Gera uma versao tratada de uma foto sua. Nao sobrescreve nada: a versao
   * entra como imagem nova, e desfazer e apaga-la.
   */
  app.post('/images/:imageId/enhance', async (req, reply) => {
    const { imageId } = req.params as { imageId: string };
    const { mode } = (req.body ?? {}) as { mode?: string };
    if (!mode || !(mode in ENHANCE_MODES)) {
      return reply.status(400).send({ error: `modo invalido. Use: ${Object.keys(ENHANCE_MODES).join(', ')}` });
    }
    const out = await enhanceImage(imageId, mode as EnhanceMode);
    logEvent('info', `foto tratada com IA (${mode})`, { productId: out.product.id });
    return reply.status(201).send(out);
  });

  /** Escreve um anuncio novo a partir do nome do produto e do contexto livre. */
  app.post('/ai/draft', async (req, reply) => {
    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: invalidMessage(parsed.error), issues: parsed.error.issues });
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
