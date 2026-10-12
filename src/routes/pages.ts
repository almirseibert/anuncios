import type { FastifyInstance } from 'fastify';
import { formatBRL } from '../domain/product.ts';
import { addImage, getProduct } from '../services/products.ts';
import { illustrativeNote, locationLine, specLines } from '../services/templates.ts';
import { ACCEPTED_MIME, processUpload } from '../services/images.ts';
import { productIdForToken } from '../services/uploadTokens.ts';

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
  ${illustrativeNote(p) ? `<p class="muted">${esc(illustrativeNote(p))}</p>` : ''}
</main>`);
  });

  /**
   * Envio de fotos pelo celular. Pagina minima, sem senha: quem autoriza e o
   * token do link, que vale 2 horas e serve a um produto so. O painel mostra
   * isto como QR Code.
   */
  app.get('/m/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const productId = productIdForToken(token);
    const product = productId ? getProduct(productId) : undefined;
    if (!product) {
      return reply.status(404).type('text/html').send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<p style="font:16px system-ui;padding:2rem">Este link expirou. Gere um novo QR Code no painel.</p>',
      );
    }

    return reply.type('text/html').send(`<!doctype html>
<html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fotos - ${esc(product.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font:17px/1.5 system-ui,sans-serif; margin:0; padding:1.25rem; }
  h1 { font-size:1.15rem; margin:0 0 1rem; }
  label { display:block; border:2px dashed currentColor; border-radius:.75rem; padding:1.5rem 1rem;
          text-align:center; opacity:.85; }
  input[type=file] { display:block; margin:.75rem auto 0; }
  button { width:100%; padding:.9rem; font-size:1.05rem; border-radius:.6rem; margin-top:1rem;
           border:0; background:#0a63c9; color:#fff; }
  button[disabled] { opacity:.5; }
  #log { margin-top:1rem; }
  .thumbs { display:grid; grid-template-columns:repeat(3,1fr); gap:.4rem; margin-top:1rem; }
  .thumbs img { width:100%; aspect-ratio:1; object-fit:cover; border-radius:.4rem; }
</style>
<h1>${esc(product.title)}</h1>
<form id="f">
  <label>Tirar foto ou escolher da galeria
    <input type="file" id="files" accept="image/*" capture="environment" multiple required>
  </label>
  <button type="submit">Enviar fotos</button>
</form>
<div id="log"></div>
<div class="thumbs" id="thumbs">${product.images.map((i) => `<img src="${esc(i.url)}" alt="">`).join('')}</div>
<script>
const form = document.getElementById('f');
const log = document.getElementById('log');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = document.getElementById('files');
  if (!input.files.length) return;
  const fd = new FormData();
  for (const f of input.files) fd.append('images', f);
  const btn = form.querySelector('button');
  btn.disabled = true;
  log.textContent = 'Enviando ' + input.files.length + ' foto(s)...';
  try {
    const res = await fetch(location.pathname + '/images', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'falha no envio');
    log.textContent = 'Pronto. ' + data.product.images.length + ' foto(s) no anuncio.';
    document.getElementById('thumbs').innerHTML =
      data.product.images.map((i) => '<img src="' + i.url + '" alt="">').join('');
    input.value = '';
  } catch (err) {
    log.textContent = 'Erro: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});
</script>`);
  });

  app.post('/m/:token/images', async (req, reply) => {
    const { token } = req.params as { token: string };
    const productId = productIdForToken(token);
    if (!productId) return reply.status(404).send({ error: 'link expirado' });

    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!ACCEPTED_MIME.has(part.mimetype)) {
        return reply.status(400).send({ error: `tipo nao aceito: ${part.mimetype}` });
      }
      const processed = await processUpload(await part.toBuffer(), { productId });
      addImage(productId, { ...processed, origin: 'upload' });
      saved.push(processed.filename);
    }
    if (saved.length === 0) return reply.status(400).send({ error: 'nenhuma imagem recebida' });
    return reply.status(201).send({ product: getProduct(productId) });
  });
}
