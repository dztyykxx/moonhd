/**
 * 月固坐标契约：内部表示、方向向量、格式化、输入解析。
 *
 * 契约（全程序唯一一套，任何入口都不得另立公式）：
 *   lat  纬度，北正南负，[-90, 90]，度
 *   lon  经度，东正西负，内部规范化为 [-180, 180)，度
 *
 * 渲染坐标系（three.js 里 moon 的局部系）是 **y 轴指向北极**：
 *   dir = (cos lat·cos lon, sin lat, −cos lat·sin lon)
 *   lat = asin(dir.y)
 *   lon = atan2(−dir.z, dir.x)
 *
 * 注意这与 `hips/healpix.js` 的天文坐标系（z = 极轴）不是同一套。边界只在
 * main.js 的 `renderToHp` / `hpToRender` 一处来回转换，本文件不碰天文系。
 *
 * 本文件是纯数学，不依赖 three.js，可直接在 Node 下测试。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 月球参考半径（km）。IAU 平均半径 1737.4 km。用于比例尺与球面角距换算。 */
export const MOON_RADIUS_KM = 1737.4;

export { DEG, RAD };

/** 把经度规范化到 [-180, 180)。180 与 −180 是同一根子午线，统一取 −180。 */
export function wrapLon(lon) {
  if (!Number.isFinite(lon)) return NaN;
  let x = ((lon + 180) % 360 + 360) % 360 - 180;
  // 上述运算对 180 会给出 −180；对 −0 也归零
  if (x === 0) x = 0;
  return x;
}

/** 角度规范化到 [0, 360)。 */
export function wrap360(deg) {
  if (!Number.isFinite(deg)) return NaN;
  return ((deg % 360) + 360) % 360;
}

/** 经度差是否跨 ±180°（用于判断两点谁在东侧）。 */
export function lonDelta(a, b) {
  return wrapLon(a - b);
}

/** 经纬度（度）→ 渲染系单位方向向量。 */
export function dirFromLatLon(lat, lon, out = [0, 0, 0]) {
  const cl = Math.cos(lat * DEG);
  out[0] = cl * Math.cos(lon * DEG);
  out[1] = Math.sin(lat * DEG);
  out[2] = -cl * Math.sin(lon * DEG);
  return out;
}

/** 渲染系方向向量 → { lat, lon }（度）。输入不必是单位向量。 */
export function latLonFromDir(v) {
  const x = v[0], y = v[1], z = v[2];
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) return { lat: NaN, lon: NaN };
  const lat = Math.asin(Math.max(-1, Math.min(1, y / len))) * RAD;
  const lon = wrapLon(Math.atan2(-z / len, x / len) * RAD);
  return { lat, lon: lon === 0 ? 0 : lon };
}

/** 两个单位方向之间的球面角距（弧度）。 */
export function angleBetween(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/** 两个经纬度点之间的球面角距（度）。 */
export function separationDeg(lat1, lon1, lat2, lon2) {
  const a = dirFromLatLon(lat1, lon1, [0, 0, 0]);
  const b = dirFromLatLon(lat2, lon2, [0, 0, 0]);
  return angleBetween(a, b) * RAD;
}

/** 两个经纬度点之间的大圆距离（km）。 */
export function greatCircleKm(lat1, lon1, lat2, lon2, radiusKm = MOON_RADIUS_KM) {
  return separationDeg(lat1, lon1, lat2, lon2) * DEG * radiusKm;
}

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

/** 把绝对值小于半个末位的数归零，避免出现 "−0.00°"。 */
function killNegZero(v, decimals) {
  const q = 0.5 * 10 ** -decimals;
  return Math.abs(v) < q ? 0 : v;
}

/** 固定小数位，且不带负零。 */
export function fixed(v, decimals = 2) {
  if (!Number.isFinite(v)) return '—';
  return killNegZero(v, decimals).toFixed(decimals);
}

/** 纬度 → "43.31° S"；0 → "0.00° N"。 */
export function formatLat(lat, decimals = 2) {
  if (!Number.isFinite(lat)) return '—';
  const v = killNegZero(lat, decimals);
  const hemi = v < 0 ? 'S' : 'N';
  return `${Math.abs(v).toFixed(decimals)}° ${hemi}`;
}

/** 经度 → "11.36° W"。 */
export function formatLon(lon, decimals = 2) {
  if (!Number.isFinite(lon)) return '—';
  const v = killNegZero(wrapLon(lon), decimals);
  const hemi = v < 0 ? 'W' : 'E';
  return `${Math.abs(v).toFixed(decimals)}° ${hemi}`;
}

/** "43.31° S · 11.36° W"。 */
export function formatLatLon(lat, lon, decimals = 2) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${formatLat(lat, decimals)} · ${formatLon(lon, decimals)}`;
}

/** 复制到剪贴板用的纯小数形式："-43.31, -11.36"。 */
export function formatClipboard(lat, lon, decimals = 2) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  return `${killNegZero(lat, decimals).toFixed(decimals)}, ${killNegZero(wrapLon(lon), decimals).toFixed(decimals)}`;
}

/* ------------------------------------------------------------------ *
 * 输入解析
 * ------------------------------------------------------------------ */

/**
 * 全角/异体字符归一：中文逗号、全角数字与符号、Unicode 负号、度数符号。
 * 不改变语义，只把常见的输入法产物收敛成 ASCII。
 */
export function normalizeInputText(raw) {
  return String(raw ?? '')
    // 全角数字（中文输入法下很常见）
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF0C\u3001\uFF1B;]/g, ',')
    .replace(/[\uFF0E]/g, '.')
    .replace(/[\u2212\u2013\u2014\uFF0D]/g, '-')
    .replace(/[\u00BA\u02DA]/g, '°')
    .replace(/[\u2032\u2019\u02B9]/g, "'")
    .replace(/[\u2033\u201D]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/\uFF08/g, '(')
    .replace(/\uFF09/g, ')')
    .trim();
}

const DIR_ONLY = /^[NSEWnsew]$/;

/**
 * 把输入拆成两个"分量"。
 *
 * 有逗号就按逗号拆；否则按空白拆，并把孤立的 N/S/E/W 与相邻数字合并
 * （`N 43.31 W 11.36` → `N43.31` / `W11.36`）。
 */
function splitComponents(body) {
  const raw = body.includes(',') ? body.split(',') : body.split(/\s+/);
  let toks = raw.map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (DIR_ONLY.test(t)) {
      const prev = out[out.length - 1];
      if (prev && /\d/.test(prev) && !/[NSEWnsew]$/.test(prev)) out[out.length - 1] = prev + t;
      else if (i + 1 < toks.length) toks[i + 1] = t + toks[i + 1];
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * 解析单个分量：返回 { value, hemi, minus } 或 null。
 * 接受 `12.4` · `12.4N` · `N12.4` · `-12.4` · `43°31'` · `43°31'12"S`。
 */
function parseComponent(token) {
  const t = token.replace(/\s+/g, '');
  if (!t) return null;

  // 度分秒 / 度分
  let m = /^([NSEWnsew]?)([+-]?)(\d+(?:\.\d+)?|\.\d+)[°d](?:(\d+(?:\.\d+)?)['\u2032])?(?:(\d+(?:\.\d+)?)["\u2033])?([NSEWnsew]?)$/.exec(t);
  if (m && (m[3] || m[4])) {
    const deg = Math.abs(Number(m[2] + m[3]));
    const min = Number(m[4] || 0);
    const sec = Number(m[5] || 0);
    const sign = m[2] === '-' ? -1 : 1;
    const hemi = (m[6] || m[1] || '').toUpperCase() || null;
    return { value: sign * (deg + min / 60 + sec / 3600), hemi, minus: m[2] === '-' };
  }

  // 十进制度（可带度数符号与方向字母，方向在前或在后）
  const t2 = t.replace(/[°\u00BA\u02DA]/g, '');
  m = /^([NSEWnsew]?)([+-]?)(\d+(?:\.\d+)?|\.\d+)([NSEWnsew]?)$/.exec(t2);
  if (m) {
    const hemi = (m[4] || m[1] || '').toUpperCase() || null;
    return { value: Number(m[2] + m[3]), hemi, minus: m[2] === '-' };
  }
  return null;
}

const LAT_H = new Set(['N', 'S']);
const LON_H = new Set(['E', 'W']);

/**
 * 解析用户输入的经纬度。
 *
 * 接受：`12.40, 18.60` · `12.40 18.60` · `12.40°N, 18.60°E` · `N12.40 E18.60`
 *      · `12.40S 18.60W` · `43°31'S 11°22'W`
 *
 * 返回 { ok:true, lat, lon } 或 { ok:false, code, message }。
 * 超范围一律报错，**不**把纬度裁到边界（设计文档 7.2 明确要求）。
 */
export function parseLatLonInput(raw) {
  const text = normalizeInputText(raw);
  if (!text) return { ok: false, code: 'empty', message: '请输入纬度与经度' };

  // 去掉包裹的括号
  const body = text.replace(/^[(\[]/, '').replace(/[)\]]$/, '').trim();
  const tokens = splitComponents(body);
  if (tokens.length !== 2) {
    return { ok: false, code: 'format', message: '输入格式：纬度, 经度（例如 43.31S, 11.36W）' };
  }

  const a = parseComponent(tokens[0]);
  const b = parseComponent(tokens[1]);
  if (!a || !b) {
    return { ok: false, code: 'format', message: '输入格式：纬度, 经度（例如 12.40, 18.60）' };
  }

  const ah = a.hemi, bh = b.hemi;
  const aIsLat = ah ? LAT_H.has(ah) : null;
  const aIsLon = ah ? LON_H.has(ah) : null;
  const bIsLat = bh ? LAT_H.has(bh) : null;
  const bIsLon = bh ? LON_H.has(bh) : null;

  let latC, lonC;
  if (ah && bh) {
    if (aIsLat && bIsLon) { latC = a; lonC = b; }
    else if (aIsLon && bIsLat) { latC = b; lonC = a; }
    else {
      return { ok: false, code: 'format', message: '两端的 N/S 与 E/W 必须一个是纬度、一个是经度' };
    }
  } else if (ah && !bh) {
    // 只给了一个方向标记：用它的语义决定谁是纬度，另一位按位置补
    if (aIsLat) { latC = a; lonC = b; }
    else if (aIsLon) { lonC = a; latC = b; }
    else return { ok: false, code: 'format', message: '方向标记只能是 N/S/E/W' };
  } else if (!ah && bh) {
    if (bIsLat) { latC = b; lonC = a; }
    else if (bIsLon) { lonC = b; latC = a; }
    else return { ok: false, code: 'format', message: '方向标记只能是 N/S/E/W' };
  } else {
    // 都没有方向标记：按“纬度, 经度”的约定
    latC = a; lonC = b;
  }

  // 符号与方向矛盾
  if (latC.hemi && latC.minus) {
    return { ok: false, code: 'conflict', message: `纬度符号与方向矛盾：${latC.minus ? '−' : ''}${latC.hemi}` };
  }
  if (lonC.hemi && lonC.minus) {
    return { ok: false, code: 'conflict', message: `经度符号与方向矛盾：−${lonC.hemi}` };
  }

  const latMag = Math.abs(latC.value);
  const lonMag = Math.abs(lonC.value);
  if (!Number.isFinite(latMag) || !Number.isFinite(lonMag)) {
    return { ok: false, code: 'format', message: '无法识别的数字' };
  }

  let lat = latMag * (latC.hemi === 'S' || latC.minus ? -1 : 1);
  let lon = lonMag * (lonC.hemi === 'W' || lonC.minus ? -1 : 1);

  if (latMag > 90) {
    return { ok: false, code: 'range-lat', message: `纬度须在 −90° 至 90° 之间（读到 ${fixed(latMag)}）` };
  }
  if (lonMag > 360) {
    return { ok: false, code: 'range-lon', message: `经度须在 −360° 至 360° 之间（读到 ${fixed(lonMag)}）` };
  }
  if (lat === 0) lat = 0;
  lon = wrapLon(lon);
  return { ok: true, lat, lon, normalized: formatLatLon(lat, lon) };
}

/**
 * 判断一段文本是否像经纬度（用于搜索框分流）。只做保守判断，
 * 真正解析仍走 parseLatLonInput。
 */
export function looksLikeCoordinates(raw) {
  const t = normalizeInputText(raw);
  if (!t) return false;
  if (!/\d/.test(t)) return false;
  return /^[(\[]?\s*[NSEWnsew+-]?\s*\d+(?:\.\d+)?\s*(?:°|'|\s*[NSEWnsew])?\s*[, ]\s*[NSEWnsew+-]?\s*\d+(?:\.\d+)?/.test(t);
}
