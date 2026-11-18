/**
 * 注入到被录制页面里的呈现层：片头卡 / 实时字幕 / 方案卡 / 片尾卡 / 鼠标指针。
 * 通过 addInitScript 在应用脚本之前执行，最后暴露 window.__vid。
 */
(() => {
  const CSS = `
  .v-cover, .v-card, .v-end {
    position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #f2ede4; -webkit-font-smoothing: antialiased;
  }
  .v-cover { background: #000; transition: opacity .55s ease; }
  .v-cover__inner { text-align: center; padding: 0 60px; }
  .v-kicker {
    font-size: 15px; letter-spacing: .42em; color: #8d8a82;
    margin-bottom: 26px; text-indent: .42em;
  }
  .v-cover h1 {
    margin: 0; font-size: 82px; font-weight: 600; letter-spacing: .1em;
    color: #f6f1e6;
  }
  .v-cover h1 span { font-size: 52px; color: #c8aa73; letter-spacing: .16em; margin-left: 18px; }
  .v-line {
    width: 120px; height: 1px; margin: 34px auto;
    background: linear-gradient(90deg, transparent, #c8aa73, transparent);
  }
  .v-cover p { margin: 8px 0; font-size: 22px; color: #b9b3a7; letter-spacing: .06em; }
  .v-credit { font-size: 18px !important; color: #8d8a82 !important; margin-top: 30px !important; letter-spacing: .12em !important; }

  .v-sub {
    position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
    max-width: 1120px; padding: 11px 26px; border-radius: 14px;
    background: rgba(6, 8, 14, .62); backdrop-filter: blur(8px);
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 31px; line-height: 1.4; font-weight: 500; letter-spacing: .02em;
    color: #fff; text-align: center; text-shadow: 0 2px 10px rgba(0,0,0,.9), 0 0 1px rgba(0,0,0,1);
    z-index: 2147482000; opacity: 0; transition: opacity .22s ease; pointer-events: none;
  }
  .v-sub.is-on { opacity: 1; }

  .v-card {
    background: rgba(4, 6, 11, .82); backdrop-filter: blur(10px);
    transition: opacity .6s ease; z-index: 2147482500;
  }
  .v-card__box {
    width: 1080px; padding: 56px 64px 48px; border-radius: 20px;
    border: 1px solid rgba(200, 170, 115, .28);
    background: linear-gradient(180deg, rgba(20,22,30,.92), rgba(9,10,15,.94));
    box-shadow: 0 30px 90px rgba(0,0,0,.7);
  }
  .v-card__tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 15px; color: #c8aa73; letter-spacing: .04em; margin-bottom: 18px;
  }
  .v-card h2 { margin: 0 0 26px; font-size: 34px; font-weight: 600; letter-spacing: .03em; color: #f6f1e6; }
  .v-card ul { margin: 0; padding: 0; list-style: none; }
  .v-card li {
    font-size: 23px; line-height: 1.95; color: #cfc9bd; letter-spacing: .02em;
    padding-left: 26px; position: relative;
  }
  .v-card li::before {
    content: ''; position: absolute; left: 4px; top: 20px;
    width: 7px; height: 7px; border-radius: 50%; background: #c8aa73;
  }
  .v-card li b { color: #f6f1e6; font-weight: 600; }
  .v-card__foot {
    margin-top: 30px; padding-top: 24px; border-top: 1px solid rgba(200,170,115,.22);
    font-size: 21px; color: #c8aa73; letter-spacing: .08em;
  }

  .v-end { background: rgba(3, 4, 8, .93); transition: opacity .9s ease; }
  .v-end__box { text-align: center; padding: 0 60px; }
  .v-end h1 { margin: 0; font-size: 60px; font-weight: 600; letter-spacing: .1em; color: #f6f1e6; }
  .v-end h1 span { color: #c8aa73; }
  .v-end__sub { margin-top: 16px; font-size: 21px; color: #8d8a82; letter-spacing: .28em; }
  .v-end__grid {
    margin: 48px auto 0; width: 1000px; display: grid; grid-template-columns: 1fr 1fr;
    gap: 20px 40px; text-align: left;
  }
  .v-end__grid div {
    font-size: 23px; color: #ded8cc; display: flex; gap: 18px; align-items: baseline;
    border-bottom: 1px solid rgba(255,255,255,.07); padding-bottom: 14px;
  }
  .v-end__grid span {
    flex: 0 0 76px; font-size: 17px; color: #c8aa73; letter-spacing: .16em;
  }

  .v-cursor {
    position: fixed; left: 0; top: 0; width: 26px; height: 26px; margin: -3px 0 0 -3px;
    z-index: 2147483647; pointer-events: none;
    transition: transform .26s cubic-bezier(.3,.7,.3,1);
    filter: drop-shadow(0 2px 6px rgba(0,0,0,.75));
  }
  .v-ripple {
    position: fixed; left: 0; top: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px;
    border-radius: 50%; border: 2px solid rgba(255,255,255,.9);
    background: rgba(255,255,255,.28); z-index: 2147483646; pointer-events: none;
    animation: v-rip .5s ease-out forwards;
  }
  @keyframes v-rip {
    from { transform: scale(.5); opacity: .95; }
    to   { transform: scale(3.4); opacity: 0; }
  }
  `;

  const CURSOR_SVG = `<svg viewBox="0 0 24 24" width="26" height="26">
    <path d="M3.2 2.4 20 11.1l-7.1 1.5-3.3 6.5z" fill="#ffffff" stroke="#111318" stroke-width="1.6"
      stroke-linejoin="round"/></svg>`;

  function install() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    const mk = (cls, html) => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      document.documentElement.appendChild(d);
      return d;
    };

    const cover = mk('v-cover', `
      <div class="v-cover__inner">
        <div class="v-kicker">THREE.JS · REALTIME LUNAR EXPLORER</div>
        <h1>LUNA <span>超高清月球</span></h1>
        <div class="v-line"></div>
        <p>8K 底图 ・ 真实高程光照 ・ 嫦娥二号 7 m 影像按需加载</p>
        <p class="v-credit">方案 GPT-6.1 sol　·　实现 DeepSeek</p>
      </div>`);

    const sub = mk('v-sub', '');

    const card = mk('v-card', `
      <div class="v-card__box">
        <div class="v-card__tag">docs/plans/china-vo-hips-implementation-deepseek.md</div>
        <h2>国内高清月球影像实施方案与 DeepSeek 任务书</h2>
        <ul>
          <li><b>一</b>　给 DeepSeek 的任务提示词：只交实现，不接受伪代码</li>
          <li><b>二</b>　当前项目与修改位置：先读源码与调研报告</li>
          <li><b>三</b>　数据源与已验证事实：HTTP 200 / CORS / 元数据实测</li>
          <li><b>四</b>　推荐架构：HEALPix、LOD、调度、持久化分层</li>
          <li><b>五</b>　分阶段实施：坐标验证 → 按需加载 → 缓存 → 测试交付</li>
        </ul>
        <div class="v-card__foot">跨模型协作：方案 GPT-6.1 sol　→　实现 DeepSeek</div>
      </div>`);
    card.style.opacity = '0';
    card.style.display = 'none';

    const end = mk('v-end', `
      <div class="v-end__box">
        <h1>LUNA <span>超高清月球</span></h1>
        <div class="v-end__sub">REALTIME LUNAR EXPLORER</div>
        <div class="v-end__grid">
          <div><span>方案</span>GPT-6.1 sol 制定实施任务书</div>
          <div><span>实现</span>DeepSeek 逐阶段编码与验证</div>
          <div><span>影像</span>嫦娥二号 7 m DOM · 国家天文台</div>
          <div><span>数据</span>国家空间科学数据中心 · NASA / USGS</div>
          <div><span>技术</span>three.js r186 · 无构建 · 100 个用例全绿</div>
          <div><span>许可</span>细节影像 CC BY 4.0 · 需引用致谢</div>
        </div>
      </div>`);
    end.style.opacity = '0';
    end.style.display = 'none';

    const cursor = mk('v-cursor', CURSOR_SVG);

    const reduce = (el, ms) => new Promise((r) => setTimeout(r, ms));
    let ended = false;          // 片尾卡起来之后，后面排到的字幕一律不再显示

    window.__vid = {
      /* 片头卡：淡出后从 DOM 移除 */
      hideCover: (ms = 550) => new Promise((r) => {
        cover.style.opacity = '0';
        setTimeout(() => { cover.style.display = 'none'; r(); }, ms);
      }),
      sub: (text) => {
        if (ended) return;
        if (!text) { sub.classList.remove('is-on'); return; }
        sub.textContent = text;
        sub.classList.add('is-on');
      },
      subOff: () => sub.classList.remove('is-on'),
      cardIn: () => { card.style.display = 'flex'; requestAnimationFrame(() => { card.style.opacity = '1'; }); },
      cardOut: (ms = 500) => new Promise((r) => {
        card.style.opacity = '0';
        setTimeout(() => { card.style.display = 'none'; r(); }, ms);
      }),
      endIn: () => {
        ended = true;
        sub.classList.remove('is-on');
        end.style.display = 'flex';
        requestAnimationFrame(() => { end.style.opacity = '1'; });
      },
      cursor: (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; },
      ripple: (x, y) => {
        const r = document.createElement('div');
        r.className = 'v-ripple';
        r.style.transform = `translate(${x}px, ${y}px)`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 520);
      },
      reduce,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
