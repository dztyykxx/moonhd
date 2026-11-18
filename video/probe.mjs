import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const EXE = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const URL = 'http://127.0.0.1:5173/index.html?spin=0&d=2.6&lon=0&lat=0';

const browser = await chromium.launch({
  executablePath: EXE,
  headless: false,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-infobars'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__luna, null, { timeout: 20000 });
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const l = window.__luna;
  const gl = l.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    quality: l.state.quality,
    dpr: devicePixelRatio,
    bodySize: [innerWidth, innerHeight],
    places: document.querySelectorAll('#place-list [role="listitem"], #place-list button, #place-list a').length,
    hips: { maxOrder: l.hips?.maxOrder, tiles: l.hips?.tiles?.length ?? null },
  };
});
console.log(JSON.stringify(info, null, 1));

await page.screenshot({ path: '/Users/dztyykxx/projects/moonhd/video/probe-globe.png' });

// zoom to a crater to check tile loading
await page.evaluate(() => window.__luna.flyTo(-43.3, -11.22, { distance: 1.12, duration: 0.9 }));
await page.waitForTimeout(9000);
const stats = await page.evaluate(() => {
  const s = window.__luna.api.stats?.();
  return s ?? null;
});
console.log('stats:', JSON.stringify(stats));
await page.screenshot({ path: '/Users/dztyykxx/projects/moonhd/video/probe-crater.png' });

await browser.close();
