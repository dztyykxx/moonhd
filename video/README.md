# 介绍视频是怎么录出来的

一条可复现的流水线：**旁白 → 音轨与时间轴 → 按时间轴自动录屏 → 合成**。
画面里的操作都是真点、真拖、真滚轮，没有后期剪辑拼贴。

```
narration.mjs   分镜脚本：每段的旁白文本（tts）+ 字幕文本（sub）+ 段末停顿
     │
     ├─ build-audio.mjs   edge-tts 合成配音 → 量每段时长 → 生成音轨 / 字幕 / 时间轴
     │                    产物：build/narration.wav、subtitles.srt、timeline.json
     │
     ├─ record.mjs        读 timeline.json，在「演示时钟」的指定秒数执行对应操作，
     │                    同时录屏。产物：build/demo.webm、record-meta.json
     │
     ├─ finalize.mjs      剪掉预热段 → 接音轨 → 压 H.264。产物：LUNA-超高清月球-介绍片.mp4
     │
     ├─ make-cover.mjs    用 ?ui=0 拍一张无界面底图 → 套版出封面。产物：LUNA-封面.png
     │
     └─ voice-sample.mjs  几个候选音色念同一段，拼成音色试听.mp3 供挑音色
```

## 怎么重跑

```bash
# 0. 起本地站点（应用必须走 http，importmap 不支持 file://）
cd ../public && python3 -m http.server 5173 &

cd ../video && npm install          # playwright-core + ffmpeg-static

# 配音用 edge-tts，装在项目自带的 venv 里（系统 python 是外部托管环境，装不进包）
python3 -m venv .venv && ./.venv/bin/pip install -U edge-tts

node voice-sample.mjs               # 可选：对比几个音色，选定后写进 TTS_VOICE
node build-audio.mjs                # 改旁白就重跑这一步
node record.mjs                     # 约 2.5 分钟，无头录制，屏幕不会弹窗
node finalize.mjs
node make-cover.mjs                 # 可选：COVER_VIEW=closeup 换近景底图
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TTS_VOICE` | `zh-CN-YunxiNeural` | 配音音色（云希）；换音色后必须重录 |
| `TTS_RATE` | `+8%` | 语速 |
| `TTS=say` | — | 退回 macOS 内置 Tingting（离线可用，音质差一截） |
| `DURATION` | `124` | 成片时长（秒） |
| `HEADED=1` | — | 在屏幕上看着录（默认无头，不会弹窗） |
| `APP_URL` | 本地 5173 | 换站点地址 |
| `COVER_VIEW` | `globe` | 封面底图取整球还是 `closeup` 近景 |

换音色或改旁白都会改变每段时长，`record.mjs` 是按 `timeline.json` 现场排程的，
所以**必须重录**；只改画面动作则重跑 `record.mjs` + `finalize.mjs` 即可。

## 时间对齐

音轨的第 0 秒 = 演示时钟的第 0 秒 = 成片第 0 秒。
录制时从开页到「演示 0 秒」之间会录进一段加载过程（画面是片头卡），
`record-meta.json` 里的 `preRoll` 就是这段长度，`finalize.mjs` 从 `preRoll` 处剪起，
所以字幕、配音、画面天然对齐，不需要再手动对轨。

自检：`silencedetect` 应显示 0 → 1.502s 为静音（片头卡停留），随后开始念第一句。

## 复杂的几个点（改脚本时注意）

- **交互一律用鼠标坐标点击**，不走 Playwright 的可点击性判定。
  点之前会做命中测试，命中的不是目标就打印遮挡者，方便定位。
- **开关类按钮用 `aria-checked` / `aria-pressed` 做幂等校准**。
  漏点一次不会让后面整段跑偏——这正是前几版录制翻车的原因。
- **所有定位调用都带显式短超时**（4–5s），不能用默认 30s，否则一个卡顿会把整条排程拖崩。
- **自定义 range 滑块要按拇指宽度换算**：轨道只有 92px，拇指占 13px，
  按「左端 + 比例×整宽」算会差十几度（想拖到 104° 会落在 91.5°）。
- **片尾卡起来之后要屏蔽后续字幕**（`overlay.js` 里的 `ended` 标志），
  否则半透明的片尾卡会透出底下的字幕。
- `browser.close()` 偶尔不返回，脚本里做了超时兜底后直接 `process.exit(0)`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `LUNA-超高清月球-介绍片.mp4` | 成片 |
| `LUNA-封面.png` | B 站封面 |
| `B站投稿文案.md` | 标题 / 简介 / 标签 / 置顶评论 |
| `overlay.js` | 注入页面里的呈现层：片头卡、实时字幕、方案卡、片尾卡、鼠标指针 |
| `voice-sample.mjs` | 音色试听（改音色前先听这个） |
| `.venv/` | edge-tts 专用环境 |
| `probe*.mjs` / `diag*.mjs` | 排查用的探针（GPU、无头渲染、面板状态、滑块映射），可留作参考 |
| `build/` | 中间产物（音轨、字幕、时间轴、原始录屏） |
