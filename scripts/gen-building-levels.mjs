/**
 * 生成 config/building_levels.csv —— 把建筑的「基数×增长率^(等级-1)」公式
 * 1:1 展开为「每级独立数值」表。列：code,level,costWood,costClay,costIron,costCrop,timeSec,popCap,prod
 *
 * 用法：node scripts/gen-building-levels.mjs
 * 用途：v4 平衡调参改造后，建筑成本/耗时/人口上限/产量改为逐等级独立数值，由 GM 面板逐等级编辑。
 *       本脚本只负责从「旧公式基数快照」初次生成数据；之后逐等级数值直接在 building_levels.csv 里
 *       手改或用 GM 面板改。生成结果应与原文件一致（详见下）。
 *
 * 注意：
 *  - v4 起 buildings.csv 已删除公式列（cost*、prod*、popCapPerLevel 等），故公式基数快照内嵌于本脚本
 *    LEGACY_BASES（重构自改造前的 buildings.csv + 居民楼规则），使本脚本可独立重跑、不依赖旧 schema。
 *  - 表头在首行、注释在表头之后（与 buildings.csv 约定一致：loadCsv/parseCsv 把首行当表头、仅跳过
 *    正文里的 # 注释行）。
 *  - popCap 为「该级相对上一级的增量贡献」（逐等级恒定=旧 popCapPerLevel），硬上限 = Σ 1..当前等级 popCap，
 *    1:1 等价于旧模型 popCapPerLevel × level（例如 main L10 = 20×10 = 200）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', 'config');

/**
 * 旧公式基数快照（v4 起 buildings.csv 已删除公式列，此处保留以便重新生成 building_levels.csv）。
 * 字段：cw/cc/ci/cr 木/泥/铁/粮基价；cg 造价增长率；tb 时间基；tg 时间增长率；pc 每级人口上限增量基数；
 *       pb/pg 仅资源田：产量基/增长率。
 * 居民楼（residence）无产出，popCap 每级 +18（增量）；成本/时间与 main 同档。
 */
const LEGACY_BASES = {
  main:       { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:20 },
  warehouse:  { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:6 },
  granary:    { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:6 },
  barracks:   { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8 },
  stable:     { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8 },
  workshop:   { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8 },
  academy:    { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8 },
  smithy:     { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8 },
  wall:       { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:4 },
  rallypoint: { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:4 },
  woodcutter: { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8, pb:1000, pg:1.3 },
  claypit:    { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8, pb:1000, pg:1.3 },
  ironmine:   { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8, pb:1000, pg:1.3 },
  cropland:   { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:8, pb:1000, pg:1.3 },
  hospital:   { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:10 },
  residence:  { cw:4, cc:3.5, ci:3, cr:2, cg:1.28, tb:1.5, tg:1.6, pc:18 },
};

const out = [
  'code,level,costWood,costClay,costIron,costCrop,costGold,timeSec,popCap,prod',
  '#建筑逐级参数（v4 逐等级独立数值；由 scripts/gen-building-levels.mjs 从旧公式基数快照生成）。code=建筑代码,level=等级(1..maxLevel),cost*=升/建到该级的花费,timeSec=耗时(秒),popCap=该级相对上一级的人口上限增量贡献(硬上限=Σ1..当前等级popCap),prod=仅资源田填该级产量/小时',
];

// 读新 schema buildings.csv 仅取 code / maxLevel / resource（isField 判定）
const text = readFileSync(join(configDir, 'buildings.csv'), 'utf8');
const lines = text.split(/\r?\n/).filter((l) => l.trim().length && !l.trimStart().startsWith('#'));
const header = lines[0].split(',').map((h) => h.trim());
const rows = lines.slice(1).map((line) => {
  const cells = line.split(',');
  const o = {};
  header.forEach((h, i) => (o[h] = (cells[i] ?? '').trim()));
  return o;
});

for (const r of rows) {
  const base = LEGACY_BASES[r.code];
  if (!base) {
    console.warn(`跳过未知建筑 code=${r.code}（LEGACY_BASES 无对应基数）`);
    continue;
  }
  const isField = !!r.resource;
  const maxLevel = parseInt(r.maxLevel, 10) || 10;
  for (let lv = 1; lv <= maxLevel; lv++) {
    const costW = Math.round(base.cw * Math.pow(base.cg, lv - 1));
    const costC = Math.round(base.cc * Math.pow(base.cg, lv - 1));
    const costI = Math.round(base.ci * Math.pow(base.cg, lv - 1));
    const costR = Math.round(base.cr * Math.pow(base.cg, lv - 1));
    const time = Math.round(base.tb * Math.pow(base.tg, lv - 1));
    const popCap = base.pc; // 每级增量（恒定），硬上限=Σ1..level
    const prod = isField ? Math.round(base.pb * Math.pow(base.pg, lv - 1)) : '';
    out.push([r.code, lv, costW, costC, costI, costR, 1, time, popCap, prod].join(','));
  }
}

writeFileSync(join(configDir, 'building_levels.csv'), out.join('\n') + '\n', 'utf8');
console.log(`wrote ${rows.length} buildings x levels -> config/building_levels.csv`);
