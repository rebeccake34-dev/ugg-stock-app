/* UGG 货位助手 — single-page app, all data stays in this browser (localStorage). */
(function () {
  'use strict';

  const STORE_KEY = 'ugg-stock-app-v1';
  const RETURN_REASONS = ['调回仓库', '质量问题 / 瑕疵', '换季退仓', '顾客退货待处理', '其他'];

  // ---------------------------------------------------------------- state
  let S = load();

  function freshState() {
    const seed = window.SEED_DATA || { locations: [], products: [] };
    return {
      version: 1,
      staff: '',
      lowStock: 3,
      locations: JSON.parse(JSON.stringify(seed.locations)),
      products: JSON.parse(JSON.stringify(seed.products)),
      vendImportedAt: seed.generated || '',
      unitNames: {},
      log: [],
      counts: [],
      countDraft: null,
      returns: [],
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const st = JSON.parse(raw);
        return Object.assign(freshState(), st);
      }
    } catch (e) { console.warn('load failed', e); }
    return freshState();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast('⚠️ 保存失败：浏览器存储空间不足'); }
    rebuildIndex();
  }

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nowISO = () => new Date().toISOString();
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.length <= 19 && !iso.endsWith('Z') ? iso.replace(' ', 'T') : iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const today = () => fmtTime(nowISO()).slice(0, 10);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function ensureStaff() {
    if (S.staff) return S.staff;
    const name = (prompt('请输入你的名字（用于记录是谁做的修改）：') || '').trim();
    if (!name) { toast('需要先填写名字才能修改'); return null; }
    S.staff = name; save(); renderStaff();
    return name;
  }
  function addLog(type, detail) {
    S.log.unshift({ id: uid(), t: nowISO(), staff: S.staff || '?', type, detail });
    if (S.log.length > 3000) S.log.length = 3000;
  }

  function download(filename, text, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob([mime.startsWith('text/csv') ? '﻿' + text : text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function toCSV(rows) {
    return rows.map((r) => r.map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已复制，可以直接粘贴到微信 / WhatsApp'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (_) { toast('复制失败，请手动选择文字'); }
      ta.remove();
    }
  }

  // ---------------------------------------------------------------- index
  let P = {};          // code -> product
  let codeLocs = {};   // resolved code -> [locationId]
  let locById = {};

  function resolveCode(c) {
    c = norm(c);
    if (!c) return '';
    if (P[c]) return c;
    if (/[KM]$/.test(c) && P[c.slice(0, -1)]) return c.slice(0, -1);
    if (P[c + 'K']) return c + 'K';
    if (/^\d+$/.test(c) && P['AS' + c]) return 'AS' + c;
    return c; // unknown to Vend, keep as written
  }
  function rebuildIndex() {
    P = {}; codeLocs = {}; locById = {};
    S.products.forEach((p) => { if (p.code) P[p.code] = p; });
    S.locations.forEach((l) => {
      locById[l.id] = l;
      l.items.forEach((it) => {
        if (!it.code) return;
        const rc = resolveCode(it.code);
        (codeLocs[rc] = codeLocs[rc] || []);
        if (!codeLocs[rc].includes(l.id)) codeLocs[rc].push(l.id);
      });
    });
  }
  function pendingReturnQty(code) {
    return S.returns.filter((r) => r.status === 'pending' && r.code === code).reduce((a, r) => a + Number(r.qty || 0), 0);
  }

  // ---------------------------------------------------------------- location naming
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
    const cls = l.area === 'storeroom' ? 'loc-chip' : 'loc-chip store';
    const icon = l.area === 'storeroom' ? '📦' : '🏬';
    return `<a class="${cls}" href="#/loc/${encodeURIComponent(id)}${hiCode ? '?c=' + encodeURIComponent(hiCode) : ''}">${icon} <span class="where">${esc(locLabel(l))}</span></a>`;
  }
  const itemName = (it) => {
    const p = P[resolveCode(it.code)];
    return p ? p.name : (it.note || '');
  };

  // ---------------------------------------------------------------- router
  const routes = {
    search: viewSearch, map: viewMap, loc: viewLoc, count: viewCount, countReport: viewCountReport,
    returns: viewReturns, stock: viewStock, more: viewMore, log: viewLog, import: viewImport, product: viewProduct,
  };
  function route() {
    const h = location.hash.replace(/^#\/?/, '') || 'search';
    const [pathPart, qs] = h.split('?');
    const [name, ...rest] = pathPart.split('/');
    const params = new URLSearchParams(qs || '');
    const fn = routes[name] || viewSearch;
    $$('.tabbar a').forEach((a) => {
      const tab = a.dataset.tab;
      const group = { loc: 'map', countReport: 'count', stock: 'more', log: 'more', import: 'more', product: 'search' }[name] || name;
      a.classList.toggle('active', tab === group);
    });
    fn(rest.map(decodeURIComponent), params);
    if (!route._keepScroll) window.scrollTo(0, 0);
    route._keepScroll = false;
  }
  function rerender() { route._keepScroll = true; const y = window.scrollY; route(); window.scrollTo(0, y); }
  const view = (html) => { $('#view').innerHTML = html; };

  // ---------------------------------------------------------------- search
  let lastQuery = '';
  function searchProducts(q) {
    const nq = norm(q);
    if (!nq) return [];
    const lower = q.trim().toLowerCase();
    const seen = new Map();
    const add = (code, score) => { if (!seen.has(code) || seen.get(code) < score) seen.set(code, score); };
    const allCodes = new Set([...Object.keys(P), ...Object.keys(codeLocs)]);
    allCodes.forEach((code) => {
      const p = P[code];
      if (code === nq) add(code, 100);
      else if (code.startsWith(nq)) add(code, 80);
      else if (code.includes(nq)) add(code, 60);
      else if (nq.length >= 3 && /^\d+$/.test(nq) && code.replace(/^[A-Z]+/, '').startsWith(nq)) add(code, 55);
      if (p && p.name.toLowerCase().includes(lower)) add(code, 40);
    });
    // notes written on the shelf sheets (e.g. "Talia", "gift set")
    if (lower.length >= 2) {
      S.locations.forEach((l) => l.items.forEach((it) => {
        if (it.code && (it.note || '').toLowerCase().includes(lower)) add(resolveCode(it.code), 35);
      }));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map((e) => e[0]);
  }
  function searchLocationsByText(q) {
    const lower = q.trim().toLowerCase();
    if (lower.length < 2) return [];
    return S.locations.filter((l) => l.items.some((it) => !it.code && (it.note || '').toLowerCase().includes(lower)) || locLabel(l).toLowerCase().includes(lower));
  }
  function productCard(code) {
    const p = P[code];
    const locs = codeLocs[code] || [];
    const pend = pendingReturnQty(code);
    const qty = p ? p.qty : null;
    const notes = new Set();
    locs.forEach((id) => locById[id].items.forEach((it) => { if (it.code && resolveCode(it.code) === code && it.note) notes.add(it.note); }));
    return `<div class="card result">
      <div class="result-head">
        <div class="grow">
          <a href="#/product/${encodeURIComponent(code)}" style="text-decoration:none"><span class="code">${esc(code)}</span></a>
          <div class="name">${esc(p ? p.name : [...notes].join(' / ') || '（Vend 中没有这个款号）')}</div>
        </div>
        <div style="text-align:right">
          ${qty == null ? '<span class="pill grey">Vend 无记录</span>' : `<div class="qty ${qty <= 0 ? 'zero' : ''}">${qty}</div><div class="small muted">系统库存</div>`}
          ${pend ? `<div><span class="pill warn">待退库 ${pend}</span></div>` : ''}
        </div>
      </div>
      <div style="margin-top:6px">${locs.length ? locs.map((id) => locChip(id, code)).join('') : '<span class="pill bad">还没有记录货位</span> <a class="small" href="#/product/' + encodeURIComponent(code) + '">添加货位</a>'}</div>
    </div>`;
  }
  function viewSearch() {
    view(`
      <input id="q" class="searchbox" type="search" inputmode="search" autocomplete="off" placeholder="输入款号或名字，例如 2115、AS2115、Tay" value="${esc(lastQuery)}">
      <div class="small muted" style="margin:6px 2px 12px">不用打完整款号：输入数字的一部分或英文名都可以。</div>
      <div id="results"></div>`);
    const q = $('#q');
    const run = () => {
      lastQuery = q.value;
      const codes = searchProducts(q.value);
      const locs = searchLocationsByText(q.value);
      let html = '';
      if (!q.value.trim()) {
        html = homeSummary();
      } else if (!codes.length && !locs.length) {
        html = `<div class="empty-state">找不到「${esc(q.value)}」<br><span class="small">检查款号是否正确，或者去「更多 → 库存总览」看全部款号。</span></div>`;
      } else {
        html = codes.map(productCard).join('');
        if (locs.length) html += `<h2>相关位置</h2>` + locs.map((l) => locChip(l.id)).join('');
      }
      $('#results').innerHTML = html;
    };
    q.addEventListener('input', run);
    run();
    setTimeout(() => q.focus(), 50);
  }
  function homeSummary() {
    const noLoc = S.products.filter((p) => p.code && p.qty > 0 && !codeLocs[p.code]).length;
    const low = S.products.filter((p) => p.code && p.qty > 0 && p.qty <= S.lowStock && codeLocs[p.code]).length;
    const pend = S.returns.filter((r) => r.status === 'pending').length;
    const todayCount = S.counts.filter((c) => c.date.slice(0, 10) === today()).length;
    return `
      <div class="card">
        <div class="row between"><b>今日状态</b><span class="small muted">${today()}</span></div>
        <div class="row" style="margin-top:8px">
          <a class="btn small" href="#/count">${todayCount ? '✅ 今日已清点 ' + todayCount + ' 次' : '⏳ 今日还没清点'}</a>
          <a class="btn small" href="#/returns">📦 待退库 ${pend} 条</a>
        </div>
      </div>
      <div class="card">
        <div class="row between"><b>需要注意</b></div>
        <div class="row" style="margin-top:8px">
          <a class="btn small" href="#/stock?f=low">🔻 库存偏低（≤${S.lowStock}）${low} 款</a>
          <a class="btn small" href="#/stock?f=noloc">❓ 有库存但没登记货位 ${noLoc} 款</a>
        </div>
        <div class="small muted" style="margin-top:8px">Vend 库存数据更新于：${esc(fmtTime(S.vendImportedAt)) || '未导入'} · <a href="#/import">导入最新数据</a></div>
      </div>`;
  }

  // ---------------------------------------------------------------- product page
  function viewProduct([code]) {
    code = resolveCode(code);
    const p = P[code];
    const locs = codeLocs[code] || [];
    const rets = S.returns.filter((r) => r.code === code);
    const history = S.log.filter((g) => g.detail && g.detail.code && resolveCode(g.detail.code) === code).slice(0, 20);
    view(`
      <a href="javascript:history.back()" class="small">‹ 返回</a>
      <h1><span class="code">${esc(code)}</span></h1>
      <div class="card">
        <div class="muted">${esc(p ? p.name : 'Vend 中没有这个款号')}</div>
        ${p ? `<div class="row" style="margin-top:8px;gap:18px">
          <div><div class="qty">${p.qty}</div><div class="small muted">系统库存</div></div>
          <div><div class="qty">${pendingReturnQty(code)}</div><div class="small muted">待退库</div></div>
          <div class="small muted">最近到货<br>${esc(fmtTime(p.lastReceived)) || '—'}</div>
        </div>` : ''}
      </div>
      <h2>货位</h2>
      <div class="card">${locs.length ? locs.map((id) => locChip(id, code)).join('') : '<span class="muted">还没有登记货位</span>'}
        <div style="margin-top:10px"><button class="btn small" id="addLocBtn">＋ 登记到一个货位</button>
        <button class="btn small" id="retBtn">📦 退库这个款</button></div>
      </div>
      ${rets.length ? `<h2>退库记录</h2><div class="card">${rets.map((r) => `<div class="small">${esc(fmtTime(r.date))} · ${esc(r.staff)} · ${r.qty} 双 ${esc(r.size || '')} · ${r.status === 'pending' ? '<span class="pill warn">待退</span>' : '<span class="pill ok">已寄出</span>'}</div>`).join('')}</div>` : ''}
      ${history.length ? `<h2>修改记录</h2><div class="card">${history.map(logLine).join('')}</div>` : ''}
    `);
    $('#addLocBtn').onclick = () => {
      if (!ensureStaff()) return;
      pickLocation('把 ' + code + ' 登记到哪个位置？', null, (dest) => {
        const l = locById[dest];
        l.items.push({ code, note: p ? '' : '' });
        addLog('add', { code, to: dest, toLabel: locLabel(l) });
        save(); toast('已登记到 ' + locLabel(l)); rerender();
      });
    };
    $('#retBtn').onclick = () => { location.hash = '#/returns?c=' + encodeURIComponent(code); };
  }

  // ---------------------------------------------------------------- map (all locations)
  let mapTab = 'storeroom';
  function viewMap(_, params) {
    if (params.get('t')) mapTab = params.get('t');
    const units = (area) => [...new Set(S.locations.filter((l) => l.area === area).map((l) => l.unit))];
    let body = '';
    if (mapTab === 'storeroom') {
      body = units('storeroom').map((u) => unitGrid(u)).join('') || '<div class="empty-state">没有库房货位</div>';
    } else if (mapTab === 'store') {
      body = `<div class="store-grid">${S.locations.filter((l) => l.area === 'store').map((l) => cellHtml(l, '')).join('')}</div>`;
    } else {
      const others = S.locations.filter((l) => l.area === 'other');
      body = others.length ? `<div class="store-grid">${others.map((l) => cellHtml(l, '')).join('')}</div>` : '<div class="empty-state">还没有其他位置。可以点下面的按钮新增（例如新的柜子、收银台下面）。</div>';
    }
    view(`
      <h1>货位图</h1>
      <div class="seg">
        <button data-t="storeroom" class="${mapTab === 'storeroom' ? 'on' : ''}">📦 库房</button>
        <button data-t="store" class="${mapTab === 'store' ? 'on' : ''}">🏬 店面</button>
        <button data-t="other" class="${mapTab === 'other' ? 'on' : ''}">➕ 其他</button>
      </div>
      ${body}
      <div class="row" style="margin-top:14px">
        <button class="btn small" id="newLoc">＋ 新增位置</button>
        <button class="btn small" id="printBtn">🖨️ 打印货位表</button>
      </div>
      <p class="small muted">点任意格子可以查看、添加、移动或删除里面的款号。每次修改都会自动记录是谁改的。</p>`);
    $$('.seg button').forEach((b) => b.onclick = () => { mapTab = b.dataset.t; rerender(); });
    $$('[data-loc]').forEach((el) => el.onclick = () => { location.hash = '#/loc/' + encodeURIComponent(el.dataset.loc); });
    $$('[data-rename]').forEach((el) => el.onclick = (e) => { e.stopPropagation(); renameUnit(el.dataset.rename); });
    $('#newLoc').onclick = newLocation;
    $('#printBtn').onclick = printSheets;
  }
  function cellHtml(l, hiCode, showPos, curId) {
    const hit = hiCode && l.items.some((it) => it.code && resolveCode(it.code) === hiCode);
    const inner = l.items.length
      ? l.items.map((it) => it.code ? `<span class="c">${esc(it.code)}</span> ${esc(it.note || shortName(itemName(it)))}` : esc(it.note)).join('<br>')
      : '（空）';
    const pos = showPos ? `第${l.row + 1}行 第${l.col + 1}格` : locLabel(l);
    const style = l.area === 'storeroom' && showPos ? `grid-row:${l.row + 1} / span ${l.rowspan || 1};grid-column:${l.col + 1} / span ${l.colspan || 1};` : '';
    return `<button type="button" class="cell ${l.items.length ? '' : 'empty'} ${hit ? 'hit' : ''} ${curId === l.id ? 'cur' : ''}" style="${style}" data-loc="${esc(l.id)}"><span class="pos">${esc(pos)}</span>${inner}</button>`;
  }
  const shortName = (n) => String(n || '').replace(/^(Australian Shepherd|Everau|AS\*|As\*)\s*/i, '');
  function unitGrid(unit, hiCode, curId) {
    const cells = S.locations.filter((l) => l.unit === unit && l.area === 'storeroom');
    const cols = Math.max(...cells.map((l) => l.col + (l.colspan || 1)));
    return `<div class="unit">
      <div class="unit-title"><b>${esc(unitName(unit))}</b><button class="btn small" data-rename="${esc(unit)}">改名</button></div>
      <div class="grid" style="grid-template-columns:repeat(${cols}, minmax(0,1fr))">${cells.map((l) => cellHtml(l, hiCode, true, curId)).join('')}</div>
    </div>`;
  }
  function renameUnit(unit) {
    if (!ensureStaff()) return;
    const cur = unitName(unit);
    const name = (prompt('给「' + cur + '」起个好认的名字（例如：库房 左边第一个架子）', cur) || '').trim();
    if (!name || name === cur) return;
    S.unitNames[unit] = name;
    addLog('rename', { from: cur, to: name });
    save(); toast('已改名'); rerender();
  }
  function newLocation() {
    if (!ensureStaff()) return;
    const name = (prompt('新位置的名字（例如：收银台下柜、库房 门口地上）') || '').trim();
    if (!name) return;
    const id = 'X' + uid();
    S.locations.push({ id, area: 'other', unit: id, sub: '', raw: '', items: [] });
    S.unitNames[id] = name;
    addLog('newloc', { toLabel: name, to: id });
    save(); location.hash = '#/loc/' + id;
  }

  // ---------------------------------------------------------------- single location
  function viewLoc([id], params) {
    const l = locById[id];
    if (!l) { view('<div class="empty-state">这个位置不存在了</div>'); return; }
    const hi = params.get('c') ? resolveCode(params.get('c')) : '';
    const context = l.area === 'storeroom' ? unitGrid(l.unit, hi, l.id) : '';
    view(`
      <a href="#/map?t=${l.area}" class="small">‹ 货位图</a>
      <h1>${esc(locLabel(l))}</h1>
      ${context ? `<div class="small muted">黑框 = 当前这一格${hi ? '，橙色 = 你在找的款号' : ''}</div>${context}` : ''}
      <div class="card">
        ${l.items.length ? l.items.map((it, i) => {
          const rc = resolveCode(it.code);
          const p = P[rc];
          return `<div class="item-line">
            <div class="grow">
              ${it.code ? `<a href="#/product/${encodeURIComponent(rc)}" style="text-decoration:none"><span class="code" ${rc === hi ? 'style="background:var(--accent-soft)"' : ''}>${esc(it.code)}</span></a>` : ''}
              <span>${esc(it.note || '')}</span>
              ${p ? `<div class="small muted">${esc(p.name)} · 系统库存 <b>${p.qty}</b></div>` : it.code ? '<div class="small muted">Vend 无记录</div>' : ''}
            </div>
            <button class="btn small" data-act="move" data-i="${i}">移动</button>
            <button class="btn small" data-act="edit" data-i="${i}">备注</button>
            <button class="btn small danger" data-act="del" data-i="${i}">删除</button>
          </div>`;
        }).join('') : '<div class="muted">这里现在是空的</div>'}
      </div>
      <div class="card stack">
        <b>添加款号到这里</b>
        <div class="row"><input id="newCode" type="text" placeholder="款号，例如 AS2115" class="grow" style="flex:2" autocapitalize="characters"><input id="newNote" type="text" placeholder="备注（颜色/尺码，可不填）" class="grow" style="flex:3"></div>
        <div id="newHint" class="small muted"></div>
        <button class="btn primary" id="addBtn">＋ 添加</button>
      </div>
      ${l.area !== 'storeroom' ? `<div class="row"><button class="btn small" id="renameLoc">改位置名字</button>${l.area === 'other' ? '<button class="btn small danger" id="delLoc">删除这个位置</button>' : ''}</div>` : ''}
      <h2>这个位置的修改记录</h2>
      <div class="card">${S.log.filter((g) => g.detail && (g.detail.to === id || g.detail.from === id || g.detail.loc === id)).slice(0, 15).map(logLine).join('') || '<span class="muted small">暂无</span>'}</div>
    `);
    $$('[data-loc]').forEach((el) => el.onclick = () => { if (el.dataset.loc !== id) location.hash = '#/loc/' + encodeURIComponent(el.dataset.loc); });
    $$('[data-rename]').forEach((el) => el.onclick = () => renameUnit(el.dataset.rename));
    const nc = $('#newCode');
    nc.addEventListener('input', () => {
      const rc = resolveCode(nc.value);
      const p = P[rc];
      $('#newHint').innerHTML = !nc.value ? '' : p ? `✔ ${esc(p.name)}（库存 ${p.qty}）${codeLocs[rc] ? ' · 已在：' + codeLocs[rc].map((x) => esc(locLabel(locById[x]))).join('、') : ''}` : '⚠️ Vend 里没有这个款号（也可以照样添加）';
    });
    $('#addBtn').onclick = () => {
      const code = norm(nc.value);
      const note = $('#newNote').value.trim();
      if (!code && !note) { toast('请输入款号'); return; }
      if (!ensureStaff()) return;
      l.items.push({ code, note });
      addLog('add', { code, to: id, toLabel: locLabel(l), note });
      save(); toast('已添加'); rerender();
    };
    $$('[data-act]').forEach((b) => b.onclick = () => {
      const i = Number(b.dataset.i);
      const it = l.items[i];
      if (!ensureStaff()) return;
      if (b.dataset.act === 'del') {
        if (!confirm(`确定把 ${it.code || it.note} 从「${locLabel(l)}」删除吗？`)) return;
        l.items.splice(i, 1);
        addLog('remove', { code: it.code, from: id, fromLabel: locLabel(l) });
        save(); toast('已删除'); rerender();
      } else if (b.dataset.act === 'edit') {
        const note = prompt('备注（颜色、尺码等）', it.note || '');
        if (note == null) return;
        addLog('note', { code: it.code, loc: id, fromLabel: locLabel(l), before: it.note, after: note.trim() });
        it.note = note.trim();
        save(); rerender();
      } else {
        pickLocation(`把 ${it.code || it.note} 移到哪里？`, id, (dest) => {
          const d = locById[dest];
          l.items.splice(i, 1);
          d.items.push(it);
          addLog('move', { code: it.code, from: id, fromLabel: locLabel(l), to: dest, toLabel: locLabel(d) });
          save(); toast(`已移到 ${locLabel(d)}`); rerender();
        });
      }
    });
    const rn = $('#renameLoc'); if (rn) rn.onclick = () => renameUnit(l.unit);
    const dl = $('#delLoc'); if (dl) dl.onclick = () => {
      if (l.items.length) { toast('请先把里面的款号移走'); return; }
      if (!ensureStaff() || !confirm('确定删除这个位置？')) return;
      addLog('delloc', { fromLabel: locLabel(l) });
      S.locations = S.locations.filter((x) => x.id !== id);
      save(); location.hash = '#/map?t=other';
    };
  }

  // modal: choose a destination location
  function pickLocation(title, excludeId, onPick) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dlg-body"><b>${esc(title)}</b>
      <input type="search" placeholder="搜索位置或款号，例如 货架3、S05、AS2115" style="margin-top:10px">
      <div class="pick-list"></div></div>
      <div class="dlg-actions"><button class="btn" value="cancel">取消</button></div>`;
    document.body.appendChild(dlg);
    const input = $('input', dlg), list = $('.pick-list', dlg);
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const nq = norm(q);
      const ls = S.locations.filter((l) => l.id !== excludeId && (!q || locLabel(l).toLowerCase().includes(q) || l.id.toLowerCase().includes(q) || l.items.some((it) => norm(it.code).includes(nq) || (it.note || '').toLowerCase().includes(q))));
      list.innerHTML = ls.map((l) => `<button data-id="${esc(l.id)}"><b>${esc(locLabel(l))}</b><br><span class="small muted">${esc(l.items.map((it) => it.code || it.note).join(' · ') || '（空）')}</span></button>`).join('') || '<div class="muted small">没有匹配的位置</div>';
      $$('button[data-id]', list).forEach((b) => b.onclick = () => { dlg.close(); dlg.remove(); onPick(b.dataset.id); });
    };
    input.addEventListener('input', draw);
    $('.dlg-actions button', dlg).onclick = () => { dlg.close(); dlg.remove(); };
    draw();
    dlg.showModal();
    input.focus();
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
      const recent = S.counts.slice(0, 10);
      view(`
        <h1>每日清点</h1>
        <div class="card">
          <b>清点步骤</b>
          <ol class="sop small">
            <li>选择今天要清点的范围（一个货架 / 一个展位 / 全部）</li>
            <li>按列表逐个款号数实物，在右边格子里填<b>实际数量</b>（店面 + 库房加起来的总数）</li>
            <li>右边会自动显示和 Vend 系统数的差异</li>
            <li>点「完成清点」保存，再把差异报告复制发给经理</li>
          </ol>
          <div class="small muted">Vend 数据更新于 ${esc(fmtTime(S.vendImportedAt)) || '—'}。清点前最好先 <a href="#/import">导入当天的 Vend 库存</a>，差异才准确。</div>
        </div>
        <label class="field">清点范围
          <select id="scope">${scopeOptions().map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>
        </label>
        <button class="btn primary block" id="startBtn" style="margin-top:10px">开始清点</button>
        <h2>最近的清点</h2>
        ${recent.length ? recent.map((c) => {
          const diffs = c.lines.filter((x) => x.diff !== 0).length;
          return `<a class="card row between" style="text-decoration:none;display:flex" href="#/countReport/${c.id}"><div><b>${esc(c.scopeLabel)}</b><div class="small muted">${esc(fmtTime(c.date))} · ${esc(c.staff)} · ${c.lines.length} 款</div></div>${diffs ? `<span class="pill bad">${diffs} 款有差异</span>` : '<span class="pill ok">全部相符</span>'}</a>`;
        }).join('') : '<div class="muted small">还没有清点记录</div>'}
      `);
      $('#startBtn').onclick = () => {
        if (!ensureStaff()) return;
        const scope = $('#scope').value;
        const label = $('#scope').selectedOptions[0].textContent;
        const codes = scope === 'custom' ? [] : codesForScope(scope);
        S.countDraft = { id: uid(), scope, scopeLabel: label, startedAt: nowISO(), staff: S.staff, lines: codes.map((c) => ({ code: c, counted: '' })) };
        save(); rerender();
      };
      return;
    }
    const done = d.lines.filter((x) => x.counted !== '').length;
    view(`
      <div class="row between"><h1 style="margin:0">清点：${esc(d.scopeLabel)}</h1></div>
      <div class="small muted">开始于 ${esc(fmtTime(d.startedAt))} · ${esc(d.staff)} · 已填 <span id="doneN">${done}</span>/${d.lines.length}</div>
      <div class="progress"><div style="width:${d.lines.length ? (done / d.lines.length * 100) : 0}%"></div></div>
      <div class="row" style="margin:10px 0"><input id="addCode" type="text" placeholder="加一个款号到清点列表" class="grow" autocapitalize="characters"><button class="btn small" id="addCodeBtn">加入</button></div>
      <div class="card" id="lines">
        <div class="count-line small muted" style="padding-top:0"><div>款号 / 货位</div><div class="sys">系统</div><div style="text-align:center">实数</div></div>
        ${d.lines.map((x, i) => {
          const p = P[x.code];
          return `<div class="count-line">
            <div><span class="code">${esc(x.code)}</span> <span class="diff" id="diff${i}"></span>
              <div class="small muted">${esc(shortName(p ? p.name : '（Vend 无记录）'))}</div>
              <div class="small">${(codeLocs[x.code] || []).map((id) => esc(locLabel(locById[id]))).join(' · ')}</div></div>
            <div class="sys"><b>${p ? p.qty : '—'}</b></div>
            <input type="number" inputmode="numeric" min="0" data-i="${i}" value="${esc(x.counted)}" aria-label="${esc(x.code)} 实际数量">
          </div>`;
        }).join('')}
      </div>
      <div class="sticky-actions row">
        <button class="btn danger" id="cancelBtn">放弃</button>
        <button class="btn primary grow" id="finishBtn">完成清点（${done} 款）</button>
      </div>
    `);
    const showDiff = (i) => {
      const x = d.lines[i]; const p = P[x.code]; const el = $('#diff' + i);
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
        showDiff(i);
        save();
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
      d.lines.push({ code: c, counted: '' }); save(); rerender();
    };
    $('#cancelBtn').onclick = () => { if (confirm('放弃这次清点？已填的数字会清空。')) { S.countDraft = null; save(); rerender(); } };
    $('#finishBtn').onclick = () => {
      const lines = d.lines.filter((x) => x.counted !== '').map((x) => {
        const p = P[x.code]; const sys = p ? p.qty : 0;
        return { code: x.code, name: p ? p.name : '', system: sys, counted: Number(x.counted), diff: Number(x.counted) - sys };
      });
      if (!lines.length) { toast('还没有填任何数量'); return; }
      const skipped = d.lines.length - lines.length;
      if (skipped && !confirm(`还有 ${skipped} 款没有填，确定完成吗？（没填的不会记录）`)) return;
      const rec = { id: d.id, date: nowISO(), staff: S.staff, scope: d.scope, scopeLabel: d.scopeLabel, vendAt: S.vendImportedAt, lines };
      S.counts.unshift(rec);
      if (S.counts.length > 400) S.counts.length = 400;
      S.countDraft = null;
      addLog('count', { scopeLabel: d.scopeLabel, n: lines.length, diffs: lines.filter((x) => x.diff).length, countId: rec.id });
      save(); location.hash = '#/countReport/' + rec.id;
    };
  }
  function countReportText(c) {
    const diffs = c.lines.filter((x) => x.diff !== 0);
    let t = `【库存清点】${fmtTime(c.date)}\n范围：${c.scopeLabel}\n清点人：${c.staff}\n共清点 ${c.lines.length} 款，${diffs.length ? diffs.length + ' 款有差异：' : '全部和系统相符 ✅'}\n`;
    diffs.forEach((x) => { t += `- ${x.code} ${shortName(x.name)}：系统 ${x.system} / 实际 ${x.counted}（${x.diff > 0 ? '多' : '少'} ${Math.abs(x.diff)}）\n`; });
    return t;
  }
  function viewCountReport([id]) {
    const c = S.counts.find((x) => x.id === id);
    if (!c) { view('<div class="empty-state">找不到这次清点</div>'); return; }
    const diffs = c.lines.filter((x) => x.diff !== 0);
    view(`
      <a href="#/count" class="small">‹ 清点</a>
      <h1>清点报告</h1>
      <div class="card"><b>${esc(c.scopeLabel)}</b><div class="small muted">${esc(fmtTime(c.date))} · ${esc(c.staff)} · Vend 数据时间 ${esc(fmtTime(c.vendAt))}</div>
        <div class="row" style="margin-top:8px">${diffs.length ? `<span class="pill bad">${diffs.length} 款有差异</span>` : '<span class="pill ok">全部相符</span>'}<span class="pill grey">共 ${c.lines.length} 款</span></div></div>
      <div class="row"><button class="btn primary" id="copyBtn">📋 复制差异报告</button><button class="btn" id="csvBtn">⬇️ 下载 Excel(CSV)</button></div>
      <h2>${diffs.length ? '差异' : '明细'}</h2>
      <div class="card"><table class="list"><tr><th>款号</th><th class="num">系统</th><th class="num">实际</th><th class="num">差异</th></tr>
        ${(diffs.length ? diffs : c.lines).map((x) => `<tr><td><span class="code">${esc(x.code)}</span><div class="small muted">${esc(shortName(x.name))}</div></td><td class="num">${x.system}</td><td class="num">${x.counted}</td><td class="num"><span class="diff ${x.diff > 0 ? 'plus' : x.diff < 0 ? 'minus' : 'zero'}">${x.diff > 0 ? '+' : ''}${x.diff}</span></td></tr>`).join('')}
      </table></div>
      ${diffs.length ? `<details><summary class="small">查看全部 ${c.lines.length} 款</summary><div class="card"><table class="list">${c.lines.map((x) => `<tr><td class="code">${esc(x.code)}</td><td class="num">${x.system}</td><td class="num">${x.counted}</td><td class="num">${x.diff}</td></tr>`).join('')}</table></div></details>` : ''}
      <button class="btn small danger" id="delCount" style="margin-top:14px">删除这次记录</button>
    `);
    $('#copyBtn').onclick = () => copyText(countReportText(c));
    $('#csvBtn').onclick = () => download(`清点_${fmtTime(c.date).replace(/[: ]/g, '-')}.csv`, toCSV([['日期', '清点人', '范围', '款号', '名称', '系统数量', '实际数量', '差异'], ...c.lines.map((x) => [fmtTime(c.date), c.staff, c.scopeLabel, x.code, x.name, x.system, x.counted, x.diff])]));
    $('#delCount').onclick = () => { if (confirm('删除这次清点记录？')) { S.counts = S.counts.filter((x) => x.id !== id); save(); location.hash = '#/count'; } };
  }

  // ---------------------------------------------------------------- returns
  let retFilter = 'pending';
  function viewReturns(_, params) {
    const pre = params.get('c') || '';
    const list = S.returns.filter((r) => retFilter === 'all' || r.status === retFilter);
    view(`
      <h1>退库</h1>
      <div class="card stack">
        <b>登记一笔退库</b>
        <label class="field">款号<input id="rCode" type="text" value="${esc(pre)}" placeholder="例如 AS2115" autocapitalize="characters"></label>
        <div id="rHint" class="small muted"></div>
        <div class="row">
          <label class="field grow">尺码 / 颜色<input id="rSize" type="text" placeholder="例如 38 CHOC"></label>
          <label class="field" style="width:90px">数量<input id="rQty" type="number" min="1" value="1" inputmode="numeric"></label>
        </div>
        <label class="field">原因<select id="rReason">${RETURN_REASONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
        <label class="field">备注<input id="rNote" type="text" placeholder="可不填，例如 箱号 / 退货单号"></label>
        <button class="btn primary" id="rAdd">＋ 加入退库清单</button>
      </div>
      <div class="seg">
        <button data-f="pending" class="${retFilter === 'pending' ? 'on' : ''}">待退 (${S.returns.filter((r) => r.status === 'pending').length})</button>
        <button data-f="sent" class="${retFilter === 'sent' ? 'on' : ''}">已寄出</button>
        <button data-f="all" class="${retFilter === 'all' ? 'on' : ''}">全部</button>
      </div>
      ${list.length ? `<div class="card"><table class="list"><tr><th>款号</th><th>尺码</th><th class="num">数量</th><th></th></tr>
        ${list.map((r) => `<tr>
          <td><span class="code">${esc(r.code)}</span><div class="small muted">${esc(shortName(r.name))}</div><div class="small muted">${esc(r.reason)}${r.note ? ' · ' + esc(r.note) : ''}<br>${esc(fmtTime(r.date))} · ${esc(r.staff)}${r.sentAt ? '<br>寄出 ' + esc(fmtTime(r.sentAt)) + ' · ' + esc(r.sentBy) : ''}</div></td>
          <td>${esc(r.size)}</td><td class="num"><b>${r.qty}</b></td>
          <td style="text-align:right">${r.status === 'pending' ? `<button class="btn small" data-sent="${r.id}">已寄出</button>` : '<span class="pill ok">已寄出</span>'}<br><button class="btn small danger" data-del="${r.id}" style="margin-top:4px">删除</button></td>
        </tr>`).join('')}</table></div>
        <div class="row"><button class="btn primary" id="rCopy">📋 复制清单</button><button class="btn" id="rCsv">⬇️ 下载 Excel(CSV)</button>${retFilter === 'pending' ? '<button class="btn" id="rAllSent">全部标记为已寄出</button>' : ''}</div>`
        : '<div class="empty-state">清单是空的</div>'}
      <p class="small muted">提示：寄出后记得在 Vend 里做对应的库存调整，下次导入 Vend 数据时库存数就会更新。</p>
    `);
    const rc = $('#rCode');
    const hint = () => {
      const c = resolveCode(rc.value); const p = P[c];
      $('#rHint').innerHTML = !rc.value ? '' : p ? `✔ ${esc(p.name)} · 库存 ${p.qty}${codeLocs[c] ? ' · 位置：' + codeLocs[c].map((id) => esc(locLabel(locById[id]))).join('、') : ''}` : '⚠️ Vend 中没有这个款号';
    };
    rc.addEventListener('input', hint); hint();
    $$('.seg button').forEach((b) => b.onclick = () => { retFilter = b.dataset.f; rerender(); });
    $('#rAdd').onclick = () => {
      const code = resolveCode(rc.value);
      const qty = parseInt($('#rQty').value, 10);
      if (!code) { toast('请输入款号'); return; }
      if (!(qty > 0)) { toast('数量要大于 0'); return; }
      if (!ensureStaff()) return;
      const p = P[code];
      const r = { id: uid(), date: nowISO(), staff: S.staff, code, name: p ? p.name : '', size: $('#rSize').value.trim(), qty, reason: $('#rReason').value, note: $('#rNote').value.trim(), status: 'pending' };
      S.returns.unshift(r);
      addLog('return', { code, qty, size: r.size, reason: r.reason });
      save(); toast('已加入退库清单'); location.hash = '#/returns'; rerender();
    };
    $$('[data-sent]').forEach((b) => b.onclick = () => {
      if (!ensureStaff()) return;
      const r = S.returns.find((x) => x.id === b.dataset.sent);
      r.status = 'sent'; r.sentAt = nowISO(); r.sentBy = S.staff;
      addLog('return-sent', { code: r.code, qty: r.qty, size: r.size });
      save(); rerender();
    });
    $$('[data-del]').forEach((b) => b.onclick = () => {
      if (!ensureStaff() || !confirm('删除这条退库记录？')) return;
      const r = S.returns.find((x) => x.id === b.dataset.del);
      S.returns = S.returns.filter((x) => x !== r);
      addLog('return-del', { code: r.code, qty: r.qty, size: r.size });
      save(); rerender();
    });
    const copyBtn = $('#rCopy');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const total = list.reduce((a, r) => a + r.qty, 0);
        copyText(`【退库清单】${today()}  共 ${list.length} 条 / ${total} 件\n` + list.map((r) => `- ${r.code} ${shortName(r.name)} ${r.size} × ${r.qty}（${r.reason}${r.note ? '，' + r.note : ''}）`).join('\n'));
      };
      $('#rCsv').onclick = () => download(`退库清单_${today()}.csv`, toCSV([['登记日期', '登记人', '款号', '名称', '尺码/颜色', '数量', '原因', '备注', '状态', '寄出时间', '寄出人'], ...list.map((r) => [fmtTime(r.date), r.staff, r.code, r.name, r.size, r.qty, r.reason, r.note, r.status === 'pending' ? '待退' : '已寄出', fmtTime(r.sentAt), r.sentBy || ''])]));
      const all = $('#rAllSent');
      if (all) all.onclick = () => {
        if (!ensureStaff() || !confirm(`把 ${list.length} 条全部标记为已寄出？`)) return;
        list.forEach((r) => { r.status = 'sent'; r.sentAt = nowISO(); r.sentBy = S.staff; });
        addLog('return-sent', { n: list.length });
        save(); rerender();
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
    view(`
      <a href="#/more" class="small">‹ 更多</a>
      <h1>库存总览</h1>
      <div class="small muted">共 ${S.products.length} 款 · 总件数 ${total} · Vend 数据 ${esc(fmtTime(S.vendImportedAt))}</div>
      <div class="seg" style="margin-top:10px">
        <button data-f="all" class="${f === 'all' ? 'on' : ''}">全部</button>
        <button data-f="low" class="${f === 'low' ? 'on' : ''}">偏低</button>
        <button data-f="noloc" class="${f === 'noloc' ? 'on' : ''}">没货位</button>
        <button data-f="zero" class="${f === 'zero' ? 'on' : ''}">卖完了</button>
      </div>
      <div class="small muted" style="margin-bottom:8px">${{ all: '按库存从多到少排列', low: `库存 1–${S.lowStock} 件的款，考虑补货`, noloc: '有库存但货位表里没有，点进去登记货位', zero: '系统显示 0，但货位表里还有它——可以考虑把位置腾出来' }[f]}</div>
      <input id="filter" type="search" placeholder="筛选款号或名字">
      <div class="card" style="margin-top:8px"><table class="list" id="stockTable"><tr><th>款号</th><th class="num">库存</th></tr>
        ${rows.map((p) => `<tr data-k="${esc((p.code + ' ' + p.name).toLowerCase())}"><td><a href="#/product/${encodeURIComponent(p.code)}" style="text-decoration:none"><span class="code">${esc(p.code)}</span></a><div class="small muted">${esc(p.name)}</div><div>${(codeLocs[p.code] || []).map((id) => locChip(id, p.code)).join('')}</div></td><td class="num"><b class="${p.qty <= 0 ? 'qty zero' : ''}">${p.qty}</b></td></tr>`).join('')}
      </table></div>
      ${unknown.length && f === 'all' ? `<h2>货位表里有，但 Vend 没有的款号</h2><div class="card small">${unknown.map((c) => `<a href="#/product/${encodeURIComponent(c)}" class="code">${esc(c)}</a>`).join(' · ')}<div class="muted" style="margin-top:6px">可能是款号写错了，或者已经卖完从系统里下架。</div></div>` : ''}
      <button class="btn small" id="csvStock">⬇️ 下载这张表 (CSV)</button>
    `);
    $$('.seg button').forEach((b) => b.onclick = () => { location.hash = '#/stock?f=' + b.dataset.f; });
    $('#filter').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('#stockTable tr[data-k]').forEach((tr) => { tr.style.display = tr.dataset.k.includes(q) ? '' : 'none'; });
    });
    $('#csvStock').onclick = () => download(`库存_${today()}.csv`, toCSV([['款号', '名称', '系统库存', '货位'], ...rows.map((p) => [p.code, p.name, p.qty, (codeLocs[p.code] || []).map((id) => locLabel(locById[id])).join(' | ')])]));
  }

  // ---------------------------------------------------------------- Vend import
  function viewImport() {
    view(`
      <a href="#/more" class="small">‹ 更多</a>
      <h1>导入 Vend 库存</h1>
      <div class="card">
        <ol class="sop small">
          <li>在 Vend（Lightspeed）后台导出库存报表（Inventory → period end count / 库存报表），下载 Excel (.xlsx) 或 CSV</li>
          <li>点下面的按钮选择这个文件</li>
          <li>表格里要有 <b>Tag</b>（款号）和 <b>Current Inventory</b>（当前库存）两列</li>
        </ol>
        <input type="file" id="file" accept=".xlsx,.xls,.csv" style="margin-top:8px">
        <div id="impResult" style="margin-top:10px"></div>
      </div>
      <div class="small muted">上次导入：${esc(fmtTime(S.vendImportedAt)) || '—'}。导入只会更新库存数字，不会改动货位。</div>
    `);
    $('#file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!window.XLSX) { toast('表格读取组件还没加载完，请稍等再试'); return; }
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        const products = parseVendRows(rows);
        if (!products.length) throw new Error('没找到 Tag / Current Inventory 列');
        const before = {}; S.products.forEach((p) => { before[p.code] = p.qty; });
        const changed = products.filter((p) => before[p.code] !== undefined && before[p.code] !== p.qty);
        const added = products.filter((p) => before[p.code] === undefined);
        if (!ensureStaff()) return;
        S.products = products;
        S.vendImportedAt = nowISO();
        addLog('import', { file: file.name, n: products.length, changed: changed.length, added: added.length });
        save();
        $('#impResult').innerHTML = `<div class="pill ok">导入成功</div>
          <p class="small">共 ${products.length} 款；库存变化 ${changed.length} 款；新款 ${added.length} 款。</p>
          ${added.length ? `<p class="small"><b>新款（记得登记货位）：</b>${added.map((p) => `<a href="#/product/${encodeURIComponent(p.code)}" class="code">${esc(p.code)}</a>`).join(' · ')}</p>` : ''}
          ${changed.length ? `<details><summary class="small">查看变化</summary><table class="list small">${changed.map((p) => `<tr><td class="code">${esc(p.code)}</td><td>${before[p.code]} → <b>${p.qty}</b></td></tr>`).join('')}</table></details>` : ''}`;
      } catch (err) {
        console.error(err);
        $('#impResult').innerHTML = `<div class="pill bad">导入失败</div><p class="small">${esc(err.message)}</p>`;
      }
    };
  }
  function parseVendRows(rows) {
    let h = -1, cols = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map((x) => String(x).trim().toLowerCase());
      const tag = r.findIndex((x) => x === 'tag' || x === 'sku' || x === 'tags');
      const cur = r.findIndex((x) => x === 'current inventory' || x === 'inventory' || x === 'current stock');
      if (tag >= 0 && cur >= 0) {
        h = i;
        cols = { tag, cur, name: r.findIndex((x) => x === 'product' || x === 'name'), closing: r.findIndex((x) => x === 'closing inventory'), last: r.findIndex((x) => x.startsWith('last received')) };
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
  const LOG_TYPES = { move: '移动', add: '添加', remove: '删除', note: '改备注', rename: '改名', newloc: '新位置', delloc: '删位置', count: '清点', return: '退库登记', 'return-sent': '退库寄出', 'return-del': '删退库', import: '导入 Vend', restore: '恢复备份' };
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
      case 'restore': return `从备份文件恢复数据`;
      default: return JSON.stringify(d);
    }
  }
  function logLine(g) {
    return `<div class="small" style="padding:5px 0;border-top:1px solid var(--line)"><span class="pill grey">${esc(LOG_TYPES[g.type] || g.type)}</span> ${esc(logText(g))}<div class="muted">${esc(fmtTime(g.t))} · <b>${esc(g.staff)}</b></div></div>`;
  }
  function viewLog(_, params) {
    const t = params.get('t') || '';
    const list = S.log.filter((g) => !t || g.type === t);
    view(`
      <a href="#/more" class="small">‹ 更多</a>
      <h1>修改记录</h1>
      <select id="lt"><option value="">全部类型</option>${Object.entries(LOG_TYPES).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <div class="card" style="margin-top:8px">${list.slice(0, 300).map(logLine).join('') || '<span class="muted small">暂无记录</span>'}</div>
      <button class="btn small" id="csvLog">⬇️ 下载全部记录 (CSV)</button>
    `);
    $('#lt').onchange = (e) => { location.hash = '#/log?t=' + e.target.value; };
    $('#csvLog').onclick = () => download(`修改记录_${today()}.csv`, toCSV([['时间', '操作人', '类型', '内容'], ...S.log.map((g) => [fmtTime(g.t), g.staff, LOG_TYPES[g.type] || g.type, logText(g)])]));
  }

  // ---------------------------------------------------------------- more / settings / backup
  function viewMore() {
    view(`
      <h1>更多</h1>
      <div class="card stack">
        <a class="btn block" href="#/stock">📊 库存总览</a>
        <a class="btn block" href="#/import">⬆️ 导入 Vend 库存</a>
        <a class="btn block" href="#/log">🕑 修改记录（谁改了什么）</a>
      </div>
      <div class="card stack">
        <b>设置</b>
        <label class="field">我的名字（每次修改都会记录）<input id="staff" type="text" value="${esc(S.staff)}" placeholder="例如 Rebecca"></label>
        <label class="field">库存偏低提醒：少于等于几件<input id="low" type="number" min="1" value="${S.lowStock}"></label>
        <button class="btn primary" id="saveSet">保存设置</button>
      </div>
      <div class="card stack">
        <b>备份 / 换手机</b>
        <div class="small muted">数据只存在这台设备的浏览器里。建议每周下载一次备份；换手机或给同事用时，在新设备上「从备份恢复」。</div>
        <div class="row"><button class="btn" id="backup">⬇️ 下载备份</button><label class="btn">⬆️ 从备份恢复<input type="file" id="restore" accept=".json" hidden></label></div>
        <button class="btn small danger" id="reset">恢复成最初的货位表（会清空所有记录）</button>
      </div>
      <p class="small muted">UGG 货位助手 · 数据版本 ${esc(fmtTime((window.SEED_DATA || {}).generated))}</p>
    `);
    $('#saveSet').onclick = () => {
      S.staff = $('#staff').value.trim();
      S.lowStock = Math.max(1, parseInt($('#low').value, 10) || 3);
      save(); renderStaff(); toast('已保存');
    };
    $('#backup').onclick = () => download(`ugg货位备份_${today()}.json`, JSON.stringify(S, null, 1), 'application/json');
    $('#restore').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.locations || !data.products) throw new Error('不是这个应用的备份文件');
        if (!confirm('用备份覆盖这台设备上的数据？')) return;
        const me = S.staff;
        S = Object.assign(freshState(), data);
        S.staff = me || S.staff;
        addLog('restore', { file: f.name });
        save(); renderStaff(); toast('已恢复'); rerender();
      } catch (err) { toast('恢复失败：' + err.message); }
    };
    $('#reset').onclick = () => {
      if (!confirm('确定恢复成最初的货位表吗？所有修改、清点、退库记录都会被清空。建议先下载备份。')) return;
      const me = S.staff;
      S = freshState(); S.staff = me;
      save(); toast('已恢复初始数据'); rerender();
    };
  }

  // ---------------------------------------------------------------- printing
  function printSheets() {
    let html = `<h3>STOREROOM LOCATION · 打印于 ${esc(fmtTime(nowISO()))}</h3>`;
    const units = [...new Set(S.locations.filter((l) => l.area === 'storeroom').map((l) => l.unit))];
    units.forEach((u) => {
      const cells = S.locations.filter((l) => l.unit === u && l.area === 'storeroom');
      const rows = Math.max(...cells.map((l) => l.row + (l.rowspan || 1)));
      html += `<h3>${esc(unitName(u))}</h3><table>`;
      for (let r = 0; r < rows; r++) {
        html += '<tr>' + cells.filter((l) => l.row === r).sort((a, b) => a.col - b.col).map((l) => `<td rowspan="${l.rowspan || 1}" colspan="${l.colspan || 1}">${l.items.map((it) => esc([it.code, it.note].filter(Boolean).join(' '))).join('<br>')}</td>`).join('') + '</tr>';
      }
      html += '</table>';
    });
    html += `<h3>STORE STOCK LOCATION</h3><table>`;
    S.locations.filter((l) => l.area !== 'storeroom').forEach((l) => {
      html += `<tr><td style="width:25%"><b>${esc(locLabel(l))}</b></td><td>${l.items.map((it) => esc([it.code, it.note].filter(Boolean).join(' '))).join(' / ')}</td></tr>`;
    });
    html += '</table>';
    let pa = $('#printArea');
    if (!pa) { pa = document.createElement('div'); pa.id = 'printArea'; document.body.appendChild(pa); }
    pa.innerHTML = html;
    window.print();
  }

  // ---------------------------------------------------------------- boot
  function renderStaff() {
    const c = $('#staffChip');
    c.textContent = S.staff ? '👤 ' + S.staff : '点这里填名字';
    c.classList.toggle('missing', !S.staff);
  }
  $('#staffChip').onclick = () => {
    const name = (prompt('你的名字（用于记录是谁做的修改）', S.staff) || '').trim();
    if (name) { S.staff = name; save(); renderStaff(); toast('你好，' + name); }
  };
  rebuildIndex();
  renderStaff();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { get state() { return S; }, resolveCode, searchProducts };
})();
