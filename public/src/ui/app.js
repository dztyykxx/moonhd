/**
 * UI 控制器：面板、搜索、信息卡、可见性、沉浸、抽屉、快捷键。
 *
 * 与三维侧的边界：本模块不直接碰 three.js，也不做任何坐标数学，
 * 只通过 main.js 传进来的 `api` 读写场景状态。
 * 三维投影出来的标签由 main.js 每帧推给 renderLabels()，这里只负责摆放 DOM。
 */
import { LAYERS, createVisibilityStore } from './visibility.js';
import {
  formatLat, formatLon, formatLatLon, formatClipboard, parseLatLonInput, looksLikeCoordinates,
} from '../geo/coords.js';
import { formatScaleKm } from '../geo/metrics.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const isEditable = (el) => !!el && (
  el.isContentEditable
  || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const TYPE_LABEL = {
  mare: 'MARE / 月海',
  oceanus: 'OCEANUS / 风暴洋',
  crater: 'CRATER / 陨石坑',
  landing: 'LANDING SITE / 着陆点',
  basin: 'BASIN / 盆地',
  point: 'SELECTED POINT / 选中点',
};

export function createUI(api) {
  const dom = {
    body: document.body,
    topbar: $('#ui-topbar'),
    catalog: $('#ui-catalog'),
    rightcol: $('#ui-rightcol'),
    infocard: $('#ui-infocard'),
    settings: $('#ui-settings'),
    toolbar: $('#ui-toolbar'),
    coordbar: $('#ui-coordbar'),
    zoomtools: $('#ui-zoomtools'),
    overlay: $('#overlay'),
    restore: $('#restore'),
    toast: $('#toast'),
    drawer: $('#drawer'),
    drawerBody: $('#drawer-body'),
    search: $('#search'),
    searchInput: $('#search-input'),
    searchPop: $('#search-results'),
    searchClear: $('#search-clear'),
    placeList: $('#place-list'),
    visList: $('#vis-list'),
  };

  const store = createVisibilityStore();

  const st = {
    places: [],
    facts: null,
    dataError: null,
    category: 'feature',
    selectedId: null,
    selectedPoint: null,        // {lat, lon}
    hover: null,
    center: null,
    labels: [],
    settingsView: 'main',
    searchResults: [],
    searchCursor: -1,
    searchOpen: false,
    mobile: matchMedia('(max-width: 767px)').matches,
    /** 768–1199px 下右侧是否优先展开（择一显示，避免两面夹住月球）。 */
    rightPriority: false,
    drawerTab: 'catalog',
    drawerDetent: 'half',
    spinBeforeFly: true,
    restoreTimer: 0,
    lastRender: 0,
  };

  /* ---------------------------------------------------------------- *
   * 提示
   * ---------------------------------------------------------------- */
  let toastTimer = 0;
  function toast(msg, isErr = false) {
    dom.toast.textContent = msg;
    dom.toast.classList.toggle('is-err', isErr);
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 2200);
  }

  /* ---------------------------------------------------------------- *
   * 数据加载
   * ---------------------------------------------------------------- */
  async function loadData() {
    try {
      const [pr, fr] = await Promise.all([
        fetch('./data/places.json', { cache: 'no-cache' }),
        fetch('./data/moon-facts.json', { cache: 'no-cache' }),
      ]);
      if (!pr.ok) throw new Error(`places.json ${pr.status}`);
      const places = await pr.json();
      st.places = Array.isArray(places.items) ? places.items : [];
      st.meta = places;
      if (fr.ok) st.facts = await fr.json();
    } catch (e) {
      st.dataError = e;
      console.warn('[luna] 地点资料加载失败：', e && e.message);
    }
  }

  const featurePlaces = () => st.places.filter((p) => p.kind !== 'landing');
  const landingPlaces = () => st.places.filter((p) => p.kind === 'landing');
  const placeById = (id) => st.places.find((p) => p.id === id) || null;

  /* ---------------------------------------------------------------- *
   * 地点目录
   * ---------------------------------------------------------------- */
  function renderCatalog() {
    dom.placeList.textContent = '';
    if (st.dataError) {
      const box = el('div', 'sr--empty');
      box.innerHTML = '<b>地点资料不可用</b>无法读取本地 data/places.json。<br />月球渲染与坐标功能不受影响。';
      dom.placeList.append(box);
      return;
    }
    const list = st.category === 'landing' ? landingPlaces() : featurePlaces();
    for (const p of list) {
      const b = el('button', 'place');
      b.type = 'button';
      b.dataset.id = p.id;
      b.setAttribute('role', 'listitem');
      if (p.id === st.selectedId) b.classList.add('is-on');
      const pin = el('span', 'place__pin');
      pin.innerHTML = p.kind === 'landing'
        ? '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 14s4.4-4.6 4.4-8A4.4 4.4 0 1 0 3.6 6c0 3.4 4.4 8 4.4 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="6" r="1.6" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 14s4.4-4.6 4.4-8A4.4 4.4 0 1 0 3.6 6c0 3.4 4.4 8 4.4 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
      const tx = el('span', 'place__tx');
      tx.append(el('span', 'place__t', p.nameZh || p.name));
      tx.append(el('span', 'place__s', p.name || ''));
      b.append(pin, tx);
      if (Number.isFinite(p.latDeg)) {
        b.append(el('span', 'place__meta', `${Math.abs(p.latDeg).toFixed(1)}°${p.latDeg >= 0 ? 'N' : 'S'}`));
      }
      b.addEventListener('click', () => selectPlace(p.id, { fly: true, source: 'catalog' }));
      dom.placeList.append(b);
    }
    if (!list.length) {
      const box = el('div', 'sr--empty');
      box.innerHTML = st.dataError ? '<b>资料不可用</b>' : '<b>暂无收录</b>';
      dom.placeList.append(box);
    }
  }

  function setCategory(cat) {
    st.category = cat;
    $('#cat-feature').classList.toggle('is-on', cat === 'feature');
    $('#cat-feature').setAttribute('aria-selected', String(cat === 'feature'));
    $('#cat-landing').classList.toggle('is-on', cat === 'landing');
    $('#cat-landing').setAttribute('aria-selected', String(cat === 'landing'));
    renderCatalog();
  }

  /* ---------------------------------------------------------------- *
   * 信息卡
   * ---------------------------------------------------------------- */
  function rowsFor(entries) {
    const dl = document.createDocumentFragment();
    for (const [k, v] of entries) {
      if (v == null || v === '') continue;
      const row = el('div');
      row.append(el('dt', 'row__k', k), el('dd', 'row__v', v));
      dl.append(row);
    }
    return dl;
  }

  function showInfo(open) {
    if (!open) { dom.infocard.hidden = true; return; }
    dom.infocard.hidden = false;
  }

  function renderInfoCard() {
    const p = st.selectedId ? placeById(st.selectedId) : null;
    const pt = st.selectedPoint;
    if (!p && !pt) { showInfo(false); return; }
    showInfo(true);
    const rows = $('#info-rows');
    const actions = $('#info-actions');
    rows.textContent = '';
    actions.textContent = '';

    if (p) {
      $('#info-kicker').textContent = TYPE_LABEL[p.kind === 'landing' ? 'landing' : (p.type || 'crater')] || TYPE_LABEL.crater;
      $('#info-title').textContent = p.nameZh || p.name || '—';
      $('#info-official').textContent = p.name || '';
      const entries = [];
      entries.push(['纬度', Number.isFinite(p.latDeg) ? formatLat(p.latDeg) : null]);
      entries.push(['经度', Number.isFinite(p.lonDeg) ? formatLon(p.lonDeg) : null]);
      if (p.kind === 'landing') {
        if (p.mission) entries.push(['任务', p.mission]);
        if (p.region) entries.push(['区域', p.region]);
        if (p.landingDate) entries.push(['日期', p.landingDate]);
      } else if (Number.isFinite(p.diameterKm)) {
        entries.push(['直径', `${p.diameterKm} km`]);
      }
      rows.append(rowsFor(entries));
      $('#info-desc').textContent = p.summary || '';
      if (Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg)) {
        const b = el('button', 'act');
        b.type = 'button';
        b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 2.4v11.2M2.4 8h11.2" stroke="currentColor" stroke-width="1.2"/></svg><span>定位此处</span>';
        b.addEventListener('click', () => flyToPlace(p, 'card'));
        actions.append(b);
      }
      const c = el('button', 'act act--ghost');
      c.type = 'button';
      c.textContent = '复制坐标';
      c.disabled = !(Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg));
      c.addEventListener('click', () => copyCoords(p.latDeg, p.lonDeg));
      actions.append(c);
      $('#info-src').textContent = p.sourceLabel || '地名来源 · IAU / USGS';
    } else {
      $('#info-kicker').textContent = TYPE_LABEL.point;
      $('#info-title').textContent = pt.matchedName || '月面位置';
      $('#info-official').textContent = '';
      const entries = [
        ['纬度', formatLat(pt.lat)],
        ['经度', formatLon(pt.lon)],
        ['地名', pt.matchedName ? `附近：${pt.matchedName}` : '未匹配已收录地名'],
      ];
      rows.append(rowsFor(entries));
      $('#info-desc').textContent = pt.matchedName
        ? `这里是用户选中的位置。视野中心坐标单独显示。附近地点为最近邻提示，不代表选点落在该地貌范围内。`
        : '这里是用户选中的位置。视野中心坐标单独显示。收录地名之外的月面位置不保证有对应条目。';
      const c = el('button', 'act');
      c.type = 'button';
      c.innerHTML = `<span>复制坐标</span><span style="font-family:var(--mono);font-size:12px;opacity:.85">${formatClipboard(pt.lat, pt.lon)}</span>`;
      c.addEventListener('click', () => copyCoords(pt.lat, pt.lon));
      const l = el('button', 'act act--ghost');
      l.type = 'button';
      l.textContent = '定位到该点';
      l.addEventListener('click', () => api.flyTo(pt.lat, pt.lon, { distance: Math.min(api.distance(), 1.9) }));
      actions.append(c, l);
      $('#info-src').textContent = '经纬度由点击位置实时换算，非测量结果。';
    }
  }

  async function copyCoords(lat, lon) {
    const text = formatClipboard(lat, lon);
    if (!text) { toast('没有可复制的坐标', true); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('execCommand 失败');
      }
      toast(`已复制 ${text}`);
    } catch (e) {
      toast('复制失败，请手动选择坐标', true);
    }
  }

  /* ---------------------------------------------------------------- *
   * 选择地点 / 选点
   * ---------------------------------------------------------------- */
  function selectPlace(id, { fly = false, source = '' } = {}) {
    st.selectedId = id;
    st.selectedPoint = null;
    api.setSelected(id);
    renderCatalog();
    renderInfoCard();
    if (!st.mobile) { st.rightPriority = true; syncNarrowLayout(); }
    if (fly) flyToPlace(placeById(id), source);
    if (st.mobile && source === 'catalog') openDrawer('info', 'half');
  }

  function flyToPlace(p) {
    if (!p || !Number.isFinite(p.latDeg) || !Number.isFinite(p.lonDeg)) {
      toast('该地点缺少已核验坐标，无法定位', true);
      return;
    }
    api.flyTo(p.latDeg, p.lonDeg, { distance: p.zoomDistance || 1.75 });
  }

  function clearSelection() {
    st.selectedId = null;
    st.selectedPoint = null;
    api.setSelected(null);
    api.clearPoint();
    renderCatalog();
    renderInfoCard();
  }

  /** main.js 在用户点击月面时调用。 */
  function onPickPoint(pt) {
    if (!pt) return;
    const near = nearestPlace(pt.lat, pt.lon);
    st.selectedPoint = {
      lat: pt.lat,
      lon: pt.lon,
      matchedName: near && near.distKm <= 260 ? (near.place.nameZh || near.place.name) : null,
    };
    st.selectedId = null;
    api.setSelected(null);
    renderCatalog();
    renderInfoCard();
    if (st.mobile) openDrawer('info', 'half');
  }

  function nearestPlace(lat, lon) {
    let best = null;
    for (const p of st.places) {
      if (!Number.isFinite(p.latDeg) || !Number.isFinite(p.lonDeg)) continue;
      const d = api.separationKm(lat, lon, p.latDeg, p.lonDeg);
      if (!best || d < best.distKm) best = { place: p, distKm: d };
    }
    return best;
  }

  /* ---------------------------------------------------------------- *
   * 搜索
   * ---------------------------------------------------------------- */
  let searchTimer = 0;

  function searchPlaces(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const scored = [];
    for (const p of st.places) {
      const zh = (p.nameZh || '').toLowerCase();
      const en = (p.name || '').toLowerCase();
      const aliases = (p.aliases || []).map((a) => String(a).toLowerCase());
      const mission = (p.mission || '').toLowerCase();
      let score = 0;
      if (zh === s || en === s) score = 100;
      else if (zh.startsWith(s) || en.startsWith(s)) score = 80;
      else if (aliases.some((a) => a === s)) score = 75;
      else if (aliases.some((a) => a.startsWith(s))) score = 60;
      else if (zh.includes(s) || en.includes(s)) score = 45;
      else if (aliases.some((a) => a.includes(s))) score = 35;
      else if (mission.includes(s)) score = 30;
      if (score > 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.p.nameZh || '').localeCompare(b.p.nameZh || '', 'zh'));
    return scored.slice(0, 12).map((x) => x.p);
  }

  function renderSearch() {
    const q = dom.searchInput.value.trim();
    dom.searchClear.hidden = !q;
    if (!q) { closeSearch(); return; }

    const pop = dom.searchPop;
    pop.textContent = '';
    const items = [];

    if (looksLikeCoordinates(q)) {
      const r = parseLatLonInput(q);
      if (r.ok) {
        items.push({ kind: 'coord', lat: r.lat, lon: r.lon, label: formatLatLon(r.lat, r.lon) });
      } else {
        const box = el('div', 'sr--empty sr--err');
        const b = el('b', null, '坐标无效');
        box.append(b, document.createTextNode(r.message));
        pop.append(box);
        pop.hidden = false;
        st.searchOpen = true;
        st.searchResults = [];
        st.searchCursor = -1;
        dom.searchInput.setAttribute('aria-expanded', 'true');
        return;
      }
    }

    const found = searchPlaces(q);
    st.searchResults = [...items, ...found];
    st.searchCursor = st.searchResults.length ? 0 : -1;

    if (!st.searchResults.length) {
      const box = el('div', 'sr--empty');
      const b = el('b', null, '未找到该地点');
      box.append(b, document.createTextNode('试试正式名称或输入经纬度。'));
      pop.append(box);
    } else {
      st.searchResults.forEach((r, i) => {
        const b = el('button', 'sr');
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.dataset.i = String(i);
        if (i === st.searchCursor) b.classList.add('is-cursor');
        if (r.kind === 'coord') {
          b.append(el('span', 'sr__k', '坐标定位'), el('span', 'sr__t', r.label));
        } else {
          b.append(el('span', 'sr__k', r.kind === 'landing' ? '任务' : '地貌'));
          b.append(el('span', 'sr__t', r.nameZh || r.name));
          b.append(el('span', 'sr__s', r.latDeg != null ? formatLatLon(r.latDeg, r.lonDeg) : '坐标待核验'));
        }
        b.addEventListener('click', () => commitSearch(i));
        pop.append(b);
      });
      const hint = el('div', 'sr-hint');
      hint.textContent = '纬度, 经度 · 支持 N/S/E/W · ↑↓ 选择 · Enter 定位';
      pop.append(hint);
    }
    pop.hidden = false;
    st.searchOpen = true;
    dom.searchInput.setAttribute('aria-expanded', 'true');
  }

  function moveCursor(delta) {
    if (!st.searchResults.length) return;
    st.searchCursor = (st.searchCursor + delta + st.searchResults.length) % st.searchResults.length;
    $$('.sr', dom.searchPop).forEach((n, i) => n.classList.toggle('is-cursor', i === st.searchCursor));
    const cur = $(`.sr[data-i="${st.searchCursor}"]`, dom.searchPop);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function commitSearch(i) {
    const r = st.searchResults[i];
    if (!r) return;
    if (r.kind === 'coord') {
      api.flyTo(r.lat, r.lon, { distance: Math.min(api.distance(), 1.9) });
      st.selectedId = null;
      st.selectedPoint = { lat: r.lat, lon: r.lon, matchedName: null };
      const near = nearestPlace(r.lat, r.lon);
      if (near && near.distKm <= 260) st.selectedPoint.matchedName = near.place.nameZh || near.place.name;
      renderCatalog();
      renderInfoCard();
      toast(`已定位 ${formatLatLon(r.lat, r.lon)}`);
    } else {
      selectPlace(r.id, { fly: true, source: 'search' });
    }
    closeSearch();
    dom.searchInput.blur();
  }

  function closeSearch() {
    st.searchOpen = false;
    st.searchResults = [];
    st.searchCursor = -1;
    dom.searchPop.hidden = true;
    dom.searchInput.setAttribute('aria-expanded', 'false');
  }

  /* ---------------------------------------------------------------- *
   * 三维标签
   * ---------------------------------------------------------------- */
  const labelNodes = new Map();

  function renderLabels(list) {
    st.labels = list;
    const seen = new Set();
    // 避让规则：地名/选点标签优先占位；经纬网与极点标签撞上就整体隐藏，
    // 避免近距时坐标标签糊在地名上。
    const placed = [];
    const sorted = [...list].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    for (const l of sorted) {
      seen.add(l.id);
      let node = labelNodes.get(l.id);
      if (!node) {
        node = el('div', `lbl lbl--${l.kind}`);
        if (l.kind === 'place') node.append(el('span', 'lbl__dot'));
        if (l.kind === 'point') node.append(el('span', 'lbl__ring'));
        node.append(el('span', 'lbl__t'));
        dom.overlay.append(node);
        labelNodes.set(l.id, node);
      }
      const txt = node.querySelector('.lbl__t');
      if (txt.textContent !== l.text) txt.textContent = l.text;
      node.classList.toggle('is-active', !!l.active);

      const boxW = l.text ? Math.max(22, l.text.length * 13) : 16;
      const box = { x: l.x - boxW / 2, y: l.y - 9, w: boxW, h: 18 };
      const hit = placed.some((p) => Math.abs(p.x - box.x) < (p.w + box.w) / 2
        && Math.abs(p.y - box.y) < (p.h + box.h) / 2);
      if (hit && (l.kind === 'grid' || l.kind === 'pole')) {
        node.style.opacity = '0';
        node.style.transform = 'translate(-9999px,-9999px)';
        continue;
      }
      placed.push(box);

      node.style.transform = `translate(${Math.round(l.x)}px,${Math.round(l.y)}px) translate(-50%,-50%)`;
      node.style.opacity = l.dim ? '0.45' : '1';
    }
    for (const [id, node] of labelNodes) {
      if (!seen.has(id)) { node.remove(); labelNodes.delete(id); }
    }
  }

  /* ---------------------------------------------------------------- *
   * 设置面板
   * ---------------------------------------------------------------- */
  const VIEWS = {
    main: '#view-main',
    phase: '#view-phase',
    layers: '#view-layers',
    data: '#view-data',
    spin: '#view-spin',
    axis: '#view-axis',
    grid: '#view-grid',
    visibility: '#view-visibility',
    facts: '#view-facts',
  };

  function showView(name, { open = true } = {}) {
    st.settingsView = name;
    for (const [k, sel] of Object.entries(VIEWS)) {
      const n = $(sel);
      if (n) n.hidden = k !== name;
    }
    if (open) openSettings(true);
    if (name === 'visibility') renderVisibilityList();
    if (name === 'facts') renderFacts();
    if (name === 'data') updateStats();
  }

  function openSettings(on) {
    dom.settings.hidden = !on;
    $('#nav-settings').classList.toggle('is-on', on);
    $('#nav-settings').setAttribute('aria-pressed', String(on));
    if (on) {
      st.rightPriority = true;
      syncNarrowLayout();
    }
    if (on && st.mobile) openDrawer('settings', 'half');
  }

  /**
   * 768–1199px：左右面板择一展开，避免两边夹住月球。
   * 哪一侧优先由最近一次操作决定（打开设置/信息卡 = 右侧，点探索 = 左侧）。
   */
  function syncNarrowLayout() {
    const narrow = innerWidth >= 768 && innerWidth < 1200;
    if (!narrow) {
      dom.body.classList.remove('narrow-right', 'narrow-left');
      return;
    }
    const rightOpen = st.rightPriority;
    dom.body.classList.toggle('narrow-right', rightOpen);
    dom.body.classList.toggle('narrow-left', !rightOpen);
  }

  function bindSwitch(id, get, set) {
    const n = $(id);
    if (!n) return;
    n.addEventListener('click', () => set(!get()));
    return n;
  }

  function syncSwitch(id, on) {
    const n = $(id);
    if (!n) return;
    n.setAttribute('aria-checked', String(!!on));
  }

  function renderVisibilityList() {
    dom.visList.textContent = '';
    for (const layer of LAYERS) {
      const row = el('div', 'row');
      row.append(el('span', 'row__k', layer.label));
      const sw = el('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(store.preferred(layer.key)));
      sw.setAttribute('aria-label', layer.label);
      sw.append(el('i'));
      sw.addEventListener('click', () => store.toggle(layer.key));
      row.append(sw);
      dom.visList.append(row);
    }
  }

  /**
   * 月相预设：角度由 main.js 按模型的固定朝向解出（参考方位角 φ 决定），
   * 不写死在 HTML 里，避免以后调了月球初始朝向而预设悄悄错位。
   */
  function applyPhasePresets() {
    const map = { new: '新月', first: '上弦', full: '满月', last: '下弦' };
    const p = api.phasePresets ? api.phasePresets() : null;
    if (!p) return;
    for (const b of $$('.preset')) {
      const key = Object.keys(map).find((k) => map[k] === b.textContent.trim());
      if (!key || !Number.isFinite(p[key])) continue;
      const v = Math.round(p[key] * 10) / 10;
      b.dataset.phase = String(v);
      b.title = `光照角度 ${v}°（参考视角 0°N·0°E 实测）`;
    }
  }

  /** 月相面板的来源链接（数据加载完成后填充）。 */
  function applyPhaseSource() {    const src = $('#phase-src');
    const ph = st.facts && st.facts.phases;
    if (!src) return;
    if (!ph || !ph.sourceUrl) { src.textContent = ph ? (ph.caveat || '') : ''; return; }
    const a = el('a', 'link', ph.sourceLabel || '月相定义来源');
    a.href = ph.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    src.textContent = '';
    src.append(a);
    src.title = [ph.caveat, ph.seenFrom].filter(Boolean).join('\n');
  }

  function renderFacts() {
    const box = $('#facts-rows');
    box.textContent = '';
    const links = $('#facts-links');
    links.textContent = '';
    if (!st.facts) {
      box.append(rowsFor([['状态', '资料不可用']]));
      return;
    }
    for (const f of st.facts.facts || []) {
      const row = rowsFor([[f.label, f.display || (f.value != null ? `${f.value} ${f.unit || ''}`.trim() : '—')]]);
      box.append(row);
      if (f.note) {
        const n = el('p', 'hint');
        n.style.marginTop = '0';
        n.style.marginBottom = '10px';
        n.textContent = f.note;
        box.append(n);
      }
    }
    for (const l of st.facts.links || []) {
      const a = el('a', 'link', l.label);
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const p = el('p', 'src');
      p.append(a);
      links.append(p);
    }
    if (st.facts.sourceNote) $('#facts-src').textContent = st.facts.sourceNote;
  }

  /* ---------------------------------------------------------------- *
   * 运行数据
   * ---------------------------------------------------------------- */
  function updateStats() {
    if (dom.settings.hidden || st.settingsView !== 'data') return;
    const s = api.stats();
    $('#data-quality').textContent = s.baseRes ? `${s.baseRes} × ${s.baseRes / 2}` : '—';
    const qb = $('#quality-note');
    if (qb) {
      qb.textContent = s.baseRes >= 8192
        ? '当前使用 8K 底图（整球视角下比高清瓦片更完整）'
        : `当前底图 ${s.baseRes / 1024}K；可在上方"底图画质"切到 8K（本机为${s.autoIsMobile ? '窄屏' : '桌面'}自动档）`;
    }
    $('#data-detail').textContent = s.detailToggle
      ? (s.detailActive ? `按需加载 · L${s.order}` : '待命（放大后启用）')
      : '已关闭';
    $('#data-maxorder').textContent = `L${s.maxOrder} · 约 ${s.metersPerPx} m/px`;
    $('#data-tiles').textContent = `${s.ready} / ${s.tiles}${s.pending ? ` · 队列 ${s.pending}` : ''}`;
    $('#data-fps').textContent = s.fps ? `${s.fps} FPS` : '—';
    $('#data-mem').textContent = `${s.bytesText} / ${s.memBudgetText}`;
    $('#data-persist').textContent = s.persistent
      ? `${s.persistBytesText} / ${s.persistBudgetText}`
      : '不可用（无 IndexedDB）';
    $('#data-req').textContent = `${s.requests}（内存命中 ${s.memoryHits} · 本地命中 ${s.persistentHits}）`;
    $('#status-imagery').textContent = s.statusText;
    $('#status-dot').style.background = s.dotColor;
  }

  function updateCoordBar() {
    $('#coord-center').textContent = st.center ? formatLatLon(st.center.lat, st.center.lon) : '—';
    $('#coord-hover').textContent = st.hover ? formatLatLon(st.hover.lat, st.hover.lon) : '—';
    const north = api.northAngle();
    const wrap = $('#north-wrap');
    if (north == null) wrap.hidden = true;
    else {
      wrap.hidden = false;
      $('#north-arrow').style.transform = `rotate(${north.toFixed(1)}deg)`;
    }
    const sc = api.localScale();
    const sw = $('#scale-wrap');
    if (!sc) sw.hidden = true;
    else {
      sw.hidden = false;
      $('#scale-bar').style.width = `${Math.round(sc.px)}px`;
      $('#scale-v').textContent = formatScaleKm(sc.km);
    }
    // 状态栏：始终反映实际运行状态（不是设计稿样例）
    const s = api.stats();
    $('#status-imagery').textContent = s.statusText;
    $('#status-dot').style.background = s.dotColor;
    // 月相比例随镜头变化，所以周期性刷新
    $('#phase-ratio').textContent = api.phaseRatioText();
  }

  /* ---------------------------------------------------------------- *
   * 沉浸 / 恢复
   * ---------------------------------------------------------------- */
  function showRestoreTemporarily(ms = 2500) {
    if (!store.immersive) return;
    dom.restore.hidden = false;
    clearTimeout(st.restoreTimer);
    st.restoreTimer = setTimeout(() => { dom.restore.hidden = true; }, ms);
  }

  function exitImmersive({ focusSafe = true } = {}) {
    if (!store.immersive) return;
    store.setImmersive(false);
    dom.restore.hidden = true;
    if (focusSafe) $('#nav-explore').focus({ preventScroll: true });
  }

  function toggleImmersive() {
    if (store.immersive) exitImmersive();
    else {
      store.setImmersive(true);
      // 焦点若落在即将隐藏的面板里，先转移出去
      if (dom.body.contains(document.activeElement) && document.activeElement !== dom.body
        && !isEditable(document.activeElement)) {
        document.activeElement.blur();
      }
      toast('已进入沉浸模式 · 移动鼠标或轻触可显示恢复入口');
    }
  }

  /** 全部隐藏也要能恢复：打开可见性管理并退出沉浸。 */
  function emergencyRestore() {
    store.setImmersive(false);
    if (store.allHidden()) store.reset();
    showView('visibility');
    openSettings(true);
    dom.restore.hidden = true;
    $('#nav-settings').focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- *
   * 手机抽屉
   * ---------------------------------------------------------------- */
  function isMobile() { return matchMedia('(max-width: 767px)').matches; }

  function layoutPanels() {
    const mob = isMobile();
    st.mobile = mob;
    if (mob) {
      if (dom.drawer.hidden) dom.drawer.hidden = false;
      placeInDrawer(st.drawerTab);
    } else {
      dom.drawer.hidden = true;
      dom.body.classList.remove('drawer-open');
      dom.rightcol.append(dom.infocard, dom.settings);
      // 目录可能正被抽屉托管（已从 DOM 上摘下来），必须用缓存引用判断，
      // 重新 querySelector 会拿到 null。
      if (!dom.catalog.isConnected) dom.body.append(dom.catalog);
    }
  }

  function placeInDrawer(tab) {
    st.drawerTab = tab;
    $$('.dtab', dom.drawer).forEach((n) => {
      const on = n.id === `dtab-${tab}`;
      n.classList.toggle('is-on', on);
      if (!n.classList.contains('dtab--close')) n.setAttribute('aria-selected', String(on));
    });
    // 目录面板在移动端回到 body（它有自己的 fixed 定位，被 display:none 隐藏）
    dom.drawerBody.textContent = '';
    if (tab === 'catalog') {
      dom.catalog.hidden = false;
      dom.drawerBody.append(dom.catalog);
    } else if (tab === 'info') {
      dom.drawerBody.append(dom.infocard);
      dom.infocard.hidden = false;
    } else {
      dom.drawerBody.append(dom.settings);
      dom.settings.hidden = false;
    }
  }

  function openDrawer(tab = st.drawerTab, detent = 'half') {
    if (!isMobile()) return;
    dom.drawer.hidden = false;
    st.drawerDetent = detent;
    dom.drawer.dataset.detent = detent;
    dom.body.classList.add('drawer-open');
    placeInDrawer(tab);
  }

  function closeDrawer() {
    dom.drawer.hidden = true;
    dom.body.classList.remove('drawer-open');
  }

  /* ---------------------------------------------------------------- *
   * 键盘
   * ---------------------------------------------------------------- */
  function onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;  // 中文输入法组合中
    const editing = isEditable(document.activeElement);

    if (e.key === 'Escape') {
      if (st.searchOpen) { closeSearch(); e.preventDefault(); return; }
      if (store.immersive) { exitImmersive(); e.preventDefault(); return; }
      if (isMobile() && !dom.drawer.hidden) { closeDrawer(); return; }
      if (!dom.settings.hidden && st.settingsView !== 'main') { showView('main'); return; }
      return;
    }
    if (editing) return;

    const k = e.key.toLowerCase();
    if (k === 'h') { toggleImmersive(); e.preventDefault(); }
    else if (k === 'a') { store.toggle('axis'); e.preventDefault(); }
    else if (k === 'g') { store.toggle('grid'); e.preventDefault(); }
    else if (k === 'r') { api.resetView(); e.preventDefault(); }
    else if (e.key === ' ' || e.code === 'Space') { api.setSetting('spin', !api.setting('spin')); e.preventDefault(); }
    else if (k === '/') { dom.searchInput.focus(); e.preventDefault(); }
  }

  /* ---------------------------------------------------------------- *
   * 绑定
   * ---------------------------------------------------------------- */
  function bindAll() {
    // 顶栏
    $('#nav-explore').addEventListener('click', () => {
      const next = !store.preferred('catalog');
      store.set('catalog', next);
      if (next) {
        dom.settings.hidden = true;
        $('#nav-settings').classList.remove('is-on');
        $('#nav-settings').setAttribute('aria-pressed', 'false');
        st.rightPriority = false;
        syncNarrowLayout();
      }
    });
    $('#nav-settings').addEventListener('click', () => {
      const willOpen = dom.settings.hidden || st.settingsView !== 'main';
      if (willOpen) showView('main');
      else openSettings(false);
    });
    $('#nav-hide').addEventListener('click', () => toggleImmersive());
    $('#settings-close').addEventListener('click', () => openSettings(false));
    $('#info-close').addEventListener('click', () => {
      if (st.mobile) closeDrawer(); else clearSelection();
    });
    $('#catalog-fold').addEventListener('click', () => store.set('catalog', false));

    // 搜索
    dom.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderSearch, 150);
    });
    dom.searchInput.addEventListener('focus', () => { if (dom.searchInput.value.trim()) renderSearch(); });
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') { moveCursor(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { moveCursor(-1); e.preventDefault(); }
      else if (e.key === 'Enter') {
        if (st.searchOpen && st.searchCursor >= 0) commitSearch(st.searchCursor);
        else renderSearch();
        e.preventDefault();
      } else if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
    });
    dom.searchClear.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchClear.hidden = true;
      closeSearch();
      dom.searchInput.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (st.searchOpen && !dom.search.contains(e.target)) closeSearch();
    }, true);

    // 目录
    $('#cat-feature').addEventListener('click', () => setCategory('feature'));
    $('#cat-landing').addEventListener('click', () => setCategory('landing'));
    $('#facts-open').addEventListener('click', () => showView('facts'));

    // 设置视图跳转
    $('#go-phase').addEventListener('click', () => showView('phase'));
    $('#go-layers').addEventListener('click', () => showView('layers'));
    $('#go-visibility').addEventListener('click', () => showView('visibility'));
    $('#go-immersive').addEventListener('click', () => toggleImmersive());
    $('#go-clear-cache').addEventListener('click', doClearCache);
    for (const [id, view] of [
      ['back-from-phase', 'main'], ['back-from-layers', 'main'], ['back-from-data', 'main'],
      ['back-from-spin', 'main'], ['back-from-axis', 'main'], ['back-from-grid', 'main'],
      ['back-from-visibility', 'main'], ['back-from-facts', 'main'],
    ]) { const n = $('#' + id); if (n) n.addEventListener('click', () => showView(view)); }

    // 参数
    const exp = $('#exposure');
    exp.addEventListener('input', () => {
      api.setExposure(Number(exp.value));
      $('#exposure-v').textContent = Number(exp.value).toFixed(2);
    });
    const rel = $('#relief');
    rel.addEventListener('input', () => {
      api.setRelief(Number(rel.value));
      $('#relief-v').textContent = Number(rel.value).toFixed(2);
    });
    const ph = $('#phase');
    ph.addEventListener('input', () => {
      api.setPhase(Number(ph.value));
      $('#phase-v').textContent = `${Number(ph.value).toFixed(0)}°`;
      $('#phase-ratio').textContent = api.phaseRatioText(Number(ph.value));
    });
    for (const b of $$('.preset')) {
      b.addEventListener('click', () => {
        const v = Number(b.dataset.phase);
        ph.value = String(v);
        api.setPhase(v, { goToReferenceView: true });
        $('#phase-v').textContent = `${v.toFixed(0)}°`;
        $('#phase-ratio').textContent = api.phaseRatioText(v);
        toast(`已套用${b.textContent}光照角度（先回到正面参考视角）`);
      });
    }
    $('#quality-btn').addEventListener('click', () => {
      const o = $('#quality-opts');
      o.hidden = !o.hidden;
      $('#quality-btn').setAttribute('aria-expanded', String(!o.hidden));
    });
    for (const b of $$('#quality-opts .opt')) {
      b.addEventListener('click', () => {
        $$('#quality-opts .opt').forEach((n) => {
          const on = n === b;
          n.classList.toggle('is-on', on);
          n.setAttribute('aria-selected', String(on));
        });
        $('#quality-btn').textContent = b.textContent;
        $('#quality-opts').hidden = true;
        api.setQuality(b.dataset.q);
      });
    }
    const sp = $('#spin-speed');
    sp.addEventListener('input', () => {
      const v = Number(sp.value);
      api.setSpinSpeed(v);
      $('#spin-speed-v').textContent = v <= 0.5 ? '很慢' : v <= 1 ? '缓慢' : v <= 2 ? '中等' : '较快';
    });

    bindSwitch('#sw-stars', () => api.setting('stars'), (v) => api.setSetting('stars', v));
    bindSwitch('#sw-earth', () => api.setting('earth'), (v) => api.setSetting('earth', v));
    bindSwitch('#sw-color', () => api.setting('color'), (v) => api.setSetting('color', v));
    bindSwitch('#sw-detail', () => api.setting('detail'), (v) => api.setSetting('detail', v));
    bindSwitch('#sw-cal', () => api.setting('calibrate'), (v) => api.setSetting('calibrate', v));
    bindSwitch('#sw2-stars', () => api.setting('stars'), (v) => api.setSetting('stars', v));
    bindSwitch('#sw2-earth', () => api.setting('earth'), (v) => api.setSetting('earth', v));
    bindSwitch('#sw2-color', () => api.setting('color'), (v) => api.setSetting('color', v));
    bindSwitch('#sw2-detail', () => api.setting('detail'), (v) => api.setSetting('detail', v));
    bindSwitch('#sw2-cal', () => api.setting('calibrate'), (v) => api.setSetting('calibrate', v));
    bindSwitch('#sw2-spin', () => api.setting('spin'), (v) => api.setSetting('spin', v));

    for (const id of ['#sw-axis', '#sw2-axis', '#sw2-axis2', '#sw2-axis3']) {
      bindSwitch(id, () => store.preferred('axis'), (v) => store.set('axis', v));
    }
    for (const id of ['#sw-grid', '#sw2-grid', '#sw2-grid3']) {
      bindSwitch(id, () => store.preferred('grid'), (v) => store.set('grid', v));
    }
    for (const id of ['#sw-markers', '#sw2-markers']) {
      bindSwitch(id, () => store.preferred('markers'), (v) => store.set('markers', v));
    }
    bindSwitch('#sw-poles', () => prefs.poles !== false, (v) => { prefs.poles = v; applyOverlayPrefs(); });
    bindSwitch('#sw-grid-labels', () => prefs.gridLabels !== false, (v) => { prefs.gridLabels = v; applyOverlayPrefs(); });

    $('#vis-hide-all').addEventListener('click', () => { store.setAll(false); store.setImmersive(true); });
    $('#vis-reset').addEventListener('click', () => { store.reset(); toast('已恢复默认布局'); });
    $('#reset-defaults').addEventListener('click', () => {
      api.resetDefaults();
      syncAllSwitches();
      toast('已恢复默认参数');
    });

    // 缩放
    $('#zoom-in').addEventListener('click', () => api.zoom(0.78));
    $('#zoom-out').addEventListener('click', () => api.zoom(1.28));
    $('#zoom-reset').addEventListener('click', () => api.resetView());

    // 沉浸恢复
    dom.restore.addEventListener('click', () => exitImmersive());

    // 抽屉
    $('#dtab-catalog').addEventListener('click', () => placeInDrawer('catalog'));
    $('#dtab-info').addEventListener('click', () => placeInDrawer('info'));
    $('#dtab-settings').addEventListener('click', () => placeInDrawer('settings'));
    $('#dtab-close').addEventListener('click', () => closeDrawer());
    $('#tb-immersive').addEventListener('click', () => toggleImmersive());
    $('#tb-phase').addEventListener('click', () => showView('phase'));
    $('#tb-spin').addEventListener('click', () => api.setSetting('spin', !api.setting('spin')));
    $('#tb-axis').addEventListener('click', () => store.toggle('axis'));
    $('#tb-grid').addEventListener('click', () => store.toggle('grid'));

    // 抽屉手柄：拖动切换档位
    bindDrawerDrag();

    document.addEventListener('keydown', onKeyDown);

    // 沉浸时：鼠标靠近底部或轻触空白处，临时显示恢复入口
    document.addEventListener('pointermove', (e) => {
      if (!store.immersive) return;
      const nearBottom = e.clientY > innerHeight - 140;
      if (nearBottom) showRestoreTemporarily(2500);
    }, { passive: true });
    $('#scene').addEventListener('pointerup', (e) => {
      if (store.immersive && !api.lastGestureWasDrag()) showRestoreTemporarily(2500);
    });

    addEventListener('resize', () => { layoutPanels(); syncNarrowLayout(); });
    addEventListener('orientationchange', () => setTimeout(layoutPanels, 120));
  }

  function bindDrawerDrag() {
    const grip = $('#drawer-grip');
    let startY = 0, startH = 0, dragging = false;
    const onDown = (e) => {
      dragging = true;
      startY = e.clientY;
      startH = dom.drawer.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!dragging) return;
      const h = Math.min(innerHeight * 0.9, Math.max(120, startH + (startY - e.clientY)));
      dom.drawer.style.height = `${h}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      dom.drawer.style.height = '';
      const h = dom.drawer.getBoundingClientRect().height;
      const detent = h > innerHeight * 0.7 ? 'full' : h < innerHeight * 0.30 ? 'peek' : 'half';
      if (detent === 'peek') closeDrawer();
      else { st.drawerDetent = detent; dom.drawer.dataset.detent = detent; }
    };
    grip.addEventListener('pointerdown', onDown);
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
    grip.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { openDrawer(st.drawerTab, 'full'); e.preventDefault(); }
      if (e.key === 'ArrowDown') {
        if (st.drawerDetent === 'full') openDrawer(st.drawerTab, 'half');
        else closeDrawer();
        e.preventDefault();
      }
    });
  }

  async function doClearCache() {
    const btn = $('#go-clear-cache');
    const old = btn.firstElementChild.textContent;
    btn.firstElementChild.textContent = '清理中…';
    try {
      const n = await api.clearCache();
      toast(`已清理本程序瓦片缓存（${n} 项）`);
      btn.firstElementChild.textContent = `已清理 ${n} 项`;
    } catch (e) {
      toast('清理缓存失败', true);
      btn.firstElementChild.textContent = '清理失败';
    }
    setTimeout(() => { btn.firstElementChild.textContent = old; }, 1800);
  }

  /* ---------------------------------------------------------------- *
   * 偏好同步
   * ---------------------------------------------------------------- */
  const prefs = { poles: true, gridLabels: true };

  function applyOverlayPrefs() {
    api.overlays.setAxis(store.visible('axis'));
    api.overlays.setPoles(store.visible('axis') && prefs.poles !== false);
    api.overlays.setGrid(store.visible('grid'));
    api.overlays.setGridLabels(store.visible('grid') && prefs.gridLabels !== false);
    api.overlays.setMarkers(store.visible('markers'));
  }

  function applyVisibility() {
    const v = (k) => store.visible(k);
    dom.topbar.hidden = !v('topbar');
    dom.body.classList.toggle('is-immersive', store.immersive);
    if (st.mobile) {
      // 移动端：面板由抽屉托管，只控制抽屉本身与叠加层
      dom.catalog.hidden = !v('catalog') || st.drawerTab !== 'catalog';
      if (!v('catalog') && st.drawerTab === 'catalog') closeDrawer();
      if (st.drawerTab === 'info') dom.infocard.hidden = !v('infoCard');
      dom.settings.hidden = false;
    } else {
      dom.catalog.hidden = !v('catalog');
      dom.infocard.hidden = !v('infoCard') || (!st.selectedId && !st.selectedPoint);
      if (!v('infoCard')) { dom.settings.hidden = true; $('#nav-settings').classList.remove('is-on'); }
    }
    dom.coordbar.hidden = !v('coordbar');
    dom.toolbar.hidden = !v('toolbar');
    dom.zoomtools.hidden = !v('zoomTools');
    syncNarrowLayout();
    $('#tb-axis').setAttribute('aria-pressed', String(store.preferred('axis')));
    $('#tb-grid').setAttribute('aria-pressed', String(store.preferred('grid')));
    $('#nav-explore').classList.toggle('is-on', store.preferred('catalog'));
    $('#nav-explore').setAttribute('aria-pressed', String(store.preferred('catalog')));
    syncSwitch('#sw-axis', store.preferred('axis'));
    syncSwitch('#sw2-axis', store.preferred('axis'));
    syncSwitch('#sw2-axis2', store.preferred('axis'));
    syncSwitch('#sw2-axis3', store.preferred('axis'));
    syncSwitch('#sw-grid', store.preferred('grid'));
    syncSwitch('#sw2-grid', store.preferred('grid'));
    syncSwitch('#sw2-grid3', store.preferred('grid'));
    syncSwitch('#sw-markers', store.preferred('markers'));
    syncSwitch('#sw2-markers', store.preferred('markers'));
    applyOverlayPrefs();
  }

  function syncAllSwitches() {
    syncSwitch('#sw-stars', api.setting('stars'));
    syncSwitch('#sw-earth', api.setting('earth'));
    syncSwitch('#sw-color', api.setting('color'));
    syncSwitch('#sw-detail', api.setting('detail'));
    syncSwitch('#sw-cal', api.setting('calibrate'));
    syncSwitch('#sw2-stars', api.setting('stars'));
    syncSwitch('#sw2-earth', api.setting('earth'));
    syncSwitch('#sw2-color', api.setting('color'));
    syncSwitch('#sw2-detail', api.setting('detail'));
    syncSwitch('#sw2-cal', api.setting('calibrate'));
    syncSwitch('#sw2-spin', api.setting('spin'));
    $('#tb-spin').setAttribute('aria-pressed', String(api.setting('spin')));
    const e = api.setting('exposure');
    $('#exposure').value = String(e);
    $('#exposure-v').textContent = Number(e).toFixed(2);
    const r = api.setting('relief');
    $('#relief').value = String(r);
    $('#relief-v').textContent = Number(r).toFixed(2);
    const ph = api.setting('phase');
    $('#phase').value = String(ph);
    $('#phase-v').textContent = `${Number(ph).toFixed(0)}°`;
    const gopv = $('#go-phase-v');
    if (gopv) gopv.textContent = `${Number(ph).toFixed(0)}° · ${api.phaseRatioText(Number(ph))}`;
    $('#phase-ratio').textContent = api.phaseRatioText(Number(ph));
    $('#grid-step').textContent = `${api.gridStep()}°`;
    $('#quality-btn').textContent = { auto: '自动', 2048: '2K', 4096: '4K', 8192: '8K' }[api.setting('quality')] || '自动';
    $$('#quality-opts .opt').forEach((n) => {
      const on = String(n.dataset.q) === String(api.setting('quality'));
      n.classList.toggle('is-on', on);
      n.setAttribute('aria-selected', String(on));
    });
    api.overlays.setPoles(prefs.poles !== false);
    syncSwitch('#sw-poles', prefs.poles !== false);
    syncSwitch('#sw-grid-labels', prefs.gridLabels !== false);
  }

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */
  function init() {
    bindAll();
    layoutPanels();
    renderCatalog();
    renderInfoCard();
    renderVisibilityList();
    showView('main', { open: false });
    openSettings(false);
    applyPhasePresets();
    $('#tb-spin').setAttribute('aria-pressed', String(api.setting('spin')));
    store.subscribe(() => {
      applyVisibility();
      if (st.settingsView === 'visibility') renderVisibilityList();
    });
    syncAllSwitches();
    applyVisibility();
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    loadData().then(() => {
      api.setMarkerPlaces(st.places);
      renderCatalog();
      applyPhaseSource();
      if (st.dataError) toast('地点资料加载失败，其余功能不受影响', true);
    });

    // 周期性刷新坐标栏与运行数据（不需要每帧）。数据面板展开时同步刷新详细数值。
    setInterval(() => {
      st.center = api.centerCoord();
      st.hover = api.hoverCoord();
      updateCoordBar();
      updateStats();
    }, 200);
    setInterval(() => { $('#grid-step').textContent = `${api.gridStep()}°`; }, 400);

    if (isMobile()) openDrawer('catalog', 'half');

    // 首屏提示：若偏好被全部关掉，引导恢复（不能出现无法操作的死角）
    if (store.allHidden() && !store.immersive) {
      toast('所有面板当前处于隐藏状态，按 H 显示界面');
      dom.restore.hidden = false;
      setTimeout(() => { dom.restore.hidden = true; }, 6000);
    }
  }

  return {
    init,
    renderLabels,
    onPickPoint,
    toast,
    store,
    showView,
    syncSwitches: syncAllSwitches,
    state: st,
    refresh: renderInfoCard,
  };
}
