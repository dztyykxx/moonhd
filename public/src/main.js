import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { fetchSourceConfigCached, DEFAULT_SOURCE } from './hips/meta.js';
import { HttpTileLoader } from './hips/loader.js';
import { TileScheduler, TileState, textureBytes } from './hips/scheduler.js';
import { visibleCapBySampling, selectTiles } from './hips/lod.js';
import { hpToRender, renderToHp } from './hips/healpix.js';
import { TileAtlas, TileLayer } from './hips/tiles.js';
import { openTileCache, clearTileCache, cacheEstimate } from './hips/cache.js';

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
 * 示例：index.html?spin=0&d=1.35&lon=-11.36&lat=-43.31
 */
const TEST = (() => {
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) ? Number(q.get(k)) : null);
  const flag = (k) => (q.has(k) ? q.get(k) !== '0' : null);
  return {
    active: ['spin', 'd', 'lon', 'lat', 'detail', 'cal', 'seg'].some((k) => q.has(k)),
    spin: flag('spin'), d: num('d'), lon: num('lon'), lat: num('lat'),
    detail: flag('detail'), cal: flag('cal'), seg: flag('seg'),
  };
})();

const state = {
  spin: TEST.spin === null ? true : TEST.spin,
  stars: true, earth: true, relief: 1.2,
  detail: TEST.detail === null ? true : TEST.detail,
  color: true,
  calibrate: TEST.cal === null ? true : TEST.cal,
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
controls.rotateSpeed = 0.45;
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
const moon = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS, SEG, SEG >> 1), moonMat);
moon.rotation.z = THREE.MathUtils.degToRad(1.5);
moon.rotation.y = -Math.PI / 2 + 0.3;
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
      onp(got / total);
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
  const mDetail = $('#m-detail');
  try {
    const { props, config, fromCache, error: metaErr } = await fetchSourceConfigCached(DEFAULT_SOURCE);
    hipsState.config = config;
    $('#m-source').textContent = config.label + (fromCache ? '（离线元数据）' : '');
    $('#m-source').title = `${config.title} · order ${config.orderMin}-${config.orderMax} · ${config.tileWidth}px/瓦片`
      + (fromCache ? `\n元数据取自本地缓存；本次联网失败：${metaErr && metaErr.message}` : '');
    mDetail.textContent = '准备中';

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
      persistentPut: persist ? (order, npix, blob) => persist.put(order, npix, blob) : null,
    });

    hipsState.ready = true;
    mDetail.textContent = '开启';
    $('#m-cache').textContent = persist ? '内存 + 浏览器' : '仅内存';
    if (persist) updatePersistStats();
  } catch (e) {
    hipsState.error = e;
    console.error('[moonhd] HiPS 初始化失败：', e);
    mDetail.textContent = '不可用';
    $('#m-source').textContent = '基础底图';
  }
}

async function updatePersistStats() {
  if (!persist) return;
  try {
    const e = await cacheEstimate();
    hipsState.persistentBytes = e.usage || 0;
    $('#m-cache').textContent = (persist ? '内存 + 浏览器 ' : '仅内存 ') + fmtBytes(e.usage || 0);
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
const _v = new THREE.Vector3();
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
  const W = renderer.domElement.width;          // 设备像素
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
  return { moonPx: moonPxV, baseMag: moonPxV / texelsAcross, canvasW: W };
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
  camera.updateMatrixWorld(true);
  moon.updateMatrixWorld(true);
  _inv.copy(moon.matrixWorld).invert();
  _rot.extractRotation(_inv);
  updateCameraBasis();
  _camLocal.copy(camera.position).applyMatrix4(_inv);

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
const qv = $('#quality-v');
function pickQuality() {
  const f = new URLSearchParams(location.search).get('q');
  if (f) return Number(f);
  const sel = $('#quality').value;
  if (sel === 'auto') return isMobile ? 2048 : 8192;
  return Number(sel);
}
async function upgrade(q, onp) {
  const tex = await loadTex('assets/moon_albedo_' + q / 1024 + 'k.webp', true, onp);
  const old = moonMat.map;
  moonMat.map = tex;
  moonMat.needsUpdate = true;
  if (old) old.dispose();
  $('#m-res').textContent = q + ' x ' + q / 2;
  qv.textContent = '';
}

/* ============ 启动 ============ */
(async function boot() {
  const bar = $('#load-bar');
  moonMat.map = await loadTex('assets/moon_albedo_1k.webp', true, (p) => { bar.style.width = p * 25 + '%'; });
  moonMat.needsUpdate = true;
  $('#m-res').textContent = '1024 x 512';
  $('#loading').classList.add('is-done');
  setTimeout(() => { $('#loading').style.display = 'none'; }, 900);
  renderer.setAnimationLoop(frame);

  // 彩色调制层（LROC WAC 彩色合成，极区已填充）
  loadTex('assets/moon_chroma_1k.webp', true, () => {}).then((t) => {
    uni.chromaMap.value = t;
    uni.chromaAmt.value = state.color ? 0.7 : 0;
  }).catch(() => { $('#t-color').classList.remove('is-on'); });

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

  const target = pickQuality();
  for (let q = 2048; q <= target; q *= 2) {
    try {
      await upgrade(q, (p) => { qv.textContent = '载入 ' + Math.round(p * 100) + '%'; });
    } catch (e) {
      qv.textContent = '已是最优';
      break;
    }
  }

  // 底图就绪后再接入国内 HiPS，避免与首屏加载抢带宽
  initHips();

  // 测试模式：固定相机与朝向
  if (TEST.active) applyTestView();
})();

/** 把相机放到指定经纬度上方指定距离；用于可复现的验收截图。 */
function applyTestView() {
  if (TEST.d !== null) {
    controls.enabled = false;
    /**
     * lon/lat 指的是**月固经纬度**，方向用渲染坐标系公式算：
     *   D_base(λ,φ) = (cosφ·cosλ, sinφ, −cosφ·sinλ)
     * 之前用的是天文坐标系那一套（北极在 +z），在瓦片层修好配准之后就错了：
     * 那样算出来的方向在渲染系里是"经度相同、纬度被换掉"的另一个点。
     */
    const dirLocal = TEST.lon !== null && TEST.lat !== null
      ? new THREE.Vector3(...(() => {
        const c = Math.cos((TEST.lat * Math.PI) / 180);
        const lo = (TEST.lon * Math.PI) / 180;
        return [c * Math.cos(lo), Math.sin((TEST.lat * Math.PI) / 180), -c * Math.sin(lo)];
      })())
      : new THREE.Vector3(1, 0, 0);          // 默认：正对月面中心 (lon 0, lat 0)
    const dirWorld = dirLocal.clone().applyMatrix4(new THREE.Matrix4().extractRotation(moon.matrixWorld)).normalize();
    camera.position.copy(dirWorld.multiplyScalar(TEST.d));
    camera.lookAt(0, 0, 0);
  }
  // UI 状态同步
  const det = document.getElementById('t-det');
  det.classList.toggle('is-on', state.detail);
  const cal = document.getElementById('t-cal');
  cal.classList.toggle('is-on', state.calibrate);
  const spin = document.getElementById('t-spin');
  spin.classList.toggle('is-on', state.spin);
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
      }));
    }, 2000);
  }
}

/* ============ 月相 / 光照方向 ============ */
function setPhase(deg) {
  const a = THREE.MathUtils.degToRad(deg);
  sun.position.set(Math.sin(a), 0.10, -Math.cos(a)).normalize().multiplyScalar(80);
  $('#phase-v').textContent = deg.toFixed(0);
  $('#m-phase').textContent = Math.round((1 - Math.cos(a)) / 2 * 100) + '%';
}

/* ============ UI ============ */
function bind(id, fn) {
  const el = document.getElementById(id);
  const h = () => fn(el.value);
  el.addEventListener('input', h);
  h();
}
function toggle(id, key, after) {
  const el = document.getElementById(id);
  el.addEventListener('click', () => {
    state[key] = state[key] === false;
    el.classList.toggle('is-on', state[key]);
    if (after) after(state[key]);
  });
}
bind('phase', (v) => setPhase(Number(v)));
bind('exposure', (v) => { renderer.toneMappingExposure = Number(v); $('#exposure-v').textContent = Number(v).toFixed(2); });
bind('relief', (v) => {
  state.relief = Number(v);
  moonMat.normalScale.set(state.relief, state.relief);
  if (tileLayer) tileLayer.setNormalScale(state.relief);
  $('#relief-v').textContent = state.relief.toFixed(2);
});
$('#quality').addEventListener('change', (e) => {
  const u = new URL(location.href);
  if (e.target.value === 'auto') u.searchParams.delete('q');
  else u.searchParams.set('q', e.target.value);
  location.href = u.toString();
});
toggle('t-spin', 'spin');
toggle('t-stars', 'stars');
toggle('t-earth', 'earth');
toggle('t-det', 'detail');
toggle('t-color', 'color', (on) => { uni.chromaAmt.value = on ? 0.7 : 0; });
toggle('t-cal', 'calibrate', (on) => {
  if (tileLayer) tileLayer.setCalibration(on ? HIPS.gain : 1, 0);
});

$('#cache-clear').addEventListener('click', async () => {
  if (!persist) return;
  const n = await clearTileCache().catch(() => 0);
  await updatePersistStats();
  $('#cache-clear').textContent = '已清理 ' + n;
  setTimeout(() => { $('#cache-clear').textContent = '清理缓存'; }, 1600);
});

/* ============ 主循环 ============ */
const clock = new THREE.Clock();
let fpsN = 0, fpsT = 0, intro = isMobile ? 1 : 0;
let uiT = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.spin) moon.rotation.y += dt * 0.012;
  if (intro < 1 && !TEST.active) {
    intro = Math.min(1, intro + dt / 1.8);
    const e = 1 - Math.pow(1 - intro, 3);
    camera.position.setLength(9.5 + (5.25 - 9.5) * e);
  } else if (TEST.active) {
    intro = 1;
  }

  controls.update();

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

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    $('#m-fps').textContent = Math.round(fpsN / fpsT) + ' FPS';
    fpsN = 0; fpsT = 0;
  }
  uiT += dt;
  if (uiT > 0.5 && hipsState.ready) {
    uiT = 0;
    updateHipsUi();
  }
}

function updateHipsUi() {
  const st = scheduler ? scheduler.getStats() : null;
  const n = hipsState.readyKeys.size;
  const total = hipsState.tiles.length;
  $('#m-detail').textContent = state.detail
    ? `L${hipsState.centerOrder} · ${n}/${total}`
    : '关闭';
  if (st) {
    hipsState.bytes = st.bytes;
    $('#m-cache').textContent = fmtBytes(st.bytes) + ' / ' + fmtBytes(st.memoryBudget)
      + (persist ? ' + 浏览器' : '');
  }
  $('#m-detail').title = [
    `层级 L${hipsState.centerOrder}`,
    `可视瓦片 ${total}（已就绪 ${n}，队列 ${st ? st.queued : 0}，进行中 ${st ? st.inflight : 0}）`,
    `可视球冠半径 ${hipsState.capRadiusDeg ? hipsState.capRadiusDeg.toFixed(1) : '-'}°`,
    `选择耗时 ${hipsState.selectMs.toFixed(1)}ms`,
    `累计请求 ${st ? st.requests : 0}（内存命中 ${st ? st.memoryHits : 0}，持久化命中 ${st ? st.persistentHits : 0}）`,
    `重试 ${st ? st.retries : 0}，失败 ${st ? st.errors : 0}，取消 ${st ? st.cancelled : 0}，淘汰 ${st ? st.evictions : 0}`,
    `图集页 ${atlas ? atlas.pageCount : 0}/${HIPS.maxPages}，槽位不足跳过 ${hipsState.slotStarved}`,
    `几何顶点 ${tileLayer ? tileLayer.vertices : 0}`,
  ].join('\n');
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
window.__luna = {
  THREE, scene, camera, renderer, moon, moonMat, controls, sun, uni,
  hips: hipsState,
  get scheduler() { return scheduler; },
  get atlas() { return atlas; },
  get tileLayer() { return tileLayer; },
  get persist() { return persist; },
  get normalTex() { return normalTex; },
  hpToRender, renderToHp,
  unprojectLocal, unprojectHp, projectLocal, projectFromHp,
  refreshTileSelection,
  clearPersist: () => clearTileCache(),
};
addEventListener('resize', resize);
resize();
