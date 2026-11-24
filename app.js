/* ============================================================
   DEV STORE — vanilla JS, zero dependencies
   Reads games.txt + apps.txt · hash routing · glass UI
   ============================================================ */
'use strict';

/* ---------- helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = v => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'x';
const pretty = t => String(t).split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const typeLabel = t => t === 'app' ? 'App' : 'Game';
const svg = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
const stripComments = s => s.replace(/\/\/\/.*?\/\/\//g, '').replace(/\/\/\/.*$/, '').trim();
const fmtBytes = n => {
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  const v = (n >= 100 || i === 0) ? Math.round(n) : Math.round(n * 10) / 10;
  return `${v} ${u[i]}`;
};

const FILES = [
  { url: 'games.txt', type: 'game' },
  { url: 'apps.txt',  type: 'app'  }
];

const SHOT_FALLBACK = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="#101013"/><g fill="none" stroke="#3f3f46" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(330,610) scale(2.5)"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></g></svg>`
);

/* ---------- state & dom ---------- */
const state = {
  items: [], rows: [], loading: false, error: null, busy: false,
  currentKey: null, prevKey: null, scrollMem: new Map(), lastSearchFirst: null
};
const view        = $('#view');
const input       = $('#searchInput');
const searchClear = $('#searchClear');
const refreshBtn  = $('#refreshBtn');

/* ============================================================
   PARSER — games.txt / apps.txt
   --- separator · Key= Value · Description= ~~~// ... //~~~
   ///comments/// are ignored · both spellings accepted
   ============================================================ */
function parseStore(text, type) {
  const out = [];
  let cur = null, desc = null;
  const flush = () => { if (cur && cur.name) out.push(cur); cur = null; desc = null; };

  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (desc) {                                   // inside multi-line description
      const end = raw.indexOf('//~~~');
      if (end > -1) {
        const tail = raw.slice(0, end);
        if (tail) desc.push(tail);
        cur.description = desc.join('\n').trim();
        desc = null;
      } else desc.push(raw);
      continue;
    }
    const line = stripComments(raw);
    if (!line) continue;
    if (/^-{3,}$/.test(line)) { flush(); continue; }

    const m = line.match(/^([A-Za-z][A-Za-z-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();

    if (key === 'name' && cur && cur.name) flush();   // missing separator safety
    if (!cur) cur = {};

    if (key === 'description') {
      if (val.startsWith('~~~//')) {
        const body = val.slice(5);
        const end = body.indexOf('//~~~');
        if (end > -1) cur.description = body.slice(0, end).trim();
        else desc = body ? [body] : [];
      } else cur.description = val;
      continue;
    }
    switch (key) {
      case 'name':       cur.name = val; break;
      case 'devloper': case 'developer': cur.developer = val; break;
      case 'download':   cur.download = val; break;
      case 'icon-img': case 'icon': cur.icon = val; break;
      case 'screenshots': cur.screenshots = val.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'catagory': case 'category': cur.categories = val.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'size':       cur.size = val; break;       // optional override
    }
  }
  flush();

  return out.map((it, i) => ({
    id: `${type}-${slug(it.name)}-${i}`,
    type,
    name: it.name,
    developer: it.developer || '',
    download: it.download || '',
    icon: it.icon || '',
    screenshots: it.screenshots || [],
    categories: (it.categories && it.categories.length) ? it.categories : [typeLabel(type)],
    description: it.description || '',
    size: it.size || '',
    _sizeTried: false
  }));
}

/* ============================================================
   CATEGORY ROWS
   ============================================================ */
const ROW_DEFS = [
  { label: 'Games',        slug: 'games',        test: i => i.type === 'game' },
  { label: 'Apps',         slug: 'apps',         test: i => i.type === 'app' },
  { label: 'Shooter Games',slug: 'shooter-games',tags: ['shooter','shooter-games'], gamesOnly: true },
  { label: 'Casual Games', slug: 'casual-games', tags: ['casual','casual-games'],   gamesOnly: true },
  { label: 'Idle Games',   slug: 'idle-games',   tags: ['idle','idel','idle-games','idel-games'], gamesOnly: true },
  { label: 'Games Series', slug: 'games-series', tags: ['series','game-series','games-series'],   gamesOnly: true }
];
const TYPE_TAGS = ['game','app','games','apps'];

function buildRows() {
  const items = state.items;
  const rows = ROW_DEFS.map(d => ({
    ...d,
    items: items.filter(i => d.test
      ? d.test(i)
      : i.categories.some(c => d.tags.includes(c.toLowerCase())) && (!d.gamesOnly || i.type === 'game'))
  })).filter(r => r.items.length);

  // auto-create rows for any new tag used on 2+ items
  const covered = new Set([...TYPE_TAGS, ...ROW_DEFS.flatMap(d => d.tags || [])]);
  const extra = new Map();
  for (const i of items) for (const c of i.categories) {
    const t = c.toLowerCase();
    if (covered.has(t)) continue;
    if (!extra.has(t)) extra.set(t, []);
    extra.get(t).push(i);
  }
  [...extra.entries()].filter(([, l]) => l.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([t, l]) => rows.push({ label: pretty(t), slug: slug(t), tag: t, items: l }));

  state.rows = rows;
}
function findRow(s) {
  if (!s) return null;
  const hit = state.rows.find(r => r.slug === s);
  if (hit) return hit;
  if (s === 'games') return { label: 'Games', slug: s, items: state.items.filter(i => i.type === 'game') };
  if (s === 'apps')  return { label: 'Apps',  slug: s, items: state.items.filter(i => i.type === 'app') };
  const list = state.items.filter(i => i.categories.some(c => slug(c) === s));
  return list.length ? { label: pretty(s.replace(/-/g, ' ')), slug: s, items: list } : null;
}
function rowSlugForTag(t) {
  const low = t.toLowerCase();
  const r = state.rows.find(r => r.tag === low || (r.tags && r.tags.includes(low)));
  return r ? r.slug : slug(t);
}
const primaryTag = i => {
  const t = i.categories.find(c => !TYPE_TAGS.includes(c.toLowerCase()));
  return t ? pretty(t) : '';
};

/* ============================================================
   TEMPLATES
   ============================================================ */
const iconHTML = (i, cls) => i.icon
  ? `<span class="${cls}"><img src="${esc(i.icon)}" alt="" loading="lazy" draggable="false" data-fb="${esc(i.name)}"></span>`
  : `<span class="${cls}"><span class="icon-fallback">${esc((i.name || '?').trim().charAt(0).toUpperCase() || '?')}</span></span>`;

const backHTML = () =>
  `<button class="icon-btn glass-circle back-btn" type="button" data-back aria-label="Go back">${svg('arrow-left')}</button>`;

function tileHTML(i) {
  return `<a class="tile" href="#/item/${i.id}">
    ${iconHTML(i, 'tile-icon')}
    <span class="tile-name">${esc(i.name)}</span>
    <span class="tile-sub">${esc(primaryTag(i) || i.developer || typeLabel(i.type))}</span>
  </a>`;
}
function highlight(name, q) {
  const idx = name.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return esc(name);
  return esc(name.slice(0, idx)) + '<mark>' + esc(name.slice(idx, idx + q.length)) + '</mark>' + esc(name.slice(idx + q.length));
}
function listCardHTML(i, q) {
  return `<div class="row-card">
    <a class="row-main" href="#/item/${i.id}">
      ${iconHTML(i, 'row-icon')}
      <span class="row-text">
        <span class="row-name">${q ? highlight(i.name, q) : esc(i.name)}</span>
        <span class="row-sub">${esc([i.developer, primaryTag(i)].filter(Boolean).join(' · '))}</span>
      </span>
    </a>
    <button class="get-btn" type="button" data-get="${i.id}"><span class="btn-label">Get</span></button>
  </div>`;
}
function rowHTML(r) {
  return `<section class="section">
    <div class="sec-head">
      <h2 class="sec-title">${esc(r.label)}</h2>
      <span class="count-pill">${r.items.length}</span>
      <a class="see-all glass-circle" href="#/category/${r.slug}" aria-label="See all ${esc(r.label)}">${svg('chev-right')}</a>
    </div>
    <div class="row-wrap">
      <button class="row-nav prev glass-circle" type="button" aria-label="Scroll left">${svg('chev-right','flip')}</button>
      <div class="scroller">${r.items.map(tileHTML).join('')}</div>
      <button class="row-nav next glass-circle" type="button" aria-label="Scroll right">${svg('chev-right')}</button>
    </div>
  </section>`;
}
function stateBlockHTML(icon, title, text, action = 'retry') {
  const btn = action === 'home'
    ? `<a class="btn-ghost" href="#/">${svg('arrow-left')}Back to home</a>`
    : `<button class="btn-ghost" type="button" data-retry>${svg('refresh')}${action === 'refresh' ? 'Refresh' : 'Try again'}</button>`;
  return `<div class="state-block">
    <span class="state-icon glass-circle">${svg(icon)}</span>
    <h2 class="state-title">${esc(title)}</h2>
    <p class="state-text">${esc(text)}</p>
    ${btn}
  </div>`;
}

/* ============================================================
   VIEWS
   ============================================================ */
function renderSkeleton() {
  const sk = `<section class="section"><div class="sk-head shimmer"></div><div class="scroller sk-row">${
    '<div class="sk-tile"><div class="sk-icon shimmer"></div><div class="sk-line shimmer"></div><div class="sk-line short shimmer"></div></div>'.repeat(7)
  }</div></section>`;
  view.innerHTML = sk.repeat(3);
}
function renderHome() {
  if (!state.items.length) {
    view.innerHTML = stateBlockHTML('box', 'The store is empty',
      'Add entries to games.txt or apps.txt, then refresh the store.', 'refresh');
    return;
  }
  view.innerHTML = state.rows.map(rowHTML).join('');
  initRows();
}
function renderList(row) {
  view.innerHTML = `
    <div class="view-head">${backHTML()}
      <h1 class="view-title">${esc(row.label)}</h1>
      <span class="count-pill">${row.items.length}</span>
    </div>
    ${row.items.length
      ? `<div class="grid">${row.items.map(i => listCardHTML(i)).join('')}</div>`
      : stateBlockHTML('box', 'Nothing here yet', 'Items tagged with this category will appear here.', 'home')}`;
}
function renderSearch(q) {
  const query = q.trim();
  if (!query) { renderHome(); return; }
  const ql = query.toLowerCase();
  const hits = state.items.filter(i =>
    i.name.toLowerCase().includes(ql) ||
    i.developer.toLowerCase().includes(ql) ||
    i.categories.some(c => c.toLowerCase().includes(ql)));
  state.lastSearchFirst = hits[0] ? hits[0].id : null;
  view.innerHTML = `
    <div class="view-head">
      <h1 class="view-title">Results for “${esc(query)}”</h1>
      <span class="count-pill">${hits.length}</span>
    </div>
    ${hits.length
      ? `<div class="grid">${hits.map(i => listCardHTML(i, query)).join('')}</div>`
      : stateBlockHTML('search', 'No results found', 'Try a different name, developer or category.', 'home')}`;
}
function renderDetail(i) {
  if (!i) {
    view.innerHTML = stateBlockHTML('alert', 'Not found', 'This item does not exist. It may have been removed from the store.', 'home');
    return;
  }
  const tags = i.categories.filter(c => !TYPE_TAGS.includes(c.toLowerCase()));
  const chips = [
    `<span class="chip static">${svg(i.type === 'game' ? 'gamepad' : 'logo')}${typeLabel(i.type)}</span>`,
    ...tags.map(t => `<a class="chip" href="#/category/${rowSlugForTag(t)}">${esc(pretty(t))}</a>`)
  ].join('');

  view.innerHTML = `
    <div class="view-head">${backHTML()}
      <span class="crumb">${esc(typeLabel(i.type))}${tags[0] ? ' · ' + esc(pretty(tags[0])) : ''}</span>
      <button class="icon-btn glass-circle share-btn" type="button" data-share aria-label="Share">${svg('share')}</button>
    </div>

    <section class="hero glass">
      <div class="hero-top">
        ${iconHTML(i, 'hero-icon')}
        <div class="hero-info">
          <h1 class="hero-name">${esc(i.name)}</h1>
          ${i.developer ? `<p class="hero-dev">${esc(i.developer)}</p>` : ''}
          <div class="chips">${chips}</div>
        </div>
      </div>
      <div class="hero-meta">
        <div class="stat"><span class="stat-label">Size</span><span class="stat-value" data-size-for="${i.id}">${esc(i.size || '—')}</span></div>
        <div class="stat"><span class="stat-label">Type</span><span class="stat-value">${typeLabel(i.type)}</span></div>
        <div class="stat"><span class="stat-label">Screens</span><span class="stat-value">${i.screenshots.length}</span></div>
      </div>
      <div class="hero-actions">
        <button class="btn-primary" type="button" data-get="${i.id}" ${i.download ? '' : 'disabled'}>
          ${svg('download')}<span class="btn-label">${i.download ? 'Download' : 'No file'}</span>
          <span class="btn-bar" aria-hidden="true"></span>
        </button>
      </div>
    </section>

    ${i.screenshots.length ? `
    <section class="section">
      <div class="sec-head"><h2 class="sec-title">Screenshots</h2><span class="count-pill">${i.screenshots.length}</span></div>
      <div class="row-wrap">
        <button class="row-nav prev glass-circle" type="button" aria-label="Scroll left">${svg('chev-right','flip')}</button>
        <div class="scroller shots-scroller">
          ${i.screenshots.map((s, idx) => `
            <button class="shot" type="button" data-shot="${idx}" data-item="${i.id}" aria-label="Open screenshot ${idx + 1}">
              <img class="shot-img" src="${esc(s)}" alt="${esc(i.name)} screenshot ${idx + 1}" loading="lazy" draggable="false" data-shot-img>
            </button>`).join('')}
        </div>
        <button class="row-nav next glass-circle" type="button" aria-label="Scroll right">${svg('chev-right')}</button>
      </div>
    </section>` : ''}

    <section class="about glass">
      <h2 class="sec-title">About this ${typeLabel(i.type).toLowerCase()}</h2>
      ${i.description ? `
        <div class="desc clamped" data-desc>
          <div class="desc-text" data-desc-text>${esc(i.description)}</div>
        </div>
        <button class="read-more" type="button" data-desc-btn aria-expanded="false">
          <span class="rm-label">Read more</span>${svg('chev-right','rm-chev')}
        </button>`
      : `<p class="muted">No description provided.</p>`}
      <div class="info-grid">
        <div class="info"><span class="info-label">Developer</span><span class="info-value">${esc(i.developer || '—')}</span></div>
        <div class="info"><span class="info-label">Category</span><span class="info-value">${esc(tags.map(pretty).join(', ') || typeLabel(i.type))}</span></div>
        <div class="info"><span class="info-label">Size</span><span class="info-value" data-size-for="${i.id}">${esc(i.size || '—')}</span></div>
        <div class="info"><span class="info-label">Type</span><span class="info-value">${typeLabel(i.type)}</span></div>
      </div>
    </section>`;

  initRows();
  requestAnimationFrame(() => {           // hide "Read more" if description already fits
    const d = $('[data-desc]');
    if (d) {
      const t = $('[data-desc-text]', d);
      if (t.scrollHeight <= t.clientHeight + 6) {
        d.classList.remove('clamped');
        const b = $('[data-desc-btn]');
        if (b) b.hidden = true;
      }
    }
  });
  resolveSize(i);
}

/* ============================================================
   SIZE — optional Size= field, otherwise read Content-Length
   ============================================================ */
async function resolveSize(i) {
  if (i.size || i._sizeTried || !i.download) return;
  i._sizeTried = true;
  try {
    const r = await fetch(i.download, { method: 'HEAD' });
    const f = fmtBytes(Number(r.headers.get('Content-Length')));
    if (f) {
      i.size = f;
      $$(`[data-size-for="${i.id}"]`).forEach(el => el.textContent = f);
    }
  } catch (_) { /* size stays "—" — no fake data */ }
}

/* ============================================================
   DOWNLOAD — fetch → blob → save. Never leaves DEV STORE.
   ============================================================ */
function fileNameFor(i) {
  try {
    const u = new URL(i.download, location.href);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last;
  } catch (_) {}
  return slug(i.name);
}
async function startDownload(i, btn) {
  if (state.busy)   return toast('A download is already running', 'alert');
  if (!i.download)  return toast('No download link for this item', 'alert');
  state.busy = true;

  const compact  = btn.classList.contains('get-btn');
  const label    = $('.btn-label', btn) || btn;
  const use      = $('use', btn);
  const bar      = $('.btn-bar', btn);
  const orig     = label.textContent;
  const origIcon = use ? use.getAttribute('href') : null;
  const setLabel = t => { label.textContent = t; };
  const progress = p => {
    if (bar) bar.style.width = (p ?? 0) + '%';
    setLabel(p == null ? (compact ? '…' : 'Preparing…') : p + '%');
  };
  btn.dataset.state = 'loading';

  try {
    const res = await fetch(i.download, { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || 0;
    let blob;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        progress(total ? Math.min(99, Math.round(got / total * 100)) : null);
      }
      blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
      if (!i.size && total) {
        const f = fmtBytes(total);
        if (f) { i.size = f; $$(`[data-size-for="${i.id}"]`).forEach(el => el.textContent = f); }
      }
    } else { progress(null); blob = await res.blob(); }

    progress(100);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: fileNameFor(i) });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    btn.dataset.state = 'success';
    if (use) use.setAttribute('href', '#i-check');
    setLabel(compact ? 'Done' : 'Saved');
    toast(`Downloading “${i.name}”`, 'download');
  } catch (_) {
    // fallback for hosts without CORS: direct download attribute
    try {
      const a = Object.assign(document.createElement('a'), { href: i.download, download: fileNameFor(i), rel: 'noopener' });
      document.body.appendChild(a); a.click(); a.remove();
      btn.dataset.state = 'success';
      if (use) use.setAttribute('href', '#i-check');
      setLabel(compact ? 'Done' : 'Started');
      toast('Download started', 'download');
    } catch (__) {
      btn.dataset.state = 'error';
      if (use) use.setAttribute('href', '#i-alert');
      setLabel(compact ? 'Error' : 'Failed');
      toast('Download failed — check the file link', 'alert');
    }
  } finally {
    state.busy = false;
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.state;
        setLabel(orig);
        if (use && origIcon) use.setAttribute('href', origIcon);
        if (bar) bar.style.width = '0%';
      }
    }, 2200);
  }
}

/* ============================================================
   SHARE / TOAST / LIGHTBOX
   ============================================================ */
const currentItem = () => {
  const p = routeKey().split('/').filter(Boolean);
  return p[0] === 'item' ? state.items.find(x => x.id === p[1]) : null;
};
async function shareCurrent() {
  const item = currentItem();
  const title = item ? `${item.name} — DEV STORE` : 'DEV STORE';
  if (navigator.share) { try { await navigator.share({ title, url: location.href }); } catch (_) {} }
  else {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied', 'check'); }
    catch (_) { toast('Could not copy the link', 'alert'); }
  }
}

let toastTimer;
function toast(msg, icon = 'check') {
  const el = $('#toast');
  el.innerHTML = `${svg(icon)}<span>${esc(msg)}</span>`;
  el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

const lb = { shots: [], idx: 0, opener: null };
function openLB(item, idx, opener) {
  lb.shots = item.screenshots; lb.idx = idx; lb.opener = opener || null;
  const box = $('#lightbox');
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('open'));
  document.body.classList.add('locked');
  updateLB();
  $('#lbClose').focus();
}
function updateLB() {
  const img = $('#lbImg');
  delete img.dataset.fbDone;
  img.src = lb.shots[lb.idx];
  $('#lbCount').textContent = `${lb.idx + 1} / ${lb.shots.length}`;
  const multi = lb.shots.length > 1;
  $('#lbPrev').hidden = !multi;
  $('#lbNext').hidden = !multi;
}
function navLB(d) {
  if (!lb.shots.length) return;
  lb.idx = (lb.idx + d + lb.shots.length) % lb.shots.length;
  updateLB();
}
function closeLB() {
  const box = $('#lightbox');
  if (box.hidden) return;
  box.classList.remove('open');
  document.body.classList.remove('locked');
  setTimeout(() => { box.hidden = true; }, 220);
  if (lb.opener && lb.opener.isConnected) lb.opener.focus();
}

/* ============================================================
   ROWS — arrows, edge fades, mouse drag-to-swipe
   ============================================================ */
const rowUpdaters = [];
function initRows() {
  rowUpdaters.length = 0;
  $$('.row-wrap').forEach(wrap => {
    const sc = $('.scroller', wrap), prev = $('.prev', wrap), next = $('.next', wrap);
    const update = () => {
      const max = sc.scrollWidth - sc.clientWidth - 2;
      wrap.classList.toggle('can-left',  sc.scrollLeft > 2);
      wrap.classList.toggle('can-right', sc.scrollLeft < max);
    };
    update(); rowUpdaters.push(update);
    sc.addEventListener('scroll', update, { passive: true });
    if (prev) prev.addEventListener('click', () => sc.scrollBy({ left: -sc.clientWidth * .85, behavior: 'smooth' }));
    if (next) next.addEventListener('click', () => sc.scrollBy({ left:  sc.clientWidth * .85, behavior: 'smooth' }));

    let drag = null;
    sc.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, left: sc.scrollLeft, moved: false };
      try { sc.setPointerCapture(e.pointerId); } catch (_) {}
    });
    sc.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 5) drag.moved = true;
      if (drag.moved) { sc.classList.add('dragging'); sc.scrollLeft = drag.left - dx; }
    });
    const end = () => {
      if (!drag) return;
      const moved = drag.moved; drag = null;
      sc.classList.remove('dragging');
      if (moved) { sc._suppress = true; setTimeout(() => { sc._suppress = false; }, 50); }
    };
    sc.addEventListener('pointerup', end);
    sc.addEventListener('pointercancel', end);
    sc.addEventListener('click', e => {
      if (sc._suppress) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    sc.addEventListener('dragstart', e => e.preventDefault());
  });
}
const updateAllRows = () => rowUpdaters.forEach(f => f());

/* ============================================================
   ROUTER — #/ · #/category/x · #/item/x · #/search/q
   ============================================================ */
const routeKey = () => location.hash.slice(1) || '/';
function goBack() {
  if (state.prevKey && state.prevKey !== state.currentKey) history.back();
  else location.hash = '#/';
}
function renderRoute() {
  closeLB();
  const key = routeKey();
  const parts = key.split('/').filter(Boolean);
  let q = '';
  if (parts[0] === 'search') { try { q = decodeURIComponent(parts.slice(1).join('/') || ''); } catch (_) { q = ''; } }
  if (document.activeElement !== input) input.value = q;
  updateSearchUI();
  state.prevKey = state.currentKey;
  state.currentKey = key;
  if (parts[0] !== 'search') state.lastSearchFirst = null;

  if (state.loading)      renderSkeleton();
  else if (state.error)   view.innerHTML = stateBlockHTML('alert', 'Couldn’t load the store', state.error, 'retry');
  else if (!parts.length || (parts[0] === 'search' && !q.trim())) renderHome();
  else if (parts[0] === 'category') {
    const r = findRow(parts[1]);
    if (r) renderList(r);
    else view.innerHTML = stateBlockHTML('alert', 'Category not found', 'This category has no items yet.', 'home');
  }
  else if (parts[0] === 'item')   renderDetail(state.items.find(i => i.id === parts[1]));
  else if (parts[0] === 'search') renderSearch(q);
  else view.innerHTML = stateBlockHTML('alert', 'Page not found', 'The link you followed does not exist.', 'home');

  const y = state.scrollMem.get(key) || 0;
  requestAnimationFrame(() => window.scrollTo(0, y));
}

/* ============================================================
   DATA LOADING — cache-busted so manual txt edits show up
   ============================================================ */
async function loadData(manual = false) {
  if (state.loading) return;
  state.loading = true; state.error = null;
  refreshBtn.classList.add('spinning');
  renderRoute();

  const bust = '?t=' + Date.now();
  const results = await Promise.allSettled(FILES.map(async f => {
    const r = await fetch(f.url + bust, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${f.url} — HTTP ${r.status}`);
    return parseStore(await r.text(), f.type);
  }));
  const ok  = results.filter(r => r.status === 'fulfilled');
  const bad = results.map((r, i) => r.status === 'rejected' ? FILES[i].url : null).filter(Boolean);

  if (ok.length) {
    state.items = ok.flatMap(r => r.value);
    buildRows();
    const n = state.items.length;
    $('#footCount').textContent = `${n} ${n === 1 ? 'title' : 'titles'}`;
  } else {
    state.error = location.protocol === 'file:'
      ? 'Browsers block reading local txt files. Host this folder on GitHub Pages (or run any local web server) and try again.'
      : 'Could not load games.txt / apps.txt. Make sure both files are in the same folder as index.html.';
    $('#footCount').textContent = 'Data unavailable';
  }
  state.loading = false;
  refreshBtn.classList.remove('spinning');
  renderRoute();
  if (manual && ok.length) toast('Store data refreshed', 'refresh');
  if (ok.length && bad.length) toast(`Couldn’t load ${bad.join(', ')}`, 'alert');
}

/* ============================================================
   EVENTS
   ============================================================ */
function updateSearchUI() {
  const has = !!input.value;
  $('.search').classList.toggle('has-value', has);
  searchClear.hidden = !has;
}
let searchTimer;
function applySearch() {
  updateSearchUI();
  const q = input.value.trim();
  const cur = routeKey();
  if (q) {
    const target = '/search/' + encodeURIComponent(q);
    if (cur !== target) history.replaceState(null, '', '#' + target);
  } else if (cur.startsWith('/search')) history.replaceState(null, '', '#/');
  renderRoute();
}
input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 120); });
searchClear.addEventListener('click', () => { input.value = ''; applySearch(); input.focus(); });
refreshBtn.addEventListener('click', () => loadData(true));

function toggleDesc() {
  const d = $('[data-desc]'), b = $('[data-desc-btn]');
  if (!d || !b) return;
  const expanded = !d.classList.toggle('clamped');
  b.setAttribute('aria-expanded', String(expanded));
  $('.rm-label', b).textContent = expanded ? 'Show less' : 'Read more';
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-back],[data-get],[data-share],[data-shot],[data-desc-btn],[data-desc-text],[data-retry],[data-lb-close],[data-lb-prev],[data-lb-next]');
  if (!el) return;
  if      (el.hasAttribute('data-back'))     { e.preventDefault(); goBack(); }
  else if (el.hasAttribute('data-get'))      { const i = state.items.find(x => x.id === el.getAttribute('data-get')); if (i) startDownload(i, el); }
  else if (el.hasAttribute('data-share'))    shareCurrent();
  else if (el.hasAttribute('data-shot'))     { const i = state.items.find(x => x.id === el.getAttribute('data-item')); if (i) openLB(i, Number(el.getAttribute('data-shot')) || 0, el); }
  else if (el.hasAttribute('data-desc-btn')) toggleDesc();
  else if (el.hasAttribute('data-desc-text')){ const d = el.closest('[data-desc]'); if (d && d.classList.contains('clamped')) toggleDesc(); }
  else if (el.hasAttribute('data-retry'))    loadData(true);
  else if (el.hasAttribute('data-lb-close')) closeLB();
  else if (el.hasAttribute('data-lb-prev'))  navLB(-1);
  else if (el.hasAttribute('data-lb-next'))  navLB(1);
});

document.addEventListener('keydown', e => {
  if (!$('#lightbox').hidden) {
    if (e.key === 'Escape') closeLB();
    else if (e.key === 'ArrowLeft') navLB(-1);
    else if (e.key === 'ArrowRight') navLB(1);
    return;
  }
  const active = document.activeElement || document.body;
  if (e.key === '/' && active !== input && !/^(INPUT|TEXTAREA)$/.test(active.tagName)) {
    e.preventDefault(); input.focus(); input.select();
  } else if (e.key === 'Escape' && active === input) {
    input.value = ''; applySearch(); input.blur();
  } else if (e.key === 'Enter' && active === input && state.lastSearchFirst) {
    location.hash = '#/item/' + state.lastSearchFirst;
  }
});

/* broken image fallbacks (letter tile / gray placeholder) */
document.addEventListener('error', e => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement)) return;
  if (t.dataset.fb !== undefined) {
    const s = document.createElement('span');
    s.className = 'icon-fallback';
    s.textContent = (t.dataset.fb || '?').trim().charAt(0).toUpperCase() || '?';
    t.replaceWith(s);
  } else if ((t.dataset.shotImg !== undefined || t.id === 'lbImg') && !t.dataset.fbDone) {
    t.dataset.fbDone = '1';
    t.src = SHOT_FALLBACK;
  }
}, true);
document.addEventListener('load', e => { if (e.target.tagName === 'IMG') updateAllRows(); }, true);

/* scroll memory per route */
let scrollTick = false;
addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    if (state.currentKey) state.scrollMem.set(state.currentKey, scrollY);
  });
}, { passive: true });
addEventListener('resize', updateAllRows);
addEventListener('hashchange', renderRoute);

/* ---------- init ---------- */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
updateSearchUI();
loadData();