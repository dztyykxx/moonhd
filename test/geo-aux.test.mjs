/**
 * 地理辅助层测试：拾取、经纬网生成、方向与局部比例尺。
 *
 * 关注点（设计文档 7、8、11 节）：
 *   - 拾取是"屏幕射线 × 解析球面"，且必须归一化到同一半径，否则点底图与
 *     点高清区会差一点；
 *   - 经纬网必须由月固坐标生成、±180° 只画一根、极点不生成退化圆；
 *   - 间隔切换要有滞回；
 *   - 比例尺只用视野中心附近的信息，取不到交点时必须返回 null（显示 "—"），
 *     不能拿固定相机高度冒充。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLocal, raySphereNearest, occludedBySphere, PICK_RADIUS, SURFACE_LIFT } from '../public/src/geo/pick.js';
import {
  buildGraticule, pickStep, capAngleDeg, axisSegments, poleLabels, STEP_LEVELS, AXIS_REACH,
} from '../public/src/geo/graticule.js';
import { niceScale, sampleLocalScale, northTangent, eastTangent, formatScaleKm } from '../public/src/geo/metrics.js';
import { dirFromLatLon, MOON_RADIUS_KM } from '../public/src/geo/coords.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('射线×球：命中正前方、擦边、完全错开', () => {
  // 从 (0,0,5) 朝 −Z 打，命中 (0,0,1)
  const t = raySphereNearest([0, 0, 5], [0, 0, -1], 1);
  assert.ok(t !== null);
  assert.ok(close(t, 4, 1e-12));

  // 正切：原点 (0,1,5)、方向 −Z → 判别式为 0，命中
  assert.ok(raySphereNearest([0, 1, 5], [0, 0, -1], 1) !== null);
  // 刚好错过
  assert.equal(raySphereNearest([0, 1.0000001, 5], [0, 0, -1], 1), null);
  // 已经贴在球面上朝外打 → 没有正交点
  assert.equal(raySphereNearest([0, 0, 1], [0, 0, 1], 1), null);
  // 从球内向外打 → 取唯一的正交点
  assert.ok(raySphereNearest([0, 0, 0], [0, 0, 1], 1) !== null);
});

test('拾取结果：归一化到球面、经纬度与方向公式一致', () => {
  // 朝 (0,0,1) 方向：lat 0、lon −90（西经 90）
  const hit = pickLocal([0, 0, 5], [0, 0, -1], PICK_RADIUS);
  assert.ok(hit);
  const r = Math.hypot(hit.local[0], hit.local[1], hit.local[2]);
  assert.ok(close(r, PICK_RADIUS, 1e-12), '命中点必须在拾取球面上');
  assert.ok(close(hit.lat, 0, 1e-9));
  // dir=(cos lat·cos lon, sin lat, −cos lat·sin lon)：z=+1 解得 lon = −90
  assert.ok(close(hit.lon, -90, 1e-9), 'z=+1 对应 lon −90°（西经 90）');
  // 法线与归一化方向相同
  for (let i = 0; i < 3; i++) assert.ok(close(hit.normal[i], hit.local[i] / r, 1e-12));
});

test('拾取对"底球 0.997 / 瓦片 1.0"两个半径给出同一个经纬度', () => {
  const from5 = pickLocal([0, 0, 5], [0, 0, -1], 1.0);
  const fromNear = pickLocal([0, 0, 1.3], [0, 0, -1], 1.0);
  assert.ok(close(from5.lat, fromNear.lat, 1e-12));
  assert.ok(close(from5.lon, fromNear.lon, 1e-12));
});

test('遮挡判定：正面可见、背面被挡、球外点在球后也被挡', () => {
  const cam = [0, 0, 5];
  // 正对相机的球面点
  assert.equal(occludedBySphere(cam, [0, 0, 1], 1), false);
  // 背面
  assert.equal(occludedBySphere(cam, [0, 0, -1], 1), true);
  // 背面外侧（自转轴南端）
  assert.equal(occludedBySphere(cam, [0, 0, -AXIS_REACH], 1), true);
  // 自转轴北端（在相机这一侧的球外）
  assert.equal(occludedBySphere(cam, [0, AXIS_REACH, 0], 1), false);
  // 相机在 d=5 时可见球冠半角 acos(1/5)≈78.5°，所以 90° 处的点已在月缘之外
  assert.equal(occludedBySphere(cam, [1, 0, 0], 1), true, '超过月缘应判为被挡');
  assert.equal(occludedBySphere(cam, [-1, 0, 0], 1), true);
  // 60° 处的点在可见球冠内
  const inside = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
  assert.equal(occludedBySphere(cam, inside, 1), false);
});

test('自转轴：沿本地 ±Y，两端伸出 14%', () => {
  const segs = axisSegments(1);
  assert.equal(segs.length, 12, '两段线 → 4 个顶点');
  const ys = [segs[1], segs[4], segs[7], segs[10]];
  assert.deepEqual(ys, [-AXIS_REACH, 0, 0, AXIS_REACH]);
  for (const [i, v] of segs.entries()) {
    if (i % 3 !== 1) assert.equal(v, 0, '轴线不能有 x/z 分量');
  }
  const poles = poleLabels();
  assert.equal(poles.length, 2);
  assert.ok(poles[0].pos[1] > 0 && poles[1].pos[1] < 0);
  assert.match(poles[0].text, /北极/);
  assert.match(poles[1].text, /南极/);
});

test('经纬网：纬线不含 ±90°，经线 ±180° 只画一次，标签一线上一个', () => {
  const { positions, labels } = buildGraticule({ step: 30, camLat: 0, camLon: 0 });
  assert.ok(positions.length > 0 && positions.length % 6 === 0, '每条线段 2 个顶点 × 3 分量');

  const parallels = labels.filter((l) => l.kind === 'parallel');
  const meridians = labels.filter((l) => l.kind === 'meridian');
  assert.deepEqual(parallels.map((l) => l.lat), [-60, -30, 0, 30, 60]);
  assert.equal(meridians.length, 12, '30° 间隔应生成 12 根经线（±180 只算一根）');
  const merLons = meridians.map((l) => l.lon);
  for (const want of [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]) {
    assert.ok(merLons.includes(want), `缺少经线 ${want}°`);
  }
  const lons = meridians.map((l) => l.lon);
  assert.equal(new Set(lons).size, lons.length, '经线标签不得重复');
  assert.ok(lons.includes(-180) || lons.includes(180));
  assert.equal(lons.includes(180), false, '180 必须规范化成 −180');

  // 所有顶点都必须落在网格半径上（略高于球面），且在球面上
  let maxR = 0, minR = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const r = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
    maxR = Math.max(maxR, r); minR = Math.min(minR, r);
  }
  assert.ok(minR > 1 && minR < 1.01, `网格半径应略高于 1，实际 ${minR}`);
  assert.ok(maxR < 1.01);
});

test('经纬网：极点附近不出现退化圆（纬线半径随纬度收缩但不为 0）', () => {
  const radius = 1 + SURFACE_LIFT;
  const { positions } = buildGraticule({ step: 5, camLat: 0, camLon: 0 });
  // 85° 纬线的半径应是 cos(85°)·R ≈ 0.0873，而不是 0
  let r85 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    const r = Math.hypot(positions[i], positions[i + 2]);
    if (close(y, Math.sin(85 * Math.PI / 180) * radius, 1e-6)) r85 = Math.max(r85, r);
  }
  assert.ok(close(r85, Math.cos(85 * Math.PI / 180) * radius, 1e-6), `85° 纬线半径 ${r85}`);
  // 5° 间隔下纬线数量应为 35（−85…85）
  const { labels } = buildGraticule({ step: 5 });
  assert.equal(labels.filter((l) => l.kind === 'parallel').length, 35);
  // 最细一档的规模要可控（不能把整球画成密网）
  const dense = buildGraticule({ step: STEP_LEVELS[STEP_LEVELS.length - 1] });
  assert.ok(dense.positions.length / 3 < 200000, '顶点数要有上限');
});

test('经纬网：标签锚在朝向相机的一侧', () => {
  const a = buildGraticule({ step: 30, camLat: 12, camLon: 34 });
  for (const l of a.labels) {
    if (l.kind === 'parallel') assert.equal(l.lon, 34);
    else assert.equal(l.lat, 12);
  }
});

test('间隔选择：整球 30°，近距逐级变细，且带滞回不抖动', () => {
  assert.equal(pickStep(capAngleDeg(9.5)), 30);
  assert.equal(pickStep(capAngleDeg(5.25)), 30);
  assert.equal(pickStep(capAngleDeg(1.35)), 15);
  // 从默认档连续调用会逐级收敛到最细一档
  let step = 30;
  for (let i = 0; i < 8; i++) step = pickStep(capAngleDeg(1.05), step);
  assert.equal(step, 5, '近距离应逐级细化到 5°');

  // 滞回：在阈值附近来回移动不能来回跳档
  const boundary = 70;                 // 30° → 15° 的变细阈值
  const fine = pickStep(boundary - 1, 30);
  assert.equal(fine, 15);
  const stillFine = pickStep(boundary + 1, 15);   // 只回升 1°，还没到变粗阈值 82°
  assert.equal(stillFine, 15, '回升一点点不应该立刻变粗');
  assert.equal(pickStep(85, 15), 30, '明显拉远才变粗');
  // 每次调用最多走一档（连续调用才会逐级收敛）
  assert.equal(pickStep(5, 30), 15, '一次只进一档');
  assert.equal(pickStep(5, 15), 10);
  assert.equal(pickStep(5, 10), 5);
  assert.equal(pickStep(5, 5), 5, '到最细一档就停住');
  assert.equal(STEP_LEVELS[STEP_LEVELS.length - 1], 5, '最细一档是 5°，不再往下');
  assert.equal(pickStep(85, 5), 10, '一次只退一档');
});

test('局部比例尺：1/2/5 系列刻度', () => {
  assert.deepEqual(niceScale(1, 96), { km: 100, px: 100 });
  assert.deepEqual(niceScale(0.01, 96), { km: 1, px: 100 });
  assert.deepEqual(niceScale(5, 96), { km: 500, px: 100 });
  assert.deepEqual(niceScale(0.2, 96), { km: 20, px: 100 });
  assert.equal(niceScale(0, 96), null);
  assert.equal(niceScale(NaN, 96), null);
  assert.equal(niceScale(-1, 96), null);
  // 极端值也不应给出离谱的条长：px 必须落在可用区间
  for (const k of [1e-9, 1e-3, 1e3, 1e9]) {
    const s = niceScale(k, 96);
    assert.ok(s && s.px >= 16 && s.px <= 260, `${k} → ${JSON.stringify(s)}`);
  }
});

test('局部比例尺：用中心横向量测，未命中返回 null', () => {
  // 造一个"赤道附近、1 NDC 跨度 ≈ 30°"的解析球面
  const pickAt = (nx, ny) => {
    const lon = nx * 30;          // 人为映射
    const lat = ny * 30;
    if (Math.abs(lon) > 90 || Math.abs(lat) > 90) return null;
    return { lat, lon };
  };
  const s = sampleLocalScale({ pickAt, screenW: 1000, ndcSpan: 0.12, radiusKm: MOON_RADIUS_KM });
  assert.ok(s);
  // 中心到 nx=0.12 的角距 = 3.6°（经度差，赤道上等于角距）
  assert.ok(close(s.spanDeg, 3.6, 1e-9), `spanDeg=${s.spanDeg}`);
  const km = (3.6 * Math.PI / 180) * MOON_RADIUS_KM;
  const pxSpan = 0.12 * 1000 / 2;
  assert.ok(close(s.kmPerPx, km / pxSpan, 1e-9));

  // 中心未命中 → null（不能拿相机高度冒充）
  assert.equal(sampleLocalScale({ pickAt: () => null, screenW: 1000 }), null);
  // 一侧未命中时改用另一侧
  const half = (nx) => (nx > 0 ? null : { lat: 0, lon: nx * 30 });
  assert.ok(sampleLocalScale({ pickAt: half, screenW: 1000, ndcSpan: 0.12 }));
  // 两侧都不命中 → null
  assert.equal(sampleLocalScale({ pickAt: () => null, screenW: 1000, ndcSpan: 0.12 }), null);
  // 屏幕宽度非法 → null
  assert.equal(sampleLocalScale({ pickAt, screenW: 0 }), null);
});

test('方向指示：北向切向量与球面相切，极点上退化', () => {
  for (const [lat, lon] of [[0, 0], [43.3, 120], [-43.3, -11.22], [-80, 30]]) {
    const n = dirFromLatLon(lat, lon, [0, 0, 0]);
    const t = northTangent(lat, lon);
    assert.ok(t, `lat ${lat} 应有北向切向量`);
    const len = Math.hypot(...t);
    assert.ok(close(len, 1, 1e-12), '必须是单位向量');
    const dot = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    assert.ok(Math.abs(dot) < 1e-12, '必须与球面法线垂直');
    // 北向分量应为正（朝北极）
    assert.ok(t[1] > 0, '北向切向量必须指向 +Y');
  }
  assert.equal(northTangent(90, 0), null, '北极点退化，应返回 null 让界面隐藏指示');
  assert.equal(northTangent(-90, 0), null);
  // 东向同理：赤道上指向 +z 的反方向（经度增大方向）
  const e = eastTangent(0, 0);
  assert.ok(e && close(e[0], 0, 1e-12) && close(e[2], -1, 1e-12));
  assert.equal(eastTangent(90, 0), null);
});

test('比例尺标签：整数与小数的显示', () => {
  assert.equal(formatScaleKm(500), '500 km');
  assert.equal(formatScaleKm(2000), '2,000 km');
  assert.equal(formatScaleKm(2.5), '2.5 km');
  assert.equal(formatScaleKm(NaN), '—');
});
