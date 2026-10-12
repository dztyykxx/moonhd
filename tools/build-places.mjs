/**
 * 由已核验的官方数据生成前端使用的 public/data/places.json。
 *
 * 分工：
 *   - 坐标、直径、正式名称、来源链接 —— 全部来自
 *     docs/data/lunar-features-iau-usgs.json（逐条抄自 IAU/USGS Gazetteer 的
 *     LOLA 2011 控制网字段，并与 USGS 批量产品 MOON_nomenclature_center_pts
 *     的 .dbf / .kml 交叉核对）。
 *   - 中文展示名、检索别名、简介、定位距离 —— 属于**编辑内容**，写在下面的
 *     EDITORIAL 表里。简介只写公开、可核对的事实，不写测量结论。
 *   - 着陆点来自 docs/data/landing-sites.json（NASA / CLEP 公开资料）。
 *
 * 任何缺失的字段保持 null，前端会显示 "—"，绝不填猜测值。
 *
 * 运行：node tools/build-places.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/places.json');

/** 编辑内容：中文展示名/别名/简介/定位距离。 */
const EDITORIAL = {
  'mare-tranquillitatis': { zh: '静海', summary: '月球正面东侧的月海，阿波罗 11 号在此着陆。', aliases: ['Tranquillitatis'] },
  'mare-imbrium': { zh: '雨海', summary: '月球正面西北部的巨大月海，直径超过 1100 km。', aliases: ['Imbrium'] },
  'mare-serenitatis': { zh: '澄海', summary: '月球正面东北部的月海，位于静海以北。', aliases: ['Serenitatis'] },
  'oceanus-procellarum': { zh: '风暴洋', summary: '月球正面西侧的大片月海，是月面上面积最大的月海。', aliases: ['Procellarum'] },
  'mare-crisium': { zh: '危海', summary: '月球正面东缘的圆形月海，边界清晰。', aliases: ['Crisium'] },
  'mare-fecunditatis': { zh: '丰富海', summary: '月球正面东南部的月海，位于危海以南。', aliases: ['Fecunditatis'] },
  'mare-nectaris': { zh: '酒海', summary: '月球正面东南部的月海，位于丰富海西南。', aliases: ['Nectaris'] },
  'mare-humorum': { zh: '湿海', summary: '月球正面西南部的月海，四周为高地环绕。', aliases: ['Humorum'] },
  'mare-nubium': { zh: '云海', summary: '月球正面西南部的月海，位于湿海以东。', aliases: ['Nubium'] },
  'mare-frigoris': { zh: '冷海', summary: '月球正面北部的狭长月海，呈弧形横贯北部。', aliases: ['Frigoris'] },
  'mare-moscoviense': { zh: '莫斯科海', summary: '月球背面的月海之一，位于背面北半球。', aliases: ['Moscoviense'] },
  'mare-ingenii': { zh: '智海', summary: '月球背面的月海之一，位于背面南半球。', aliases: ['Ingenii'] },
  'mare-orientale': { zh: '东海', summary: '月球西缘的撞击盆地，可见同心环状结构。', aliases: ['Orientale', '东方海'] },
  'mare-smythii': { zh: '史密斯海', summary: '月球正面东缘的月海，位于赤道附近。', aliases: ['Smythii'] },
  tycho: { zh: '第谷环形山', summary: '明亮的辐射纹向四周延伸，是月面最醒目的撞击坑之一。', aliases: ['第谷'] },
  copernicus: { zh: '哥白尼环形山', summary: '位于月球正面，坑底平坦、坑壁有阶地，周围有辐射纹。', aliases: ['哥白尼'] },
  kepler: { zh: '开普勒环形山', summary: '位于月球正面风暴洋东侧的小型撞击坑，带有辐射纹。', aliases: ['开普勒'] },
  aristarchus: { zh: '阿利斯塔克环形山', summary: '月面上亮度最高的较大地貌之一，位于风暴洋东部。', aliases: ['阿利斯塔克'] },
  clavius: { zh: '克拉维乌斯环形山', summary: '月球正面南部的大型古老撞击坑，坑底有密集小坑。', aliases: ['克拉维乌斯'] },
  plato: { zh: '柏拉图环形山', summary: '月球正面北部的大型撞击坑，坑底为深色平坦的熔岩填充。', aliases: ['柏拉图'] },
  bailly: { zh: '巴伊环形山', summary: '月球正面西南缘的大型古老撞击坑，靠近南极区域。', aliases: ['巴伊'] },
  tsiolkovskiy: { zh: '齐奥尔科夫斯基环形山', summary: '月球背面的醒目撞击坑，坑底为深色熔岩填充。', aliases: ['齐奥尔科夫斯基'] },
  shackleton: { zh: '沙克尔顿陨石坑', summary: '位于月球南极附近，坑内长期处于阴影中。', aliases: ['沙克尔顿'] },
  peary: { zh: '皮里环形山', summary: '位于月球北极附近，靠近极区永久阴影区。', aliases: ['皮里'] },
  malapert: { zh: '马拉柏特环形山', summary: '位于月球南极区域，靠近月球南极边缘。', aliases: ['马拉柏特', '马拉佩特'] },
  'von-karman': { zh: '冯·卡门环形山', summary: '月球背面的撞击坑，嫦娥四号在此着陆。', aliases: ['冯卡门', 'Von Karman'] },
  apollo: { zh: '阿波罗环形山', summary: '月球背面南半球的巨大撞击盆地，嫦娥六号在此采样返回。', aliases: ['阿波罗盆地', 'Apollo basin'] },
};

/** 按直径给一个合适的定位距离（月球半径 = 1）。纯 UI 参数，不是科学量。 */
function zoomForDiameter(km) {
  if (!Number.isFinite(km)) return 1.6;
  if (km >= 800) return 2.9;
  if (km >= 300) return 2.2;
  if (km >= 150) return 1.5;
  if (km >= 60) return 1.12;
  return 1.06;
}

const featuresRaw = JSON.parse(readFileSync(resolve(ROOT, 'docs/data/lunar-features-iau-usgs.json'), 'utf8'));
let landingsRaw = { landingSites: [] };
try {
  landingsRaw = JSON.parse(readFileSync(resolve(ROOT, 'docs/data/lunar-verification.json'), 'utf8'));
} catch (e) {
  console.warn('[build-places] 尚未找到 lunar-verification.json，本次只输出地貌。');
}

const items = [];

for (const f of featuresRaw.features) {
  const ed = EDITORIAL[f.id] || {};
  if (!ed.zh) throw new Error(`缺少中文展示名：${f.id}`);
  const isMare = f.type === 'mare' || f.type === 'oceanus';
  items.push({
    id: f.id,
    kind: isMare ? 'mare' : 'crater',
    type: f.type,
    nameZh: ed.zh,
    name: f.name,
    aliases: [f.name, ...(ed.aliases || [])],
    latDeg: f.latDeg,
    lonDeg: f.lonDeg,
    diameterKm: f.diameterKm ?? null,
    diameterNote: isMare ? '目录给出的近似直径或最长尺度' : null,
    approxCenter: !!f.approxCenter,
    summary: ed.summary || null,
    zoomDistance: zoomForDiameter(f.diameterKm),
    sourceLabel: '地名与参数来源 · IAU / USGS',
    sourceUrl: f.sourceUrl,
    sourceDate: f.sourceDate,
  });
}

for (const s of landingsRaw.landingSites || []) {
  if (s.latDeg == null || s.lonDeg == null) continue;   // 未核验坐标的条目不入目录
  items.push({
    id: s.id,
    kind: 'landing',
    type: 'landing',
    nameZh: s.nameZh || s.name,
    name: s.name,
    aliases: [s.name, ...(s.aliases || [])],
    latDeg: s.latDeg,
    lonDeg: s.lonDeg,
    diameterKm: null,
    mission: s.mission || null,
    region: s.region || null,
    landingDate: s.landingDate || null,
    summary: s.notes ? null : null,
    notes: s.notes || null,
    zoomDistance: 1.1,
    sourceLabel: '任务来源 · NASA / LROC',
    sourceUrl: s.sourceUrl || null,
    sourceDate: s.sourceDate || null,
  });
}

const out = {
  schema: 1,
  generatedBy: 'tools/build-places.mjs',
  note: '坐标与直径来自官方目录（IAU/USGS Gazetteer，LOLA 2011 控制网）；中文展示名与简介为编辑内容。'
    + '月海中心坐标是目录给出的大范围不规则地貌近似中心，不代表严格地质单元范围。',
  counts: {
    features: items.filter((i) => i.kind !== 'landing').length,
    landing: items.filter((i) => i.kind === 'landing').length,
  },
  sources: {
    features: 'https://planetarynames.wr.usgs.gov/Page/MOON/target',
    fields: 'https://planetarynames.wr.usgs.gov/Page/Specifics',
  },
  items,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`[build-places] ${out.items.length} 个地点 → ${OUT}`);
console.log(`  地貌 ${out.counts.features} · 着陆点 ${out.counts.landing}`);

/* ------------------------------------------------------------------ *
 * 月球概览：参考值与来源（数值本身来自核验过的 NASA/NSSDC 数据）
 * ------------------------------------------------------------------ */

const FACT_EDITORIAL = {
  'mean-radius-km': { label: '平均半径', display: (v) => `约 ${v.toLocaleString('en-US')} km` },
  'surface-gravity-m-s2': { label: '表面重力', display: (v) => `约 ${v} m/s²` },
  'sidereal-rotation-period-days': { label: '自转周期（恒星日）', display: (v) => `约 ${v} 天` },
  'mean-earth-moon-distance-km': { label: '平均地月距离', display: (v) => `约 ${v.toLocaleString('en-US')} km` },
};

const factsOut = {
  schema: 1,
  generatedBy: 'tools/build-places.mjs',
  sourceNote: '资料来源 · NASA / NSSDC（逐项核验；时间变化量与常量分开标注）',
  facts: (landingsRaw.facts || []).map((f) => {
    const ed = FACT_EDITORIAL[f.key] || {};
    return {
      key: f.key,
      label: ed.label || f.key,
      value: f.value,
      unit: f.unit,
      display: ed.display ? ed.display(f.value) : `${f.value} ${f.unit}`.trim(),
      isTimeVarying: !!f.isTimeVarying,
      note: f.isTimeVarying
        ? '实际值随时间变化（约 357,000–407,000 km），此处是平均值。'
        : '参考值，不随时间变化。',
      sourceUrl: f.sourceUrl,
      sourceDate: f.sourceDate,
    };
  }),
  links: [
    { label: '月球概况 · NASA Science', url: 'https://science.nasa.gov/moon/facts/' },
    { label: '月球参数表 · NASA NSSDC', url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html' },
    { label: '月相 · NASA Science', url: 'https://science.nasa.gov/moon/moon-phases/' },
  ],
  phases: {
    caveat: '本程序的月相只是场景光照角度的模拟，不是带日期的天文历算，也不表示今天的真实月相。',
    seenFrom: '月相名称由日月黄经差定义（新月 0°、上弦 90°、满月 180°、下弦 270°），真实外观需要星历表；'
      + 'NASA SVS 的月相与天平动影像由 JPL DE421 星历 + LOLA 高程 + LROC 影像生成，单一光照角度不足以描述。',
    sourceLabel: '月相定义 · USNO / NASA',
    sourceUrl: (landingsRaw.phaseDefinitions && landingsRaw.phaseDefinitions.url) || null,
  },
  unverified: landingsRaw.unverified || [],
};

const FACTS_OUT = resolve(ROOT, 'public/data/moon-facts.json');
writeFileSync(FACTS_OUT, JSON.stringify(factsOut, null, 2) + '\n', 'utf8');
console.log(`[build-places] ${factsOut.facts.length} 条月球概览 → ${FACTS_OUT}`);
if (factsOut.unverified.length) {
  console.log(`  未核验项（界面不展示，仅记录）：${factsOut.unverified.length} 条`);
}
