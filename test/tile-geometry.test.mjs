/**
 * 瓦片几何测试：绕向 / 法线朝向 / UV / 覆盖范围。
 *
 * 为什么单独有这个文件：
 * buildTileGrid 的三角形绕向曾经被"凭直觉"改错过两次，症状都是**瓦片整块消失或全黑**
 * （gl_FrontFacing 为假被 discard；或 computeVertexNormals 算出朝内法线导致光照≈0）。
 * 球面瓦片的四角在经纬度上是菱形（healpix.c 的面内 (dx,dy) 绕面心转了 45°），
 * 所以"从外侧看逆时针"这种推理不可靠，必须用几何量实测。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildTileGeometry, slotOrigin, slotUvOf, AtlasSlots } from '../public/src/hips/tiles.js';
import {
  pix2vec, orderToNside, hpToRender, renderToHp, renderUv, tileCenterLonLat, tilePointVec,
} from '../public/src/hips/healpix.js';
import { tileAngularRadius } from '../public/src/hips/lod.js';

/**
 * 走**生产路径** buildTileGeometry（TileLayer.sync 用的就是它），
 * 而不是在测试里自己拼几何——否则 sync() 漏掉 computeVertexNormals()
 * 这类 bug 测试根本看不见。
 */
function geometryOf(order, npix, sub, uv = { u0: 0.1, v0: 0.2, scale: 0.05 }) {
  const { geometry: g, opacities } = buildTileGeometry(order, npix, sub, uv);
  return { g, opacities };
}

// 覆盖极冠、赤道、各阶，以及实际会用到的 sub 值
const CASES = [
  [0, 0, 4], [2, 7, 4], [3, 40, 4], [4, 120, 5],
  [5, 1000, 6], [5, 5000, 4], [6, 20000, 8], [8, 150000, 10], [9, 300000, 4],
];

test('几何在渲染前已就绪：normal 属性存在且顶点法线朝外', () => {
  for (const [order, npix, sub] of CASES) {
    const { g } = geometryOf(order, npix, sub);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    // MeshStandardMaterial 没有 normal 就点不亮（实测瓦片 mean 3.33 的根因）
    assert.ok(n, `order ${order} npix ${npix}：几何缺少 normal 属性，MeshStandardMaterial 会渲染成近黑`);
    assert.equal(n.count, p.count, 'normal 与 position 顶点数不一致');
    let worst = Infinity;
    for (let i = 0; i < n.count; i++) {
      const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      const len = Math.hypot(px, py, pz);
      // 顶点在单位球面上，法线应与归一化位置向量同向（点积→1）
      const d = (n.getX(i) * px + n.getY(i) * py + n.getZ(i) * pz) / len;
      worst = Math.min(worst, d);
    }
    assert.ok(worst > 0.9,
      `order ${order} npix ${npix} sub ${sub}：最差法线·中心 = ${worst.toFixed(6)}，说明绕向反了（法线朝内）`);
  }
});

test('三角形绕向在球心看来一致朝外（叉积 · 面心 > 0）', () => {
  for (const [order, npix, sub] of CASES) {
    const { g } = geometryOf(order, npix, sub);
    const idx = g.getIndex();
    const p = g.getAttribute('position');
    // 几何在渲染坐标系里，瓦片中心向量也要跟着转过去才能比
    const center = hpToRender(pix2vec(orderToNside(order), npix));
    const V = (i) => new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    for (let t = 0; t < idx.count; t += 3) {
      const a = V(idx.getX(t)), b = V(idx.getX(t + 1)), c = V(idx.getX(t + 2));
      const nrm = b.clone().sub(a).cross(c.clone().sub(a));
      const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      assert.ok(nrm.dot(cen) > 0,
        `order ${order} npix ${npix} 三角形 ${t / 3}：叉积朝内`);
      // 面心方向与瓦片中心方向的夹角应远小于瓦片本身尺度（这里只做粗检）
      assert.ok(cen.normalize().dot(new THREE.Vector3(...center)) > 0.5,
        `order ${order} npix ${npix} 三角形 ${t / 3}：面心离瓦片中心过远`);
    }
  }
});

/*
 * 坐标系钉死：几何必须落在**渲染坐标系**（y = 自转轴）里，与 8K 底图球一致。
 *
 * 回归背景：buildTileGrid 曾把 tilePointVec() 的天文坐标系输出（z = 极轴）
 * 直接当渲染坐标用，整层瓦片相对底图转了 90°——视野中心叠着的瓦片和底下
 * 底图不是同一块地形，也就是"8K 底图和放大后的区域对不上"。
 * 这里直接用"瓦片几何中心 == D_base(lon, lat)"把它钉住。
 */
test('瓦片几何在渲染坐标系里（y = 自转轴），与底图球一致', () => {
  const D_base = (lon, lat) => {
    const c = Math.cos((lat * Math.PI) / 180), lo = (lon * Math.PI) / 180;
    return [c * Math.cos(lo), Math.sin((lat * Math.PI) / 180), -c * Math.sin(lo)];
  };
  const D_hp = (lon, lat) => {
    const c = Math.cos((lat * Math.PI) / 180), lo = (lon * Math.PI) / 180;
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin((lat * Math.PI) / 180)];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  let discriminated = 0;
  for (const [order, npix, sub] of CASES) {
    const { g } = geometryOf(order, npix, sub);
    const p = g.getAttribute('position');
    const { lon, lat } = tileCenterLonLat(order, npix);
    const cb = D_base(lon, lat), ch = D_hp(lon, lat);

    // 每个顶点都必须在"按底图经纬度算出的瓦片角尺度"之内
    let worstBase = 1, worstHp = 1;
    for (let i = 0; i < p.count; i++) {
      const v = [p.getX(i), p.getY(i), p.getZ(i)];
      const n = Math.hypot(v[0], v[1], v[2]);
      const u = [v[0] / n, v[1] / n, v[2] / n];
      worstBase = Math.min(worstBase, dot(u, cb));
      worstHp = Math.min(worstHp, dot(u, ch));
    }
    const angBase = Math.acos(Math.max(-1, Math.min(1, worstBase)));
    const R = tileAngularRadius(order, npix);
    assert.ok(angBase <= R + 1e-6,
      `order ${order} npix ${npix}：有顶点偏离底图经纬度 ${lon.toFixed(2)}/${lat.toFixed(2)} `
      + `${((angBase * 180) / Math.PI).toFixed(2)}°，超过瓦片自身角半径 ${((R * 180) / Math.PI).toFixed(2)}°`);

    // 两种坐标系的判别力：z=极轴那一套必须明显更差（落在 ±x 轴附近的瓦片两者重合，跳过）
    if (dot(cb, ch) < 0.9) {
      discriminated++;
      assert.ok(worstHp < worstBase - 0.05,
        `order ${order} npix ${npix}：按天文坐标系 (z=极轴) 算反而更贴合，说明坐标系转换方向反了`);
    }
  }
  assert.ok(discriminated >= 4,
    `只有 ${discriminated} 个用例能区分两种坐标系，判别力不足`);
});

test('hpToRender / renderToHp 互逆，且与 SphereGeometry 的铺法一致', () => {
  const v = [0.3, -0.5, 0.81];
  const r = hpToRender(v);
  const back = renderToHp(r);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-12, '往返不闭合');
  const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  // 北天极 (z=+1) → 渲染系的 +y；东经 90°(y=+1) → 渲染系的 −z
  assert.ok(same(hpToRender([0, 0, 1]), [0, 1, 0]), '北天极未落到 +y');
  assert.ok(same(hpToRender([0, 1, 0]), [0, 0, -1]), 'lon=+90 未落到 −z');
  assert.ok(same(hpToRender([1, 0, 0]), [1, 0, 0]), 'lon=0/lat=0 应保持 +x（底图月面中心）');
  // 任意方向转换后模长不变
  for (const t of [[0.3, -0.5, 0.81], [-0.2, 0.9, 0.39]]) {
    assert.ok(Math.abs(Math.hypot(...hpToRender(t)) - Math.hypot(...t)) < 1e-12, '转换改变了模长');
  }
});

test('uv1 是底图那套等距圆柱经纬度（供 LOLA 法线按 uv1 采样）', () => {
  const { g } = geometryOf(4, 120, 3);
  const p = g.getAttribute('position');
  const uv1 = g.getAttribute('uv1');
  assert.ok(uv1, '几何缺少 uv1 属性：法线贴图会退化成按图集 uv 采样，起伏全错');
  assert.equal(uv1.count, p.count, 'uv1 与 position 顶点数不一致');
  // position 存的是 float32，这里的容差要覆盖 float32 舍入（~1e-7）
  let worst = 0;
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)];
    const want = renderUv(v);
    worst = Math.max(worst, Math.abs(uv1.getX(i) - want[0]), Math.abs(uv1.getY(i) - want[1]));
    assert.ok(uv1.getX(i) >= 0 && uv1.getX(i) <= 1, 'uv1.u 越界');
    assert.ok(uv1.getY(i) >= 0 && uv1.getY(i) <= 1, 'uv1.v 越界');
  }
  assert.ok(worst < 1e-5, `uv1 与底图 uv 公式最大偏差 ${worst}`);
  // 与底图球的 uv 公式一致：y 越大（越靠北）v 越大
  const n = p.count;
  let minY = Infinity, maxY = -Infinity, vAtMin = 0, vAtMax = 0;
  for (let i = 0; i < n; i++) {
    if (p.getY(i) < minY) { minY = p.getY(i); vAtMin = uv1.getY(i); }
    if (p.getY(i) > maxY) { maxY = p.getY(i); vAtMax = uv1.getY(i); }
  }
  assert.ok(vAtMax > vAtMin, 'v 未随纬度（+y）增大——与 SphereGeometry 的 uv 约定相反');
});

test('索引不越界、无退化三角形、顶点数与索引数自洽', () => {
  for (const [order, npix, sub] of CASES) {
    const { g } = geometryOf(order, npix, sub);
    const vcount = g.getAttribute('position').count;
    const idx = g.getIndex();
    assert.equal(vcount, (sub + 1) * (sub + 1), '顶点数应为 (sub+1)²');
    assert.equal(idx.count, sub * sub * 6, '索引数应为 sub²·6');
    for (let i = 0; i < idx.count; i++) {
      const v = idx.getX(i);
      assert.ok(Number.isInteger(v) && v >= 0 && v < vcount, `索引 ${v} 越界`);
    }
    for (let t = 0; t < idx.count; t += 3) {
      const s = new Set([idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]);
      assert.equal(s.size, 3, `三角形 ${t / 3} 退化为同一点`);
    }
  }
});

test('UV 落在图集槽位内，且 u 随横向 i、v 随纵向 j 单调增', () => {
  const uv = { u0: 0.25, v0: 0.5, scale: 0.1 };
  const sub = 4;
  const { g } = geometryOf(5, 1000, sub, uv);
  const uvs = g.getAttribute('uv');
  for (let j = 0; j <= sub; j++) {
    for (let i = 0; i <= sub; i++) {
      const k = j * (sub + 1) + i;
      const u = uvs.getX(k), v = uvs.getY(k);
      assert.ok(u >= uv.u0 - 1e-6 && u <= uv.u0 + uv.scale + 1e-6, `u ${u} 越出槽位`);
      assert.ok(v >= uv.v0 - 1e-6 && v <= uv.v0 + uv.scale + 1e-6, `v ${v} 越出槽位`);
      // 图像 (col,row) 对应 (i,j)：u 随 i 增、v 随 j 增（图集纹理 flipY=false）
      assert.ok(Math.abs(u - (uv.u0 + (i / sub) * uv.scale)) < 1e-6, 'u 未随横向 i 单调增');
      assert.ok(Math.abs(v - (uv.v0 + (j / sub) * uv.scale)) < 1e-6, 'v 未随纵向 j 单调增');
    }
  }
});

test('初始不透明度全为 0（必须先淡入，避免半成品闪现）', () => {
  for (const [order, npix, sub] of CASES) {
    const { opacities } = geometryOf(order, npix, sub);
    assert.ok(opacities.every((x) => x === 0), `order ${order} npix ${npix} 初始透明度非 0`);
    assert.equal(opacities.length, (sub + 1) * (sub + 1), 'aOpacity 数量应与顶点数一致');
  }
});

test('几何尺寸与瓦片真实角尺度一致（order 越高越小，且符合 4^-order 比例）', () => {
  const span = (order, npix) => {
    const { g } = geometryOf(order, npix, 1);
    g.computeBoundingSphere();
    return g.boundingSphere.radius;   // 弦长半径，与角尺度成正比
  };
  const a = span(5, 1000), b = span(6, 4000);   // 同一块瓦片的父子（npix*4 是同区域子瓦片）
  assert.ok(a > b, '高阶瓦片应更小');
  // order 每加 1，瓦片角尺度减半 → 弦长半径约减半
  assert.ok(Math.abs(a / b - 2) < 0.2, `父子尺度比 ${(a / b).toFixed(3)} 偏离 2 过多`);
});

/*
 * 图集 uv 约定。
 *
 * 背景：three 的 Texture 默认 flipY = true，上传时会把图像上下翻转。
 * 而 slotUvOf()/buildTileGrid() 用的是"v=0 在画布顶边"的约定。
 * 两者一旦不一致，texture2D(uv) 会取到上下镜像的位置——实测表现是每张瓦片
 * 都采样到图集里另一个空槽位，瓦片整块近黑（屏上 13，而把 texture2D 换成
 * 常数 0.5 后同一像素是 206，证明问题在采样而非光照/法线/标定）。
 * 所以这里把"uv ↔ 画布像素"这条映射钉死。
 */
test('图集 uv 与画布像素一致：uv 落在槽位像素范围内，且 v 随画布 y 增大', () => {
  const PAGE = 4096, TILE = 512, SIDE = PAGE / TILE;
  for (const slot of [0, 1, 7, 8, 9, 63]) {
    const o = slotOrigin(slot);
    const uv = slotUvOf(slot);
    // 槽位原点应落在 512 网格上
    assert.equal(o.x % TILE, 0, `slot ${slot} 的 x 未对齐 512 网格`);
    assert.equal(o.y % TILE, 0, `slot ${slot} 的 y 未对齐 512 网格`);
    assert.ok(o.x >= 0 && o.x < PAGE && o.y >= 0 && o.y < PAGE, `slot ${slot} 原点越界`);
    // uv 区间必须落在该槽位的像素范围内（含半像素内缩）
    const px0 = uv.u0 * PAGE, px1 = (uv.u0 + uv.scale) * PAGE;
    const py0 = uv.v0 * PAGE, py1 = (uv.v0 + uv.scale) * PAGE;
    assert.ok(px0 >= o.x && px1 <= o.x + TILE,
      `slot ${slot} 的 u 区间 [${px0.toFixed(1)}, ${px1.toFixed(1)}] 超出槽位 x [${o.x}, ${o.x + TILE}]`);
    assert.ok(py0 >= o.y && py1 <= o.y + TILE,
      `slot ${slot} 的 v 区间 [${py0.toFixed(1)}, ${py1.toFixed(1)}] 超出槽位 y [${o.y}, ${o.y + TILE}]`);
    // 关键：v 与画布 y 同向（v=0 在顶边）。若纹理 flipY=true，这里就反了。
    assert.ok(py0 >= o.y, `slot ${slot}: v=0 未对应画布顶边（flipY 约定被破坏）`);
    // 内缩应为半像素
    assert.ok(Math.abs(px0 - o.x - 0.5) < 1e-9, `slot ${slot} u 内缩不是半像素`);
    assert.ok(Math.abs(py0 - o.y - 0.5) < 1e-9, `slot ${slot} v 内缩不是半像素`);
  }
  // 槽位排布：slot 0 在左上，slot 7 在第一行末，slot 8 在第二行首
  assert.deepEqual(slotOrigin(0), { x: 0, y: 0 });
  assert.deepEqual(slotOrigin(7), { x: 7 * 512, y: 0 });
  assert.deepEqual(slotOrigin(8), { x: 0, y: 512 });
  assert.deepEqual(slotOrigin(63), { x: 7 * 512, y: 7 * 512 });
  assert.equal(SIDE, 8);
});

test('瓦片网格的 uv 与槽位 uv 组合后仍落在槽位内', () => {
  const uv = slotUvOf(9);
  const sub = 4;
  const { g } = geometryOf(5, 1000, sub, uv);
  const uvs = g.getAttribute('uv');
  for (let j = 0; j <= sub; j++) {
    for (let i = 0; i <= sub; i++) {
      const k = j * (sub + 1) + i;
      const u = uvs.getX(k), v = uvs.getY(k);
      assert.ok(u >= uv.u0 - 1e-6 && u <= uv.u0 + uv.scale + 1e-6, `顶点 ${k} 的 u 越出槽位`);
      assert.ok(v >= uv.v0 - 1e-6 && v <= uv.v0 + uv.scale + 1e-6, `顶点 ${k} 的 v 越出槽位`);
    }
  }
  // 图像 (col,row) 对应 (i,j)：j=0 是第一行 → v 取槽位上边界（v 小 = 画布靠上）
  assert.ok(Math.abs(uvs.getY(0) - uv.v0) < 1e-6, 'j=0 未取到槽位 v 上边界');
  // j=sub 是最后一行 → v 取槽位下边界
  assert.ok(Math.abs(uvs.getY(sub * (sub + 1)) - (uv.v0 + uv.scale)) < 1e-6, 'j=sub 未取到槽位 v 下边界');
  // i=0 是第一列 → u 取左边界；i=sub → 右边界
  assert.ok(Math.abs(uvs.getX(0) - uv.u0) < 1e-6, 'i=0 未取到槽位 u 左边界');
  assert.ok(Math.abs(uvs.getX(sub) - (uv.u0 + uv.scale)) < 1e-6, 'i=sub 未取到槽位 u 右边界');
});

/*
 * 图集槽位账本。
 *
 * 回归背景：调用方每次刷新视野（0.25s 一次）都会对"已解码"的瓦片再调一次
 * atlas.upload()，把同一张图反复 drawImage 进画布、页面反复标脏，
 * 于是每次都要把 4096² 整页重传到 GPU 并重建 mipmap。
 * 实测静止不动时仍有 243 次/秒 的上传。AtlasSlots.has() 是幂等判断的依据。
 */
test('AtlasSlots：分配/复用/释放/内容判定', () => {
  const a = new AtlasSlots(1);
  const s0 = a.allocate('k0');
  assert.deepEqual(s0, { page: 0, slot: 0 });
  // 重复分配返回同一个槽位
  assert.deepEqual(a.allocate('k0'), s0);
  // 新键拿到下一个槽位
  assert.deepEqual(a.allocate('k1'), { page: 0, slot: 1 });
  // 分配 ≠ 已画入：刚分配时画布上还是空的
  assert.equal(a.has('k0'), false);
  assert.equal(a.has('k1'), false);
  a.markDrawn('k0');
  assert.equal(a.has('k0'), true);
  assert.equal(a.has('k1'), false, 'markDrawn 不应影响别的槽位');
});

test('AtlasSlots：单页放满后返回 null（页数用尽）', () => {
  const a = new AtlasSlots(1);
  const seen = new Set();
  let last = null;
  for (let i = 0; i < 64; i++) {
    const s = a.allocate('k' + i);
    assert.ok(s, `第 ${i} 个槽位分配失败`);
    assert.ok(!seen.has(s.slot), `槽位 ${s.slot} 被重复分配`);
    seen.add(s.slot);
    last = s;
  }
  assert.equal(seen.size, 64);
  assert.equal(last.page, 0);
  // 第 65 个：页数用尽
  assert.equal(a.allocate('overflow'), null);
});

test('AtlasSlots：多页扩展', () => {
  const a = new AtlasSlots(2);
  for (let i = 0; i < 64; i++) a.allocate('k' + i);
  const s = a.allocate('k64');
  assert.deepEqual(s, { page: 1, slot: 0 });
  assert.equal(a.pageCount, 2);
  // 第二页放满
  for (let i = 65; i < 128; i++) a.allocate('k' + i);
  assert.equal(a.allocate('overflow'), null);
  assert.equal(a.pageCount, 2);
});

test('AtlasSlots：释放后槽位可被复用，且内容判定复位', () => {
  const a = new AtlasSlots(1);
  a.allocate('k0');
  a.allocate('k1');
  a.markDrawn('k0');
  assert.equal(a.has('k0'), true);
  a.release('k0');
  assert.equal(a.slotOf.has('k0'), false);
  assert.equal(a.has('k0'), false, '释放后内容判定必须复位');
  // 新键复用刚释放的槽位 0，且不应被误判为"已画入"
  assert.deepEqual(a.allocate('k2'), { page: 0, slot: 0 });
  assert.equal(a.has('k2'), false, '复用槽位后不能被认为是已画入（否则会跳过首次上传）');
  a.markDrawn('k2');
  assert.equal(a.has('k2'), true);
});

test('AtlasSlots：同一张瓦片重复 markDrawn 不影响别的槽位', () => {
  const a = new AtlasSlots(1);
  a.allocate('k0'); a.allocate('k1');
  a.markDrawn('k0'); a.markDrawn('k0'); a.markDrawn('k0');
  assert.equal(a.has('k0'), true);
  assert.equal(a.has('k1'), false);
  // 占用关系不受影响
  assert.deepEqual(a.slotOf.get('k0'), { page: 0, slot: 0 });
  assert.deepEqual(a.slotOf.get('k1'), { page: 0, slot: 1 });
});

test('AtlasSlots：释放不存在的键是安全的', () => {
  const a = new AtlasSlots(1);
  a.release('never');
  assert.equal(a.slotOf.size, 0);
});

test('AtlasSlots：清空后状态归零', () => {
  const a = new AtlasSlots(2);
  for (let i = 0; i < 100; i++) a.allocate('k' + i);
  a.clear();
  assert.equal(a.slotOf.size, 0);
  assert.equal(a.pageCount, 0);
  assert.deepEqual(a.allocate('fresh'), { page: 0, slot: 0 });
});

/*
 * 多页图集的页选择。
 *
 * 回归背景：图集允许两页，但 TileLayer 的材质始终读 atlas.textures()[0]，
 * 于是分配到第二页的瓦片采样到第一页同槽位的无关内容 —— 表现为错贴。
 * 修法：每页一个材质（各自持有自己的 tileAtlas uniform，共享标定 uniform），
 * 并按 uv.page 给 mesh 选材质。这里守住"页号 → 材质"的映射。
 */
test('AtlasSlots.pageOf：能报出每个键落在哪一页', () => {
  const a = new AtlasSlots(2);
  for (let i = 0; i < 64; i++) a.allocate('p0-' + i);
  assert.equal(a.pageOf('p0-0'), 0);
  assert.equal(a.pageOf('p0-63'), 0);
  // 第 65 个进第二页
  a.allocate('p1-0');
  assert.equal(a.pageOf('p1-0'), 1, '第二页的键应报 page=1');
  assert.equal(a.pageOf('missing'), null);
});

test('AtlasSlots：两页的槽位编号各自独立（同一 slot 号出现在两页）', () => {
  const a = new AtlasSlots(2);
  for (let i = 0; i < 64; i++) a.allocate('a' + i);
  a.allocate('b0');
  assert.deepEqual(a.slotOf.get('a0'), { page: 0, slot: 0 });
  assert.deepEqual(a.slotOf.get('b0'), { page: 1, slot: 0 });
  // 同样的 slot=0 在两页里是不同内容 → 必须靠 page 区分材质，否则一定错贴
  assert.equal(a.pageOf('a0'), 0);
  assert.equal(a.pageOf('b0'), 1);
});
