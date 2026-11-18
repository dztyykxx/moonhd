import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => ({ d, n: Number(d.split('-')[1]) })).sort((a, b) => b.n - a.n);
const EXE = path.join(root, dirs[0].d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const browser = await chromium.launch({ executablePath: EXE, headless: false,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
await page.addInitScript({ path: new URL('./overlay.js', import.meta.url).pathname });

await page.goto('http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna && window.__vid, null, { timeout: 30000 });
await page.waitForTimeout(8000);

const dump = (tag) => page.evaluate((tag) => {
  const q = (s) => document.querySelector(s);
  const vis = (s) => { const n = q(s); if (!n) return 'missing';
    const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
    return `${cs.display}/${cs.visibility}/op=${cs.opacity} hidden=${n.hidden} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`; };
  return {
    tag,
    places: document.querySelectorAll('#place-list button').length,
    landingBtn: vis('#cat-landing'),
    navSettings: vis('#nav-settings'),
    settingsPanel: vis('#ui-settings'),
    viewMain: vis('#view-main'),
    goPhase: vis('#go-phase'),
    qualityBtn: vis('#quality-btn'),
    cover: vis('.v-cover'),
    card: vis('.v-card'),
    cursor: vis('.v-cursor'),
    topEl: document.elementFromPoint(1755, 41)?.id || document.elementFromPoint(1755, 41)?.className,
    midEl: document.elementFromPoint(150, 363)?.className,
    stats: (() => { const s = window.__luna.api.stats(); return { order: s.order, tiles: s.tiles, req: s.requests, status: s.statusText }; })(),
  };
}, tag);

console.log(JSON.stringify(await dump('initial'), null, 1));

// 用录制脚本里的同一套点击逻辑
async function click(sel) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'visible', timeout: 5000 });
  await el.hover({ timeout: 4000 }).catch(() => {});
  const b = await el.boundingBox();
  await page.evaluate(([x, y]) => window.__vid.cursor(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
  await new Promise((r) => setTimeout(r, 300));
  await el.click({ timeout: 5000 });
}

await click('#cat-landing');
await page.waitForTimeout(900);
console.log('点击着陆点后:', JSON.stringify((await dump('after-cat')).places));
console.log('着陆点条数:', await page.evaluate(() => document.querySelectorAll('#place-list button').length));
console.log('嫦娥五号存在:', await page.evaluate(() => !!document.querySelector('#place-list button[data-id="chang-e-5"]')));
console.log('嫦娥五号可见:', await page.locator('#place-list button[data-id="chang-e-5"]').isVisible().catch((e) => e.message));

await click('#nav-settings');
await page.waitForTimeout(900);
console.log(JSON.stringify(await dump('after-settings-open'), null, 1));

await click('#go-phase');
await page.waitForTimeout(700);
console.log(JSON.stringify(await dump('after-phase'), null, 1));

await browser.close();
