/**
 * LOD / 视野选择的测试。
 *
 * 这里用**假相机**（解析投影）而不是 WebGL：selectTiles 的输入只有
 * camLocal + project + 画布尺寸，因此完全可以在 Node 下复现。
 *
 * 重点覆盖一个曾经真实出现的 bug：
 * 近距离时可视球冠很小（d=1.05 时角半径仅 1.86°），而 order 0 瓦片跨 58°，
 * 球冠整个落在某张父瓦片内部。旧实现只检查瓦片中心与四个角是否在球冠内，
 * 于是 12 张 order 0 瓦片全被判为不可见，四叉树一步都下降不了，
 * 结果一张瓦片都选不出来（实测 d≤1.10 → tiles=0，而 d=1.22 还有 45 张）。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  visibleCapBySampling, selectTiles, tileVisible, tileAngularRadius,
  pointVisible, DEFAULT_LOD,
} from '../public/src/hips/lod.js';
import { tilePointVec, orderToNside } from '../public/src/hips/healpix.js';

const FOV = 30;
const ASPECT = 2612 / 1196;
const W = 2612, H = 1196;

/**
 * 假相机：位于给定月球局部经纬度方向、距球心 d，视轴指向球心（与真实页面一致）。
 *
 * 注意 sub-point（相机正下方点）的位置很关键：
 * 如果相机放在 +Z 轴上，sub-point 正好落在 4 张 order 0 瓦片共用的极点上，
 * 那些瓦片的**角点**恰好在可视区内，旧的"只查中心与四角"实现会侥幸通过。
 * 真实视角不会这么巧（第谷在 lat −43°），所以这里用与页面一致的经纬度。
 */
function makeCamera(d, lon = -11.36, lat = -43.31) {
  const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180;
  // 与 healpix.js 的 lonLatToVec 一致：x=cos(lat)cos(lon), y=cos(lat)sin(lon), z=sin(lat)
  const p = [
    Math.cos(b) * Math.cos(a) * d,
    Math.cos(b) * Math.sin(a) * d,
    Math.sin(b) * d,
  ];
  const len = Math.hypot(...p);
  const fwd = p.map((v) => -v / len);              // 看向球心
  const worldUp = [0, 0, 1];
  let right = [
    fwd[1] * worldUp[2] - fwd[2] * worldUp[1],
    fwd[2] * worldUp[0] - fwd[0] * worldUp[2],
    fwd[0] * worldUp[1] - fwd[1] * worldUp[0],
  ];
  let rl = Math.hypot(...right);
  if (rl < 1e-6) { right = [1, 0, 0]; rl = 1; }
  right = right.map((v) => v / rl);
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];

  const th = Math.tan((FOV * Math.PI) / 360);
  return {
    pos: p, fwd, right, up,
    unproject(nx, ny) {
      const v = [
        fwd[0] + right[0] * nx * th * ASPECT + up[0] * ny * th,
        fwd[1] + right[1] * nx * th * ASPECT + up[1] * ny * th,
        fwd[2] + right[2] * nx * th * ASPECT + up[2] * ny * th,
      ];
      const l = Math.hypot(...v);
      return v.map((x) => x / l);
    },
    project(v) {
      const rel = [v[0] - p[0], v[1] - p[1], v[2] - p[2]];
      const zc = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
      if (zc <= 1e-6) return null;
      const xc = rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2];
      const yc = rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2];
      return [(xc / (zc * th * ASPECT) * 0.5 + 0.5) * W, (-yc / (zc * th) * 0.5 + 0.5) * H];
    },
  };
}

function selectAt(d, opts = {}) {
  const cam = makeCamera(d, opts.lon, opts.lat);
  const cap = visibleCapBySampling(cam.pos, cam.unproject);
  const sel = selectTiles({
    camLocal: cam.pos, project: cam.project, screenW: W, screenH: H,
    orderMax: 9, cap,
  });
  return { cam, cap, sel };
}

const DISTS = [5.25, 2.0, 1.35, 1.22, 1.10, 1.05, 1.02];

test('任何允许的距离都必须选出瓦片（近距离不能为空）', () => {
  for (const d of DISTS) {
    const { sel, cap } = selectAt(d);
    assert.ok(sel.tiles.length > 0,
      `d=${d}（可视球冠 ${cap.radiusDeg.toFixed(2)}°）选不出任何瓦片`);
  }
});

test('越靠近月面层级越高，且层级单调不降', () => {
  let prev = -1;
  const rows = [];
  for (const d of DISTS) {
    const { sel } = selectAt(d);
    rows.push({ d, maxOrder: sel.maxOrder, n: sel.tiles.length });
    assert.ok(sel.maxOrder >= prev, `d=${d} 的层级 ${sel.maxOrder} 低于更远距离的 ${prev}`);
    prev = sel.maxOrder;
  }
  // 最近处应达到较高层级（7 m 数据在近距离才真正发挥作用）
  const near = rows.find((r) => r.d === 1.02);
  assert.ok(near.maxOrder >= 5, `d=1.02 只到 order ${near.maxOrder}，层级过低`);
  // 最远处应停在低层级
  const far = rows.find((r) => r.d === 5.25);
  assert.ok(far.maxOrder <= 2, `d=5.25 到了 order ${far.maxOrder}，层级过高（会拉大量瓦片）`);
});

test('瓦片角半径随层级减半（几何自洽）', () => {
  for (let o = 0; o <= 8; o++) {
    const r1 = tileAngularRadius(o, 0);
    const r2 = tileAngularRadius(o + 1, 0);
    // 子瓦片是父瓦片的 1/4 区域，角半径应约减半
    assert.ok(Math.abs(r1 / r2 - 2) < 0.25,
      `order ${o}→${o + 1} 角半径比 ${(r1 / r2).toFixed(3)} 偏离 2 过多`);
  }
});

test('tileVisible 把瓦片自身跨度算进去：小球冠落在父瓦片内部时仍可见', () => {
  // d=1.05 → 球冠角半径约 1.86°
  const d = 1.05;
  const camLocal = [0, 0, d];
  const capR = Math.acos(1 / d);                  // 几何地平线角半径 ≈ 17.75°
  const smallCap = 1.86 * Math.PI / 180;          // 实测的可视球冠

  // 找一张中心明显在球冠外、但跨度覆盖球冠的 order 0 瓦片
  let found = false;
  for (let p = 0; p < 12; p++) {
    const c = tilePointVec(p, 1, 0.5, 0.5);
    const angFromCam = Math.acos(Math.max(-1, Math.min(1, c[2] / Math.hypot(...c) )));
    void angFromCam;
    const r = tileAngularRadius(0, p);
    // 球冠中心（相机正下方点 = +Z）与该瓦片中心方向的夹角
    const centerDir = [0, 0, 1];
    const ang = Math.acos(Math.max(-1, Math.min(1, c[0] * centerDir[0] + c[1] * centerDir[1] + c[2] * centerDir[2])));
    if (ang > smallCap && ang < smallCap + r && ang < capR + r) {
      const vis = tileVisible(0, p, camLocal, Math.cos(smallCap), smallCap);
      assert.ok(vis, `order0 npix${p}（中心距球冠中心 ${(ang * 180 / Math.PI).toFixed(1)}°，瓦片角半径 ${(r * 180 / Math.PI).toFixed(1)}°）应判为可见`);
      found = true;
    }
  }
  assert.ok(found, '没有构造出"小球冠落在父瓦片内部"的用例，测试失去意义');
});

test('远距离：地平线之外的瓦片必须被排除（不能选到背面）', () => {
  const d = 2.0;
  const { sel, cam } = selectAt(d);
  const sub = cam.pos.map((v) => v / d);              // sub-point（相机正下方点）
  const horizon = Math.acos(1 / d) * 180 / Math.PI;   // ≈60°
  for (const t of sel.tiles) {
    const c = tilePointVec(t.npix, orderToNside(t.order), 0.5, 0.5);
    const ang = Math.acos(Math.max(-1, Math.min(1, c[0] * sub[0] + c[1] * sub[1] + c[2] * sub[2]))) * 180 / Math.PI;
    const r = tileAngularRadius(t.order, t.npix) * 180 / Math.PI;
    assert.ok(ang <= horizon + r + 1e-6,
      `${t.order}/${t.npix} 中心距 sub-point ${ang.toFixed(1)}°，超过地平线 ${horizon.toFixed(1)}°+瓦片半径 ${r.toFixed(1)}°`);
  }
});

/*
 * 回归：sub-point 落在极点（4 张 order 0 瓦片共用的角点）时，
 * 旧的"只查中心与四角"实现会侥幸让 order 0 通过；换成普通经纬度就全军覆没。
 * 这条用例专门盯住"父瓦片可见但四角都不在球冠内"的情形。
 */
test('sub-point 不在瓦片角点上时，近距离仍必须选出瓦片', () => {
  const cases = [
    { lon: -11.36, lat: -43.31, name: '第谷（真实默认视角）' },
    { lon: 0, lat: 0, name: '赤道' },
    { lon: 60, lat: 20, name: '危海一带' },
    { lon: -30, lat: 70, name: '高纬' },
  ];
  for (const c of cases) {
    for (const d of [1.02, 1.05, 1.10]) {
      const { sel, cap } = selectAt(d, { lon: c.lon, lat: c.lat });
      assert.ok(sel.tiles.length > 0,
        `${c.name} d=${d}（可视球冠 ${cap.radiusDeg.toFixed(2)}°）选不出瓦片`);
      assert.ok(sel.maxOrder >= 4,
        `${c.name} d=${d} 只到 order ${sel.maxOrder}，近距离层级过低`);
    }
  }
});

test('极点视角（sub-point 落在瓦片角点）也要正常选出瓦片', () => {
  for (const [lon, lat] of [[0, 90], [0, -90]]) {
    for (const d of [1.05, 1.35]) {
      const { sel } = selectAt(d, { lon, lat });
      assert.ok(sel.tiles.length > 0, `极点视角 lon${lon} lat${lat} d=${d} 选不出瓦片`);
    }
  }
});

test('选出的瓦片数量受 maxTiles 限制，且优先级按离屏幕中心排序', () => {
  const { sel } = selectAt(1.22);
  assert.ok(sel.tiles.length <= DEFAULT_LOD.maxTiles, `超出 maxTiles：${sel.tiles.length}`);
  for (let i = 1; i < sel.tiles.length; i++) {
    assert.ok(sel.tiles[i].priority >= sel.tiles[i - 1].priority - 1e-9, '优先级未按升序排列');
  }
});

test('无 cap 时退化为"相机正下方点为中心、全月可见"，不应崩也不应为空', () => {
  const d = 1.35;
  const cam = makeCamera(d);
  const sel = selectTiles({
    camLocal: cam.pos, project: cam.project, screenW: W, screenH: H, orderMax: 9,
    // 故意不传 cap
  });
  assert.ok(sel.tiles.length > 0, '不传 cap 时选不出瓦片');
  assert.equal(sel.capRadiusDeg, null);
});

test('pointVisible：地平线判定正确', () => {
  const d = 1.5;
  const camLocal = [0, 0, d];
  const horizon = 1 / d;
  // 正下方点（+Z）可见
  assert.ok(pointVisible([0, 0, 1], camLocal, null));
  // 正好在地平线上
  const hx = Math.sqrt(1 - horizon * horizon);
  assert.ok(pointVisible([hx, 0, horizon], camLocal, null), '地平线上的点应可见');
  // 明显在背面
  assert.ok(!pointVisible([0, 0, -1], camLocal, null), '背面的点不应可见');
});
