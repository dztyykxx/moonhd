/**
 * HEALPix NESTED 球面索引 —— HiPS 瓦片定位。
 *
 * 算法来源：astrometry.net 的 healpix.c（`hp_to_xyz` / `xyztohp` /
 * `healpixl_nested_to_xy` / `healpixl_xy_to_nested`），随 astropy-healpix 2.0.1
 * 分发（BSD-3-Clause, https://github.com/astropy/astropy-healpix）。本文件是
 * 这些函数的逐行移植，**不是**凭公式猜测；与 astropy-healpix 的
 * healpix_to_lonlat / lonlat_to_healpix 逐点比对见 test/healpix.test.mjs
 * （参考向量由 tools/gen-healpix-reference.py 生成，490 点最大偏差 < 1e-13 度）。
 *
 * 只使用 NESTED 编号，不使用 RING。
 *
 * 坐标约定（与 HiPS / FITS 一致，单位：度）：
 *   lon ∈ [-180, 180]，东经为正；lat ∈ [-90, 90]。
 *   笛卡尔方向向量 v = (cos lat·cos lon, cos lat·sin lon, sin lat)。
 *
 * 本文件是纯数学，不依赖 three.js，便于在 Node 下直接测试。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const PI = Math.PI;
const HALF_PI = PI / 2;
const TWO_PI = 2 * PI;
const TWOTHIRDS = 2 / 3;
const ROOT3 = Math.sqrt(3);

/** HiPS order（层级）n 对应 HEALPix nside = 2^n。 */
export function orderToNside(order) {
  return 2 ** order;
}

/** 第 order 层的瓦片总数 = 12 · 4^order。 */
export function npixOfOrder(order) {
  return 12 * 4 ** order;
}

/** 由 nside 反推 order（nside 必须是 2 的幂）。 */
export function nsideToOrder(nside) {
  const o = Math.round(Math.log2(nside));
  if (2 ** o !== nside) throw new Error('nside must be a power of two: ' + nside);
  return o;
}

/** HiPS 官方文件路径规则：Norder{o}/Dir{floor(npix/10000)*10000}/Npix{npix}.png */
export function tilePath(order, npix, ext = 'png') {
  if (!Number.isInteger(npix) || npix < 0 || npix >= npixOfOrder(order)) {
    throw new RangeError(`npix ${npix} 超出 order ${order} 的范围 [0, ${npixOfOrder(order) - 1}]`);
  }
  const dir = Math.floor(npix / 10000) * 10000;
  return `Norder${order}/Dir${dir}/Npix${npix}.${ext}`;
}

/** 经纬度（度）→ 单位方向向量。 */
export function lonLatToVec(lon, lat, out = [0, 0, 0]) {
  const c = Math.cos(lat * DEG);
  out[0] = c * Math.cos(lon * DEG);
  out[1] = c * Math.sin(lon * DEG);
  out[2] = Math.sin(lat * DEG);
  return out;
}

/** 单位方向向量 → { lon, lat }（度）。 */
export function vecToLonLat(v) {
  const lon = Math.atan2(v[1], v[0]) * RAD;
  const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD;
  return { lon, lat };
}

/* ------------------------------------------------------------------ *
 * NESTED ↔ face 局部 (x, y)
 * ------------------------------------------------------------------ */

/**
 * NESTED 编号 → { face, x, y }（移植 healpixl_nested_to_xy）。
 * npix = face·nside² + Σ_i [ x_i·4^i + y_i·2·4^i ]，即 (y, x) 交替位。
 */
export function nestedToFaceXY(npix, nside) {
  const ns2 = nside * nside;
  const face = Math.floor(npix / ns2);
  let index = npix % ns2;
  let x = 0, y = 0;
  for (let i = 0; i < 32; i++) {
    x |= (index & 1) << i; index >>>= 1;
    y |= (index & 1) << i; index >>>= 1;
    if (!index) break;
  }
  return { face, x, y };
}

/** { face, x, y } → NESTED 编号（移植 healpixl_xy_to_nested）。 */
export function faceXYToNested(face, x, y, nside) {
  let index = 0;
  for (let i = 0; i < 32; i++) {
    index += ((x & 1) + 2 * (y & 1)) * 4 ** i;
    y >>>= 1; x >>>= 1;
    if (!x && !y) break;
  }
  return index + face * nside * nside;
}

/* ------------------------------------------------------------------ *
 * NESTED → 方向向量（移植 hp_to_xyz）
 * ------------------------------------------------------------------ */

/**
 * NESTED 瓦片 → 方向向量。dx/dy ∈ [0,1] 是瓦片内的局部位置
 * （dx 向东、dy 向北），(0.5, 0.5) 为瓦片中心。
 * 返回单位向量 [x, y, z]。
 */
export function tilePointVec(npix, nside, dx = 0.5, dy = 0.5, out = [0, 0, 0]) {
  const { face: face0, x: xp, y: yp } = nestedToFaceXY(npix, nside);
  let chp = face0;
  let equatorial = true;
  let zfactor = 1;
  let x = xp + dx;
  let y = yp + dy;

  if (chp <= 3 && x + y > nside) { equatorial = false; zfactor = 1; }
  if (chp >= 8 && x + y < nside) { equatorial = false; zfactor = -1; }

  let z, phi, rad;
  if (equatorial) {
    let zoff = 0, phioff = 0;
    x /= nside; y /= nside;
    if (chp <= 3) {
      phioff = 1;
    } else if (chp <= 7) {
      zoff = -1; chp -= 4;
    } else {
      phioff = 1; zoff = -2; chp -= 8;
    }
    z = TWOTHIRDS * (x + y + zoff);
    phi = (PI / 4) * (x - y + phioff + 2 * chp);
    rad = Math.sqrt(Math.max(0, 1 - z * z));
  } else {
    if (zfactor === -1) {
      const t = x;
      x = nside - y;
      y = nside - t;
    }
    let phi_t;
    if (y === nside && x === nside) phi_t = 0;
    else phi_t = (PI * (nside - y)) / (2 * ((nside - x) + (nside - y)));
    let vv;
    if (phi_t < PI / 4) {
      vv = Math.abs((PI * (nside - x)) / ((2 * phi_t - PI) * nside) / ROOT3);
    } else {
      vv = Math.abs((PI * (nside - y)) / (2 * phi_t * nside) / ROOT3);
    }
    z = (1 - vv) * (1 + vv);
    rad = Math.sqrt(Math.max(0, 1 + z)) * vv;
    z *= zfactor;
    phi = chp >= 8 ? HALF_PI * (chp - 8) + phi_t : HALF_PI * chp + phi_t;
  }
  if (phi < 0) phi += TWO_PI;
  out[0] = rad * Math.cos(phi);
  out[1] = rad * Math.sin(phi);
  out[2] = z;
  return out;
}

export function pix2vec(nside, npix, out = [0, 0, 0]) {
  const npixCap = 12 * nside * nside;
  if (!Number.isInteger(npix) || npix < 0 || npix >= npixCap) {
    throw new RangeError(`npix ${npix} 超出 nside ${nside} 的范围 [0, ${npixCap - 1}]`);
  }
  return tilePointVec(npix, nside, 0.5, 0.5, out);
}

export function pix2lonlat(nside, npix) {
  return vecToLonLat(pix2vec(nside, npix));
}

/* ------------------------------------------------------------------ *
 * 方向向量 → NESTED（移植 xyztohp）
 * ------------------------------------------------------------------ */

/**
 * 方向向量 → NESTED 编号。
 * coz 为 cos(纬度)（等价于 sqrt(x²+y²)），传 0 时自动计算。
 */
export function vec2pixCoords(x, y, z, nside, coz = 0) {
  const n = Math.hypot(x, y, z) || 1;
  x /= n; y /= n; z /= n;
  let phi = Math.atan2(y, x);
  if (phi < 0) phi += TWO_PI;
  const phi_t = phi % HALF_PI;

  let basehp, ix, iy;
  if (z >= TWOTHIRDS || z <= -TWOTHIRDS) {
    // 极冠
    const north = z >= TWOTHIRDS;
    const vz = north ? z : -z;
    if (coz === 0) coz = Math.hypot(x, y);
    const kx = (coz / Math.sqrt(1 + vz)) * ROOT3 * Math.abs((nside * (2 * phi_t - PI)) / PI);
    const ky = (coz / Math.sqrt(1 + vz)) * ROOT3 * nside * (2 * phi_t) / PI;
    let xx, yy;
    if (north) { xx = nside - kx; yy = nside - ky; }
    else { xx = ky; yy = kx; }
    ix = Math.min(nside - 1, Math.max(0, Math.floor(xx)));
    iy = Math.min(nside - 1, Math.max(0, Math.floor(yy)));
    const sector = (phi - phi_t) / HALF_PI;
    const offset = ((Math.round(sector) % 4) + 4) % 4;
    basehp = north ? offset : 8 + offset;
  } else {
    const zunits = (z + TWOTHIRDS) / (4 / 3);
    const phiunits = phi_t / HALF_PI;
    const u1 = zunits + phiunits;
    const u2 = zunits - phiunits + 1;
    let xx = u1 * nside;
    let yy = u2 * nside;
    const sector = (phi - phi_t) / HALF_PI;
    const offset = ((Math.round(sector) % 4) + 4) % 4;
    if (xx >= nside) {
      xx -= nside;
      if (yy >= nside) { yy -= nside; basehp = offset; }
      else { basehp = ((offset + 1) % 4) + 4; }
    } else {
      if (yy >= nside) { yy -= nside; basehp = offset + 4; }
      else { basehp = 8 + offset; }
    }
    ix = Math.max(0, Math.min(nside - 1, Math.floor(xx)));
    iy = Math.max(0, Math.min(nside - 1, Math.floor(yy)));
  }
  return faceXYToNested(basehp, ix, iy, nside);
}

export function vec2pix(nside, x, y, z) {
  return vec2pixCoords(x, y, z, nside);
}

/* ------------------------------------------------------------------ *
 * 瓦片几何
 * ------------------------------------------------------------------ */

/** 瓦片中心经纬度（度）。 */
export function tileCenterLonLat(order, npix) {
  return pix2lonlat(orderToNside(order), npix);
}

/**
 * 瓦片四角方向向量，顺序为 C 参考实现的 (dx,dy) = (0,0) → (1,0) → (1,1) → (0,1)。
 *
 * 注意：在赤道带，healpix.c 的 (dx,dy) 局部坐标是**绕面心旋转 45°** 的
 * （见 xyztohp 中 u1/u2 的定义），所以一个 order 层的瓦片在经纬度上呈菱形，
 * 而不是正南北向的矩形。四角顺序与 astropy-healpix boundaries_lonlat 的
 * 点集完全一致（见测试）。
 */
export function tileCornerVecs(order, npix) {
  const nside = orderToNside(order);
  return [
    tilePointVec(npix, nside, 0, 0),
    tilePointVec(npix, nside, 1, 0),
    tilePointVec(npix, nside, 1, 1),
    tilePointVec(npix, nside, 0, 1),
  ];
}

/** 瓦片四角经纬度（度），顺序同上。 */
export function tileCorners(order, npix) {
  return tileCornerVecs(order, npix).map(vecToLonLat);
}

/**
 * 瓦片内 (s, t) ∈ [0,1]²（s 向东、t 向北）→ 单位方向向量。
 * 用于把瓦片边界与可视区边界求交后得到精确顶点。
 */
export function tileSampleVec(order, npix, s, t) {
  return tilePointVec(npix, orderToNside(order), s, t);
}

/**
 * 瓦片角点在图像中的 UV（图像左上角为 (0,0)，与 HiPS PNG 一致）。
 *
 * 与 tileCornerVecs 一一对应。tileCornerVecs 的顺序是
 * (dx,dy) = (0,0) → (1,0) → (1,1) → (0,1)，
 * 而像素对应关系是 **dx = row/N、dy = col/N**（转置，见 buildTileGrid 的说明），
 * 所以四个角在图像里的 (col,row) 依次是：
 *   (dx,dy)=(0,0) → (col,row)=(0,0)   → uv (0,0)
 *   (dx,dy)=(1,0) → (col,row)=(0,1)   → uv (0,1)
 *   (dx,dy)=(1,1) → (col,row)=(1,1)   → uv (1,1)
 *   (dx,dy)=(0,1) → (col,row)=(1,0)   → uv (1,0)
 *
 * 该方向由实测确认：按此 UV 贴图后，order6 瓦片与本地 8K 底图逐像素相关
 * r = +0.68~+0.80；按旧（转置）约定只有 +0.086。
 */
export const TILE_CORNER_UV = [[0, 0], [0, 1], [1, 1], [1, 0]];

/* ------------------------------------------------------------------ *
 * 坐标系：HEALPix 天文坐标系 ↔ three.js 渲染坐标系
 * ------------------------------------------------------------------ */

/**
 * 天文/HEALPix 坐标系（**z = 自转轴**，右手系，lon 自 +x 起向 +y 增大）
 *   → 渲染坐标系（**y = 自转轴**，即 THREE.SphereGeometry 的等距圆柱贴图）。
 *
 * ## 为什么必须有这个转换
 *
 * 本模块（以及 lod.js）里的方向向量全部是天文坐标系：pix2vec()/tilePointVec()
 * 返回 `(rad·cosφ, rad·sinφ, z)`，北极在 **+z**。
 *
 * 而底图球用的是 THREE.SphereGeometry，它的顶点公式是
 *   `x = −r·cos(phi)  y = r·cos(theta)  z = r·sin(phi)`，北极在 **+y**；
 * 贴图 u 从 lon = −180° 开始（因此 lon=0 在 +x、lon=+90° 在 −z）。
 * 即底图把经纬度铺在
 *   D_base(λ,φ) = (cosφ·cosλ, sinφ, −cosφ·sinλ)
 * 方向上。
 *
 * 两者相差一个**绕 x 轴 −90° 的旋转**：D_hp = R_x(+90°)·D_base。
 *
 * 之前 buildTileGrid() 把 tilePointVec() 的输出直接当成渲染坐标塞进
 * position 属性，于是整层瓦片相对底图转了 90°——这正是"8K 底图和放大后的
 * 区域对不上"的根因：视野中心叠着的瓦片和底下底图根本不是同一块地形。
 *
 * ## 实测（1306×598 视口、DPR 2、d=5.25 整球视角）
 *
 * 把 8K 底图按两种坐标系各自重投影到屏幕，再与 WebGL 实际输出做高通相关：
 *   按渲染坐标系 (y = 极轴) 采样 → **r = +0.61**
 *   按天文坐标系 (z = 极轴) 采样 → r = −0.03
 * 即底图确实铺在 y = 极轴那一套上（另外用 Kepler 撞击坑的位置独立核对过：
 * 资源图在 lon −38.4°、lat +6.6° 处正是 Kepler，与其真实坐标 −38.0/+8.1 相符）。
 */
export function hpToRender(v, out = [0, 0, 0]) {
  out[0] = v[0]; out[1] = v[2]; out[2] = -v[1];
  return out;
}

/** hpToRender() 的逆：渲染坐标系 → 天文坐标系。 */
export function renderToHp(v, out = [0, 0, 0]) {
  out[0] = v[0]; out[1] = -v[2]; out[2] = v[1];
  return out;
}

/**
 * 渲染坐标系下的单位方向 → 底图（等距圆柱）UV，与 SphereGeometry 的 uv 属性一致。
 *
 * 由 SphereGeometry 的顶点公式反解：
 *   phi   = atan2(z, −x)        u = phi / 2π      （u=0 ↔ lon −180°）
 *   theta = acos(y)             v = 1 − theta/π   （v=1 ↔ 北极，纹理 flipY=true）
 *
 * 用来给瓦片几何补一路 uv1，使其能按"底图那套经纬度"采样 LOLA 法线贴图，
 * 从而和底图有同样的起伏光照（否则高清区是纯漫反射，看起来是平的）。
 *
 * 注意 u 在经度 ±180° 处不连续；跨日界线的瓦片会有一条极窄的接缝，
 * 影响仅限于该瓦片内 1 个像素宽的切线帧，可忽略。
 */
export function renderUv(v, out = [0, 0]) {
  const phi = Math.atan2(v[2], -v[0]);
  let u = phi / TWO_PI;
  if (u < 0) u += 1;
  const y = v[1] < -1 ? -1 : (v[1] > 1 ? 1 : v[1]);
  out[0] = u;
  out[1] = 1 - Math.acos(y) / PI;
  return out;
}
