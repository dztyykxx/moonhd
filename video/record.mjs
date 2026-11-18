/**
 * 按时间轴录制演示。
 *
 *   node record.mjs            # 正式录制
 *
 * 时间轴取自 build/timeline.json（由 build-audio.mjs 生成）。
 * 所有动作时间都是「演示时钟」秒数——演示 0 秒 = 成片 0 秒 = 音轨 0 秒。
 *
 * 交互原则：
 *   1. 一律用鼠标坐标点击（page.mouse.click），不依赖 Playwright 的可点击性判定；
 *   2. 点之前先做命中测试，命中的不是目标就把遮挡者打出来；
 *   3. 开关类按钮用 aria-pressed 做幂等校准，漏点一次不会让后面整段跑偏。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 取 ms-playwright 缓存里最新的一个完整 Chromium（headless shell 不能录视频） */
function chromiumPath() {
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))
    .map((d) => ({ d, n: Number(d.split('-')[1]) })).sort((a, b) => b.n - a.n);
  for (const { d } of dirs) {
    const p = path.join(root, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Chromium，先跑: npx playwright install chromium');
}

const EXE = process.env.CHROME_PATH || chromiumPath();
const APP = process.env.APP_URL || 'http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=1';
const W = 1920, H = 1080;

const tl = JSON.parse(fs.readFileSync(new URL('./build/timeline.json', import.meta.url), 'utf8'));
const endAt = tl.total + 1.4;
const RAW = new URL('./build/raw/', import.meta.url).pathname;
fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  headless: process.env.HEADED !== '1',   // 无头同样是真 GPU（ANGLE Metal），不会在桌面上弹窗
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-features=Translate,BackForwardCache'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  recordVideo: { dir: RAW, size: { width: W, height: H } },
});
const page = await ctx.newPage();
const tVideoStart = Date.now();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/.test(m.text())) console.log('[console]', m.text().slice(0, 160));
});
await page.addInitScript({ path: new URL('./overlay.js', import.meta.url).pathname });

let t0ForLog = 0;
const T = (msg, t) => {
  const real = t0ForLog ? (Date.now() - t0ForLog) / 1000 : 0;
  console.log(`  ${t.toFixed(1).padStart(6)}s (实际 ${real.toFixed(1).padStart(6)}s)  ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 交互助手 ================= */
async function cursorTo(x, y) {
  await page.evaluate(([x, y]) => window.__vid.cursor(x, y), [x, y]);
}
async function boxOf(sel) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'visible', timeout: 5000 });
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await sleep(180); // 等面板/列表的 transition 停下
  const b = await el.boundingBox({ timeout: 4000 });
  if (!b) throw new Error('元素没有可见盒子: ' + sel);
  return { el, b };
}
/** 点之前做命中测试：命中的不是目标就把遮挡者打出来 */
async function hitTest(sel, x, y) {
  const who = await page.evaluate(([x, y, sel]) => {
    const top = document.elementFromPoint(x, y);
    let target = null;
    try { target = document.querySelector(sel); } catch { return { ok: true, top: '-' }; }
    if (!top || !target) return { ok: false, top: top ? top.outerHTML.slice(0, 90) : 'null' };
    const ok = top === target || target.contains(top) || top.contains(target);
    return { ok, top: top.tagName + '.' + (top.className || '') };
  }, [x, y, sel]);
  if (!who.ok) console.log(`    [遮挡] ${sel} 命中 ${who.top}`);
  return who.ok;
}
async function click(sel, { settle = 300, ripple = true } = {}) {
  const { b } = await boxOf(sel);
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await cursorTo(x, y);
  await sleep(settle);
  await hitTest(sel, x, y);
  await page.mouse.click(x, y);
  if (ripple) await page.evaluate(([x, y]) => window.__vid.ripple(x, y), [x, y]);
}
async function clickIf(sel, opts = {}) {
  try {
    const el = page.locator(sel).first();
    if (!(await el.isVisible())) return false;
    await click(sel, opts);
    return true;
  } catch (e) { console.log('    [跳过]', sel, e.message.slice(0, 60)); return false; }
}

const state = {
  settingsOpen: () => page.evaluate(() => !document.querySelector('#ui-settings').hidden),
  switchOn: (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    return (n.getAttribute('aria-checked') ?? n.getAttribute('aria-pressed')) === 'true';
  }, sel),
  phaseView: () => page.evaluate(() => !document.querySelector('#view-phase').hidden),
  infoOpen: () => page.evaluate(() => !document.querySelector('#ui-infocard').hidden),
  order: () => page.evaluate(() => window.__luna.api.stats().order),
};
/** 幂等：无论当前是什么状态，都校准到目标状态 */
async function ensureSettings(open) {
  for (let i = 0; i < 3; i++) {
    if ((await state.settingsOpen()) === open) return true;
    await click('#nav-settings', { settle: 240 });
    await sleep(280);
  }
  console.log(`    [警告] 设置面板未能${open ? '打开' : '收起'}`);
  return false;
}
async function ensureToggle(sel, on) {
  for (let i = 0; i < 3; i++) {
    if ((await state.switchOn(sel)) === on) return true;
    await click(sel, { settle: 220 });
    await sleep(240);
  }
  console.log(`    [警告] ${sel} 未切到 ${on}`);
  return false;
}
/** 用快捷键把某个开关校准到目标状态（不依赖按钮坐标） */
async function keyToggle(sel, k, on) {
  for (let i = 0; i < 3; i++) {
    if ((await state.switchOn(sel)) === on) return true;
    await key(k);
    await sleep(260);
  }
  console.log(`    [警告] ${sel} 快捷键未切到 ${on}`);
  return false;
}

/** 点触发器直到面板真的展开/收起（面板有动画，且点两次会翻转） */
async function ensureOpen(trigger, panel, open = true) {
  const isOpen = () => page.evaluate((s) => !document.querySelector(s).hidden, panel);
  for (let i = 0; i < 3; i++) {
    if ((await isOpen()) === open) return true;
    await click(trigger, { settle: 220 });
    await sleep(300);
  }
  console.log(`    [警告] ${panel} 未${open ? '展开' : '收起'}`);
  return false;
}
/** 点一下并确认某个状态成立，不成立就再点一次 */
async function clickUntil(sel, pred, tries = 2) {
  for (let i = 0; i < tries; i++) {
    await click(sel, { settle: 240 });
    await sleep(320);
    if (await pred()) return true;
  }
  console.log(`    [警告] ${sel} 点击后状态未变`);
  return false;
}
async function clickPlace(id) {
  const sel = `#place-list button[data-id="${id}"]`;
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });
  await click(sel, { settle: 280 });
}
async function drag(x1, y1, x2, y2, { steps = 26, hold = 120, settle = 280 } = {}) {
  await cursorTo(x1, y1);
  await sleep(settle);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await sleep(hold);
  for (let i = 1; i <= 4; i++) {
    const k = i / 4;
    const x = x1 + (x2 - x1) * k, y = y1 + (y2 - y1) * k;
    await page.mouse.move(x, y, { steps: Math.round(steps / 4) });
    await cursorTo(x, y);
  }
  await sleep(80);
  await page.mouse.up();
}
/**
 * 把 range 滑块拖到指定值。
 *
 * 这个滑块是 appearance:none 的自定义轨道，只有 92px 宽，拇指自己占 13px，
 * 按「x = 左端 + 比例×整宽」算会差十几度（实测：想拖到 104° 会落在 91.5°）。
 * 正确映射是 x = 左端 + 拇指半径 + 比例×(整宽 − 拇指直径)，13px 是实测值。
 * 另外 range 只在「按下→移动→松开」时改值，光在拇指上按一下不算。
 */
const THUMB_PX = 13;
async function setSlider(sel, target) {
  const read = () => page.evaluate((s) => Number(document.querySelector(s).value), sel);
  const box = await page.locator(sel).first().boundingBox({ timeout: 4000 });
  if (!box) throw new Error(`${sel} 不可见，滑块拖不了`);
  const y = box.y + box.height / 2;
  const W = box.width, M = 360;
  const at = (v) => Math.max(box.x + 1, Math.min(box.x + W - 1,
    box.x + THUMB_PX / 2 + (v / M) * (W - THUMB_PX)));

  const drag = async (xFrom, xTo) => {
    await cursorTo(xFrom, y);
    await sleep(240);
    await page.mouse.move(xFrom, y);
    await page.mouse.down();
    try {
      await sleep(140);
      await page.mouse.move(xTo, y, { steps: 16 });
      await cursorTo(xTo, y);
      await sleep(140);
    } finally {
      await page.mouse.up();
    }
    await sleep(300);
  };

  await drag(at(await read()), at(target));
  let v = await read();
  if (Math.abs(v - target) > 3) {   // 兜底：先甩到一端再落到目标，保证位移足够被识别
    const via = v < target ? box.x + 2 : box.x + W - 2;
    await cursorTo(at(v), y);
    await sleep(200);
    await page.mouse.move(at(v), y);
    await page.mouse.down();
    try {
      await sleep(120);
      await page.mouse.move(via, y, { steps: 10 });
      await sleep(90);
      await page.mouse.move(at(target), y, { steps: 12 });
      await sleep(120);
    } finally {
      await page.mouse.up();
    }
    await sleep(300);
    v = await read();
  }
  console.log(`    [滑块] 目标 ${target}° → 实际 ${v}°`);
  return v;
}

const fly = (lat, lon, distance, duration) =>
  page.evaluate(([lat, lon, d, du]) => window.__luna.flyTo(lat, lon, { distance: d, duration: du }),
    [lat, lon, distance, duration]);
const key = async (k) => {
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(k);
};

/* ================= 排程 ================= */
const timers = [];
let t0 = 0;
const at = (sec, label, fn) => {
  timers.push(setTimeout(() => {
    T(label, sec);
    const started = Date.now();
    let done = false;
    const guard = new Promise((_, rej) =>
      setTimeout(() => { if (!done) rej(new Error('动作超时 7s')); }, 7000));
    Promise.race([Promise.resolve().then(fn), guard])
      .then(() => {
        done = true;
        const ms = Date.now() - started;
        if (ms > 2500) console.log(`    [慢] ${label} 用了 ${(ms / 1000).toFixed(1)}s`);
      })
      .catch((e) => { done = true; console.log('[action error]', label, e.message); });
  }, Math.max(0, t0 + sec * 1000 - Date.now())));
};
/** 心跳：如果 Node 事件循环被卡住，这里会看出空档有多大 */
let lastTick = 0;
setInterval(() => {
  const now = Date.now();
  if (lastTick) {
    const gap = now - lastTick;
    if (gap > 900) console.log(`  [心跳] 事件循环卡了 ${(gap / 1000).toFixed(1)}s`);
  }
  lastTick = now;
}, 400);

/* ================= 载入并预热 ================= */
await page.goto(APP, { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna && window.__vid, null, { timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.__luna.api.stats?.();
  return s && s.baseRes >= 8192 && !s.upgradeError;
}, null, { timeout: 60000 });
await sleep(1200);
await page.evaluate(() => window.__vid.cursor(960, 540));

t0 = Date.now();
t0ForLog = t0;
const preRoll = (t0 - tVideoStart) / 1000;
console.log(`\n预热完成：视频已录 ${preRoll.toFixed(2)}s，现在开始演示时钟\n`);

/* ================= 分镜 ================= */
const S = Object.fromEntries(tl.segments.map((s) => [s.id, s]));
const checks = {};
const note = (k, v) => { checks[k] = v; };

/* 字幕 */
for (const seg of tl.segments) {
  for (const cue of seg.cues) {
    at(cue.start, `字幕「${cue.text.slice(0, 14)}…」`,
      () => page.evaluate((t) => window.__vid.sub(t), cue.text));
  }
}

/* 0 · 开场 */
at(S.intro.start, '片头卡淡出 + 缓慢推进', async () => {
  await page.evaluate(() => window.__vid.hideCover(560));
  page.evaluate(() => window.__luna.flyTo(0, 0, { distance: 4.5, duration: 9.4 }));
});

/* 1 · 方案任务书 */
at(S.origin.start - 0.1, '方案卡淡入', () => page.evaluate(() => window.__vid.cardIn()));
at(S.origin.end - 1.4, '方案卡淡出', () => page.evaluate(() => window.__vid.cardOut(520)));

/* 2 · 整球底图与彩色层 */
at(S.globe.start + 0.15, '退回整球', () => fly(0, 0, 5.25, 1.5));
at(S.globe.start + 4.7, '打开观察设置', async () => { note('settings', await ensureSettings(true)); });
at(S.globe.start + 5.9, '关闭彩色调制', () => ensureToggle('#sw-color', false));
at(S.globe.start + 9.2, '打开彩色调制', () => ensureToggle('#sw-color', true));
at(S.globe.end - 0.9, '收起设置 · 关闭自转', async () => {
  await ensureSettings(false);
  note('spinOff', await ensureToggle('#tb-spin', false));
});

/* 3 · 拖拽手感 */
at(S.drag.start + 0.15, '拖拽旋转 ①', () => drag(1180, 470, 800, 560));
at(S.drag.start + 3.7, '拖拽旋转 ②', () => drag(900, 620, 1240, 520));
at(S.drag.start + 6.4, '滚轮放大后再拖', async () => {
  await cursorTo(980, 520);
  await page.mouse.move(980, 520);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -120); await sleep(90); }
  await sleep(400);
  await drag(1200, 560, 1020, 500, { steps: 18 });
});

/* 4 · 地点目录与信息卡 */
at(S.catalog.start + 0.15, '切到着陆点', () => click('#cat-landing'));
at(S.catalog.start + 1.5, '滚动目录', () => page.locator('#place-list').evaluate((el) => { el.scrollTop = 150; }));
at(S.catalog.start + 3.0, '选中嫦娥五号', async () => {
  await clickPlace('chang-e-5');
  await sleep(900);
  note('infoCard', await state.infoOpen());
});
at(S.catalog.start + 9.0, '环绕着陆区', () => drag(1000, 500, 1160, 470, { steps: 22 }));

/* 5 · 七米细节按需加载 */
at(S.detail.start + 0.15, '切回地貌 · 选第谷', async () => {
  await click('#cat-feature', { settle: 220 });
  await sleep(450);
  await clickPlace('tycho');
});
at(S.detail.start + 3.6, '缓慢压到最细层级', () => fly(-43.3, -11.22, 1.045, 7.2));
at(S.detail.end - 0.4, '记录层级', async () => { note('orderAfterZoom', await state.order()); });

/* 6 · 经纬网与自转轴 */
at(S.grid.start + 0.15, '拉到中距', () => fly(-24, -26, 2.35, 1.6));
at(S.grid.start + 2.1, '开经纬网', () => ensureToggle('#tb-grid', true));
at(S.grid.start + 4.1, '开自转轴', () => ensureToggle('#tb-axis', true));
at(S.grid.start + 5.6, '转动看背面遮挡', () => drag(1300, 520, 1010, 500, { steps: 20 }));
at(S.grid.end - 0.5, '关经纬网', () => ensureToggle('#tb-grid', false));

/* 7 · 模拟月相 */
at(S.phase.start + 0.15, '关信息卡 · 开设置', async () => {
  if (await state.infoOpen()) await clickIf('#info-close', { settle: 200 });
  await ensureSettings(true);
});
at(S.phase.start + 1.4, '进入月相页', async () => {
  await click('#go-phase');
  await sleep(320);
  note('phaseView', await state.phaseView());
});
at(S.phase.start + 2.8, '预设：满月', () => click('#view-phase .preset:nth-child(3)'));
at(S.phase.start + 4.6, '预设：新月', () => click('#view-phase .preset:nth-child(1)'));
at(S.phase.start + 6.0, '拖回默认光照 104°', async () => {
  note('phaseRestored', await setSlider('#phase', 104));
});
at(S.phase.end - 0.5, '返回主设置', async () => {
  await clickUntil('#back-from-phase', async () => !(await state.phaseView()));
});

/* 8 · 画质切换与本地缓存 */
at(S.data.start + 0.2, '展开底图画质', async () => {
  await ensureSettings(true);
  note('qualityOpen', await ensureOpen('#quality-btn', '#quality-opts', true));
});
at(S.data.start + 1.6, '切到 4K', () => click('#quality-opts button[data-q="4096"]'));
at(S.data.start + 3.5, '切回 8K', async () => {
  await ensureOpen('#quality-btn', '#quality-opts', true);
  await click('#quality-opts button[data-q="8192"]');
});
at(S.data.start + 5.6, '收起设置 · 缩回整球', async () => {
  await ensureSettings(false);
  await fly(0, 0, 5.25, 1.25);
});
at(S.data.start + 8.1, '原路返回第谷（走本地缓存）', () => fly(-43.3, -11.22, 1.045, 1.7));

/* 9 · 沉浸模式与片尾 */
at(S.outro.start + 0.35, '关自转轴 · 进入沉浸', async () => {
  await page.mouse.up().catch(() => {});       // 兜底：防止上一拍留下按下状态
  await keyToggle('#tb-axis', 'a', false);
  await sleep(220);
  await key('h');
  await sleep(500);
  note('immersive', await page.evaluate(() => {
    const n = document.querySelector('#ui-topbar');
    return n.hidden || getComputedStyle(n).display === 'none';
  }));
});
at(S.outro.start + 4.2, '退出沉浸', () => key('h'));
at(S.outro.start + 5.0, '恢复自转', () => keyToggle('#tb-spin', ' ', true));
at(S.outro.start + 7.6, '片尾卡', () => page.evaluate(() => { window.__vid.subOff(); window.__vid.endIn(); }));

/* ================= 收尾 ================= */
setTimeout(async () => {
  const stats = await page.evaluate(() => {
    const s = window.__luna.api.stats();
    return { order: s.order, tiles: s.tiles, requests: s.requests, persistentHits: s.persistentHits, fps: s.fps, status: s.statusText };
  });
  for (const t of timers) clearTimeout(t);
  const video = page.video();
  await ctx.close();
  const dest = path.resolve('build/demo.webm');
  await video.saveAs(dest);
  fs.writeFileSync(path.resolve('build/record-meta.json'), JSON.stringify({
    preRoll, leadIn: tl.leadIn, total: tl.total, endAt, checks, stats,
  }, null, 2));
  console.log('\n自查:', JSON.stringify(checks));
  console.log('收尾统计:', JSON.stringify(stats));
  console.log(`视频 → ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
  console.log(`preRoll=${preRoll.toFixed(2)}s → 成片从 ${preRoll.toFixed(2)}s 处剪起`);
  // browser.close() 偶尔会卡住不返回（Chromium 退出时），视频已经落盘了，直接退
  await Promise.race([browser.close().catch(() => {}), sleep(4000)]);
  process.exit(0);
}, (endAt + 1.6) * 1000);

console.log(`演示时长 ${endAt.toFixed(1)}s，等待录制结束…`);
