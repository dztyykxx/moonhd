/**
 * 月面拾取：屏幕射线 × 解析球面。
 *
 * 只与一个半径 1 的球求交，**不遍历 HiPS 瓦片**。底球几何半径是 0.997、
 * 细节瓦片层在半径 1.0，两者相差 3e-3；拾取统一用半径 1.0，再把命中方向
 * 归一化后取经纬度，因此两层给出的是同一个经纬度，不会出现"点底图和高清区
 * 差一点"的问题。
 *
 * 纯数学，不依赖 three.js。
 */
import { latLonFromDir } from './coords.js';

/** 拾取球半径（月球局部系；底图 0.997、瓦片 1.0，取 1.0 并归一化）。 */
export const PICK_RADIUS = 1.0;

/** 标记/辅助线相对球面抬高的量，避免与球面 z-fighting。 */
export const SURFACE_LIFT = 0.0015;

/**
 * 射线与以原点为心、半径 r 的球求最近正交点。
 *
 * @param {number[]} origin 射线起点（月球局部系）
 * @param {number[]} dir 单位方向
 * @returns {number|null} 最近交点参数 t，未命中返回 null
 */
export function raySphereNearest(origin, dir, r = PICK_RADIUS) {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t0 > 1e-6) return t0;
  if (t1 > 1e-6) return t1;
  return null;
}

/**
 * 射线命中月面 → 月球局部坐标与经纬度。
 *
 * @returns {{t:number, local:number[], lat:number, lon:number, normal:number[]}|null}
 */
export function pickLocal(origin, dir, r = PICK_RADIUS) {
  const t = raySphereNearest(origin, dir, r);
  if (t === null) return null;
  const local = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const len = Math.hypot(local[0], local[1], local[2]) || 1;
  const normal = [local[0] / len, local[1] / len, local[2] / len];
  const { lat, lon } = latLonFromDir(normal);
  return { t, local, lat, lon, normal };
}

/**
 * 点是否被半径 r 的月球挡住（用于隐藏背面标签、自转轴端点、地名标注）。
 *
 * 判据：相机到该点的线段是否与球相交。点本身就在球面上时退化为
 * 常见的地平线判据 dot(n, cam) <= r。
 *
 * @param {number[]} camLocal 相机在月球局部系的位置
 * @param {number[]} pLocal 目标点（月球局部系）
 */
export function occludedBySphere(camLocal, pLocal, r = PICK_RADIUS) {
  const dx = pLocal[0] - camLocal[0];
  const dy = pLocal[1] - camLocal[1];
  const dz = pLocal[2] - camLocal[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (!(len2 > 0)) return false;
  // 球心到线段的最近点参数
  let t = -(camLocal[0] * dx + camLocal[1] * dy + camLocal[2] * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = camLocal[0] + dx * t;
  const cy = camLocal[1] + dy * t;
  const cz = camLocal[2] + dz * t;
  const dist = Math.hypot(cx, cy, cz);
  // 线段整体在球外，或最近点就在目标点本身（点贴在球面上）时不算遮挡
  if (dist >= r) return false;
  if (t >= 1 - 1e-9) return false;
  return true;
}
