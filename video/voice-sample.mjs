/**
 * 生成音色试听：同一段新文案，用几个候选音色各念一遍，拼成一条 mp3。
 *
 *   node voice-sample.mjs
 *
 * 产物：build/音色试听.mp3
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const FFMPEG = createRequire(import.meta.url)('ffmpeg-static');
/** edge-tts 装在项目自带的 venv 里（系统 python 是外部托管环境，装不进去） */
const PY = path.resolve('.venv/bin/python');
const PYEXE = fs.existsSync(PY) ? PY : 'python3';
const OUT = path.resolve('build');
fs.mkdirSync(OUT, { recursive: true });

const VOICES = [
  ['zh-CN-YunxiNeural', '云希 · 男声，活泼阳光，讲技术最常用'],
  ['zh-CN-YunyangNeural', '云扬 · 男声，新闻播报腔，稳'],
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 女声，温暖自然'],
  ['zh-CN-XiaoyiNeural', '晓伊 · 女声，轻快'],
];

const LINE = '先看这个：一颗完全跑在浏览器里的月球。three.js 实时渲染，8K 底图加真实高程光照，打开网页就能用，什么都不用装。';

const parts = [];
for (const [voice, desc] of VOICES) {
  const mp3 = path.join(OUT, `sample-${voice}.mp3`);
  execFileSync(PYEXE, ['-m', 'edge_tts', '--voice', voice, '--rate=+8%',
    '--text', LINE, '--write-media', mp3], { stdio: ['ignore', 'ignore', 'inherit'] });
  // 每段前面加一句报名字
  const tag = path.join(OUT, `tag-${voice}.mp3`);
  execFileSync(PYEXE, ['-m', 'edge_tts', '--voice', voice, '--rate=+8%',
    '--text', `音色 ${desc.split(' · ')[0]}。`, '--write-media', tag], { stdio: ['ignore', 'ignore', 'inherit'] });
  const wav = path.join(OUT, `sample-${voice}.wav`);
  const list = path.join(OUT, `sample-${voice}.txt`);
  fs.writeFileSync(list, [tag, mp3].map((f) => `file '${f}'`).join('\n'));
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
    '-safe', '0', '-i', list, '-ar', '24000', '-ac', '1', wav]);
  // 段间留 0.8s 空白
  const gap = path.join(OUT, 'sample-gap.wav');
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.8', gap]);
  parts.push(wav, gap);
  console.log(`  ${desc}`);
}

const listAll = path.join(OUT, 'sample-all.txt');
fs.writeFileSync(listAll, parts.map((f) => `file '${f}'`).join('\n'));
const out = path.join(OUT, '音色试听.mp3');
execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
  '-safe', '0', '-i', listAll, '-c:a', 'libmp3lame', '-q:a', '3', out]);
console.log('\n试听 →', out);
