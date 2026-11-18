/**
 * 生成配音、时间轴与字幕。
 *
 *   node build-audio.mjs
 *
 * 产物（video/build/）：
 *   seg-XX.wav       每段配音
 *   narration.wav    整条音轨（含片头留白与段间停顿）
 *   subtitles.srt    字幕（备用；成片里字幕是实时叠加的）
 *   timeline.json    录制脚本读取的时间轴
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SEGMENTS, ENDCARD_HOLD } from './narration.mjs';

const FFMPEG = createRequire(import.meta.url)('ffmpeg-static');
/**
 * 配音用 edge-tts（微软神经语音，免费、不用 key）。
 * 系统 python 是外部托管环境装不进包，所以装在项目自带的 .venv 里。
 * 离线时用 TTS=say 退回 macOS 内置 Tingting（音质差一截，但能出片）。
 */
const PY = path.resolve('.venv/bin/python');
const PYEXE = fs.existsSync(PY) ? PY : 'python3';
const ENGINE = process.env.TTS || 'edge';
const VOICE = process.env.TTS_VOICE || 'zh-CN-YunxiNeural';
const RATE = process.env.TTS_RATE || '+8%';        // edge-tts 用百分比
const SAY_VOICE = process.env.SAY_VOICE || 'Tingting';
const SAY_RATE = Number(process.env.SAY_RATE || 200);
const LEAD_IN = Number(process.env.LEAD_IN || 1.5); // 录制里片头卡停留的时间
const OUT = path.resolve('build');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const run = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

/** 用 ffmpeg -i 读时长（没有 ffprobe，从 stderr 里解析） */
function duration(file) {
  try {
    run(FFMPEG, ['-i', file]);
    throw new Error('ffmpeg 没有报错，解析不到时长');
  } catch (e) {
    const s = String(e.stderr || '');
    const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) throw new Error('解析时长失败: ' + file + '\n' + s.slice(-400));
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
}

/* ---------- 1. 逐段合成 ---------- */
const parts = [];
let cursor = LEAD_IN;
for (let i = 0; i < SEGMENTS.length; i++) {
  const seg = SEGMENTS[i];
  const raw = path.join(OUT, `raw-${String(i).padStart(2, '0')}.wav`);
  const wav = path.join(OUT, `seg-${String(i).padStart(2, '0')}.wav`);
  if (ENGINE === 'say') {
    run('say', ['-v', SAY_VOICE, '-r', String(SAY_RATE), '-o', raw, '--file-format=WAVE',
      '--data-format=LEI16@22050', seg.tts || seg.sub]);
  } else {
    const mp3 = path.join(OUT, `raw-${String(i).padStart(2, '0')}.mp3`);
    run(PYEXE, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`,
      '--text', seg.tts || seg.sub, '--write-media', mp3]);
    run(FFMPEG, ['-y', '-loglevel', 'error', '-i', mp3, '-ar', '22050', '-ac', '1', raw]);
    fs.rmSync(mp3, { force: true });
  }
  const spoken = duration(raw);
  const gap = seg.gap ?? 0.5;
  // 补足到 本段时长 + 停顿，方便直接拼接
  run(FFMPEG, ['-y', '-loglevel', 'error', '-i', raw, '-af',
    `apad=whole_dur=${(spoken + gap).toFixed(3)}`, '-ar', '22050', '-ac', '1', wav]);
  fs.rmSync(raw, { force: true });
  parts.push({ file: wav, start: cursor, end: cursor + spoken, spoken, gap });
  cursor += spoken + gap;
  console.log(`seg ${String(i).padStart(2)} ${seg.id.padEnd(8)} 说 ${spoken.toFixed(2)}s  ` +
    `${((seg.tts || seg.sub).length / spoken).toFixed(2)} 字/秒  →  ${parts[i].start.toFixed(2)}s`);
}
const finalEnd = cursor + ENDCARD_HOLD;

/* ---------- 2. 整轨拼接（片头留白 + 各段 + 片尾留白） ---------- */
const listFile = path.join(OUT, 'concat.txt');
const lead = path.join(OUT, 'lead.wav');
run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
  `anullsrc=r=22050:cl=mono`, '-t', String(LEAD_IN), lead]);
const tail = path.join(OUT, 'tail.wav');
run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
  `anullsrc=r=22050:cl=mono`, '-t', String(ENDCARD_HOLD), tail]);

fs.writeFileSync(listFile, [lead, ...parts.map((p) => p.file), tail]
  .map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
const narration = path.join(OUT, 'narration.wav');
run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', narration]);

/* ---------- 3. 字幕切分与时间轴 ---------- */
const BREAKS = /([，。：；、！？])/;
function cueSplit(text, max = 21) {
  const chunks = [];
  let buf = '';
  const push = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const ch of text) {
    buf += ch;
    if (BREAKS.test(ch) && buf.length >= max - 6) push();
    else if (buf.length >= max) {
      // 没有标点就硬切，优先在空白/英文词边界
      const at = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('·'));
      if (at > max * 0.5) { const head = buf.slice(0, at); buf = buf.slice(at + 1); chunks.push(head.trim()); }
      else push();
    }
  }
  push();
  return chunks;
}

const srtTime = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

const segments = [];
const srt = [];
let cueIndex = 1;
for (let i = 0; i < SEGMENTS.length; i++) {
  const seg = SEGMENTS[i];
  const { start, end } = parts[i];
  const cues = cueSplit(seg.sub).map((c) => ({ text: c }));
  const total = cues.reduce((n, c) => n + c.text.length, 0);
  let t = start;
  for (const c of cues) {
    const d = Math.max(0.75, (c.text.length / total) * (end - start));
    c.start = t; c.end = Math.min(t + d, end + (seg.gap ?? 0.5) * 0.5);
    t = c.end;
    srt.push(`${cueIndex++}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`);
  }
  segments.push({ id: seg.id, sub: seg.sub, start, end, cues });
}

fs.writeFileSync(path.join(OUT, 'subtitles.srt'), srt.join('\n'));
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({
  leadIn: LEAD_IN, endcardHold: ENDCARD_HOLD, total: finalEnd, segments,
}, null, 2));

console.log(`\n总时长 ${finalEnd.toFixed(2)}s（配音 ${(cursor - LEAD_IN).toFixed(1)}s + 片尾卡 ${ENDCARD_HOLD}s）`);
console.log('时间轴 →', path.join(OUT, 'timeline.json'));
