/**
 * 视野与 LOD 选择：决定当前画面需要哪些 HiPS 瓦片、各自什么层级。
 *
 * 做法：从 12 个基础瓦片（order 0）开始的四叉树遍历。
 * 对每个候选瓦片计算它在屏幕上的实际像素跨度（把瓦片中心与四角投到屏幕空间，
 * 取到中心的最大距离），只有当"一张 512px 瓦片被放大到超过阈值像素"时才继续
 * 细分。这样：
 *   - 视野中心（离相机近、被放大）自动拿到高层级；
 *   - 视野边缘/月缘（被压缩）自动停在低层级，不会为了一小块区域拉一堆瓦片；
 *   - 不是"永远加载最高层"，而是让影像像素与屏幕像素接近。
 *
 * 与分辨率无关的输入只有相机与画布尺寸，因此可在 Node 下用假相机测试。
 */
import {
  tilePointVec, vecToLonLat, lonLatToVec, tilePath, orderToNside,
} from './healpix.js';

export const DEFAULT_LOD = {
  /** 一张瓦片在屏幕上超过这么多像素就继续细分（≈ 每屏幕像素对应多少影像像素）。 */
  screenPxPerTile: 620,
  /** 层级滞回：当前层级与目标层级差小于该值时保持不变，减少抖动。 */
  hysteresis: 0.25,
  /** 最高层级上限（也受数据源 hips_order 限制）。 */
  maxOrder: 9,
  /** 一次选择最多返回多少张瓦片。 */
  maxTiles: 320,
  /** 屏幕采样网格（用于估计可视球冠半径与视口覆盖）。 */
  gridX: 17,
  gridY: 13,
};

/**
 * 相机可见的球面区域：以"相机正下方点"为极的球冠。
 * 解析式在近距离掠射时容易退化，因此主用 visibleCapBySampling()，
 * 这里只提供一个不依赖投影矩阵的粗略估计（供测试与降级使用）。
 */
export function visibleCapApprox(camLocal, fovDeg, aspect, margin = 1.06) {
  const p = camLocal;
  const d = Math.hypot(p[0], p[1], p[2]) || 1;
  const center = [p[0] / d, p[1] / d, p[2] / d];
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const half = Math.max(halfV, halfH);
  const limb = Math.acos(Math.min(1, 1 / d));
  // 视锥角点方向与视线方向的夹角（保守取 √2 倍半视场）
  const corner = Math.min(Math.PI / 2, half * Math.SQRT2);
  const los = Math.min(Math.PI / 2, corner + limb);
  const b = d * Math.cos(los);
  const c = d * d - 1;
  const delta = b * b - c;
  let radius;
  if (delta <= 0) {
    radius = limb;                                  // 该方向已越过月缘
  } else {
    const t = -b + Math.sqrt(delta);
    const hx = p[0] + Math.cos(los) * 0 + t * 0;    // 交点方向与视线夹角即为球面角
    void hx;
    radius = Math.min(limb, Math.acos(Math.min(1, 1 / d)) + corner);
  }
  radius = Math.min(Math.PI, radius * margin);
  return { center, cosCap: Math.cos(radius), radiusDeg: (radius * 180) / Math.PI };
}

/**
 * 数值采样视口得到可视球冠：把屏幕网格上的像素反投影成射线与单位球求交，
 * 取所有交点与"相机正下方点"的最大夹角。
 * 这个做法对近距离相机（球面占满画面、边缘掠射）也稳定。
 *
 * @param {number[]} camLocal 相机在月球局部坐标的位置
 * @param {(nx:number, ny:number)=>number[]} unproject 归一化设备坐标 → 世界方向（局部坐标）
 * @param {object} [cfg]
 */
export function visibleCapBySampling(camLocal, unproject, cfg = DEFAULT_LOD) {
  const p = camLocal;
  const d = Math.hypot(p[0], p[1], p[2]) || 1;
  const center = [p[0] / d, p[1] / d, p[2] / d];
  let maxAng = 0;
  const nx = cfg.gridX, ny = cfg.gridY;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const u = (i / nx) * 2 - 1;
      const v = (j / ny) * 2 - 1;
      const dir = unproject(u, v);
      if (!dir) continue;
      const b = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
      const c = d * d - 1;
      const delta = b * b - c;
      if (delta <= 0) {
        // 该像素方向没有打到球面（视野越过月缘）→ 取月缘
        maxAng = Math.max(maxAng, Math.acos(Math.min(1, 1 / d)));
        continue;
      }
      // 取**近**交点：相机在球外时 -b - √delta 才是朝向相机的那一面。
      // 用远交点会把"背面"也算进可视区，导致可视球冠接近整个球面、
      // LOD 判断失效（症状：只选到很低层级）。
      const t = -b - Math.sqrt(delta);
      if (t <= 0) continue;
      const hx = p[0] + dir[0] * t, hy = p[1] + dir[1] * t, hz = p[2] + dir[2] * t;
      const hl = Math.hypot(hx, hy, hz) || 1;
      const dot = (hx * center[0] + hy * center[1] + hz * center[2]) / hl;
      maxAng = Math.max(maxAng, Math.acos(Math.max(-1, Math.min(1, dot))));
    }
  }
  return { center, cosCap: Math.cos(maxAng), radiusDeg: (maxAng * 180) / Math.PI };
}

/** 单个方向的可见性（球面地平线 + 可视球冠）。 */
export function pointVisible(vec, camLocal, cosCap, slack = 1) {
  const d = Math.hypot(camLocal[0], camLocal[1], camLocal[2]) || 1;
  const c = [camLocal[0] / d, camLocal[1] / d, camLocal[2] / d];
  const horizon = 1 / d;
  const dot = (vec[0] * camLocal[0] + vec[1] * camLocal[1] + vec[2] * camLocal[2]) / d;
  if (dot < horizon * slack) return false;
  if (cosCap !== undefined && cosCap !== null) {
    const cc = vec[0] * c[0] + vec[1] * c[1] + vec[2] * c[2];
    if (cc < cosCap) return false;
  }
  return true;
}

/**
 * 瓦片的角半径：瓦片中心到最远角的角距（弧度）。
 *
 * 用来做"瓦片与可视区是否可能相交"的判定。四叉树遍历必须能一路下降到
 * 真正覆盖视野的那一层，所以父瓦片的判定必须考虑它自身的跨度。
 */
export function tileAngularRadius(order, npix) {
  const nside = 2 ** order;
  const c = tilePointVec(npix, nside, 0.5, 0.5);
  let maxAng = 0;
  for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const v = tilePointVec(npix, nside, s, t);
    const dot = Math.max(-1, Math.min(1, c[0] * v[0] + c[1] * v[1] + c[2] * v[2]));
    maxAng = Math.max(maxAng, Math.acos(dot));
  }
  return maxAng;
}

/**
 * 瓦片可见性：瓦片与"可视球冠"是否**可能相交**。
 *
 * 这里的关键是不能只看中心与四角落在不在球冠里。
 * 近距离时可视球冠很小（d=1.05 时角半径只有 1.86°），而 order 0 瓦片跨 58°：
 * 球冠整个落在某张父瓦片内部，但父瓦片的中心与四个角**都在球冠外**，
 * 于是 12 张 order 0 瓦片全被判为不可见，四叉树一步都下降不了，
 * 结果一张瓦片都选不出来（实测：d≤1.10 时 tiles=0，而 d=1.22 时还有 45 张）。
 *
 * 正确判据是把瓦片自身的角半径算进去：
 *   瓦片中心方向与球冠中心的夹角 ≤ 球冠角半径 + 瓦片角半径
 * 地平线判定同理（掠射边缘要放宽一个瓦片角半径）。
 */
export function tileVisible(order, npix, camLocal, cosCap, capRadiusRad = null) {
  const nside = 2 ** order;
  const c = tilePointVec(npix, nside, 0.5, 0.5);
  const r = tileAngularRadius(order, npix);
  const d = Math.hypot(camLocal[0], camLocal[1], camLocal[2]) || 1;
  const center = [camLocal[0] / d, camLocal[1] / d, camLocal[2] / d];

  // 地平线：点积 > 1/d 才在朝向相机的一侧；放宽 r 以照顾跨过月缘的瓦片
  const horizon = 1 / d;
  const dotCam = (c[0] * camLocal[0] + c[1] * camLocal[1] + c[2] * camLocal[2]) / d;
  if (dotCam < horizon * Math.cos(r) - Math.sin(r) * Math.sqrt(Math.max(0, 1 - horizon * horizon))) return false;

  if (cosCap !== undefined && cosCap !== null) {
    const cc = c[0] * center[0] + c[1] * center[1] + c[2] * center[2];
    // 球冠角半径：优先用调用方给的（capRadiusRad），否则由 cosCap 反解
    const capR = capRadiusRad !== null && capRadiusRad !== undefined
      ? capRadiusRad
      : Math.acos(Math.max(-1, Math.min(1, cosCap)));
    if (cc < Math.cos(Math.min(Math.PI, capR + r))) return false;
  }
  return true;
}

/** 兼容旧名：只判断中心点。 */
export function isVisible(centerVec, camLocal, cosCap) {
  return pointVisible(centerVec, camLocal, cosCap);
}

/**
 * 选择瓦片集合。
 *
 * @param {object} o
 * @param {number[]} o.camLocal       相机在月球局部坐标
 * @param {(v:number[])=>number[]|null} o.project 局部方向向量 → 屏幕像素 [x, y]（不可见返回 null）
 * @param {number} o.screenW
 * @param {number} o.screenH
 * @param {number} o.orderMax         数据源最高层级
 * @param {object} [o.cfg]
 * @param {number} [o.prevMaxOrder]   上一次的中心层级（用于滞回）
 * @returns {{tiles:Array<{order:number,npix:number,path:string,priority:number,screenPx:number,centerLonLat:{lon:number,lat:number}}>, maxOrder:number, capRadiusDeg:number, nodes:number}}
 */
export function selectTiles(o) {
  const cfg = { ...DEFAULT_LOD, ...(o.cfg || {}) };
  const orderMax = Math.min(cfg.maxOrder, o.orderMax ?? cfg.maxOrder);
  const camLocal = o.camLocal;
  const cap = o.cap || null;                 // 由调用方传入 visibleCapBySampling 的结果
  const cosCap = cap ? cap.cosCap : null;
  const capRadiusRad = cap && Number.isFinite(cap.radiusDeg)
    ? (cap.radiusDeg * Math.PI) / 180
    : null;
  const center = cap ? cap.center : (() => {
    const d = Math.hypot(camLocal[0], camLocal[1], camLocal[2]) || 1;
    return [camLocal[0] / d, camLocal[1] / d, camLocal[2] / d];
  })();

  const tiles = [];
  let nodes = 0;

  const visit = (order, npix) => {
    if (tiles.length >= cfg.maxTiles) return;
    nodes++;
    const c = tilePointVec(npix, orderToNside(order), 0.5, 0.5);
    if (!tileVisible(order, npix, camLocal, cosCap, capRadiusRad)) return;

    const projected = o.project(c);
    if (!projected) return;
    // 屏幕跨度：中心与四角投影后的最大距离（角点不可见时用中心估计）
    let screenPx = 0;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    let anyCorner = false;
    for (const [s, t] of corners) {
      const v = tilePointVec(npix, orderToNside(order), s, t);
      const pv = o.project(v);
      if (!pv) continue;
      anyCorner = true;
      const dx = pv[0] - projected[0], dy = pv[1] - projected[1];
      screenPx = Math.max(screenPx, Math.hypot(dx, dy));
    }
    if (!anyCorner) {
      // 角点都在屏幕外：用中心到屏幕中心的距离粗估（保守地继续细分）
      screenPx = Math.hypot(projected[0] - o.screenW / 2, projected[1] - o.screenH / 2) * 2;
    }

    const wantChild = order < orderMax && screenPx > cfg.screenPxPerTile;
    if (wantChild) {
      for (let k = 0; k < 4; k++) visit(order + 1, npix * 4 + k);
      return;
    }
    // 优先级：离屏幕中心越近越优先
    const dx = (projected[0] - o.screenW / 2) / o.screenW;
    const dy = (projected[1] - o.screenH / 2) / o.screenH;
    const priority = Math.hypot(dx, dy);
    tiles.push({
      order, npix, path: tilePath(order, npix),
      priority, screenPx,
      centerLonLat: vecToLonLat(c),
    });
  };

  for (let p = 0; p < 12; p++) visit(0, p);
  tiles.sort((a, b) => a.priority - b.priority);
  if (tiles.length > cfg.maxTiles) tiles.length = cfg.maxTiles;

  // 中心层级：屏幕中心附近瓦片的层级（用于滞回判断与界面显示）
  const mid = tiles[Math.min(tiles.length - 1, Math.floor(tiles.length * 0.25))];
  const maxOrder = mid ? mid.order : 0;
  return {
    tiles, maxOrder, nodes,
    capRadiusDeg: cap ? cap.radiusDeg : null,
  };
}

/**
 * 层级滞回：当新的中心层级与上一次接近时，沿用上一次（减少自转/小幅缩放抖动）。
 * 返回 [目标层级下限, 上限]。
 */
export function levelWindow(newOrder, prevOrder, cfg = DEFAULT_LOD) {
  if (prevOrder === null || prevOrder === undefined) return [newOrder, newOrder];
  const diff = newOrder - prevOrder;
  if (Math.abs(diff) <= cfg.hysteresis + 1e-9) return [Math.min(newOrder, prevOrder), Math.max(newOrder, prevOrder)];
  return [newOrder, newOrder];
}

/**
 * 计算瓦片集合的差异，供渲染层做渐进替换：
 * 返回 { added, removed, kept }。
 */
export function diffTiles(prevKeys, nextTiles) {
  const next = new Set(nextTiles.map((t) => t.order + '/' + t.npix));
  const added = [], kept = [];
  for (const t of nextTiles) {
    const k = t.order + '/' + t.npix;
    if (prevKeys.has(k)) kept.push(k); else added.push(k);
  }
  const removed = [];
  for (const k of prevKeys) if (!next.has(k)) removed.push(k);
  return { added, removed, kept };
}

/** 经纬度 → 该层级下的瓦片编号（供"跳到某个地标"之类的功能使用）。 */
export function tileAtLonLat(order, lon, lat) {
  const nside = orderToNside(order);
  const v = lonLatToVec(lon, lat);
  // 这里只做局部搜索：以中心点反查最接近的瓦片
  let best = 0, bestDot = -2;
  const n = 12 * nside * nside;
  const stride = Math.max(1, Math.floor(n / 4096));
  for (let p = 0; p < n; p += stride) {
    const c = tilePointVec(p, nside, 0.5, 0.5);
    const dot = c[0] * v[0] + c[1] * v[1] + c[2] * v[2];
    if (dot > bestDot) { bestDot = dot; best = p; }
  }
  return best;
}
