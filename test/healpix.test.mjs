/**
 * HEALPix NESTED 数学测试。
 *
 * 关键点：参考向量来自 **独立实现** astropy-healpix 2.0.1（BSD-3-Clause），
 * 由 tools/gen-healpix-reference.py 生成，不是本模块正反函数的自洽检查。
 *
 * 运行：npm test   （或 node --test test/）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  orderToNside, npixOfOrder, nsideToOrder, tilePath,
  lonLatToVec, vecToLonLat, pix2vec, pix2lonlat, vec2pix,
  tileCornerVecs, tileCorners, tileSampleVec, TILE_CORNER_UV, nestedToFaceXY, faceXYToNested,
} from '../public/src/hips/healpix.js';

const REF = JSON.parse(readFileSync(
  fileURLToPath(new URL('./reference/healpix-ref.json', import.meta.url)), 'utf8'));

const norm180 = (d) => ((d % 360) + 540) % 360 - 180;
/** 经度差的绝对值（跨 ±180 正确）。 */
const dLon = (a, b) => Math.abs(norm180(a - b));
const angBetween = (u, v) => {
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
};

test('order/nside 换算与瓦片总数', () => {
  for (let o = 0; o <= 9; o++) {
    const n = orderToNside(o);
    assert.equal(n, 2 ** o);
    assert.equal(nsideToOrder(n), o);
    assert.equal(npixOfOrder(o), 12 * 4 ** o);
    assert.equal(npixOfOrder(o), 12 * n * n);
  }
  assert.throws(() => nsideToOrder(3), /power of two/);
});

test('HiPS 路径规则 Norder/Dir/Npix', () => {
  assert.equal(tilePath(0, 0), 'Norder0/Dir0/Npix0.png');
  assert.equal(tilePath(9, 0), 'Norder9/Dir0/Npix0.png');
  assert.equal(tilePath(9, 9999), 'Norder9/Dir0/Npix9999.png');
  assert.equal(tilePath(9, 10000), 'Norder9/Dir10000/Npix10000.png');
  assert.equal(tilePath(9, 10001), 'Norder9/Dir10000/Npix10001.png');
  assert.equal(tilePath(9, 99999), 'Norder9/Dir90000/Npix99999.png');
  assert.equal(tilePath(9, 3145727), 'Norder9/Dir3140000/Npix3145727.png');
  assert.equal(tilePath(5, 1234, 'fits'), 'Norder5/Dir0/Npix1234.fits');
  // 层级边界
  assert.throws(() => tilePath(9, 3145728), RangeError);
  assert.throws(() => tilePath(9, -1), RangeError);
  assert.throws(() => tilePath(5, 12288), RangeError);
  assert.equal(tilePath(5, 12287), 'Norder5/Dir10000/Npix12287.png');
});

test('pix2lonlat 与 astropy-healpix 参考向量一致', () => {
  let worst = 0;
  for (const v of REF.vectors) {
    const { lon, lat } = pix2lonlat(v.nside, v.npix);
    const e = Math.max(dLon(lon, v.lon), Math.abs(lat - v.lat));
    worst = Math.max(worst, e);
    assert.ok(e < 1e-9, `order${v.order} npix${v.npix}: got ${lon},${lat} want ${v.lon},${v.lat}`);
    assert.equal(tilePath(v.order, v.npix), v.path);
  }
  assert.ok(worst < 1e-9, 'worst=' + worst);
});

test('vec2pix 与 astropy-healpix 参考向量一致（经纬度→瓦片编号）', () => {
  for (const v of REF.vectors) {
    // 用参考像素中心的经纬度反查，必须回到同一编号
    const px = vec2pix(v.nside, ...lonLatToVec(v.lon, v.lat));
    assert.equal(px, v.npix, `order${v.order} lon${v.lon} lat${v.lat}`);
  }
});

test('vec2pix / pix2vec 在整个球面互为逆运算', () => {
  for (const order of [0, 1, 2, 4, 6, 9]) {
    const nside = orderToNside(order);
    const n = npixOfOrder(order);
    const step = Math.max(1, Math.floor(n / 2000));
    for (let p = 0; p < n; p += step) {
      const c = pix2vec(nside, p);
      assert.equal(vec2pix(nside, c[0], c[1], c[2]), p, `order${order} npix${p}`);
    }
  }
});

test('随机方向：vec2pix 结果与 pix2vec 中心夹角小于半瓦片', () => {
  for (const order of [1, 3, 5, 9]) {
    const nside = orderToNside(order);
    const tol = 1.05 * (180 / Math.PI) * Math.sqrt(Math.PI / 3) / nside; // 半瓦片角度上限
    for (let k = 0; k < 400; k++) {
      const lon = Math.random() * 360 - 180;
      const lat = Math.asin(Math.random() * 2 - 1) * 180 / Math.PI;
      const v = lonLatToVec(lon, lat);
      const px = vec2pix(nside, v[0], v[1], v[2]);
      const c = pix2vec(nside, px);
      assert.ok(angBetween(v, c) <= tol, `order${order} ${lon},${lat} -> ${px}`);
    }
  }
});

test('地标经纬度 → 瓦片编号与参考一致（含另一半球/极点/±180 接缝）', () => {
  for (const [name, byOrder] of Object.entries(REF.landmarks)) {
    for (const [order, r] of Object.entries(byOrder)) {
      const nside = orderToNside(Number(order));
      const px = vec2pix(nside, ...lonLatToVec(r.lon, r.lat));
      assert.equal(px, r.npix, `${name} order${order}`);
    }
  }
  // 显式复核两个地标（避免参考文件被改坏而测试仍通过）
  const tycho = REF.landmarks.Tycho['9'];
  assert.equal(tycho.npix, 2969516);
  assert.ok(dLon(tycho.center_lon, -11.36) < 0.25);
  assert.ok(Math.abs(tycho.center_lat - -43.31) < 0.25);
});

test('瓦片四角与 astropy-healpix boundaries_lonlat 一致', () => {
  for (const c of REF.corners) {
    const mine = tileCornerVecs(c.order, c.npix);
    const ref = c.corners_lon.map((lon, i) => lonLatToVec(lon, c.corners_lat[i]));
    // astropy 的角点顺序是逆时针且起点不同，这里比较点集：每个我方角点都应匹配某个参考角点
    for (const m of mine) {
      const best = Math.min(...ref.map((r) => angBetween(m, r)));
      assert.ok(best < 1e-5, `order${c.order} npix${c.npix} 角点偏差 ${best}°`);
    }
    // 参考角点数 = 我方角点数 = 4，且一一对应
    assert.equal(new Set(mine.map((v) => v.map((x) => x.toFixed(9)).join(','))).size, 4);
  }
});

test('瓦片四角包住像素中心，且四角顺序为逆时针（朝外看）', () => {
  for (const order of [0, 1, 2, 4, 6, 9]) {
    const nside = orderToNside(order);
    const n = npixOfOrder(order);
    const step = Math.max(1, Math.floor(n / 500));
    for (let p = 0; p < n; p += step) {
      const c = pix2vec(nside, p);
      const q = tileCornerVecs(order, p);
      for (const corner of q) assert.ok(angBetween(c, corner) < 90, `order${order} npix${p}`);
      // 逆时针（从球外看）：相邻边叉积与中心同向
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4];
        const cr = [
          a[1] * b[2] - a[2] * b[1],
          a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0],
        ];
        const dot = cr[0] * c[0] + cr[1] * c[1] + cr[2] * c[2];
        assert.ok(dot > 0, `order${order} npix${p} 角点 ${k} 绕向错误 (dot=${dot})`);
      }
      // 四角经度跨度：跨 ±180 接缝的瓦片不能直接用 max−min，改为取最小弧长
      const lons = q.map((v) => vecToLonLat(v).lon).sort((a, b) => a - b);
      let span = 360;
      for (let i = 0; i < 4; i++) {
        const gap = (lons[(i + 1) % 4] - lons[i] + 360) % 360;
        span = Math.min(span, 360 - gap);
      }
      assert.ok(span <= 180.001, `order${order} npix${p} 经度跨度 ${span} 过大（可能跨接缝）`);
    }
  }
});

test('瓦片内 (s,t) 采样：边界处与角点重合，中心与 pix2vec 一致', () => {
  for (const order of [1, 4, 9]) {
    const nside = orderToNside(order);
    for (const p of [0, 1, npixOfOrder(order) - 1, Math.floor(npixOfOrder(order) / 3)]) {
      const c = pix2vec(nside, p);
      const mid = tileSampleVec(order, p, 0.5, 0.5);
      assert.ok(angBetween(c, mid) < 1e-4, `order${order} npix${p} 中心不一致`);
      const corners = tileCornerVecs(order, p);
      assert.ok(angBetween(tileSampleVec(order, p, 0, 0), corners[0]) < 1e-5);
      assert.ok(angBetween(tileSampleVec(order, p, 1, 1), corners[2]) < 1e-5);
      assert.ok(angBetween(tileSampleVec(order, p, 1, 0), corners[1]) < 1e-5);
      assert.ok(angBetween(tileSampleVec(order, p, 0, 1), corners[3]) < 1e-5);
    }
  }
});


test('父子层对应关系：父块 (face,x,y) 的 4 个子块 = NESTED 编号 4p..4p+3', () => {
  // 这是 HiPS 层级结构的核心不变量（子块 = 父块的 2×2 细分），
  // 也是"父层回退"能正确工作、LOD 切换不会错位的前提。
  for (const order of [0, 1, 3, 7]) {
    const nside = orderToNside(order);
    const n = npixOfOrder(order);
    const step = Math.max(1, Math.floor(n / 60));
    for (let p = 0; p < n; p += step) {
      const par = nestedToFaceXY(p, nside);
      const kids = [0, 1, 2, 3].map((k) => nestedToFaceXY(p * 4 + k, nside * 2));
      // 4 个子块同属一个 face
      for (const k of kids) assert.equal(k.face, par.face, `order${order} p${p} face`);
      // 子块 (x,y) 必须落在父块 2×2 细分的四个格子里
      const seen = new Set(kids.map((k) => (k.x >> 1) + ',' + (k.y >> 1)));
      assert.equal(seen.size, 1, `order${order} p${p} 子块不在同一父格`);
      assert.ok(seen.has(par.x + ',' + par.y), `order${order} p${p} 子块父格不匹配`);
      const quads = new Set(kids.map((k) => (k.x & 1) + ',' + (k.y & 1)));
      assert.equal(quads.size, 4, `order${order} p${p} 子块象限重复`);
      // 子块中心必须落在父块球面四边形内（用父块自身的四角做同侧判定）
      const parent = tileCornerVecs(order, p);
      for (let k = 0; k < 4; k++) {
        const cc = pix2vec(nside * 2, p * 4 + k);
        assert.ok(inSphericalQuad(cc, parent),
          `order${order} parent${p} child${p * 4 + k} 中心不在父块内`);
      }
    }
  }
});

/** 点 v 是否在（逆时针）球面四边形 q 内：对每条边同侧。 */
function inSphericalQuad(v, q, tol = 0) {
  for (let e = 0; e < 4; e++) {
    const a = q[e], b = q[(e + 1) % 4];
    const nrm = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const d = nrm[0] * v[0] + nrm[1] * v[1] + nrm[2] * v[2];
    if (d < -tol) return false;
  }
  return true;
}

test('球面面积：每层全部瓦片面积之和 = 4π（球面多边形内角和法）', () => {
  for (const order of [0, 1, 2]) {
    const n = npixOfOrder(order);
    let total = 0;
    for (let p = 0; p < n; p++) total += quadSolidAngle(tileCornerVecs(order, p));
    assert.ok(Math.abs(total - 4 * Math.PI) < 1e-9,
      `order${order} 面积和 ${total} ≠ 4π`);
  }
});

/** 球面四边形立体角（内角和 − 2π），单位球、逆时针绕向。 */
function quadSolidAngle(q) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 1) % 4], b = q[(i + 3) % 4];
    const u = norm(sub(a, [dot(a, p) * p[0], dot(a, p) * p[1], dot(a, p) * p[2]]));
    const w = norm(sub(b, [dot(b, p) * p[0], dot(b, p) * p[1], dot(b, p) * p[2]]));
    sum += Math.acos(Math.max(-1, Math.min(1, dot(u, w))));
  }
  return sum - 2 * Math.PI;
}

test('图像 UV 约定：与 tileCornerVecs 一一对应，覆盖单位方格', () => {
  // 角点顺序为局部 (dx,dy) = (0,0) (1,0) (1,1) (0,1)
  const DX_DY = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.deepEqual(TILE_CORNER_UV, [[0, 0], [0, 1], [1, 1], [1, 0]]);
  assert.equal(TILE_CORNER_UV.length, 4);
  const seen = new Set(TILE_CORNER_UV.map(([u, v]) => u + ',' + v));
  assert.equal(seen.size, 4);
  for (const uv of ['0,0', '1,0', '1,1', '0,1']) assert.ok(seen.has(uv), uv);
  /**
   * 图像 (col,row) 与局部 (dx,dy) 是**转置**关系：
   *   col = dy，row = dx
   * 所以 u = dy，v = row = dx。
   * 这条约定由实测确定（与 8K 底图逐像素相关：转置 r≈0.68~0.80，非转置 r≈0.086），
   * 见 public/src/hips/tiles.js 里 buildTileGrid 的说明。
   */
  for (let i = 0; i < 4; i++) {
    assert.equal(TILE_CORNER_UV[i][0], DX_DY[i][1], `角点 ${i} 的 u 应等于 dy`);
    assert.equal(TILE_CORNER_UV[i][1], DX_DY[i][0], `角点 ${i} 的 v 应等于 dx`);
  }
});

test('nestedToFaceXY / faceXYToNested 与编号自洽', () => {
  for (const order of [0, 1, 2, 5, 9]) {
    const nside = orderToNside(order);
    const n = npixOfOrder(order);
    const step = Math.max(1, Math.floor(n / 300));
    for (let p = 0; p < n; p += step) {
      const { face, x, y } = nestedToFaceXY(p, nside);
      assert.ok(face >= 0 && face < 12, `face ${face}`);
      assert.ok(x >= 0 && x < nside && y >= 0 && y < nside, `xy ${x},${y}`);
      assert.equal(faceXYToNested(face, x, y, nside), p, `order${order} npix${p}`);
    }
  }
});

test('经纬度与方向向量互转', () => {
  for (const [lon, lat] of [[0, 0], [90, 0], [-90, 0], [180, 0], [-180, 0], [0, 90], [0, -90], [12.5, -33.25]]) {
    const v = lonLatToVec(lon, lat);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
    const r = vecToLonLat(v);
    assert.ok(dLon(r.lon, lon) < 1e-9 || Math.abs(lat) === 90);
    assert.ok(Math.abs(r.lat - lat) < 1e-9);
  }
});
