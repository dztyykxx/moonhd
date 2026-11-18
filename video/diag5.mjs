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
await page.goto('http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=0', { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna && window.__vid, null, { timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.__vid.hideCover(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nav = page.locator('#nav-settings').first();
let b = await nav.boundingBox();
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await sleep(500);
const gp = page.locator('#go-phase').first();
b = await gp.boundingBox();
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await sleep(600);

const box = await page.locator('#phase').first().boundingBox();
console.log('滑块盒子:', JSON.stringify(box));
console.log('样式:', await page.evaluate(() => {
  const n = document.querySelector('#phase');
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return { w: r.width, h: r.height, pad: cs.padding, appearance: cs.appearance, min: n.min, max: n.max, value: n.value };
}));

// 扫一遍：在轨道上若干比例位置按下，读回真实值，得到真实映射
const y = box.y + box.height / 2;
for (const r of [0, 0.1, 0.289, 0.5, 0.7, 0.9, 1]) {
  const x = box.x + r * box.width;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(120);
  const v = await page.evaluate(() => Number(document.querySelector('#phase').value));
  console.log(`  比例 ${r.toFixed(3)}  x=${Math.round(x)}  → 值 ${v}`);
}

// 再试一次真实拖拽：从当前值拖到 104
const cur = await page.evaluate(() => Number(document.querySelector('#phase').value));
await page.evaluate(() => { const n = document.querySelector('#phase'); n.value = '342.8'; n.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
const fromX = box.x + (342.8 / 360) * box.width;
await page.mouse.move(fromX, y);
await page.mouse.down();
await sleep(150);
for (const r of [0.7, 0.5, 0.35, 0.289]) {
  await page.mouse.move(box.x + r * box.width, y, { steps: 6 });
  await sleep(120);
  console.log(`  拖到比例 ${r} → 值 ${await page.evaluate(() => Number(document.querySelector('#phase').value))}`);
}
await page.mouse.up();
console.log('松手后:', await page.evaluate(() => document.querySelector('#phase').value));
await browser.close();
