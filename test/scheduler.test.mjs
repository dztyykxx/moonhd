/**
 * 调度器测试：请求合并、重试上限、熔断、LRU 与内存预算。
 *
 * 重点回归：
 *  1. FAILED 分支曾直接 cache.delete()，导致 attempts 归零、maxRetries 永远达不到，
 *     弱网下无限重试（实测 80 张瓦片 30 秒 1280 次请求）。现在必须封顶。
 *  2. 连续失败要触发熔断，整体暂停请求而不是逐张死磕。
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TileScheduler, TileState } from '../public/src/hips/scheduler.js';

/** 可控时钟。 */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** 永远失败的 loader。 */
const failLoader = () => async () => { throw new Error('network down'); };
/** 永远成功的 loader（1x1 像素的假图，bytes 用 textureBytes 计）。 */
const okLoader = (w = 512, h = 512) => async () => ({ image: { width: w, height: h, close() {} }, width: w, height: h, blob: null });

async function settle(ms = 50) { await new Promise((r) => setTimeout(r, ms)); }

test('重试封顶：失败不会无限重试（曾经 attempts 被清零导致无限循环）', async () => {
  const c = clock();
  const s = new TileScheduler({
    loader: failLoader(), concurrency: 1, maxRetries: 2, retryBaseMs: 1,
    failCooldownMs: 1, maxCooldownMs: 2,
    breakerThreshold: 1e9,              // 关掉熔断，单独测重试上限
    now: c.now,
  });
  for (let i = 0; i < 60; i++) {
    s.request(0, 0, 0);
    c.advance(1000);
    await settle(5);
  }
  const st = s.getStats();
  assert.ok(st.requests <= 8,
    `重试未封顶：requests=${st.requests}（60 轮轮询后仍应停在个位数）`);
  const e = s.peek(0, 0);
  assert.equal(e.state, TileState.FAILED);
  assert.ok(e.dead, '达到上限后应标记为 dead，本会话不再请求');
});

test('熔断：连续失败到阈值后整体暂停请求', async () => {
  const c = clock();
  const s = new TileScheduler({
    loader: failLoader(), concurrency: 4, maxRetries: 0, retryBaseMs: 1,
    failCooldownMs: 1, maxCooldownMs: 1,
    breakerThreshold: 3, breakerCooldownMs: 10000,
    now: c.now,
  });
  // 触发 3 次失败
  for (let i = 0; i < 3; i++) { s.request(0, i, 0); }
  await settle(80);
  assert.ok(s.getStats().breakerTrips >= 1, `熔断未触发：${JSON.stringify(s.getStats())}`);
  const before = s.getStats().requests;
  // 熔断期间继续请求，应被跳过
  for (let i = 0; i < 50; i++) s.request(1, i, 0);
  await settle(50);
  const after = s.getStats();
  assert.equal(after.requests, before, '熔断期间不应发出新请求');
  assert.ok(after.breakerSkipped >= 50, `breakerSkipped=${after.breakerSkipped}`);
  // 冷却结束后恢复
  c.advance(20000);
  s.request(2, 0, 0);
  await settle(60);
  assert.ok(s.getStats().requests > before, '冷却结束后应恢复请求');
});

test('成功一次即重置熔断计数（源站恢复后不会一直被拦）', async () => {
  const c = clock();
  let fail = true;
  const loader = async () => {
    if (fail) throw new Error('down');
    return { image: { width: 512, height: 512, close() {} }, width: 512, height: 512, blob: null };
  };
  const s = new TileScheduler({
    loader, concurrency: 1, maxRetries: 0, failCooldownMs: 1, maxCooldownMs: 1,
    breakerThreshold: 2, breakerCooldownMs: 5000, now: c.now,
  });
  s.request(0, 0, 0); await settle(40);
  s.request(0, 1, 0); await settle(40);
  assert.ok(s.consecutiveFailures >= 2);
  fail = false;
  c.advance(6000);
  s.request(0, 2, 0); await settle(60);
  assert.equal(s.consecutiveFailures, 0, '成功后应清零连续失败计数');
  assert.equal(s.peek(0, 2).state, TileState.READY);
});

test('请求合并：同一张瓦片并发请求只发一次', async () => {
  let calls = 0;
  const s = new TileScheduler({
    loader: async () => { calls++; await settle(20); return { image: { width: 512, height: 512, close() {} }, width: 512, height: 512, blob: null }; },
    concurrency: 2,
  });
  const rs = [s.request(3, 100), s.request(3, 100), s.request(3, 100)];
  await settle(80);
  assert.equal(calls, 1, `同一瓦片应只请求一次，实际 ${calls}`);
  assert.equal(s.getStats().hits >= 2, true, '重复请求应计为命中');
  assert.equal(s.peek(3, 100).state, TileState.READY);
  void rs;
});

test('就绪瓦片命中缓存不再重新请求', async () => {
  let calls = 0;
  const s = new TileScheduler({
    loader: async () => { calls++; return { image: { width: 512, height: 512, close() {} }, width: 512, height: 512, blob: null }; },
    concurrency: 1,
  });
  s.request(4, 7); await settle(40);
  assert.equal(calls, 1);
  const r = s.request(4, 7);
  assert.equal(r.state, TileState.READY);
  await settle(30);
  assert.equal(calls, 1, '已就绪的瓦片不应再发请求');
  assert.equal(s.getStats().memoryHits, 1);
});

test('LRU：超预算时淘汰最久未用的，且不淘汰 pinned', async () => {
  const s = new TileScheduler({
    loader: okLoader(512, 512),
    concurrency: 4,
    memoryBudget: 3 * 512 * 512 * 4,      // 大约 3 张（textureBytes 含 mip 系数）
  });
  for (let i = 0; i < 8; i++) s.request(5, i);
  await settle(150);
  const st = s.getStats();
  assert.ok(st.evictions > 0, '超预算应发生淘汰');
  assert.ok(st.evictedBytes > 0, `淘汰字节数应被累加（曾恒为 0），实际 ${st.evictedBytes}`);
  assert.ok(st.bytes <= s.memoryBudget * 1.5, `淘汰后仍远超预算：${st.bytes}`);
  // 钉住一张（必须确保它还在缓存里），再压入更多，钉住的必须留下
  if (!s.peek(5, 0)) s.request(5, 0);
  await settle(80);
  assert.ok(s.peek(5, 0), '重新请求后 5/0 应在缓存里');
  s.setPinned(new Set(['5/0']));
  for (let i = 10; i < 20; i++) s.request(5, i);
  await settle(150);
  assert.ok(s.peek(5, 0), 'pinned 的瓦片不应被淘汰');
});
