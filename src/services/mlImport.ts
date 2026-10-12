import { draftFromItem, fetchItemsWithDescription, listSellerItemIds } from '../channels/mercadolivre/importer.ts';
import { logEvent } from './events.ts';
import { fetchFirstImage, processUpload } from './images.ts';
import { addImage, createProduct, setChannelAttrs } from './products.ts';
import { findListingByExternalId, linkListing, wasRemoved } from './publish.ts';

export interface ImportReport {
  /** Anuncios encontrados na conta (ativos, pausados, encerrados). */
  encontrados: number;
  importados: Array<{ productId: string; externalId: string; title: string; fotos: number; fotosFalharam: number }>;
  jaImportados: number;
  /** Anuncios de produtos que voce excluiu aqui: ficam de fora. */
  excluidos: number;
  pulados: Array<{ externalId: string; title: string; motivo: string }>;
}

/**
 * Traz para ca os anuncios da conta do ML que ainda nao estao aqui. Cada um
 * vira um produto ligado ao anuncio original: publicar depois atualiza o mesmo
 * anuncio. Rodar de novo so traz os novos.
 *
 * As fotos passam por processUpload como qualquer outra (EXIF fora, 1600 px) e
 * entram como foto sua ('url'): sao as fotos que voce mesmo publicou.
 */
export async function importFromMercadoLivre(): Promise<ImportReport> {
  const ids = await listSellerItemIds();
  const excluidos = ids.filter((id) => wasRemoved('mercadolivre', id));
  const novos = ids.filter((id) => !excluidos.includes(id) && !findListingByExternalId('mercadolivre', id));
  const report: ImportReport = {
    encontrados: ids.length,
    importados: [],
    jaImportados: ids.length - novos.length - excluidos.length,
    excluidos: excluidos.length,
    pulados: [],
  };

  for (const { item, descricao } of await fetchItemsWithDescription(novos)) {
    const draft = draftFromItem(item, descricao);
    if ('pulado' in draft) {
      report.pulados.push({ externalId: item.id, title: item.title ?? '', motivo: draft.pulado });
      continue;
    }
    const product = createProduct(draft.input);
    if (draft.categoryId || Object.keys(draft.mlAttributes).length) {
      setChannelAttrs(product.id, 'mercadolivre', { categoryId: draft.categoryId, attributes: draft.mlAttributes });
    }

    let fotos = 0;
    let fotosFalharam = 0;
    for (const variantes of draft.pictureUrls) {
      try {
        const processed = await processUpload(await fetchFirstImage(variantes), { productId: product.id });
        addImage(product.id, {
          ...processed,
          origin: 'url',
          sourceUrl: variantes.at(-1)!,
          sourceLabel: `anuncio ${item.id} no Mercado Livre`,
        });
        fotos++;
      } catch {
        fotosFalharam++;
      }
    }

    linkListing(product.id, 'mercadolivre', draft.listing);
    logEvent('info', `importado do Mercado Livre (${item.id})`, { productId: product.id, channel: 'mercadolivre' });
    report.importados.push({ productId: product.id, externalId: item.id, title: product.title, fotos, fotosFalharam });
  }
  return report;
}
