import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { fetchSourceConfigCached, DEFAULT_SOURCE } from './hips/meta.js';
import { HttpTileLoader } from './hips/loader.js';
import { TileScheduler, TileState, textureBytes } from './hips/scheduler.js';
import { visibleCapBySampling, selectTiles } from './hips/lod.js';
import { hpToRender, renderToHp } from './hips/healpix.js';
import { TileAtlas, TileLayer } from './hips/tiles.js';
import { openTileCache, clearTileCache, cacheEstimate } from './hips/cache.js';

import { createUI } from './ui/app.js';
import { createOverlays } from './scene/overlays.js';
import { PICK_RADIUS, pickLocal, occludedBySphere } from './geo/pick.js';
import { MOON_RADIUS_KM, dirFromLatLon, latLonFromDir, separationDeg } from './geo/coords.js';
import { northTangent, sampleLocalScale, dragRotateRadPerScreen } from './geo/metrics.js';
import { capAngleDeg, pickStep, STEP_LEVELS, poleLabels } from './geo/graticule.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#scene');
const isMobile = matchMedia('(max-width: 820px)').matches;

/**
 * 可复现的测试模式（供浏览器验收脚本使用，不影响正常访问）：
 *   ?spin=0            关闭自转
 *   ?d=1.35            固定相机距离（月球半径 = 1）
 *   ?lon=11.36&lat=-43.31  把镜头对准该经纬度
 *   ?detail=0|1        初始是否开启国内细节
 *   ?cal=0|1           初始是否开启亮度标定
 *   ?seg=1             显示分段耗时/统计到控制台
 *   ?ui=0              启动时不创建界面（对照帧率/请求量）
 *   ?ui=axis,grid      启动时开启指定辅助层（逗号分隔）
 *   ?immersive=1       启动即进入沉浸模式
 * 示例：index.html?spin=0&d=1.35&lon=-11.36&lat=-43.31
 */
const TEST = (() => {
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) ? Number(q.get(k)) : null);
  const flag = (k) => (q.has(k) ? q.get(k) !== '0' : null);
  return {
    active: ['spin', 'd', 'lon', 'lat', 'detail', 'cal', 'seg', 'ui', 'immersive', 'lock'].some((k) => q.has(k)),
    spin: flag('spin'), d: num('d'), lon: num('lon'), lat: num('lat'),
    detail: flag('detail'), cal: flag('cal'), seg: flag('seg'), lock: flag('lock'),
    ui: flag('ui'), immersive: flag('immersive'),
    layers: (q.get('ui') && q.get('ui') !== '0' ? q.get('ui') : (q.get('layers') || '')).split(',').filter(Boolean),
  };
})();

const state = {
  spin: TEST.spin === null ? true : TEST.spin,
  stars: true, earth: true, relief: 1.2,
  detail: TEST.detail === null ? true : TEST.detail,
  color: true,
  calibrate: TEST.cal === null ? true : TEST.cal,
  exposure: 1.05,
  phase: 104,
  quality: 'auto',
  spinSpeed: 1,
};

/* ============ 渲染器 / 场景 / 相机 ============ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearAlpha(0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 4000);
camera.position.set(0, 0.95, 9.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.rotateSpeed = 0.45;   // 初值；每帧由 updateRotateSpeed() 按缩放改写
controls.zoomSpeed = 0.75;
controls.minDistance = 1.02;
controls.maxDistance = 30;

/* ============ 月球：底图 + 彩色调制 + 国内 HiPS 细节瓦片 ============ */
const SEG = isMobile ? 192 : 512;
const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blank.needsUpdate = true;

const uni = {
  chromaMap: { value: blank },
  chromaAmt: { value: 0 },
};

const moonMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
moonMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, uni);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <map_pars_fragment>', [
      '#include <map_pars_fragment>',
      'uniform sampler2D chromaMap;',
      'uniform float chromaAmt;',
    ].join('\n'))
    .replace('#include <map_fragment>', [
      '#include <map_fragment>',
      '{',
      '  vec3 ch = texture2D(chromaMap, vMapUv).rgb;',
      '  float chL = dot(ch, vec3(0.2126, 0.7152, 0.0722));',
      '  vec3 tint = mix(vec3(1.0), ch / max(chL, 0.06), chromaAmt);',
      '  diffuseColor.rgb *= tint;',
      '}',
    ].join('\n'));
};
moonMat.customProgramCacheKey = () => 'moonhd-base-v1';

/**
 * 底图球半径略小于 1（瓦片层在半径 1 的球面上）。
 * 差值 3e-3 相对月球半径 1737.4 km 约 5 km，在画面上不可见，
 * 但足以避免两层同半径几何的 z-fighting——否则瓦片会被底图挡掉。
 */
const BASE_RADIUS = 0.997;

/**
 * 月球模型的**固定**朝向（不含自转累积量）。
 * 月相预设需要一个不随自转漂移的参考观察方向，下面的参考方位角由它解出。
 */
const MOON_BASE_YAW = -Math.PI / 2 + 0.3;
const MOON_BASE_ROLL = THREE.MathUtils.degToRad(1.5);

const moon = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS, SEG, SEG >> 1), moonMat);
moon.rotation.z = MOON_BASE_ROLL;
moon.rotation.y = MOON_BASE_YAW;
scene.add(moon);

/* ============ 光照 ============ */
/**
 * 太阳光强度。默认从 4.0 调到 1.4。
 *
 * 原因：ACES 色调映射在输入超过 ~1.0 后迅速饱和。实测（满月相位、曝光 1.05、
 * 近距离视角）色调映射前的线性亮度：中位 0.83、p90 1.76、最大 5.37，
 * **35.6% 的像素超过 1.0**，于是底图被压成一片白：
 *   sun=4.0 → 底图 84% 像素贴顶(≥254)、相邻像素梯度中位数 = 0（完全没有细节）
 *   sun=1.4 → 贴顶降到 12%、梯度中位数 9（细节恢复）
 * 这也正是"高清区域融不进整体画面"的主因——不是瓦片标定不准
 * （逐张与底图比值 0.96~1.00），而是整个场景过曝后一起变白。
 *
 * 改小后底图与瓦片仍然同步（同一套光照），两者贴顶比例接近（11.8% / 17.1%），
 * 过渡处不会出现亮度台阶。
 *
 * ⚠️ 本轮 UI 工作**没有改动这里的光照强度与太阳位置公式**，只改了界面上
 * "光照角度"的含义标注与预设映射：滑块值仍然是光源在 XZ 平面上的角度 a，
 * sun.position = (sin a, 0.10, −cos a)·80。以默认正面视角（相机在 +X）为例，
 * 可见亮面比例 = (1 + cos∠(sun, cam))/2 = (1 + sin a)/2：
 *   a = 90° → 满月 · a = 270° → 新月 · a = 0° → 上弦 · a = 180° → 下弦。
 * 旧界面上"0°=新月 · 180°=满月"的文字与实际画面不符，这里按实际画面更正。
 */
const sun = new THREE.DirectionalLight(0xfff6ea, 1.4);
scene.add(sun, sun.target);
const earthshine = new THREE.AmbientLight(0x35507a, 0.055);
scene.add(earthshine);

/* ============ 星空 ============ */
function makeStars(n) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2;
    const r = 600 + Math.random() * 900, s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(t);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(t);
    c.setHSL(0.56 + Math.random() * 0.1, 0.35 * Math.random(), 0.4 + Math.pow(Math.random(), 3) * 0.6);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
  return new THREE.Points(g, m);
}
const stars = makeStars(4200);
scene.add(stars);

/* ============ 底图贴图工具 ============ */
const loader = new THREE.TextureLoader();
function tune(tex, srgb) {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
async function loadTex(url, srgb, onp) {
  const report = typeof onp === 'function' ? onp : () => {};
  const res = await fetch(url);
  const total = Number(res.headers.get('content-length') || 0);
  let src = url, tmp = '';
  if (res.body && total > 0) {
    const rd = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const r = await rd.read();
      if (r.done) break;
      chunks.push(r.value); got += r.value.length;
      report(got / total);
    }
    tmp = URL.createObjectURL(new Blob(chunks));
    src = tmp;
  }
  const tex = await loader.loadAsync(src);
  if (tmp) URL.revokeObjectURL(tmp);
  return tune(tex, srgb);
}

/* ============ 国内 HiPS 细节层 ============ */
const HIPS = {
  concurrency: isMobile ? 3 : 4,
  memoryBudget: (isMobile ? 64 : 128) * 1024 * 1024,
  persistBudget: (isMobile ? 64 : 256) * 1024 * 1024,
  maxPages: isMobile ? 1 : 2,
  /**
   * 与本地 8K 底图的亮度标定（纯增益，不加偏移）。
   *
   * 嫦娥二号 DOM 与底图（LROC WAC 全球镶嵌）不是同一产品，绝对定标不同，
   * 不做标定会在细节层淡入时出现整屏亮度跳变。
   *
   * 增益在**渲染域**实测反解（ACES 非线性，不能直接取线性域比值）：
   * 同一机位（d=1.35、曝光 1.05、月面中心=Tycho）关掉细节层取底图均值为基准，
   * 再扫增益读瓦片均值，求两者相等的位置。
   *
   *   相位  底图均值   零交叉增益
   *   104     68.0        6.64      ← 应用默认相位
   *   150    152.8        8.73
   *   180    159.7        8.89
   *
   * 理想增益随月相漂移（ACES 在亮部压缩，底图被放大后又是模糊的，
   * 两者的方差不同），单一全局增益不可能同时命中。取 7.5 是**相对误差**的
   * 折中：相位 104 +8.0%、相位 150 −6.0%、相位 180 −6.4%，最大 8%。
   *
   * 注意这个值是修好配准之后重新标定的：之前瓦片盖在错误的半球上，
   * 那次标定（4.558 → 5.0）测的根本不是同一块地形。
   *
   * 逐张所需增益仍在 1.9~29 之间（见 calibration.json），所以标定后
   * 区域性的亮度差依然存在，不是无缝的。界面上"亮度标定"开关可对照关闭。
   */
  gain: 7.5,
  bias: 0,

  /* ---------------- 细节层的启用门槛（按屏幕覆盖，不用固定距离） ---------------- */

  /**
   * 细节层最多到 HiPS order 7（512px 瓦片 → 约 28 m/像素）。
   * 再往下每升一级瓦片数 ×4，收益递减而请求/显存开销陡增。
   */
  maxOrder: 7,

  /**
   * 门槛依据：**底图在屏幕上被放大到什么程度**（屏幕像素 / 底图纹素）。
   *
   * 为什么不用相机距离：同样距离下，窗口越大、DPR 越高，底图被放得越厉害，
   * 越需要细节。用"放大倍率"能同时覆盖屏幕尺寸与 DPR，且与分辨率无关。
   *
   * 取值来自实测（1306×598 视口、DPR 2，底图 8K）：
   *   整球视角（月球直径约占屏高 25%）→ 放大倍率 ≈ 0.84 → 不启用
   *   中距离 d=1.35（月球铺满屏）      → 放大倍率 ≈ 3.3  → 启用
   * 取 1.0 作进入阈值、0.8 作退出阈值（滞回，避免在阈值附近来回闪）。
   */
  enterMag: 1.0,
  exitMag: 0.8,
};

const hipsState = {
  ready: false,
  config: null,
  error: null,
  tiles: [],
  readyKeys: new Set(),
  pending: 0,
  centerOrder: 0,
  mix: 0,
  mixTarget: 0,
  lastSelect: 0,
  selectMs: 0,
  lastRequested: new Set(),
  bytes: 0,
  persistentBytes: 0,
  persistentCount: 0,
  slotStarved: 0,
  capRadiusDeg: null,
  /** 细节层当前是否启用（按底图放大倍率决定）。 */
  detailActive: false,
  /** 底图放大倍率：屏幕像素 / 底图纹素。 */
  baseMag: 0,
  /** 月球在屏幕上的直径（设备像素）。 */
  moonPx: 0,
};

let atlas = null;
let tileLayer = null;
let scheduler = null;
let tileLoader = null;
let persist = null;
/** 给瓦片层用的 LOLA 法线克隆（channel=1，按 uv1 采样）；可能晚于 tileLayer 建好。 */
let normalTex = null;

async function initHips() {
  try {
    const { props, config, fromCache, error: metaErr } = await fetchSourceConfigCached(DEFAULT_SOURCE);
    hipsState.config = config;
    setStatus();
    tileLoader = new HttpTileLoader(config, { timeoutMs: 25000 });
    atlas = new TileAtlas({ renderer, maxPages: HIPS.maxPages, mipmaps: !isMobile });
    tileLayer = new TileLayer({ renderer, atlas });
    tileLayer.createMaterial();
    // 法线贴图可能已经/还没加载完，两个方向都接一次（setNormalMap 会记住）
    if (normalTex) tileLayer.setNormalMap(normalTex, state.relief);
    tileLayer.setCalibration(state.calibrate ? HIPS.gain : 1, 0);
    /**
     * 必须挂在 moon 下面，不能挂在 scene 上。
     *
     * 瓦片几何是用 tilePointVec() 在**月球局部坐标**里生成的（半径 1.0，与底球同心），
     * 而 moon 自身带着固定的朝向（rotation.y = -π/2 + 0.3、rotation.z = 1.5°）
     * 以及自转。挂在 scene 上时瓦片不跟随这个朝向，几何落在错误的经度上，
     * 于是每张瓦片都背对相机、被 gl_FrontFacing 整块 discard——
     * 实测症状：draw call 有 58 次、三角形 26 万，但画面与关闭细节时**逐像素完全相同**。
     * 挂在 moon 下面后，瓦片与底球共享同一套朝向与自转。
     */
    moon.add(tileLayer.group);

    // 持久化缓存（IndexedDB）——失败不影响在线浏览
    persist = await openTileCache({ budget: HIPS.persistBudget, sourceId: config.id }).catch((e) => {
      console.warn('[moonhd] 持久化缓存不可用：', e && e.message);
      return null;
    });

    scheduler = new TileScheduler({
      loader: tileLoader,
      concurrency: HIPS.concurrency,
      memoryBudget: HIPS.memoryBudget,
      maxRetries: 3,
      retryBaseMs: 700,
      persistentGet: persist ? (order, npix) => persist.get(order, npix) : null,
      persistentPut: persist ? (order, npix, data) => persist.put(order, npix, data) : null,
    });

    hipsState.ready = true;
    setStatus();
    if (persist) updatePersistStats();
  } catch (e) {
    hipsState.error = e;
    console.error('[moonhd] HiPS 初始化失败：', e);
    setStatus();
  }
}

async function updatePersistStats() {
  if (!persist) return;
  try {
    const e = await cacheEstimate();
    hipsState.persistentBytes = e.usage || 0;
  } catch (err) { /* 忽略 */ }
}

function fmtBytes(b) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GiB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MiB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KiB';
  return b + ' B';
}

/** 相机在月球局部坐标的位置。 */
const _camLocal = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/**
 * 月球局部方向 → 屏幕像素（不可见返回 null）。
 *
 * 注意：输入是月球**局部**坐标，必须先经 moon.matrixWorld 变到世界空间才能投影；
 * 也不能拿它和 camera.position（世界空间）直接算距离——之前这个错误导致
 * 所有瓦片都被判为"不可见"，选不出任何瓦片。
 */
const _w = new THREE.Vector3();
function projectLocal(v) {
  _w.set(v[0], v[1], v[2]).applyMatrix4(moon.matrixWorld);
  // 可见性由 isVisible() 的地平线判定负责；这里只做投影，不再用 NDC z 过滤，
  // 否则球面在近距离下会被误判为"不可见"（实测导致选不出瓦片）。
  _w.project(camera);
  return [(_w.x * 0.5 + 0.5) * renderer.domElement.width, (-_w.y * 0.5 + 0.5) * renderer.domElement.height];
}

/**
 * 屏幕 NDC → 月球局部**方向**（从相机出发的单位向量）。
 *
 * 这里不用 Vector3.unproject：unproject 得到的是"近裁剪面上的一点"，
 * 再减相机位置会得到一个极短的向量，方向噪声很大（实测导致可视球冠塌缩、
 * 只选到 L2）。直接用相机基向量与视场角解析地构造射线，稳定且与渲染一致。
 *
 * 返回的是**渲染坐标系**方向；交给 LOD 之前必须经 renderToHp() 转到天文坐标系。
 */
const _rot = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();

function updateCameraBasis() {
  const e = camera.matrixWorld.elements;
  _right.set(e[0], e[1], e[2]).normalize();
  _up.set(e[4], e[5], e[6]).normalize();
  _fwd.set(-e[8], -e[9], -e[10]).normalize();
}

function unprojectLocal(nx, ny) {
  const th = Math.tan((camera.fov * Math.PI) / 360);
  _dir.copy(_fwd)
    .addScaledVector(_right, nx * th * camera.aspect)
    .addScaledVector(_up, ny * th)
    .normalize();
  // 转进月球局部系（月球只有旋转，用旋转部分即可）
  _dir.applyMatrix4(_rot).normalize();
  return [_dir.x, _dir.y, _dir.z];
}

/**
 * 把"相机 / 月球"的最新矩阵同步到一组复用的局部变量。
 *
 * 瓦片选择、拾取、标签投影都依赖它。以前只在 refreshTileSelection() 里更新，
 * 那是以 0.25 s 为周期；现在拾取与标签每帧都要用，所以提到每帧开头。
 * 一次 4×4 求逆 + 一次点变换，开销可忽略。
 */
function syncLocalFrame() {
  camera.updateMatrixWorld();
  moon.updateMatrixWorld(true);
  _inv.copy(moon.matrixWorld).invert();
  _rot.extractRotation(_inv);
  updateCameraBasis();
  _camLocal.copy(camera.position).applyMatrix4(_inv);
}

/* ---------------- 坐标系边界：渲染系 (y=极轴) ↔ 天文系 (z=极轴) ----------------
 *
 * lod.js / healpix.js 全程用天文坐标系（z = 极轴，见 healpix.js 里 hpToRender 的
 * 长篇说明）；而 three.js 这边（底图球、相机、moon.matrixWorld）用的是渲染坐标系
 * （y = 极轴）。两者相差绕 x 轴 90°，必须在**这一处**显式来回转换，
 * 否则瓦片层会整体错位到另一个半球——"8K 底图和放大后的区域对不上"。
 *
 * 三个转换点：
 *   1. 相机位置：渲染系 → 天文系（喂给 visibleCapBySampling / selectTiles）
 *   2. 反投影方向：渲染系 → 天文系（同上）
 *   3. 瓦片四角方向：天文系 → 渲染系（喂给 projectLocal 做屏幕投影）
 */
const _camHp = [0, 0, 0];
const _dirHp = [0, 0, 0];
const _vecRender = [0, 0, 0];

function unprojectHp(nx, ny) {
  const v = unprojectLocal(nx, ny);
  if (!v) return v;
  return renderToHp(v, _dirHp);
}

function projectFromHp(v) {
  return projectLocal(hpToRender(v, _vecRender));
}

/**
 * 量出"底图在屏幕上被放大了多少倍"：屏幕像素 / 底图纹素。
 *
 * 月球直径在球面上占 π 弧度；底图是等距圆柱 8192×4096，所以赤道方向
 * 每度有 baseW/360 个纹素。把月球的屏幕直径除以它覆盖的纹素数，
 * 就得到放大倍率。与窗口大小、DPR 都相关，因此不用固定相机距离。
 *
 * @returns {{moonPx:number, baseMag:number}}
 */
function measureBaseMagnification() {
  const H = renderer.domElement.height;
  const baseW = (moonMat.map && moonMat.map.image && moonMat.map.image.width) || 8192;

  // 月球在屏幕上的角半径 → 像素半径
  const d = camera.position.length();
  const sinA = Math.min(1, BASE_RADIUS / Math.max(1e-6, d));
  const angRad = Math.asin(sinA);                       // 视半径（弧度）
  const th = Math.tan((camera.fov * Math.PI) / 360);
  // 垂直方向：tan(视半径)/tan(半视场) 得到以半屏为单位的半径
  const rFracV = Math.tan(angRad) / th;
  const moonPxV = rFracV * (H / 2) * 2;                 // 垂直直径（像素）

  // 月球 180° 视角对应 baseW 个纹素（等距圆柱全宽 360°，月球占一半）
  const texelsAcross = baseW / 2;
  return { moonPx: moonPxV, baseMag: moonPxV / texelsAcross };
}

/**
 * 是否启用细节层：带滞回的门槛判断。
 * 进入用 enterMag、退出用 exitMag，避免在阈值附近反复开关导致闪烁。
 */
function updateDetailGate() {
  const { moonPx, baseMag } = measureBaseMagnification();
  hipsState.moonPx = moonPx;
  hipsState.baseMag = baseMag;
  const was = hipsState.detailActive;
  if (!was && baseMag >= HIPS.enterMag) hipsState.detailActive = true;
  else if (was && baseMag < HIPS.exitMag) hipsState.detailActive = false;
  return hipsState.detailActive !== was;
}

function refreshTileSelection(now) {
  if (!hipsState.ready) return;
  const t0 = performance.now();
  syncLocalFrame();

  /**
   * 整球视角只显示底图：不选瓦片、不发请求。
   * 判定依据是底图放大倍率（见 measureBaseMagnification），
   * 因此窗口尺寸与 DPR 变化都会自动反映进来。
   */
  const gateChanged = updateDetailGate();
  if (!hipsState.detailActive) {
    if (gateChanged || hipsState.tiles.length) {
      // 退出细节：释放槽位与几何，回到纯底图
      for (const k of [...atlas.slotOf.keys()]) atlas.release(k);
      scheduler.cancel(new Set(hipsState.lastRequested));
      hipsState.tiles = [];
      hipsState.readyKeys = new Set();
      hipsState.lastRequested = new Set();
      hipsState.pending = 0;
      hipsState.centerOrder = 0;
      scheduler.setPinned(new Set());
    }
    hipsState.selectMs = performance.now() - t0;
    return;
  }

  const cap = visibleCapBySampling(
    renderToHp([_camLocal.x, _camLocal.y, _camLocal.z], _camHp),
    unprojectHp,
  );
  const sel = selectTiles({
    camLocal: _camHp,
    project: projectFromHp,
    screenW: renderer.domElement.width,
    screenH: renderer.domElement.height,
    // 上限取"数据源层级"与"HIPS.maxOrder（order 7 ≈ 28 m/px）"的较小者
    orderMax: Math.min(hipsState.config.orderMax, HIPS.maxOrder),
    cap,
  });
  hipsState.selectMs = performance.now() - t0;
  hipsState.tiles = sel.tiles;
  hipsState.centerOrder = sel.maxOrder;
  hipsState.capRadiusDeg = sel.capRadiusDeg;

  // 分配图集槽位 + 提交请求
  //
  // 顺序很重要：先把"已经解码好、但还没进图集"的瓦片槽位占住并上传，
  // 再为真正缺的瓦片排队。否则在自转/缩放导致瓦片集合频繁变化时，
  // 会出现"槽位被反复释放又分配、几何永远建不起来"的空转。
  const want = new Set();
  const readyKeys = new Set();
  for (const t of sel.tiles) {
    const key = t.order + '/' + t.npix;
    want.add(key);
    const entry = scheduler.peek(t.order, t.npix);
    const decoded = !!(entry && entry.state === TileState.READY && entry.image);
    const slot = atlas.allocate(key);
    if (!slot) { hipsState.slotStarved++; continue; }
    if (decoded) {
      if (atlas.upload(key, entry.image)) readyKeys.add(key);
      else readyKeys.add(key);
      continue;
    }
    if (hipsState.readyKeys.has(key)) readyKeys.add(key);
    scheduler.request(t.order, t.npix, t.priority);
  }
  // 取消不再需要的请求，释放不再显示的槽位
  const stale = new Set();
  for (const k of hipsState.lastRequested) if (!want.has(k)) stale.add(k);
  if (stale.size) scheduler.cancel(stale);
  for (const k of [...atlas.slotOf.keys()]) if (!want.has(k)) atlas.release(k);

  hipsState.lastRequested = want;
  hipsState.readyKeys = readyKeys;
  hipsState.pending = want.size - readyKeys.size;

  /**
   * 保护当前画面正在用的瓦片不被 LRU 淘汰。
   *
   * 之前 setPinned() 定义了却从未调用，pinned 集合恒为空，
   * 于是 LRU 会把**正在显示**的瓦片也淘汰掉；下一帧它又被选中、
   * 只能重新走一遍"请求→解码→上传"（实测 evictions=194 / requests=274，
   * 大量重复取图与解码）。
   */
  scheduler.setPinned(want);
}

/** 把已解码的瓦片画进图集（选视野之间到达的瓦片，不必等下一次选择）。 */
function uploadReadyTiles() {
  if (!hipsState.ready) return;
  for (const t of hipsState.tiles) {
    const key = t.order + '/' + t.npix;
    if (hipsState.readyKeys.has(key)) continue;
    if (!atlas.slotOf.has(key)) continue;
    const entry = scheduler.peek(t.order, t.npix);
    if (!entry || entry.state !== TileState.READY || !entry.image) continue;
    if (atlas.upload(key, entry.image)) hipsState.readyKeys.add(key);
  }
}

/* ============ 画质档位 ============ */
let baseRes = 1024;
let upgrading = false;
/** 升清失败原因；非空时状态栏要如实报出来，不能假装是 8K。 */
let upgradeError = null;

const QUALITY_KEY = 'luna.ui.quality';

function pickQuality() {
  const f = new URLSearchParams(location.search).get('q');
  if (f) return Number(f);
  if (state.quality === 'auto') return isMobile ? 2048 : 8192;
  return Number(state.quality);
}

/** 记住用户显式选择的底图档位，重开页面不会被"自动"改回小图。 */
function saveQuality(q) {
  try { localStorage.setItem(QUALITY_KEY, String(q)); } catch (e) { /* 隐私模式忽略 */ }
}
function loadQuality() {
  try { return localStorage.getItem(QUALITY_KEY) || null; } catch (e) { return null; }
}
async function upgrade(q, onp) {
  const tex = await loadTex('assets/moon_albedo_' + q / 1024 + 'k.webp', true, onp);
  const old = moonMat.map;
  moonMat.map = tex;
  moonMat.needsUpdate = true;
  if (old) old.dispose();
  baseRes = q;
  setStatus();
}

/** 运行时切换底图画质：只加载目标档位，不改变 LOD 与缓存策略，也不需要刷新页面。 */
async function setQuality(q) {
  state.quality = q === 'auto' || q == null ? 'auto' : String(q);
  saveQuality(state.quality);
  const target = pickQuality();
  if (target === baseRes) { setStatus(); return; }
  if (upgrading) return;
  upgrading = true;
  setStatus('正在切换到 ' + target / 1024 + 'K 底图…');
  const bar = $('#load-bar');
  try {
    await upgrade(target, (p) => { if (bar) bar.style.width = p * 100 + '%'; });
    setStatus();
  } catch (e) {
    console.warn('[moonhd] 画质切换失败：', e);
    setStatus('底图档位切换失败');
  }
  upgrading = false;
}

/* ============ 三维辅助层 ============ */
const overlays = createOverlays({ moon });

/* ============ 局部坐标系下的拾取 / 投影 ============ */
let hoverCoord = null;
let centerCoord = null;

/**
 * 画布 CSS 尺寸缓存。
 *
 * 标签一趟要投影几十个点，如果每个点都调 getBoundingClientRect()，
 * 一秒就是上千次强制布局。这里每趟只读一次。
 */
const viewRect = { width: 1, height: 1, left: 0, top: 0 };
function refreshViewRect() {
  const r = renderer.domElement.getBoundingClientRect();
  viewRect.width = r.width; viewRect.height = r.height;
  viewRect.left = r.left; viewRect.top = r.top;
}

/** NDC → 月面交点（月球局部系）。 */
function pickNDC(nx, ny) {
  const dir = unprojectLocal(nx, ny);
  if (!dir) return null;
  return pickLocal([_camLocal.x, _camLocal.y, _camLocal.z], dir, PICK_RADIUS);
}

/** 画布 CSS 尺寸下的月球中心与视半径（用于标签剔除）。 */
function moonScreen() {
  _w.set(0, 0, 0).applyMatrix4(moon.matrixWorld).project(camera);
  const cx = (_w.x * 0.5 + 0.5) * viewRect.width;
  const cy = (-_w.y * 0.5 + 0.5) * viewRect.height;
  const d = camera.position.length();
  const ang = Math.asin(Math.min(1, BASE_RADIUS / Math.max(1e-6, d)));
  const th = Math.tan((camera.fov * Math.PI) / 360);
  const r = (Math.tan(ang) / th) * (viewRect.height / 2);
  return { cx, cy, r, w: viewRect.width, h: viewRect.height };
}

/**
 * 月球局部点 → 画布 CSS 像素 + 遮挡判定。
 * @returns {{x:number,y:number,onScreen:boolean,occluded:boolean}}
 */
function projectPoint(local) {
  const occluded = occludedBySphere([_camLocal.x, _camLocal.y, _camLocal.z], local, PICK_RADIUS);
  _w.set(local[0], local[1], local[2]).applyMatrix4(moon.matrixWorld).project(camera);
  const x = (_w.x * 0.5 + 0.5) * viewRect.width;
  const y = (-_w.y * 0.5 + 0.5) * viewRect.height;
  return {
    x, y, occluded,
    onScreen: _w.z > -1 && _w.z < 1
      && x >= -40 && x <= viewRect.width + 40
      && y >= -30 && y <= viewRect.height + 30,
  };
}

/** 经纬度 → 局部点（略微抬高，避免标签贴在球面上被裁掉）。 */
function localOfLatLon(lat, lon, lift = 0.002) {
  const d = dirFromLatLon(lat, lon, [0, 0, 0]);
  const k = 1 + lift;
  return [d[0] * k, d[1] * k, d[2] * k];
}

/* ============ 相机飞行 ============ */
const flight = {
  active: false, t: 0, dur: 0.78,
  from: new THREE.Vector3(), to: new THREE.Vector3(),
  spinHold: false,
};
let spinHoldUntil = 0;

function pauseSpin(seconds) {
  spinHoldUntil = Math.max(spinHoldUntil, performance.now() / 1000 + seconds);
}
const spinRunning = () => state.spin && performance.now() / 1000 >= spinHoldUntil;

function defaultViewDistance() { return 5.25; }

function cancelFlight() {
  if (!flight.active) return;
  flight.active = false;
  controls.enabled = true;
}

/**
 * 平滑飞到月固经纬度上方。
 * 飞行期间暂停自转；用户 pointerdown 会取消飞行（不吞掉这次操作）。
 */
function flyTo(lat, lon, { distance = null, duration = 0.78 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  intro = 1;
  // 月球自身带固定朝向（rotation.y/z）与自转，必须先把世界矩阵刷新到最新，
  // 否则在首帧之前调用会读到单位矩阵，把相机放到错误的经度上。
  moon.updateMatrixWorld(true);
  const dirWorld = new THREE.Vector3(...dirFromLatLon(lat, lon, [0, 0, 0]))
    .applyMatrix4(new THREE.Matrix4().extractRotation(moon.matrixWorld))
    .normalize();
  const d = THREE.MathUtils.clamp(
    distance == null ? camera.position.length() : distance,
    controls.minDistance + 0.02, controls.maxDistance,
  );
  flight.from.copy(camera.position);
  flight.to.copy(dirWorld).multiplyScalar(d);
  flight.t = 0;
  flight.dur = Math.max(0.12, duration);
  flight.active = true;
  controls.enabled = false;
  pauseSpin(flight.dur + 0.4);
}

function resetView({ duration = 0.86 } = {}) {
  flyTo(0, 0, { distance: defaultViewDistance(), duration });
}

function zoomBy(factor) {
  const d = THREE.MathUtils.clamp(
    camera.position.length() * factor, controls.minDistance + 0.02, controls.maxDistance,
  );
  const dir = camera.position.clone().normalize();
  flight.from.copy(camera.position);
  flight.to.copy(dir).multiplyScalar(d);
  flight.t = 0;
  flight.dur = 0.22;
  flight.active = true;
  controls.enabled = false;
}

/**
 * 拖拽旋转速度随缩放变化——"抓住月面"的规律。
 *
 * OrbitControls 的转角是固定角速度：`angle = 2π·dx·rotateSpeed / clientHeight`，
 * 与相机远近无关。整球视角下这没问题，但贴到最近（d=1.02）时屏幕上只有约 19 km
 * 月面，同样一次拖拽却仍然转 162°，于是"拖一点就飘到别的地方去"。
 *
 * 正确的映射是让月面**跟着指针走**：相机绕月球转 δ 时，视中心那块月面沿球面移动
 * δ·R；而屏幕在视中心处的深度是 (d−1)，满屏高度对应 (d−1)·2·tan(fov/2) 个世界单位。
 * 两者相除，一屏拖拽应转的角度恰好是
 *
 *     θ_screen = 2·(d−1)·tan(fov/2)          （弧度）
 *
 * 这个取法在任意距离下都给出 1:1 的跟随（不是近似）：
 *   拖 Δpx → 月面移动 Δpx 像素。整球 d=5.25 时 θ_screen≈130°，
 *   与原来的固定手感接近；d=1.35 时约 10.7°；d=1.02 时约 0.61°。
 *
 * 下限是为了不出现"贴到最近就转不动"：d < 1.04 之后不再继续变慢，
 * 满屏拖拽保底 1.2°（此时月面会比指针快约 2 倍，仍属可控微调）。
 */
const ROTATE_FLOOR_RAD = 1.2 * (Math.PI / 180);
const ROTATE_SPEED_MAX = 0.45;   // 与历史手感一致的上限
const ROTATE_SPEED_MIN = 0.002;
function updateRotateSpeed() {
  const perScreen = dragRotateRadPerScreen(camera.position.length(), camera.fov, ROTATE_FLOOR_RAD);
  // OrbitControls 满屏拖拽转 2π·rotateSpeed，所以这里反解 rotateSpeed
  controls.rotateSpeed = THREE.MathUtils.clamp(
    perScreen / (2 * Math.PI), ROTATE_SPEED_MIN, ROTATE_SPEED_MAX,
  );
}

function stepFlight(dt) {
  if (!flight.active) return;
  flight.t += dt;
  let k = Math.min(1, flight.t / flight.dur);
  k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
  camera.position.lerpVectors(flight.from, flight.to, k);
  camera.lookAt(0, 0, 0);
  if (flight.t >= flight.dur) {
    flight.active = false;
    controls.enabled = true;
    controls.update();
  }
}

/* ============ 标签（三维投影 → DOM） ============ */
let markerPlaces = [];
let gridAnchor = { lat: 999, lon: 999 };

function setMarkerPlaces(list) {
  markerPlaces = Array.isArray(list) ? list.filter((p) => Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg)) : [];
}

/**
 * 计算这一趟要显示的标签。
 *
 * 规则：
 *  - 选中点始终显示；
 *  - 每个收录地点的球面圆点始终显示（属于"地名与选点标记"这一可见性分组）；
 *    文字只给距离视野中心最近的前若干个，避免整球时糊成一片；
 *  - 极点标签只在"自转轴 + 极点标注"都开启时出现；
 *  - 经纬网坐标标签由 buildGraticule 每根线给一个、锚在朝向相机的一侧。
 * 所有标签都必须通过"是否被月球挡住"的判定，背面不透出。
 */
function computeLabels() {
  const out = [];
  const vis = overlays.state;
  refreshViewRect();
  const scr = moonScreen();

  if (selectedPoint && vis.markers) {
    const p = projectPoint(localOfLatLon(selectedPoint.lat, selectedPoint.lon, 0.004));
    if (p.onScreen && !p.occluded) {
      out.push({ id: 'sel', kind: 'point', x: p.x, y: p.y, text: '选中点', active: true, priority: 0 });
    }
  }

  if (vis.markers && markerPlaces.length) {
    const cand = [];
    for (const pl of markerPlaces) {
      const p = projectPoint(localOfLatLon(pl.latDeg, pl.lonDeg, 0.0025));
      if (!p.onScreen || p.occluded) continue;
      cand.push({ pl, p, dist: Math.hypot(p.x - scr.cx, p.y - scr.cy), active: pl.id === selectedId });
    }
    cand.sort((a, b) => a.dist - b.dist);
    const labelBudget = camera.position.length() > 3.2 ? 4 : 8;
    let used = 0;
    for (const c of cand) {
      const withText = c.active || used < labelBudget;
      if (withText && !c.active) used++;
      out.push({
        id: 'place:' + c.pl.id,
        kind: 'place',
        x: c.p.x,
        y: c.p.y,
        text: withText ? (c.pl.nameZh || c.pl.name) : '',
        active: c.active,
        priority: 1,
      });
    }
  }

  if (vis.axis && vis.poles) {
    for (const pole of poleLabels(1.03)) {
      const p = projectPoint(pole.pos);
      if (!p.onScreen || p.occluded) continue;
      out.push({ id: 'pole:' + pole.text, kind: 'pole', x: p.x, y: p.y, text: pole.text, priority: 3 });
    }
  }

  if (vis.grid && vis.gridLabels) {
    for (const l of overlays.gridLabels) {
      const p = projectPoint(localOfLatLon(l.lat, l.lon, 0.004));
      if (!p.onScreen || p.occluded) continue;
      out.push({ id: `grid:${l.kind}:${l.text}`, kind: 'grid', x: p.x, y: p.y, text: l.text, priority: 4 });
    }
  }
  return out;
}

/* ============ UI 桥接 ============ */
let ui = null;
/** 当前选中的收录地点 id（由 UI 通知）；选点则是任意月面位置。 */
let selectedId = null;
let selectedPoint = null;

const api = {
  /* 视图 */
  flyTo,
  resetView,
  zoom: zoomBy,
  distance: () => camera.position.length(),
  /* 坐标 */
  centerCoord: () => centerCoord,
  hoverCoord: () => hoverCoord,
  separationKm: (lat1, lon1, lat2, lon2) => separationDeg(lat1, lon1, lat2, lon2) * (Math.PI / 180) * MOON_RADIUS_KM,
  northAngle,
  localScale,
  /* 设置 */
  setting: (k) => state[k],
  setSetting(k, v) { applySetting(k, v); },
  setExposure(v) { state.exposure = Number(v); renderer.toneMappingExposure = state.exposure; },
  setRelief(v) {
    state.relief = Number(v);
    moonMat.normalScale.set(state.relief, state.relief);
    if (tileLayer) tileLayer.setNormalScale(state.relief);
  },
  setPhase(v, opts) { setPhase(Number(v), opts); },
  phaseRatioText,
  /** 参考视角下与四个预设名称对应的光照角度（由模型固定朝向解出）。 */
  phasePresets: () => ({ ...PHASE_PRESETS }),
  setQuality,
  setSpinSpeed(v) { state.spinSpeed = Number(v); },
  gridStep: () => overlays.gridStep || STEP_LEVELS[0],
  resetDefaults() {
    applySetting('stars', true); applySetting('earth', true); applySetting('color', true);
    applySetting('detail', true); applySetting('calibrate', true); applySetting('spin', true);
    state.exposure = 1.05; renderer.toneMappingExposure = 1.05;
    state.relief = 1.2; api.setRelief(1.2);
    setPhase(104);
    state.spinSpeed = 1;
  },
  /* 运行数据 */
  stats,
  clearCache: async () => {
    const n = await clearTileCache().catch(() => 0);
    await updatePersistStats();
    return n;
  },
  /* 覆盖层 */
  overlays: {
    setAxis: (on) => overlays.setAxis(on),
    setPoles: (on) => overlays.setPoles(on),
    setGrid: (on) => overlays.setGrid(on),
    setGridLabels: (on) => overlays.setGridLabels(on),
    setMarkers: (on) => overlays.setMarkers(on),
  },
  setMarkerPlaces,
  /** 经纬度 → 画布 CSS 像素（验收脚本与调试用；与标签用的是同一条投影路径）。 */
  projectLatLon: (lat, lon, lift = 0.0025) => {
    syncLocalFrame();
    refreshViewRect();
    const p = projectPoint(localOfLatLon(lat, lon, lift));
    return { x: p.x, y: p.y, onScreen: p.onScreen, occluded: p.occluded };
  },
  /** 画布 CSS 像素 → 月面经纬度（验收脚本用；与点击走同一条拾取路径）。 */
  pickAtScreen: (x, y) => {
    syncLocalFrame();
    refreshViewRect();
    const nx = (x / viewRect.width) * 2 - 1;
    const ny = -(y / viewRect.height) * 2 + 1;
    const hit = pickNDC(nx, ny);
    return hit ? { lat: hit.lat, lon: hit.lon } : null;
  },
  /** UI 通知当前选中的收录地点（用于标签高亮）。 */
  setSelected(id) { selectedId = id || null; if (!id) selectedPoint = null; },
  /** UI 清空选点。 */
  clearPoint() { selectedPoint = null; },
  lastGestureWasDrag: () => lastGesture.dragged,
  /** 当前拖拽旋转灵敏度（验收脚本用）。 */
  rotateInfo: () => {
    const d = camera.position.length();
    return {
      distance: d,
      rotateSpeed: controls.rotateSpeed,
      degPerScreen: (2 * Math.PI * controls.rotateSpeed * 180) / Math.PI,
      grabDegPerScreen: (2 * Math.max(0, d - 1) * Math.tan((camera.fov * Math.PI) / 360) * 180) / Math.PI,
    };
  },
};

/* ============ 屏幕方向与比例尺 ============ */
function northAngle() {
  if (!centerCoord) return null;
  const t = northTangent(centerCoord.lat, centerCoord.lon);
  if (!t) return null;
  const base = localOfLatLon(centerCoord.lat, centerCoord.lon, 0.002);
  const tip = [base[0] + t[0] * 0.02, base[1] + t[1] * 0.02, base[2] + t[2] * 0.02];
  const a = projectPoint(base);
  const b = projectPoint(tip);
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 0.6) return null;      // 退化视角（正对极点）：隐藏方向指示
  return Math.atan2(dx, -dy) * 180 / Math.PI;     // 0 = 屏幕正上方，顺时针为正
}

function localScale() {
  const rect = renderer.domElement.getBoundingClientRect();
  return sampleLocalScale({
    screenW: rect.width,
    pickAt: (nx, ny) => {
      const hit = pickNDC(nx, ny);
      return hit ? { lat: hit.lat, lon: hit.lon } : null;
    },
  });
}

/* ============ 运行状态 ============ */
let lastFps = 0;

function statusInfo() {
  if (upgradeError) return { text: `${baseRes / 1024}K 底图 · 升清失败`, dot: '#D98C7A' };
  if (hipsState.error) return { text: '暂用底图 · 高清不可用', dot: '#D98C7A' };
  if (!hipsState.ready) return { text: `${baseRes / 1024}K 底图 · 高清连接中…`, dot: '#979CA3' };
  if (!state.detail) return { text: `${baseRes / 1024}K 底图 · 高清已关闭`, dot: '#979CA3' };
  if (!hipsState.detailActive) return { text: `${baseRes / 1024}K 底图 · 高清待命`, dot: '#C8AA73' };
  // 用**当前**这一帧的缺图数量，而不是上一次选择时的快照，
  // 否则瓦片都到齐了状态栏还显示"加载中"。
  if (pendingNow() > 0) return { text: `高清加载中 · L${hipsState.centerOrder}`, dot: '#979CA3' };
  return { text: `高清已就绪 · L${hipsState.centerOrder}`, dot: '#C8AA73' };
}

/** 当前视野里还没就绪的瓦片数。 */
function pendingNow() {
  return Math.max(0, hipsState.tiles.length - hipsState.readyKeys.size);
}

function setStatus(override) {
  const n = $('#status-imagery');
  if (!n) return;
  const s = statusInfo();
  n.textContent = override || s.text;
  n.title = `底图 ${baseRes} × ${baseRes / 2}`
    + (upgradeError ? `\n升清中断：${upgradeError}` : '')
    + (hipsState.config ? `\n高清源：${hipsState.config.label}` : '\n高清源：未连接');
  const d = $('#status-dot');
  if (d) d.style.background = s.dot;
}

function stats() {
  const st = scheduler ? scheduler.getStats() : null;
  const s = statusInfo();
  const maxOrder = Math.min(hipsState.config ? hipsState.config.orderMax : HIPS.maxOrder, HIPS.maxOrder);
  return {
    fps: lastFps,
    baseRes,
    detailToggle: state.detail,
    detailActive: hipsState.detailActive,
    order: hipsState.centerOrder,
    maxOrder,
    metersPerPx: Math.round(28 * 2 ** (7 - maxOrder)),
    tiles: hipsState.tiles.length,
    ready: hipsState.readyKeys.size,
    pending: pendingNow(),
    bytes: st ? st.bytes : 0,
    bytesText: fmtBytes(st ? st.bytes : 0),
    memBudgetText: fmtBytes(HIPS.memoryBudget),
    persistent: !!persist,
    persistBytesText: fmtBytes(hipsState.persistentBytes),
    persistBudgetText: fmtBytes(HIPS.persistBudget),
    requests: st ? st.requests : 0,
    memoryHits: st ? st.memoryHits : 0,
    persistentHits: st ? st.persistentHits : 0,
    errors: st ? st.errors : 0,
    evictions: st ? st.evictions : 0,
    queued: st ? st.queued : 0,
    inflight: st ? st.inflight : 0,
    capRadiusDeg: hipsState.capRadiusDeg,
    selectMs: hipsState.selectMs,
    autoIsMobile: isMobile,
    qualityChoice: state.quality,
    upgradeError,
    statusText: s.text,
    dotColor: s.dot,
    sourceLabel: hipsState.config ? hipsState.config.label : null,
    sourceTitle: hipsState.config ? hipsState.config.title : null,
    baseMag: hipsState.baseMag,
  };
}

/* ============ 设置应用 ============ */
function applySetting(k, v) {
  const on = !!v;
  switch (k) {
    case 'spin': state.spin = on; break;
    case 'stars': state.stars = on; break;
    case 'earth': state.earth = on; break;
    case 'detail': state.detail = on; break;
    case 'color': state.color = on; uni.chromaAmt.value = on ? 0.7 : 0; break;
    case 'calibrate':
      state.calibrate = on;
      if (tileLayer) tileLayer.setCalibration(on ? HIPS.gain : 1, 0);
      break;
    default: break;
  }
  if (ui) ui.syncSwitches();
}

/* ============ 月相 / 光照方向 ============ */
/** 参考观察方向（正面 0°N·0°E 的相机方向）与屏幕右方向，都在世界系。 */
const _phaseC = new THREE.Vector3(1, 0, 0)
  .applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, MOON_BASE_YAW, MOON_BASE_ROLL, 'XYZ')))
  .normalize();
const _phaseRight = new THREE.Vector3()
  .crossVectors(_phaseC.clone().negate(), new THREE.Vector3(0, 1, 0))
  .normalize();

/**
 * 光照角度 → 世界系太阳方向。
 *
 * ⚠️ 公式与历史版本**完全一致**，没有改动渲染：sun = normalize(sin a, 0.10, −cos a)。
 * 用户已认可的默认画面依赖这个式子，所以本轮只改界面标注与预设映射，
 * 不动光源位置。
 *
 * "光照角度"是光源在场景 XZ 平面上的角度，**不是**天文相位角。以参考观察方向
 * c 为准，可见亮面比例 = (1 + s·c)/2。把 c 的方位角记为 φ，则
 *   满月 a = 180° − φ 、新月 a = 360° − φ 、上弦 a = 90° − φ 、下弦 a = 270° − φ 。
 * 当前模型 φ = atan2(c.x, c.z) ≈ 17.19°，于是四个预设是 162.8 / 342.8 / 72.8 / 252.8°；
 * 预设按实测标定，"新月/上弦/满月/下弦"与参考视角下真正看到的画面一致。
 * 旧界面写"0°=新月 · 180°=满月"，与画面不符（实测 0° 是 3%、180° 是 98%），已更正。
 *
 * 默认 104° → 可见亮面约 76%，与设计稿 01 的月球背景一致。
 */
const PHASE_REF_AZIMUTH = Math.atan2(_phaseC.x, _phaseC.z) * (180 / Math.PI);
const PHASE_PRESETS = {
  full: (180 - PHASE_REF_AZIMUTH + 360) % 360,
  new: (360 - PHASE_REF_AZIMUTH + 360) % 360,
  first: (90 - PHASE_REF_AZIMUTH + 360) % 360,
  last: (270 - PHASE_REF_AZIMUTH + 360) % 360,
};

function sunDirectionFor(deg, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(deg);
  return out.set(Math.sin(a), 0.10, -Math.cos(a)).normalize();
}

function setPhase(deg, { goToReferenceView = false } = {}) {
  state.phase = deg;
  sunDirectionFor(deg, sun.position).multiplyScalar(80);
  if (goToReferenceView) {
    flyTo(0, 0, {
      distance: Math.max(camera.position.length(), defaultViewDistance() * 0.85),
      duration: 0.86,
    });
  }
}

/**
 * 可见亮面比例：按**当前相机方向**与光源方向的实际夹角计算，
 * fraction = (1 + cos∠(sun, cam)) / 2。这是半球近似，会随镜头变化；
 * 旧界面用的是 (1 − cos 滑块值)/2，没有考虑镜头方向，所以不能拿来当观测值。
 */
function phaseRatioText(deg = null) {
  const s = sunDirectionFor(deg == null ? state.phase : Number(deg), new THREE.Vector3());
  const c = camera.position.clone().normalize();
  const f = (1 + s.dot(c)) / 2;
  return `${Math.round(f * 100)}%`;
}

/* ============ 指针交互：拖拽 / 选点 / 指向坐标 ============ */
const lastGesture = { dragged: false, x: 0, y: 0, t: 0 };
let activePointers = 0;
let hoverAt = 0;

function ndcOf(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
}

canvas.addEventListener('pointerdown', (e) => {
  activePointers++;
  if (flight.active) cancelFlight();
  if (activePointers > 1) { lastGesture.dragged = true; return; }
  lastGesture.dragged = false;
  lastGesture.x = e.clientX;
  lastGesture.y = e.clientY;
  lastGesture.t = performance.now();
  pauseSpin(1.4);
}, { passive: true });

canvas.addEventListener('pointermove', (e) => {
  if (activePointers > 0) {
    if (Math.hypot(e.clientX - lastGesture.x, e.clientY - lastGesture.y) > 5) {
      if (!lastGesture.dragged) pauseSpin(1.6);
      lastGesture.dragged = true;
    }
    if (lastGesture.dragged) { hoverCoord = null; return; }
  }
  const now = performance.now();
  if (now - hoverAt < 50) return;      // 约 20 Hz
  hoverAt = now;
  syncLocalFrame();
  const [nx, ny] = ndcOf(e);
  const hit = pickNDC(nx, ny);
  hoverCoord = hit ? { lat: hit.lat, lon: hit.lon } : null;
}, { passive: true });

canvas.addEventListener('pointerup', (e) => {
  activePointers = Math.max(0, activePointers - 1);
  if (lastGesture.dragged || e.button !== 0) { lastGesture.dragged = false; return; }
  syncLocalFrame();
  const [nx, ny] = ndcOf(e);
  const hit = pickNDC(nx, ny);
  if (hit) {
    selectedId = null;
    selectedPoint = { lat: hit.lat, lon: hit.lon, matchedName: null };
    if (ui) ui.onPickPoint({ lat: hit.lat, lon: hit.lon });
  }
}, { passive: true });

canvas.addEventListener('pointercancel', () => {
  activePointers = Math.max(0, activePointers - 1);
  lastGesture.dragged = false;
}, { passive: true });

canvas.addEventListener('pointerleave', () => { hoverCoord = null; }, { passive: true });

canvas.addEventListener('dblclick', (e) => {
  syncLocalFrame();
  const [nx, ny] = ndcOf(e);
  const hit = pickNDC(nx, ny);
  if (hit) flyTo(hit.lat, hit.lon, { distance: Math.max(controls.minDistance + 0.05, camera.position.length() * 0.62) });
});

/* ============ 启动 ============ */
let uiEnabled = TEST.ui !== false;
let intro = isMobile ? 1 : 0;
const clock = new THREE.Clock();
let fpsN = 0, fpsT = 0;

(async function boot() {
  // 画质优先级：?q= > 上次显式选择 > 自动
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam) state.quality = qParam;
  else { const saved = loadQuality(); if (saved) state.quality = saved; }

  // 光照必须在这里初始化一次：旧代码靠 bind('phase') 在绑定时调用 setPhase 顺带设好，
  // 现在滑块由 UI 模块接管，不初始化的话太阳会停在上方默认位置 (0,1,0)，
  // 整个月球的明暗分布就与设计稿不一致（实测默认视角下亮度分布明显偏暗）。
  setPhase(state.phase);

  const bar = $('#load-bar');
  const loading = $('#loading');
  const dropLoading = () => {
    if (!loading) return;
    loading.classList.add('is-done');
    setTimeout(() => { loading.style.display = 'none'; }, 900);
  };
  /**
   * 底图首帧失败也必须放行：旧写法里 boot 一旦在 await 上抛错，
   * 全屏 loading 遮罩就永远留在页面上，用户看到的是"旋转缩放全坏了"。
   */
  try {
    moonMat.map = await loadTex('assets/moon_albedo_1k.webp', true, (p) => { if (bar) bar.style.width = p * 25 + '%'; });
    moonMat.needsUpdate = true;
    baseRes = 1024;
    dropLoading();
  } catch (e) {
    console.error('[moonhd] 底图加载失败：', e);
    dropLoading();
    if (ui) ui.toast('底图加载失败，请检查网络后刷新', true);
    setStatus('底图加载失败');
    return;
  }

  // UI 先接上，让用户能立刻操作；升清在后台继续
  if (uiEnabled) {
    ui = createUI(api);
    ui.init();
  } else {
    for (const id of ['#ui-topbar', '#ui-catalog', '#ui-rightcol', '#ui-toolbar', '#ui-coordbar', '#ui-zoomtools']) {
      const n = $(id); if (n) n.hidden = true;
    }
  }

  renderer.setAnimationLoop(frame);

  // 彩色调制层（LROC WAC 彩色合成，极区已填充）
  loadTex('assets/moon_chroma_1k.webp', true, () => {}).then((t) => {
    uni.chromaMap.value = t;
    uni.chromaAmt.value = state.color ? 0.7 : 0;
  }).catch(() => { applySetting('color', false); });

  // 地形法线（LOLA 高程）——高清影像是影像，不因此获得高清地形
  loadTex('assets/moon_normal_' + (isMobile ? '2048' : '5760') + '.webp', false, () => {}).then((t) => {
    moonMat.normalMap = t;
    moonMat.normalScale.set(state.relief, state.relief);
    moonMat.needsUpdate = true;
    /**
     * 瓦片层也接同一张法线，高清区才有和底图一致的起伏光照。
     *
     * 必须是**克隆**：瓦片几何的 uv 是图集坐标，法线要按 uv1（等距圆柱经纬度）
     * 采样，所以克隆体的 channel 要设成 1；而底图材质继续用 channel 0 的原件。
     * clone() 共享同一个 Source，GPU 上只有一份纹理，不额外占显存。
     */
    normalTex = t.clone();
    normalTex.channel = 1;
    normalTex.needsUpdate = true;
    if (tileLayer) tileLayer.setNormalMap(normalTex, state.relief);
  }).catch(() => {});

  // 测试模式：固定相机与朝向
  if (TEST.active) applyTestView();

  // 底图升清 → 底图就绪后再接入国内 HiPS，避免与首屏加载抢带宽
  (async () => {
    const target = pickQuality();
    const bar2 = $('#load-bar');
    for (let q = 2048; q <= target; q *= 2) {
      try {
        // 必须传进度回调：早先这里漏了参数，loadTex 里回调调用抛错被 catch 吞掉，
        // 底图会永远停在 1K，细节层门槛（按底图放大倍率）随之误判成"该拉瓦片"。
        await upgrade(q, (p) => { if (bar2) bar2.style.width = p * 100 + '%'; });
      } catch (e) {
        console.warn('[moonhd] 底图升清中断于 ' + q + '：', e && e.message);
        upgradeError = e && e.message ? e.message : String(e);
        setStatus();
        break;
      }
    }
    initHips();
  })();
})();

/** 把相机放到指定经纬度上方指定距离；用于可复现的验收截图。 */
function applyTestView() {
  if (TEST.d !== null) {
    /**
     * 固定机位只在 `?lock=1` 时锁死交互。
     *
     * 老行为是只要带 `?d=` 就 `controls.enabled = false`，一次都不能拖——
     * 用户点到带参数的链接后就会以为"旋转和缩放坏了"。默认不锁，
     * 验收脚本要确定性时显式加 `?lock=1`。
     */
    if (TEST.lock) controls.enabled = false;
    intro = 1;
    /**
     * lon/lat 指的是**月固经纬度**，方向用渲染坐标系公式算：
     *   D_base(λ,φ) = (cosφ·cosλ, sinφ, −cosφ·sinλ)
     * 之前用的是天文坐标系那一套（北极在 +z），在瓦片层修好配准之后就错了：
     * 那样算出来的方向在渲染系里是"经度相同、纬度被换掉"的另一个点。
     */
    const dirLocal = TEST.lon !== null && TEST.lat !== null
      ? new THREE.Vector3(...dirFromLatLon(TEST.lat, TEST.lon, [0, 0, 0]))
      : new THREE.Vector3(1, 0, 0);          // 默认：正对月面中心 (lon 0, lat 0)
    // 必须先刷新世界矩阵：boot 里这一步跑在首帧之前，否则 moon.matrixWorld 还是
    // 单位矩阵，rotation.y=−π/2+0.3 不会计入，相机就落到了错误的经度上（实测差 72.8°）。
    moon.updateMatrixWorld(true);
    const dirWorld = dirLocal.clone().applyMatrix4(new THREE.Matrix4().extractRotation(moon.matrixWorld)).normalize();
    camera.position.copy(dirWorld.multiplyScalar(TEST.d));
    camera.lookAt(0, 0, 0);
  }
  for (const l of TEST.layers) {
    if (l === 'axis' || l === 'grid' || l === 'markers') {
      if (ui) ui.store.set(l, true); else overlays['set' + l[0].toUpperCase() + l.slice(1)](true);
    }
  }
  if (TEST.immersive && ui) ui.store.setImmersive(true);
  if (TEST.seg) {
    setInterval(() => {
      const st = scheduler ? scheduler.getStats() : null;
      console.log('[moonhd]', JSON.stringify({
        d: +camera.position.length().toFixed(3),
        order: hipsState.centerOrder, tiles: hipsState.tiles.length, ready: hipsState.readyKeys.size,
        capDeg: hipsState.capRadiusDeg ? +hipsState.capRadiusDeg.toFixed(2) : null,
        selectMs: +hipsState.selectMs.toFixed(2),
        bytesMiB: st ? +(st.bytes / 1048576).toFixed(1) : 0,
        requests: st ? st.requests : 0, errors: st ? st.errors : 0,
        retries: st ? st.retries : 0, cancelled: st ? st.cancelled : 0,
        evictions: st ? st.evictions : 0, persistHits: st ? st.persistentHits : 0,
        fps: lastFps,
      }));
    }, 2000);
  }
}

/* ============ 主循环 ============ */
let labelT = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now() / 1000;

  if (spinRunning()) moon.rotation.y += dt * 0.012 * state.spinSpeed;
  if (intro < 1 && !TEST.active && !flight.active) {
    intro = Math.min(1, intro + dt / 1.8);
    const e = 1 - Math.pow(1 - intro, 3);
    camera.position.setLength(9.5 + (5.25 - 9.5) * e);
  } else if (TEST.active) {
    intro = 1;
  }

  stepFlight(dt);
  // 自愈：除非显式 ?lock=1，任何情况下都不允许交互被永久关掉
  // （用户反馈过"进去以后不能旋转和缩放"，这里加一道兜底）
  if (!controls.enabled && !flight.active && !TEST.lock) controls.enabled = true;
  updateRotateSpeed();
  controls.update();
  syncLocalFrame();

  // 经纬网：间隔随可见球冠分档（带滞回）；标签锚点用"相机正下方经纬度"，
  // 锚点转动超过 5° 才重建几何，避免每帧重建 1 万多个顶点。
  if (overlays.state.grid) {
    const cap = capAngleDeg(camera.position.length());
    const next = pickStep(cap, overlays.gridStep || STEP_LEVELS[0]);
    const cam = latLonFromDir([_camLocal.x, _camLocal.y, _camLocal.z]);
    const moved = Math.abs(cam.lat - gridAnchor.lat) > 5
      || Math.abs(((cam.lon - gridAnchor.lon + 540) % 360) - 180) > 5;
    if (next !== overlays.gridStep || moved || !overlays.gridObject) {
      overlays.rebuildGrid(next, cam.lat, cam.lon);
      gridAnchor = { lat: cam.lat, lon: cam.lon };
    }
  }

  // 瓦片：0.25s 选一次视野；每帧只做上传/淡入，避免自转时抖动
  if (hipsState.ready) {
    hipsState.lastSelect += dt;
    if (hipsState.lastSelect > 0.25) {
      hipsState.lastSelect = 0;
      refreshTileSelection();
    }
    uploadReadyTiles();
    atlas.flush(performance.now());
    if (tileLayer) {
      // 只重建变化的部分：新瓦片建几何，离开视野的释放，未变的保留淡入状态
      tileLayer.sync(hipsState.tiles, (key) => atlas.slotUv(key));
      tileLayer.setMix(hipsState.mix);
      tileLayer.update(dt, hipsState.readyKeys);
    }
    hipsState.mixTarget = state.detail ? 1 : 0;
    hipsState.mix += (hipsState.mixTarget - hipsState.mix) * Math.min(1, dt * 2.5);
  }

  stars.visible = state.stars;
  earthshine.intensity = state.earth ? 0.055 : 0;
  renderer.render(scene, camera);

  // 中心坐标：屏幕中心射线与月球的近交点；未命中就是 null（不拿相机正下方点冒充）
  const centerHit = pickNDC(0, 0);
  centerCoord = centerHit ? { lat: centerHit.lat, lon: centerHit.lon } : null;

  // 标签：约 20 Hz 更新 DOM，不每帧重排
  labelT += dt;
  if (ui && labelT > 0.05) {
    labelT = 0;
    ui.renderLabels(computeLabels());
  }

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    lastFps = Math.round(fpsN / fpsT);
    fpsN = 0; fpsT = 0;
    setStatus();
  }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  refreshViewRect();
}

window.__luna = {
  THREE, scene, camera, renderer, moon, moonMat, controls, sun, uni,
  hips: hipsState,
  get scheduler() { return scheduler; },
  get atlas() { return atlas; },
  get tileLayer() { return tileLayer; },
  get persist() { return persist; },
  get normalTex() { return normalTex; },
  get ui() { return ui; },
  overlays,
  api,
  state,
  hpToRender, renderToHp,
  unprojectLocal, unprojectHp, projectLocal, projectFromHp,
  refreshTileSelection,
  clearPersist: () => clearTileCache(),
  setPhase,
  flyTo,
  resetView,
};
addEventListener('resize', resize);
resize();
