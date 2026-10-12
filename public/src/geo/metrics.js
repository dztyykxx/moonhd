/**
 * 方向指示与局部比例尺。
 *
 * 两者都只用**视野中心附近**的月面信息：
 *  - 北向 = 中心点的"向北切向"在屏幕上的投影，不是固定朝上的 N；
 *  - 比例尺 = 中心横向上两个邻近像素射线各自的月面交点之间的角距 × 月球半径，
 *    所以它只描述中心附近，不代表整幅透视画面同一比例。
 *
 * 纯数学，不依赖 three.js；取交点由调用方通过 pickAt 回调提供。
 */
import { MOON_RADIUS_KM, DEG, dirFromLatLon } from './coords.js';

/** 北向切向量（月球局部系单位向量）；在极点退化，返回 null。 */
export function northTangent(lat, lon) {
  const n = dirFromLatLon(lat, lon, [0, 0, 0]);
  const up = [0, 1, 0];
  const d = n[0] * up[0] + n[1] * up[1] + n[2] * up[2];
  const t = [up[0] - d * n[0], up[1] - d * n[1], up[2] - d * n[2]];
  const len = Math.hypot(t[0], t[1], t[2]);
  if (!(len > 1e-6)) return null;
  return [t[0] / len, t[1] / len, t[2] / len];
}

/** 东向切向量（月球局部系单位向量），即经度增大的方向；极点退化返回 null。 */
export function eastTangent(lat, lon) {
  const n = dirFromLatLon(lat, lon, [0, 0, 0]);
  // d/dlon (cos lat·cos lon, sin lat, −cos lat·sin lon) ∝ (n.z, 0, −n.x)
  const t = [n[2], 0, -n[0]];
  const len = Math.hypot(t[0], t[1], t[2]);
  if (!(len > 1e-6)) return null;
  return [t[0] / len, t[1] / len, t[2] / len];
}

/**
 * 把 km/px 收成 1/2/5×10ⁿ 的整齐刻度，并给出它对应的像素长度。
 *
 * @param {number} kmPerPx 中心附近每 CSS 像素对应的公里数
 * @param {number} targetPx 期望的条长（像素）
 * @returns {{km:number, px:number}|null}
 */
export function niceScale(kmPerPx, targetPx = 96) {
  if (!(kmPerPx > 0) || !Number.isFinite(kmPerPx)) return null;
  const raw = kmPerPx * targetPx;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  const km = mult * mag;
  const px = km / kmPerPx;
  if (!Number.isFinite(px) || px < 16 || px > 260) return null;
  return { km, px };
}

/**
 * 局部比例尺。
 *
 * @param {object} o
 * @param {(nx:number, ny:number)=>({lat:number,lon:number}|null)} o.pickAt
 *   以 NDC 坐标取月面交点（未命中返回 null）
 * @param {number} o.screenW 画布 CSS 宽度
 * @param {number} [o.ndcSpan] 采样横向跨度（NDC）
 * @param {number} [o.radiusKm] 月球参考半径
 * @returns {{km:number, px:number, kmPerPx:number}|null}
 */
export function sampleLocalScale({ pickAt, screenW, ndcSpan = 0.12, radiusKm = MOON_RADIUS_KM }) {
  if (!(screenW > 0)) return null;
  const c = pickAt(0, 0);
  if (!c) return null;
  // 先向 +x 采样；如果在月缘外就改向 −x，两侧都不行则放弃
  let a = pickAt(ndcSpan, 0);
  let sign = 1;
  if (!a) { a = pickAt(-ndcSpan, 0); sign = -1; }
  if (!a) return null;

  const d2r = DEG;
  const p1 = dirFromLatLon(c.lat, c.lon, [0, 0, 0]);
  const p2 = dirFromLatLon(a.lat, a.lon, [0, 0, 0]);
  const cosA = Math.max(-1, Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]));
  const ang = Math.acos(cosA);
  const km = ang * radiusKm;
  const pxSpan = (Math.abs(ndcSpan) * screenW) / 2;
  if (!(pxSpan > 0)) return null;
  const kmPerPx = km / pxSpan;
  const nice = niceScale(kmPerPx);
  if (!nice) return null;
  return { km: nice.km, px: nice.px, kmPerPx, sign, d2r, spanDeg: ang / d2r };
}

/** 把公里数写成界面用的短标签（1/2/5 系列必然是整数或一位小数）。 */
export function formatScaleKm(km) {
  if (!Number.isFinite(km)) return '—';
  const digits = Number.isInteger(km) ? 0 : 1;
  return `${km.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 })} km`;
}
