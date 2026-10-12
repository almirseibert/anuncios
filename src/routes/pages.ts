import type { FastifyInstance } from 'fastify';
import { formatBRL } from '../domain/product.ts';
import { getProduct } from '../services/products.ts';
import { locationLine, specLines } from '../services/templates.ts';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function registerPageRoutes(app: FastifyInstance) {
  /**
   * Pagina publica do produto. O catalogo da Meta exige uma URL de destino
   * para cada item, e ela tambem serve de link para colar em grupos.
   */
  app.get('/produtos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProduct(id);
    if (!p) return reply.status(404).type('text/html').send('<h1>Anuncio nao encontrado</h1>');

    const specs = specLines(p).map((l) => `<li>${esc(l)}</li>`).join('');
    const photos = p.images
      .map((i) => `<img src="${esc(i.url)}" alt="${esc(p.title)}" loading="lazy">`)
      .join('');

    return reply.type('text/html').send(`<!doctype html>
<html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title>
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description.slice(0, 200))}">
${p.images[0] ? `<meta property="og:image" content="${esc(p.images[0].url)}">` : ''}
<style>
  :root { color-scheme: light dark; --fg:#15171a; --muted:#5b6066; --bg:#fff; --line:#e3e6ea; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e9ecef; --muted:#9aa2ab; --bg:#15171a; --line:#2b2f35; } }
  body { font:16px/1.6 system-ui,sans-serif; margin:0; color:var(--fg); background:var(--bg); }
  main { max-width:48rem; margin:0 auto; padding:1.5rem 1rem 4rem; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  .price { font-size:1.6rem; font-weight:700; margin:.5rem 0 1rem; }
  .gallery { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fill,minmax(14rem,1fr)); }
  .gallery img { width:100%; border-radius:.5rem; border:1px solid var(--line); aspect-ratio:4/3; object-fit:cover; }
  ul { padding-left:1.1rem; } .muted { color:var(--muted); }
  p { white-space:pre-wrap; }
</style>
<main>
  <h1>${esc(p.title)}</h1>
  <div class="muted">${esc(locationLine(p))}</div>
  <div class="price">${esc(formatBRL(p.priceCents))}</div>
  <div class="gallery">${photos}</div>
  <p>${esc(p.description)}</p>
  ${specs ? `<h2>Detalhes</h2><ul>${specs}</ul>` : ''}
  ${p.acceptsTrade ? '<p class="muted">Aceito troca.</p>' : ''}
</main>`);
  });
}
