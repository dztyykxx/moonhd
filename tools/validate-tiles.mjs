/**
 * 阶段1 实证校验：真实 China-VO 嫦娥二号 7m HiPS 瓦片 vs 本项目已有 8K 底图。
 *
 * 为什么不逐像素相关：LROC WMS 约 100 m/px、本地 8K 底图赤道约 1500 m/px，
 * 都比 7 m 的 HiPS 粗 10~200 倍。分辨率差异会主导相关系数，不能用它判断坐标。
 *
 * 本脚本用**与分辨率无关**的位置检查：
 *   对每张真实瓦片，取"瓦片平均亮度"与"该瓦片中心经纬度处 8K 底图的局部
 *   平均亮度（半径约 2.6°）"做秩相关。瓦片尺度约 1.5°（45 km），远大于底图
 *   分辨率，因此一旦瓦片被放到错误经纬度，相关性会立刻崩掉。
 *   用 Spearman 秩相关消除两套产品的绝对定标差异。
 *
 * 瓦片内部的图像方向（TILE_CORNER_UV）由另外两项证据确认，见报告 notes。
 *
 * 用法：node tools/validate-tiles.mjs [--out docs/validation/coords] [--count 24]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  tilePath, tileCenterLonLat, tileCornerVecs, nestedToFaceXY,
  orderToNside, npixOfOrder, vecToLonLat,
} from '../public/src/hips/healpix.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIPS = 'https://hips.china-vo.org/change2-moon-7m-dom/';
const CACHE = join(ROOT, 'docs/validation/coords/tiles');
const PY = process.env.PYTHON || 'python3';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'docs/validation/coords');
const cntIdx = args.indexOf('--count');
const COUNT = cntIdx >= 0 ? Number(args[cntIdx + 1]) : 30;
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const ORDER = 5;                        // 12288 张瓦片，约 1.4° 尺度
const NSIDE = orderToNside(ORDER);
const N = 64;

/* ---------- 取瓦片（磁盘缓存，避免重复请求源站） ---------- */
function fetchTile(npix) {
  const file = join(CACHE, `o${ORDER}-n${npix}.png`);
  if (existsSync(file) && readFileSync(file).length > 1000) return { file, cached: true };
  const url = HIPS + tilePath(ORDER, npix);
  const r = execFileSync('curl', [
    '-sS', '-L', '--max-time', '90',
    '-w', '%{http_code} %{size_download} %{content_type}',
    '-o', file, url,
  ], { encoding: 'utf8' });
  const [status, size, type] = r.trim().split(/\s+/);
  return { file, cached: false, status: Number(status), size: Number(size), type };
}

/** 一次解码多张为 n×n 灰度（减少 Python 启动次数）。 */
function decodeMany(paths, n) {
  const py = `
import sys
from PIL import Image
n = ${n}
for p in sys.argv[1:]:
    img = Image.open(p).convert('L')
    if n: img = img.resize((n, n), Image.BILINEAR)
    sys.stdout.buffer.write(img.tobytes())
`;
  const buf = execFileSync(PY, ['-c', py, ...paths], { maxBuffer: 1 << 30 });
  const per = n * n;
  return paths.map((_, i) => Float64Array.from(buf.subarray(i * per, (i + 1) * per)));
}

/** 8K 底图在若干经纬度点上的局部平均亮度。 */
function baseMeans(points, radius) {
  const f = join(OUT, '_basepts.f32');
  writeFileSync(f, Buffer.from(new Float32Array(points.flat()).buffer));
  const py = `
import sys, numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
img = Image.open(sys.argv[1]).convert('L')
W, H = img.size
a = np.asarray(img, dtype=np.float32)
pts = np.fromfile(sys.argv[2], dtype=np.float32).reshape(-1, 2)
r = ${radius}
out = []
for lon, lat in pts:
    u = ((lon + 180.0) % 360.0) / 360.0 * (W - 1)
    v = (90.0 - lat) / 180.0 * (H - 1)
    x = int(round(u)); y = int(round(v))
    x0 = max(0, x - r); x1 = min(W, x + r + 1)
    y0 = max(0, y - r); y1 = min(H, y + r + 1)
    out.append(float(a[y0:y1, x0:x1].mean()))
sys.stdout.buffer.write(np.asarray(out, dtype=np.float32).tobytes())
`;
  const buf = execFileSync(PY, ['-c', py, join(ROOT, 'public/assets/moon_albedo_8k.webp'), f],
    { maxBuffer: 1 << 26 });
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function pearson(a, b) {
  const n = a.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(Math.max(1e-12, da * db));
}
const rank = (arr) => {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  idx.forEach(([, i], k) => { r[i] = k; });
  return r;
};

/* ---------- 选瓦片：区域分散 + 确定性随机 ---------- */
const picks = [];
{
  const n = npixOfOrder(ORDER);
  const regions = [
    { name: '近边北', lon: 0, lat: 30 },
    { name: '近边南', lon: 0, lat: -30 },
    { name: '危海/东侧', lon: 60, lat: 15 },
    { name: '背面', lon: 180, lat: 0 },
    { name: '南极', lon: 0, lat: -85 },
    { name: '北极', lon: 0, lat: 85 },
    { name: '第谷', lon: -11.36, lat: -43.31 },
    { name: '哥白尼', lon: -20.08, lat: 9.62 },
  ];
  const seen = new Set();
  for (const rg of regions) {
    let best = -1, bestD = 1e9;
    for (let p = 0; p < n; p += 3) {
      const c = tileCenterLonLat(ORDER, p);
      const dlon = Math.abs(((c.lon - rg.lon) % 360 + 540) % 360 - 180);
      const d = dlon * dlon + (c.lat - rg.lat) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best >= 0 && !seen.has(best)) { seen.add(best); picks.push({ ...rg, npix: best }); }
  }
  let s = 20261012;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (picks.length < COUNT) {
    const p = Math.floor(rnd() * n);
    if (!seen.has(p)) { seen.add(p); picks.push({ name: '随机抽样', npix: p }); }
  }
}

/* ---------- 拉取 + 解码 ---------- */
const metas = [], files = [];
const errors = [];
for (const pk of picks) {
  const r = fetchTile(pk.npix);
  if (r.status && r.status !== 200) { errors.push({ npix: pk.npix, error: `HTTP ${r.status} ${r.type}` }); continue; }
  const c = tileCenterLonLat(ORDER, pk.npix);
  metas.push({
    ...pk, cached: r.cached, bytes: r.size,
    center: c,
    corners: tileCornerVecs(ORDER, pk.npix).map(vecToLonLat),
    faceXY: nestedToFaceXY(pk.npix, NSIDE),
  });
  files.push(r.file);
}
const grays = decodeMany(files, N);
const tileMeans = grays.map((g) => mean(g));

/* ---------- 位置检查 ---------- */
const bmeans = baseMeans(metas.map((m) => [m.center.lon, m.center.lat]), 60);
const rhoPearson = pearson(tileMeans, bmeans);
const rhoSpearman = pearson(rank(tileMeans), rank(bmeans));

const report = {
  generatedAt: new Date().toISOString(),
  source: HIPS,
  order: ORDER,
  tileCount: metas.length,
  errors,
  checks: {
    placement: {
      description: '瓦片平均亮度 vs 8K 底图同经纬度局部平均亮度（半径 60px≈2.6°）',
      pearson: +rhoPearson.toFixed(4),
      spearman: +rhoSpearman.toFixed(4),
      threshold: 'spearman > 0.5',
      pass: rhoSpearman > 0.5,
    },
  },
  tiles: metas.map((m, i) => ({
    npix: m.npix, name: m.name, cached: m.cached, bytes: m.bytes,
    center: [+m.center.lon.toFixed(4), +m.center.lat.toFixed(4)],
    faceXY: m.faceXY,
    tileMean: +tileMeans[i].toFixed(2),
    baseMean: +bmeans[i].toFixed(2),
  })),
  notes: [
    '位置检查：瓦片尺度约 1.5°（45 km），远大于底图分辨率（赤道约 1500 m/px），'
      + '对"瓦片被放到错误经纬度"敏感；用 Spearman 秩相关消除两套产品的定标差异。',
    '瓦片内部图像方向（TILE_CORNER_UV）的证据：'
      + '（a）与 LROC WMS 做梯度相关时，翻转/镜像后的相关系数一致低于当前方向；'
      + '（b）第谷区域按当前方向重投影后，环形山亮环与 LROC WMS 在同一经纬度重合'
      + '（见 docs/validation/coords/tycho-*.png 与 phase1 报告）。',
    '未验证项：moc_sky_fraction=1 是发布者声明，本轮只抽样检查了数十张瓦片，'
      + '不代表全月 314 万张都存在且内容正确。',
  ],
};

writeFileSync(join(OUT, 'tile-report.json'), JSON.stringify(report, null, 2));
const c = report.checks.placement;
console.log(`瓦片数：${metas.length}（order ${ORDER}，失败 ${errors.length}）`);
console.log(`位置检查：pearson=${c.pearson} spearman=${c.spearman}  ${c.pass ? '✔ 通过' : '✖ 未通过'}`);
console.log(`报告：${join(OUT, 'tile-report.json')}`);
process.exitCode = c.pass ? 0 : 1;
