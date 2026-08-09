import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { loadCsv, num, parseCsvStructured, serializeCsv, type CsvRow } from './csv.js';
import { TRAIT_EFFECTS, type TraitEffect, type UnitForm, type UnitTraitDef } from './combat-types.js';

export type { UnitTraitDef } from './combat-types.js';

// ── 平衡调参覆盖（持久化在 data/balance_overrides.json，git 忽略，部署/wipe 都不动）────

/**
 * 平衡调参覆盖结构：与 GM 保存接口 body 同形。
 * tableName → 行主键 → 字段名 → 新值（字符串，与 CSV 单元格同口径）。
 * 例如：{ buildings: { '16': { maxLevel: '5' } }, building_levels: { 'main|1': { popCap: '99' } } }
 */
export type BalanceOverrides = Record<string, Record<string, Record<string, string>>>;

/**
 * 单个表的可编辑字段集合（与 gm.ts 的 BALANCE_TABLES 同形，但只关心覆盖逻辑所需的子集）。
 * 这里只声明本文件需要的最小结构，避免直接依赖 gm.ts 造成循环引用。
 */
export interface BalanceTableMeta {
  /** CSV 文件名（相对 configDir）。 */
  file: string;
  /** 单字段主键列名（如 'id'）。 */
  key?: string;
  /** 复合主键列名数组（如 ['code','level']）。 */
  keyComposite?: string[];
  /** 数字字段集合：用于校验与规范化。 */
  numeric?: string[];
}

/**
 * 读 data/balance_overrides.json。文件不存在或解析失败时返回空对象（视作「无覆盖」）。
 * 注意：路径在 data/ 目录下，与 game.json 同级；data/ 已在 .gitignore 中，
 * 所以部署（git reset --hard）和 wipe:all 都不会触碰。
 */
export function loadBalanceOverrides(overridePath: string): BalanceOverrides {
  if (!existsSync(overridePath)) return {};
  try {
    const raw = readFileSync(overridePath, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj as BalanceOverrides;
  } catch {
    // 文件损坏时降级为空对象（不影响启动；玩家改坏的下次保存会被覆盖）
    return {};
  }
}

/**
 * 写 data/balance_overrides.json（原子写入：先写临时文件再 rename，避免半截文件）。
 */
export function saveBalanceOverrides(overridePath: string, overrides: BalanceOverrides): void {
  const tmp = overridePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf8');
  // 原子重命名（跨平台：先 rename；失败则 copy + unlink 兜底）
  try {
    renameSync(tmp, overridePath);
  } catch {
    copyFileSync(tmp, overridePath);
    unlinkSync(tmp);
  }
}

/**
 * 把单个表的覆盖合并到已解析的 CSV 行集合上，返回新行集合。
 * 不做文件 I/O；调用方负责序列化与落盘。
 * 校验逻辑与 gm.applyBalanceEdits 保持一致：数字字段必须能 parseFloat；非数字字段原样覆盖。
 */
export function mergeOverridesIntoRows(
  rows: CsvRow[],
  table: BalanceTableMeta,
  changes: Record<string, Record<string, string>>,
): CsvRow[] {
  const incByKey = new Map(Object.entries(changes));
  const keyCol = table.key;
  const compCols = table.keyComposite ?? [];
  return rows.map((orig) => {
    const keyVal = keyCol
      ? String(orig[keyCol] ?? '')
      : compCols.map((c) => String(orig[c] ?? '')).join('|');
    const inc = incByKey.get(keyVal);
    if (!inc) return orig;
    const merged = { ...orig };
    for (const h of Object.keys(inc)) {
      const newVal = inc[h];
      if (newVal === undefined || newVal === '') continue;
      if (table.numeric?.includes(h)) {
        const n = Number(newVal);
        if (!Number.isFinite(n)) throw new Error(`${table.file} 行 ${keyVal} 字段 ${h}="${newVal}" 不是合法数字`);
        merged[h] = String(n);
      } else {
        merged[h] = newVal;
      }
    }
    return merged;
  });
}

/**
 * 深合并两次平衡调参覆盖（表→主键→字段）。后写入覆盖先写入；缺失字段保留。
 * 用于 GM 保存端点：读现有覆盖 → 合并本次编辑 → 落盘（避免一次保存抹掉之前的手改）。
 */
export function mergeBalanceOverrides(existing: BalanceOverrides, incoming: BalanceOverrides): BalanceOverrides {
  const merged: BalanceOverrides = { ...existing };
  for (const table of Object.keys(incoming)) {
    merged[table] = { ...(merged[table] ?? {}) };
    for (const key of Object.keys(incoming[table])) {
      merged[table][key] = { ...(merged[table][key] ?? {}), ...incoming[table][key] };
    }
  }
  return merged;
}

/**
 * 基础设施 · 配置注册表（GameConfig）
 * 启动时从 config/*.csv 加载所有游戏数据，解析成模块用的结构。
 * 模块不再硬编码 *_DEFS，而是从这里读 → 改 CSV 即改游戏，不改代码。
 *
 * 建筑成本/耗时/人口上限/产量改为「逐等级独立数值」，存于 building_levels.csv（code,level,cost*,timeSec,popCap,prod），
 * 由 GM 平衡面板逐等级编辑；buildings.csv 只保留每建筑的归属/解锁/繁荣度等静态字段。
 *
 * ── 主键与引用约定（2.0 配置规范）──────────────────────────────
 * 目录表(buildings/units/pve_targets)每行有两个标识：
 *   · id   数字主键——CSV 里**跨表引用一律用它**（requires=4:3、building=4、targetId=1）。
 *   · code 英文代码——**引擎内部与存档统一用它**（避免 kind===5 这种魔法数字、CSV 重排不破坏代码）。
 * 加载时把 CSV 里的数字引用解析回 code，所以本文件之外的代码只见 code。
 * 资源(resources)与部族(tribe)主键保持语义串(wood/romans…)，它们是 economy/wire/存档的结构属性名。
 *
 * icon 列只填**基名**（如 bld_barracks）；渲染方拼 `<美术根>/<基名>.png`（前端 artPath）。
 */

/** 建筑归属区。center=城镇中心(阀门,唯一)；inner=城内(民生研发)；outer=城外(生产量产)。 */
export type Zone = 'center' | 'inner' | 'outer';

/** 建筑某一等级的独立参数（来自 building_levels.csv，替代旧的等比公式）。 */
export interface BuildingLevelDef {
  /** 升/建到该等级的花费（4 资源）。 */
  cost: Record<string, number>;
  /** 升/建到该等级额外消耗的金币（逐等级独立，替代旧全局 goldCostPerBuild；GM 可改）。 */
  costGold: number;
  /** 升/建到该等级耗时（秒）。 */
  timeSec: number;
  /** 该等级相对上一级的「增量」人口硬上限贡献。硬上限 = Σ 每栋已建建筑 levels[1..当前等级].popCap（增量求和，1:1 等价于旧 popCapPerLevel×level）。 */
  popCap: number;
  /** 仅资源田：该等级产量/小时。 */
  prod?: number;
}

export interface BuildingDef {
  id: number;
  kind: string; // code
  name: string;
  icon: string; // 基名
  zone: Zone;
  /** 仅资源田：产出资源 key（wood/clay/iron/crop）；非产出建筑为 undefined。 */
  resource?: string;
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
  requires: { kind: string; level: number }[]; // kind=code（由数字ID解析而来）
  /** 每级贡献的繁荣度（按建筑主题分档，见 buildings.csv）。 */
  prosperityPerLevel: number;
  /** 每级人口增长/小时（仅 main 城镇中心有意义；其他建筑留 0）。替代旧的全局 popGrowthPerHour 常数。 */
  popGrowthPerLevel: number;
  /** 逐等级参数（成本/耗时/人口上限/产量），见 building_levels.csv。 */
  levels: Record<number, BuildingLevelDef>;
  /** 前端展示用：第 1 级人口上限贡献（= levels[1]?.popCap ?? 0），卡片显示「+X/级」。 */
  popCapPerLevel: number;
  /** 展示用简介：这栋建筑干嘛的/有什么用（点开建筑详情展示；纯文本，缺列回退空串）。 */
  desc: string;
  /** 展示用升级效果说明：每级提升什么（纯文本，缺列回退空串）。 */
  effect: string;
}

/** 城镇中心某等级开放的槽位数（来自 town_center_slots.csv）。 */
export interface TownCenterSlotTier {
  inner: number;
  outer: number;
  queue: number;
}

export interface UnitDef {
  id: number;
  key: string; // code
  tribe: string;
  name: string;
  icon: string; // 基名
  /** 形态：melee(近战/前排) / ranged(远程/后排)。取代旧的 cat。 */
  form: UnitForm;
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  speed: number;
  carry: number;
  upkeep: number;
  cost: Record<string, number>;
  trainSec: number;
  building: string; // 所需建筑 code（由数字ID解析而来）
  /** 特性 code 列表（由 units.csv 的数字 traits 引用解析而来；可空）。 */
  traits: string[];
  /** 训练时扣除的人口数量（消耗玩家的 currentPop）。 */
  popCost: number;
  /** 是否永久消耗人口（拓荒者=true：解散/死亡时人口不返还）。 */
  popPermanent: boolean;
  /** 是否雇佣兵（tribe=merc）：不耗粮、不占人口、金币购买、永久拥有；不进训练队列。 */
  isMercenary?: boolean;
  /** 雇佣兵单价（金币）。仅 isMercenary=true 时有意义。 */
  goldCost?: number;
}

export interface PveTemplate {
  id: number;
  type: string; // code
  name: string;
  icon: string; // 基名
  defender: Record<string, {
    count: number;
    form: UnitForm;
    meleeAtk: number;
    rangedAtk: number;
    meleeDef: number;
    rangedDef: number;
    carry: number;
  }>;
  loot: Record<string, number>;
  respawnSec: number;
}

export interface PveSpawn {
  id: string;
  type: string; // pve 目标 code（由数字ID解析而来）
  q: number; // 六边形轴坐标
  r: number;
}

/** 开局模板：按部族定义预置建筑布局/初始资源。来自 village_templates.csv。 */
export interface VillageTemplate {
  tribe: string;
  /** 开局预置建筑：{ code -> 等级 }（zone 由 buildings.csv 自动归区；资源田用 0 级=未开发占位）。 */
  startPlaced: Record<string, number>;
  /** 初始资源覆盖（空则各资源用 constants.start_resource_amount） */
  startResources: Record<string, number> | null;
}

/**
 * 全局常量集合（来自 game_constants.csv）。
 * 强类型暴露逻辑常用项，避免各模块各写各的 magic number；
 * 同时保留 raw 便于校验与调试。
 */
export interface GameConstants {
  wallBonusPerLevel: number;
  smithyBonusPerLevel: number;
  smithyCostBase: number;
  mainBuildSpeedupPerLevel: number;
  mainBuildSpeedupCap: number;
  storageBase: number;
  storageGrowthPerLevel: number;
  startResourceAmount: number;
  /** 金币：每个劳动人口每小时交税金币数（绑定城镇中心，与人口增速同节奏，不受繁荣度影响）。 */
  goldTaxPerCivilianPerHour: number;
  /** 金币：新村初始金币存量。 */
  startGoldAmount: number;
  baseProductionPerHour: number;
  mapSize: number;
  mapViewRadius: number;
  /** 环绕平行四边形世界尺寸（axial q 周期 worldW、r 周期 worldH）。 */
  worldW: number;
  worldH: number;
  /** 战斗每 tick 间隔(ms)：越小越平滑越费算力（08设计§4.4 的 dt）。 */
  combatTickMs: number;
  /** 战斗全局强度系数 k：越大减员越快、战斗越短（08设计§4.4 的 k）。 */
  combatStrength: number;
  /** 行军速度全局倍率（march_speed_multiplier）：>1加速、<1减速、1=原速。 */
  marchSpeedMultiplier: number;
  /** 每个村庄最多保留的通知/战报条数。 */
  notificationsPerVillage: number;
  /** PvE 战利品随机浮动幅度（0.2=±20%，均值不变；确定性 LCG 取种，可复现）。 */
  pveLootVariance: number;
  /** 人口：劳动人口占比达到此值（占硬上限比例）时，繁荣度加成达到满值（默认 0.70）。 */
  popProsperityFullRatio: number;
  /** 人口：超上限惩罚拐点；currentPop/hardCap 达到此比例时繁荣度加成归零（默认 2.0=超出一倍）。 */
  popOvercapPenaltyFullRatio: number;
  /** 人口：各部族最大动员比例（士兵占总人口的上限）；条顿0.80/高卢0.70/罗马0.75；超过则禁止继续征兵。 */
  popRaceMobilizeMax: { romans: number; gauls: number; teutons: number };
  /** 人口：劳动人口每小时消耗粮食量（平民口粮；士兵口粮见兵种 upkeep）。 */
  popCropPerLabor: number;
  /** 人口：零人口时所有速率类建筑的最低倍率（防死亡螺旋）。 */
  popLaborFloor: number;
  /** 人口：净粮赤字→减员速率比例（值越大粮仓耗尽后减员越快；v2已拍板=0.5）。 */
  popDeathRateFactor: number;
  /** 人口：饥荒减员定时任务间隔（秒；默认 300=5 分钟）。 */
  popFamineTickSec: number;
  /** 人口：医院 1 级回收战死士兵人口的比例（即时回收，无伤兵池）。 */
  popHospitalRecoveryBase: number;
  /** 人口：医院每级额外回收比例。 */
  popHospitalRecoveryPerLevel: number;
  /** 人口：医院回收比例上限。 */
  popHospitalRecoveryMax: number;
  /** 铁匠升级基础时长（秒），受繁荣度加成加速（除以 prosperityMult）。 */
  smithyUpgradeSec: number;
  /** 拓荒：出发村主基地最低等级。 */
  foundMinMainLevel: number;
  /** 拓荒：出发村人口软上限最低门槛。 */
  foundMinSoftLimit: number;
  /** 拓荒：所需拓荒者数量。 */
  foundSettlerCount: number;
  /** 拓荒：第2村开城包（单资源）。 */
  foundResourceCostBase: number;
  /** 拓荒：开城包递增底数（第N村 = base × growth^(N-2)）。 */
  foundResourceCostGrowth: number;
  /** 拓荒：与任意已有村庄的最小六边形距离。 */
  foundMinTileDistance: number;
  /** 拓荒：每玩家同时在途拓荒行军上限。 */
  foundMaxInflight: number;
  /** 分城新建后禁止放弃的秒数。 */
  foundAbandonLockSec: number;
  /** 原始 key->value（含未被强类型收录的扩展项） */
  raw: Record<string, number | boolean | string>;
}

/** 雇佣兵营地某等级的刷新参数（来自 merc_camp.csv）。 */
export interface MercCampLevel {
  /** 自动刷新间隔（秒）。 */
  refreshSec: number;
  /** 每次刷新刷出的可雇佣名额数。 */
  mercCount: number;
  /** 可存储的刷新次数上限（玩家手动点刷新消耗，营地自动刷新累积）。 */
  maxStoredRefreshes: number;
}

export interface GameConfig {
  resources: { key: string; name: string; icon: string }[];
  buildings: Record<string, BuildingDef>;
  /** 城镇中心等级 → 槽位配额（town_center_slots.csv），索引 = tcLevel（1..maxLevel）。 */
  townCenterSlots: Record<number, TownCenterSlotTier>;
  units: Record<string, UnitDef>;
  /** 雇佣兵营地刷新参数（merc_camp.csv）：level → 参数。 */
  mercCamp: Record<number, MercCampLevel>;
  /** 兵种特性表（unit_traits.csv），按 code 索引。 */
  unitTraits: Record<string, UnitTraitDef>;
  pveTemplates: Record<string, PveTemplate>;
  pveSpawns: PveSpawn[];
  constants: GameConstants;
  villageTemplates: Record<string, VillageTemplate>;
}

/** 解析 game_constants.csv 的一行值（按 type 列转型）。 */
function parseConstantValue(raw: string, type: string): number | boolean | string {
  if (type === 'bool') return raw === 'true' || raw === '1';
  if (type === 'string') return raw;
  return num(raw);
}

/** 解析 "main:1|rallypoint:1" → { main:1, rallypoint:1 }。 */
function parseLeveledList(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const part of s.split('|')) {
    const [code, lv] = part.split(':');
    if (code) out[code.trim()] = num(lv, 1);
  }
  return out;
}

/** 解析 "wood:750|clay:750" → { wood:750, clay:750 }；空串返回 null（表示用全局默认）。 */
function parseResourceList(s: string): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const part of s.split('|')) {
    const [code, amt] = part.split(':');
    if (code) out[code.trim()] = num(amt);
  }
  return out;
}

/**
 * 解析前置依赖。新格式用建筑**数字ID**："4:3" 或多个 "4:3|7:1"；空则无前置。
 * idToCode 把数字ID映射回建筑 code（引擎内部统一用 code）。
 */
function parseRequires(s: string, idToCode: Map<number, string>): { kind: string; level: number }[] {
  if (!s) return [];
  return s.split('|').map((part) => {
    const [idStr, lv] = part.split(':');
    const code = idToCode.get(num(idStr)) ?? idStr.trim();
    return { kind: code, level: num(lv, 1) };
  });
}

/**
 * 解析兵种 traits 列。竖线(|)分隔的特性**数字ID**（如 "1|3"）；traitIdToCode 映射回 code。
 * 注意：用 | 而非逗号，因为 CSV 解析器按逗号切分，值内不能含逗号（与 requires 列同理）。
 * 空则返回 []。
 */
function parseTraitRefs(s: string, traitIdToCode: Map<number, string>): string[] {
  if (!s) return [];
  return s.split('|').map((part) => {
    const idStr = part.trim();
    if (!idStr) return '';
    return traitIdToCode.get(num(idStr)) ?? idStr;
  }).filter(Boolean);
}

function assertUniqueRows(rows: Record<string, string>[], table: string, idField = 'id', codeField = 'code'): void {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const r of rows) {
    const id = r[idField]?.trim();
    const code = r[codeField]?.trim();
    if (id) {
      if (ids.has(id)) throw new Error(`${table} 存在重复 ${idField}: ${id}`);
      ids.add(id);
    }
    if (code) {
      if (codes.has(code)) throw new Error(`${table} 存在重复 ${codeField}: ${code}`);
      codes.add(code);
    }
  }
}

/** 从指定目录加载所有 CSV。configDir 默认指向仓库根的 config/。 */
export function loadGameConfig(configDir: string, overrides?: BalanceOverrides): GameConfig {
  const p = (f: string) => join(configDir, f);

  const resourceRows = loadCsv(p('resources.csv'));
  assertUniqueRows(resourceRows, 'resources.csv', 'id', 'id');
  const resources = resourceRows.map((r) => ({ key: r.id, name: r.name, icon: r.icon }));

  // 先读建筑原始行，建立 数字ID→code 映射，再解析 requires（前置也是数字ID引用）
  let buildingRows = loadCsv(p('buildings.csv'));
  assertUniqueRows(buildingRows, 'buildings.csv');
  // 应用平衡覆盖（玩家在 /gm/balance 的手动修改；持久化在 data/balance_overrides.json，git 忽略）
  if (overrides?.buildings) {
    buildingRows = mergeOverridesIntoRows(buildingRows, { file: 'buildings.csv', key: 'id', numeric: ['maxLevel','prosperityPerLevel','popGrowthPerLevel'] }, overrides.buildings);
  }
  const buildingIdToCode = new Map<number, string>();
  for (const r of buildingRows) buildingIdToCode.set(num(r.id), r.code);

  // 建筑逐级参数表（building_levels.csv）：code -> level -> BuildingLevelDef
  const levelsByCode: Record<string, Record<number, BuildingLevelDef>> = {};
  let levelRows = loadCsv(p('building_levels.csv'));
  if (overrides?.building_levels) {
    levelRows = mergeOverridesIntoRows(levelRows, {
      file: 'building_levels.csv', keyComposite: ['code','level'],
      numeric: ['costWood','costClay','costIron','costCrop','costGold','timeSec','popCap','prod'],
    }, overrides.building_levels);
  }
  for (const r of levelRows) {
    const code = r.code?.trim();
    if (!code) continue;
    const lv = num(r.level);
    if (lv <= 0) continue;
    (levelsByCode[code] ??= {})[lv] = {
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      costGold: num(r.costGold, 0),
      timeSec: num(r.timeSec),
      popCap: num(r.popCap),
      prod: r.prod ? num(r.prod) : undefined,
    };
  }

  const buildings: Record<string, BuildingDef> = {};
  for (const r of buildingRows) {
    const isField = !!r.resource;
    const lvl = levelsByCode[r.code] ?? {};
    buildings[r.code] = {
      id: num(r.id), kind: r.code, name: r.name, icon: r.icon,
      zone: (r.zone as Zone) || 'inner',
      resource: isField ? r.resource : undefined,
      cost: (lv: number): Record<string, number> => {
        const l = lvl[lv];
        if (l) return { ...l.cost, gold: l.costGold ?? 0 };
        return { wood: 0, clay: 0, iron: 0, crop: 0, gold: 0 };
      },
      timeSec: (lv: number) => lvl[lv]?.timeSec ?? 0,
      maxLevel: num(r.maxLevel, 10),
      requires: parseRequires(r.requires, buildingIdToCode),
      prosperityPerLevel: num(r.prosperityPerLevel, 5),
      popGrowthPerLevel: num(r.popGrowthPerLevel, 0),
      levels: lvl,
      popCapPerLevel: lvl[1]?.popCap ?? 0,
      desc: r.desc ?? '',
      effect: r.effect ?? '',
    };
  }

  // 城镇中心槽位曲线：tcLevel → {inner,outer,queue}
  const townCenterSlots: Record<number, TownCenterSlotTier> = {};
  for (const r of loadCsv(p('town_center_slots.csv'))) {
    const lv = num(r.tcLevel);
    if (lv <= 0) continue;
    townCenterSlots[lv] = {
      inner: num(r.innerSlots), outer: num(r.outerSlots), queue: num(r.queueSlots, 2),
    };
  }

  // 兵种特性表：先解析，units 的 traits 列用数字 id 引用它，解析回 code
  const traitRows = loadCsv(p('unit_traits.csv'));
  assertUniqueRows(traitRows, 'unit_traits.csv');
  const unitTraits: Record<string, UnitTraitDef> = {};
  const traitIdToCode = new Map<number, string>();
  for (const r of traitRows) {
    if (!r.code) continue;
    traitIdToCode.set(num(r.id), r.code);
    const effects: { effect: TraitEffect; value: number }[] = [];
    for (let i = 1; i <= 5; i++) {
      const ek = `effect${i}`, vk = `value${i}`;
      if (r[ek]) effects.push({ effect: r[ek] as TraitEffect, value: num(r[vk]) });
    }
    unitTraits[r.code] = { id: num(r.id), code: r.code, name: r.name, effects };
  }

  let unitRows = loadCsv(p('units.csv'));
  assertUniqueRows(unitRows, 'units.csv');
  if (overrides?.units) {
    unitRows = mergeOverridesIntoRows(unitRows, {
      file: 'units.csv', key: 'code',
      numeric: ['meleeAtk','rangedAtk','meleeDef','rangedDef','speed','carry','upkeep','costWood','costClay','costIron','costCrop','trainSec','popCost'],
    }, overrides.units);
  }
  const units: Record<string, UnitDef> = {};
  for (const r of unitRows) {
    units[r.code] = {
      id: num(r.id), key: r.code, tribe: r.tribe || 'romans', name: r.name, icon: r.icon,
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef),
      speed: num(r.speed, 6), carry: num(r.carry), upkeep: num(r.upkeep, 1),
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      trainSec: num(r.trainSec, 30),
      building: buildingIdToCode.get(num(r.building)) ?? r.building, // 数字建筑ID → code
      traits: parseTraitRefs(r.traits, traitIdToCode),
      popCost: num(r.popCost, 1),
      popPermanent: num(r.popPermanent, 0) === 1,
    };
  }

  // 雇佣兵（tribe=merc）：解析 mercenaries.csv，合并进 config.units（key=code），
  // 强制 popCost=0/upkeep=0/cost*=0/trainSec=0（不经 military.TrainTroops，直接经 mercenary.Hire 金币购买）。
  // 覆盖层：与 units 同源，key='id'，numeric 含战斗属性 + goldCost。
  let mercRows = loadCsv(p('mercenaries.csv'));
  assertUniqueRows(mercRows, 'mercenaries.csv');
  if (overrides?.mercenaries) {
    mercRows = mergeOverridesIntoRows(mercRows, {
      file: 'mercenaries.csv', key: 'id',
      numeric: ['meleeAtk','rangedAtk','meleeDef','rangedDef','speed','carry','upkeep','goldCost','costWood','costClay','costIron','costCrop','trainSec','popCost'],
    }, overrides.mercenaries);
  }
  for (const r of mercRows) {
    const code = r.code?.trim();
    if (!code) continue;
    units[code] = {
      id: num(r.id), key: code, tribe: 'merc', name: r.name, icon: r.icon,
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef),
      speed: num(r.speed, 6), carry: num(r.carry), upkeep: 0,
      cost: { wood: 0, clay: 0, iron: 0, crop: 0 },
      trainSec: 0,
      building: '', // 雇佣兵不经训练建筑
      traits: parseTraitRefs(r.traits, traitIdToCode),
      popCost: 0,
      popPermanent: false,
      isMercenary: true,
      goldCost: num(r.goldCost, 0),
    };
  }

  // 雇佣兵营地刷新参数（merc_camp.csv）：level → MercCampLevel。覆盖层 key='level'。
  const mercCamp: Record<number, MercCampLevel> = {};
  let mercCampRows = loadCsv(p('merc_camp.csv'));
  if (overrides?.merc_camp) {
    mercCampRows = mergeOverridesIntoRows(mercCampRows, {
      file: 'merc_camp.csv', key: 'level',
      numeric: ['refreshSec','mercCount','maxStoredRefreshes'],
    }, overrides.merc_camp);
  }
  for (const r of mercCampRows) {
    const lv = num(r.level);
    if (lv <= 0) continue;
    mercCamp[lv] = {
      refreshSec: num(r.refreshSec, 3600),
      mercCount: num(r.mercCount, 3),
      maxStoredRefreshes: num(r.maxStoredRefreshes, 1),
    };
  }

  // PvE：主表 + 守军表 + 分布点，三表用数字目标ID互相引用，解析回 code
  const pveRows = loadCsv(p('pve_targets.csv'));
  assertUniqueRows(pveRows, 'pve_targets.csv');
  const pveTemplates: Record<string, PveTemplate> = {};
  const pveIdToCode = new Map<number, string>();
  for (const r of pveRows) {
    pveIdToCode.set(num(r.id), r.code);
    pveTemplates[r.code] = {
      id: num(r.id), type: r.code, name: r.name, icon: r.icon, respawnSec: num(r.respawnSec, 120),
      defender: {},
      loot: { wood: num(r.lootWood), clay: num(r.lootClay), iron: num(r.lootIron), crop: num(r.lootCrop) },
    };
  }
  for (const r of loadCsv(p('pve_defenders.csv'))) {
    const code = pveIdToCode.get(num(r.targetId));
    const tpl = code ? pveTemplates[code] : undefined;
    if (!tpl) throw new Error(`pve_defenders.csv targetId=${r.targetId} 不在 pve_targets.csv`);
    tpl.defender[r.unitCode] = {
      count: num(r.count),
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef),
      carry: num(r.carry),
    };
  }

  const spawnRows = loadCsv(p('pve_spawns.csv'));
  assertUniqueRows(spawnRows, 'pve_spawns.csv', 'id', 'id');
  const pveSpawns: PveSpawn[] = spawnRows.map((r) => ({
    id: r.id,
    type: pveIdToCode.get(num(r.targetId)) ?? r.targetId, // 数字目标ID → code
    q: num(r.q), r: num(r.r),
  }));

  // 全局常量表
  const raw: Record<string, number | boolean | string> = {};
  let constRows = loadCsv(p('game_constants.csv'));
  if (overrides?.constants) {
    // game_constants 的主键是 key，value/type 都可改（GM 保存路由以表名 'constants' 写入覆盖）
    constRows = mergeOverridesIntoRows(constRows, { file: 'game_constants.csv', key: 'key' }, overrides.constants);
  }
  for (const r of constRows) {
    if (!r.key) continue;
    raw[r.key] = parseConstantValue(r.value, r.type);
  }
  const cn = (k: string, def: number) => (typeof raw[k] === 'number' ? (raw[k] as number) : def);
  const constants: GameConstants = {
    wallBonusPerLevel: cn('wall_bonus_per_level', 0.03),
    smithyBonusPerLevel: cn('smithy_bonus_per_level', 0.1),
    smithyCostBase: cn('smithy_cost_base', 200),
    mainBuildSpeedupPerLevel: cn('main_build_speedup_per_level', 0.05),
    mainBuildSpeedupCap: cn('main_build_speedup_cap', 0.6),
    storageBase: cn('storage_base', 800),
    storageGrowthPerLevel: cn('storage_growth_per_level', 0.5),
    startResourceAmount: cn('start_resource_amount', 750),
    goldTaxPerCivilianPerHour: cn('gold_tax_per_civilian_per_hour', 1),
    startGoldAmount: cn('start_gold_amount', 100),
    baseProductionPerHour: cn('base_production_per_hour', 10),
    mapSize: cn('map_size', 20),
    mapViewRadius: cn('map_view_radius', 6),
    worldW: cn('world_width', 41),
    worldH: cn('world_height', 41),
    combatTickMs: cn('combat_tick_ms', 200),
    combatStrength: cn('combat_strength', 1),
    notificationsPerVillage: cn('notifications_per_village', 60),
    marchSpeedMultiplier: cn('march_speed_multiplier', 1),
    pveLootVariance: cn('pve_loot_variance', 0.2),
    popProsperityFullRatio: cn('pop_prosperity_full_ratio', 0.70),
    popOvercapPenaltyFullRatio: cn('pop_overcap_penalty_full_ratio', 2.0),
    popRaceMobilizeMax: {
      romans: cn('pop_race_mobilize_max_romans', 0.75),
      gauls: cn('pop_race_mobilize_max_gauls', 0.70),
      teutons: cn('pop_race_mobilize_max_teutons', 0.80),
    },
    popCropPerLabor: cn('pop_crop_per_labor', 1.0),
    popLaborFloor: cn('pop_labor_floor', 0.75),
    popDeathRateFactor: cn('pop_death_rate_factor', 0.5),
    popFamineTickSec: cn('pop_famine_tick_sec', 300),
    popHospitalRecoveryBase: cn('pop_hospital_recovery_base', 0.20),
    popHospitalRecoveryPerLevel: cn('pop_hospital_recovery_per_level', 0.10),
    popHospitalRecoveryMax: cn('pop_hospital_recovery_max', 0.80),
    smithyUpgradeSec: cn('smithy_upgrade_sec', 30),
    foundMinMainLevel: cn('found_min_main_level', 10),
    foundMinSoftLimit: cn('found_min_soft_limit', 350),
    foundSettlerCount: cn('found_settler_count', 3),
    foundResourceCostBase: cn('found_resource_cost_base', 3000),
    foundResourceCostGrowth: cn('found_resource_cost_growth', 2),
    foundMinTileDistance: cn('found_min_tile_distance', 3),
    foundMaxInflight: cn('found_max_inflight', 1),
    foundAbandonLockSec: cn('found_abandon_lock_sec', 86400),
    raw,
  };

  // 开局模板表（按部族）
  const templateRows = loadCsv(p('village_templates.csv'));
  assertUniqueRows(templateRows, 'village_templates.csv', 'tribe', 'tribe');
  const villageTemplates: Record<string, VillageTemplate> = {};
  for (const r of templateRows) {
    if (!r.tribe) continue;
    villageTemplates[r.tribe] = {
      tribe: r.tribe,
      startPlaced: parseLeveledList(r.start_placed),
      startResources: parseResourceList(r.start_resources),
    };
  }

  // mercCamp 缺级回退：从已解析的最高有效级向下复制，保证任意营地等级都能取到参数。
  const maxMercLv = Object.keys(mercCamp).map(Number).sort((a, b) => a - b);
  if (maxMercLv.length) {
    let last = mercCamp[maxMercLv[0]];
    for (let lv = 1; lv <= maxMercLv[maxMercLv.length - 1]; lv++) {
      if (mercCamp[lv]) last = mercCamp[lv];
      else mercCamp[lv] = { ...last };
    }
  }

  const config: GameConfig = {
    resources, buildings, townCenterSlots, units, unitTraits, pveTemplates, pveSpawns, constants, villageTemplates, mercCamp,
  };
  validateGameConfig(config);
  return config;
}

/**
 * 热重载入口：重新从目录加载整套配置（含 validateGameConfig 校验；失败抛出 Error）。
 * 配合 app.reloadConfig() 使用——先在此校验通过，再写回磁盘，避免半截配置。
 * overrides 来自 data/balance_overrides.json（玩家在 /gm/balance 的手动修改）。
 */
export function reloadGameConfig(configDir: string, overrides?: BalanceOverrides): GameConfig {
  return loadGameConfig(configDir, overrides);
}

/**
 * 启动期配置校验：把"运行时才暴露的错误"提前到启动失败，错误信息定位到表/字段。
 * 覆盖：跨表引用合法性、关键值范围、建筑 requires 循环依赖。
 * 任何错误抛出 Error（聚合所有问题一次性报出，便于一次改完）。
 */
export function validateGameConfig(config: GameConfig): void {
  const errors: string[] = [];
  const resourceKeys = new Set(config.resources.map((r) => r.key));
  const knownTribes = new Set(['romans', 'gauls', 'teutons']);

  // resources：必须含 economy 依赖的 4 种结构字段
  for (const need of ['wood', 'clay', 'iron', 'crop']) {
    if (!resourceKeys.has(need)) errors.push(`resources.csv 缺少必需资源 id=${need}（economy 结构字段）`);
  }

  // buildings：zone 合法；恰好一个 center；资源田产出字段；requires 引用存在；范围
  const buildingCodes = new Set(Object.keys(config.buildings));
  let centerCount = 0;
  let centerMaxLevel = 0;
  for (const b of Object.values(config.buildings)) {
    if (b.zone !== 'center' && b.zone !== 'inner' && b.zone !== 'outer') {
      errors.push(`buildings.csv[${b.kind}] zone=${b.zone} 必须是 center/inner/outer`);
    }
    if (b.zone === 'center') { centerCount++; centerMaxLevel = b.maxLevel; }
    if (b.resource !== undefined) {
      if (!resourceKeys.has(b.resource)) errors.push(`buildings.csv[${b.kind}] resource=${b.resource} 不在 resources.csv`);
      if (b.zone !== 'outer') errors.push(`buildings.csv[${b.kind}] 有产出(resource)必须归 outer 区`);
    }
    if (b.maxLevel <= 0) errors.push(`buildings.csv[${b.kind}] maxLevel 必须>0（当前${b.maxLevel}）`);
    // 逐等级参数（building_levels.csv）：必须覆盖 1..maxLevel；popCap≥0；prod 仅资源田且≥0
    for (let lv = 1; lv <= b.maxLevel; lv++) {
      const ld = b.levels[lv];
      if (!ld) {
        errors.push(`building_levels.csv[${b.kind}] 缺少 level=${lv}（需覆盖 1..${b.maxLevel}）`);
        continue;
      }
      if (ld.popCap < 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} popCap 不能为负`);
      if (b.resource !== undefined) {
        if (ld.prod === undefined || ld.prod < 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} 资源田 prod 必须≥0`);
      } else if (ld.prod !== undefined) {
        errors.push(`building_levels.csv[${b.kind}] level=${lv} 非资源田不应有 prod`);
      }
    }
    for (const r of b.requires) {
      if (!buildingCodes.has(r.kind)) errors.push(`buildings.csv[${b.kind}] requires 引用了不存在的建筑 ${r.kind}`);
      if (r.level <= 0) errors.push(`buildings.csv[${b.kind}] requires 等级必须>0`);
    }
    if (b.prosperityPerLevel < 0) errors.push(`buildings.csv[${b.kind}] prosperityPerLevel 必须≥0（当前${b.prosperityPerLevel}）`);
    if (b.popGrowthPerLevel < 0) errors.push(`buildings.csv[${b.kind}] popGrowthPerLevel 必须≥0（当前${b.popGrowthPerLevel}）`);
    if (b.kind === 'main' && b.popGrowthPerLevel <= 0) errors.push(`buildings.csv[main] popGrowthPerLevel 必须>0（人口增长绑在城镇中心上；当前${b.popGrowthPerLevel}）`);
  }
  if (centerCount !== 1) errors.push(`buildings.csv 必须恰好有一个 zone=center 的建筑（城镇中心），当前 ${centerCount} 个`);

  // town_center_slots：覆盖 1..城镇中心maxLevel；槽位单调不减；queue≥1
  if (centerMaxLevel > 0) {
    let prevInner = 0, prevOuter = 0;
    for (let lv = 1; lv <= centerMaxLevel; lv++) {
      const tier = config.townCenterSlots[lv];
      if (!tier) { errors.push(`town_center_slots.csv 缺少 tcLevel=${lv}（需覆盖 1..${centerMaxLevel}）`); continue; }
      if (tier.inner < prevInner) errors.push(`town_center_slots.csv tcLevel=${lv} innerSlots 比上一级小（须单调不减）`);
      if (tier.outer < prevOuter) errors.push(`town_center_slots.csv tcLevel=${lv} outerSlots 比上一级小（须单调不减）`);
      if (tier.queue < 1) errors.push(`town_center_slots.csv tcLevel=${lv} queueSlots 必须≥1`);
      prevInner = tier.inner; prevOuter = tier.outer;
    }
  }

  // 建筑 requires 循环依赖检测（DFS 找环）
  const cycle = findRequiresCycle(config.buildings);
  if (cycle) errors.push(`buildings.csv requires 存在循环依赖：${cycle.join(' → ')}`);

  // unit_traits：每个 effect 必须是已知枚举，且至少有一个效果
  const traitEffects = new Set<TraitEffect>(TRAIT_EFFECTS);
  const traitCodes = new Set(Object.keys(config.unitTraits));
  for (const t of Object.values(config.unitTraits)) {
    if (t.effects.length === 0) {
      errors.push(`unit_traits.csv[${t.code}] 没有任何效果（effect1 不能为空）`);
    }
    for (const e of t.effects) {
      if (!traitEffects.has(e.effect)) {
        errors.push(`unit_traits.csv[${t.code}] effect=${e.effect} 不是已知效果（${TRAIT_EFFECTS.join('/')}）`);
      }
    }
  }

  // units：所需建筑必须存在；form 枚举；traits 引用存在；范围
  for (const u of Object.values(config.units)) {
    if (!u.isMercenary && !knownTribes.has(u.tribe)) {
      errors.push(`units.csv[${u.key}] tribe=${u.tribe} 必须是 romans/gauls/teutons`);
    }
    if (u.building && !buildingCodes.has(u.building)) {
      errors.push(`units.csv[${u.key}] building=${u.building} 不在 buildings.csv`);
    }
    if (u.form !== 'melee' && u.form !== 'ranged') {
      errors.push(`units.csv[${u.key}] form=${u.form} 必须是 melee 或 ranged`);
    }
    for (const tc of u.traits) {
      if (!traitCodes.has(tc)) errors.push(`units.csv[${u.key}] traits 引用了不存在的特性 ${tc}`);
    }
    // 雇佣兵不走 military.TrainTroops（trainSec=0 合法），普通兵种仍要求 trainSec>0 防零除
    if (!u.isMercenary && u.trainSec <= 0) errors.push(`units.csv[${u.key}] trainSec 必须>0（防零除，当前${u.trainSec}）`);
    if (u.speed <= 0) errors.push(`units.csv[${u.key}] speed 必须>0（防零除，当前${u.speed}）`);
    if (u.popCost < 0) errors.push(`units.csv[${u.key}] popCost 必须≥0（当前${u.popCost}）`);
  }

  // pve：每个模板必须有守军；spawn 目标必须存在且坐标在地图内
  const pveCodes = new Set(Object.keys(config.pveTemplates));
  for (const p of Object.values(config.pveTemplates)) {
    if (Object.keys(p.defender).length === 0) errors.push(`pve_targets.csv[${p.type}] 没有任何守军（pve_defenders.csv 至少应有一行）`);
  }
  for (const s of config.pveSpawns) {
    if (!pveCodes.has(s.type)) errors.push(`pve_spawns.csv[${s.id}] targetId 指向的目标 ${s.type} 不在 pve_targets.csv`);
    if (!Number.isFinite(s.q) || !Number.isFinite(s.r)) {
      errors.push(`pve_spawns.csv[${s.id}] 坐标非数值`);
    }
    // 注：坐标可为负或超出 [0,W)×[0,H)，放置时 world.PlacePve 会按环面取模归一。
  }

  // village_templates：预置建筑 code 必须存在；资源覆盖 key 必须存在；开局预置不超 tcLevel=1 槽位
  const tier1 = config.townCenterSlots[1];
  for (const need of knownTribes) {
    if (!config.villageTemplates[need]) errors.push(`village_templates.csv 缺少部族模板 ${need}`);
  }
  for (const t of Object.values(config.villageTemplates)) {
    if (!knownTribes.has(t.tribe)) errors.push(`village_templates.csv[${t.tribe}] tribe 必须是 romans/gauls/teutons`);
    let innerUsed = 0, outerUsed = 0, centerUsed = 0;
    for (const code of Object.keys(t.startPlaced)) {
      const def = config.buildings[code];
      if (!def) { errors.push(`village_templates.csv[${t.tribe}] start_placed 含未知建筑 ${code}`); continue; }
      if (def.zone === 'center') centerUsed++;
      else if (def.zone === 'inner') innerUsed++;
      else outerUsed++;
    }
    if (centerUsed !== 1) errors.push(`village_templates.csv[${t.tribe}] 开局必须恰好含 1 个城镇中心(center)，当前 ${centerUsed}`);
    if (tier1) {
      if (innerUsed > tier1.inner) errors.push(`village_templates.csv[${t.tribe}] 开局城内预置 ${innerUsed} 超过 tcLevel=1 上限 ${tier1.inner}`);
      if (outerUsed > tier1.outer) errors.push(`village_templates.csv[${t.tribe}] 开局城外预置 ${outerUsed} 超过 tcLevel=1 上限 ${tier1.outer}`);
    }
    if (t.startResources) {
      for (const code of Object.keys(t.startResources)) {
        if (!resourceKeys.has(code)) errors.push(`village_templates.csv[${t.tribe}] start_resources 含未知资源 ${code}`);
      }
    }
  }

  // constants：关键范围
  const c = config.constants;
  if (c.mapSize <= 0) errors.push(`game_constants.csv map_size 必须>0`);
  if (c.mapViewRadius <= 0) errors.push(`game_constants.csv map_view_radius 必须>0`);
  if (c.worldW <= 0) errors.push(`game_constants.csv world_width 必须>0`);
  if (c.worldH <= 0) errors.push(`game_constants.csv world_height 必须>0`);
  if (c.mainBuildSpeedupCap < 0 || c.mainBuildSpeedupCap >= 1) errors.push(`game_constants.csv main_build_speedup_cap 必须在[0,1)`);
  if (c.storageBase <= 0) errors.push(`game_constants.csv storage_base 必须>0`);
  if (c.combatTickMs <= 0) errors.push(`game_constants.csv combat_tick_ms 必须>0`);
  if (c.combatStrength <= 0) errors.push(`game_constants.csv combat_strength 必须>0`);
  if (c.marchSpeedMultiplier <= 0) errors.push(`game_constants.csv march_speed_multiplier 必须>0`);
  if (c.notificationsPerVillage <= 0) errors.push(`game_constants.csv notifications_per_village 必须>0`);
  // 人口常量范围校验（硬上限模型）
  if (c.popProsperityFullRatio <= 0 || c.popProsperityFullRatio > 1) errors.push(`game_constants.csv pop_prosperity_full_ratio 必须在(0,1]`);
  if (c.popOvercapPenaltyFullRatio <= 1) errors.push(`game_constants.csv pop_overcap_penalty_full_ratio 必须>1（当前${c.popOvercapPenaltyFullRatio}）`);
  for (const [tribe, v] of Object.entries(c.popRaceMobilizeMax)) {
    if (v <= 0 || v > 1) {
      errors.push(`game_constants.csv pop_race_mobilize_max_${tribe} 必须在(0,1]（当前${v}）`);
    }
  }
  if (c.popCropPerLabor <= 0) errors.push(`game_constants.csv pop_crop_per_labor 必须>0（平民每小时口粮）`);
  if (c.popLaborFloor <= 0 || c.popLaborFloor > 1) errors.push(`game_constants.csv pop_labor_floor 必须在(0,1]`);
  if (c.popDeathRateFactor <= 0) errors.push(`game_constants.csv pop_death_rate_factor 必须>0`);
  if (c.popFamineTickSec <= 0) errors.push(`game_constants.csv pop_famine_tick_sec 必须>0`);
  if (c.popHospitalRecoveryBase < 0 || c.popHospitalRecoveryBase > 1) errors.push(`game_constants.csv pop_hospital_recovery_base 必须在[0,1]`);
  if (c.popHospitalRecoveryPerLevel < 0) errors.push(`game_constants.csv pop_hospital_recovery_per_level 必须≥0`);
  if (c.popHospitalRecoveryMax <= 0 || c.popHospitalRecoveryMax > 1) errors.push(`game_constants.csv pop_hospital_recovery_max 必须在(0,1]`);
  if (c.smithyUpgradeSec <= 0) errors.push(`game_constants.csv smithy_upgrade_sec 必须>0`);

  // 人口启动配置守卫：训练一个兵时，净粮食消耗不应下降（防止免费兵种）。
  // 推导：转化 1 名平民(popCost)为 1 个兵 → 释放平民口粮 popCost×popCropPerLabor，
  // 增加士兵口粮 popCost×(popCropPerLabor + upkeep)（默认口粮 + 军晌）；
  // 净变化 = popCost×upkeep ≥ 0（始终不降，除非 upkeep 为负）。
  // 故仅需守卫 upkeep ≥ 0（零资源零人口的特殊单位跳过）。
  for (const [key, u] of Object.entries(config.units)) {
    if (u.popCost <= 0 && u.upkeep <= 0) continue; // 特殊单位跳过
    if (u.upkeep < 0) {
      errors.push(
        `units.csv[${key}] 兵种 upkeep(${u.upkeep}) 不能为负`
      );
    }
  }

  if (errors.length) {
    throw new Error(`配置校验失败（共${errors.length}项）：\n  - ${errors.join('\n  - ')}`);
  }
}

/** DFS 检测建筑 requires 图中的环；返回环路径（含重复首节点）或 null。 */
function findRequiresCycle(buildings: Record<string, BuildingDef>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (node: string): void => {
    if (found) return;
    color[node] = GRAY;
    stack.push(node);
    for (const r of buildings[node]?.requires ?? []) {
      if (!buildings[r.kind]) continue; // 不存在的引用已在别处报错
      if (color[r.kind] === GRAY) {
        const i = stack.indexOf(r.kind);
        found = stack.slice(i).concat(r.kind);
        return;
      }
      if ((color[r.kind] ?? WHITE) === WHITE) visit(r.kind);
      if (found) return;
    }
    stack.pop();
    color[node] = BLACK;
  };

  for (const node of Object.keys(buildings)) {
    if ((color[node] ?? WHITE) === WHITE) visit(node);
    if (found) return found;
  }
  return null;
}
