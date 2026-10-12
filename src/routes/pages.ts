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
  button { width:100%; padding:.95rem; font-size:1.05rem; border-radius:.6rem; margin-top:.6rem;
           border:2px solid #0a63c9; background:transparent; color:#0a63c9; }
  button.primary { border-color:#0a63c9; background:#0a63c9; color:#fff; margin-top:1rem; }
  button[disabled] { opacity:.45; }
  h2 { font-size:.9rem; font-weight:600; opacity:.7; margin:1.4rem 0 .4rem; }
  #log { margin-top:1rem; }
  .thumbs { display:grid; grid-template-columns:repeat(3,1fr); gap:.4rem; margin-top:.4rem; }
  .thumbs figure { margin:0; position:relative; }
  .thumbs img { width:100%; aspect-ratio:1; object-fit:cover; border-radius:.4rem; }
  .thumbs button { position:absolute; top:.15rem; right:.15rem; width:auto; margin:0; padding:.05rem .4rem;
                   font-size:.9rem; border-radius:.3rem; background:rgba(0,0,0,.6); color:#fff; border:0; }
</style>
<h1>${esc(product.title)}</h1>

<!--
  Dois caminhos, e por isso dois inputs: 'capture' manda o celular abrir a camera
  direto, sem passar pelo seletor de arquivos. Um input so com capture (como era
  antes) deixa as fotos que ja estao no telefone inalcancaveis; um input so sem
  capture perde o atalho de fotografar na hora.
-->
<input type="file" id="cam" accept="image/*" capture="environment" multiple hidden>
<input type="file" id="gal" accept="image/*" multiple hidden>

<button type="button" id="b-cam">📷 Fotografar agora</button>
<button type="button" id="b-gal">🖼️ Escolher da galeria</button>

<h2 id="fila-titulo" hidden>Para enviar</h2>
<div class="thumbs" id="fila"></div>

<button type="button" id="enviar" class="primary" disabled>Enviar fotos</button>
<div id="log"></div>

<h2 id="ja-titulo"${product.images.length ? '' : ' hidden'}>Já no anúncio</h2>
<div class="thumbs" id="thumbs">${product.images.map((i) => `<figure><img src="${esc(i.url)}" alt=""></figure>`).join('')}</div>
<script>
const log = document.getElementById('log');
const enviar = document.getElementById('enviar');
const fila = document.getElementById('fila');
const filaTitulo = document.getElementById('fila-titulo');

// Cada input guarda so a ultima selecao, entao a fila vive aqui: assim
// fotografar agora nao apaga o que veio da galeria, e vice-versa.
const pendentes = [];

function desenharFila() {
  fila.innerHTML = pendentes.map((p, i) =>
    '<figure><img src="' + p.preview + '" alt=""><button type="button" data-i="' + i + '">✕</button></figure>'
  ).join('');
  filaTitulo.hidden = pendentes.length === 0;
  enviar.disabled = pendentes.length === 0;
  enviar.textContent = pendentes.length
    ? 'Enviar ' + pendentes.length + ' foto(s)'
    : 'Enviar fotos';
}

function adicionar(input) {
  for (const file of input.files) {
    pendentes.push({ file: file, preview: URL.createObjectURL(file) });
  }
  input.value = ''; // permite escolher o mesmo arquivo de novo
  desenharFila();
}

document.getElementById('b-cam').addEventListener('click', () => document.getElementById('cam').click());
document.getElementById('b-gal').addEventListener('click', () => document.getElementById('gal').click());
document.getElementById('cam').addEventListener('change', (ev) => adicionar(ev.target));
document.getElementById('gal').addEventListener('change', (ev) => adicionar(ev.target));

fila.addEventListener('click', (ev) => {
  const alvo = ev.target.closest('button[data-i]');
  if (!alvo) return;
  const [removido] = pendentes.splice(Number(alvo.dataset.i), 1);
  URL.revokeObjectURL(removido.preview);
  desenharFila();
});

enviar.addEventListener('click', async () => {
  if (!pendentes.length) return;
  const fd = new FormData();
  for (const p of pendentes) fd.append('images', p.file);
  enviar.disabled = true;
  log.textContent = 'Enviando ' + pendentes.length + ' foto(s)...';
  try {
    const res = await fetch(location.pathname + '/images', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'falha no envio');
    log.textContent = 'Pronto. ' + data.product.images.length + ' foto(s) no anúncio.';
    document.getElementById('ja-titulo').hidden = false;
    document.getElementById('thumbs').innerHTML =
      data.product.images.map((i) => '<figure><img src="' + i.url + '" alt=""></figure>').join('');
    for (const p of pendentes) URL.revokeObjectURL(p.preview);
    pendentes.length = 0;
    desenharFila();
  } catch (err) {
    log.textContent = 'Erro: ' + err.message;
    enviar.disabled = false;
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
