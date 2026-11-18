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

// 在应用脚本之前挂钩 addEventListener，记录谁绑了什么
await page.addInitScript(() => {
  window.__bound = [];
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const id = this.id || this.className || this.tagName;
    window.__bound.push(`${type}@${id}`);
    return orig.call(this, type, fn, opts);
  };
});
await page.goto('http://127.0.0.1:5173/index.html?d=5.6&lon=0&lat=0&spin=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__luna, null, { timeout: 30000 });
await page.waitForTimeout(5000);

const bound = await page.evaluate(() => window.__bound.filter((b) => /back-|go-phase|nav-settings|settings-close/.test(b)));
console.log('绑定记录:', JSON.stringify(bound, null, 1));

const res = await page.evaluate(() => {
  const out = [];
  for (const id of ['back-from-phase', 'go-phase', 'nav-settings', 'settings-close', 'view-phase']) {
    const n = document.getElementById(id) || document.querySelector('.' + id);
    out.push(`${id}: ${n ? 'exists' : 'NULL'}`);
  }
  return out;
});
console.log(res.join('\n'));
await browser.close();
