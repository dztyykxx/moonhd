/**
 * 有限持久化缓存（IndexedDB）。
 *
 * 只做一种实现（IndexedDB），不与 CacheStorage 并行维护。
 * 缓存键 = 数据源 id + 版本 + 层级 + 瓦片编号，避免不同来源/版本互相污染。
 *
 * 预算用 navigator.storage.estimate() 的 usage 做参考（浏览器按整站统计，
 * 包含本项目其它内容），并额外维护本库自己的字节账本，超预算时按
 * "最久未访问"清理本库记录。配额不足或 IndexedDB 不可用时全部降级为
 * "只走内存"，不影响在线浏览。
 */

const DB_NAME = 'moonhd-tiles';
const DB_VERSION = 1;
const STORE = 'tiles';

function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

export async function openTileCache(o = {}) {
  if (!idbAvailable()) throw new Error('当前环境没有 indexedDB');
  const sourceId = o.sourceId || 'unknown';
  const version = o.version || 1;
  const budget = o.budget || 256 * 1024 * 1024;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'key' });
        s.createIndex('usedAt', 'usedAt');
        s.createIndex('source', 'source');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open 失败'));
    req.onblocked = () => reject(new Error('indexedDB 被其它标签页阻塞'));
  });

  const keyOf = (order, npix) => `${sourceId}|v${version}|${order}|${npix}`;

  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);

  const wrap = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function get(order, npix) {
    const rec = await wrap(tx('readonly').get(keyOf(order, npix)));
    if (!rec || !rec.blob) return null;
    // 命中后异步更新访问时间（不阻塞返回）
    try {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      s.put({ ...rec, usedAt: Date.now(), uses: (rec.uses || 0) + 1 });
    } catch (e) { /* 忽略 */ }
    return rec.blob;
  }

  async function put(order, npix, blob) {
    try {
      const rec = {
        key: keyOf(order, npix),
        source: sourceId, version, order, npix,
        bytes: blob.size, usedAt: Date.now(), uses: 0, blob,
      };
      await wrap(tx('readwrite').put(rec));
      await enforceBudget();
      return true;
    } catch (e) {
      // 配额不足：静默降级，不影响在线浏览
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
        await pruneOldest(0.25).catch(() => {});
      }
      return false;
    }
  }

  async function count() {
    return wrap(tx('readonly').count());
  }

  /** 本库记录的字节总量与条数。 */
  async function ownUsage() {
    const store = tx('readonly');
    const c = await wrap(store.count());
    // 逐条累加 bytes（条目数受预算限制，量级可控）
    const all = await wrap(tx('readonly').getAll());
    let bytes = 0;
    for (const r of all) bytes += r.bytes || 0;
    return { count: c, bytes };
  }

  /** 按最久未访问删除一部分本库记录。 */
  async function pruneOldest(fraction = 0.25) {
    const all = await wrap(tx('readonly').getAll());
    if (!all.length) return 0;
    all.sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    const n = Math.max(1, Math.floor(all.length * fraction));
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (let i = 0; i < n; i++) s.delete(all[i].key);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    return n;
  }

  async function enforceBudget() {
    const own = await ownUsage();
    if (own.bytes > budget) await pruneOldest(0.2);
  }

  async function clear() {
    const c = await count();
    await wrap(tx('readwrite').clear());
    return c;
  }

  return { get, put, count, ownUsage, pruneOldest, clear, keyOf, budget, sourceId, version, db };
}

/** 浏览器层面的存储估算（整站）。 */
export async function cacheEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
    return { usage: 0, quota: 0, supported: false };
  }
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0, supported: true };
  } catch (err) {
    return { usage: 0, quota: 0, supported: false, error: String(err) };
  }
}

/** 清理本项目缓存（只删 moonhd-tiles 库）。 */
export async function clearTileCache() {
  if (!idbAvailable()) return 0;
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) { db.close(); resolve(0); return; }
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const c = s.count();
      let n = 0;
      c.onsuccess = () => { n = c.result; };
      s.clear();
      t.oncomplete = () => { db.close(); resolve(n); };
      t.onerror = () => { db.close(); resolve(0); };
    };
    req.onerror = () => resolve(0);
  });
}
