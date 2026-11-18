/**
 * 合成成片：剪掉预热段 → 接上配音 → 压成 B 站可投的 mp4。
 *
 *   node finalize.mjs
 *
 * 时间对齐原理：
 *   录制脚本在「演示时钟 0 秒」时开始分镜，音轨也在 0 秒开始，
 *   而录制里演示 0 秒之前还录了 preRoll 秒的加载过程（画面是片头卡），
 *   所以成片从 preRoll 处剪起，A/V 天然对齐。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const FFMPEG = createRequire(import.meta.url)('ffmpeg-static');
const ROOT = path.resolve('.');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/record-meta.json'), 'utf8'));

/** 成片总时长：最后一句旁白在 132.1s 结束，片尾卡再留约 3 秒 */
const DURATION = Number(process.env.DURATION || 135.0);
const OUT = path.join(ROOT, process.env.OUT || 'LUNA-超高清月球-介绍片.mp4');

const run = (args) => execFileSync(FFMPEG, args, { stdio: ['ignore', 'inherit', 'inherit'] });

console.log(`剪掉预热 ${meta.preRoll.toFixed(2)}s，成片 ${DURATION}s → ${path.basename(OUT)}`);

run([
  '-y', '-hide_banner', '-loglevel', 'error',
  '-ss', meta.preRoll.toFixed(3),
  '-i', path.join(ROOT, 'build/demo.webm'),
  '-i', path.join(ROOT, 'build/narration.wav'),
  '-filter_complex',
    `[0:v]trim=start=0:end=${DURATION},setpts=PTS-STARTPTS,` +
    `fade=t=out:st=${(DURATION - 1.2).toFixed(2)}:d=1.2[v];` +
    `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,atrim=start=0:end=${DURATION},asetpts=PTS-STARTPTS[a]`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-profile:v', 'high', '-level', '4.2', '-r', '25',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-movflags', '+faststart',
  OUT,
]);

const size = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`\n完成 → ${OUT} (${size} MB)`);
execFileSync(FFMPEG, ['-hide_banner', '-i', OUT], { stdio: ['ignore', 'inherit', 'inherit'] });
