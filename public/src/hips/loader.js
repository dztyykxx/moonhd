/**
 * HiPS 瓦片加载器：HTTP 拉取 + 解码为 ImageBitmap，供 TileScheduler 使用。
 *
 * 只请求 PNG。HTTP 200 但返回 HTML/JSON 视为失败（源站 404 会返回 HTML 页面）。
 */
import { tilePath } from './healpix.js';

export class HttpTileLoader {
  /**
   * @param {object} cfg  makeSourceConfig() 的结果
   * @param {object} [o]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {number} [o.timeoutMs=20000]
   */
  constructor(cfg, o = {}) {
    this.cfg = cfg;
    this.fetchImpl = o.fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = o.timeoutMs || 20000;
    /** 最近一次成功请求的字节数（用于界面显示，不是显存口径）。 */
    this.lastBytes = 0;
  }

  url(order, npix) {
    return this.cfg.url(tilePath(order, npix, 'png'));
  }

  /** 拉取原始字节（不在这里解码，便于同时喂给持久化缓存）。 */
  async fetchBlob(order, npix, signal) {
    const url = this.url(order, npix);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
    const onAbort = () => ctrl.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw abortError(); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.status = res.status;
        const ra = res.headers && res.headers.get && res.headers.get('retry-after');
        if (ra) err.retryAfter = ra;
        throw err;
      }
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) {
        const err = new Error(`空响应 ${url}`);
        err.status = 200;
        throw err;
      }
      // 源站在 404 时会返回 HTML 页面；即便状态是 200 也要拦住
      if (!/image\//i.test(type) && !isPng(buf)) {
        const err = new Error(`不是 PNG（content-type=${type || '未知'}）`);
        err.status = 415;
        throw err;
      }
      if (!isPng(buf)) {
        const err = new Error('返回内容不是 PNG 数据');
        err.status = 415;
        throw err;
      }
      this.lastBytes = buf.byteLength;
      return new Blob([buf], { type: 'image/png' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 解码为 ImageBitmap（浏览器）。 */
  async decode(blob) {
    if (typeof createImageBitmap !== 'function') throw new Error('当前环境不支持 createImageBitmap');
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }

  /** TileScheduler 的 loader 接口。 */
  async load(order, npix, signal) {
    const blob = await this.fetchBlob(order, npix, signal);
    const image = await this.decode(blob);
    return { image, width: image.width, height: image.height, blob };
  }
}

function isPng(buf) {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
