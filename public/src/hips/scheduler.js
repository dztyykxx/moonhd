/**
 * HiPS 瓦片请求调度：请求合并、有限并发、取消、退避重试、真实 LRU 与内存预算。
 *
 * 设计要点（对应任务书阶段2）：
 *   - 同一瓦片同时只发一次请求（inflight 合并）。
 *   - 并发上限可配；队列按优先级（当前视野中心优先）排序。
 *   - 视角变化时取消已不需要的请求；取消后释放 ImageBitmap / objectURL。
 *   - 失败退避重试并设上限；404/410 视为永久缺失（不重试）；429 尊重 Retry-After。
 *   - 内存缓存按"解码后的像素字节数"计费（不是 PNG 文件大小），真实 LRU，
 *     当前正在显示的瓦片受保护不被淘汰。
 *   - 淘汰时释放资源；已释放对象不会留在缓存里。
 *
 * 本模块不依赖 three.js，可在 Node 下用假 fetch 测试（见 test/scheduler.test.mjs）。
 */

export const TileState = {
  QUEUED: 'queued',
  LOADING: 'loading',
  READY: 'ready',
  FAILED: 'failed',
  MISSING: 'missing',
};

/** 永久缺失（不重试）。 */
const PERMANENT = new Set([400, 404, 410, 451]);

export function tileKey(order, npix) {
  return order + '/' + npix;
}

/**
 * 估算一张解码后纹理的字节数：宽×高×4 通道 ×（mipmap 约 4/3）。
 * 这是显存/内存计费口径，不是 PNG 压缩后大小。
 */
export function textureBytes(w, h, mipmaps = true) {
  const base = w * h * 4;
  return mipmaps ? Math.round(base * (4 / 3)) : base;
}

export class TileScheduler {
  /**
   * @param {object} o
   * 加载器：函数，或带 load(order, npix, signal) 方法的对象。
   * @param {Function|{load:Function}} o.loader
   * @param {number} [o.concurrency=4]
   * @param {number} [o.memoryBudget=134217728]  内存缓存预算（字节）
   * @param {number} [o.maxRetries=3]
   * @param {number} [o.retryBaseMs=600]
   * @param {(entry:object)=>void} [o.onStateChange]
   * @param {(order:number,npix:number)=>Promise<Blob|ArrayBuffer|null>} [o.persistentGet]
   * @param {(order:number,npix:number,blob:Blob)=>Promise<void>} [o.persistentPut]
   * @param {()=>number} [o.now]
   */
  constructor(o) {
    const l = o.loader;
    this.loader = typeof l === 'function' ? l : (order, npix, signal) => l.load(order, npix, signal);
    /** 原始 loader（可能带 decode 方法）。 */
    this.rawLoader = l;
    this.concurrency = Math.max(1, o.concurrency || 4);
    this.memoryBudget = o.memoryBudget || 128 * 1024 * 1024;
    this.maxRetries = o.maxRetries === undefined ? 2 : o.maxRetries;
    this.retryBaseMs = o.retryBaseMs || 600;
    /** 失败后的冷却时间（指数增长，上限 maxCooldownMs）。 */
    this.failCooldownMs = o.failCooldownMs || 8000;
    this.maxCooldownMs = o.maxCooldownMs || 120000;
    /**
     * 熔断：连续失败达到该次数后，暂停对外请求一段时间。
     *
     * 弱网/源站不可用时，逐张瓦片各自重试仍然会累积成很大的请求量
     * （实测 80 张瓦片 30 秒内 480 次请求）。熔断让"整体不可用"这种情况
     * 直接安静下来，只保留底图，等冷却后再试。
     */
    this.breakerThreshold = o.breakerThreshold === undefined ? 8 : o.breakerThreshold;
    this.breakerCooldownMs = o.breakerCooldownMs || 60000;
    this.consecutiveFailures = 0;
    this.breakerUntil = 0;
    this.onStateChange = o.onStateChange || (() => {});
    this.persistentGet = o.persistentGet || null;
    this.persistentPut = o.persistentPut || null;
    this.now = o.now || (() => Date.now());

    /** @type {Map<string, object>} 内存缓存（含 READY 与失败记录） */
    this.cache = new Map();
    /** @type {Map<string, object>} 正在请求 */
    this.inflight = new Map();
    /** @type {Array<object>} 待请求队列 */
    this.queue = [];
    this.active = 0;
    /** @type {Set<string>} 受保护（当前显示）的键，淘汰时跳过 */
    this.pinned = new Set();
    this.bytes = 0;
    this.stats = {
      requests: 0, hits: 0, memoryHits: 0, persistentHits: 0,
      errors: 0, retries: 0, cancelled: 0, evictions: 0, evictedBytes: 0,
      missing: 0,
      /** 因熔断而跳过的请求数（弱网时可用来判断源站是否整体不可用）。 */
      breakerSkipped: 0,
      /** 熔断触发次数。 */
      breakerTrips: 0,
    };
    this._tickScheduled = false;
    this._disposed = false;
  }

  /** 记录统计（便于测试与界面显示）。 */
  getStats() {
    return {
      ...this.stats,
      cacheEntries: this.cache.size,
      inflight: this.inflight.size,
      queued: this.queue.length,
      active: this.active,
      bytes: this.bytes,
      memoryBudget: this.memoryBudget,
    };
  }

  /** 设置受保护的键集合（当前画面正在用的瓦片）。 */
  setPinned(keys) {
    this.pinned = keys instanceof Set ? keys : new Set(keys);
  }

  /** 查询缓存条目（不改 LRU 顺序）。 */
  peek(order, npix) {
    return this.cache.get(tileKey(order, npix)) || null;
  }

  /** 命中缓存并提升优先级（真实 LRU：命中的挪到最近使用）。 */
  _touch(entry) {
    entry.usedAt = this.now();
    entry.uses++;
    // Map 保持插入顺序：删除再插入 = 移到末尾（最近使用）
    this.cache.delete(entry.key);
    this.cache.set(entry.key, entry);
  }

  /**
   * 请求一张瓦片。
   * @param {number} order
   * @param {number} npix
   * @param {number} [priority] 越小越优先（按视野中心距离）
   * @returns {{state:string, entry:object|null, promise:Promise|null}}
   */
  request(order, npix, priority = 0) {
    const key = tileKey(order, npix);
    const hit = this.cache.get(key);
    if (hit && hit.state === TileState.READY) {
      this.stats.memoryHits++;
      this._touch(hit);
      return { state: TileState.READY, entry: hit, promise: null };
    }
    /**
     * 熔断打开期间：不再发起任何新请求（已就绪的瓦片照常显示）。
     * 这样弱网/源站不可用时画面安静地停在底图，不会持续打请求。
     */
    if (this.breakerUntil && this.now() < this.breakerUntil) {
      this.stats.breakerSkipped++;
      return { state: TileState.FAILED, entry: hit || null, promise: null };
    }
    if (this.breakerUntil && this.now() >= this.breakerUntil) {
      // 冷却结束，重新试探
      this.breakerUntil = 0;
      this.consecutiveFailures = 0;
    }
    if (hit && hit.state === TileState.MISSING) {
      // 永久缺失（404/410 等）：不再请求
      return { state: TileState.MISSING, entry: hit, promise: null };
    }
    if (hit && hit.state === TileState.FAILED) {
      /**
       * 重试上限：把 entry 标记为"本轮放弃"，本会话不再请求。
       *
       * 之前这里直接 `this.cache.delete(key)`，于是下一次 request() 会新建一个
       * attempts=0 的条目，**maxRetries 永远达不到** —— 冷却窗口一到就再试一轮，
       * 无限循环。实测弱网/被墙时：80 张瓦片在 30 秒内打出 1280 次请求、960 次重试。
       * 现在保留 attempts，并用 deadKeys 在会话内彻底封顶。
       */
      if (hit.dead || hit.attempts > this.maxRetries + 2) {
        hit.dead = true;
        return { state: TileState.FAILED, entry: hit, promise: null };
      }
      // 暂时失败：冷却期内不再重排，避免"每次选视野都重试"把源站打爆
      const wait = hit.cooldownMs || this.failCooldownMs;
      if (this.now() < (hit.nextRetryAt || 0)) {
        return { state: TileState.FAILED, entry: hit, promise: null };
      }
      hit.cooldownMs = Math.min(wait * 2, this.maxCooldownMs);
      /**
       * 关键：**复用**这个 entry（保留 attempts / cooldownMs），而不是删掉重建。
       * 删掉会让 attempts 归零，重试次数失去意义。
       */
      hit.state = TileState.QUEUED;
      hit.error = null;
      const again = { key, order, npix, priority, entry: hit, promise: null, cancelled: false };
      again.promise = new Promise((resolve) => { again.resolve = resolve; });
      this.queue.push(again);
      this.queue.sort((a, b) => a.priority - b.priority);
      this.stats.retries++;
      this._pump();
      return { state: TileState.QUEUED, entry: hit, promise: again.promise };
    }
    const flying = this.inflight.get(key);
    if (flying) {
      this.stats.hits++;
      if (priority < flying.priority) flying.priority = priority;   // 提升优先级
      return { state: TileState.LOADING, entry: flying.entry, promise: flying.promise };
    }
    const queued = this.queue.find((q) => q.key === key);
    if (queued) {
      this.stats.hits++;
      if (priority < queued.priority) {
        queued.priority = priority;
        this.queue.sort((a, b) => a.priority - b.priority);
      }
      return { state: TileState.QUEUED, entry: null, promise: queued.promise };
    }

    const entry = {
      key, order, npix, state: TileState.QUEUED,
      image: null, width: 0, height: 0, bytes: 0,
      usedAt: this.now(), uses: 0, attempts: 0,
      error: null, fromPersistent: false,
    };
    const job = { key, order, npix, priority, entry, promise: null, cancelled: false };
    job.promise = new Promise((resolve) => { job.resolve = resolve; });
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority);
    this._pump();
    return { state: TileState.QUEUED, entry, promise: job.promise };
  }

  /** 取消不再需要的排队/进行中的请求（过时结果不会写入缓存）。 */
  cancel(keys) {
    const drop = keys instanceof Set ? keys : new Set(keys);
    let n = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (drop.has(job.key)) {
        this.queue.splice(i, 1);
        job.cancelled = true;
        job.resolve({ cancelled: true });
        n++;
      }
    }
    for (const [key, fly] of this.inflight) {
      if (drop.has(key)) {
        fly.cancelled = true;
        if (fly.controller) fly.controller.abort();
        this.inflight.delete(key);
        this.active--;
        fly.resolve({ cancelled: true });
        this._release(fly.entry);
        n++;
      }
    }
    this.stats.cancelled += n;
    if (n) this._pump();
    return n;
  }

  /** 取消所有未完成的请求。 */
  cancelAll() {
    return this.cancel(new Set([
      ...this.queue.map((q) => q.key),
      ...this.inflight.keys(),
    ]));
  }

  _pump() {
    while (!this._disposed && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job.cancelled) continue;
      this.active++;
      this._run(job).finally(() => {
        this.active--;
        this._pump();
      });
    }
  }

  async _run(job) {
    const { entry } = job;
    entry.attempts++;
    entry.state = TileState.LOADING;
    this.onStateChange(entry);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    job.controller = controller;
    this.inflight.set(job.key, job);
    this.stats.requests++;

    try {
      let image = null, width = 0, height = 0, fromPersistent = false;

      // 1) 持久化缓存优先（阶段3 接入）
      if (this.persistentGet) {
        try {
          const blob = await this.persistentGet(job.order, job.npix);
          if (blob) {
            if (!this.rawLoader || typeof this.rawLoader.decode !== 'function') {
              throw new Error('loader 不支持 decode');
            }
            image = await this.rawLoader.decode(blob);
            width = image.width; height = image.height;
            fromPersistent = true;
            this.stats.persistentHits++;
          }
        } catch (e) { /* 持久化失败不影响在线 */ }
      }
      if (!image) {
        const r = await this.loader(job.order, job.npix, controller ? controller.signal : undefined);
        image = r.image; width = r.width; height = r.height;
        job.blob = r.blob || null;      // 供持久化缓存写入
      }

      if (job.cancelled) { this._release(entry, image); job.resolve({ cancelled: true }); return; }

      entry.image = image;
      entry.width = width;
      entry.height = height;
      entry.bytes = textureBytes(width, height, true);
      entry.state = TileState.READY;
      entry.error = null;
      entry.fromPersistent = fromPersistent;
      // 成功一次就重置熔断计数：说明源站是通的
      this.consecutiveFailures = 0;
      this._insert(entry);
      this._evict();

      // 写入持久化缓存（阶段3）
      if (!fromPersistent && this.persistentPut && job.blob) {
        this.persistentPut(job.order, job.npix, job.blob).catch(() => {});
      }
      job.resolve({ entry });
      this.onStateChange(entry);
    } catch (err) {
      this.inflight.delete(job.key);
      if (job.cancelled) { job.resolve({ cancelled: true }); return; }
      const status = err && err.status;
      this.stats.errors++;
      // 熔断计数：连续失败到阈值就整体暂停一段时间
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.breakerThreshold && !this.breakerUntil) {
        this.breakerUntil = this.now() + this.breakerCooldownMs;
        this.stats.breakerTrips++;
      }
      if (PERMANENT.has(status)) {
        entry.state = TileState.MISSING;
        entry.error = `HTTP ${status}`;
        this.stats.missing++;
        this._insert(entry);
        job.resolve({ entry, error: entry.error });
        this.onStateChange(entry);
        return;
      }
      // 429：尊重 Retry-After
      let wait = this.retryBaseMs * 2 ** (entry.attempts - 1);
      if (status === 429 && err.retryAfter) {
        const ra = Number(err.retryAfter);
        if (Number.isFinite(ra)) wait = Math.max(wait, ra * 1000);
      }
      if (entry.attempts <= this.maxRetries) {
        this.stats.retries++;
        entry.state = TileState.QUEUED;
        entry.error = (err && err.message) || String(err);
        job.promise = new Promise((resolve) => { job.resolve = resolve; });
        job.cancelled = false;
        this.queue.push(job);
        setTimeout(() => {
          if (this._disposed || job.cancelled) return;
          this.queue.sort((a, b) => a.priority - b.priority);
          this._pump();
        }, wait);
        this.onStateChange(entry);
        return;
      }
      entry.state = TileState.FAILED;
      entry.error = (err && err.message) || String(err);
      entry.nextRetryAt = this.now() + (entry.cooldownMs || this.failCooldownMs);
      this._insert(entry);
      job.resolve({ entry, error: entry.error });
      this.onStateChange(entry);
    } finally {
      this.inflight.delete(job.key);
    }
  }

  /** 把条目放入缓存并计费。 */
  _insert(entry) {
    const old = this.cache.get(entry.key);
    if (old && old !== entry && old.image) this._release(old);
    this.cache.set(entry.key, entry);
    this._recount();
  }

  _recount() {
    let b = 0;
    for (const e of this.cache.values()) b += e.bytes || 0;
    this.bytes = b;
  }

  /**
   * 真实 LRU 淘汰：从最久未使用的一端开始，跳过受保护（当前显示）与未就绪条目。
   * 每次淘汰都会释放纹理引用。
   */
  _evict() {
    if (this.bytes <= this.memoryBudget) return;
    const order = [...this.cache.values()]
      .filter((e) => e.state === TileState.READY)
      .sort((a, b) => a.usedAt - b.usedAt);
    for (const e of order) {
      if (this.bytes <= this.memoryBudget) break;
      if (this.pinned.has(e.key)) continue;
      // 注意：_release() 会把 entry.bytes 清零，所以必须先取出字节数再释放。
      // 之前写成 `this.stats.evictedBytes += e.bytes` 且放在 _release() 之后，
      // 结果恒为 0（实测 evictions=194 而 evictedBytes=0）。
      const bytes = e.bytes || 0;
      this.cache.delete(e.key);
      this._release(e);
      this.stats.evictions++;
      this.stats.evictedBytes += bytes;
      this.bytes -= bytes;
      this.onStateChange({ ...e, state: 'evicted' });
    }
    this._recount();
  }

  /** 释放条目持有的图像资源。 */
  _release(entry, imageOverride) {
    const img = imageOverride || entry.image;
    if (!img) return;
    try {
      if (typeof img.close === 'function') img.close();            // ImageBitmap
      else if (typeof img.dispose === 'function') img.dispose();   // three Texture
      else if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    } catch (e) { /* 释放失败不应影响主流程 */ }
    if (!imageOverride) { entry.image = null; entry.bytes = 0; entry.width = 0; entry.height = 0; }
  }

  /** 手动清空内存缓存（不清理持久化缓存）。 */
  clearMemory() {
    for (const e of this.cache.values()) if (e.image) this._release(e);
    this.cache.clear();
    this.bytes = 0;
  }

  dispose() {
    this._disposed = true;
    this.cancelAll();
    this.clearMemory();
  }
}
