import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => ({ d, n: Number(d.split('-')[1]) })).sort((a, b) => b.n - a.n);
const EXE = path.join(root, dirs[0].d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio', '--use-angle=metal', '--enable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript({ path: new URL('./overlay.js', import.meta.url).pathname });
await page.goto('http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna && window.__vid, null, { timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.__vid.hideCover(1));
await page.waitForTimeout(400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(tag) {
  const r = await page.evaluate(() => {
    const g = (s) => {
      const n = document.querySelector(s);
      if (!n) return 'missing';
      const b = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return `${cs.display} hidden=${n.hidden} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    };
    return {
      panel: g('#ui-settings'), main: g('#view-main'), phase: g('#view-phase'),
      qualityOpts: g('#quality-opts'), qualityBtn: g('#quality-btn'), backPhase: g('#back-from-phase'),
      closeBtn: g('#settings-close'), navSettings: g('#nav-settings'),
    };
  });
  console.log('\n== ' + tag);
  for (const [k, v] of Object.entries(r)) console.log(`   ${k.padEnd(13)} ${v}`);
  return r;
}

async function click(sel, label) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'visible', timeout: 5000 });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(200);
  const b = await el.boundingBox();
  if (!b) { console.log(`   [${label}] 没有盒子`); return; }
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const hit = await page.evaluate(([x, y, sel]) => {
    const top = document.elementFromPoint(x, y);
    return { top: top ? top.tagName + '#' + top.id + '.' + top.className : 'null', same: top === document.querySelector(sel) || document.querySelector(sel)?.contains(top) };
  }, [x, y, sel]);
  console.log(`   [点击 ${label}] 坐标 ${Math.round(x)},${Math.round(y)} 命中 ${hit.top} ${hit.same ? 'OK' : '<<< 不是目标'}`);
  await page.mouse.click(x, y);
  await sleep(500);
}

await click('#nav-settings', '观察设置');
await probe('打开设置');
await click('#go-phase', '进入月相');
await probe('月相页');
await click('#back-from-phase', '返回主设置');
await probe('返回后');
await click('#quality-btn', '展开底图画质');
await probe('展开后');
await click('#quality-opts button[data-q="4096"]', '切到4K');
await probe('切到4K后');
await browser.close();
