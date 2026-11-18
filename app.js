/* UGG 货位助手 — Claude artifact edition.
   Data lives in the artifact's shared database (db capability), so every device
   that opens this page sees the same locations, counts, returns and change log. */
(function () {
  'use strict';

  const RETURN_REASONS = ['调回仓库', '质量问题 / 瑕疵', '换季退仓', '顾客退货待处理', '其他'];
  const LS_STAFF = 'ugg-staff-name';
  const LS_DRAFT = 'ugg-count-draft';

  // ---------------------------------------------------------------- state (mirrors the database)
  const S = {
    loaded: { locations: false, meta: false, products: false },
    locations: [], products: [], vendImportedAt: '', unitNames: {}, lowStock: 3,
    returns: [], counts: [], log: [], imports: [], laybys: [],
    layout: { storeroom: {}, store: {} },
    cap: { h: 6, l: 7, d: 2, display: 2, mode: 'cell', xl: ['15901', '15902'], xlH: 5, xlD: 1, daily: 8 },
    staff: lsGet(LS_STAFF) || '',
    countDraft: JSON.parse(lsGet(LS_DRAFT) || 'null'),
    readOnly: false,
  };
  let db = null, downloads = null, LOCAL = false;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  const saveDraft = () => lsSet(LS_DRAFT, S.countDraft ? JSON.stringify(S.countDraft) : null);

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowISO = () => new Date().toISOString();
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(String(iso).length <= 19 && !String(iso).endsWith('Z') ? String(iso).replace(' ', 'T') : iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const today = () => fmtTime(nowISO()).slice(0, 10);
  const go = (name, arg, params) => JSON.stringify({ n: name, a: arg || '', p: params || {} });
  const goAttr = (name, arg, params) => `data-go="${esc(go(name, arg, params))}"`;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------- 中 / EN switch
  // The UI is written in Chinese; in English mode every Chinese text node is translated as it appears.
  let LANG = lsGet('ugg-lang') || 'zh';
  const I18N_RULES = [
    [/库房\s*货架\s*(\d+)/g, 'Storeroom Shelf $1'], [/货架\s*(\d+)/g, 'Shelf $1'], [/店面\s*(\d+)/g, 'Store $1'],
    [/第\s*(\d+)\s*行\s*第\s*(\d+)\s*格/g, 'Row $1 · Bay $2'], [/约\s*(\d+)\s*\/\s*(\d+)\s*盒/g, '~$1/$2 boxes'],
    [/有\s*(\d+)\s*位客人的货可能到了/g, '$1 layby item(s) may have arrived'], [/有\s*(\d+)\s*位 layby 客人等的货到了，记得通知/g, '$1 layby item(s) arrived — remember to notify the customers'],
    [/(今天|当天)到货（/g, '$1 arrivals ('],
  ];
  let I18N_RE = null;
  const HAS_ZH = /[\u4e00-\u9fff]/;
  function tr(str) {
    if (LANG !== 'en' || !str || !HAS_ZH.test(str) || !window.I18N_EN) return str;
    let t = str;
    I18N_RULES.forEach(([r, v]) => { t = t.replace(r, v); });
    if (!I18N_RE) {
      const keys = Object.keys(window.I18N_EN).sort((a, b) => b.length - a.length);
      I18N_RE = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    }
    return t.replace(I18N_RE, (m) => window.I18N_EN[m]).replace(/[ ]{2,}/g, ' ');
  }
  // Only write when the text actually changes, or the observer would fire forever on untranslatable text.
  function setText(n) { const v = n.nodeValue; if (!v || !HAS_ZH.test(v)) return; const t = tr(v); if (t !== v) n.nodeValue = t; }
  function translateTree(root) {
    if (LANG !== 'en' || !root) return;
    if (root.nodeType === 3) { setText(root); return; }
    if (root.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA)$/.test(root.nodeName)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName) ? 2 : 1 });
    const nodes = []; let n;
    while ((n = w.nextNode())) if (HAS_ZH.test(n.nodeValue)) nodes.push(n);
    nodes.forEach(setText);
    [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')].forEach((el) => ['placeholder', 'title', 'aria-label'].forEach((a) => {
      const v = el.getAttribute(a); if (v && HAS_ZH.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }));
  }
  new MutationObserver((muts) => {
    if (LANG !== 'en') return;
    muts.forEach((m) => {
      if (m.type === 'characterData') { setText(m.target); return; }
      m.addedNodes.forEach(translateTree);
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  const SHELL = { tabs: document.querySelector('.tabbar').innerHTML, brand: document.querySelector('.brand').textContent };
  function applyLang() {
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
    document.querySelector('.tabbar').innerHTML = SHELL.tabs;
    document.querySelector('.brand').textContent = SHELL.brand;
    document.querySelector('#langBtn').textContent = LANG === 'en' ? '中文' : 'EN';
    translateTree(document.querySelector('.tabbar')); translateTree(document.querySelector('.brand'));
    const h = location.hash.replace(/^#/, '');
    $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === h));
  }
  document.querySelector('#langBtn').onclick = () => {
    LANG = LANG === 'en' ? 'zh' : 'en'; lsSet('ugg-lang', LANG);
    applyLang(); renderStaff(); render(false);
  };

  // ---------------------------------------------------------------- in-page dialogs (alert/confirm/prompt are blocked here)
  function modal(bodyHtml, buttons) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = `<div class="dlg-body">${bodyHtml}</div><div class="dlg-actions">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
      document.body.appendChild(dlg);
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      $$('.dlg-actions button', dlg).forEach((b) => b.onclick = () => done(buttons[b.dataset.i].value(dlg)));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
      dlg.showModal();
      const inp = $('input', dlg); if (inp) { inp.focus(); inp.select(); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(buttons[buttons.length - 1].value(dlg)); }); }
    });
  }
  const ask = (title, def = '', placeholder = '') => modal(
    `<b>${esc(title)}</b><input type="text" value="${esc(def)}" placeholder="${esc(placeholder)}" style="margin-top:10px">`,
    [{ label: '取消', value: () => null }, { label: '确定', cls: 'primary', value: (d) => $('input', d).value.trim() }]);
  const confirmDlg = (msg, okLabel = '确定') => modal(`<div>${esc(msg)}</div>`,
    [{ label: '取消', value: () => false }, { label: okLabel, cls: 'primary', value: () => true }]).then(Boolean);

  async function ensureStaff() {
    if (S.readOnly) { toast('你只有查看权限，不能修改'); return null; }
    if (S.staff) return S.staff;
    const name = await ask('请输入你的名字（用于记录是谁做的修改）', '', '例如 Rebecca');
    if (!name) { toast('需要先填写名字才能修改'); return null; }
    S.staff = name; lsSet(LS_STAFF, name); renderStaff();
    return name;
  }

  async function copyText(text, raw) {
    if (!raw) text = tr(text);
    try { await navigator.clipboard.writeText(text); toast('已复制，可以直接粘贴到微信 / WhatsApp'); }
    catch (e) {
      await modal(`<b>长按全选后复制</b><textarea readonly style="margin-top:8px">${esc(text)}</textarea>`, [{ label: '关闭', value: () => null }]);
    }
  }
  function toCSV(rows) {
    return rows.map((r) => r.map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  }
  async function saveFile(filename, text) {
    if (LOCAL) {
      const blob = new Blob([filename.endsWith('.csv') ? '\ufeff' + tr(text) : text], { type: filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = tr(filename);
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      return;
    }
    if (!downloads) { copyText(text); return; }
    try {
      await downloads.save({ filename: tr(filename), data: filename.endsWith('.csv') ? '\ufeff' + tr(text) : text });
    } catch (e) {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rate_limited') { toast('请稍等再试'); return; }
      toast('这里不能下载，改为复制');
      copyText(text);
    }
  }

  // Standalone mode (GitHub Pages): the same document API as Claude's db, kept in this browser's localStorage.
  function localDB() {
    const KEY = 'ugg-localdb-v1';
    let store = null;
    try { store = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { store = null; }
    if (!store) {
      store = {};
      const seed = window.SEED_DATA || { locations: [], products: [] };
      seed.locations.forEach((l, i) => { const c = Object.assign({}, l); delete c.id; c.order = i; store['locations/' + l.id] = c; });
      store['products/all'] = { list: seed.products, importedAt: seed.generated || '' };
      store['meta/main'] = { unitNames: {}, lowStock: 3, vendImportedAt: seed.generated || '' };
    }
    const subs = new Set();
    const persist = () => {
      try { localStorage.setItem(KEY, JSON.stringify(store)); }
      catch (e) { throw { code: 'quota_exceeded', message: '浏览器存储空间不够了（照片太多？），请删除一些旧照片' }; }
    };
    try { persist(); } catch (e) { /* reported on the first write */ }
    const fire = () => setTimeout(() => subs.forEach((f) => f()), 0);
    const meta = { fromCache: false, hasPendingWrites: false };
    const snapDoc = (p) => ({ id: p.split('/').pop(), exists: p in store, data: () => store[p], metadata: meta });
    const clone = (d) => JSON.parse(JSON.stringify(d));
    function doc(p) {
      return {
        id: p.split('/').pop(), path: p,
        get: async () => snapDoc(p),
        set: async (d) => { const old = store[p]; store[p] = clone(d); try { persist(); } catch (e) { if (old === undefined) delete store[p]; else store[p] = old; throw e; } fire(); },
        update: async (d) => { if (!(p in store)) throw { code: 'invalid_argument' }; store[p] = Object.assign({}, store[p], clone(d)); persist(); fire(); },
        delete: async () => { delete store[p]; persist(); fire(); },
        onSnapshot(next) { const run = () => next(snapDoc(p)); subs.add(run); setTimeout(run, 0); return () => subs.delete(run); },
        collection: (c) => coll(p + '/' + c),
      };
    }
    function coll(path, ord, lim, flt) {
      const depth = path.split('/').length + 1;
      const list = () => {
        let docs = Object.keys(store).filter((k) => k.startsWith(path + '/') && k.split('/').length === depth).map(snapDoc);
        (flt || []).forEach(([f, v]) => { docs = docs.filter((d) => d.data()[f] === v); });
        if (ord) docs.sort((a, b) => { const x = a.data()[ord[0]], y = b.data()[ord[0]]; return (x > y ? 1 : x < y ? -1 : 0) * (ord[1] === 'desc' ? -1 : 1); });
        if (lim) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] };
      };
      return {
        path, doc: (id) => doc(path + '/' + (id || uid())),
        add: async (d) => { const r = doc(path + '/' + uid()); await r.set(d); return r; },
        where: (f, op, v) => coll(path, ord, lim, (flt || []).concat([[f, v]])),
        orderBy: (f, d) => coll(path, [f, d], lim, flt), limit: (n) => coll(path, ord, n, flt),
        get: async () => list(),
        onSnapshot(next) { const run = () => next(list()); subs.add(run); setTimeout(run, 0); return () => subs.delete(run); },
      };
    }
    return { doc, collection: (p) => coll(p), dump: () => clone(store), restore: (st) => { const old = store; store = clone(st); try { persist(); } catch (e) { store = old; throw e; } fire(); } };
  }

  // ---------------------------------------------------------------- database writes
  const writeQ = {};
  function write(path, fn) {
    const prev = writeQ[path] || Promise.resolve();
    const p = prev.then(fn).catch((e) => {
      console.error('write failed', path, e);
      if (e && e.code === 'invalid_argument') { S.readOnly = true; toast('保存失败：你没有修改权限'); }
      else if (e && e.code === 'quota_exceeded') toast(e.message && LOCAL ? '保存失败：' + e.message : '保存失败：数据库已满，请清理旧记录');
      else toast('保存失败，请检查网络后重试');
    });
    writeQ[path] = p;
    return p;
  }
  const strip = (o) => { const c = Object.assign({}, o); delete c.id; return c; };
  const putLoc = (l) => write('locations/' + l.id, () => db.doc('locations/' + l.id).set(strip(l)));
  const delLoc = (id) => write('locations/' + id, () => db.doc('locations/' + id).delete());
  const putMeta = () => write('meta/main', () => db.doc('meta/main').set({ unitNames: S.unitNames, lowStock: S.lowStock, vendImportedAt: S.vendImportedAt, cap: S.cap }));
  const putLayout = () => write('meta/layout', () => db.doc('meta/layout').set({ storeroom: S.layout.storeroom || {}, store: S.layout.store || {}, labels: S.layout.labels || null }));
  const putImport = (r) => write('imports/' + r.id, () => db.doc('imports/' + r.id).set(strip(r)));
  const putProducts = () => write('products/all', () => db.doc('products/all').set({ list: S.products, importedAt: S.vendImportedAt }));
  const putReturn = (r) => write('returns/' + r.id, () => db.doc('returns/' + r.id).set(strip(r)));
  const delReturn = (id) => write('returns/' + id, () => db.doc('returns/' + id).delete());
  const putCount = (c) => write('counts/' + c.id, () => db.doc('counts/' + c.id).set(strip(c)));
  const delCount = (id) => write('counts/' + id, () => db.doc('counts/' + id).delete());
  function addLog(type, detail) {
    const g = { id: uid(), t: nowISO(), staff: S.staff || '?', type, detail };
    S.log.unshift(g);
    write('log/' + g.id, () => db.doc('log/' + g.id).set(strip(g)));
  }

  // ---------------------------------------------------------------- index
  let P = {}, codeLocs = {}, locById = {};
  function resolveCode(c) {
    c = norm(c);
    if (!c) return '';
    if (P[c]) return c;
    if (/[KM]$/.test(c) && P[c.slice(0, -1)]) return c.slice(0, -1);
    if (P[c + 'K']) return c + 'K';
    if (/^\d+$/.test(c) && P['AS' + c]) return 'AS' + c;
    return c;
  }
  function rebuildIndex() {
    P = {}; codeLocs = {}; locById = {};
    S.products.forEach((p) => { if (p.code) P[p.code] = p; });
    S.locations.forEach((l) => {
      locById[l.id] = l;
      (l.items || []).forEach((it) => {
        if (!it.code) return;
        const rc = resolveCode(it.code);
        codeLocs[rc] = codeLocs[rc] || [];
        if (!codeLocs[rc].includes(l.id)) codeLocs[rc].push(l.id);
      });
    });
  }
  const pendingReturnQty = (code) => S.returns.filter((r) => r.status === 'pending' && r.code === code).reduce((a, r) => a + Number(r.qty || 0), 0);

  // ---------------------------------------------------------------- naming
  function defaultUnitName(unit) {
    if (/^R\d+$/.test(unit)) return '库房 货架' + unit.slice(1);
    if (/^S\d+$/.test(unit)) return '店面 ' + unit.slice(1);
    return unit;
  }
  const unitName = (unit) => S.unitNames[unit] || defaultUnitName(unit);
  function locLabel(l) {
    if (!l) return '（已删除的位置）';
    if (l.area === 'storeroom') return `${unitName(l.unit)} · 第${l.row + 1}行 第${l.col + 1}格`;
    return unitName(l.unit) + (l.sub ? ' ' + l.sub : '');
  }
  function locChip(id, hiCode) {
    const l = locById[id];
    if (!l) return '';
    const room = l.area === 'storeroom';
    return `<a class="loc-chip ${room ? '' : 'store'}" ${goAttr('loc', id, hiCode ? { c: hiCode } : {})}>${room ? '📦' : '🏬'} <span class="where">${esc(locLabel(l))}</span></a>`;
  }
  const shortName = (n) => String(n || '').replace(/^(Australian Shepherd|Everau|AS\*|As\*)\s*/i, '');
  const itemName = (it) => { const p = P[resolveCode(it.code)]; return p ? p.name : (it.note || ''); };

  // ---------------------------------------------------------------- router (only plain #names reach the URL here)
  const TABS = ['today', 'search', 'map', 'count', 'stock', 'more'];
  let cur = { n: 'today', a: '', p: {} };
  const stack = [];
  const routes = {
    today: viewToday, overview: viewStock, layby: viewLayby, search: viewSearch, map: viewMap, loc: viewLoc, count: viewCount, countReport: viewCountReport,
    returns: viewReturns, stock: viewStockHub, more: viewMore, log: viewLog, import: viewImport, product: viewProduct,
    shelf: viewShelf, tidy: viewTidy, docs: viewDocs,
  };
  const GROUP = { loc: 'map', shelf: 'map', tidy: 'map', countReport: 'count', overview: 'stock', returns: 'stock', layby: 'stock', import: 'stock', docs: 'stock', log: 'more', product: 'search' };
  function navigate(r, push = true) {
    if (push) stack.push(cur);
    if (stack.length > 50) stack.shift();
    cur = r;
    render(true);
  }
  function back() { navigate(stack.pop() || { n: 'today', a: '', p: {} }, false); }
  function render(scrollTop) {
    if (!(S.loaded.locations && S.loaded.products)) return;
    const y = window.scrollY;
    const group = GROUP[cur.n] || cur.n;
    $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === group));
    (routes[cur.n] || viewSearch)(cur.a, new Map(Object.entries(cur.p || {})));
    window.scrollTo(0, scrollTop ? 0 : y);
  }
  // A snapshot from another device must not wipe what someone is typing.
  let pendingRender = false;
  function scheduleRender() {
    rebuildIndex();
    const a = document.activeElement;
    if (mapEditing || (a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || $('dialog[open]')) { pendingRender = true; return; }
    render(false);
  }
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!pendingRender) return;
    const a = document.activeElement;
    if (mapEditing || (a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) return;
    pendingRender = false; render(false);
  }, 400));
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go]');
    if (el) { e.preventDefault(); const r = JSON.parse(el.dataset.go); navigate({ n: r.n, a: r.a, p: r.p }); return; }
    if (e.target.closest('[data-back]')) { e.preventDefault(); back(); }
  });
  function fromHash() {
    const h = location.hash.replace(/^#/, '');
    if (TABS.includes(h)) { if (cur.n !== h || stack.length) { stack.length = 0; cur = { n: h, a: '', p: {} }; render(true); } }
  }
  window.addEventListener('hashchange', fromHash);
  const view = (html) => { $('#view').innerHTML = (S.readOnly ? '<div class="banner">你只有查看权限：可以查找，但不能修改。</div>' : '') + html; };
  const backLink = (label) => `<button class="linkish" data-back>‹ ${esc(label || '返回')}</button>`;

  // ---------------------------------------------------------------- search
  let lastQuery = '';
  function searchProducts(q) {
    const nq = norm(q);
    if (!nq) return [];
    const lower = q.trim().toLowerCase();
    const seen = new Map();
    const add = (code, score) => { if (!seen.has(code) || seen.get(code) < score) seen.set(code, score); };
    new Set([...Object.keys(P), ...Object.keys(codeLocs)]).forEach((code) => {
      const p = P[code];
      if (code === nq) add(code, 100);
      else if (code.startsWith(nq)) add(code, 80);
      else if (code.includes(nq)) add(code, 60);
      if (p && p.name.toLowerCase().includes(lower)) add(code, 40);
    });
    if (lower.length >= 2) S.locations.forEach((l) => (l.items || []).forEach((it) => {
      if (it.code && (it.note || '').toLowerCase().includes(lower)) add(resolveCode(it.code), 35);
    }));
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map((e) => e[0]);
  }
  function searchLocationsByText(q) {
    const lower = q.trim().toLowerCase();
    if (lower.length < 2) return [];
    return S.locations.filter((l) => (l.items || []).some((it) => !it.code && (it.note || '').toLowerCase().includes(lower)) || locLabel(l).toLowerCase().includes(lower));
  }
  function productCard(code) {
    const p = P[code];
    const locs = codeLocs[code] || [];
    const pend = pendingReturnQty(code);
    const notes = new Set();
    locs.forEach((id) => locById[id].items.forEach((it) => { if (it.code && resolveCode(it.code) === code && it.note) notes.add(it.note); }));
    return `<div class="card result">
      <div class="result-head">
        <div class="grow"><a ${goAttr('product', code)}><span class="code">${esc(code)}</span></a>
          <div class="name">${esc(p ? p.name : [...notes].join(' / ') || '（Vend 中没有这个款号）')}</div></div>
        <div style="text-align:right">
          ${!p ? '<span class="pill grey">Vend 无记录</span>' : `<div class="qty ${p.qty <= 0 ? 'zero' : ''}">${p.qty}</div><div class="small muted">系统库存</div>`}
          ${pend ? `<div><span class="pill warn">待退库 ${pend}</span></div>` : ''}
        </div>
      </div>
      <div style="margin-top:6px">${locs.length ? locs.map((id) => locChip(id, code)).join('') : `<span class="pill bad">还没有记录货位</span> <a class="small" ${goAttr('product', code)}>添加货位</a>`}</div>
    </div>`;
  }
  function viewSearch() {
    if (searchMode === 'batch') { viewBatch(); return; }
    view(`
      <div class="seg"><button class="on">🔍 单个查找</button><button id="toBatch">📍 批量定位</button></div>
      <input id="q" class="searchbox" type="search" inputmode="search" autocomplete="off" placeholder="输入款号或名字，例如 2115、AS2115、Tay" value="${esc(lastQuery)}">
      <div class="small muted" style="margin:6px 2px 12px">不用打完整款号：输入数字的一部分或英文名都可以。</div>
      <div id="results"></div>`);
    const q = $('#q');
    const run = () => {
      lastQuery = q.value;
      const codes = searchProducts(q.value), locs = searchLocationsByText(q.value);
      $('#results').innerHTML = !q.value.trim() ? homeSummary()
        : (!codes.length && !locs.length) ? `<div class="empty-state">找不到「${esc(q.value)}」<br><span class="small">检查款号是否正确，或者去「更多 → 库存总览」看全部款号。</span></div>`
          : codes.map(productCard).join('') + (locs.length ? '<h2>相关位置</h2>' + locs.map((l) => locChip(l.id)).join('') : '');
    };
    q.addEventListener('input', run);
    run();
    $('#toBatch').onclick = () => { searchMode = 'batch'; render(true); };
  }
  function viewBatch() {
    const codes = parseCodeList(batchText);
    view(`
      <div class="seg"><button id="toSingle">🔍 单个查找</button><button class="on">📍 批量定位</button></div>
      <label class="field">输入或粘贴多个货号（空格、逗号或换行分开）
        <textarea id="bq" rows="3" placeholder="AS2115 EA7100 15801 AS3083" autocapitalize="characters">${esc(batchText)}</textarea></label>
      <div class="row" style="margin:8px 0 12px"><button class="btn primary" id="bgo">📍 一起定位</button><button class="btn" id="bclear">清空</button></div>
      <div id="bres">${codes.length ? batchResults(codes) : '<div class="empty-state small">输入几个货号，会在仓库地图和店面地图上同时标出来。</div>'}</div>`);
    if (codes.length) bindBatch(codes);
    $('#toSingle').onclick = () => { searchMode = 'single'; render(true); };
    $('#bq').addEventListener('input', (e) => { batchText = e.target.value; lsSet('ugg-batch', batchText); });
    $('#bgo').onclick = () => { batchText = $('#bq').value; lsSet('ugg-batch', batchText); $('#bq').blur(); render(false); };
    $('#bclear').onclick = () => { batchText = ''; lsSet('ugg-batch', ''); render(false); };
  }
  function homeSummary() {
    const noLoc = S.products.filter((p) => p.code && p.qty > 0 && !codeLocs[p.code]).length;
    const low = S.products.filter((p) => p.code && p.qty > 0 && p.qty <= S.lowStock && codeLocs[p.code]).length;
    const pend = S.returns.filter((r) => r.status === 'pending').length;
    const todayCount = S.counts.filter((c) => fmtTime(c.date).slice(0, 10) === today()).length;
    return `
      <div class="card"><div class="row between"><b>今日状态</b><span class="small muted">${today()}</span></div>
        <div class="row" style="margin-top:8px">
          <a class="btn small" href="#count">${todayCount ? '✅ 今日已清点 ' + todayCount + ' 次' : '⏳ 今日还没清点'}</a>
          <a class="btn small" href="#returns">📦 待退库 ${pend} 条</a>
          <a class="btn small" ${goAttr('docs', '', { t: 'arrival' })}>📥 导入到货单</a>
          <a class="btn small" ${goAttr('tidy')}>💡 整理建议</a>
        </div></div>
      <div class="card"><b>需要注意</b>
        <div class="row" style="margin-top:8px">
          <a class="btn small" ${goAttr('overview', '', { f: 'low' })}>🔻 库存偏低（≤${S.lowStock}）${low} 款</a>
          <a class="btn small" ${goAttr('overview', '', { f: 'noloc' })}>❓ 有库存但没登记货位 ${noLoc} 款</a>
        </div>
        <div class="small muted" style="margin-top:8px">Vend 库存数据更新于：${esc(fmtTime(S.vendImportedAt)) || '未导入'} · <a ${goAttr('import')} style="text-decoration:underline">导入最新数据</a></div>
      </div>`;
  }

  // ---------------------------------------------------------------- product page
  function viewProduct(code) {
    code = resolveCode(code);
    const p = P[code];
    const locs = codeLocs[code] || [];
    const rets = S.returns.filter((r) => r.code === code);
    const history = S.log.filter((g) => g.detail && g.detail.code && resolveCode(g.detail.code) === code).slice(0, 20);
    view(`${backLink()}
      <h1><span class="code">${esc(code)}</span></h1>
      <div class="card"><div class="muted">${esc(p ? p.name : 'Vend 中没有这个款号')}</div>
        ${p ? `<div class="row" style="margin-top:8px;gap:18px">
          <div><div class="qty">${p.qty}</div><div class="small muted">系统库存</div></div>
          <div><div class="qty">${pendingReturnQty(code)}</div><div class="small muted">待退库</div></div>
          <div class="small muted">最近到货<br>${esc(fmtTime(p.lastReceived)) || '—'}</div></div>` : ''}
      </div>
      <h2>货位</h2>
      <div class="card">${locs.length ? locs.map((id) => `<div class="item-line"><div class="grow">${locChip(id, code)}</div><button class="btn small" data-mv="${esc(id)}">更改存放地</button><button class="btn small danger" data-rm="${esc(id)}">移除</button></div>`).join('') : '<span class="muted">还没有登记货位</span>'}
        <div style="margin-top:10px"><button class="btn small" id="addLocBtn">＋ 再登记一个货位</button>
        <button class="btn small" ${goAttr('returns', '', { c: code })}>📦 退库这个款</button></div></div>
      ${rets.length ? `<h2>退库记录</h2><div class="card">${rets.map((r) => `<div class="small">${esc(fmtTime(r.date))} · ${esc(r.staff)} · ${r.qty} 双 ${esc(r.size || '')} · ${r.status === 'pending' ? '<span class="pill warn">待退</span>' : '<span class="pill ok">已寄出</span>'}</div>`).join('')}</div>` : ''}
      ${history.length ? `<h2>修改记录</h2><div class="card">${history.map(logLine).join('')}</div>` : ''}`);
    $$('[data-mv]').forEach((b) => b.onclick = async () => {
      if (!await ensureStaff()) return;
      const from = b.dataset.mv;
      pickLocation(`${code} 从「${locLabel(locById[from])}」改放到哪里？`, from, (dest) => {
        moveCode(code, from, dest); toast('已改到 ' + locLabel(locById[dest])); render(false);
      });
    });
    $$('[data-rm]').forEach((b) => b.onclick = async () => {
      if (!await ensureStaff() || !await confirmDlg(`把 ${code} 从「${locLabel(locById[b.dataset.rm])}」移除？`, '移除')) return;
      removeCode(code, b.dataset.rm); toast('已移除'); render(false);
    });
    $('#addLocBtn').onclick = async () => {
      if (!await ensureStaff()) return;
      pickLocation('把 ' + code + ' 登记到哪个位置？', null, (dest) => {
        const l = locById[dest];
        l.items.push({ code, note: '' });
        putLoc(l); addLog('add', { code, to: dest, toLabel: locLabel(l) });
        rebuildIndex(); toast('已登记到 ' + locLabel(l)); render(false);
      });
    };
  }

  function bindCells(curId) {
    $$('[data-loc]').forEach((el) => el.onclick = () => { if (el.dataset.loc !== curId) navigate({ n: 'loc', a: el.dataset.loc, p: {} }); });
    $$('[data-rename]').forEach((el) => el.onclick = (e) => { e.stopPropagation(); renameUnit(el.dataset.rename); });
  }
  const toSet = (h) => h instanceof Set ? h : new Set(h ? [h] : []);
  function cellHtml(l, hiCode, showPos, curId, est) {
    const hs = toSet(hiCode);
    const hit = hs.size && l.items.some((it) => it.code && hs.has(resolveCode(it.code)));
    const inner = l.items.length ? l.items.map((it) => it.code ? `<span class="c">${esc(it.code)}</span> ${esc(it.note || shortName(itemName(it)))}` : esc(it.note)).join('<br>') : '（空）';
    let pos = showPos ? `第${l.row + 1}行 第${l.col + 1}格` : locLabel(l);
    if (est && l.area === 'storeroom') pos += ` · 约${Math.round(est.cell[l.id] || 0)}/${Math.round(cellCap(l))}盒`;
    const style = l.area === 'storeroom' && showPos ? `grid-row:${l.row + 1} / span ${l.rowspan || 1};grid-column:${l.col + 1} / span ${l.colspan || 1};` : '';
    return `<button type="button" class="cell ${l.items.length ? '' : 'empty'} ${hit ? 'hit' : ''} ${curId === l.id ? 'cur' : ''}" style="${style}" data-loc="${esc(l.id)}"><span class="pos">${esc(pos)}</span>${inner}</button>`;
  }
  function unitGrid(unit, hiCode, curId, est) {
    const cells = S.locations.filter((l) => l.unit === unit && l.area === 'storeroom');
    const cols = Math.max(...cells.map((l) => l.col + (l.colspan || 1)));
    return `<div class="unit"><div class="unit-title"><b>${esc(unitName(unit))}</b><button class="btn small" data-rename="${esc(unit)}">改名</button></div>
      <div class="grid" style="grid-template-columns:repeat(${cols}, minmax(0,1fr))">${cells.map((l) => cellHtml(l, hiCode, true, curId, est)).join('')}</div></div>`;
  }
  async function renameUnit(unit) {
    if (!await ensureStaff()) return;
    const before = unitName(unit);
    const name = await ask('给「' + before + '」起个好认的名字', before, '例如：库房 左边第一个架子');
    if (!name || name === before) return;
    S.unitNames[unit] = name;
    putMeta(); addLog('rename', { from: before, to: name });
    toast('已改名'); render(false);
  }
  async function newLocation() {
    if (!await ensureStaff()) return;
    const name = await ask('新位置的名字', '', '例如：收银台下柜、库房 门口地上');
    if (!name) return;
    const id = 'X' + uid();
    const l = { id, area: 'other', unit: id, sub: '', raw: '', items: [], order: 10000 + S.locations.length };
    S.locations.push(l); S.unitNames[id] = name;
    putLoc(l); putMeta(); addLog('newloc', { toLabel: name, to: id });
    rebuildIndex(); navigate({ n: 'loc', a: id, p: {} });
  }

  // ---------------------------------------------------------------- single location
  function viewLoc(id, params) {
    const l = locById[id];
    if (!l) { view(backLink() + '<div class="empty-state">这个位置不存在了</div>'); return; }
    const hi = params.get('c') ? resolveCode(params.get('c')) : '';
    const context = l.area === 'storeroom' ? unitGrid(l.unit, hi, l.id) : '';
    view(`${backLink()}
      <h1>${esc(locLabel(l))}</h1>
      ${context ? `<div class="small muted">黑框 = 当前这一格${hi ? '，橙色 = 你在找的款号' : ''}</div>${context}` : ''}
      <div class="card">
        ${l.items.length ? l.items.map((it, i) => {
          const rc = resolveCode(it.code), p = P[rc];
          return `<div class="item-line"><div class="grow">
              ${it.code ? `<a ${goAttr('product', rc)}><span class="code" ${rc === hi ? 'style="background:var(--accent-soft)"' : ''}>${esc(it.code)}</span></a>` : ''}
              <span>${esc(it.note || '')}</span>
              ${p ? `<div class="small muted">${esc(p.name)} · 系统库存 <b>${p.qty}</b></div>` : it.code ? '<div class="small muted">Vend 无记录</div>' : ''}
            </div>
            <button class="btn small" data-act="move" data-i="${i}">移动</button>
            <button class="btn small" data-act="edit" data-i="${i}">备注</button>
            <button class="btn small danger" data-act="del" data-i="${i}">删除</button></div>`;
        }).join('') : '<div class="muted">这里现在是空的</div>'}
      </div>
      <div class="card stack"><b>添加款号到这里</b>
        <div class="row"><input id="newCode" type="text" placeholder="款号，例如 AS2115" class="grow" style="flex:2" autocapitalize="characters"><input id="newNote" type="text" placeholder="备注（颜色/尺码，可不填）" class="grow" style="flex:3"></div>
        <div id="newHint" class="small muted"></div>
        <button class="btn primary" id="addBtn">＋ 添加</button></div>
      ${l.area !== 'storeroom' ? `<div class="row"><button class="btn small" id="renameLoc">改位置名字</button>${l.area === 'other' ? '<button class="btn small danger" id="delLoc">删除这个位置</button>' : ''}</div>` : ''}
      <h2>这个位置的修改记录</h2>
      <div class="card">${S.log.filter((g) => g.detail && (g.detail.to === id || g.detail.from === id || g.detail.loc === id)).slice(0, 15).map(logLine).join('') || '<span class="muted small">暂无</span>'}</div>`);
    bindCells(id);
    const nc = $('#newCode');
    nc.addEventListener('input', () => {
      const rc = resolveCode(nc.value), p = P[rc];
      $('#newHint').innerHTML = !nc.value ? '' : p ? `✔ ${esc(p.name)}（库存 ${p.qty}）${codeLocs[rc] ? ' · 已在：' + codeLocs[rc].map((x) => esc(locLabel(locById[x]))).join('、') : ''}` : '⚠️ Vend 里没有这个款号（也可以照样添加）';
    });
    $('#addBtn').onclick = async () => {
      const code = norm(nc.value), note = $('#newNote').value.trim();
      if (!code && !note) { toast('请输入款号'); return; }
      if (!await ensureStaff()) return;
      l.items.push({ code, note });
      putLoc(l); addLog('add', { code, to: id, toLabel: locLabel(l), note });
      rebuildIndex(); toast('已添加'); render(false);
    };
    $$('[data-act]').forEach((b) => b.onclick = async () => {
      const i = Number(b.dataset.i), it = l.items[i];
      if (!await ensureStaff()) return;
      if (b.dataset.act === 'del') {
        if (!await confirmDlg(`确定把 ${it.code || it.note} 从「${locLabel(l)}」删除吗？`, '删除')) return;
        l.items.splice(i, 1);
        putLoc(l); addLog('remove', { code: it.code, from: id, fromLabel: locLabel(l) });
        rebuildIndex(); toast('已删除'); render(false);
      } else if (b.dataset.act === 'edit') {
        const note = await ask('备注（颜色、尺码等）', it.note || '');
        if (note == null) return;
        addLog('note', { code: it.code, loc: id, fromLabel: locLabel(l), before: it.note, after: note });
        it.note = note; putLoc(l); render(false);
      } else {
        pickLocation(`把 ${it.code || it.note} 移到哪里？`, id, (dest) => {
          const d = locById[dest];
          l.items.splice(i, 1); d.items.push(it);
          putLoc(l); putLoc(d);
          addLog('move', { code: it.code, from: id, fromLabel: locLabel(l), to: dest, toLabel: locLabel(d) });
          rebuildIndex(); toast(`已移到 ${locLabel(d)}`); render(false);
        });
      }
    });
    const rn = $('#renameLoc'); if (rn) rn.onclick = () => renameUnit(l.unit);
    const dl = $('#delLoc'); if (dl) dl.onclick = async () => {
      if (l.items.length) { toast('请先把里面的款号移走'); return; }
      if (!await ensureStaff() || !await confirmDlg('确定删除这个位置？', '删除')) return;
      addLog('delloc', { fromLabel: locLabel(l) });
      S.locations = S.locations.filter((x) => x.id !== id); delLoc(id);
      rebuildIndex(); back();
    };
  }
  function pickLocation(title, excludeId, onPick) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dlg-body"><b>${esc(title)}</b>
      <input type="search" placeholder="搜索位置或款号，例如 货架3、店面 05、AS2115" style="margin-top:10px">
      <div class="pick-list"></div></div><div class="dlg-actions"><button class="btn">取消</button></div>`;
    document.body.appendChild(dlg);
    const input = $('input', dlg), list = $('.pick-list', dlg);
    const close = () => { dlg.close(); dlg.remove(); };
    const draw = () => {
      const q = input.value.trim().toLowerCase(), nq = norm(q);
      const ls = S.locations.filter((l) => l.id !== excludeId && (!q || locLabel(l).toLowerCase().includes(q) || l.id.toLowerCase().includes(q) || l.items.some((it) => (nq && norm(it.code).includes(nq)) || (it.note || '').toLowerCase().includes(q))));
      list.innerHTML = ls.map((l) => `<button data-id="${esc(l.id)}"><b>${esc(locLabel(l))}</b><br><span class="small muted">${esc(l.items.map((it) => it.code || it.note).join(' · ') || '（空）')}</span></button>`).join('') || '<div class="muted small">没有匹配的位置</div>';
      $$('button[data-id]', list).forEach((b) => b.onclick = () => { close(); onPick(b.dataset.id); });
    };
    input.addEventListener('input', draw);
    $('.dlg-actions button', dlg).onclick = close;
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    draw(); dlg.showModal(); input.focus();
  }

  // ---------------------------------------------------------------- daily count
  function scopeOptions() {
    const opts = [['all-store', '🏬 店面全部'], ['all-room', '📦 库房全部']];
    [...new Set(S.locations.filter((l) => l.area === 'storeroom').map((l) => l.unit))].forEach((u) => opts.push(['unit:' + u, '📦 ' + unitName(u)]));
    S.locations.filter((l) => l.area !== 'storeroom').forEach((l) => opts.push(['loc:' + l.id, (l.area === 'store' ? '🏬 ' : '➕ ') + locLabel(l)]));
    opts.push(['custom', '✍️ 自己输入款号']);
    return opts;
  }
  function codesForScope(scope) {
    let locs = [];
    if (scope === 'all-store') locs = S.locations.filter((l) => l.area === 'store');
    else if (scope === 'all-room') locs = S.locations.filter((l) => l.area === 'storeroom');
    else if (scope.startsWith('unit:')) locs = S.locations.filter((l) => l.unit === scope.slice(5));
    else if (scope.startsWith('loc:')) locs = [locById[scope.slice(4)]].filter(Boolean);
    const codes = [];
    locs.forEach((l) => l.items.forEach((it) => { if (it.code) { const rc = resolveCode(it.code); if (!codes.includes(rc)) codes.push(rc); } }));
    return codes;
  }
  function viewCount() {
    const d = S.countDraft;
    if (!d) {
      view(`<h1>每日清点</h1>
        <div class="card"><b>清点步骤</b>
          <ol class="sop small">
            <li>选择今天要清点的范围（一个货架 / 一个展位 / 全部）</li>
            <li>按列表逐个款号数实物，在右边格子里填<b>实际数量</b>（店面 + 库房加起来的总数）</li>
            <li>右边会自动显示和 Vend 系统数的差异</li>
            <li>点「完成清点」保存，再把差异报告复制发给经理</li>
          </ol>
          <div class="small muted">Vend 数据更新于 ${esc(fmtTime(S.vendImportedAt)) || '—'}。清点前最好先 <a ${goAttr('import')} style="text-decoration:underline">导入当天的 Vend 库存</a>，差异才准确。</div></div>
        <label class="field">清点范围<select id="scope">${scopeOptions().map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>
        <button class="btn primary block" id="startBtn" style="margin-top:10px">开始清点</button>
        <h2>最近的清点</h2>
        ${S.counts.length ? S.counts.slice(0, 15).map((c) => {
          const diffs = c.lines.filter((x) => x.diff !== 0).length;
          return `<a class="card row between" style="display:flex" ${goAttr('countReport', c.id)}><div><b>${esc(c.scopeLabel)}</b><div class="small muted">${esc(fmtTime(c.date))} · ${esc(c.staff)} · ${c.lines.length} 款</div></div>${diffs ? `<span class="pill bad">${diffs} 款有差异</span>` : '<span class="pill ok">全部相符</span>'}</a>`;
        }).join('') : '<div class="muted small">还没有清点记录</div>'}`);
      $('#startBtn').onclick = async () => {
        if (!await ensureStaff()) return;
        const scope = $('#scope').value, label = $('#scope').selectedOptions[0].textContent;
        const codes = scope === 'custom' ? [] : codesForScope(scope);
        S.countDraft = { id: uid(), scope, scopeLabel: label, startedAt: nowISO(), staff: S.staff, lines: codes.map((c) => ({ code: c, counted: '' })) };
        saveDraft(); render(true);
      };
      return;
    }
    const done = d.lines.filter((x) => x.counted !== '').length;
    view(`<h1 style="margin:0">清点：${esc(d.scopeLabel)}</h1>
      <div class="small muted">开始于 ${esc(fmtTime(d.startedAt))} · ${esc(d.staff)} · 已填 <span id="doneN">${done}</span>/${d.lines.length}（草稿只存在这台设备上）</div>
      <div class="progress"><div style="width:${d.lines.length ? done / d.lines.length * 100 : 0}%"></div></div>
      <div class="row" style="margin:10px 0"><input id="addCode" type="text" placeholder="加一个款号到清点列表" class="grow" autocapitalize="characters"><button class="btn small" id="addCodeBtn">加入</button></div>
      <div class="card" id="lines">
        <div class="count-line small muted" style="padding-top:0"><div>款号 / 货位</div><div class="sys">系统</div><div style="text-align:center">实数</div></div>
        ${d.lines.map((x, i) => {
          const p = P[x.code];
          return `<div class="count-line"><div><span class="code">${esc(x.code)}</span> <span class="diff" id="diff${i}"></span>
              <div class="small muted">${esc(shortName(p ? p.name : '（Vend 无记录）'))}</div>
              <div class="small">${(codeLocs[x.code] || []).map((id) => esc(locLabel(locById[id]))).join(' · ')}</div></div>
            <div class="sys"><b>${p ? p.qty : '—'}</b></div>
            <input type="number" inputmode="numeric" min="0" data-i="${i}" value="${esc(x.counted)}" aria-label="${esc(x.code)} 实际数量"></div>`;
        }).join('')}
      </div>
      <div class="sticky-actions row"><button class="btn danger" id="cancelBtn">放弃</button><button class="btn primary grow" id="finishBtn">完成清点（${done} 款）</button></div>`);
    const showDiff = (i) => {
      const x = d.lines[i], p = P[x.code], el = $('#diff' + i);
      if (x.counted === '' || !p) { el.textContent = ''; return; }
      const df = Number(x.counted) - p.qty;
      el.className = 'diff ' + (df > 0 ? 'plus' : df < 0 ? 'minus' : 'zero');
      el.textContent = df === 0 ? '✓ 相符' : (df > 0 ? '多 ' + df : '少 ' + (-df));
    };
    $$('#lines input').forEach((inp) => {
      const i = Number(inp.dataset.i);
      showDiff(i);
      inp.addEventListener('input', () => {
        d.lines[i].counted = inp.value === '' ? '' : String(Math.max(0, parseInt(inp.value, 10) || 0));
        showDiff(i); saveDraft();
        const n = d.lines.filter((x) => x.counted !== '').length;
        $('#finishBtn').textContent = `完成清点（${n} 款）`;
        $('#doneN').textContent = n;
        $('.progress > div').style.width = (n / d.lines.length * 100) + '%';
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const nx = $(`#lines input[data-i="${i + 1}"]`); if (nx) nx.focus(); } });
    });
    $('#addCodeBtn').onclick = () => {
      const c = resolveCode($('#addCode').value);
      if (!c) return;
      if (d.lines.some((x) => x.code === c)) { toast('已经在列表里了'); return; }
      d.lines.push({ code: c, counted: '' }); saveDraft(); render(false);
    };
    $('#cancelBtn').onclick = async () => { if (await confirmDlg('放弃这次清点？已填的数字会清空。', '放弃')) { S.countDraft = null; saveDraft(); render(true); } };
    $('#finishBtn').onclick = async () => {
      const lines = d.lines.filter((x) => x.counted !== '').map((x) => {
        const p = P[x.code], sys = p ? p.qty : 0;
        return { code: x.code, name: p ? p.name : '', system: sys, counted: Number(x.counted), diff: Number(x.counted) - sys };
      });
      if (!lines.length) { toast('还没有填任何数量'); return; }
      const skipped = d.lines.length - lines.length;
      if (skipped && !await confirmDlg(`还有 ${skipped} 款没有填，确定完成吗？（没填的不会记录）`, '完成')) return;
      if (!await ensureStaff()) return;
      const rec = { id: d.id, date: nowISO(), staff: S.staff, scope: d.scope, scopeLabel: d.scopeLabel, vendAt: S.vendImportedAt, lines };
      S.counts.unshift(rec); putCount(rec);
      addLog('count', { scopeLabel: d.scopeLabel, n: lines.length, diffs: lines.filter((x) => x.diff).length, countId: rec.id });
      S.countDraft = null; saveDraft();
      navigate({ n: 'countReport', a: rec.id, p: {} });
    };
  }
  function countReportText(c) {
    const diffs = c.lines.filter((x) => x.diff !== 0);
    let t = `【库存清点】${fmtTime(c.date)}\n范围：${c.scopeLabel}\n清点人：${c.staff}\n共清点 ${c.lines.length} 款，${diffs.length ? diffs.length + ' 款有差异：' : '全部和系统相符 ✅'}\n`;
    diffs.forEach((x) => { t += `- ${x.code} ${shortName(x.name)}：系统 ${x.system} / 实际 ${x.counted}（${x.diff > 0 ? '多' : '少'} ${Math.abs(x.diff)}）\n`; });
    return t;
  }
  function viewCountReport(id) {
    const c = S.counts.find((x) => x.id === id);
    if (!c) { view(backLink() + '<div class="empty-state">找不到这次清点</div>'); return; }
    const diffs = c.lines.filter((x) => x.diff !== 0);
    const row = (x) => `<tr><td><span class="code">${esc(x.code)}</span><div class="small muted">${esc(shortName(x.name))}</div></td><td class="num">${x.system}</td><td class="num">${x.counted}</td><td class="num"><span class="diff ${x.diff > 0 ? 'plus' : x.diff < 0 ? 'minus' : 'zero'}">${x.diff > 0 ? '+' : ''}${x.diff}</span></td></tr>`;
    view(`<a class="linkish" href="#count">‹ 清点</a>
      <h1>清点报告</h1>
      <div class="card"><b>${esc(c.scopeLabel)}</b><div class="small muted">${esc(fmtTime(c.date))} · ${esc(c.staff)} · Vend 数据时间 ${esc(fmtTime(c.vendAt))}</div>
        <div class="row" style="margin-top:8px">${diffs.length ? `<span class="pill bad">${diffs.length} 款有差异</span>` : '<span class="pill ok">全部相符</span>'}<span class="pill grey">共 ${c.lines.length} 款</span></div></div>
      <div class="row"><button class="btn primary" id="copyBtn">📋 复制差异报告</button><button class="btn" id="csvBtn">⬇️ 下载 CSV</button></div>
      <h2>${diffs.length ? '差异' : '明细'}</h2>
      <div class="card"><table class="list"><tr><th>款号</th><th class="num">系统</th><th class="num">实际</th><th class="num">差异</th></tr>${(diffs.length ? diffs : c.lines).map(row).join('')}</table></div>
      ${diffs.length && diffs.length < c.lines.length ? `<details><summary class="small">查看全部 ${c.lines.length} 款</summary><div class="card"><table class="list">${c.lines.map(row).join('')}</table></div></details>` : ''}
      <button class="btn small danger" id="delCount" style="margin-top:14px">删除这次记录</button>`);
    $('#copyBtn').onclick = () => copyText(countReportText(c));
    $('#csvBtn').onclick = () => saveFile(`清点_${fmtTime(c.date).replace(/[: ]/g, '-')}.csv`, toCSV([['日期', '清点人', '范围', '款号', '名称', '系统数量', '实际数量', '差异'], ...c.lines.map((x) => [fmtTime(c.date), c.staff, c.scopeLabel, x.code, x.name, x.system, x.counted, x.diff])]));
    $('#delCount').onclick = async () => {
      if (!await ensureStaff() || !await confirmDlg('删除这次清点记录？', '删除')) return;
      S.counts = S.counts.filter((x) => x.id !== id); delCount(id);
      location.hash = '#count'; stack.length = 0; cur = { n: 'count', a: '', p: {} }; render(true);
    };
  }

  // ---------------------------------------------------------------- returns
  let retFilter = 'pending';
  function viewReturns(_, params) {
    const pre = params.get('c') || '';
    const list = S.returns.filter((r) => retFilter === 'all' || r.status === retFilter);
    view(`<h1>📦 待退清单</h1>
      ${backLink()}
      <div class="card stack"><b>登记一笔退库</b>
        <label class="field">款号<input id="rCode" type="text" value="${esc(pre)}" placeholder="例如 AS2115" autocapitalize="characters"></label>
        <div id="rHint" class="small muted"></div>
        <div class="row"><label class="field grow">尺码 / 颜色<input id="rSize" type="text" placeholder="例如 38 CHOC"></label>
          <label class="field" style="width:90px">数量<input id="rQty" type="number" min="1" value="1" inputmode="numeric"></label></div>
        <label class="field">原因<select id="rReason">${RETURN_REASONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
        <label class="field">备注<input id="rNote" type="text" placeholder="可不填，例如 箱号 / 退货单号"></label>
        <button class="btn primary" id="rAdd">＋ 加入退库清单</button></div>
      <div class="seg">
        <button data-f="pending" class="${retFilter === 'pending' ? 'on' : ''}">待退 (${S.returns.filter((r) => r.status === 'pending').length})</button>
        <button data-f="sent" class="${retFilter === 'sent' ? 'on' : ''}">已寄出</button>
        <button data-f="all" class="${retFilter === 'all' ? 'on' : ''}">全部</button></div>
      ${list.length ? `<div class="card"><table class="list"><tr><th>款号</th><th>尺码</th><th class="num">数量</th><th></th></tr>
        ${list.map((r) => `<tr><td><span class="code">${esc(r.code)}</span><div class="small muted">${esc(shortName(r.name))}</div><div class="small muted">${esc(r.reason)}${r.note ? ' · ' + esc(r.note) : ''}<br>${esc(fmtTime(r.date))} · ${esc(r.staff)}${r.sentAt ? '<br>寄出 ' + esc(fmtTime(r.sentAt)) + ' · ' + esc(r.sentBy) : ''}</div></td>
          <td>${esc(r.size)}</td><td class="num"><b>${r.qty}</b></td>
          <td style="text-align:right">${r.status === 'pending' ? `<button class="btn small" data-sent="${esc(r.id)}">已寄出</button>` : '<span class="pill ok">已寄出</span>'}<br><button class="btn small danger" data-del="${esc(r.id)}" style="margin-top:4px">删除</button></td></tr>`).join('')}</table></div>
        <div class="row"><button class="btn primary" id="rCopy">📋 复制清单</button><button class="btn" id="rCsv">⬇️ 下载 CSV</button>${retFilter === 'pending' ? '<button class="btn" id="rAllSent">全部标记为已寄出</button>' : ''}</div>`
        : '<div class="empty-state">清单是空的</div>'}
      <p class="small muted">点「已寄出」会马上从库存里减掉这个数量。也记得在 Vend 里做对应调整，下次导入 Vend 报表时以 Vend 为准。</p>`);
    const rc = $('#rCode');
    const hint = () => {
      const c = resolveCode(rc.value), p = P[c];
      $('#rHint').innerHTML = !rc.value ? '' : p ? `✔ ${esc(p.name)} · 库存 ${p.qty}${codeLocs[c] ? ' · 位置：' + codeLocs[c].map((id) => esc(locLabel(locById[id]))).join('、') : ''}` : '⚠️ Vend 中没有这个款号';
    };
    rc.addEventListener('input', hint); hint();
    $$('.seg button').forEach((b) => b.onclick = () => { retFilter = b.dataset.f; render(false); });
    $('#rAdd').onclick = async () => {
      const code = resolveCode(rc.value), qty = parseInt($('#rQty').value, 10);
      if (!code) { toast('请输入款号'); return; }
      if (!(qty > 0)) { toast('数量要大于 0'); return; }
      if (!await ensureStaff()) return;
      const p = P[code];
      const r = { id: uid(), date: nowISO(), staff: S.staff, code, name: p ? p.name : '', size: $('#rSize').value.trim(), qty, reason: $('#rReason').value, note: $('#rNote').value.trim(), status: 'pending' };
      S.returns.unshift(r); putReturn(r);
      addLog('return', { code, qty, size: r.size, reason: r.reason });
      cur.p = {}; toast('已加入退库清单'); render(false);
    };
    $$('[data-sent]').forEach((b) => b.onclick = async () => {
      if (!await ensureStaff()) return;
      const r = S.returns.find((x) => x.id === b.dataset.sent);
      r.status = 'sent'; r.sentAt = nowISO(); r.sentBy = S.staff;
      if (!r.stockApplied && P[r.code]) { applyMove('return_wh', [{ code: r.code, qty: r.qty, delta: -r.qty, size: r.size }], '待退清单寄出', r.reason); r.stockApplied = true; }
      putReturn(r); addLog('return-sent', { code: r.code, qty: r.qty, size: r.size });
      toast(`已寄出，${r.code} 库存 −${r.qty}`); render(false);
    });
    $$('[data-del]').forEach((b) => b.onclick = async () => {
      if (!await ensureStaff() || !await confirmDlg('删除这条退库记录？', '删除')) return;
      const r = S.returns.find((x) => x.id === b.dataset.del);
      S.returns = S.returns.filter((x) => x !== r); delReturn(r.id);
      addLog('return-del', { code: r.code, qty: r.qty, size: r.size }); render(false);
    });
    if ($('#rCopy')) {
      $('#rCopy').onclick = () => {
        const total = list.reduce((a, r) => a + r.qty, 0);
        copyText(`【退库清单】${today()}  共 ${list.length} 条 / ${total} 件\n` + list.map((r) => `- ${r.code} ${shortName(r.name)} ${r.size} × ${r.qty}（${r.reason}${r.note ? '，' + r.note : ''}）`).join('\n'));
      };
      $('#rCsv').onclick = () => saveFile(`退库清单_${today()}.csv`, toCSV([['登记日期', '登记人', '款号', '名称', '尺码/颜色', '数量', '原因', '备注', '状态', '寄出时间', '寄出人'], ...list.map((r) => [fmtTime(r.date), r.staff, r.code, r.name, r.size, r.qty, r.reason, r.note, r.status === 'pending' ? '待退' : '已寄出', fmtTime(r.sentAt), r.sentBy || ''])]));
      const all = $('#rAllSent');
      if (all) all.onclick = async () => {
        if (!await ensureStaff() || !await confirmDlg(`把 ${list.length} 条全部标记为已寄出？`)) return;
        const lines = list.filter((r) => !r.stockApplied && P[r.code]).map((r) => ({ code: r.code, qty: r.qty, delta: -r.qty, size: r.size }));
        if (lines.length) applyMove('return_wh', lines, '待退清单寄出', '');
        for (const r of list) { r.status = 'sent'; r.sentAt = nowISO(); r.sentBy = S.staff; r.stockApplied = true; putReturn(r); }
        addLog('return-sent', { n: list.length }); render(false);
      };
    }
  }

  // ---------------------------------------------------------------- stock overview
  function viewStock(_, params) {
    const f = params.get('f') || 'all';
    let rows = S.products.filter((p) => p.code);
    if (f === 'low') rows = rows.filter((p) => p.qty > 0 && p.qty <= S.lowStock);
    if (f === 'noloc') rows = rows.filter((p) => p.qty > 0 && !codeLocs[p.code]);
    if (f === 'zero') rows = rows.filter((p) => p.qty <= 0 && codeLocs[p.code]);
    const unknown = Object.keys(codeLocs).filter((c) => !P[c]);
    rows.sort((a, b) => f === 'low' ? a.qty - b.qty : b.qty - a.qty);
    const total = S.products.reduce((a, p) => a + Math.max(0, p.qty), 0);
    view(`${backLink()}
      <h1>库存总览</h1>
      <div class="small muted">共 ${S.products.length} 款 · 总件数 ${total} · Vend 数据 ${esc(fmtTime(S.vendImportedAt))}</div>
      <div class="seg" style="margin-top:10px">
        <button data-f="all" class="${f === 'all' ? 'on' : ''}">全部</button><button data-f="low" class="${f === 'low' ? 'on' : ''}">偏低</button>
        <button data-f="noloc" class="${f === 'noloc' ? 'on' : ''}">没货位</button><button data-f="zero" class="${f === 'zero' ? 'on' : ''}">卖完了</button></div>
      <div class="small muted" style="margin-bottom:8px">${{ all: '按库存从多到少排列', low: `库存 1–${S.lowStock} 件的款，考虑补货`, noloc: '有库存但货位表里没有，点进去登记货位', zero: '系统显示 0，但货位表里还有它——可以考虑把位置腾出来' }[f]}</div>
      <input id="filter" type="search" placeholder="筛选款号或名字">
      <div class="card" style="margin-top:8px"><table class="list" id="stockTable"><tr><th>款号</th><th class="num">库存</th></tr>
        ${rows.map((p) => `<tr data-k="${esc((p.code + ' ' + p.name).toLowerCase())}"><td><a ${goAttr('product', p.code)}><span class="code">${esc(p.code)}</span></a><div class="small muted">${esc(p.name)}</div><div>${(codeLocs[p.code] || []).map((id) => locChip(id, p.code)).join('')}</div></td><td class="num"><b class="${p.qty <= 0 ? 'qty zero' : ''}">${p.qty}</b></td></tr>`).join('')}
      </table></div>
      ${unknown.length && f === 'all' ? `<h2>货位表里有，但 Vend 没有的款号</h2><div class="card small">${unknown.map((c) => `<a ${goAttr('product', c)} class="code">${esc(c)}</a>`).join(' · ')}<div class="muted" style="margin-top:6px">可能是款号写错了，或者已经卖完从系统里下架。</div></div>` : ''}
      <button class="btn small" id="csvStock">⬇️ 下载这张表 (CSV)</button>`);
    $$('.seg button').forEach((b) => b.onclick = () => { cur.p = { f: b.dataset.f }; render(true); });
    $('#filter').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('#stockTable tr[data-k]').forEach((tr) => { tr.style.display = tr.dataset.k.includes(q) ? '' : 'none'; });
    });
    $('#csvStock').onclick = () => saveFile(`库存_${today()}.csv`, toCSV([['款号', '名称', '系统库存', '货位'], ...rows.map((p) => [p.code, p.name, p.qty, (codeLocs[p.code] || []).map((id) => locLabel(locById[id])).join(' | ')])]));
  }

  // ---------------------------------------------------------------- Vend import
  let importResultHtml = '';
  function viewImport() {
    view(`${backLink()}
      <h1>导入 Vend 库存</h1>
      <div class="card"><ol class="sop small">
          <li>在 Vend（Lightspeed）后台导出库存报表（和之前的 period end count 报表同一种），下载 Excel (.xlsx) 或 CSV</li>
          <li>点下面的按钮选择这个文件</li>
          <li>表格里要有 <b>Tag</b>（款号）和 <b>Current Inventory</b>（当前库存）两列</li></ol>
        <input type="file" id="file" accept=".xlsx,.xls,.csv" style="margin-top:8px">
        <div id="impResult" style="margin-top:10px">${importResultHtml}</div></div>
      <div class="small muted">上次导入：${esc(fmtTime(S.vendImportedAt)) || '—'}。导入只更新库存数字，不会改动货位。导入后所有设备都会看到新数字。</div>`);
    $('#file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!window.XLSX) { toast('表格读取组件还没加载完，请稍等再试'); return; }
      if (!await ensureStaff()) return;
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
        const products = parseVendRows(rows);
        if (!products.length) throw new Error('没找到 Tag / Current Inventory 列');
        const before = {}; S.products.forEach((p) => { before[p.code] = p.qty; });
        const changed = products.filter((p) => before[p.code] !== undefined && before[p.code] !== p.qty);
        const added = products.filter((p) => before[p.code] === undefined);
        S.products = products; S.vendImportedAt = nowISO();
        putProducts(); putMeta();
        addLog('import', { file: file.name, n: products.length, changed: changed.length, added: added.length });
        rebuildIndex();
        importResultHtml = `<div class="pill ok">导入成功</div>
          <p class="small">共 ${products.length} 款；库存变化 ${changed.length} 款；新款 ${added.length} 款。</p>
          ${added.length ? `<p class="small"><b>新款（记得登记货位）：</b>${added.map((p) => `<a ${goAttr('product', p.code)} class="code">${esc(p.code)}</a>`).join(' · ')}</p>` : ''}
          ${changed.length ? `<details><summary class="small">查看变化</summary><table class="list small">${changed.map((p) => `<tr><td class="code">${esc(p.code)}</td><td>${before[p.code]} → <b>${p.qty}</b></td></tr>`).join('')}</table></details>` : ''}`;
        $('#impResult').innerHTML = importResultHtml;
      } catch (err) {
        console.error(err);
        importResultHtml = `<div class="pill bad">导入失败</div><p class="small">${esc(err.message)}</p>`;
        $('#impResult').innerHTML = importResultHtml;
      }
    };
  }
  function parseVendRows(rows) {
    let h = -1, cols = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map((x) => String(x).trim().toLowerCase());
      const tag = r.findIndex((x) => x === 'tag' || x === 'sku' || x === 'tags');
      const curI = r.findIndex((x) => x === 'current inventory' || x === 'inventory' || x === 'current stock');
      if (tag >= 0 && curI >= 0) {
        h = i;
        cols = { tag, cur: curI, name: r.findIndex((x) => x === 'product' || x === 'name'), closing: r.findIndex((x) => x === 'closing inventory'), last: r.findIndex((x) => x.startsWith('last received')) };
        break;
      }
    }
    if (h < 0) return [];
    const map = {};
    rows.slice(h + 1).forEach((r) => {
      const name = cols.name >= 0 ? String(r[cols.name]).trim() : '';
      const code = norm(r[cols.tag]);
      if (!code && !name) return;
      const key = code || 'NAME:' + name;
      const p = map[key] = map[key] || { code, name: name || code, qty: 0, closing: 0, lastReceived: '' };
      p.qty += parseInt(r[cols.cur], 10) || 0;
      if (cols.closing >= 0) p.closing += parseInt(r[cols.closing], 10) || 0;
      if (cols.last >= 0 && String(r[cols.last]) > p.lastReceived) p.lastReceived = String(r[cols.last]);
    });
    return Object.values(map);
  }

  // ---------------------------------------------------------------- change log
  const LOG_TYPES = { move: '移动', add: '添加', remove: '删除', note: '改备注', rename: '改名', newloc: '新位置', delloc: '删位置', count: '清点', return: '退库登记', 'return-sent': '退库寄出', 'return-del': '删退库', import: '导入 Vend', 'stock-in': '到货入库', 'stock-out': '退货出库', 'stock-undo': '撤销库存变动', move: '库存变动', layby: 'Layby 登记', 'layby-notified': 'Layby 已通知', 'layby-collected': 'Layby 已取货', layout: '调整地图', 'shelf-size': '货架格数', capacity: '容量设置' };
  function logText(g) {
    const d = g.detail || {};
    switch (g.type) {
      case 'move': return `${d.code} 从「${d.fromLabel}」移到「${d.toLabel}」`;
      case 'add': return `${d.code || d.note} 添加到「${d.toLabel}」`;
      case 'remove': return `${d.code} 从「${d.fromLabel}」删除`;
      case 'note': return `${d.code}（${d.fromLabel}）备注「${d.before || ''}」→「${d.after || ''}」`;
      case 'rename': return `「${d.from}」改名为「${d.to}」`;
      case 'newloc': return `新增位置「${d.toLabel}」`;
      case 'delloc': return `删除位置「${d.fromLabel}」`;
      case 'count': return `清点「${d.scopeLabel}」${d.n} 款，${d.diffs} 款有差异`;
      case 'return': return `${d.code} ${d.size || ''} × ${d.qty} 登记退库（${d.reason}）`;
      case 'return-sent': return d.n ? `${d.n} 条退库标记为已寄出` : `${d.code} ${d.size || ''} × ${d.qty} 已寄出`;
      case 'return-del': return `删除退库记录 ${d.code} × ${d.qty}`;
      case 'import': return `导入 Vend 文件 ${d.file}：${d.n} 款，变化 ${d.changed}，新款 ${d.added}`;
      case 'stock-in': return `导入订货单「${d.source}」：${d.n} 款 +${d.total} 件`;
      case 'stock-out': return `导入退货单「${d.source}」：${d.n} 款 −${d.total} 件`;
      case 'stock-undo': return `撤销「${d.source}」（${d.n} 款）`;
      case 'move': return `${moveMeta(d.kind).zh}：${d.code ? d.code + ' ' : ''}${d.source}，${d.n} 款 ${d.total} 件`;
      case 'layby': return `登记 layby：${d.name} 等 ${d.code}`;
      case 'layby-notified': return `已通知 ${d.name}（${d.code}）`;
      case 'layby-collected': return `${d.name} 已取货（${d.code}）`;
      case 'layout': return `调整了${d.area}布局`;
      case 'shelf-size': return `「${d.name}」改为 ${d.rows} 层 × ${d.cols} 格`;
      case 'capacity': return `货架容量改为 ${d.text}`;
      default: return JSON.stringify(d);
    }
  }
  function logLine(g) {
    return `<div class="small" style="padding:5px 0;border-top:1px solid var(--line)"><span class="pill grey">${esc(LOG_TYPES[g.type] || g.type)}</span> ${esc(logText(g))}<div class="muted">${esc(fmtTime(g.t))} · <b>${esc(g.staff)}</b></div></div>`;
  }
  function viewLog(_, params) {
    const t = params.get('t') || '';
    const list = S.log.filter((g) => !t || g.type === t);
    view(`${backLink()}
      <h1>修改记录</h1>
      <select id="lt"><option value="">全部类型</option>${Object.entries(LOG_TYPES).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <div class="card" style="margin-top:8px">${list.map(logLine).join('') || '<span class="muted small">暂无记录</span>'}</div>
      <div class="small muted">显示最近 500 条。</div>
      <button class="btn small" id="csvLog">⬇️ 下载记录 (CSV)</button>`);
    $('#lt').onchange = (e) => { cur.p = { t: e.target.value }; render(true); };
    $('#csvLog').onclick = () => saveFile(`修改记录_${today()}.csv`, toCSV([['时间', '操作人', '类型', '内容'], ...S.log.map((g) => [fmtTime(g.t), g.staff, LOG_TYPES[g.type] || g.type, logText(g)])]));
  }

  // ---------------------------------------------------------------- more
  function viewMore() {
    view(`<h1>更多</h1>
      <div class="card stack">
        <a class="btn block" ${goAttr('overview')}>📊 库存总览</a>
        <a class="btn block" ${goAttr('docs', '', { t: 'arrival' })}>📥 一键导入到货单</a>
        <a class="btn block" ${goAttr('docs', '', { t: 'return_wh' })}>📤 一键导入退货单</a>
        <a class="btn block" ${goAttr('layby')}>🧾 Layby 客人</a>
        <a class="btn block" ${goAttr('tidy')}>💡 库存容纳整理建议</a>
        <a class="btn block" ${goAttr('import')}>⬆️ 导入 Vend 库存（整体覆盖）</a>
        <a class="btn block" ${goAttr('log')}>🕑 修改记录（谁改了什么）</a></div>
      <div class="card stack"><b>设置</b>
        <label class="field">我的名字（这台设备上的修改会记在这个名字下）<input id="staff" type="text" value="${esc(S.staff)}" placeholder="例如 Rebecca"></label>
        <label class="field">库存偏低提醒：少于等于几件<input id="low" type="number" min="1" value="${S.lowStock}"></label>
        <button class="btn primary" id="saveSet">保存设置</button></div>
      <div class="card small"><b>数据存在哪里？</b><div class="muted" style="margin-top:4px">${LOCAL
        ? '这是网页版（GitHub）：所有数据只存在这台设备的浏览器里，不会和别的手机或 Claude 版同步。换手机前先「下载完整备份」，在新设备上「从备份恢复」。照片很占空间，建议定期删除旧照片。'
        : '货位、清点、退库和修改记录都存在 Claude 里，你的手机和电脑打开都是同一份，改了马上同步。只有正在进行中的清点草稿存在当前设备上。'}</div>
        <div class="row" style="margin-top:8px"><button class="btn small" id="backup">⬇️ 下载完整备份 (JSON)</button>
        ${LOCAL ? '<label class="btn small">⬆️ 从备份恢复<input type="file" id="restore" accept=".json" hidden></label>' : ''}</div></div>`);
    if ($('#restore')) $('#restore').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.store || data.format !== 'ugg-local-v1') throw new Error('不是网页版的备份文件');
        if (!await confirmDlg('用这个备份覆盖这台设备上的所有数据？', '覆盖')) return;
        db.restore(data.store); toast('已恢复');
      } catch (err) { toast('恢复失败：' + (err.message || err)); }
    };
    $('#saveSet').onclick = () => {
      S.staff = $('#staff').value.trim(); lsSet(LS_STAFF, S.staff);
      const low = Math.max(1, parseInt($('#low').value, 10) || 3);
      if (low !== S.lowStock && !S.readOnly) { S.lowStock = low; putMeta(); }
      renderStaff(); toast('已保存');
    };
    $('#backup').onclick = () => LOCAL ? saveFile(`ugg货位备份_${today()}.json`, JSON.stringify({ format: 'ugg-local-v1', at: nowISO(), store: db.dump() })) : saveFile(`ugg货位备份_${today()}.json`, JSON.stringify({ locations: S.locations, products: S.products, unitNames: S.unitNames, returns: S.returns, counts: S.counts, log: S.log, vendImportedAt: S.vendImportedAt }, null, 1));
  }

  // ================================================================ capacity estimate
  // Each storeroom shelf holds h (high) × l (long) × d (deep) big shoe boxes.
  const ACC_PREFIX = /^(ASA|ASZ|EAA|EAZ|TAA|TAZ|URA|URZ|UEZ|BA\d|ABT|AKS|AKG|W\d|LWP|DYS|FLAT|EAZ|UEDECO|11401)/;
  function boxFactor(code) {
    const p = P[code]; const n = (p ? p.name : '').toLowerCase();
    if (ACC_PREFIX.test(code) || /glove|scarf|hat\b|hatband|keyring|bag\b|backpack|beanie|sock|earmuff|towel|insole|purse|charm|cushion|rug|brush|kit|shawl|pouch|cover|wrap|warm pack|case|toy|platypus|koala|kangaroo/.test(n)) return 0.3;
    if (/K$/.test(code) || /kids|baby|bootie/.test(n)) return 0.5;
    if ((S.cap.xl || []).includes(code)) return boxUnit() / (S.cap.xlH * S.cap.l * S.cap.xlD);
    return 1;
  }
  const isShoe = (code) => boxFactor(code) >= 0.5;
  // cap.mode 'cell': every grid cell is one shelf bay of h×l×d boxes (merged cells count per bay they span).
  // cap.mode 'shelf': the whole shelving unit holds h×l×d boxes, split across its cells by area.
  const boxUnit = () => S.cap.h * S.cap.l * S.cap.d;
  const cellCap = (l) => S.cap.mode === 'shelf' ? boxUnit() * ((l.colspan || 1) / (l.cols || 1)) * ((l.rowspan || 1) / (l.rows || 1)) : boxUnit() * (l.colspan || 1) * (l.rowspan || 1);
  const shelfCapOf = (u) => S.cap.mode === 'shelf' ? boxUnit() : S.locations.filter((l) => l.unit === u && l.area === 'storeroom').reduce((a, l) => a + cellCap(l), 0);
  const capText = () => `${S.cap.mode === 'shelf' ? '每个货架' : '每一格'}按 ${S.cap.h} 高 × ${S.cap.l} 长 × ${S.cap.d} 宽 = ${boxUnit()} 个大鞋盒`;
  const roomUnits = () => [...new Set(S.locations.filter((l) => l.area === 'storeroom').map((l) => l.unit))];
  function estimate() {
    const cell = {}, shelf = {}, items = {};
    S.locations.forEach((l) => { if (l.area === 'storeroom') { cell[l.id] = 0; items[l.id] = {}; shelf[l.unit] = shelf[l.unit] || 0; } });
    Object.entries(codeLocs).forEach(([code, ids]) => {
      const p = P[code]; if (!p || p.qty <= 0) return;
      const room = ids.filter((id) => locById[id] && locById[id].area === 'storeroom');
      if (!room.length) return;
      const roomQty = Math.max(0, p.qty - (ids.length - room.length) * S.cap.display);
      const per = roomQty / room.length * boxFactor(code);
      room.forEach((id) => { cell[id] += per; items[id][code] = (items[id][code] || 0) + per; shelf[locById[id].unit] += per; });
    });
    return { cell, shelf, items };
  }
  const fillClass = (pct) => pct >= 1 ? 'bad' : pct >= 0.75 ? 'warn' : 'ok';
  const FILL = { ok: '#e3f2e8', warn: '#fbe7da', bad: '#fbd5d1', hi: '#f2c58f' };

  const STORE_LAYOUT = {"S01":[916,34,103,51],"S02":[798,33,105,51],"S03":[57,53,106,54],"S04":[464,44,117,39],"S05":[322,44,116,39],"S06":[22,58,106,44],"S07":[502,487,128,147],"S08":[465,91,118,71],"S09":[320,91,121,44],"S10":[801,108,113,54],"S11":[163,148,105,53],"S12":[22,187,117,55],"S13":[742,218,127,233],"S14":[20,601,103,102],"S15":[892,481,109,49],"S16":[283,474,163,266],"S17":[373,403,85,72],"S18":[452,475,159,294],"S19":[298,243,96,155],"S20":[755,554,128,144],"S21":[922,535,95,58],"S22":[915,234,110,66],"S23":[1034,391,90,64],"S24":[1034,325,88,60],"S25":[899,325,113,60],"S26":[900,391,115,69],"S27":[1034,464,90,62],"S28":[1035,531,86,68],"S29":[463,404,164,48],"S30":[550,303,155,35],"S31":[553,252,153,45],"S32":[415,303,124,35],"S33":[416,254,120,43],"S34":[146,417,147,81],"S35":[16,260,116,54],"S36":[161,336,106,69],"S37":[163,243,105,80]};
  // ---------------------------------------------------------------- one shelf, front view
  function viewShelf(unit, params) {
    const hi = new Set((params.get('h') || '').split(',').filter(Boolean));
    const est = estimate(), cap = shelfCapOf(unit), used = est.shelf[unit] || 0;
    const cells = S.locations.filter((l) => l.unit === unit && l.area === 'storeroom');
    const rows = [];
    cells.forEach((l) => Object.entries(est.items[l.id] || {}).forEach(([c, b]) => rows.push([c, b, l])));
    rows.sort((a, b) => b[1] - a[1]);
    view(`${backLink('地图')}
      <h1>${esc(unitName(unit))}</h1>
      <div class="card"><div class="row between"><b>估计 ${Math.round(used)} / ${cap} 盒</b><span class="pill ${fillClass(used / cap)}">${Math.round(used / cap * 100)}%</span></div>
        <div class="progress"><div style="width:${Math.min(100, used / cap * 100)}%;background:${used > cap ? 'var(--bad)' : used / cap >= .75 ? 'var(--warn)' : 'var(--ok)'}"></div></div>
        <div class="small muted">正面视图：行 = 表格里的行（从上往下），格 = 从左往右。每格显示估计盒数 / 容量。</div></div>
      ${unitGrid(unit, hi, '', est)}
      <h2>这个货架上的款（按占用排序）</h2>
      <div class="card"><table class="list"><tr><th>款号</th><th>位置</th><th class="num">约几盒</th></tr>
        ${rows.map(([c, b, l]) => `<tr><td><a ${goAttr('product', c)}><span class="code">${esc(c)}</span></a><div class="small muted">${esc(shortName(P[c] ? P[c].name : ''))} · 库存 ${P[c] ? P[c].qty : '—'}</div></td><td class="small">第${l.row + 1}行 第${l.col + 1}格</td><td class="num">${b.toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">没有有库存的款</td></tr>'}</table></div>
      <a class="btn small" ${goAttr('tidy')}>💡 看整理建议</a>`);
    bindCells();
  }

  // ---------------------------------------------------------------- batch locate (查找 tab, 批量定位)
  let searchMode = 'single';
  let batchText = lsGet('ugg-batch') || '';
  function parseCodeList(text) {
    const out = [];
    String(text || '').split(/[\s,，;；、]+/).forEach((t) => {
      const c = resolveCode(t.replace(/[^A-Za-z0-9_]/g, ''));
      if (c && /\d/.test(c) && !out.includes(c)) out.push(c);
    });
    return out;
  }
  function batchResults(codes) {
    const hs = new Set(codes);
    const found = codes.filter((c) => codeLocs[c]);
    const missing = codes.filter((c) => !codeLocs[c]);
    const inRoom = found.filter((c) => codeLocs[c].some((id) => locById[id].area === 'storeroom')).length;
    const inStore = found.filter((c) => codeLocs[c].some((id) => locById[id].area === 'store')).length;
    return `<div class="card"><b>${codes.length} 个款号</b> · 仓库里 ${inRoom} 个 · 店面 ${inStore} 个${missing.length ? ` · <span style="color:var(--bad)">没登记货位 ${missing.length} 个</span>` : ''}
        <div class="row" style="margin-top:8px"><button class="btn primary small" id="batchCount">✅ 用这些款号开始清点</button><button class="btn small" id="batchCopy">📋 复制位置清单</button></div></div>
      <h2>📦 仓库</h2>${mapBox('storeroom', mapSVG('storeroom', hs))}
      <h2>🏬 店面</h2>${mapBox('store', mapSVG('store', hs))}
      <div class="small muted" style="margin:4px 0 10px">橙色 = 有你输入的款号。点方块看详细位置。</div>
      <h2>逐个款号</h2>${codes.map(productCard).join('')}`;
  }
  function bindBatch(codes) {
    bindMap($('#view'), new Set(codes)); bindZoom($('#view'));
    const bc = $('#batchCount');
    if (bc) bc.onclick = async () => {
      if (!await ensureStaff()) return;
      if (S.countDraft && !await confirmDlg('你有一个没完成的清点，要用这些款号替换它吗？', '替换')) return;
      S.countDraft = { id: uid(), scope: 'custom', scopeLabel: `批量定位 ${codes.length} 款`, startedAt: nowISO(), staff: S.staff, lines: codes.map((c) => ({ code: c, counted: '' })) };
      saveDraft(); location.hash = '#count'; stack.length = 0; cur = { n: 'count', a: '', p: {} }; render(true);
    };
    const cp = $('#batchCopy');
    if (cp) cp.onclick = () => copyText(`【货位清单】${today()}\n` + codes.map((c) => `${c} ${shortName(P[c] ? P[c].name : '')}（库存 ${P[c] ? P[c].qty : '—'}）：${(codeLocs[c] || []).map((id) => locLabel(locById[id])).join('、') || '没登记货位'}`).join('\n'));
  }

  // ---------------------------------------------------------------- change storage location (product page helper)
  function moveCode(code, fromId, toId) {
    const l = locById[fromId], d = locById[toId];
    const i = l.items.findIndex((it) => it.code && resolveCode(it.code) === code);
    if (i < 0) return false;
    const [it] = l.items.splice(i, 1);
    d.items.push(it);
    putLoc(l); putLoc(d);
    addLog('move', { code: it.code, from: fromId, fromLabel: locLabel(l), to: toId, toLabel: locLabel(d) });
    rebuildIndex();
    return true;
  }
  function removeCode(code, fromId) {
    const l = locById[fromId];
    const i = l.items.findIndex((it) => it.code && resolveCode(it.code) === code);
    if (i < 0) return false;
    const [it] = l.items.splice(i, 1);
    putLoc(l); addLog('remove', { code: it.code, from: fromId, fromLabel: locLabel(l) });
    rebuildIndex();
    return true;
  }
  function addCode(code, toId) {
    const d = locById[toId];
    d.items.push({ code, note: '' });
    putLoc(d); addLog('add', { code, to: toId, toLabel: locLabel(d) });
    rebuildIndex();
  }

  // ================================================================ tidy suggestions (库存容纳整理建议)
  function emptiestCell(unit, est, planned) {
    const cells = S.locations.filter((l) => l.unit === unit && l.area === 'storeroom');
    return cells.map((l) => ({ l, free: cellCap(l) - (est.cell[l.id] || 0) - (planned[l.id] || 0) })).sort((a, b) => b.free - a.free)[0];
  }
  function viewTidy() {
    const est = estimate(), units = roomUnits();
    const capOf = {}; units.forEach((u) => { capOf[u] = shelfCapOf(u); });
    const planned = {}, shelfPlan = {};
    units.forEach((u) => { shelfPlan[u] = est.shelf[u] || 0; });
    const sug = [];
    const bestShelf = (exclude, need) => units.filter((u) => u !== exclude).map((u) => ({ u, free: capOf[u] - shelfPlan[u] })).filter((x) => x.free >= need).sort((a, b) => b.free - a.free)[0];
    // 1. over-full shelves
    units.forEach((u) => {
      let excess = shelfPlan[u] - capOf[u]; if (excess <= 0) return;
      const items = [];
      S.locations.filter((l) => l.unit === u && l.area === 'storeroom').forEach((l) => Object.entries(est.items[l.id] || {}).forEach(([c, b]) => items.push({ c, b, l })));
      items.sort((a, b) => b.b - a.b);
      for (const it of items) {
        if (excess <= 0) break;
        const t = bestShelf(u, it.b); if (!t) continue;
        const cell = emptiestCell(t.u, est, planned);
        sug.push({ kind: 'over', text: `<b>${esc(unitName(u))}</b> 超出约 ${Math.round(excess)} 盒：把 <span class="code">${esc(it.c)}</span>（约 ${it.b.toFixed(0)} 盒）从「${esc(locLabel(it.l))}」移到「${esc(locLabel(cell.l))}」`, btn: '移过去', run: () => moveCode(it.c, it.l.id, cell.l.id) });
        shelfPlan[u] -= it.b; shelfPlan[t.u] += it.b; planned[cell.l.id] = (planned[cell.l.id] || 0) + it.b; excess -= it.b;
      }
    });
    // 2. zero stock still occupying a location
    S.locations.forEach((l) => l.items.forEach((it) => {
      const c = resolveCode(it.code), p = P[c];
      if (it.code && p && p.qty <= 0) sug.push({ kind: 'zero', text: `<span class="code">${esc(c)}</span> 系统库存 0，还占着「${esc(locLabel(l))}」`, btn: '清出货位', run: () => removeCode(c, l.id) });
    }));
    // 3. shoes with stock but no location
    S.products.filter((p) => p.code && p.qty > 0 && !codeLocs[p.code] && isShoe(p.code)).sort((a, b) => b.qty - a.qty).forEach((p) => {
      const need = p.qty * boxFactor(p.code);
      const t = bestShelf(null, need) || units.map((u) => ({ u, free: capOf[u] - shelfPlan[u] })).sort((a, b) => b.free - a.free)[0];
      if (!t) return;
      const cell = emptiestCell(t.u, est, planned);
      sug.push({ kind: 'noloc', text: `<span class="code">${esc(p.code)}</span> ${esc(shortName(p.name))}（${p.qty} 件，约 ${need.toFixed(0)} 盒）没有货位 → 建议放「${esc(locLabel(cell.l))}」`, btn: '登记到这里', run: () => addCode(p.code, cell.l.id) });
      shelfPlan[t.u] += need; planned[cell.l.id] = (planned[cell.l.id] || 0) + need;
    });
    // 4. same style scattered over several storeroom cells → merge if it fits
    Object.entries(codeLocs).forEach(([c, ids]) => {
      const room = ids.filter((id) => locById[id].area === 'storeroom'); if (room.length < 2 || !P[c] || P[c].qty <= 0) return;
      const total = room.reduce((a, id) => a + ((est.items[id] || {})[c] || 0), 0);
      const target = room.map((id) => ({ id, free: cellCap(locById[id]) - est.cell[id] + ((est.items[id] || {})[c] || 0) })).sort((a, b) => b.free - a.free)[0];
      if (target.free < total) return;
      const others = room.filter((id) => id !== target.id);
      sug.push({ kind: 'merge', text: `<span class="code">${esc(c)}</span> 分散在 ${room.length} 格（共约 ${total.toFixed(0)} 盒），可以合并到「${esc(locLabel(locById[target.id]))}」`, btn: '合并', run: () => others.forEach((id) => moveCode(c, id, target.id)) });
    });
    const empty = S.locations.filter((l) => l.area === 'storeroom' && !l.items.length);
    const accNoLoc = S.products.filter((p) => p.code && p.qty > 0 && !codeLocs[p.code] && !isShoe(p.code)).length;
    const section = (kind, title, desc) => {
      const list = sug.map((x, i) => [x, i]).filter(([x]) => x.kind === kind);
      if (!list.length) return '';
      return `<h2>${title}（${list.length}）</h2><div class="small muted" style="margin-bottom:6px">${desc}</div><div class="card">${list.slice(0, 40).map(([x, i]) => `<div class="item-line"><div class="grow small">${x.text}</div><button class="btn small" data-sug="${i}">${x.btn}</button></div>`).join('')}${list.length > 40 ? `<div class="small muted">还有 ${list.length - 40} 条，先处理上面的。</div>` : ''}</div>`;
    };
    view(`${backLink()}
      <h1>💡 整理建议</h1>
      <div class="card">
        <b>货架容量</b> <span class="small muted">（${capText()}）</span>
        ${units.map((u) => { const v = est.shelf[u] || 0, cap = capOf[u]; return `<div style="margin-top:8px"><div class="row between small"><a ${goAttr('shelf', u)}><b>${esc(unitName(u))}</b></a><span>约 ${Math.round(v)} / ${cap} 盒 · ${Math.round(v / cap * 100)}%</span></div><div class="progress"><div style="width:${Math.min(100, v / cap * 100)}%;background:${v > cap ? 'var(--bad)' : v / cap >= .75 ? 'var(--warn)' : 'var(--ok)'}"></div></div></div>`; }).join('')}
        <div class="small muted" style="margin-top:8px">估算方法：Vend 库存 − 店面每个展位 ${S.cap.display} 件，剩下的平均分到这个款在仓库的格子里；童鞋按 0.5 盒、配饰按 0.3 盒算；特大鞋盒（${esc((S.cap.xl || []).join('/'))}）每格只能放 ${S.cap.xlH} 高 × ${S.cap.xlD} 宽，按 ${(boxUnit() / (S.cap.xlH * S.cap.l * S.cap.xlD)).toFixed(1)} 盒算。只是估计，实际以清点为准。</div>
      </div>
      ${section('over', '🔴 超出容量的货架', '按占用最多的款优先移到最空的货架。')}
      ${section('noloc', '❓ 有库存但没货位的鞋', '按剩余空间最多的货架安排。')}
      ${section('zero', '⚪ 卖完了还占着货位', '清出来的位置可以给新货用。')}
      ${section('merge', '🔗 可以合并的款', '同一款放在一起，找货和清点都更快。')}
      ${!sug.length ? '<div class="empty-state">目前没有需要整理的地方 👍</div>' : ''}
      ${empty.length ? `<h2>空着的格子（${empty.length}）</h2><div class="card">${empty.map((l) => locChip(l.id)).join('')}</div>` : ''}
      ${accNoLoc ? `<p class="small muted">另外有 ${accNoLoc} 个配饰（手套、围巾、钥匙扣等）没有货位，没列在上面。可以在「更多 → 库存总览 → 没货位」查看。</p>` : ''}
      <details class="card"><summary><b>调整容量设置</b></summary>
        <div class="row" style="margin-top:8px">
          <label class="field" style="width:80px">高（盒）<input id="capH" type="number" min="1" value="${S.cap.h}"></label>
          <label class="field" style="width:80px">长（盒）<input id="capL" type="number" min="1" value="${S.cap.l}"></label>
          <label class="field" style="width:80px">宽（盒）<input id="capD" type="number" min="1" value="${S.cap.d}"></label>
          <label class="field" style="width:120px">店面每展位按几件<input id="capS" type="number" min="0" value="${S.cap.display}"></label>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="field grow">特大鞋盒款号（逗号分开）<input id="capX" type="text" value="${esc((S.cap.xl || []).join(', '))}"></label>
          <label class="field" style="width:90px">特大·高<input id="capXH" type="number" min="1" value="${S.cap.xlH}"></label>
          <label class="field" style="width:90px">特大·宽<input id="capXD" type="number" min="1" value="${S.cap.xlD}"></label></div>
        <label class="field" style="margin-top:8px;width:200px">每天建议清点几款<input id="capDaily" type="number" min="1" max="20" value="${S.cap.daily || 8}"></label>
        <label class="field" style="margin-top:8px">这个尺寸是指
          <select id="capM"><option value="cell" ${S.cap.mode !== 'shelf' ? 'selected' : ''}>每一格（表格里的一个格子）</option><option value="shelf" ${S.cap.mode === 'shelf' ? 'selected' : ''}>整个货架（一整张表格）</option></select></label><button class="btn small primary" id="capSave" style="margin-top:8px">保存</button></details>`);
    bindCells();
    $$('[data-sug]').forEach((b) => b.onclick = async () => {
      if (!await ensureStaff()) return;
      sug[Number(b.dataset.sug)].run();
      toast('已完成'); render(false);
    });
    $('#capSave').onclick = async () => {
      if (!await ensureStaff()) return;
      const g = (id, d) => Math.max(0, parseInt($(id).value, 10) || d);
      S.cap = { h: g('#capH', 6) || 6, l: g('#capL', 7) || 7, d: g('#capD', 2) || 2, display: g('#capS', 2), mode: $('#capM').value,
        xl: $('#capX').value.split(/[\s,，]+/).map(norm).filter(Boolean), xlH: g('#capXH', 5) || 5, xlD: g('#capXD', 1) || 1, daily: g('#capDaily', 8) || 8 };
      putMeta(); addLog('capacity', { text: `${S.cap.h}×${S.cap.l}×${S.cap.d}` }); toast('已保存'); render(false);
    };
  }

  // ================================================================ stock movements (4 kinds of stock change)
  // 1 新到货 arrival (+) · 2 卖出 sale (−) / 顾客退货 custreturn (+) / 换货 exchange (±) · 3 退回仓库 return_wh (−) · 4 瑕疵 faulty (−)
  const MOVE = {
    arrival: { zh: '新到货', icon: '📥', sign: 1 },
    sale: { zh: '卖出', icon: '🛍️', sign: -1 },
    custreturn: { zh: '顾客退货', icon: '↩️', sign: 1 },
    exchange: { zh: '换货', icon: '🔁', sign: 0 },
    return_wh: { zh: '退回仓库', icon: '📤', sign: -1 },
    faulty: { zh: '瑕疵品', icon: '⚠️', sign: -1 },
    order: { zh: '新到货', icon: '📥', sign: 1 },
    return: { zh: '退回仓库', icon: '📤', sign: -1 },
  };
  const moveMeta = (t) => MOVE[t] || { zh: t, icon: '•', sign: 0 };
  const lineDelta = (r, x) => x.delta != null ? x.delta : moveMeta(r.type).sign * x.qty;
  function applyMove(type, lines, source, note, extra) {
    const rec = Object.assign({ id: uid(), type, date: nowISO(), staff: S.staff, source: source || '手动登记', note: note || '', lines: [], undone: false }, extra || {});
    lines.forEach((x) => {
      let p = P[x.code];
      if (!p) {
        if (x.delta < 0) return;
        p = { code: x.code, name: x.name || x.code, qty: 0, lastReceived: '' };
        S.products.push(p); P[x.code] = p;
      }
      const before = p.qty;
      p.qty = before + x.delta;
      if (type === 'arrival') p.lastReceived = fmtTime(nowISO());
      rec.lines.push({ code: x.code, qty: x.qty, delta: x.delta, size: x.size || '', before, after: p.qty });
    });
    if (!rec.lines.length) return null;
    S.imports.unshift(rec); putImport(rec); putProducts();
    addLog('move', { kind: type, source: rec.source, n: rec.lines.length, total: rec.lines.reduce((a, x) => a + Math.abs(x.delta), 0), code: rec.lines.length === 1 ? rec.lines[0].code : undefined });
    rebuildIndex();
    if (type === 'arrival') setTimeout(() => notifyLaybyArrivals(rec.lines.map((x) => x.code)), 2700);
    return rec;
  }
  function undoMove(r) {
    r.lines.forEach((x) => { const p = P[x.code]; if (p) p.qty -= lineDelta(r, x); });
    r.undone = true; putImport(r); putProducts();
    addLog('stock-undo', { source: r.source || moveMeta(r.type).zh, n: r.lines.length });
    rebuildIndex();
  }
  const isArrival = (r) => (r.type === 'arrival' || r.type === 'order') && !r.undone;
  const arrivalsOn = (date) => S.imports.filter((r) => isArrival(r) && fmtTime(r.date).slice(0, 10) === date);
  function moveCard(r) {
    const m = moveMeta(r.type);
    return `<div class="card"><div class="row between"><div><b>${m.icon} ${esc(m.zh)}</b> <span class="small">${esc(r.source || '')}</span>
        <div class="small muted">${esc(fmtTime(r.date))} · ${esc(r.staff)} · ${r.lines.length} 款${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        ${r.undone ? '<span class="pill grey">已撤销</span>' : `<button class="btn small danger" data-undo="${esc(r.id)}">撤销</button>`}</div>
      <table class="list small" style="margin-top:4px">${r.lines.slice(0, 12).map((x) => { const d = lineDelta(r, x); return `<tr><td><a ${goAttr('product', x.code)} class="code">${esc(x.code)}</a> ${esc(x.size || '')}</td><td class="num"><b style="color:${d < 0 ? 'var(--bad)' : 'var(--ok)'}">${d > 0 ? '+' : ''}${d}</b></td><td class="num muted">${x.before} → ${x.after}</td></tr>`; }).join('')}
      ${r.lines.length > 12 ? `<tr><td colspan="3" class="muted">…还有 ${r.lines.length - 12} 款</td></tr>` : ''}</table></div>`;
  }
  function bindUndo() {
    $$('[data-undo]').forEach((b) => b.onclick = async () => {
      const r = S.imports.find((x) => x.id === b.dataset.undo);
      if (!r || !await ensureStaff() || !await confirmDlg(`撤销这次「${moveMeta(r.type).zh}」？库存会恢复回去。`, '撤销')) return;
      undoMove(r); toast('已撤销'); render(false);
    });
  }
  function codeHint(input, out) {
    const upd = () => {
      const c = resolveCode(input.value), p = P[c];
      out.innerHTML = !input.value ? '' : p ? `✔ ${esc(p.name)} · 库存 <b>${p.qty}</b>${codeLocs[c] ? ' · ' + codeLocs[c].map((id) => esc(locLabel(locById[id]))).join('、') : ''}` : '⚠️ 库存表里没有这个款号';
    };
    input.addEventListener('input', upd); upd();
  }

  // ---------------------------------------------------------------- 库存 tab (stock hub)
  let moveType = '', saleMode = 'sale', retMode = 'now';
  function viewStockHub() {
    const pend = S.returns.filter((r) => r.status === 'pending').length;
    const waiting = S.laybys.filter((l) => l.status === 'waiting').length;
    const btn = (t, n, label, sub) => `<button class="typebtn ${moveType === t ? 'on' : ''}" data-mt="${t}"><span class="n">${n}</span><b>${label}</b><span class="small muted">${sub}</span></button>`;
    let form = '';
    if (moveType) {
      const codeRow = (id, label) => `<label class="field">${label}<input id="${id}" type="text" autocapitalize="characters" placeholder="例如 AS2115"></label><div id="${id}H" class="small muted"></div>`;
      const common = `<div class="row"><label class="field grow">尺码 / 颜色<input id="mSize" type="text" placeholder="例如 38 CHOC"></label><label class="field" style="width:90px">数量<input id="mQty" type="number" min="1" value="1" inputmode="numeric"></label></div>`;
      if (moveType === 'arrival') form = `${codeRow('mCode', '款号')}${common}<div class="small muted">很多款一起到货时，用上面的「一键导入到货单文件」更快。</div>`;
      if (moveType === 'sale') form = `<div class="seg"><button data-sm="sale" class="${saleMode === 'sale' ? 'on' : ''}">卖出（−）</button><button data-sm="custreturn" class="${saleMode === 'custreturn' ? 'on' : ''}">顾客退货（+）</button><button data-sm="exchange" class="${saleMode === 'exchange' ? 'on' : ''}">换货</button></div>
        ${saleMode === 'exchange' ? `${codeRow('mCode', '顾客退回来的款（库存 +1）')}<label class="field">尺码<input id="mSize" type="text"></label>${codeRow('mCode2', '顾客换走的款（库存 −1）')}<label class="field">尺码<input id="mSize2" type="text"></label>` : codeRow('mCode', '款号') + common}
        <div class="small muted">Vend 会自动记录销售；这里适合在下次导入 Vend 报表前，先让库存数字及时准确。</div>`;
      if (moveType === 'return_wh') form = `${codeRow('mCode', '款号')}${common}
        <label class="field">原因<select id="mReason">${RETURN_REASONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
        <div class="seg"><button data-rm="now" class="${retMode === 'now' ? 'on' : ''}">已经寄出（马上减库存）</button><button data-rm="later" class="${retMode === 'later' ? 'on' : ''}">还没寄，先放待退清单</button></div>`;
      if (moveType === 'faulty') form = `${codeRow('mCode', '款号')}${common}
        <label class="field">瑕疵说明<input id="mNote" type="text" placeholder="例如 鞋面污渍、开胶"></label>
        <label class="row small"><input type="checkbox" id="mToRet" checked style="width:auto"> 同时加入待退清单（之后寄回仓库）</label>`;
      form = `<div class="card stack"><b>${moveMeta(moveType === 'sale' ? saleMode : moveType).icon} ${esc(moveMeta(moveType === 'sale' ? saleMode : moveType).zh)}</b>${form}
        ${moveType !== 'sale' || saleMode !== 'exchange' ? '<label class="field">备注<input id="mNote2" type="text" placeholder="可不填"></label>' : ''}
        <button class="btn primary" id="mGo">✔ 确认</button></div>`;
    }
    view(`<h1>库存变动</h1>
      <div class="typegrid">
        ${btn('arrival', '1', '📥 新到货', '库存 +')}
        ${btn('sale', '2', '🛍️ 卖出 / 退换货', '− / +')}
        ${btn('return_wh', '3', '📤 退回仓库', '库存 −')}
        ${btn('faulty', '4', '⚠️ 瑕疵品', '库存 −')}
      </div>
      ${form}
      <div class="card stack">
        <a class="btn block primary" ${goAttr('docs', '', { t: 'arrival' })}>📥 一键导入到货单文件</a>
        <a class="btn block" ${goAttr('docs', '', { t: 'return_wh' })}>📤 一键导入退货单文件</a>
        <div class="small muted">Excel / CSV / 粘贴文字，自动识别款号和数量，确认后马上更新库存。</div>
      </div>
      <div class="row">
        <a class="btn small" ${goAttr('returns')}>📦 待退清单 ${pend}</a>
        <a class="btn small" ${goAttr('layby')}>🧾 Layby 等货 ${waiting}</a>
        <a class="btn small" ${goAttr('overview')}>📊 库存总览</a>
        <a class="btn small" ${goAttr('import')}>⬆️ 导入 Vend 报表</a>
      </div>
      <h2>最近的库存变动</h2>
      ${S.imports.slice(0, 15).map(moveCard).join('') || '<div class="muted small">还没有记录</div>'}`);
    $$('[data-mt]').forEach((b) => b.onclick = () => { moveType = moveType === b.dataset.mt ? '' : b.dataset.mt; render(false); });
    $$('[data-sm]').forEach((b) => b.onclick = () => { saleMode = b.dataset.sm; render(false); });
    $$('[data-rm]').forEach((b) => b.onclick = () => { retMode = b.dataset.rm; render(false); });
    if ($('#mCode')) codeHint($('#mCode'), $('#mCodeH'));
    if ($('#mCode2')) codeHint($('#mCode2'), $('#mCode2H'));
    bindUndo();
    if ($('#mGo')) $('#mGo').onclick = async () => {
      const code = resolveCode($('#mCode').value);
      if (!code) { toast('请输入款号'); return; }
      const qty = $('#mQty') ? parseInt($('#mQty').value, 10) : 1;
      if (!(qty > 0)) { toast('数量要大于 0'); return; }
      if (!await ensureStaff()) return;
      const size = $('#mSize') ? $('#mSize').value.trim() : '';
      const note = ($('#mNote2') && $('#mNote2').value.trim()) || ($('#mNote') && $('#mNote').value.trim()) || '';
      let rec = null;
      if (moveType === 'arrival') rec = applyMove('arrival', [{ code, qty, delta: qty, size }], '手动登记', note);
      else if (moveType === 'sale' && saleMode === 'exchange') {
        const code2 = resolveCode($('#mCode2').value);
        if (!code2) { toast('请输入顾客换走的款号'); return; }
        rec = applyMove('exchange', [{ code, qty: 1, delta: 1, size }, { code: code2, qty: 1, delta: -1, size: $('#mSize2').value.trim() }], '手动登记', note);
      } else if (moveType === 'sale') rec = applyMove(saleMode, [{ code, qty, delta: saleMode === 'sale' ? -qty : qty, size }], '手动登记', note);
      else if (moveType === 'return_wh') {
        const reason = $('#mReason').value;
        if (retMode === 'later') {
          const p = P[code];
          const r = { id: uid(), date: nowISO(), staff: S.staff, code, name: p ? p.name : '', size, qty, reason, note, status: 'pending' };
          S.returns.unshift(r); putReturn(r); addLog('return', { code, qty, size, reason });
          toast('已加入待退清单（寄出时再减库存）'); moveType = ''; render(false); return;
        }
        rec = applyMove('return_wh', [{ code, qty, delta: -qty, size }], '手动登记', [reason, note].filter(Boolean).join('，'));
      } else if (moveType === 'faulty') {
        rec = applyMove('faulty', [{ code, qty, delta: -qty, size }], '手动登记', note);
        if (rec && $('#mToRet').checked) {
          const p = P[code];
          const r = { id: uid(), date: nowISO(), staff: S.staff, code, name: p ? p.name : '', size, qty, reason: '质量问题 / 瑕疵', note, status: 'pending', stockApplied: true };
          S.returns.unshift(r); putReturn(r);
        }
      }
      if (!rec) { toast('没有更新：库存表里没有这个款号'); return; }
      const ln = rec.lines.map((x) => `${x.code} ${x.before}→${x.after}`).join('，');
      toast('已更新：' + ln); moveType = ''; render(false);
    };
  }

  // ---------------------------------------------------------------- 到货单 / 退货单 file import
  let docType = 'arrival', docPreview = null, docPaste = '';
  const CODE_HDR = /^(tag|tags|sku|code|style|style ?(code|no\.?|number)|item ?code|product ?(code|sku)|article|款号|货号|款式编号|商品编号|编号)$/i;
  const QTY_HDR = /(qty|quantity|数量|件数|units|received|ordered|order qty|count|pairs|双数|退货数|到货数|订货数)/i;
  const NAME_HDR = /^(product|name|description|item|品名|名称|商品名称|产品)$/i;
  const SIZE_HDR = /(size|尺码|码数)/i;
  const looksLikeCode = (v) => { const c = norm(v); return !!c && (P[resolveCode(c)] !== undefined || /^[A-Z_]{0,6}\d{3,7}[A-Z]?$/.test(c)); };
  function parseDocRows(rows) {
    let h = -1, cols = {};
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const r = rows[i].map((x) => String(x).trim());
      const c = r.findIndex((x) => CODE_HDR.test(x)), q = r.findIndex((x) => QTY_HDR.test(x));
      if (c >= 0 && q >= 0) { h = i; cols = { c, q, n: r.findIndex((x) => NAME_HDR.test(x)), s: r.findIndex((x) => SIZE_HDR.test(x)) }; break; }
    }
    const lines = [];
    if (h >= 0) {
      rows.slice(h + 1).forEach((r) => {
        const code = norm(r[cols.c]), qty = parseInt(r[cols.q], 10);
        if (!code || !(qty > 0)) return;
        lines.push({ code, qty, name: cols.n >= 0 ? String(r[cols.n]).trim() : '', size: cols.s >= 0 ? String(r[cols.s]).trim() : '' });
      });
      return lines;
    }
    rows.forEach((r) => {
      const ci = r.findIndex(looksLikeCode); if (ci < 0) return;
      const nums = r.slice(ci + 1).map((x) => String(x).trim()).filter((x) => /^\d{1,4}$/.test(x)).map(Number).filter((n) => n > 0);
      lines.push({ code: norm(r[ci]), qty: nums.length ? nums[nums.length - 1] : 1, name: '', size: '' });
    });
    return lines;
  }
  function parsePasted(text) {
    return String(text || '').split(/\n+/).map((line) => line.trim().split(/[\s,，\t×xX*]+/).filter(Boolean)).filter((t) => t.length).map((t) => {
      const ci = t.findIndex(looksLikeCode); if (ci < 0) return null;
      const nums = t.slice(ci + 1).filter((x) => /^\d{1,4}$/.test(x)).map(Number);
      return { code: norm(t[ci]), qty: nums.length ? nums[nums.length - 1] : 1, size: nums.length > 1 ? String(nums[0]) : '', name: '' };
    }).filter(Boolean);
  }
  function buildPreview(raw, source) {
    const agg = {};
    raw.forEach((x) => {
      const code = resolveCode(x.code);
      const a = agg[code] = agg[code] || { code, qty: 0, sizes: [], name: x.name };
      a.qty += x.qty; if (x.size) a.sizes.push(x.size + '×' + x.qty);
    });
    const sign = moveMeta(docType).sign;
    const lines = Object.values(agg).map((a) => {
      const p = P[a.code];
      return Object.assign(a, { known: !!p, name: p ? p.name : a.name, before: p ? p.qty : 0, after: (p ? p.qty : 0) + sign * a.qty });
    });
    return { type: docType, source, lines, raw };
  }
  function viewDocs(_, params) {
    if (params.get('t')) { docType = params.get('t'); cur.p = {}; }
    const isIn = docType === 'arrival';
    const pv = docPreview && docPreview.type === docType ? docPreview : null;
    const hist = S.imports.filter((r) => isIn ? (r.type === 'arrival' || r.type === 'order') : (r.type === 'return_wh' || r.type === 'return'));
    view(`${backLink()}
      <h1>${isIn ? '📥 导入到货单' : '📤 导入退货单'}</h1>
      <div class="seg">
        <button data-d="arrival" class="${isIn ? 'on' : ''}">📥 到货单（库存 +）</button>
        <button data-d="return_wh" class="${!isIn ? 'on' : ''}">📤 退货单（库存 −）</button>
      </div>
      <div class="card stack">
        <div class="small muted">${isIn ? '货到店、点完数之后导入：每个款的库存加上单子上的数量；新款会自动加入库存表；有 layby 客人在等的款会提醒你。' : '货寄回仓库之后导入：每个款的库存减去单子上的数量。'}
          支持 Excel / CSV（自动找“款号/SKU/Tag”和“数量/Qty”两列），也可以直接粘贴文字。</div>
        <label class="field">选择文件<input type="file" id="docFile" accept=".xlsx,.xls,.csv"></label>
        <label class="field">或者粘贴（每行：款号 数量，或 款号 尺码 数量）
          <textarea id="docPaste" rows="4" placeholder="AS2115 3&#10;EA7100 38 2&#10;15801 5">${esc(docPaste)}</textarea></label>
        <button class="btn" id="docParse">读取粘贴内容</button>
      </div>
      ${pv ? `<h2>预览：${esc(pv.source)}</h2>
        <div class="card"><table class="list"><tr><th>款号</th><th class="num">${isIn ? '+' : '−'}数量</th><th class="num">库存变化</th></tr>
          ${pv.lines.map((x) => `<tr><td><span class="code">${esc(x.code)}</span><div class="small muted">${esc(shortName(x.name)) || ''}${x.sizes.length ? ' · ' + esc(x.sizes.join(' ')) : ''}</div>
            ${!x.known ? `<div class="small" style="color:var(--warn)">${isIn ? '新款：会加入库存表' : '库存表里没有，会跳过'}</div>` : ''}</td>
            <td class="num"><b>${x.qty}</b></td><td class="num">${x.known || isIn ? `${x.before} → <b style="color:${x.after < 0 ? 'var(--bad)' : 'inherit'}">${x.after}</b>` : '—'}</td></tr>`).join('')}
        </table>
        <div class="small muted" style="margin-top:6px">共 ${pv.lines.length} 款，${pv.lines.reduce((a, x) => a + x.qty, 0)} 件。${pv.lines.some((x) => x.known && x.after < 0) ? '<span style="color:var(--bad)">有款会变成负数，请核对。</span>' : ''}</div></div>
        <div class="row"><button class="btn" id="docClear">取消</button><button class="btn primary grow" id="docApply">✔ 确认，${isIn ? '加入' : '扣减'}库存</button></div>` : ''}
      <h2>已导入的${isIn ? '到货单' : '退货单'}</h2>
      ${hist.slice(0, 20).map(moveCard).join('') || '<div class="muted small">还没有导入过</div>'}
      <p class="small muted">提示：导入 Vend 报表时，库存会以 Vend 的数字为准重新覆盖。</p>`);
    $$('.seg button').forEach((b) => b.onclick = () => {
      docType = b.dataset.d;
      if (docPreview) docPreview = buildPreview(docPreview.raw, docPreview.source);
      render(false);
    });
    $('#docPaste').addEventListener('input', (e) => { docPaste = e.target.value; });
    $('#docParse').onclick = () => {
      const raw = parsePasted($('#docPaste').value);
      if (!raw.length) { toast('没读到款号，请检查格式：款号 数量'); return; }
      docPreview = buildPreview(raw, '粘贴 ' + today()); render(false);
    };
    $('#docFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!window.XLSX) { toast('表格读取组件还没加载完，请稍等再试'); return; }
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        let raw = [];
        wb.SheetNames.forEach((n) => { if (!raw.length) raw = parseDocRows(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' })); });
        if (!raw.length) throw new Error('没找到款号和数量，请确认表格里有“款号/SKU”和“数量/Qty”列');
        docPreview = buildPreview(raw, f.name); render(false);
      } catch (err) { toast('读取失败：' + err.message); }
    };
    if ($('#docClear')) $('#docClear').onclick = () => { docPreview = null; render(false); };
    if ($('#docApply')) $('#docApply').onclick = async () => {
      if (!await ensureStaff()) return;
      const sign = moveMeta(docType).sign;
      const rec = applyMove(docType, pv.lines.map((x) => ({ code: x.code, qty: x.qty, delta: sign * x.qty, size: x.sizes.join(' '), name: x.name })), pv.source, '');
      if (!rec) { toast('没有可以更新的款'); return; }
      docPreview = null; docPaste = '';
      toast(`已更新 ${rec.lines.length} 款库存`);
      render(true);
    };
    bindUndo();
  }

  // ================================================================ Layby
  const putLayby = (l) => write('laybys/' + l.id, () => db.doc('laybys/' + l.id).set(strip(l)));
  const delLayby = (id) => write('laybys/' + id, () => db.doc('laybys/' + id).delete());
  const laybyReady = (l) => l.status === 'waiting' && P[l.code] && P[l.code].qty > 0;
  function notifyLaybyArrivals(codes) {
    const n = S.laybys.filter((l) => l.status === 'waiting' && codes.includes(l.code)).length;
    if (n) toast(`🧾 有 ${n} 位 layby 客人等的货到了，记得通知`);
  }
  function laybyMsg(l) {
    return `您好 ${l.name}，您预留的 ${l.code}${l.size ? ' ' + l.size + ' 码' : ''} 已经到店，欢迎随时来取。\nHi ${l.name}, your layby item ${l.code}${l.size ? ' (size ' + l.size + ')' : ''} has arrived. You're welcome to pick it up any time.`;
  }
  let laybyFilter = 'waiting';
  function viewLayby() {
    const arrivedToday = new Set(arrivalsOn(today()).flatMap((r) => r.lines.map((x) => x.code)));
    const list = S.laybys.filter((l) => laybyFilter === 'all' || l.status === laybyFilter);
    const ST = { waiting: '等货中', notified: '已通知', collected: '已取货' };
    view(`${backLink()}
      <h1>🧾 Layby 客人</h1>
      <div class="card stack"><b>登记一位 layby 客人</b>
        <div class="row"><label class="field grow">名字<input id="lyName" type="text"></label><label class="field grow">电话<input id="lyPhone" type="tel" inputmode="tel"></label></div>
        <label class="field">款号<input id="lyCode" type="text" autocapitalize="characters" placeholder="例如 AS2115"></label><div id="lyCodeH" class="small muted"></div>
        <div class="row"><label class="field grow">尺码 / 颜色<input id="lySize" type="text"></label><label class="field" style="width:90px">数量<input id="lyQty" type="number" min="1" value="1"></label></div>
        <label class="field">备注<input id="lyNote" type="text" placeholder="例如 已付订金 $50"></label>
        <button class="btn primary" id="lyAdd">＋ 登记</button></div>
      <div class="seg">
        <button data-lf="waiting" class="${laybyFilter === 'waiting' ? 'on' : ''}">等货中 (${S.laybys.filter((l) => l.status === 'waiting').length})</button>
        <button data-lf="notified" class="${laybyFilter === 'notified' ? 'on' : ''}">已通知</button>
        <button data-lf="collected" class="${laybyFilter === 'collected' ? 'on' : ''}">已取货</button>
        <button data-lf="all" class="${laybyFilter === 'all' ? 'on' : ''}">全部</button></div>
      ${list.map((l) => `<div class="card">
        <div class="row between"><div><b>${esc(l.name)}</b> <span class="small">${esc(l.phone || '')}</span>
          <div><a ${goAttr('product', l.code)} class="code">${esc(l.code)}</a> ${esc(l.size || '')} × ${l.qty || 1} <span class="small muted">${esc(shortName(P[l.code] ? P[l.code].name : ''))}</span></div>
          <div class="small muted">${esc(fmtTime(l.createdAt))} · ${esc(l.staff)}${l.note ? ' · ' + esc(l.note) : ''}${l.notifiedAt ? '<br>通知于 ' + esc(fmtTime(l.notifiedAt)) + ' · ' + esc(l.notifiedBy) : ''}</div></div>
          <span class="pill ${l.status === 'waiting' ? (arrivedToday.has(l.code) || laybyReady(l) ? 'warn' : 'grey') : l.status === 'notified' ? 'ok' : 'grey'}">${l.status === 'waiting' && arrivedToday.has(l.code) ? '今天到货了！' : l.status === 'waiting' && laybyReady(l) ? '有库存' : ST[l.status]}</span></div>
        <div class="row" style="margin-top:6px">
          ${l.status === 'waiting' ? `<button class="btn small" data-lymsg="${esc(l.id)}">📋 复制通知短信</button><button class="btn small primary" data-lyn="${esc(l.id)}">已通知</button>` : ''}
          ${l.status === 'notified' ? `<button class="btn small primary" data-lyc="${esc(l.id)}">已取货</button>` : ''}
          <button class="btn small danger" data-lyd="${esc(l.id)}">删除</button></div></div>`).join('') || '<div class="empty-state">没有记录</div>'}
      <p class="small muted">客人的名字和电话会保存在这个应用里，能打开这个页面的人都能看到。</p>`);
    codeHint($('#lyCode'), $('#lyCodeH'));
    $$('[data-lf]').forEach((b) => b.onclick = () => { laybyFilter = b.dataset.lf; render(false); });
    $('#lyAdd').onclick = async () => {
      const name = $('#lyName').value.trim(), code = resolveCode($('#lyCode').value);
      if (!name || !code) { toast('请填写名字和款号'); return; }
      if (!await ensureStaff()) return;
      const l = { id: uid(), name, phone: $('#lyPhone').value.trim(), code, size: $('#lySize').value.trim(), qty: parseInt($('#lyQty').value, 10) || 1, note: $('#lyNote').value.trim(), status: 'waiting', createdAt: nowISO(), staff: S.staff };
      S.laybys.unshift(l); putLayby(l); addLog('layby', { code, name });
      toast('已登记'); render(false);
    };
    const find = (id) => S.laybys.find((x) => x.id === id);
    $$('[data-lymsg]').forEach((b) => b.onclick = () => copyText(laybyMsg(find(b.dataset.lymsg)), true));
    $$('[data-lyn]').forEach((b) => b.onclick = async () => { if (!await ensureStaff()) return; const l = find(b.dataset.lyn); l.status = 'notified'; l.notifiedAt = nowISO(); l.notifiedBy = S.staff; putLayby(l); addLog('layby-notified', { code: l.code, name: l.name }); render(false); });
    $$('[data-lyc]').forEach((b) => b.onclick = async () => { if (!await ensureStaff()) return; const l = find(b.dataset.lyc); l.status = 'collected'; l.collectedAt = nowISO(); putLayby(l); addLog('layby-collected', { code: l.code, name: l.name }); render(false); });
    $$('[data-lyd]').forEach((b) => b.onclick = async () => { if (!await ensureStaff() || !await confirmDlg('删除这条 layby 记录？', '删除')) return; const id = b.dataset.lyd; S.laybys = S.laybys.filter((x) => x.id !== id); delLayby(id); render(false); });
  }

  // ================================================================ 今日 tab: daily workflow
  // daily: receipt photo, store/storeroom photos, count 6–8 styles, cleaning, tidy storeroom
  // Mon/Wed/Fri: receive goods, notify laybys, display new arrivals, price tags · Mon: stationery · Wed: shopping bags
  const TASKS = [
    { id: 'receipt', zh: '打开早小票，拍照', photo: true },
    { id: 'storephoto', zh: '拍店铺照片', photo: true },
    { id: 'roomphoto', zh: '拍仓库照片', photo: true },
    { id: 'count', zh: '清点 6–8 款货物', auto: 'count' },
    { id: 'receive', zh: '收货，导入到货单', days: [1, 3, 5], auto: 'arrival', go: ['docs', '', { t: 'arrival' }] },
    { id: 'layby', zh: '到货后通知 layby 客人', days: [1, 3, 5], go: ['layby'] },
    { id: 'display', zh: '展示新到的货品', days: [1, 3, 5] },
    { id: 'tags', zh: '打价格标签', days: [1, 3, 5] },
    { id: 'dust', zh: '打扫展示台灰尘' },
    { id: 'floor', zh: '打扫地面' },
    { id: 'vacuum', zh: '吸尘地毯' },
    { id: 'tidyroom', zh: '整理仓库', go: ['tidy'] },
    { id: 'stationery', zh: '订文具', days: [1] },
    { id: 'bags', zh: '订购物袋', days: [3] },
  ];
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  let dayView = today(), dayUnsubs = [], daySubDate = '';
  S.dayTasks = {}; S.dayPhotos = [];
  const putPhoto = (ph) => write('photos/' + ph.id, () => db.doc('photos/' + ph.id).set(strip(ph)));
  const delPhoto = (id) => write('photos/' + id, () => db.doc('photos/' + id).delete());
  function subscribeDay(date) {
    if (!db || daySubDate === date) return;
    dayUnsubs.forEach((f) => { try { f(); } catch (e) { /* already closed */ } });
    dayUnsubs = []; daySubDate = date; S.dayTasks = {}; S.dayPhotos = [];
    dayUnsubs.push(db.doc('tasks/' + date).onSnapshot((snap) => {
      S.dayTasks = snap.exists ? JSON.parse(JSON.stringify((snap.data() || {}).done || {})) : {};
      scheduleRender();
    }, (e) => console.error(e)));
    dayUnsubs.push(db.collection('photos').where('date', '==', date).onSnapshot((snap) => {
      S.dayPhotos = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data())))).sort((a, b) => a.at < b.at ? -1 : 1);
      scheduleRender();
    }, (e) => console.error(e)));
  }
  const dateAdd = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return fmtTime(x.toISOString()).slice(0, 10); };
  function tasksFor(date) {
    const wd = new Date(date + 'T12:00:00').getDay();
    return TASKS.filter((t) => !t.days || t.days.includes(wd));
  }
  function taskAutoDone(t, date) {
    if (t.auto === 'count') return S.counts.some((c) => fmtTime(c.date).slice(0, 10) === date);
    if (t.auto === 'arrival') return arrivalsOn(date).length > 0;
    return false;
  }
  function lastCountedMap() {
    const m = {};
    S.counts.forEach((c) => c.lines.forEach((x) => { if (!m[x.code] || m[x.code] < c.date) m[x.code] = c.date; }));
    return m;
  }
  function suggestDailyCount() {
    const n = S.cap.daily || 8, last = lastCountedMap();
    return S.products.filter((p) => p.code && p.qty > 0 && codeLocs[p.code] && isShoe(p.code))
      .sort((a, b) => (last[a.code] || '').localeCompare(last[b.code] || '') || b.qty - a.qty)
      .slice(0, n).map((p) => p.code);
  }
  async function compressImage(file) {
    let img;
    try { img = await createImageBitmap(file); }
    catch (e) {
      img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const scale = Math.min(1, (LOCAL ? 700 : 1100) / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let q = 0.72, url = c.toDataURL('image/jpeg', q);
    const limit = LOCAL ? 70000 : 220000;
    while (url.length > limit && q > 0.25) { q -= 0.12; url = c.toDataURL('image/jpeg', q); }
    if (url.length > 240000) { c.width = Math.round(c.width * 0.6); c.height = Math.round(c.height * 0.6); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); url = c.toDataURL('image/jpeg', 0.5); }
    return url;
  }
  function setTaskDone(id, done) {
    const d = Object.assign({}, S.dayTasks);
    if (done) d[id] = { by: S.staff, at: nowISO() }; else delete d[id];
    S.dayTasks = d;
    const date = dayView;
    write('tasks/' + date, () => db.doc('tasks/' + date).set({ date, done: d }));
  }
  function viewToday() {
    subscribeDay(dayView);
    const date = dayView, wd = new Date(date + 'T12:00:00').getDay();
    const list = tasksFor(date);
    const isDone = (t) => !!S.dayTasks[t.id] || taskAutoDone(t, date);
    const doneN = list.filter(isDone).length;
    const arrivals = arrivalsOn(date);
    const arrivedCodes = [...new Set(arrivals.flatMap((r) => r.lines.map((x) => x.code)))];
    const lyWaiting = S.laybys.filter((l) => l.status === 'waiting' && (arrivedCodes.includes(l.code) || laybyReady(l)));
    const sugg = suggestDailyCount();
    const isToday = date === today();
    view(`<div class="row between"><button class="btn small" id="dPrev">‹</button>
        <div style="text-align:center"><b style="font-size:18px">${esc(date)} ${WEEK[wd]}</b>${isToday ? '<div class="small muted">今天</div>' : `<div><button class="linkish" id="dToday">回到今天</button></div>`}</div>
        <button class="btn small" id="dNext" ${isToday ? 'disabled' : ''}>›</button></div>
      <div class="progress" style="margin:10px 0 4px"><div style="width:${list.length ? doneN / list.length * 100 : 0}%"></div></div>
      <div class="small muted" style="margin-bottom:10px">完成 ${doneN} / ${list.length} 项${[1, 3, 5].includes(wd) ? ' · 今天是收货日' : ''}</div>
      <div class="card">
        ${list.map((t) => {
          const d = S.dayTasks[t.id], auto = taskAutoDone(t, date), done = !!d || auto;
          const photos = S.dayPhotos.filter((p) => p.task === t.id);
          return `<div class="task ${done ? 'done' : ''}">
            <button class="chk" data-task="${t.id}" aria-label="完成">${done ? '✓' : ''}</button>
            <div class="grow"><div class="tname">${esc(t.zh)}</div>
              <div class="small muted">${d ? esc(d.by) + ' · ' + esc(fmtTime(d.at).slice(11)) : auto ? '已自动完成' : ''}${t.days ? ` · <span class="pill grey">${t.days.map((x) => WEEK[x]).join('/')}</span>` : ''}</div>
              ${t.photo ? `<div class="thumbs">${photos.map((p) => `<img src="${p.data}" data-ph="${esc(p.id)}" alt="">`).join('')}
                <label class="btn small">📷 拍照<input type="file" accept="image/*" capture="environment" data-up="${t.id}" hidden></label></div>` : ''}
              ${t.id === 'count' && !auto ? `<div class="small" style="margin-top:4px">今天建议清点：${sugg.map((c) => `<span class="code">${esc(c)}</span>`).join(' ')}</div><button class="btn small primary" id="dCount" style="margin-top:4px">开始清点这 ${sugg.length} 款</button>` : ''}
              ${t.go ? `<a class="btn small" style="margin-top:4px" ${goAttr(...t.go)}>打开 ›</a>` : ''}
              ${t.id === 'layby' && lyWaiting.length ? `<div class="small" style="color:var(--warn);margin-top:4px">有 ${lyWaiting.length} 位客人的货可能到了</div>` : ''}
            </div></div>`;
        }).join('')}
      </div>
      ${arrivals.length ? `<h2>📥 ${isToday ? '今天' : '当天'}到货（展示新品、打价格标签用）</h2>
        <div class="card">${arrivedCodes.map((c) => `<div class="item-line"><div class="grow"><a ${goAttr('product', c)} class="code">${esc(c)}</a> <span class="small muted">${esc(shortName(P[c] ? P[c].name : ''))}</span>
            <div class="small">${(codeLocs[c] || []).map((id) => esc(locLabel(locById[id]))).join(' · ') || '<span style="color:var(--bad)">没货位</span>'}</div></div>
          <b>+${arrivals.reduce((a, r) => a + r.lines.filter((x) => x.code === c).reduce((s, x) => s + x.qty, 0), 0)}</b></div>`).join('')}</div>` : ''}
      <h2>每周安排</h2>
      <div class="card small">
        <div>每天：开早小票拍照 · 拍店铺和仓库照片 · 清点 6–8 款 · 打扫展示台、地面、吸尘地毯 · 整理仓库</div>
        <div style="margin-top:4px">周一 / 周三 / 周五：收货 → 导入到货单 → 通知 layby 客人 → 展示新品 → 打价格标签</div>
        <div style="margin-top:4px">周一：订文具　周三：订购物袋　不定期：退货（库存 → 📤 退回仓库）</div>
      </div>`);
    $('#dPrev').onclick = () => { dayView = dateAdd(dayView, -1); render(true); };
    if (!isToday) { $('#dNext').onclick = () => { dayView = dateAdd(dayView, 1); render(true); }; $('#dToday').onclick = () => { dayView = today(); render(true); }; }
    $$('[data-task]').forEach((b) => b.onclick = async () => {
      const t = TASKS.find((x) => x.id === b.dataset.task);
      if (taskAutoDone(t, date) && !S.dayTasks[t.id]) { toast('这一项已经根据记录自动完成'); return; }
      if (!await ensureStaff()) return;
      setTaskDone(t.id, !S.dayTasks[t.id]); render(false);
    });
    $$('[data-up]').forEach((inp) => inp.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!await ensureStaff()) return;
      try {
        toast('正在上传照片…');
        const data = await compressImage(f);
        const ph = { id: uid(), date, task: inp.dataset.up, by: S.staff, at: nowISO(), data };
        S.dayPhotos.push(ph); putPhoto(ph);
        if (!S.dayTasks[ph.task]) setTaskDone(ph.task, true);
        toast('照片已保存'); render(false);
      } catch (err) { console.error(err); toast('照片处理失败，请再试一次'); }
    });
    $$('[data-ph]').forEach((img) => img.onclick = async () => {
      const ph = S.dayPhotos.find((p) => p.id === img.dataset.ph);
      const del = await modal(`<img src="${ph.data}" style="width:100%;border-radius:8px"><div class="small muted" style="margin-top:6px">${esc(ph.by)} · ${esc(fmtTime(ph.at))}</div>`,
        [{ label: '删除照片', cls: 'danger', value: () => 'del' }, { label: '关闭', value: () => null }]);
      if (del === 'del' && await ensureStaff() && await confirmDlg('删除这张照片？', '删除')) {
        S.dayPhotos = S.dayPhotos.filter((p) => p.id !== ph.id); delPhoto(ph.id); render(false);
      }
    });
    const dc = $('#dCount');
    if (dc) dc.onclick = async () => {
      if (!await ensureStaff()) return;
      if (S.countDraft && !await confirmDlg('你有一个没完成的清点，要替换成今天建议的款吗？', '替换')) return;
      S.countDraft = { id: uid(), scope: 'custom', scopeLabel: `每日清点 ${today()}`, startedAt: nowISO(), staff: S.staff, lines: sugg.map((c) => ({ code: c, counted: '' })) };
      saveDraft(); location.hash = '#count'; stack.length = 0; cur = { n: 'count', a: '', p: {} }; render(true);
    };
  }

  // ================================================================ maps v2: shelves drawn with every code on them
  const ROOM_LAYOUT = { R1: [420, 20, 960, 250], R2: [420, 320, 800, 250], R3: [20, 600, 520, 430], R4: [20, 130, 330, 420], R5: [580, 640, 330, 300], R6: [940, 640, 460, 300] };
  const DEFAULT_LABELS = { storeroom: [{ id: 'door', x: 30, y: 60, t: '🚪 门 Door', s: 34 }], store: [] };
  let mapEditing = false, editLayout = null, selected = null; // selected = {kind:'block'|'label', id}
  function layoutFor(area) {
    const units = area === 'storeroom' ? roomUnits() : [...new Set(S.locations.filter((l) => l.area === 'store').map((l) => l.unit))];
    const saved = (editLayout ? editLayout[area] : S.layout[area]) || {};
    const out = {}; let extra = 0;
    units.forEach((u) => {
      let def = area === 'store' ? STORE_LAYOUT[u] : ROOM_LAYOUT[u];
      if (!def) { def = [20 + (extra % 6) * 230, (area === 'store' ? 790 : 1060) + Math.floor(extra / 6) * 190, 210, 170]; extra++; }
      out[u] = (saved[u] || def).slice();
    });
    return out;
  }
  function labelsFor(area) {
    const src = editLayout ? editLayout.labels : S.layout.labels;
    const l = src && src[area];
    return (l || DEFAULT_LABELS[area]).map((x) => Object.assign({}, x));
  }
  function foText(lines, W, H, cls, hiSet) {
    const n = Math.max(1, lines.length), maxLen = Math.max(4, ...lines.map((c) => String(c).length));
    const fs = Math.max(9, Math.min(20, (H - 6) / (n * 1.22), (W - 8) / (maxLen * 0.6)));
    return `<foreignObject x="0" y="0" width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" class="fo ${cls || ''}" style="font-size:${fs.toFixed(1)}px">${lines.map((c) => `<span class="${hiSet && hiSet.has(resolveCode(c)) ? 'h' : ''}">${esc(c)}</span>`).join('')}</div></foreignObject>`;
  }
  function shelfBlock(u, box, hiSet, est) {
    const [x, y, w, h] = box, T = 42;
    const locs = S.locations.filter((l) => l.unit === u && l.area === 'storeroom');
    const rows = Math.max(...locs.map((l) => l.row + (l.rowspan || 1))), cols = Math.max(...locs.map((l) => l.col + (l.colspan || 1)));
    const horiz = w >= h;
    const gw = horiz ? cols : rows, gh = horiz ? rows : cols, cw = w / gw, ch = (h - T) / gh;
    const cap = shelfCapOf(u), used = est.shelf[u] || 0;
    const anyHit = hiSet && hiSet.size && locs.some((l) => l.items.some((it) => it.code && hiSet.has(resolveCode(it.code))));
    const cells = locs.map((l) => {
      const gx = horiz ? l.col : l.row, gy = horiz ? l.row : l.col, sw = horiz ? (l.colspan || 1) : (l.rowspan || 1), sh = horiz ? (l.rowspan || 1) : (l.colspan || 1);
      const cx = gx * cw, cy = T + gy * ch, W = sw * cw, H = sh * ch;
      const lines = l.items.map((it) => it.code || it.note).filter(Boolean);
      const hit = hiSet && hiSet.size && l.items.some((it) => it.code && hiSet.has(resolveCode(it.code)));
      const pct = (est.cell[l.id] || 0) / cellCap(l);
      return `<g data-loc="${esc(l.id)}" transform="translate(${cx},${cy})"><rect width="${W}" height="${H}" fill="${hit ? FILL.hi : lines.length ? FILL[fillClass(pct)] : '#f4efe8'}" stroke="#8a7a66" stroke-width="1.5"/>${foText(lines, W, H, '', hiSet)}</g>`;
    }).join('');
    const sel = mapEditing && selected && selected.kind === 'block' && selected.id === u;
    return `<g data-unit="${esc(u)}" transform="translate(${x},${y})">
      <rect width="${w}" height="${h}" fill="#fff" stroke="${anyHit ? '#b5762f' : sel ? '#2b2118' : '#5b4c3c'}" stroke-width="${anyHit || sel ? 6 : 2.5}"/>
      <g data-shelf="${esc(u)}"><rect width="${w}" height="${T}" fill="${used > cap ? '#b3261e' : '#2b2118'}"/>
        <text x="10" y="${T * 0.68}" font-size="${Math.min(24, T * 0.6)}" font-weight="700" fill="#fff">${esc(unitName(u).replace(/^库房\s*/, ''))}</text>
        <text x="${w - 10}" y="${T * 0.68}" text-anchor="end" font-size="${Math.min(18, T * 0.45)}" fill="#f6e8d6">约 ${Math.round(used)}/${Math.round(cap)} 盒 ›</text></g>
      ${cells}
      ${mapEditing ? `<rect data-handle="1" x="${w - 30}" y="${h - 30}" width="30" height="30" fill="#b5762f"/>` : ''}
    </g>`;
  }
  function storeBlock(u, box, hiSet) {
    const [x, y, w, h] = box, T = 24;
    const locs = S.locations.filter((l) => l.unit === u);
    const lines = locs.flatMap((l) => (l.sub ? [`[${l.sub}]`] : []).concat(l.items.map((it) => it.code || it.note).filter(Boolean)));
    const hit = hiSet && hiSet.size && locs.some((l) => l.items.some((it) => it.code && hiSet.has(resolveCode(it.code))));
    const sel = mapEditing && selected && selected.kind === 'block' && selected.id === u;
    return `<g data-unit="${esc(u)}" transform="translate(${x},${y})">
      <rect width="${w}" height="${h}" rx="4" fill="${hit ? FILL.hi : '#eaf1f7'}" stroke="${hit ? '#b5762f' : sel ? '#2b2118' : '#7f9ab1'}" stroke-width="${hit || sel ? 5 : 1.5}"/>
      <rect width="${w}" height="${T}" fill="${hit ? '#b5762f' : '#46596b'}"/>
      <text x="6" y="${T - 6}" font-size="17" font-weight="700" fill="#fff">${esc(unitName(u).replace(/^店面\s*/, ''))}</text>
      <g transform="translate(0,${T})">${foText(lines, w, h - T, 'store', hiSet)}</g>
      ${mapEditing ? `<rect data-handle="1" x="${w - 22}" y="${h - 22}" width="22" height="22" fill="#b5762f"/>` : ''}
    </g>`;
  }
  function mapSVG(area, hiSet) {
    const lay = layoutFor(area), labels = labelsFor(area);
    const est = estimate();
    let maxX = area === 'store' ? 1160 : 1420, maxY = area === 'store' ? 790 : 1060;
    Object.values(lay).forEach(([x, y, w, h]) => { maxX = Math.max(maxX, x + w + 20); maxY = Math.max(maxY, y + h + 20); });
    labels.forEach((l) => { maxX = Math.max(maxX, l.x + 200); maxY = Math.max(maxY, l.y + 20); });
    const blocks = Object.entries(lay).map(([u, box]) => area === 'storeroom' ? shelfBlock(u, box, hiSet, est) : storeBlock(u, box, hiSet)).join('');
    const labs = labels.map((l) => {
      const sel = mapEditing && selected && selected.kind === 'label' && selected.id === l.id;
      return `<g data-label="${esc(l.id)}" transform="translate(${l.x},${l.y})"><text font-size="${l.s || 26}" font-weight="700" fill="#2b2118" ${sel ? 'style="text-decoration:underline"' : ''}>${esc(l.t)}</text></g>`;
    }).join('');
    return `<svg class="mapsvg ${area} ${mapEditing ? 'editing' : ''}" data-area="${area}" viewBox="0 0 ${maxX} ${maxY}" style="width:${getZoom(area) * 100}%" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="${maxX - 4}" height="${maxY - 4}" fill="#fbf8f4" stroke="#2b2118" stroke-width="5" rx="8"/>${blocks}${labs}</svg>`;
  }
  // zoom: 100% = map fits the screen width; stored per map on this device
  function getZoom(area) {
    const v = parseFloat(lsGet('ugg-zoom-' + area));
    if (v > 0) return v;
    return window.innerWidth < 700 ? (area === 'storeroom' ? 2.6 : 2.2) : 1;
  }
  function setZoom(area, z) { z = Math.max(0.5, Math.min(6, Math.round(z * 100) / 100)); lsSet('ugg-zoom-' + area, String(z)); return z; }
  const mapBox = (area, svg) => `<div class="zoombar" data-zarea="${area}"><button class="btn small" data-z="out" aria-label="缩小">－</button><span class="zv">${Math.round(getZoom(area) * 100)}%</span><button class="btn small" data-z="in" aria-label="放大">＋</button><button class="btn small" data-z="fit">适合屏幕</button><span class="small muted">（两指捏合也可以缩放）</span></div><div class="map-wrap" data-zarea="${area}">${svg}</div>`;
  function applyZoom(wrap, area, z, cx) {
    const svg = $('svg', wrap); if (!svg) return;
    const old = getZoom(area); z = setZoom(area, z);
    const focus = cx != null ? cx : wrap.clientWidth / 2;
    const ratio = (wrap.scrollLeft + focus) / (svg.clientWidth || 1);
    const vy = (wrap.scrollTop + wrap.clientHeight / 2) / (svg.clientHeight || 1);
    svg.style.width = (z * 100) + '%';
    wrap.scrollLeft = ratio * svg.clientWidth - focus;
    wrap.scrollTop = vy * svg.clientHeight - wrap.clientHeight / 2;
    $$(`.zoombar[data-zarea="${area}"] .zv`).forEach((e) => { e.textContent = Math.round(z * 100) + '%'; });
    return old;
  }
  function bindZoom(root) {
    $$('.zoombar', root).forEach((bar) => {
      const area = bar.dataset.zarea, wrap = bar.nextElementSibling;
      $$('[data-z]', bar).forEach((b) => b.onclick = () => {
        const z = getZoom(area);
        applyZoom(wrap, area, b.dataset.z === 'in' ? z * 1.25 : b.dataset.z === 'out' ? z / 1.25 : 1);
      });
      // pinch with two fingers, or ctrl + mouse wheel / trackpad pinch
      let pinch = null;
      const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      wrap.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist(e.touches), z: getZoom(area) }; }, { passive: true });
      wrap.addEventListener('touchmove', (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect(), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        applyZoom(wrap, area, pinch.z * dist(e.touches) / pinch.d, cx);
      }, { passive: false });
      wrap.addEventListener('touchend', () => { pinch = null; });
      wrap.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        applyZoom(wrap, area, getZoom(area) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left);
      }, { passive: false });
    });
  }
  function openUnit(area, unit, hiSet) {
    const codes = hiSet && hiSet.size ? [...hiSet].join(',') : '';
    if (area === 'storeroom') { navigate({ n: 'shelf', a: unit, p: codes ? { h: codes } : {} }); return; }
    const locs = S.locations.filter((l) => l.unit === unit);
    if (locs.length === 1) { navigate({ n: 'loc', a: locs[0].id, p: {} }); return; }
    modal(`<b>${esc(unitName(unit))}</b><div class="pick-list">${locs.map((l, i) => `<button data-i="${i}"><b>${esc(locLabel(l))}</b><br><span class="small muted">${esc(l.items.map((it) => it.code || it.note).join(' · ') || '（空）')}</span></button>`).join('')}</div>`,
      [{ label: '取消', value: () => null }]);
    $$('dialog[open] .pick-list button').forEach((b) => b.onclick = () => { const d = $('dialog[open]'); d.close(); d.remove(); navigate({ n: 'loc', a: locs[b.dataset.i].id, p: {} }); });
  }
  function bindMap(root, hiSet) {
    $$('svg.mapsvg', root).forEach((svg) => {
      const area = svg.dataset.area;
      if (!mapEditing) {
        svg.addEventListener('click', (e) => {
          const hiParam = hiSet && hiSet.size ? { c: [...hiSet][0] } : {};
          const loc = e.target.closest('[data-loc]');
          if (loc && area === 'storeroom') { navigate({ n: 'loc', a: loc.dataset.loc, p: hiParam }); return; }
          const sh = e.target.closest('[data-shelf]');
          if (sh) { openUnit('storeroom', sh.dataset.shelf, hiSet); return; }
          const g = e.target.closest('[data-unit]');
          if (g) openUnit(area, g.dataset.unit, hiSet);
        });
        return;
      }
      let drag = null;
      const pt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
      svg.addEventListener('pointerdown', (e) => {
        const p = pt(e);
        const lab = e.target.closest('[data-label]');
        if (lab) {
          const l = editLayout.labels[area].find((x) => x.id === lab.dataset.label);
          drag = { kind: 'label', l, g: lab, dx: p.x - l.x, dy: p.y - l.y };
          selected = { kind: 'label', id: l.id };
        } else {
          const g = e.target.closest('[data-unit]'); if (!g) return;
          const u = g.dataset.unit, box = editLayout[area][u];
          selected = { kind: 'block', id: u };
          if (e.target.closest('[data-handle]')) drag = { kind: 'resize', u, g, box, x0: box[0], y0: box[1] };
          else drag = { kind: 'move', u, g, box, dx: p.x - box[0], dy: p.y - box[1] };
        }
        updateToolbar();
        svg.setPointerCapture(e.pointerId); e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const p = pt(e), snap = (v) => Math.round(v / 5) * 5;
        if (drag.kind === 'label') { drag.l.x = snap(p.x - drag.dx); drag.l.y = snap(p.y - drag.dy); drag.g.setAttribute('transform', `translate(${drag.l.x},${drag.l.y})`); }
        else if (drag.kind === 'move') { drag.box[0] = snap(p.x - drag.dx); drag.box[1] = snap(p.y - drag.dy); drag.g.setAttribute('transform', `translate(${drag.box[0]},${drag.box[1]})`); }
        else { drag.box[2] = Math.max(80, snap(p.x - drag.x0)); drag.box[3] = Math.max(70, snap(p.y - drag.y0)); const r = $('rect', drag.g); r.setAttribute('width', drag.box[2]); r.setAttribute('height', drag.box[3]); }
      });
      const end = () => { if (drag) { const k = drag.kind; drag = null; if (k === 'resize') render(false); } };
      svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    });
  }
  function updateToolbar() {
    const el = $('#selName'); if (!el) return;
    if (!selected) { el.textContent = '（点地图上的货架或文字）'; return; }
    if (selected.kind === 'label') { const l = editLayout.labels[mapTab].find((x) => x.id === selected.id); el.textContent = '文字：' + (l ? l.t : ''); }
    else el.textContent = unitName(selected.id);
    const box = selected.kind === 'block' ? editLayout[mapTab][selected.id] : null;
    $('#selW').value = box ? box[2] : ''; $('#selH').value = box ? box[3] : '';
    $$('.blkonly').forEach((b) => b.style.display = selected.kind === 'block' ? '' : 'none');
    $$('.roomonly').forEach((b) => b.style.display = selected.kind === 'block' && mapTab === 'storeroom' ? '' : 'none');
    $$('.labonly').forEach((b) => b.style.display = selected.kind === 'label' ? '' : 'none');
  }

  // ---------------------------------------------------------------- add / remove shelves, bays, levels and store displays
  // Structure changes are saved straight away; the block's position is saved with "完成并保存".
  const cellId = (u, r, c) => { let id = `${u}-${r + 1}-${c + 1}`; while (locById[id]) id += 'b'; return id; };
  function shelfDims(u) {
    const cells = S.locations.filter((l) => l.unit === u && l.area === 'storeroom');
    return { cells, rows: Math.max(1, ...cells.map((l) => l.row + (l.rowspan || 1))), cols: Math.max(1, ...cells.map((l) => l.col + (l.colspan || 1))) };
  }
  const freeSpot = (area) => { const ys = Object.values(editLayout[area]).map((b) => b[1] + b[3]); return [40, (ys.length ? Math.max(...ys) : 0) + 40]; };
  async function addShelf() {
    if (!await ensureStaff()) return;
    const nums = roomUnits().map((u) => parseInt(u.slice(1), 10)).filter((n) => n > 0);
    const n = (nums.length ? Math.max(...nums) : 0) + 1, u = 'R' + n;
    const res = await modal(`<b>新增货架</b>
      <label class="field" style="margin-top:8px">名字<input id="nsName" type="text" value="库房 货架${n}"></label>
      <div class="row"><label class="field grow">几层<input id="nsRows" type="number" min="1" max="12" value="3"></label><label class="field grow">每层几格<input id="nsCols" type="number" min="1" max="12" value="4"></label></div>`,
      [{ label: '取消', value: () => null }, { label: '新增', cls: 'primary', value: (d) => ({ name: $('#nsName', d).value.trim(), rows: parseInt($('#nsRows', d).value, 10), cols: parseInt($('#nsCols', d).value, 10) }) }]);
    if (!res) return;
    const rows = Math.max(1, Math.min(12, res.rows || 3)), cols = Math.max(1, Math.min(12, res.cols || 4));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const l = { id: cellId(u, r, c), area: 'storeroom', unit: u, row: r, col: c, rowspan: 1, colspan: 1, rows, cols, raw: '', items: [], order: 5000 + n * 100 + r * 12 + c };
      S.locations.push(l); locById[l.id] = l; putLoc(l);
    }
    if (res.name && res.name !== defaultUnitName(u)) { S.unitNames[u] = res.name; putMeta(); }
    editLayout.storeroom[u] = [...freeSpot('storeroom'), Math.max(200, cols * 150), 42 + rows * 110];
    selected = { kind: 'block', id: u };
    addLog('newloc', { toLabel: unitName(u) + `（${rows} 层 × ${cols} 格）`, to: u });
    rebuildIndex(); toast('已新增，拖到实际位置后点「完成并保存」'); render(false);
  }
  async function addDisplay() {
    if (!await ensureStaff()) return;
    const nums = [...new Set(S.locations.filter((l) => l.area === 'store').map((l) => parseInt(l.unit.slice(1), 10)))].filter((n) => n > 0);
    const n = (nums.length ? Math.max(...nums) : 0) + 1, u = 'S' + String(n).padStart(2, '0');
    const name = await ask('新展位的名字', '店面 ' + String(n).padStart(2, '0'));
    if (!name) return;
    const l = { id: u, area: 'store', unit: u, sub: '', raw: '', items: [], order: 6000 + n };
    S.locations.push(l); putLoc(l);
    if (name !== defaultUnitName(u)) { S.unitNames[u] = name; putMeta(); }
    editLayout.store[u] = [...freeSpot('store'), 150, 100];
    selected = { kind: 'block', id: u };
    addLog('newloc', { toLabel: name, to: u });
    rebuildIndex(); toast('已新增，拖到实际位置后点「完成并保存」'); render(false);
  }
  async function deleteBlock(area, u) {
    const cells = S.locations.filter((l) => l.unit === u);
    const n = cells.reduce((a, l) => a + l.items.length, 0);
    const what = area === 'storeroom' ? '货架' : '展位';
    if (!await ensureStaff() || !await confirmDlg(`删除「${unitName(u)}」？${n ? `里面还登记着 ${n} 个款号，这些货位记录会一起删掉。` : ''}`, '删除' + what)) return;
    cells.forEach((l) => delLoc(l.id));
    S.locations = S.locations.filter((l) => l.unit !== u);
    delete editLayout[area][u];
    addLog('delloc', { fromLabel: unitName(u) + (n ? `（含 ${n} 个款号）` : '') });
    selected = null; rebuildIndex(); toast('已删除'); render(false);
  }
  function resizeShelf(u, axis, delta) {
    const { cells, rows, cols } = shelfDims(u);
    const isCol = axis === 'col', count = isCol ? cols : rows;
    const pos = isCol ? 'col' : 'row', span = isCol ? 'colspan' : 'rowspan';
    const box = editLayout.storeroom[u];
    if (delta > 0) {
      for (let k = 0; k < (isCol ? rows : cols); k++) {
        const r = isCol ? k : rows, c = isCol ? cols : k;
        const l = { id: cellId(u, r, c), area: 'storeroom', unit: u, row: r, col: c, rowspan: 1, colspan: 1, rows: 0, cols: 0, raw: '', items: [], order: (cells[0] ? cells[0].order : 5000) + 0.5 + r * 0.01 + c * 0.0001 };
        S.locations.push(l); locById[l.id] = l;
      }
      if (box) { const k = (isCol === (box[2] >= box[3])) ? 2 : 3; box[k] += Math.round(box[k] / count); }
    } else {
      if (count <= 1) { toast('至少要留一' + (isCol ? '格' : '层')); return; }
      const last = count - 1;
      const gone = cells.filter((l) => l[pos] === last && (l[span] || 1) === 1);
      const busy = gone.filter((l) => l.items.length);
      if (busy.length) { toast(`最后一${isCol ? '格' : '层'}还有款号（${busy.map((l) => l.items.map((it) => it.code || it.note).join('/')).join('，')}），请先移走`); return; }
      gone.forEach((l) => { delLoc(l.id); });
      S.locations = S.locations.filter((l) => !gone.includes(l));
      cells.filter((l) => !gone.includes(l) && l[pos] <= last && l[pos] + (l[span] || 1) > last).forEach((l) => { l[span] = (l[span] || 1) - 1; });
      if (box) { const k = (isCol === (box[2] >= box[3])) ? 2 : 3; box[k] = Math.max(80, box[k] - Math.round(box[k] / count)); }
    }
    const d2 = shelfDims(u);
    d2.cells.forEach((l) => { l.rows = d2.rows; l.cols = d2.cols; putLoc(l); });
    addLog('shelf-size', { name: unitName(u), rows: d2.rows, cols: d2.cols });
    rebuildIndex(); render(false);
  }

  // ---------------------------------------------------------------- 货位 tab
  let mapTab = 'storeroom';
  function viewMap(_, params) {
    if (params.get('t')) mapTab = params.get('t');
    let body;
    if (mapTab === 'other') {
      const others = S.locations.filter((l) => l.area === 'other');
      body = others.length ? `<div class="store-grid">${others.map((l) => cellHtml(l, '')).join('')}</div>` : '<div class="empty-state">还没有其他位置。可以点下面的按钮新增（例如新的柜子、收银台下面）。</div>';
    } else {
      body = `${mapEditing ? `<div class="card stack edit-bar">
          <div class="small">拖动货架或文字移动位置；拖右下角橙色小方块改大小。已选：<b id="selName"></b></div>
          <div class="row">
            <label class="field blkonly" style="width:80px">宽<input id="selW" type="number" min="60"></label>
            <label class="field blkonly" style="width:80px">高<input id="selH" type="number" min="60"></label>
            <button class="btn small blkonly" id="rotBtn">↻ 旋转</button>
            <button class="btn small blkonly roomonly" id="colAdd">＋ 一格</button><button class="btn small blkonly roomonly" id="colDel">－ 一格</button>
            <button class="btn small blkonly roomonly" id="rowAdd">＋ 一层</button><button class="btn small blkonly roomonly" id="rowDel">－ 一层</button>
            <button class="btn small blkonly danger" id="blkDel">${mapTab === 'storeroom' ? '删除这个货架' : '删除这个展位'}</button>
            <button class="btn small labonly" id="labEdit">✏️ 改文字</button>
            <button class="btn small labonly" id="labBig">A+</button><button class="btn small labonly" id="labSmall">A−</button>
            <button class="btn small labonly danger" id="labDel">删除文字</button>
          </div>
          <div class="row"><button class="btn small" id="addBlk">${mapTab === 'storeroom' ? '＋ 新增货架' : '＋ 新增展位'}</button><button class="btn small" id="addLab">＋ 加文字</button><button class="btn small" id="resetLay">恢复默认</button>
            <button class="btn small" id="cancelLay">取消</button><button class="btn small primary" id="saveLay">完成并保存</button></div></div>` : ''}
        ${mapBox(mapTab, mapSVG(mapTab))}
        ${mapEditing ? '' : `<div class="small muted" style="margin-top:6px">${mapTab === 'storeroom' ? `每个格子里直接写着放在那里的款号。格子颜色 = 估计装满程度（绿 &lt;75%、橙 75–100%、红 超出）；${capText()}，特大鞋盒（${esc((S.cap.xl || []).join('/'))}）每格 ${S.cap.xlH} 高 × ${S.cap.xlD} 宽。点格子看详情，点货架标题看整个货架。手机上可以左右滑动。` : '点展位查看里面的款号。手机上可以左右滑动。'}</div>`}`;
    }
    view(`<h1>货位图</h1>
      <div class="seg">
        <button data-t="storeroom" class="${mapTab === 'storeroom' ? 'on' : ''}">📦 仓库地图</button>
        <button data-t="store" class="${mapTab === 'store' ? 'on' : ''}">🏬 店面地图</button>
        <button data-t="other" class="${mapTab === 'other' ? 'on' : ''}">➕ 其他</button>
      </div>
      ${body}
      ${mapEditing ? '' : `<div class="row" style="margin-top:12px">
        ${mapTab !== 'other' ? '<button class="btn small" id="editLay">✏️ 调整地图</button>' : ''}
        <a class="btn small" ${goAttr('tidy')}>💡 整理建议</a>
        <button class="btn small" id="newLoc">＋ 新增位置</button>
        <button class="btn small" id="sheetBtn">⬇️ 货位表 CSV</button></div>`}`);
    $$('.seg button').forEach((b) => b.onclick = () => { if (mapEditing) { toast('请先完成或取消地图调整'); return; } mapTab = b.dataset.t; cur.p = {}; render(false); });
    bindMap($('#view'));
    bindZoom($('#view'));
    bindCells();
    if (mapEditing) {
      updateToolbar();
      const box = () => selected && selected.kind === 'block' ? editLayout[mapTab][selected.id] : null;
      const lab = () => selected && selected.kind === 'label' ? editLayout.labels[mapTab].find((x) => x.id === selected.id) : null;
      $('#selW').onchange = () => { const b = box(); if (b) { b[2] = Math.max(60, parseInt($('#selW').value, 10) || b[2]); render(false); } };
      $('#selH').onchange = () => { const b = box(); if (b) { b[3] = Math.max(60, parseInt($('#selH').value, 10) || b[3]); render(false); } };
      $('#rotBtn').onclick = () => { const b = box(); if (b) { [b[2], b[3]] = [b[3], b[2]]; render(false); } };
      $('#labEdit').onclick = async () => { const l = lab(); if (!l) return; const t = await ask('文字内容', l.t); if (t) { l.t = t; render(false); } };
      $('#labBig').onclick = () => { const l = lab(); if (l) { l.s = Math.min(90, (l.s || 26) + 4); render(false); } };
      $('#labSmall').onclick = () => { const l = lab(); if (l) { l.s = Math.max(12, (l.s || 26) - 4); render(false); } };
      $('#labDel').onclick = () => { const l = lab(); if (l) { editLayout.labels[mapTab] = editLayout.labels[mapTab].filter((x) => x !== l); selected = null; render(false); } };
      $('#addBlk').onclick = () => (mapTab === 'storeroom' ? addShelf() : addDisplay());
      $('#blkDel').onclick = () => { if (box()) deleteBlock(mapTab, selected.id); };
      $('#colAdd').onclick = () => { if (box()) resizeShelf(selected.id, 'col', 1); };
      $('#colDel').onclick = () => { if (box()) resizeShelf(selected.id, 'col', -1); };
      $('#rowAdd').onclick = () => { if (box()) resizeShelf(selected.id, 'row', 1); };
      $('#rowDel').onclick = () => { if (box()) resizeShelf(selected.id, 'row', -1); };
      $('#addLab').onclick = async () => {
        const t = await ask('加一段文字（例如：收银台、楼梯、窗户）', '', '文字');
        if (!t) return;
        const l = { id: uid(), x: 480, y: 330, t, s: 28 };
        editLayout.labels[mapTab].push(l); selected = { kind: 'label', id: l.id }; render(false);
      };
      $('#resetLay').onclick = async () => {
        if (!await confirmDlg('恢复成默认布局？（保存后才生效）', '恢复')) return;
        editLayout[mapTab] = {}; editLayout.labels[mapTab] = DEFAULT_LABELS[mapTab].map((x) => Object.assign({}, x));
        const saved = S.layout[mapTab]; S.layout[mapTab] = {}; editLayout[mapTab] = layoutFor(mapTab); S.layout[mapTab] = saved;
        selected = null; render(false);
      };
      $('#cancelLay').onclick = () => { mapEditing = false; editLayout = null; selected = null; render(false); };
      $('#saveLay').onclick = () => {
        S.layout = { storeroom: editLayout.storeroom, store: editLayout.store, labels: editLayout.labels };
        mapEditing = false; editLayout = null; selected = null;
        putLayout(); addLog('layout', { area: mapTab === 'store' ? '店面地图' : '仓库地图' });
        toast('地图已保存'); render(false);
      };
      return;
    }
    if ($('#editLay')) $('#editLay').onclick = async () => {
      if (!await ensureStaff()) return;
      editLayout = { storeroom: layoutFor('storeroom'), store: layoutFor('store'), labels: { storeroom: labelsFor('storeroom'), store: labelsFor('store') } };
      mapEditing = true; selected = null; render(false);
    };
    $('#newLoc').onclick = newLocation;
    $('#sheetBtn').onclick = () => saveFile(`货位表_${today()}.csv`, toCSV([['区域', '位置', '款号', '备注', '系统库存'],
      ...S.locations.flatMap((l) => (l.items.length ? l.items : [{ code: '', note: '（空）' }]).map((it) => [l.area === 'storeroom' ? '仓库' : l.area === 'store' ? '店面' : '其他', locLabel(l), it.code, it.note, P[resolveCode(it.code)] ? P[resolveCode(it.code)].qty : '']))]));
  }

  // ---------------------------------------------------------------- boot
  function renderStaff() {
    const c = $('#staffChip');
    c.textContent = S.staff ? '👤 ' + S.staff : '点这里填名字';
    c.classList.toggle('missing', !S.staff);
  }
  $('#staffChip').onclick = async () => {
    const name = await ask('你的名字（用于记录是谁做的修改）', S.staff);
    if (name) { S.staff = name; lsSet(LS_STAFF, name); renderStaff(); toast('你好，' + name); }
  };
  renderStaff();
  applyLang();

  function setSync(text) { $('#sync').textContent = text; }
  function subscribe(query, onData, key) {
    let timer = setTimeout(() => { setSync('⚠️ 连接中'); if (!S.loaded[key] && key) $('#view').innerHTML = '<div class="loading">数据暂时连不上，请检查网络。连上后会自动显示。</div>'; }, 10000);
    query.onSnapshot((snap) => {
      if (!snap.metadata.fromCache) { clearTimeout(timer); setSync(''); }
      onData(snap);
      scheduleRender();
    }, (err) => {
      clearTimeout(timer);
      console.error('subscription error', err);
      setSync('⚠️ 同步中断');
      if (err && err.code === 'revoked') { S.readOnly = true; }
    });
  }

  (async function init() {
    if (!window.claude || !window.claude.use) {
      LOCAL = true; db = localDB();
    } else {
      db = await window.claude.use('db');
      claude.use('downloads').then((d) => { downloads = d; }).catch(() => {});
      claude.use('user').then(async (u) => {
        if (!u) return;
        try { const can = await u.can('data.write'); if (can === false) { S.readOnly = true; render(false); } } catch (e) { /* not told */ }
      }).catch(() => {});
    }
    if (!db) { $('#view').innerHTML = '<div class="loading">需要登录 Claude 才能读取货位数据。</div>'; return; }
    subscribe(db.collection('locations'), (snap) => {
      S.locations = snap.docs.map((d) => Object.assign({ id: d.id, items: [] }, JSON.parse(JSON.stringify(d.data())))).sort((a, b) => (a.order || 0) - (b.order || 0));
      S.loaded.locations = true;
    }, 'locations');
    subscribe(db.doc('products/all'), (snap) => {
      const d = snap.exists ? snap.data() : {};
      S.products = JSON.parse(JSON.stringify(d.list || []));
      S.loaded.products = true;
    }, 'products');
    subscribe(db.doc('meta/main'), (snap) => {
      const d = snap.exists ? snap.data() : {};
      S.unitNames = Object.assign({}, d.unitNames || {});
      S.lowStock = d.lowStock || 3;
      S.vendImportedAt = d.vendImportedAt || '';
      S.cap = Object.assign({ h: 6, l: 7, d: 2, display: 2, mode: 'cell', xl: ['15901', '15902'], xlH: 5, xlD: 1, daily: 8 }, d.cap || {});
      S.loaded.meta = true;
    });
    subscribe(db.doc('meta/layout'), (snap) => {
      const d = snap.exists ? JSON.parse(JSON.stringify(snap.data())) : {};
      S.layout = { storeroom: d.storeroom || {}, store: d.store || {}, labels: d.labels || null };
    });
    subscribe(db.collection('laybys').orderBy('createdAt', 'desc').limit(300), (snap) => {
      S.laybys = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
    });
    subscribe(db.collection('imports').orderBy('date', 'desc').limit(100), (snap) => {
      S.imports = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
    });
    subscribe(db.collection('returns').orderBy('date', 'desc').limit(500), (snap) => {
      S.returns = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
    });
    subscribe(db.collection('counts').orderBy('date', 'desc').limit(100), (snap) => {
      S.counts = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
    });
    subscribe(db.collection('log').orderBy('t', 'desc').limit(500), (snap) => {
      S.log = snap.docs.map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
    });
    const h = location.hash.replace(/^#/, '');
    if (TABS.includes(h)) cur = { n: h, a: '', p: {} };
  })();
})();
