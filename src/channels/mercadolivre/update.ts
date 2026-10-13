import { request } from '../../lib/http.ts';
import type { Product } from '../../domain/product.ts';
import type { PublishResult } from '../types.ts';
import { buildDescription } from '../../services/templates.ts';
import { comDica, situacaoNoMl } from './errors.ts';
import { ML_API } from './auth.ts';
import { allAttributes, saleTerms } from './map.ts';
import type { MlItem } from './importer.ts';

/**
 * Atualiza um anuncio que ja existe no ML (importado ou publicado daqui),
 * em vez de criar outro: mantem o numero, as visitas e o historico.
 *
 * - ativo/pausado: PUT /items/:id com preco, quantidade, fotos, atributos e
 *   (sem vendas ainda) titulo; descricao em PUT /items/:id/description;
 *   pausado volta a ficar ativo.
 * - encerrado: o ML nao edita anuncio encerrado. O caminho dele e o relist
 *   (POST /items/:id/relist), que republica o mesmo anuncio com numero novo;
 *   depois disso, a atualizacao segue no numero novo.
 *
 * Devolve { semVolta } quando o anuncio antigo nao pode mais voltar (relist
 * recusado): ai quem chama cria um anuncio novo.
 */
export async function updateExisting(
  product: Product,
  externalId: string,
  token: string,
): Promise<{ result: PublishResult } | { semVolta: string }> {
  const headers = { authorization: `Bearer ${token}` };
  const atual = await request<MlItem>(`${ML_API}/items/${encodeURIComponent(externalId)}`, { headers });
  const avisos: string[] = [];
  let id = atual.id ?? externalId;
  let permalink = atual.permalink;

  if (atual.status === 'closed') {
    try {
      const novo = await request<{ id: string; permalink?: string }>(`${ML_API}/items/${id}/relist`, {
        method: 'POST',
        headers,
        json: {
          price: product.priceCents / 100,
          quantity: product.quantity,
          listing_type_id: atual.listing_type_id ?? 'gold_special',
        },
      });
      avisos.push(`O anuncio ${id} estava encerrado: o ML o republicou com o numero ${novo.id}.`);
      id = novo.id;
      permalink = novo.permalink ?? permalink;
    } catch (err) {
      return { semVolta: (err as Error).message };
    }
  }

  // Titulo so muda em anuncio sem venda, e no modelo de produto (family_name)
  // quem monta o titulo e o ML.
  const podeTitulo = !atual.sold_quantity && !atual.family_name && product.kind === 'geral';
  const completo: Record<string, unknown> = {
    ...(podeTitulo ? { title: product.title.slice(0, 60) } : {}),
    price: product.priceCents / 100,
    available_quantity: product.quantity,
    pictures: product.images.map((i) => ({ source: i.url })),
    attributes: allAttributes(product),
    ...(product.kind === 'geral' ? { sale_terms: saleTerms(product) } : {}),
  };
  if (!product.images.length) delete completo.pictures;

  let enviado = completo;
  let resposta: unknown;
  try {
    resposta = await request(`${ML_API}/items/${id}`, { method: 'PUT', headers, json: completo });
  } catch (err) {
    // Atributo bloqueado ou titulo travado nao podem impedir o resto
    // (preco, fotos, descricao): tenta de novo so com o essencial.
    const essencial = { price: completo.price, available_quantity: completo.available_quantity,
      ...(completo.pictures ? { pictures: completo.pictures } : {}) };
    try {
      resposta = await request(`${ML_API}/items/${id}`, { method: 'PUT', headers, json: essencial });
      enviado = essencial;
      avisos.push(`O ML nao aceitou mudar titulo/atributos/garantia (${(err as Error).message}); `
        + 'preco, quantidade e fotos foram atualizados.');
    } catch (err2) {
      throw comDica(err2);
    }
  }

  const texto = buildDescription(product);
  try {
    await request(`${ML_API}/items/${id}/description`, { method: 'PUT', headers, json: { plain_text: texto } });
  } catch {
    try {
      await request(`${ML_API}/items/${id}/description`, { method: 'POST', headers, json: { plain_text: texto } });
    } catch (err) {
      avisos.push(`A descricao nao foi atualizada (${(err as Error).message}).`);
    }
  }

  if (atual.status === 'paused') {
    try {
      await request(`${ML_API}/items/${id}`, { method: 'PUT', headers, json: { status: 'active' } });
      avisos.push('O anuncio estava pausado e voltou a ficar ativo.');
    } catch (err) {
      avisos.push(`O anuncio continua pausado: o ML nao reativou (${(err as Error).message}).`);
    }
  }

  // Pausado foi reativado acima; o resto (pagamento pendente, revisao) segue
  // como o ML diz, com o aviso do que fazer.
  const situacao = atual.status === 'paused' || atual.status === 'closed'
    ? situacaoNoMl('active') : situacaoNoMl(atual.status);
  if (situacao.aviso) avisos.push(situacao.aviso);

  return {
    result: {
      status: situacao.status,
      externalId: id,
      permalink,
      payload: enviado,
      result: resposta,
      message: `anuncio ${id} atualizado no Mercado Livre${avisos.length ? `. ${avisos.join(' ')}` : ''}`,
    },
  };
}

