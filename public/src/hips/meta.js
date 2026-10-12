/**
 * HiPS 数据源元数据：解析 `properties`，给出最高层级、瓦片尺寸、路径与 URL。
 *
 * 只读 PNG。FITS 不进入浏览链路。
 */

export const DEFAULT_SOURCE = {
  id: 'china-vo-change2-moon-7m-dom',
  label: 'China-VO 嫦娥二号 DOM 7M',
  /** 元数据里写的是 http，这里强制 https。 */
  base: 'https://hips.china-vo.org/change2-moon-7m-dom/',
  attribution: '数据来源：China-VO / 嫦娥二号 Lunar DOM 7M（HiPS）',
  credit: 'https://hips.china-vo.org/change2-moon-7m-dom/',
};

/**
 * 解析 HiPS `properties` 文本。
 * 返回 { title, frame, body, orderMax, orderMin, tileWidth, formats, serviceUrl,
 *        estSizeKB, mocSkyFraction, status, pixelScaleDeg, raw }
 */
export function parseProperties(text) {
  const raw = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) raw[k] = v;
  }
  const num = (k, d = null) => {
    const v = raw[k];
    if (v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const formats = String(raw.hips_tile_format || 'png').split(/\s+/).filter(Boolean);
  return {
    raw,
    title: raw.obs_title || raw.label || '',
    frame: raw.hips_frame || '',
    body: raw.hips_body || '',
    orderMax: num('hips_order'),
    orderMin: num('hips_order_min', 0),
    tileWidth: num('hips_tile_width', 512),
    formats,
    hasPng: formats.includes('png'),
    serviceUrl: raw.hips_service_url || '',
    estSizeKB: num('hips_estsize'),
    mocSkyFraction: num('moc_sky_fraction'),
    status: raw.hips_status || '',
    pixelScaleDeg: num('hips_pixel_scale'),
    releaseDate: raw.hips_release_date || '',
    creatorDid: raw.creator_did || '',
    builder: raw.hips_builder || '',
  };
}

/** 由 properties 与源定义合成运行时配置。 */
export function makeSourceConfig(source, props) {
  if (!props.hasPng) {
    throw new Error(`数据源 ${source.id} 不提供 PNG（${props.formats.join(',')}），本实现只加载 PNG`);
  }
  if (!Number.isFinite(props.orderMax)) {
    throw new Error(`数据源 ${source.id} 缺少 hips_order`);
  }
  const base = source.base.endsWith('/') ? source.base : source.base + '/';
  return {
    ...source,
    base,
    orderMax: props.orderMax,
    orderMin: props.orderMin,
    tileWidth: props.tileWidth,
    pixelScaleDeg: props.pixelScaleDeg,
    estSizeKB: props.estSizeKB,
    mocSkyFraction: props.mocSkyFraction,
    status: props.status,
    title: props.title,
    /** 拼接瓦片 URL。 */
    url: (path) => base + path,
  };
}

/** 拉取并解析元数据。 */
export async function fetchSourceConfig(source = DEFAULT_SOURCE, { signal, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(source.base + 'properties', { signal });
  if (!res.ok) throw new Error(`properties HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error('properties 返回了 HTML，不是 HiPS 元数据');
  const props = parseProperties(text);
  return { props, config: makeSourceConfig(source, props) };
}

/* ------------------------------------------------------------------ *
 * 元数据离线回退
 * ------------------------------------------------------------------ */

const META_CACHE_PREFIX = 'moonhd.props.';

/**
 * 带本地缓存的元数据获取。
 *
 * 为什么需要：`properties` 是**静态**文件（层级、瓦片尺寸、路径规则都不变），
 * 但它是接入瓦片的第一步。断网时 fetch 失败会让整个细节层不可用，
 * 即使 IndexedDB 里已经缓存了几百 MB 的瓦片——这很浪费：
 * 用户上次看过的区域本该能离线显示。
 *
 * 策略：成功时把原始 properties 文本存进 localStorage；
 * 失败时用缓存解析；缓存也没有才抛出（保持原有的安全降级）。
 *
 * @returns {{props:object, config:object, fromCache:boolean, error:Error|null}}
 */
export async function fetchSourceConfigCached(source = DEFAULT_SOURCE, { signal, fetchImpl, storage } = {}) {
  const store = storage !== undefined
    ? storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const key = META_CACHE_PREFIX + source.id;

  let liveError = null;
  try {
    const { props, config } = await fetchSourceConfig(source, { signal, fetchImpl });
    try { store?.setItem(key, JSON.stringify({ text: rawTextOf(props), at: Date.now() })); } catch { /* 配额满等，忽略 */ }
    return { props, config, fromCache: false, error: null };
  } catch (e) {
    liveError = e;
  }

  // 回退到缓存
  try {
    const saved = store?.getItem(key);
    if (saved) {
      const { text } = JSON.parse(saved);
      const props = parseProperties(text);
      return { props, config: makeSourceConfig(source, props), fromCache: true, error: liveError };
    }
  } catch { /* 缓存损坏，走抛出 */ }

  throw liveError || new Error('元数据不可用');
}

/**
 * 从解析结果里还原原始文本。
 *
 * parseProperties 保留了 raw 键值对，这里重新拼回 `k=v` 形式，
 * 保证缓存下来的内容仍能被 parseProperties 解析（而不是缓存一个派生对象）。
 */
function rawTextOf(props) {
  const raw = props && props.raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => `${k}= ${v}`).join('\n');
  }
  return '';
}
