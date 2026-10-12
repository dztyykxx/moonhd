/**
 * HiPS 瓦片渲染层：把瓦片画进纹理图集（canvas → WebGL2 2D array texture），
 * 再为当前瓦片集合生成贴合球面的曲面几何。
 *
 * 为什么用图集而不是"每张瓦片一个纹理"：
 *   - 一个图集页面（4096²）可放 8×8=64 张 512² 瓦片，显存连续、上传可控；
 *   - 一次 draw call 画完一页的所有瓦片，避免几十上百次 draw call；
 *   - 可以在片元里做父层/子层混合与淡入，不需要切换材质。
 *
 * 几何：每张瓦片按其四角（HEALPix 面内是正方形，但在球面上是曲面四边形）
 * 细分，顶点直接落在球面上（半径 1），因此与底图球面完全贴合，不会悬浮。
 * 只画可视球冠内的部分，避免背面几何。
 */
import * as THREE from 'three';
import { tilePointVec, hpToRender, renderUv } from './healpix.js';
import { textureBytes } from './scheduler.js';

const PAGE_SIZE = 4096;
const TILE_PX = 512;
const SLOTS_PER_SIDE = PAGE_SIZE / TILE_PX;      // 8
const SLOTS_PER_PAGE = SLOTS_PER_SIDE * SLOTS_PER_SIDE;

/**
 * 槽位 → 图集画布像素左上角。
 *
 * 与 slotUv() 是一对：slotUv() 给出"画布像素 (x,y) ↔ uv=(x/W, y/H)"的映射，
 * 前提是纹理 **flipY = false**。这两个函数必须一起看，改一个就要改另一个。
 */
export function slotOrigin(slot) {
  return {
    x: (slot % SLOTS_PER_SIDE) * TILE_PX,
    y: Math.floor(slot / SLOTS_PER_SIDE) * TILE_PX,
  };
}

/**
 * 槽位 → 图集纹理 uv（含半像素内缩，避免邻槽渗色）。
 *
 * 约定：v 随画布 y 增大而增大，即 **v=0 在画布顶边**。
 * 这要求纹理 flipY = false；three 的 Texture 默认 flipY = true，
 * 若忘了关，texture2D(uv) 会取到上下镜像的位置，瓦片会整块采样到空槽位而变黑。
 */
export function slotUvOf(slot) {
  const o = slotOrigin(slot);
  const pad = 0.5 / PAGE_SIZE;
  return {
    u0: o.x / PAGE_SIZE + pad,
    v0: o.y / PAGE_SIZE + pad,
    scale: 1 / SLOTS_PER_SIDE - 2 * pad,
  };
}

/**
 * 图集槽位账本：只管"哪个槽位放了哪张瓦片"，不碰 canvas/纹理。
 *
 * 抽出来的原因：upload() 的幂等性是修掉"静止时仍有 243 次/秒重复上传"的关键，
 * 而 canvas 在 Node 里不存在、没法直接测 TileAtlas。把纯逻辑放这里就能测。
 */
export class AtlasSlots {
  /** @param {number} maxPages */
  constructor(maxPages = 2) {
    this.maxPages = maxPages;
    /** @type {Map<string,{page:number,slot:number}>} */
    this.slotOf = new Map();
    /**
     * 每页每个槽位**已画入**的瓦片键（null = 画布上还是空的）。
     * 注意与 slotOf 的区别：slotOf 表示"这个槽位归谁用"，
     * contents 表示"画布上真的画了哪张图"。刚分配但还没 drawImage 时是 null。
     */
    this.contents = [];
  }

  get pageCount() { return this.contents.length; }

  /** 为一张瓦片分配槽位；已有则复用。返回 {page, slot} 或 null（页数用尽）。 */
  allocate(key) {
    const has = this.slotOf.get(key);
    if (has) return has;
    for (let p = 0; p < this.contents.length; p++) {
      const idx = this._freeSlot(p);
      if (idx >= 0) {
        this.contents[p][idx] = null;              // 归它用，但画布上还是空的
        const slot = { page: p, slot: idx };
        this.slotOf.set(key, slot);
        return slot;
      }
    }
    if (this.contents.length < this.maxPages) {
      const arr = new Array(SLOTS_PER_PAGE).fill(null);
      this.contents.push(arr);
      const slot = { page: this.contents.length - 1, slot: 0 };
      this.slotOf.set(key, slot);
      return slot;
    }
    return null;
  }

  /** 找一个"没有被任何键占用"的槽位。 */
  _freeSlot(page) {
    const taken = new Set();
    for (const s of this.slotOf.values()) if (s.page === page) taken.add(s.slot);
    for (let i = 0; i < SLOTS_PER_PAGE; i++) if (!taken.has(i)) return i;
    return -1;
  }

  /** 释放槽位，下一帧可被别的瓦片复用。 */
  release(key) {
    const s = this.slotOf.get(key);
    if (!s) return;
    this.slotOf.delete(key);
    this.contents[s.page][s.slot] = null;
  }

  /** 该键落在哪一页（不存在返回 null）。 */
  pageOf(key) {
    const s = this.slotOf.get(key);
    return s ? s.page : null;
  }

  /** 记录该瓦片已经画进它的槽位。 */
  markDrawn(key) {
    const s = this.slotOf.get(key);
    if (!s) return;
    this.contents[s.page][s.slot] = key;
  }

  /**
   * 该瓦片的像素是否已经在槽位里。
   * true 表示调用方可以跳过 drawImage 与标脏。
   */
  has(key) {
    const s = this.slotOf.get(key);
    if (!s) return false;
    return this.contents[s.page][s.slot] === key;
  }

  clear() {
    this.slotOf.clear();
    this.contents.length = 0;
  }
}

/**
 * 瓦片图集：若干页 4096² canvas（8×8 个 512² 槽位）。
 *
 * 用普通 2D 纹理而不是 2D array：canvas 的 drawImage 是局部写入，
 * 上传时只需一次 texImage2D/texSubImage2D，不像 array texture 那样整页重传。
 * mipmap 只在"有改动"且距上次生成超过 minMipInterval 时重建一次，
 * 避免每张瓦片到达都做一次全页 mipmap。
 */
export class TileAtlas {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {number} [o.maxPages=2]
   * @param {boolean} [o.mipmaps=true]
   * @param {number} [o.minMipIntervalMs=250]
   */
  constructor(o) {
    this.renderer = o.renderer;
    this.maxPages = o.maxPages || 2;
    this.mipmaps = o.mipmaps !== false;
    this.minMipIntervalMs = o.minMipIntervalMs ?? 250;
    /** @type {Array<{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, texture:THREE.CanvasTexture, dirty:boolean, lastMip:number}>} */
    this.pages = [];
    /** 槽位账本（纯逻辑，可单测）。slotOf 由它持有，保持向后兼容。 */
    this.slots = new AtlasSlots(this.maxPages);
    this.bytes = 0;
    this.uploads = 0;
    /** 因幂等而跳过的重复上传次数（用于观察是否还有空转）。 */
    this.skippedUploads = 0;
    this.mipRebuilds = 0;
  }

  get pageCount() { return this.pages.length; }

  /** 槽位映射（只读用途）。 */
  get slotOf() { return this.slots.slotOf; }

  _createPage() {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_SIZE;
    canvas.height = PAGE_SIZE;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, PAGE_SIZE, PAGE_SIZE);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    /**
     * 必须关掉 flipY。
     *
     * three 的 Texture 默认 flipY = true，上传时会把图像上下翻转，于是着色器里
     * texture2D(uv) 的 v=0 对应画布**底边**。但 slotUv()/buildTileGrid() 用的是
     * "v=0 在画布顶边"的约定（与 HiPS PNG 的行序一致），两边对不上，
     * 每张瓦片实际采样到的是图集里另一个（空的）槽位——表现为瓦片整块近黑
     * （实测：纹理直接采样 13，把 texture2D 换成常数 0.5 后同一像素为 206，
     * 即问题确定在采样而不在光照/法线/标定）。
     *
     * 关掉 flipY 后，画布像素 (x,y) 就落在 uv=(x/W, y/H)，与约定一致。
     */
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = this.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = this.mipmaps;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    const page = {
      canvas, ctx, texture,
      dirty: false, lastMip: 0,
    };
    this.pages.push(page);
    this.bytes += textureBytes(PAGE_SIZE, PAGE_SIZE, this.mipmaps);
    return page;
  }

  /** 为一张瓦片分配槽位；已有则复用。返回 {page, slot} 或 null（页数用尽）。 */
  allocate(key) {
    const s = this.slots.allocate(key);
    // 账本可能刚开了一页 → 同步创建 canvas 与纹理
    while (this.pages.length < this.slots.pageCount) this._createPage();
    return s;
  }

  /** 释放不再显示的槽位（下一帧可以被别的瓦片复用）。 */
  release(key) {
    this.slots.release(key);
  }

  /**
   * 把 ImageBitmap 画进槽位。**幂等**：同一张瓦片已在槽位里时直接返回，
   * 不重画、不标脏、不计数。调用方可以放心地每帧调用。
   *
   * 修掉的真实问题：调用方在每次刷新视野（0.25s 一次）都会对"已解码"的瓦片
   * 再调一次 upload()，于是同一张图被反复 drawImage 进画布、页面反复标脏，
   * 每次都要把 4096² 整页重传到 GPU 并重建 mipmap。
   * 实测静止不动时仍有 **243 次/秒** 的上传与 19 次/5s 的 mipmap 重建；
   * 加幂等后静止时为 0，缩放时只上传真正新增的瓦片。
   *
   * @returns {boolean} 槽位有效（true = 该瓦片现在确实在图集里）
   */
  upload(key, image) {
    const s = this.slots.slotOf.get(key);
    if (!s) return false;
    if (this.slots.has(key)) { this.skippedUploads++; return true; }   // 已经在里面了
    const page = this.pages[s.page];
    const { x: sx, y: sy } = slotOrigin(s.slot);
    page.ctx.drawImage(image, sx, sy, TILE_PX, TILE_PX);
    this.slots.markDrawn(key);
    page.dirty = true;
    this.uploads++;
    return true;
  }

  /** 每帧调用：把有改动的页面上传，并按节流重建 mipmap。 */
  flush(now) {
    for (const page of this.pages) {
      if (!page.dirty) continue;
      page.texture.needsUpdate = true;
      if (this.mipmaps && now - page.lastMip > this.minMipIntervalMs) {
        page.texture.generateMipmaps = true;
        page.lastMip = now;
        this.mipRebuilds++;
      }
      page.dirty = false;
    }
  }

  /** 槽位在图集纹理中的 uv 偏移与缩放（含半像素内缩）。 */
  slotUv(key) {
    const s = this.slotOf.get(key);
    if (!s) return null;
    return { ...slotUvOf(s.slot), page: s.page };
  }

  /** 每页的纹理，供材质使用（多页时按页拆 mesh）。 */
  textures() { return this.pages.map((p) => p.texture); }

  dispose() {
    for (const p of this.pages) p.texture.dispose();
    this.pages.length = 0;
    this.slots.clear();
    this.bytes = 0;
  }
}

/** buildTileGrid 的复用临时数组（每次立即消费，不跨调用保留）。 */
const _renderVec = [0, 0, 0];
const _renderUv = [0, 0];

/** 把一张瓦片细分成网格三角形，顶点落在单位球面上（**渲染坐标系**）。 */
export function buildTileGrid(order, npix, sub, uv, positions, uvs, opacities, indices, uv1s) {
  const nside = 2 ** order;
  const base = positions.length / 3;
  const step = 1 / sub;
  /**
   * 关键之一：图像像素 (col,row) 与面内局部坐标的对应是
   *
   *     dx = row / N ， dy = col / N
   *
   * 即 **dx 走图像的纵向、dy 走图像的横向**，两者是转置关系。
   *
   * 之前一直按 dx=col、dy=row 处理，症状就是"地图一片一片、有明显分界线"：
   * 瓦片各自被转了 90°，相邻瓦片在共享边界上对不上。
   * 实测（order 6 的 4 张相邻瓦片拼成面内方块）：
   *   - 错误映射：接缝处相邻两行差分均值 59.93，是瓦片内部基准(9.36) 的 6.4 倍
   *   - 正确映射：16.90，仅为内部的 1.78 倍（残差来自瓦片间 1 像素的地理间隔）
   * 与本地 8K 底图逐像素相关（同一批瓦片）：
   *   - 错误映射 r = +0.086
   *   - 正确映射 r = +0.679（另外三张瓦片分别为 +0.75 / +0.80 / +0.25）
   * 并对 8 种二面体变换做了穷举，只有"转置且不翻转"这一种在两张特征明显的
   * 瓦片上都成立，其余全部接近 0 或为负。
   *
   * 因此这里把 j（纵向）当作 dx、i（横向）当作 dy 传给 tilePointVec。
   *
   * 关键之二：tilePointVec() 给的是**天文坐标系**（z = 极轴）向量，
   * 而 position 属性必须是**渲染坐标系**（y = 极轴，与底图球一致）。
   * 见 healpix.js 里 hpToRender() 的说明——漏掉这一步就是
   * "8K 底图和放大后的区域对不上"的根因。转换是纯旋转，不影响绕向。
   */
  for (let j = 0; j <= sub; j++) {
    const rowFrac = j * step;                 // 纵向 → dx
    for (let i = 0; i <= sub; i++) {
      const colFrac = i * step;               // 横向 → dy
      const hp = tilePointVec(npix, nside, rowFrac, colFrac);
      const v = hpToRender(hp, _renderVec);
      positions.push(v[0], v[1], v[2]);
      // 图集 uv：u 随横向增大，v 随纵向增大（图集纹理已设 flipY=false，
      // 画布 y 向下，所以 v 与 row 同向）。
      uvs.push(uv.u0 + colFrac * uv.scale, uv.v0 + rowFrac * uv.scale);
      // 第二路 uv：底图那套等距圆柱经纬度，供 LOLA 法线贴图使用（见 TileLayer.setNormalMap）
      if (uv1s) {
        const e = renderUv(v, _renderUv);
        uv1s.push(e[0], e[1]);
      }
      opacities.push(0);
    }
  }
  for (let j = 0; j < sub; j++) {
    for (let i = 0; i < sub; i++) {
      // 顶点按 (i 横向, j 纵向) 排列：a=(i,j), b=(i+1,j), c=(i,j+1), d=(i+1,j+1)。
      // 两个三角形取 (a,c,d) 与 (a,d,b)。
      //
      // 这个绕向不能凭直觉定，也不能从旧版本照抄：球面瓦片四角在**经纬度**上是
      // 菱形（healpix.c 的面内 (dx,dy) 绕面心转了 45°），而且一旦把
      // (dx,dy) 与图像 (col,row) 的对应改成转置，同一个索引模式的法线方向就会翻面。
      // 以实测为准——对 order 0~9 的 8 张瓦片（含极冠）计算面法线与瓦片中心的内积：
      //   (a,b,d) / (a,d,c) → −0.97 ~ −1.00（朝内，光照≈0，瓦片全黑）
      //   (a,c,d)           → +0.97 ~ +1.00（朝外，正确）
      // 绕向同时决定 gl_FrontFacing，错了会被整块 discard。
      const a = base + j * (sub + 1) + i;
      const b = a + 1;
      const c = a + (sub + 1);
      const d = c + 1;
      indices.push(a, c, d, a, d, b);
    }
  }
  return base;
}

/**
 * 构建一张瓦片的完整几何（位置/UV/透明度/索引 + **法线**）。
 *
 * 单独抽出来是为了能在 Node 里直接测：TileLayer.sync() 需要 WebGLRenderer，
 * 而绕向和法线这两件事出错的代价是"瓦片整块消失/全黑"，必须在测试里守住。
 *
 * 法线必须显式计算：几何没有 normal 属性时 MeshStandardMaterial 拿不到有效法线，
 * 漫反射项≈0，瓦片会被环境光压成一片近黑（实测 mean 3.33 / max 23，
 * 而图集里纹理像素本身是 69）。
 *
 * @returns {{geometry: THREE.BufferGeometry, opacities: Float32Array}}
 */
export function buildTileGeometry(order, npix, sub, uv) {
  const positions = [], uvs = [], opacities = [], indices = [], uv1s = [];
  buildTileGrid(order, npix, sub, uv, positions, uvs, opacities, indices, uv1s);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // uv1 = 底图那套等距圆柱经纬度。LOLA 法线贴图的 channel 设为 1，
  // 于是它按 uv1 采样而不是按 uv（图集坐标）采样。
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1s, 2));
  const op = new Float32Array(opacities);
  g.setAttribute('aOpacity', new THREE.BufferAttribute(op, 1));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return { geometry: g, opacities: op };
}

/**
 * 瓦片层：持有几何与材质，负责根据当前瓦片集合重建几何、更新淡入透明度。
 */
export class TileLayer {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {TileAtlas} o.atlas
   * @param {number} [o.radius=1.0]
   * @param {number} [o.fadeSpeed=3.5]
   * @param {number} [o.baseSub=4]      最小细分
   * @param {number} [o.maxSub=10]      最大细分
   */
  constructor(o) {
    this.renderer = o.renderer;
    this.atlas = o.atlas;
    this.radius = o.radius ?? 1.0;
    this.fadeSpeed = o.fadeSpeed ?? 3.5;
    this.baseSub = o.baseSub ?? 4;
    this.maxSub = o.maxSub ?? 10;
    /** @type {Map<string,{mesh:THREE.Mesh, opacities:Float32Array, target:number, alpha:number, sub:number, uv:any}>} */
    this.tiles = new Map();
    this.group = new THREE.Group();
    this.group.renderOrder = 2;
    this.material = null;
    /** 地形法线贴图（channel=1，按 uv1 采样）与起伏强度，建材质时套用。 */
    this._normalMap = null;
    this._normalScale = 1;
    /**
     * 共享 uniform 对象：**只创建一次**。
     *
     * 之前把 `_uniforms = {...}` 写在 onBeforeCompile 里，每次重新编译都会换一个
     * 新对象；而 Three.js 程序侧保留的是第一次编译时那个对象的引用，
     * 于是 setMix()/setCalibration() 改到的是一个"脱钩"的对象，
     * 画面完全不变（实测症状：开关细节、开关标定都毫无效果）。
     */
    this._uniforms = {
      tileAtlas: { value: null },
      detailMix: { value: 0 },
      detailGain: { value: 1 },
      detailBias: { value: 0 },
    };
    this.vertices = 0;
    this.triangles = 0;
  }

  /**
   * 用底图材质的 shader 注入点构建瓦片材质（保持与月球一致的光照/曝光）。
   *
   * **每页一个材质**：图集最多两页（各 4096²、各 64 槽位），而 slotUv() 给的
   * uv 只在**单页内**有意义。之前所有 mesh 共用 `atlas.textures()[0]`，
   * 于是分配到第二页的瓦片采样到的是第一页同槽位的无关内容——
   * 表现为错贴（实测：2 页时第二页瓦片显示的是别处的地貌）。
   * 现在按 uv.page 选材质，两个材质共享同一组 uniform（光照/曝光/标定一致）。
   */
  createMaterial() {
    this.materials = [];
    this.material = this._createPageMaterial(0);   // 兼容：material 指向第 0 页
    return this.material;
  }

  /** 构建第 page 页的材质。 */
  _createPageMaterial(page) {
    /**
     * 瓦片与底图球几乎同半径，靠深度测试会互相打架（实测：瓦片被底图挡掉）。
     * 这里关掉深度测试，让瓦片始终画在底图之上；背面由 gl_FrontFacing 丢弃，
     * 不会出现"透视看到月球背面"的问题。瓦片几何本身也只覆盖可视球冠。
     */
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0,
      transparent: true, depthWrite: false, depthTest: false,
    });
    /**
     * 接上 LOLA 地形法线，让高清区有和底图一致的起伏光照。
     *
     * 没有法线贴图时，瓦片只是"贴在理想球面上的照片"：明暗只随球面法线变化，
     * 地形本身不产生起伏感——用户看到的就是"放大了没什么立体感"。
     * 底图一直有 normalMap，只有瓦片没有，所以接缝两侧观感也不一致。
     *
     * 关键：法线贴图走的是底图那套等距圆柱 uv，而瓦片几何的 uv 是**图集坐标**，
     * 两者完全不同。所以给贴图设 channel = 1，让它按几何的 uv1 属性采样
     * （uv1 由 buildTileGrid 用 renderUv() 算出）。
     */
    if (this._normalMap) {
      mat.normalMap = this._normalMap;
      mat.normalScale.set(this._normalScale, this._normalScale);
    }
    const atlas = this.atlas;
    // 每页**自己的** tileAtlas uniform；detailMix/Gain/Bias 共享同一个对象，
    // 所以 setMix()/setCalibration() 对所有页同时生效，而纹理互不干扰。
    const pageUniforms = {
      tileAtlas: { value: null },
      detailMix: this._uniforms.detailMix,
      detailGain: this._uniforms.detailGain,
      detailBias: this._uniforms.detailBias,
    };
    this._pageUniforms = this._pageUniforms || [];
    this._pageUniforms[page] = pageUniforms;
    mat.onBeforeCompile = (sh) => {
      // 每页绑定自己的纹理
      pageUniforms.tileAtlas.value = atlas.textures()[page] || null;
      Object.assign(sh.uniforms, pageUniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute float aOpacity;',
          'varying float vTileAlpha;',
          'varying vec2 vTileUv;',
        ].join('\n'))
        .replace('#include <uv_vertex>', [
          '#include <uv_vertex>',
          'vTileUv = uv;',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vTileAlpha = aOpacity;',
        ].join('\n'));
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform sampler2D tileAtlas;',
          'uniform float detailMix;',
          'uniform float detailGain;',
          'uniform float detailBias;',
          'varying float vTileAlpha;',
          'varying vec2 vTileUv;',
        ].join('\n'))
        // 锚点用 <color_fragment>：它在 STANDARD 片元里恒定存在。
        // 不能用 <map_fragment>——材质没有 map 时 Three 会把该 include 替换成空串，
        // 我们注入的代码会被静默丢掉（实测：瓦片完全不显示）。
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          '{',
          '  if (!gl_FrontFacing) discard;',           // 只画朝向相机的一面
          '  vec3 tile = texture2D(tileAtlas, vTileUv).rgb;',
          '  tile = tile * detailGain + detailBias;',
          '  float a = clamp(vTileAlpha, 0.0, 1.0) * clamp(detailMix, 0.0, 1.0);',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, tile, a);',
          '}',
        ].join('\n'));
    };
    // 每页必须用不同的 cache key，否则 three 会把两页的程序当成同一个复用，
    // 后编译的那页的纹理绑定会覆盖前一页（实测症状：第二页瓦片显示第一页的内容）。
    mat.customProgramCacheKey = () => 'moonhd-tiles-p' + page;
    this.materials = this.materials || [];
    this.materials[page] = mat;
    return mat;
  }

  /** 取某一页的材质；该页还没建过就现建。 */
  materialForPage(page) {
    if (!this.materials) this.createMaterial();
    if (!this.materials[page]) this._createPageMaterial(page);
    return this.materials[page];
  }

  /** 设置图集纹理与全局混合量。 */
  setAtlasTexture(tex) {
    if (this._uniforms) this._uniforms.tileAtlas.value = tex;
  }

  /**
   * 给瓦片材质接上地形法线贴图（与底图共用同一张 LOLA 法线，但它是
   * channel=1 的克隆，按 uv1 采样）。晚于建材质调用也没关系：
   * 已建的材质立刻更新，之后新建的页材质会自动带上。
   */
  setNormalMap(tex, scale = this._normalScale ?? 1) {
    this._normalMap = tex || null;
    this._normalScale = scale;
    if (!this.materials) return;
    for (const m of this.materials) {
      if (!m) continue;
      m.normalMap = this._normalMap;
      m.normalScale.set(scale, scale);
      m.needsUpdate = true;
    }
  }

  /** 只改起伏强度（对应界面上的"起伏"滑块）。 */
  setNormalScale(scale) {
    this._normalScale = scale;
    if (!this.materials) return;
    for (const m of this.materials) if (m) m.normalScale.set(scale, scale);
  }
  setMix(v) {
    if (this._uniforms) this._uniforms.detailMix.value = v;
  }
  setCalibration(gain, bias) {
    if (this._uniforms) {
      this._uniforms.detailGain.value = gain;
      this._uniforms.detailBias.value = bias;
    }
  }

  /** 移除所有瓦片几何。 */
  clear() {
    for (const t of this.tiles.values()) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.vertices = 0;
    this.triangles = 0;
  }

  /**
   * 用新的瓦片集合重建几何。只重建变化的部分：
   * 新增瓦片建几何，移除瓦片释放几何，未变瓦片保留（保持淡入状态，避免闪烁）。
   *
   * @param {Array<{order:number,npix:number,screenPx:number,priority:number}>} tiles
   * @param {(key:string)=>({slot:number}|null)} slotOf
   */
  sync(tiles, slotOf) {
    const next = new Set();
    for (const t of tiles) {
      const key = t.order + '/' + t.npix;
      next.add(key);
      if (this.tiles.has(key)) continue;
      const uv = slotOf(key);
      if (!uv) continue;                     // 还没有槽位（等待分配）
      const sub = Math.max(this.baseSub, Math.min(this.maxSub,
        Math.round(Math.sqrt(Math.max(1, t.screenPx)) / 4)));
      const { geometry: g, opacities: op } = buildTileGeometry(t.order, t.npix, sub, uv);
      // 按 uv.page 选材质：图集第 0/1 页的槽位编号是各自独立的，
      // 用错材质就会采到另一页同槽位的无关内容（错贴）。
      const mesh = new THREE.Mesh(g, this.materialForPage(uv.page || 0));
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.tiles.set(key, {
        mesh, opacities: op, target: 0, alpha: 0, sub,
        uv, order: t.order, npix: t.npix,
      });
      this.vertices += g.getAttribute('position').count;
      this.triangles += g.getIndex().count / 3;
    }
    for (const [key, t] of [...this.tiles]) {
      if (!next.has(key)) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        this.tiles.delete(key);
      }
    }
  }

  /**
   * 每帧更新淡入透明度与目标值。
   * @param {number} dt
   * @param {Set<string>} readyKeys 已就绪（可以显示）的瓦片键
   */
  update(dt, readyKeys) {
    const k = Math.min(1, dt * this.fadeSpeed);
    for (const [key, t] of this.tiles) {
      t.target = readyKeys.has(key) ? 1 : 0;
      t.alpha += (t.target - t.alpha) * k;
      if (t.alpha < 0.002 && t.target === 0) t.alpha = 0;
      if (t.alpha > 0.998 && t.target === 1) t.alpha = 1;
      const arr = t.opacities;
      let changed = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== t.alpha) { arr[i] = t.alpha; changed = true; }
      }
      if (changed) t.mesh.geometry.getAttribute('aOpacity').needsUpdate = true;
    }
  }

  /** 当前已完全显示（alpha≈1）的瓦片数。 */
  get visibleCount() {
    let n = 0;
    for (const t of this.tiles.values()) if (t.alpha > 0.5) n++;
    return n;
  }

  dispose() {
    this.clear();
    for (const m of (this.materials || [])) if (m) m.dispose();
    this.materials = [];
    this.material = null;
  }
}

export { PAGE_SIZE, TILE_PX, SLOTS_PER_PAGE };
