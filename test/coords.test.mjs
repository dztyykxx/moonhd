/**
 * 月固坐标契约测试。
 *
 * 重点不是"正反函数互逆"（那种测试对公式写错的情况是瞎的），而是：
 *   1. 用**手算的独立期望值**核对方向向量公式（第 4 节：四个基准经度、两极、±180°、已知地貌）；
 *   2. 用**已经过的 HiPS 边界**核对本模块与 healpix.js 的天文系一致
 *      （renderToHp(dirFromLatLon(lat,lon)) 必须等于 lonLatToVec(lon,lat)）；
 *   3. 用 public/data/places.json 里的真实坐标核对符号约定，
 *      防止把 USGS 的 0–360 东经形式直接吃进来。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  wrapLon, wrap360, dirFromLatLon, latLonFromDir, separationDeg, greatCircleKm,
  formatLat, formatLon, formatLatLon, formatClipboard, fixed,
  parseLatLonInput, looksLikeCoordinates, normalizeInputText, MOON_RADIUS_KM,
} from '../public/src/geo/coords.js';
import { renderToHp, hpToRender, lonLatToVec, vecToLonLat } from '../public/src/hips/healpix.js';

const D = Math.PI / 180;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('经度规范化：[-180,180)，180 归到 −180，−0 归零', () => {
  assert.equal(wrapLon(0), 0);
  assert.equal(wrapLon(180), -180);
  assert.equal(wrapLon(-180), -180);
  assert.equal(wrapLon(181), -179);
  assert.equal(wrapLon(-181), 179);
  assert.equal(wrapLon(360), 0);
  assert.equal(wrapLon(540), -180);
  assert.ok(!Object.is(wrapLon(-0), -0), '−0 必须归成 +0');
  assert.equal(wrap360(-90), 270);
  assert.equal(wrap360(450), 90);
});

test('四个基准经度（赤道）给出独立可读的方向', () => {
  const cases = [
    [0, 0, [1, 0, 0]],
    [0, 90, [0, 0, -1]],
    [0, 180, [-1, 0, 0]],
    [0, -90, [0, 0, 1]],
  ];
  for (const [lat, lon, want] of cases) {
    const got = dirFromLatLon(lat, lon, [0, 0, 0]);
    for (let i = 0; i < 3; i++) assert.ok(close(got[i], want[i], 1e-12), `lat${lat} lon${lon} 分量${i}`);
  }
});

test('两极：方向与经度无关，反算纬度 = ±90', () => {
  for (const lon of [0, 37, -122, 180]) {
    const n = dirFromLatLon(90, lon, [0, 0, 0]);
    assert.ok(close(n[0], 0, 1e-12) && close(n[1], 1, 1e-12) && close(n[2], 0, 1e-12));
    assert.ok(close(latLonFromDir(n).lat, 90, 1e-9));
    const s = dirFromLatLon(-90, lon, [0, 0, 0]);
    assert.ok(close(s[1], -1, 1e-12));
    assert.ok(close(latLonFromDir(s).lat, -90, 1e-9));
  }
});

test('±180° 附近连续：经度 179.9 / −179.9 / 180 / −180 的纬度不变', () => {
  const lat = 12.5;
  for (const lon of [179.9, -179.9, 180, -180]) {
    const { lat: la, lon: lo } = latLonFromDir(dirFromLatLon(lat, lon, [0, 0, 0]));
    assert.ok(close(la, lat, 1e-9), `lon ${lon} 的纬度`);
    assert.ok(close(wrapLon(lo), wrapLon(lon), 1e-9), `lon ${lon} 的经度`);
  }
  // 180 与 −180 是同一根子午线：方向完全相同
  const a = dirFromLatLon(30, 180, [0, 0, 0]);
  const b = dirFromLatLon(30, -180, [0, 0, 0]);
  for (let i = 0; i < 3; i++) assert.ok(close(a[i], b[i], 1e-12));
});

test('与 healpix.js 的天文系一致：renderToHp(dir) === lonLatToVec(lon,lat)', () => {
  // 这条测试把"地理模块的 y=极轴约定"钉在**已经与 astropy-healpix 对过**的
  // 天文系上。两个模块任何一个把轴换错，这里立刻红。
  const samples = [
    [0, 0], [8.35, 30.83], [34.72, -14.91], [-43.3, -11.22], [-89.67, 129.78],
    [88.63, 24.4], [-20.38, 128.97], [-35.69, -151.48], [57.59, -0.01], [12.5, 179.99],
  ];
  for (const [lat, lon] of samples) {
    const render = dirFromLatLon(lat, lon, [0, 0, 0]);
    const astro = renderToHp(render, [0, 0, 0]);
    const want = lonLatToVec(lon, lat, [0, 0, 0]);
    for (let i = 0; i < 3; i++) {
      assert.ok(close(astro[i], want[i], 1e-12), `lat${lat} lon${lon} 第${i}分量`);
    }
    // 反向也成立
    const back = hpToRender(want, [0, 0, 0]);
    for (let i = 0; i < 3; i++) assert.ok(close(back[i], render[i], 1e-12));
    // 并且与天文系自己的 vecToLonLat 读出来的经纬度一致
    const hp = vecToLonLat(want);
    assert.ok(close(hp.lat, lat, 1e-9));
    assert.ok(close(wrapLon(hp.lon), wrapLon(lon), 1e-9));
  }
});

test('已知地貌 Tycho：方向向量与手算值一致（不调用被测函数求期望）', () => {
  // Tycho：43.30° S / 11.22° W（IAU/USGS，LOLA 2011）
  const lat = -43.30 * D, lon = -11.22 * D;
  const want = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
  const got = dirFromLatLon(-43.30, -11.22, [0, 0, 0]);
  for (let i = 0; i < 3; i++) assert.ok(close(got[i], want[i], 1e-12), `分量 ${i}`);
  // 手算三个分量的十进制值（python3 math 独立算得）
  assert.ok(close(got[0], 0.713863052, 1e-8), `x=${got[0]}`);
  assert.ok(close(got[1], -0.685818353, 1e-8), `y=${got[1]}`);
  assert.ok(close(got[2], 0.141607663, 1e-8), `z=${got[2]}`);
});

test('收录地点数据：坐标范围合法、符号约定正确、往返一致', () => {
  const raw = JSON.parse(readFileSync(
    fileURLToPath(new URL('../public/data/places.json', import.meta.url)), 'utf8',
  ));
  assert.ok(raw.items.length >= 20, '首版至少 20 个地点');
  const kinds = new Set(raw.items.map((i) => i.kind));
  assert.ok(kinds.has('mare') || kinds.has('crater'), '必须覆盖月海或环形山');
  const hasFarSide = raw.items.some((i) => Math.abs(i.lonDeg) > 90);
  const hasSouth = raw.items.some((i) => i.latDeg < -30);
  assert.ok(hasFarSide, '必须覆盖背面');
  assert.ok(hasSouth, '必须覆盖南半球');

  for (const it of raw.items) {
    assert.ok(Number.isFinite(it.latDeg) && it.latDeg >= -90 && it.latDeg <= 90, `${it.id} 纬度`);
    assert.ok(Number.isFinite(it.lonDeg) && it.lonDeg >= -180 && it.lonDeg < 180, `${it.id} 经度`);
    const { lat, lon } = latLonFromDir(dirFromLatLon(it.latDeg, it.lonDeg, [0, 0, 0]));
    assert.ok(close(lat, it.latDeg, 1e-9), `${it.id} 纬度往返`);
    assert.ok(close(lon, it.lonDeg, 1e-9), `${it.id} 经度往返`);
    assert.ok(it.sourceUrl && it.sourceUrl.startsWith('https://'), `${it.id} 必须有来源链接`);
  }

  // 符号约定：西侧为负、东侧为正。这两条专门防"把 USGS 的 0–360 东经直接吃进来"。
  const imbrium = raw.items.find((i) => i.id === 'mare-imbrium');
  const crisium = raw.items.find((i) => i.id === 'mare-crisium');
  assert.ok(imbrium.lonDeg < 0, '雨海在正面西侧，经度必须为负');
  assert.ok(crisium.lonDeg > 0, '危海在正面东侧，经度必须为正');
});

test('格式化：N/S/E/W 半球、避免 −0、非法值给破折号', () => {
  assert.equal(formatLat(43.31), '43.31° N');
  assert.equal(formatLat(-43.31), '43.31° S');
  assert.equal(formatLat(0), '0.00° N');
  assert.equal(formatLat(-0), '0.00° N');
  assert.equal(formatLat(-0.001), '0.00° N', '−0.001 不该显示成 S');
  assert.equal(formatLon(11.36), '11.36° E');
  assert.equal(formatLon(-11.36), '11.36° W');
  assert.equal(formatLon(180), '180.00° W', '180 规范化成 −180');
  assert.equal(formatLatLon(-43.3, -11.22), '43.30° S · 11.22° W');
  assert.equal(formatLat(NaN), '—');
  assert.equal(formatLon(Infinity), '—');
  assert.equal(formatLatLon(NaN, 0), '—');
  assert.equal(formatClipboard(-43.3, -11.22), '-43.30, -11.22');
  assert.equal(formatClipboard(0, 0), '0.00, 0.00');
  assert.equal(fixed(-0.0001, 2), '0.00');
});

test('大圆距离：参考量级正确', () => {
  // 同一点为 0
  assert.equal(separationDeg(10, 20, 10, 20), 0);
  // 赤道上差 90° 经度 → 90°
  assert.ok(close(separationDeg(0, 0, 0, 90), 90, 1e-9));
  // 极点与赤道 → 90°
  assert.ok(close(separationDeg(90, 0, 0, 0), 90, 1e-9));
  // 1° 大圆 ≈ 30.3 km（月球半径 1737.4 km）
  assert.ok(close(greatCircleKm(0, 0, 0, 1), MOON_RADIUS_KM * D, 1e-9));
  assert.ok(Math.abs(greatCircleKm(0, 0, 0, 1) - 30.32) < 0.05);
});

test('输入解析：十进制、方向字母、度分、全角、方向在前', () => {
  const cases = [
    ['12.40, 18.60', 12.4, 18.6],
    ['12.40 18.60', 12.4, 18.6],
    ['12.40°N, 18.60°E', 12.4, 18.6],
    ['43.31S, 11.36W', -43.31, -11.36],
    ['N43.31 W11.36', 43.31, -11.36],
    ['S43.31 E11.36', -43.31, 11.36],
    ['-43.31, -11.22', -43.31, -11.22],
    ['12.40E, 18.60N', 18.6, 12.4],
    ['0, 0', 0, 0],
    ['（-43.31，-11.22）', -43.31, -11.22],
    ['１２．４０，１８．６０', 12.4, 18.6],
    ["43°31'S, 11°22'W", -43.516666, -11.366666],
  ];
  for (const [text, lat, lon] of cases) {
    const r = parseLatLonInput(text);
    assert.ok(r.ok, `${text} 应解析成功，得到 ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.lat - lat) < 1e-5, `${text} 纬度 ${r.lat} ≠ ${lat}`);
    assert.ok(Math.abs(r.lon - lon) < 1e-5, `${text} 经度 ${r.lon} ≠ ${lon}`);
  }
  // 经度 180 规范化到 −180
  const r180 = parseLatLonInput('10, 180');
  assert.ok(r180.ok);
  assert.equal(r180.lon, -180);
});

test('输入解析：越界与矛盾一律报错，绝不静默裁剪', () => {
  const bad = [
    ['91, 0', 'range-lat'],
    ['-90.5, 0', 'range-lat'],
    ['0, 400', 'range-lon'],
    ['-12.4N, 0', 'conflict'],
    ['0, -18E', 'conflict'],
    ['12.4N, 18.6N', 'format'],
    ['12.4E, 18.6W', 'format'],
    ['abc', 'format'],
    ['', 'empty'],
    ['12.4', 'format'],
    ['12.4, 18.6, 20', 'format'],
    ['12.4, xyz', 'format'],
  ];
  for (const [text, code] of bad) {
    const r = parseLatLonInput(text);
    assert.equal(r.ok, false, `${text} 应该失败`);
    assert.equal(r.code, code, `${text} 的错误类型`);
    assert.ok(r.message && r.message.length > 0, `${text} 要有可显示的提示`);
  }
  // 特别确认没有把 91 裁成 90
  const r = parseLatLonInput('91, 0');
  assert.equal(r.lat, undefined);
});

test('输入解析：全角与异体字符归一', () => {
  assert.equal(normalizeInputText('１２，３４'), '12,34');
  assert.equal(normalizeInputText('−43.31'), '-43.31');
  assert.ok(parseLatLonInput('12．40，18．60').ok, '全角句点/逗号应可用');
  assert.ok(parseLatLonInput('−43.31, −11.22').ok, 'Unicode 负号应可用');
  assert.ok(parseLatLonInput('１２．４０，１８．６０').ok, '全角数字应可用');
});

test('looksLikeCoordinates：保守分流，普通地名不误判', () => {
  assert.ok(looksLikeCoordinates('12.4, 18.6'));
  assert.ok(looksLikeCoordinates('12.4N 18.6E'));
  assert.ok(looksLikeCoordinates('-43.31, -11.22'));
  assert.ok(!looksLikeCoordinates('第谷'));
  assert.ok(!looksLikeCoordinates('Tycho'));
  assert.ok(!looksLikeCoordinates('阿波罗 11'));
  assert.ok(!looksLikeCoordinates(''));
});
