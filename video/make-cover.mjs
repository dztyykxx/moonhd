/**
 * 生成 B 站封面：用成片里的一帧当底，套上和片头卡同样的排版。
 *
 *   node make-cover.mjs [取帧时间秒]
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const FFMPEG = createRequire(import.meta.url)('ffmpeg-static');
const ROOT = path.resolve('.');
const BG = path.join(ROOT, 'build/cover-bg.png');
const W = 1920, H = 1080;

/** 用 ?ui=0 拍一张没有界面的干净底图（整球 + 真实月面） */
const probe = process.env.COVER_VIEW || 'globe';   // globe | closeup
const APP = probe === 'closeup'
  ? 'http://127.0.0.1:5173/index.html?ui=0&spin=0&d=1.05&lon=-11.22&lat=-43.30'
  : 'http://127.0.0.1:5173/index.html?ui=0&spin=0&d=4.9&lon=-24&lat=12';

const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => ({ d, n: Number(d.split('-')[1]) })).sort((a, b) => b.n - a.n);
const EXE = path.join(root, dirs[0].d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio', '--use-angle=metal', '--enable-gpu'] });
const bctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const bpage = await bctx.newPage();
await bpage.goto(APP, { waitUntil: 'load' });
await bpage.waitForFunction(() => window.__luna, null, { timeout: 30000 });
await bpage.waitForFunction(() => {
  const s = window.__luna.api.stats?.();
  return s && s.baseRes >= 8192;
}, null, { timeout: 60000 });
await bpage.waitForTimeout(probe === 'closeup' ? 14000 : 4000);
await bpage.screenshot({ path: BG });
await browser.close();
console.log('底图 →', BG);
const bgData = fs.readFileSync(BG).toString('base64');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    font-family: "PingFang SC", "Hiragino Sans GB", sans-serif;
    background: #000 url(data:image/png;base64,${bgData}) center/cover no-repeat;
    -webkit-font-smoothing: antialiased;
  }
  .veil { position: absolute; inset: 0;
    background: linear-gradient(100deg, rgba(0,0,0,.86) 0%, rgba(0,0,0,.62) 42%, rgba(0,0,0,.12) 72%, rgba(0,0,0,.35) 100%); }
  .box { position: absolute; left: 118px; top: 210px; }
  .kicker { font-size: 21px; letter-spacing: .44em; color: #c8aa73; margin-bottom: 30px; }
  h1 { font-size: 132px; font-weight: 600; letter-spacing: .04em; color: #f7f2e8; line-height: 1; }
  h1 span { font-size: 86px; color: #d8bb85; letter-spacing: .1em; margin-left: 22px; }
  .rule { width: 168px; height: 2px; margin: 44px 0 40px;
    background: linear-gradient(90deg, #c8aa73, rgba(200,170,115,0)); }
  .sub { font-size: 40px; color: #ded7c9; letter-spacing: .03em; line-height: 1.5; }
  .tags { margin-top: 34px; font-size: 27px; color: #a49d90; letter-spacing: .06em; }
  .credit {
    position: absolute; left: 118px; bottom: 108px; font-size: 34px; letter-spacing: .06em;
    color: #e6d5ab; border-left: 5px solid #c8aa73; padding-left: 24px; line-height: 1.45;
  }
  .credit b { color: #fff; font-weight: 600; }
</style>
<div class="veil"></div>
<div class="box">
  <div class="kicker">THREE.JS · LUNAR EXPLORER</div>
  <h1>LUNA<span>超高清月球</span></h1>
  <div class="rule"></div>
  <div class="sub">8K 底图 ＋ 嫦娥二号 7 m 影像按需加载</div>
  <div class="tags">浏览器直开 · 无需安装 · 无构建步骤</div>
</div>
<div class="credit">方案 <b>GPT-6.1 sol</b>　·　实现 <b>DeepSeek</b></div>`;

const browser2 = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--use-angle=metal', '--enable-gpu'] });
const page = await (await browser2.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(600);
const OUT = path.join(ROOT, 'LUNA-封面.png');
await page.screenshot({ path: OUT });
console.log('封面 →', OUT);
await browser2.close();
process.exit(0);
