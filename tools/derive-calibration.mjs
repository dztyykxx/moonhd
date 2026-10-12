/**
 * 亮度标定增益推导：嫦娥二号 DOM 瓦片 ↔ 本地 8K 底图。
 *
 * 为什么需要单独一个脚本：
 * 之前 main.js 里写的 0.533 是"瓦片均值 / 底图局部均值"这个**原始像素比值**，
 * 方向搞反了——那个比值衡量的是"瓦片比底图暗多少"（0.533 表示瓦片只有底图一半亮），
 * 却当成"要把瓦片乘多少"用了。结果是瓦片被压得更暗（实测视口中心 232 → 14），
 * 在底图上叠出一块明显的暗斑。
 *
 * 正确的做法必须在**渲染域**里解：两边走同一条链路
 *   纹理 sRGB → linear → ×光强 → ACES 色调映射 → sRGB
 * 反解出让瓦片输出等于底图输出的增益。直接在线性域取比值是不够的，
 * 因为 ACES 是非线性的。
 *
 * 运行：npm run calib:gain
 * 输出：docs/validation/coords/calibration.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'docs/validation/coords/tile-report.json');
const OUT = join(ROOT, 'docs/validation/coords/calibration.json');

/* ---------- 与 three r186 完全一致的传递函数 ---------- */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
const mul = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const rrtAndOdtFit = (v) => v.map(
  (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081),
);
/** three 的 ACESFilmicToneMapping，灰度输入。 */
function aces(gray, exposure = 1.05) {
  const v = [gray * exposure / 0.6, gray * exposure / 0.6, gray * exposure / 0.6];
  const out = mul(ACES_OUT, rrtAndOdtFit(mul(ACES_IN, v)));
  return Math.min(1, Math.max(0, out[0]));
}
/** 纹理值(sRGB 0-255) → 光强 k → 屏幕值(sRGB 0-255) */
const shade = (srgb255, k, exposure = 1.05) => linearToSrgb(aces(srgbToLinear(srgb255 / 255) * k, exposure)) * 255;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const tiles = report.tiles;

/* ---------- 1. 由底球实测反解光强因子 k ---------- */
// 隔离测试页实测：底球 albedo 0x4d4d4d（77）在视口中心渲染为 232（gain 关、mix=0）
const BASE_PROBE_ALBEDO = 0x4d;
const BASE_PROBE_OUTPUT = 232;
let lo = 0, hi = 500;
for (let i = 0; i < 300; i++) {
  const mid = (lo + hi) / 2;
  (shade(BASE_PROBE_ALBEDO, mid) < BASE_PROBE_OUTPUT) ? lo = mid : hi = mid;
}
const k = (lo + hi) / 2;
const kCheck = shade(BASE_PROBE_ALBEDO, k);

/* ---------- 2. 逐张解出让瓦片输出等于底图输出的增益 ---------- */
const solveGain = (tileMean, baseMean) => {
  const target = shade(baseMean, k);
  let a = 0, b = 500;
  for (let i = 0; i < 200; i++) {
    const mid = (a + b) / 2;
    (shade(tileMean, k * mid) < target) ? a = mid : b = mid;
  }
  return (a + b) / 2;
};

const rows = tiles.map((t) => {
  const rawRatio = t.tileMean / t.baseMean;                 // 旧的（错误方向的）比值
  const linearRatio = srgbToLinear(t.baseMean / 255) / srgbToLinear(t.tileMean / 255);
  return {
    name: t.name,
    center: t.center,
    tileMean: t.tileMean,
    baseMean: t.baseMean,
    rawRatio: +rawRatio.toFixed(4),
    linearRatio: +linearRatio.toFixed(4),
    renderGain: +solveGain(t.tileMean, t.baseMean).toFixed(4),
  };
});

const gains = rows.map((r) => r.renderGain);
const chosen = +median(gains).toFixed(3);

/* ---------- 3. 残差：用选定的单一增益后，瓦片与底图的输出差 ---------- */
const residuals = rows.map((r) => {
  const baseOut = shade(r.baseMean, k);
  const tileOut = shade(r.tileMean, k * chosen);
  return +(tileOut - baseOut).toFixed(1);
});

const out = {
  generatedAt: new Date().toISOString(),
  sourceReport: 'tile-report.json',
  method: '渲染域反解：纹理 sRGB→linear→×k→ACES→sRGB，求使瓦片输出等于底图输出的增益',
  exposure: 1.05,
  lightFactorK: +k.toFixed(4),
  lightFactorProbe: { albedo: BASE_PROBE_ALBEDO, output: BASE_PROBE_OUTPUT, recomputed: +kCheck.toFixed(2) },
  chosenGain: chosen,
  bias: 0,
  gainSpread: {
    min: +Math.min(...gains).toFixed(3),
    p10: +[...gains].sort((a, b) => a - b)[Math.floor(gains.length * 0.1)].toFixed(3),
    median: chosen,
    p90: +[...gains].sort((a, b) => a - b)[Math.floor(gains.length * 0.9)].toFixed(3),
    max: +Math.max(...gains).toFixed(3),
  },
  residualAfterGain: {
    medianAbs: +median(residuals.map(Math.abs)).toFixed(1),
    maxAbs: +Math.max(...residuals.map(Math.abs)).toFixed(1),
    note: '单一全局增益无法同时匹配所有区域；残差来自两套产品的实际定标差异',
  },
  previousValue: 0.533,
  previousValueNote: '旧值是"瓦片均值/底图均值"的原始像素比（中位数 0.46），'
    + '衡量的是瓦片比底图暗多少，方向用反了，导致瓦片被进一步压暗。',
  rows,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`光强因子 k = ${out.lightFactorK}（自检反算底球输出 ${out.lightFactorProbe.recomputed} / 实测 ${BASE_PROBE_OUTPUT}）`);
console.log(`选定增益 = ${chosen}   偏差范围 ${out.gainSpread.min} ~ ${out.gainSpread.max}（p10 ${out.gainSpread.p10} / p90 ${out.gainSpread.p90}）`);
console.log(`施加后残差：中位 |Δ| = ${out.residualAfterGain.medianAbs} / 最大 |Δ| = ${out.residualAfterGain.maxAbs}（sRGB 0-255）`);
console.log(`报告：${OUT}`);
