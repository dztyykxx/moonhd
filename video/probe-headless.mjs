import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => ({ d, n: Number(d.split('-')[1]) })).sort((a, b) => b.n - a.n);
const EXE = path.join(root, dirs[0].d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const setups = [
  ['headless-new + metal', true, ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']],
  ['headless-new 默认', true, []],
  ['headed 离屏(-3000,-3000)', false, ['--window-position=-3000,-3000']],
];

for (const [name, headless, extra] of setups) {
  try {
    const browser = await chromium.launch({
      executablePath: EXE, headless,
      args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio', ...extra],
    });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/index.html?d=1.35&lon=-11.22&lat=-43.3', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__luna, null, { timeout: 30000 });
    await page.waitForTimeout(9000);
    const r = await page.evaluate(() => {
      const gl = window.__luna.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      const s = window.__luna.api.stats();
      return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?', fps: s.fps, order: s.order, tiles: s.tiles, status: s.statusText };
    });
    console.log(name.padEnd(24), JSON.stringify(r));
    await browser.close();
  } catch (e) {
    console.log(name.padEnd(24), 'ERR', e.message.split('\n')[0]);
  }
}
