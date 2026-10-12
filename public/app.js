// Painel do sistema de anuncios. Sem build: ES modules puros no navegador.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { products: [], channels: [], config: null, editing: null, ai: null };

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cents) => BRL.format((cents ?? 0) / 100);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.body instanceof FormData ? undefined : { 'content-type': 'application/json', ...opts.headers },
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `erro ${res.status}`);
  return data;
}

// ---------- navegacao ----------

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-current', String(t === tab)));
    for (const view of ['produtos', 'canais', 'eventos']) {
      $(`#view-${view}`).hidden = view !== tab.dataset.view;
    }
    if (tab.dataset.view === 'canais') loadChannels();
    if (tab.dataset.view === 'eventos') loadEvents();
  });
});

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- produtos ----------

async function loadProducts() {
  const { products } = await api('/products');
  state.products = products;
  renderProducts();
}

function renderProducts() {
  const term = $('#busca').value.trim().toLowerCase();
  const items = state.products.filter((p) =>
    !term || JSON.stringify([p.title, p.city, p.attrs]).toLowerCase().includes(term));

  $('#vazio').hidden = state.products.length > 0;
  $('#lista').innerHTML = items.map((p) => {
    const pills = p.listings.map((l) =>
      `<span class="pill ${l.status}">${esc(channelLabel(l.channel))}: ${esc(l.status)}</span>`).join('');
    return `<article class="card">
      ${p.images[0] ? `<img class="thumb" src="${esc(p.images[0].url)}" alt="">` : '<div class="thumb"></div>'}
      <h3>${esc(p.title)}</h3>
      <div class="price">${money(p.priceCents)}</div>
      <div class="muted">${esc([p.kind, p.city, p.uf].filter(Boolean).join(' · '))}</div>
      <div class="row">${pills || '<span class="pill">sem anúncios</span>'}</div>
      <div class="row">
        <button data-act="publicar" data-id="${p.id}" class="primary">Publicar</button>
        <button data-act="editar" data-id="${p.id}">Editar</button>
        <span class="spacer"></span>
        <button data-act="excluir" data-id="${p.id}" class="ghost">Excluir</button>
      </div>
    </article>`;
  }).join('');
}

$('#busca').addEventListener('input', renderProducts);

$('#lista').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const product = state.products.find((p) => p.id === btn.dataset.id);
  if (btn.dataset.act === 'editar') openForm(product);
  if (btn.dataset.act === 'publicar') openDetail(product.id);
  if (btn.dataset.act === 'excluir') {
    if (!confirm(`Excluir "${product.title}" e suas fotos? Os anúncios já publicados nas plataformas NÃO são removidos.`)) return;
    await api(`/products/${product.id}`, { method: 'DELETE' });
    loadProducts();
  }
});

// ---------- formulario ----------

const KIND_PREFIX = { geral: 'g_', veiculo: 'v_', imovel: 'i_' };

function syncKindFields() {
  const kind = $('#kind').value;
  for (const k of Object.keys(KIND_PREFIX)) $(`#attrs-${k}`).hidden = k !== kind;
}
$('#kind').addEventListener('change', syncKindFields);

$('[name="title"]').addEventListener('input', (ev) => {
  const n = ev.target.value.length;
  $('#tcount').textContent = `${n}/120`;
});

$('#novo').addEventListener('click', () => openForm(null));

// ---------- geracao com IA ----------

/** Escreve o rascunho do Gemini nos campos, sem apagar o que o usuario ja digitou de preco/local. */
function applyDraft(draft) {
  const form = $('#form-produto');
  const kind = $('#kind').value;
  form.title.value = draft.title ?? form.title.value;
  form.description.value = draft.description ?? form.description.value;

  const prefix = KIND_PREFIX[kind];
  for (const [key, value] of Object.entries(draft.attrs ?? {})) {
    const field = form[`${prefix}${key}`];
    if (!field || value === '' || value == null) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else if (Array.isArray(value)) field.value = value.join(', ');
    else field.value = value;
  }

  $('#tcount').textContent = `${form.title.value.length}/120`;

  const bloco = (titulo, itens) => itens?.length
    ? `<h4>${titulo}</h4><ul class="nota">${itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  $('#ai-saida').innerHTML = [
    bloco('Pontos fortes usados', draft.highlights),
    bloco('Deduções da IA — confira se procede', draft.assumptions),
    bloco('Informe isto para vender mais rápido', draft.questions),
    draft.keywords?.length ? `<h4>Termos de busca</h4><p class="muted">${esc(draft.keywords.join(', '))}</p>` : '',
  ].join('');
}

$('#ai-gerar').addEventListener('click', async (ev) => {
  const form = $('#form-produto');
  const input = $('#ai-input').value.trim() || form.title.value.trim();
  if (!input) return ($('#ai-status').textContent = 'Escreva o que você está vendendo.');

  ev.target.disabled = true;
  $('#ai-status').textContent = 'escrevendo...';
  $('#ai-saida').innerHTML = '';
  try {
    const path = state.editing ? `/products/${state.editing}/ai/improve` : '/ai/draft';
    const body = state.editing
      ? { input: $('#ai-input').value.trim() }
      : {
          kind: $('#kind').value,
          input,
          priceCents: Math.round(Number(form.price.value || 0) * 100) || undefined,
          city: form.city.value || undefined,
          uf: form.uf.value || undefined,
        };
    const { draft } = await api(path, { method: 'POST', body: JSON.stringify(body) });
    applyDraft(draft);
    $('#ai-status').textContent = 'pronto — revise antes de salvar';
  } catch (err) {
    $('#ai-status').textContent = '';
    $('#ai-saida').innerHTML = `<p class="erro">${esc(err.message)}</p>`;
  } finally {
    ev.target.disabled = false;
  }
});

function openForm(product) {
  const form = $('#form-produto');
  form.reset();
  state.editing = product?.id ?? null;
  $('#form-titulo').textContent = product ? 'Editar produto' : 'Novo produto';
  $('#form-erro').textContent = '';

  if (product) {
    $('#kind').value = product.kind;
    form.title.value = product.title;
    form.price.value = (product.priceCents / 100).toFixed(2);
    form.condition.value = product.condition;
    form.quantity.value = product.quantity;
    form.acceptsTrade.checked = product.acceptsTrade;
    form.description.value = product.description;
    for (const f of ['cep', 'city', 'uf', 'neighborhood']) form[f].value = product[f] ?? '';
    const prefix = KIND_PREFIX[product.kind];
    for (const [key, value] of Object.entries(product.attrs ?? {})) {
      const field = form[`${prefix}${key === 'condoFeeCents' ? 'condoFee' : key === 'iptuCents' ? 'iptu' : key}`];
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else if (Array.isArray(value)) field.value = value.join(', ');
      else if (key.endsWith('Cents')) field.value = (Number(value) / 100).toFixed(2);
      else field.value = value ?? '';
    }
  }
  $('#ai-input').value = '';
  $('#ai-saida').innerHTML = '';
  $('#ai-status').textContent = '';
  $('#ai-gerar').textContent = product ? 'Reescrever anúncio' : 'Escrever anúncio';
  $('#ai-input').placeholder = product
    ? 'Opcional: o que mudar ou acrescentar (ex: "destaque que tem 2 controles e caixa original").'
    : 'Ex: Playstation 4 slim 1TB com 2 controles, vendo porque comprei o PS5. Pouco uso, sempre em casa.';

  syncKindFields();
  $('#tcount').textContent = `${form.title.value.length}/120`;
  $('#dlg-produto').showModal();
}

function collectAttrs(form, kind) {
  const p = KIND_PREFIX[kind];
  const val = (name) => form[`${p}${name}`]?.value ?? '';
  const num = (name) => Number(val(name) || 0);
  const checked = (name) => Boolean(form[`${p}${name}`]?.checked);
  const list = (name) => val(name).split(',').map((s) => s.trim()).filter(Boolean);

  if (kind === 'veiculo') {
    return {
      vehicleType: val('vehicleType'), brand: val('brand'), model: val('model'), version: val('version'),
      yearManufacture: num('yearManufacture'), yearModel: num('yearModel'), km: num('km'),
      fuel: val('fuel'), transmission: val('transmission'), color: val('color'), doors: num('doors'),
      plateEnd: val('plateEnd'), licensed: checked('licensed'), singleOwner: checked('singleOwner'),
      features: list('features'),
    };
  }
  if (kind === 'imovel') {
    return {
      operation: val('operation'), propertyType: val('propertyType'),
      usableAreaM2: num('usableAreaM2'), totalAreaM2: num('totalAreaM2'),
      bedrooms: num('bedrooms'), suites: num('suites'), bathrooms: num('bathrooms'),
      parkingSpots: num('parkingSpots'),
      condoFeeCents: Math.round(num('condoFee') * 100), iptuCents: Math.round(num('iptu') * 100),
      furnished: checked('furnished'), features: list('features'),
    };
  }
  return { brand: val('brand'), model: val('model'), wear: val('wear'), warranty: val('warranty') };
}

$('#form-produto').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const kind = $('#kind').value;
  const body = {
    kind,
    title: form.title.value,
    description: form.description.value,
    priceCents: Math.round(Number(form.price.value || 0) * 100),
    condition: form.condition.value,
    quantity: Number(form.quantity.value || 1),
    acceptsTrade: form.acceptsTrade.checked,
    cep: form.cep.value, city: form.city.value, uf: form.uf.value.toUpperCase(),
    neighborhood: form.neighborhood.value,
    attrs: collectAttrs(form, kind),
  };
  try {
    const saved = state.editing
      ? await api(`/products/${state.editing}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/products', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-produto').close();
    await loadProducts();
    openDetail(saved.product.id);
  } catch (err) {
    $('#form-erro').textContent = err.message;
  }
});

// ---------- detalhe + publicacao ----------

function channelLabel(id) {
  return state.channels.find((c) => c.id === id)?.label ?? id;
}

const ORIGIN_TAG = {
  catalogo: { tag: 'ilustrativa', hint: 'foto oficial do catálogo do Mercado Livre: mostra o modelo, não o seu item' },
  ia: { tag: 'IA', hint: 'versão tratada por IA a partir de uma foto sua' },
  url: { tag: 'link', hint: 'foto importada de um link' },
};

/** Um quadro da galeria: miniatura, selos de capa/origem, dimensão e ações. */
function photoCard(img, idx) {
  const marca = ORIGIN_TAG[img.origin];
  const dim = img.width ? `${img.width}×${img.height}` : '';
  const podeIa = Boolean(state.ai?.image?.configured) && img.origin !== 'catalogo';
  return `
    <figure class="shot" draggable="true" data-id="${img.id}" data-origin="${esc(img.origin)}">
      <img src="${esc(img.url)}" alt="" loading="lazy">
      <div class="shot-tags">
        ${idx === 0 ? '<span class="tag capa">capa</span>' : ''}
        ${marca ? `<span class="tag ${esc(img.origin)}" title="${esc(img.sourceLabel || marca.hint)}">${marca.tag}</span>` : ''}
      </div>
      <div class="shot-acts">
        ${podeIa ? `<button data-enhance="${img.id}" title="Melhorar com IA">✨</button>` : ''}
        <button data-img="${img.id}" title="Remover">✕</button>
      </div>
      ${dim ? `<figcaption class="muted">${dim}</figcaption>` : ''}
    </figure>`;
}

async function openDetail(id) {
  const data = await api(`/products/${id}`);
  state.channels = data.channels.length ? data.channels : state.channels;
  const { product, listings, channels } = data;

  $('#det-titulo').textContent = product.title;
  const podeIa = Boolean(state.ai?.image?.configured);
  $('#det-corpo').innerHTML = `
    <section>
      <h3>Fotos</h3>
      <div class="gallery" id="galeria">${product.images.map(photoCard).join('')}</div>
      <p class="row">
        <input type="file" id="files" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple>
        <button id="upload">Enviar fotos</button>
        <button id="qr">Enviar do celular</button>
        <button id="link">Colar link de foto</button>
        ${product.kind === 'geral' ? '<button id="catalogo">Buscar fotos do catálogo</button>' : ''}
      </p>
      <div id="foto-painel"></div>
      <small class="muted">
        Arraste para reordenar. A primeira foto é a capa e tem de ser foto sua — foto de catálogo é ilustrativa
        e entra depois.${podeIa ? ' O ✨ gera uma versão tratada da foto, sem apagar a original.' : ''}
      </small>
    </section>
    <section>
      <h3>Canais</h3>
      ${channels.map((c) => {
        const listing = listings.find((l) => l.channel === c.id);
        const errors = c.issues.filter((i) => i.severity === 'error');
        return `<div class="channel-row">
          <label>
            <input type="checkbox" class="ch" value="${c.id}" ${errors.length ? '' : 'checked'}>
            <span>${esc(c.label)} <small class="muted">(${c.mode})</small></span>
          </label>
          ${listing ? `<span class="pill ${listing.status}">${esc(listing.status)}</span>` : ''}
          ${listing?.permalink ? `<a href="${esc(listing.permalink)}" target="_blank" rel="noopener">abrir</a>` : ''}
          ${c.mode === 'manual' ? `<button data-kit="${c.id}">Ver kit</button>` : ''}
          ${listing?.externalId && c.id === 'mercadolivre'
            ? `<button data-pause="${c.id}">Pausar</button><button data-close-ad="${c.id}">Encerrar</button>` : ''}
          ${c.issues.length ? `<ul class="issues">${c.issues.map((i) =>
            `<li class="${i.severity}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
        </div>`;
      }).join('')}
      <p class="row">
        <button id="publicar" class="primary">Publicar nos canais marcados</button>
        <label class="row"><input type="checkbox" id="dry" ${state.config?.dryRun ? 'checked' : ''}> simular (dry-run)</label>
        <label class="row"><input type="checkbox" id="force"> ignorar bloqueios</label>
      </p>
      <div id="resultado"></div>
    </section>`;

  $('#det-corpo').dataset.productId = product.id;
  installGalleryDnd(product.id);
  if (!$('#dlg-detalhe').open) $('#dlg-detalhe').showModal();
}

/**
 * Reordenar arrastando. A ordem nova vai para a API, que recusa foto
 * ilustrativa na capa -- quando isso acontece, voltamos a ordem anterior.
 */
function installGalleryDnd(productId) {
  const galeria = $('#galeria');
  if (!galeria) return;
  let arrastando = null;

  galeria.addEventListener('dragstart', (ev) => {
    arrastando = ev.target.closest('.shot');
    if (!arrastando) return;
    arrastando.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
  });

  galeria.addEventListener('dragend', () => {
    arrastando?.classList.remove('dragging');
    arrastando = null;
  });

  galeria.addEventListener('dragover', (ev) => {
    if (!arrastando) return;
    ev.preventDefault();
    const alvo = ev.target.closest('.shot');
    if (!alvo || alvo === arrastando) return;
    const r = alvo.getBoundingClientRect();
    const depois = ev.clientX > r.left + r.width / 2;
    alvo.parentNode.insertBefore(arrastando, depois ? alvo.nextSibling : alvo);
  });

  galeria.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const ids = $$('.shot', galeria).map((f) => f.dataset.id);
    try {
      await api(`/products/${productId}/images/order`, { method: 'PUT', body: JSON.stringify({ ids }) });
      await loadProducts();
      openDetail(productId);
    } catch (err) {
      alert(err.message);
      openDetail(productId); // desfaz o arrasto na tela
    }
  });
}

function fotoPainel(html) {
  $('#foto-painel').innerHTML = html;
}

/** Candidatas do catalogo do ML: nada entra sem voce marcar. */
async function abrirCatalogo(productId) {
  fotoPainel('<p class="muted">Procurando no catálogo do Mercado Livre...</p>');
  let data;
  try {
    data = await api(`/products/${productId}/reference-images`);
  } catch (err) {
    return fotoPainel(`<p class="erro">${esc(err.message)}</p>`);
  }
  if (!data.candidates.length) {
    return fotoPainel(`<p class="muted">${esc(data.message ?? 'nenhuma foto encontrada')}</p>`);
  }
  fotoPainel(`
    <div class="painel">
      <p><strong>Fotos oficiais do catálogo</strong> — ilustram o modelo, não o seu item.
      Elas entram depois das suas fotos e a descrição ganha o aviso de foto ilustrativa.</p>
      <div class="gallery">${data.candidates.map((c, i) => `
        <figure class="shot">
          <label><input type="checkbox" class="refbox" data-i="${i}"><img src="${esc(c.url)}" alt="" loading="lazy"></label>
          <figcaption class="muted">${esc(c.label)}</figcaption>
        </figure>`).join('')}
      </div>
      <p class="row"><button id="ref-add" class="primary">Adicionar selecionadas</button>
      <button id="ref-cancel">Fechar</button><span id="ref-status" class="muted"></span></p>
    </div>`);

  $('#ref-cancel').onclick = () => fotoPainel('');
  $('#ref-add').onclick = async (ev) => {
    const escolhidas = $$('.refbox').filter((b) => b.checked).map((b) => data.candidates[Number(b.dataset.i)]);
    if (!escolhidas.length) return alert('Marque as fotos que você quer.');
    ev.target.disabled = true;
    $('#ref-status').textContent = 'baixando...';
    try {
      await api(`/products/${productId}/reference-images`, {
        method: 'POST',
        body: JSON.stringify({ images: escolhidas }),
      });
      await loadProducts();
      openDetail(productId);
    } catch (err) {
      $('#ref-status').textContent = '';
      alert(err.message);
      ev.target.disabled = false;
    }
  };
}

async function abrirQr(productId) {
  fotoPainel('<p class="muted">Gerando QR Code...</p>');
  try {
    const qr = await api(`/products/${productId}/upload-qr`);
    const expira = new Date(qr.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    fotoPainel(`
      <div class="painel qr">
        <div>${qr.svg}</div>
        <div>
          <p><strong>Aponte a câmera do celular.</strong> O link abre uma página de envio e vale até ${esc(expira)}.</p>
          <p class="muted"><a href="${esc(qr.url)}" target="_blank" rel="noopener">${esc(qr.url)}</a></p>
          ${qr.warning ? `<p class="erro">${esc(qr.warning)}</p>` : ''}
          <p class="row"><button id="qr-pronto">Já enviei, atualizar</button><button id="qr-fechar">Fechar</button></p>
        </div>
      </div>`);
    $('#qr-fechar').onclick = () => fotoPainel('');
    $('#qr-pronto').onclick = async () => { await loadProducts(); openDetail(productId); };
  } catch (err) {
    fotoPainel(`<p class="erro">${esc(err.message)}</p>`);
  }
}

function abrirLink(productId) {
  fotoPainel(`
    <div class="painel">
      <p class="row">
        <input type="url" id="link-url" placeholder="https://..." style="flex:1">
        <button id="link-add" class="primary">Importar</button>
        <button id="link-cancel">Fechar</button>
      </p>
      <small class="muted">O link precisa ser público (uma imagem que abre direto no navegador).</small>
    </div>`);
  $('#link-cancel').onclick = () => fotoPainel('');
  $('#link-add').onclick = async (ev) => {
    const url = $('#link-url').value.trim();
    if (!url) return;
    ev.target.disabled = true;
    try {
      await api(`/products/${productId}/images/from-url`, { method: 'POST', body: JSON.stringify({ url }) });
      await loadProducts();
      openDetail(productId);
    } catch (err) {
      alert(err.message);
      ev.target.disabled = false;
    }
  };
}

/**
 * "Melhorar foto": escolhe o modo, gera e mostra antes/depois. A original fica
 * no anuncio -- desfazer apaga a versao nova, nao a sua foto.
 */
function abrirMelhoria(productId, imageId) {
  const img = state.products.find((p) => p.id === productId)?.images.find((i) => i.id === imageId);
  const modos = state.ai?.image?.modes ?? [];
  fotoPainel(`
    <div class="painel">
      <p><strong>Melhorar esta foto com IA</strong> — cada clique gera uma imagem nova e é cobrado na sua conta
      do Gemini. A sua foto original continua no anúncio.</p>
      <div class="painel-par">
        ${img ? `<figure class="shot"><img src="${esc(img.url)}" alt=""><figcaption class="muted">sua foto</figcaption></figure>` : ''}
        <div class="row">
          ${modos.map((m) => `<button data-mode="${esc(m.id)}">${esc(m.label)}</button>`).join('')}
          <button id="ia-fechar">Fechar</button>
        </div>
      </div>
      <p id="ia-status" class="muted"></p>
      <small class="muted">A IA recebe ordem de não esconder arranhão, amassado ou desgaste: foto que esconde
      defeito gera reclamação e, no Mercado Livre, atinge sua reputação.</small>
    </div>`);

  $('#ia-fechar').onclick = () => fotoPainel('');
  $$('[data-mode]', $('#foto-painel')).forEach((btn) => {
    btn.onclick = async () => {
      $$('[data-mode]', $('#foto-painel')).forEach((b) => (b.disabled = true));
      $('#ia-status').textContent = 'gerando (pode levar meio minuto)...';
      try {
        const out = await api(`/images/${imageId}/enhance`, {
          method: 'POST',
          body: JSON.stringify({ mode: btn.dataset.mode }),
        });
        const nova = out.product.images.find((i) => i.id === out.imageId);
        await loadProducts();
        await openDetail(productId);
        fotoPainel(`
          <div class="painel">
            <p><strong>Versão gerada.</strong> Compare antes de decidir.</p>
            <div class="painel-par">
              ${img ? `<figure class="shot"><img src="${esc(img.url)}" alt=""><figcaption class="muted">sua foto</figcaption></figure>` : ''}
              <figure class="shot"><img src="${esc(nova.url)}" alt=""><figcaption class="muted">versão da IA</figcaption></figure>
            </div>
            <p class="row">
              <button id="ia-manter" class="primary">Manter</button>
              <button id="ia-desfazer">Desfazer (apagar a versão da IA)</button>
            </p>
          </div>`);
        $('#ia-manter').onclick = () => fotoPainel('');
        $('#ia-desfazer').onclick = async () => {
          await api(`/images/${out.imageId}`, { method: 'DELETE' });
          await loadProducts();
          openDetail(productId);
        };
      } catch (err) {
        $('#ia-status').textContent = '';
        alert(err.message);
        $$('[data-mode]', $('#foto-painel')).forEach((b) => (b.disabled = false));
      }
    };
  });
}

$('#det-corpo').addEventListener('click', async (ev) => {
  const productId = $('#det-corpo').dataset.productId;
  const t = ev.target;

  if (t.id === 'upload') {
    const files = $('#files').files;
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('images', f);
    t.disabled = true;
    try {
      await api(`/products/${productId}/images`, { method: 'POST', body: fd });
      await loadProducts();
      openDetail(productId);
    } catch (err) { alert(err.message); } finally { t.disabled = false; }
  }

  if (t.dataset.img) {
    await api(`/images/${t.dataset.img}`, { method: 'DELETE' });
    await loadProducts();
    openDetail(productId);
  }

  if (t.id === 'catalogo') abrirCatalogo(productId);
  if (t.id === 'qr') abrirQr(productId);
  if (t.id === 'link') abrirLink(productId);
  if (t.dataset.enhance) abrirMelhoria(productId, t.dataset.enhance);

  if (t.dataset.kit) showKit(productId, t.dataset.kit);

  if (t.dataset.pause || t.dataset.closeAd) {
    const channel = t.dataset.pause ?? t.dataset.closeAd;
    const action = t.dataset.pause ? 'pause' : 'close';
    try {
      await api(`/products/${productId}/listings/${channel}/${action}`, { method: 'POST' });
      await loadProducts();
      openDetail(productId);
    } catch (err) { alert(err.message); }
  }

  if (t.id === 'publicar') {
    const channels = $$('.ch').filter((c) => c.checked).map((c) => c.value);
    if (!channels.length) return alert('Marque pelo menos um canal.');
    t.disabled = true;
    $('#resultado').innerHTML = '<p class="muted">Publicando...</p>';
    try {
      const { results } = await api(`/products/${productId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ channels, dryRun: $('#dry').checked, force: $('#force').checked }),
      });
      $('#resultado').innerHTML = results.map((r) => `
        <div class="card">
          <div class="row"><strong>${esc(channelLabel(r.channel))}</strong>
            <span class="pill ${r.status}">${esc(r.status)}</span>
            ${r.dryRun ? '<span class="pill">simulação</span>' : ''}
            ${r.permalink ? `<a href="${esc(r.permalink)}" target="_blank" rel="noopener">abrir anúncio</a>` : ''}
          </div>
          ${r.message ? `<div class="muted">${esc(r.message)}</div>` : ''}
          ${r.manualKit ? `<button data-kit="${r.channel}">Abrir kit de publicação</button>` : ''}
          ${r.payload ? `<details><summary>Payload enviado</summary><pre>${esc(JSON.stringify(r.payload, null, 2))}</pre></details>` : ''}
        </div>`).join('');
      await loadProducts();
    } catch (err) {
      $('#resultado').innerHTML = `<p class="erro">${esc(err.message)}</p>`;
    } finally { t.disabled = false; }
  }
});

async function showKit(productId, channel) {
  const { kit } = await api(`/products/${productId}/kit/${channel}`);
  if (!kit) return alert('Este canal não gera kit manual.');
  $('#kit-titulo').textContent = `Kit: ${channelLabel(channel)}`;
  $('#kit-corpo').innerHTML = `
    <ol>${kit.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <textarea id="kit-text" rows="16">${esc(kit.text)}</textarea>
    <div class="row">
      <button id="copiar" class="primary">Copiar texto</button>
      ${kit.imageUrls.length ? '<button id="baixar">Baixar fotos</button>' : ''}
      <span id="copiado" class="muted"></span>
    </div>
    <div class="gallery">${kit.imageUrls.map((u) => `<figure><img src="${esc(u)}" alt=""></figure>`).join('')}</div>`;
  $('#dlg-kit').showModal();

  $('#copiar').onclick = async () => {
    await navigator.clipboard.writeText($('#kit-text').value);
    $('#copiado').textContent = 'copiado!';
    setTimeout(() => ($('#copiado').textContent = ''), 2000);
  };
  const baixar = $('#baixar');
  if (baixar) baixar.onclick = () => kit.imageUrls.forEach((u) => window.open(u, '_blank', 'noopener'));
}

// ---------- canais ----------

async function loadChannels() {
  const { channels } = await api('/channels');
  state.channels = channels;
  $('#canais').innerHTML = channels.map((c) => `
    <article class="card">
      <h3>${esc(c.label)}</h3>
      <div class="row">
        <span class="pill">${esc(c.mode)}</span>
        <span class="pill ${c.configured ? 'publicado' : 'erro'}">${c.configured ? 'configurado' : 'falta configurar'}</span>
        ${c.connected ? `<span class="pill publicado">conectado${c.accountLabel ? `: ${esc(c.accountLabel)}` : ''}</span>` : ''}
      </div>
      <div class="muted">Aceita: ${c.kinds.join(', ')}</div>
      ${c.requiredEnv.length ? `<div class="muted">.env: ${c.requiredEnv.map(esc).join(', ')}</div>` : ''}
      <div class="row">
        ${c.needsOauth
          ? (c.connected
            ? `<button data-disconnect="${c.id}">Desconectar</button>`
            : `<a class="pill" href="/oauth/mercadolivre/start">Conectar</a>`)
          : ''}
        <a href="${esc(c.docsUrl)}" target="_blank" rel="noopener">documentação</a>
      </div>
    </article>`).join('');
}

$('#canais').addEventListener('click', async (ev) => {
  const id = ev.target.dataset?.disconnect;
  if (!id) return;
  await api(`/channels/${id}/account`, { method: 'DELETE' });
  loadChannels();
});

// ---------- eventos ----------

async function loadEvents() {
  const { events } = await api('/events?limit=200');
  $('#eventos').innerHTML = events.map((e) => `<tr>
    <td>${new Date(e.created_at).toLocaleString('pt-BR')}</td>
    <td class="${esc(e.level)}">${esc(e.level)}</td>
    <td>${esc(e.channel ?? '-')}</td>
    <td>${esc(e.message)}</td></tr>`).join('');
}

// ---------- boot ----------

async function boot() {
  state.config = await api('/config');
  const avisos = [];
  if (state.config.dryRun) avisos.push('DRY_RUN ligado: as publicações são simuladas (nada é enviado às plataformas).');
  if (state.config.publicUrlIsLocal) {
    avisos.push('PUBLIC_URL aponta para localhost: as plataformas não conseguem baixar as fotos. Use um túnel (ngrok/cloudflared) e ajuste o .env.');
  }
  if (!state.config.authEnabled) {
    avisos.push('Painel SEM senha: qualquer um que abrir este endereço cria e publica anúncios na sua conta. Defina ADMIN_USER e ADMIN_PASS.');
  }
  if (avisos.length) {
    $('#banner').hidden = false;
    $('#banner').textContent = avisos.join(' ');
  }
  const ai = await api('/ai/status');
  state.ai = ai;
  $('#ai-model').textContent = ai.configured ? ai.model : '';
  if (!ai.configured) {
    $('#ai-box').dataset.off = '1';
    $('#ai-gerar').disabled = true;
    $('#ai-aviso').textContent = 'defina GEMINI_API_KEY no .env para habilitar';
  }

  document.title = `Anúncios Multiplataforma v${state.config.version}`;

  await loadChannels();
  await loadProducts();
}

boot().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="banner">Falha ao iniciar: ${esc(err.message)}</p>`);
});
