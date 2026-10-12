/**
 * 可见性偏好 + 沉浸状态。
 *
 * 两类状态严格分开（设计文档第 6 节）：
 *   1. 用户偏好 prefs    —— 每个区域单独勾选，按版本化 schema 存 localStorage；
 *   2. 临时沉浸 immersive —— 临时隐藏全部 UI 与辅助覆盖层，**不写入偏好**，
 *      退出后恢复此前的组合。
 *
 * 本模块不碰 DOM，只维护状态并通知订阅者，便于在 Node 下测试。
 */

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'luna.ui.prefs';

/**
 * 可独立隐藏的区域。`group` 只用于界面分组显示。
 * order 决定“隐藏全部/恢复默认”时的展示顺序。
 */
export const LAYERS = [
  { key: 'topbar', label: '顶栏与搜索', group: 'ui', def: true },
  { key: 'catalog', label: '地点目录', group: 'ui', def: true },
  { key: 'infoCard', label: '地点信息卡', group: 'ui', def: true },
  { key: 'coordbar', label: '底部坐标栏', group: 'ui', def: true },
  { key: 'toolbar', label: '观察工具栏', group: 'ui', def: true },
  { key: 'zoomTools', label: '缩放工具', group: 'ui', def: true },
  { key: 'markers', label: '地名与选点标记', group: 'overlay', def: true },
  { key: 'axis', label: '自转轴与极点', group: 'overlay', def: false },
  { key: 'grid', label: '经纬网与坐标标签', group: 'overlay', def: false },
];

export const LAYER_KEYS = LAYERS.map((l) => l.key);

/** 默认偏好。 */
export function defaultPrefs() {
  const p = {};
  for (const l of LAYERS) p[l.key] = l.def;
  return p;
}

/**
 * 校验并合并外部数据。任何非法项都退回默认值，不抛异常。
 * @returns {{prefs:object, repaired:boolean}}
 */
export function sanitizePrefs(raw) {
  const base = defaultPrefs();
  if (!raw || typeof raw !== 'object') return { prefs: base, repaired: raw != null };
  const version = Number(raw.version);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    // 未来版本的数据：不猜测语义，整体退回默认
    return { prefs: base, repaired: true };
  }
  let repaired = false;
  const out = { ...base };
  const src = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : raw;
  for (const k of LAYER_KEYS) {
    if (k in src) {
      if (typeof src[k] === 'boolean') out[k] = src[k];
      else repaired = true;
    }
  }
  return { prefs: out, repaired };
}

/**
 * 创建一个可见性存储。
 *
 * @param {object} [o]
 * @param {Storage|null} [o.storage] 默认 localStorage；不可用时静默降级为内存状态
 * @param {string} [o.key]
 */
export function createVisibilityStore({ storage = safeStorage(), key = STORAGE_KEY } = {}) {
  let prefs = defaultPrefs();
  let immersive = false;
  let persisted = true;
  const listeners = new Set();

  function load() {
    if (!storage) { persisted = false; return false; }
    let raw = null;
    try {
      const text = storage.getItem(key);
      if (!text) return false;
      raw = JSON.parse(text);
    } catch (e) {
      persisted = false;
      return false;
    }
    const { prefs: p, repaired } = sanitizePrefs(raw);
    prefs = p;
    return !repaired;
  }

  function save() {
    if (!storage) { persisted = false; return false; }
    try {
      storage.setItem(key, JSON.stringify({ version: SCHEMA_VERSION, prefs }));
      persisted = true;
      return true;
    } catch (e) {
      persisted = false;
      return false;
    }
  }

  function emit() {
    const snapshot = { prefs: { ...prefs }, immersive, persisted };
    for (const fn of listeners) {
      try { fn(snapshot); } catch (e) { /* 订阅者异常不影响状态 */ }
    }
  }

  load();

  return {
    get prefs() { return { ...prefs }; },
    get immersive() { return immersive; },
    get persisted() { return persisted; },
    /** 该区域此刻是否真正可见（偏好 ∧ 非沉浸）。 */
    visible(k) { return !!prefs[k] && !immersive; },
    /** 该区域的偏好值，不含沉浸。 */
    preferred(k) { return !!prefs[k]; },
    set(k, on) {
      if (!LAYER_KEYS.includes(k)) return false;
      const v = !!on;
      if (prefs[k] === v) return false;
      prefs[k] = v;
      save();
      emit();
      return true;
    },
    toggle(k) { return this.set(k, !prefs[k]); },
    setAll(on) {
      const v = !!on;
      let changed = false;
      for (const k of LAYER_KEYS) { if (prefs[k] !== v) { prefs[k] = v; changed = true; } }
      if (changed) { save(); emit(); }
      return changed;
    },
    reset() {
      prefs = defaultPrefs();
      save();
      emit();
      return true;
    },
    /** 进入/退出沉浸。不写偏好。 */
    setImmersive(on) {
      const v = !!on;
      if (immersive === v) return false;
      immersive = v;
      emit();
      return true;
    },
    toggleImmersive() { return this.setImmersive(!immersive); },
    /** 是否所有区域都被用户关掉了（用于保证仍有恢复入口）。 */
    allHidden() { return LAYER_KEYS.every((k) => !prefs[k]); },
    subscribe(fn) {
      listeners.add(fn);
      try { fn({ prefs: { ...prefs }, immersive, persisted }); } catch (e) { /* 订阅者异常不影响状态 */ }
      return () => listeners.delete(fn);
    },
    /** 仅供测试：清掉内存状态。 */
    _reload() { load(); emit(); },
  };
}

/** 拿一个可用的 Storage，取不到就返回 null（隐私模式 / SSR / Node）。 */
export function safeStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__luna_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (e) {
    return null;
  }
}
