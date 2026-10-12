/**
 * 可见性偏好 + 沉浸状态测试。
 *
 * 这一块是硬要求（设计文档第 6 节）：所有区域都能独立隐藏、偏好按版本化
 * schema 持久化、沉浸是**临时**状态且不覆盖偏好、退出后恢复原组合、
 * 全部隐藏也要能恢复。所以用假的 Storage 把持久化路径也测到。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYERS, LAYER_KEYS, SCHEMA_VERSION, STORAGE_KEY,
  defaultPrefs, sanitizePrefs, createVisibilityStore,
} from '../public/src/ui/visibility.js';

/** 最小的 localStorage 替身。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}

test('默认偏好：自转轴与经纬网默认关闭，其余默认显示', () => {
  const p = defaultPrefs();
  assert.equal(p.axis, false);
  assert.equal(p.grid, false);
  for (const l of LAYERS) {
    if (l.key !== 'axis' && l.key !== 'grid') assert.equal(p[l.key], true, `${l.key} 应默认显示`);
  }
  // 覆盖设计文档要求的全部可隐藏区域
  for (const need of ['topbar', 'catalog', 'infoCard', 'coordbar', 'toolbar', 'zoomTools', 'markers', 'axis', 'grid']) {
    assert.ok(LAYER_KEYS.includes(need), `可见性设置必须覆盖 ${need}`);
  }
});

test('sanitizePrefs：垃圾数据、未来版本、非布尔值都退回默认且不抛异常', () => {
  assert.deepEqual(sanitizePrefs(null).prefs, defaultPrefs());
  assert.deepEqual(sanitizePrefs('nonsense').prefs, defaultPrefs());
  assert.deepEqual(sanitizePrefs({}).prefs, defaultPrefs());
  assert.deepEqual(sanitizePrefs({ prefs: { axis: 'yes', grid: 1 } }).prefs, defaultPrefs());
  const future = sanitizePrefs({ version: SCHEMA_VERSION + 1, prefs: { axis: true } });
  assert.equal(future.repaired, true);
  assert.equal(future.prefs.axis, false);
  // 部分合法：只采纳合法的键，其余保持默认
  const part = sanitizePrefs({ version: SCHEMA_VERSION, prefs: { axis: true, bogus: 1 } });
  assert.equal(part.prefs.axis, true);
  assert.equal(part.prefs.grid, false);
  assert.equal('bogus' in part.prefs, false);
});

test('偏好持久化：写入 → 重新加载后仍然生效', () => {
  const storage = fakeStorage();
  const a = createVisibilityStore({ storage });
  a.set('axis', true);
  a.set('catalog', false);
  assert.equal(a.persisted, true);

  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(raw.version, SCHEMA_VERSION);

  const b = createVisibilityStore({ storage });
  assert.equal(b.preferred('axis'), true);
  assert.equal(b.preferred('catalog'), false);
  assert.equal(b.preferred('grid'), false);
});

test('持久化失败（无 Storage / 写入抛错）时回退默认，不影响观看', () => {
  const none = createVisibilityStore({ storage: null });
  assert.equal(none.persisted, false);
  assert.equal(none.preferred('topbar'), true);
  none.set('topbar', false);
  assert.equal(none.preferred('topbar'), false, '内存状态仍要生效');

  const broken = {
    getItem() { return null; },
    setItem() { throw new Error('QuotaExceeded'); },
    removeItem() {},
  };
  const s = createVisibilityStore({ storage: broken });
  s.set('grid', true);
  assert.equal(s.persisted, false, '写入失败要记录');
  assert.equal(s.preferred('grid'), true, '状态本身仍然生效');

  // 读到损坏的 JSON 也不能抛
  const corrupt = fakeStorage({ [STORAGE_KEY]: '{not json' });
  const c = createVisibilityStore({ storage: corrupt });
  assert.equal(c.preferred('topbar'), true);
});

test('沉浸：临时隐藏全部，但**不覆盖**偏好；退出后恢复原组合', () => {
  const storage = fakeStorage();
  const s = createVisibilityStore({ storage });
  s.set('axis', true);
  s.set('grid', true);
  s.set('catalog', false);
  const before = s.prefs;

  s.setImmersive(true);
  assert.equal(s.immersive, true);
  for (const k of LAYER_KEYS) assert.equal(s.visible(k), false, `${k} 在沉浸下必须不可见`);
  // 偏好没有被改动，也没有被写回存储
  assert.deepEqual(s.prefs, before);
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(raw.prefs.axis, true);
  assert.equal(raw.prefs.catalog, false);
  assert.equal('immersive' in raw, false, '沉浸状态不得写进偏好');

  s.setImmersive(false);
  assert.equal(s.visible('axis'), true);
  assert.equal(s.visible('grid'), true);
  assert.equal(s.visible('catalog'), false);
  assert.deepEqual(s.prefs, before, '退出沉浸后组合与进入前完全一致');
});

test('沉浸下改偏好：立即生效但不解除沉浸', () => {
  const s = createVisibilityStore({ storage: fakeStorage() });
  s.setImmersive(true);
  s.set('grid', true);
  assert.equal(s.preferred('grid'), true);
  assert.equal(s.visible('grid'), false, '沉浸下仍然不可见');
  s.setImmersive(false);
  assert.equal(s.visible('grid'), true);
});

test('全隐藏 / 恢复默认 / allHidden 判定', () => {
  const s = createVisibilityStore({ storage: fakeStorage() });
  s.setAll(false);
  assert.equal(s.allHidden(), true);
  for (const k of LAYER_KEYS) assert.equal(s.preferred(k), false);
  s.reset();
  assert.equal(s.allHidden(), false);
  assert.deepEqual(s.prefs, defaultPrefs());

  // 全隐藏时依然能通过 store 恢复：这是"不能出现无法操作的死角"的状态层保证
  s.setAll(false);
  s.setImmersive(true);
  s.setImmersive(false);
  s.set('topbar', true);
  assert.equal(s.visible('topbar'), true);
});

test('订阅：状态变化会通知，订阅者抛异常不影响状态', () => {
  const s = createVisibilityStore({ storage: fakeStorage() });
  const seen = [];
  const off = s.subscribe((snap) => seen.push({ ...snap.prefs }));
  assert.equal(seen.length, 1, 'subscribe 立即回调一次当前状态');
  s.set('grid', true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].grid, true);
  const off2 = s.subscribe(() => { throw new Error('boom'); });
  s.set('grid', false);
  assert.equal(s.preferred('grid'), false, '订阅者异常不能影响状态');
  off(); off2();
  const n = seen.length;
  s.set('grid', true);
  assert.equal(seen.length, n, '退订后不再收到通知');
});

test('set 对未知键无效；重复设置同值不触发通知', () => {
  const s = createVisibilityStore({ storage: fakeStorage() });
  let hits = 0;
  s.subscribe(() => { hits++; });
  const base = hits;
  assert.equal(s.set('nope', true), false);
  assert.equal(hits, base);
  s.set('grid', false);            // 已是 false
  assert.equal(hits, base);
  assert.equal(s.set('grid', true), true);
  assert.equal(hits, base + 1);
  assert.equal(s.toggle('grid'), true);
  assert.equal(s.preferred('grid'), false);
});
