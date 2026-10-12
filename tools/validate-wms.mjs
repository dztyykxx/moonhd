/**
 * 阶段1 实证校验（独立数据源版）：把 China-VO 嫦娥二号 7m HiPS 瓦片与
 * LROC 官方 WMS（`luna_wac_global`，NASA/亚利桑那州立大学）在同一经纬度
 * 区域做逐像素比对。
 *
 * 为什么用 WMS 而不是本地 8K 底图：本地底图的投影/经度原点与常规等距圆柱
 * 不一致（见 docs/validation/coords/ 的分析），不适合做绝对定位基准；
 * WMS 的 EPSG:4326 经纬度框选是明确的，可直接作为独立基准。
 *
 * 判据：
 *   - 正确方向（asIs）的相关系数应显著高于上下翻转、左右镜像；
 *   - 把 HiPS 瓦片整体平移一个瓦片宽度后相关性应明显下降；
 *   - WMS 框选中心与瓦片中心的偏差应在瓦片尺度内。
 *
 * 用法：node tools/validate-wms.mjs [--out docs/validation/coords]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  tilePath, tileCenterLonLat, tileCorners, tileSampleVec,
  vec2pix, lonLatToVec, orderToNside, vecToLonLat, TILE_CORNER_UV,
} from '../public/src/hips/healpix.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIPS = 'https://hips.china-vo.org/change2-moon-7m-dom/';
const WMS = 'https://wms.im-ldi.com/lroc/wms?service=WMS&version=1.1.1&request=GetMap'
  + '&styles=&format=image/jpeg&srs=EPSG:4326&layers=luna_wac_global';
const PY = process.env.PYTHON || 'python3';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'docs/validation/coords');
mkdirSync(OUT, { recursive: true });

const LANDMARKS = [
  { name: 'tycho', label: '第谷环形山', lon: -11.36, lat: -43.31, order: 6 },
  { name: 'copernicus', label: '哥白尼环形山', lon: -20.08, lat: 9.62, order: 6 },
  { name: 'crisium', label: '危海', lon: 59.1, lat: 17.0, order: 5 },
  { name: 'tycho-antipode', label: '第谷对跖点（另一半球）', lon: 168.64, lat: 43.31, order: 5 },
  { name: 'dateline', label: '±180° 经度接缝', lon: 180.0, lat: 0.0, order: 5 },
];

const N = 128;

function curl(url, out) {
  const r = execFileSync('curl', [
    '-sS', '-L', '--max-time', '120',
    '-w', '%{http_code} %{size_download} %{content_type}',
    '-o', out, url,
  ], { encoding: 'utf8' });
  const [status, size, type] = r.trim().split(/\s+/);
  return { status: Number(status), size: Number(size), type };
}

function decodeGray(path, n) {
  const py = `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert('L')
if (${n}) : img = img.resize((${n}, ${n}), Image.BILINEAR)
sys.stdout.buffer.write(img.tobytes())
`;
  return execFileSync(PY, ['-c', py, path], { maxBuffer: 1 << 28 });
}

/** 用 WMS 按给定经纬度网格采样（EPSG:4326 等距圆柱，双线性）。 */
function sampleWms(lonGrid, latGrid, n, tag) {
  const fLon = join(OUT, `_wms-${tag}-lon.f32`), fLat = join(OUT, `_wms-${tag}-lat.f32`);
  writeFileSync(fLon, Buffer.from(new Float32Array(lonGrid).buffer));
  writeFileSync(fLat, Buffer.from(new Float32Array(latGrid).buffer));
  const py = `
import sys, numpy as np
from PIL import Image
img = Image.open(sys.argv[1]).convert('L')
W, H = img.size
a = np.asarray(img, dtype=np.float32)
lon = np.fromfile(sys.argv[2], dtype=np.float32).reshape(${n}, ${n})
lat = np.fromfile(sys.argv[3], dtype=np.float32).reshape(${n}, ${n})
u = ((lon + 180.0) % 360.0) / 360.0 * (W - 1)
v = (90.0 - lat) / 180.0 * (H - 1)
x0 = np.clip(np.floor(u).astype(np.int32), 0, W - 1); y0 = np.clip(np.floor(v).astype(np.int32), 0, H - 1)
x1 = np.clip(x0 + 1, 0, W - 1); y1 = np.clip(y0 + 1, 0, H - 1)
fx = (u - x0).astype(np.float32); fy = (v - y0).astype(np.float32)
top = a[y0, x0] * (1 - fx) + a[y0, x1] * fx
bot = a[y1, x0] * (1 - fx) + a[y1, x1] * fx
out = top * (1 - fy) + bot * fy
sys.stdout.buffer.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
`;
  return execFileSync(PY, ['-c', py, join(OUT, `_wms-${tag}.jpg`), fLon, fLat], { maxBuffer: 1 << 28 });
}

function stats(buf) {
  let sum = 0, sum2 = 0, min = 255, max = 0;
  for (const v of buf) { sum += v; sum2 += v * v; if (v < min) min = v; if (v > max) max = v; }
  const n = buf.length, mean = sum / n;
  return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2), min, max };
}

function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(Math.max(1e-9, da * db));
}
const flipH = (b, n) => { const o = Buffer.alloc(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) o[y * n + x] = b[y * n + (n - 1 - x)]; return o; };
const flipV = (b, n) => { const o = Buffer.alloc(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) o[y * n + x] = b[(n - 1 - y) * n + x]; return o; };

/** 图像 (i,j) → 瓦片局部 (s,t)，由 TILE_CORNER_UV 决定。 */
function imageIJtoLocalST(i, j, n) {
  const u = i / (n - 1), v = j / (n - 1);
  return [u, 1 - v];
}

const report = {
  generatedAt: new Date().toISOString(),
  hips: HIPS,
  wms: WMS,
  method: 'HiPS 瓦片逐像素反算经纬度，再在 LROC WMS (EPSG:4326, luna_wac_global) 上双线性采样，'
    + '逐像素零均值归一化互相关。两份数据来自不同产品（嫦娥二号 DOM vs LROC WAC），'
    + '且分辨率不同，相关系数不会等于 1；判据是"正确方向显著高于翻转/镜像/平移"。',
  landmarks: [],
};

for (const lm of LANDMARKS) {
  const nside = orderToNside(lm.order);
  const npix = vec2pix(nside, ...lonLatToVec(lm.lon, lm.lat));
  const center = tileCenterLonLat(lm.order, npix);
  const corners = tileCorners(lm.order, npix);
  const path = tilePath(lm.order, npix);

  const tileFile = join(OUT, `${lm.name}-o${lm.order}-n${npix}.png`);
  const res = curl(HIPS + path, tileFile);
  const entry = {
    name: lm.name, label: lm.label, requested: { lon: lm.lon, lat: lm.lat },
    order: lm.order, nside, npix, path, http: res,
    tileCenter: { lon: +center.lon.toFixed(6), lat: +center.lat.toFixed(6) },
    centerOffsetDeg: { lon: +(center.lon - lm.lon).toFixed(4), lat: +(center.lat - lm.lat).toFixed(4) },
    tileCorners: corners.map((c) => [+c.lon.toFixed(4), +c.lat.toFixed(4)]),
    cornerUV: TILE_CORNER_UV,
  };
  if (res.status !== 200 || !/png/i.test(res.type)) {
    entry.verdict = `FAIL: HTTP ${res.status} ${res.type}`;
    report.landmarks.push(entry);
    console.log(`✖ ${lm.label}: HTTP ${res.status} ${res.type}`);
    continue;
  }

  // WMS 框选：瓦片四角的经纬度包围盒（略微外扩）
  const lons = corners.map((c) => c.lon), lats = corners.map((c) => c.lat);
  let lon0 = Math.min(...lons), lon1 = Math.max(...lons);
  if (lon1 - lon0 > 180) { const a = Math.min(...lons.filter((l) => l > 0)); const b = Math.max(...lons.filter((l) => l < 0)); lon0 = b; lon1 = a; }
  let lat0 = Math.min(...lats), lat1 = Math.max(...lats);
  const padLon = (lon1 - lon0) * 0.05, padLat = (lat1 - lat0) * 0.05;
  lon0 -= padLon; lon1 += padLon; lat0 -= padLat; lat1 += padLat;
  // 经度跨接缝时 WMS bbox 不能直接跨；这里对跨缝地标用平移后的等价区间
  let bboxLon0 = lon0, bboxLon1 = lon1;
  if (bboxLon1 - bboxLon0 > 180) { bboxLon0 += 360; bboxLon1 += 360; }
  const wmsUrl = `${WMS}&bbox=${bboxLon0.toFixed(4)},${lat0.toFixed(4)},${bboxLon1.toFixed(4)},${lat1.toFixed(4)}&width=1024&height=1024`;
  entry.wmsUrl = wmsUrl;
  entry.wmsBbox = [bboxLon0, lat0, bboxLon1, lat1];
  const wmsFile = join(OUT, `_wms-${lm.name}.jpg`);
  const wres = curl(wmsUrl, wmsFile);
  entry.wmsHttp = wres;
  if (wres.status !== 200 || !/jpe?g|png/i.test(wres.type)) {
    entry.verdict = `FAIL: WMS HTTP ${wres.status} ${wres.type}`;
    report.landmarks.push(entry);
    console.log(`✖ ${lm.label}: WMS ${wres.status} ${wres.type}`);
    continue;
  }

  const tile = decodeGray(tileFile, N);
  entry.tileStats = stats(tile);

  const lonGrid = new Float32Array(N * N), latGrid = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const [s, t] = imageIJtoLocalST(i, j, N);
      const ll = vecToLonLat(tileSampleVec(lm.order, npix, s, t));
      lonGrid[j * N + i] = ll.lon; latGrid[j * N + i] = ll.lat;
    }
  }
  // WMS 采样：把经度平移到 bbox 所在的那一支
  const gridForWms = Float32Array.from(lonGrid, (v) => {
    if (bboxLon1 > 180) { let x = v; if (x < 0) x += 360; return x; }
    return v;
  });
  const ref = sampleWms(gridForWms, latGrid, N, lm.name);
  entry.wmsStats = stats(ref);
  writeFileSync(join(OUT, `${lm.name}-wms.raw`), ref);
  execFileSync(PY, ['-c', `
import sys
from PIL import Image
Image.frombytes('L', (${N}, ${N}), open(sys.argv[1],'rb').read()).save(sys.argv[2])
`, join(OUT, `${lm.name}-wms.raw`), join(OUT, `${lm.name}-wms.png`)]);

  entry.correlation = {
    asIs: +ncc(tile, ref).toFixed(4),
    flipV: +ncc(flipV(tile, N), ref).toFixed(4),
    flipH: +ncc(flipH(tile, N), ref).toFixed(4),
    flipBoth: +ncc(flipV(flipH(tile, N), N), ref).toFixed(4),
  };
  // 平移一个瓦片宽度（经度）后的相关性，应显著下降
  const spanLon = lon1 - lon0;
  const sLon0 = bboxLon0 + spanLon, sLon1 = bboxLon1 + spanLon;
  const shiftUrl = `${WMS}&bbox=${sLon0.toFixed(4)},${lat0.toFixed(4)},${sLon1.toFixed(4)},${lat1.toFixed(4)}&width=1024&height=1024`;
  const shiftFile = join(OUT, `_wms-${lm.name}-shift.jpg`);
  const sres = curl(shiftUrl, shiftFile);
  if (sres.status === 200) {
    const shiftGrid = Float32Array.from(gridForWms, (v) => v + spanLon);
    const refShift = sampleWms(shiftGrid, latGrid, N, lm.name + '-shift');
    entry.correlation.shiftLon1Tile = +ncc(tile, refShift).toFixed(4);
  }

  const c = entry.correlation;
  const keys = ['asIs', 'flipV', 'flipH', 'flipBoth'];
  const bestKey = keys.reduce((a, k) => (c[k] > c[a] ? k : a), 'asIs');
  entry.verdict = bestKey === 'asIs'
    ? `OK: asIs 最高 (${c.asIs})`
    : `CHECK: 最高是 ${bestKey} (${c[bestKey]}) vs asIs ${c.asIs}`;

  console.log(`${entry.verdict.startsWith('OK') ? '✔' : '✖'} ${lm.label} o${lm.order} npix${npix}`
    + ` 中心${center.lon.toFixed(2)},${center.lat.toFixed(2)}`
    + ` ncc asIs=${c.asIs} flipV=${c.flipV} flipH=${c.flipH} shift=${c.shiftLon1Tile}`);

  report.landmarks.push(entry);
}

writeFileSync(join(OUT, 'wms-report.json'), JSON.stringify(report, null, 2));
const ok = report.landmarks.filter((l) => l.verdict?.startsWith('OK')).length;
console.log(`\n报告：${join(OUT, 'wms-report.json')}`);
console.log(`方向一致：${ok}/${report.landmarks.length}`);
