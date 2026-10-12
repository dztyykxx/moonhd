/**
 * HiPS 元数据解析与离线回退测试。
 *
 * 重点：`properties` 是静态文件，但断网时它取不到会让整个细节层不可用，
 * 即使 IndexedDB 里已经缓存了大量瓦片。fetchSourceConfigCached 用 localStorage
 * 兜住这一步，本文件验证：联网时正常、断网时回退、缓存也坏掉时抛错。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SOURCE, parseProperties, makeSourceConfig,
  fetchSourceConfig, fetchSourceConfigCached,
} from '../public/src/hips/meta.js';

/** 真实 properties 的关键字段（取自 china-vo 源的实测内容）。 */
const REAL_PROPS = `# HiPS properties
creator_did          = ivo://china-vo/change2-moon-7m-dom
obs_title            = Chang'e-2 Lunar DOM 7m
hips_version         = 1.4
hips_release_date    = 2020-01-01T00:00:00Z
hips_frame           = equatorial
hips_body            = moon
hips_order           = 9
hips_order_min       = 0
hips_tile_width      = 512
hips_tile_format     = png
hips_estsize         = 1454437179
moc_sky_fraction     = 1
hips_status          = public master clonable
hips_pixel_scale     = 3.4e-05
hips_service_url     = https://hips.china-vo.org/change2-moon-7m-dom
`;

/** 内存版 Storage，行为对齐 localStorage 的最小集合。 */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    get size() { return m.size; },
    _map: m,
  };
}

const okFetch = (text) => async () => ({
  ok: true, status: 200, text: async () => text,
});
const failFetch = (msg = 'Failed to fetch') => async () => { throw new TypeError(msg); };

test('parseProperties 解析关键字段', () => {
  const p = parseProperties(REAL_PROPS);
  assert.equal(p.orderMax, 9);
  assert.equal(p.orderMin, 0);
  assert.equal(p.tileWidth, 512);
  assert.deepEqual(p.formats, ['png']);
  assert.equal(p.hasPng, true);
  assert.equal(p.frame, 'equatorial');
  assert.equal(p.body, 'moon');
  assert.equal(p.mocSkyFraction, 1);
  assert.equal(p.estSizeKB, 1454437179);
  assert.ok(Math.abs(p.pixelScaleDeg - 3.4e-5) < 1e-12);
});

test('makeSourceConfig 拒绝非 PNG 源与缺少 hips_order 的源', () => {
  const fits = parseProperties('hips_order=9\nhips_tile_format=fits\n');
  assert.throws(() => makeSourceConfig(DEFAULT_SOURCE, fits), /不提供 PNG/);
  const noOrder = parseProperties('hips_tile_format=png\n');
  assert.throws(() => makeSourceConfig(DEFAULT_SOURCE, noOrder), /缺少 hips_order/);
});

test('makeSourceConfig 生成的 url() 符合 HiPS 路径规则', () => {
  const { config } = { config: makeSourceConfig(DEFAULT_SOURCE, parseProperties(REAL_PROPS)) };
  assert.ok(config.base.endsWith('/'), 'base 应以 / 结尾');
  assert.equal(config.url('Norder9/Dir0/Npix0.png'),
    'https://hips.china-vo.org/change2-moon-7m-dom/Norder9/Dir0/Npix0.png');
});

test('fetchSourceConfig 拒绝 HTML 响应（HTTP 200 也可能是错误页）', async () => {
  await assert.rejects(
    () => fetchSourceConfig(DEFAULT_SOURCE, { fetchImpl: okFetch('<!DOCTYPE html><html>404</html>') }),
    /返回了 HTML/);
});

test('fetchSourceConfig 在非 2xx 时抛错', async () => {
  await assert.rejects(
    () => fetchSourceConfig(DEFAULT_SOURCE, { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /HTTP 404/);
});

test('联网成功：写入缓存并标记 fromCache=false', async () => {
  const st = memStorage();
  const r = await fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: okFetch(REAL_PROPS), storage: st });
  assert.equal(r.fromCache, false);
  assert.equal(r.error, null);
  assert.equal(r.config.orderMax, 9);
  assert.equal(st.size, 1, '应写入一条元数据缓存');
  const saved = JSON.parse(st.getItem('moonhd.props.' + DEFAULT_SOURCE.id));
  assert.ok(saved.text.includes('hips_order'), '缓存里应是可再次解析的原始文本');
  assert.ok(typeof saved.at === 'number');
});

test('断网时回退到缓存，且能解析出同样的配置', async () => {
  const st = memStorage();
  // 先联网一次写入缓存
  const first = await fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: okFetch(REAL_PROPS), storage: st });
  // 再断网
  const second = await fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: failFetch(), storage: st });
  assert.equal(second.fromCache, true, '应标记为来自缓存');
  assert.ok(second.error, '应保留本次联网失败的原因');
  assert.equal(second.config.orderMax, first.config.orderMax);
  assert.equal(second.config.tileWidth, first.config.tileWidth);
  assert.deepEqual(second.props.formats, first.props.formats);
  // 路径规则仍可用（离线渲染依赖它）
  assert.equal(second.config.url('Norder5/Dir10000/Npix10000.png'), first.config.url('Norder5/Dir10000/Npix10000.png'));
});

test('断网且无缓存：抛出联网时的原始错误（保持安全降级）', async () => {
  const st = memStorage();
  await assert.rejects(
    () => fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: failFetch('boom'), storage: st }),
    /boom/);
});

test('缓存内容损坏时不崩溃，仍按无缓存处理', async () => {
  const st = memStorage();
  st.setItem('moonhd.props.' + DEFAULT_SOURCE.id, '{ this is not json');
  await assert.rejects(
    () => fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: failFetch('net down'), storage: st }),
    /net down/);
});

test('storage 抛异常（如隐私模式/配额满）不影响联网路径', async () => {
  const bad = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
  };
  const r = await fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: okFetch(REAL_PROPS), storage: bad });
  assert.equal(r.fromCache, false);
  assert.equal(r.config.orderMax, 9);
});

test('缓存往返：rawTextOf 拼回的文本可被 parseProperties 再解析', async () => {
  const st = memStorage();
  await fetchSourceConfigCached(DEFAULT_SOURCE, { fetchImpl: okFetch(REAL_PROPS), storage: st });
  const saved = JSON.parse(st.getItem('moonhd.props.' + DEFAULT_SOURCE.id));
  const reparsed = parseProperties(saved.text);
  const original = parseProperties(REAL_PROPS);
  for (const k of ['orderMax', 'orderMin', 'tileWidth', 'frame', 'body', 'mocSkyFraction', 'estSizeKB']) {
    assert.equal(reparsed[k], original[k], `字段 ${k} 往返后不一致`);
  }
  assert.deepEqual(reparsed.formats, original.formats);
});
