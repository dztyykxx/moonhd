/**
 * 经纬网与自转轴的几何生成。
 *
 * 关键约束：所有线段都由**月固经纬度**生成三维点（半径略高于球面），
 * 不能把设计稿里的椭圆当成屏幕线条硬编码。经线在 ±180° 只画一次，
 * 纬线在极点不生成退化圆。
 *
 * 本文件只做数学，输出 Float32Array 顶点与标签规格；three.js 的包装在
 * main.js 里（LineSegments + 挂在 moon 下面跟随世界变换）。
 */
import { SURFACE_LIFT, PICK_RADIUS } from './pick.js';

/** 自转轴线伸出球面的比例（1.14 → 两端各伸出 14%）。 */
export const AXIS_REACH = 1.14;

/** 极点标签所在的半径。 */
export const POLE_LABEL_RADIUS = 1.03;

/**
 * 可选的经纬网间隔（度），由粗到细。
 *
 * 最细只到 5°：在最近机位（d≈1.02，可见球冠半角约 12–18°）下 5° 已经给出
 * 约 7 条纬线与 72 根经线，再细就是密网，与"保持地貌细节清楚"冲突。
 */
export const STEP_LEVELS = [30, 15, 10, 5];

/**
 * 加入缩放滞回的间隔选择。
 *
 * 输入是"可见球冠半角"（度）：相机距球心 d 时，可见球冠半角 = acos(1/d)。
 * 整球视角约 84°，贴近到 d=1.35 约 42°，d=1.05 约 18°。
 * 降低阈值（更细则更密）刻意比升高阈值略小，避免在阈值附近来回抖动。
 *
 * @param {number} capDeg 可见球冠半角（度）
 * @param {number} current 当前间隔（度）
 * @returns {number} 新的间隔（度）
 */
export function pickStep(capDeg, current = STEP_LEVELS[0]) {
  const idx = STEP_LEVELS.indexOf(current);
  let next = idx >= 0 ? idx : 0;
  // 变细则：需要比当前级别要求更近；变粗则：需要比上一级的要求更远。
  // 两套阈值之间留出空隙，且**每次调用最多走一档**，避免阈值附近抖动。
  const finer = [70, 42, 24];
  const coarser = [82, 52, 32];
  if (next < STEP_LEVELS.length - 1 && capDeg < finer[next]) next++;
  else if (next > 0 && capDeg > coarser[next - 1]) next--;
  return STEP_LEVELS[next];
}

/** 由相机到球心的距离估算可见球冠半角（度）。 */
export function capAngleDeg(camDist) {
  if (!(camDist > 1)) return 90;
  return Math.acos(Math.min(1, 1 / camDist)) * (180 / Math.PI);
}

function pushSeg(out, a, b, r) {
  out.push(a[0] * r, a[1] * r, a[2] * r, b[0] * r, b[1] * r, b[2] * r);
}

function dir(lat, lon) {
  const cl = Math.cos(lat * Math.PI / 180);
  return [cl * Math.cos(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180), -cl * Math.sin(lon * Math.PI / 180)];
}

/**
 * 生成经纬网线段。
 *
 * @param {object} o
 * @param {number} o.step 间隔（度），见 pickStep
 * @param {number} [o.radius] 网格半径，默认球面 + SURFACE_LIFT
 * @param {number} [o.segDeg] 每段弧长（度）
 * @param {number} [o.camLat] 相机所在的月固纬度，用于把标签放在可见一侧
 * @param {number} [o.camLon] 相机所在的月固经度
 * @returns {{positions:number[], labels:{lat:number,lon:number,text:string,kind:string}[]}}
 */
export function buildGraticule({ step, radius = PICK_RADIUS + SURFACE_LIFT, segDeg = 2, camLat = 0, camLon = 0 }) {
  const positions = [];
  const labels = [];
  const r = radius;
  const s = Math.max(0.25, step);

  // 纬线：排除 ±90°（退化成点）
  for (let lat = -90 + s; lat <= 90 - s + 1e-9; lat += s) {
    if (Math.abs(lat) < 1e-9) {
      // 赤道：显式归零，避免 -0
      // eslint-disable-next-line no-param-reassign
    }
    const L = Math.abs(lat) < 1e-9 ? 0 : lat;
    for (let lon = -180; lon < 180 - 1e-9; lon += segDeg) {
      pushSeg(positions, dir(L, lon), dir(L, lon + segDeg), r);
    }
    labels.push({
      lat: L,
      lon: camLon,
      text: Math.abs(L) < 1e-9 ? '0°' : `${Math.abs(L).toFixed(0)}° ${L > 0 ? 'N' : 'S'}`,
      kind: 'parallel',
    });
  }

  // 经线：lon 与 lon+180 是两根不同的子午线，一圈共 360/s 根，
  // ±180 只保留一次（循环上界已经排除 180，无需再特判）。
  for (let lon = -180; lon < 180 - 1e-9; lon += s) {
    const L = Math.abs(lon) < 1e-9 ? 0 : lon;
    for (let lat = -90; lat < 90 - 1e-9; lat += segDeg) {
      pushSeg(positions, dir(lat, L), dir(lat + segDeg, L), r);
    }
    labels.push({
      lat: camLat,
      lon: L,
      text: Math.abs(L) < 1e-9 ? '0°' : `${Math.abs(L).toFixed(0)}° ${L > 0 ? 'E' : 'W'}`,
      kind: 'meridian',
    });
  }

  return { positions, labels };
}

/**
 * 自转轴：月球局部 ±Y 极轴，两端伸出球面 AXIS_REACH。
 * 深度测试会挡住穿过球体的部分，因此画面上只看到两个短出头。
 */
export function axisSegments(radius = 1) {
  const a = AXIS_REACH * radius;
  return [
    0, -a, 0, 0, 0, 0,
    0, 0, 0, 0, a, 0,
  ];
}

/** 极点标签的三维位置（月球局部系）。 */
export function poleLabels(radius = POLE_LABEL_RADIUS) {
  return [
    { lat: 90, lon: 0, text: 'N · 北极', kind: 'pole', pos: [0, radius, 0] },
    { lat: -90, lon: 0, text: 'S · 南极', kind: 'pole', pos: [0, -radius, 0] },
  ];
}
