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
await page.addInitScript({ path: new URL('./overlay.js', import.meta.url).pathname });
await page.goto('http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna && window.__vid, null, { timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.__vid.hideCover(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.evaluate(() => {
  window.__log = [];
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(t, (e) => window.__log.push(`${t}:${e.target.id || e.target.className || e.target.tagName}`), true);
  }
});

const view = () => page.evaluate(() => `main=${document.querySelector('#view-main').hidden} phase=${document.querySelector('#view-phase').hidden}`);

const el = page.locator('#nav-settings').first();
let b = await el.boundingBox();
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await sleep(600);
await page.evaluate(() => window.__log = []);

const gp = page.locator('#go-phase').first();
b = await gp.boundingBox();
console.log('go-phase box', b);
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await sleep(600);
console.log('点 go-phase 后', await view(), JSON.stringify(await page.evaluate(() => window.__log)));
await page.evaluate(() => window.__log = []);

const bp = page.locator('#back-from-phase').first();
b = await bp.boundingBox();
console.log('back-from-phase box', b);
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await sleep(600);
console.log('真实鼠标点 back 后', await view(), JSON.stringify(await page.evaluate(() => window.__log)));

await page.evaluate(() => window.__log = []);
await page.evaluate(() => document.querySelector('#back-from-phase').click());
await sleep(400);
console.log('程序化 .click() 后 ', await view(), JSON.stringify(await page.evaluate(() => window.__log)));

await browser.close();
