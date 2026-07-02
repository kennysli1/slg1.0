import { join } from 'node:path';
import { loadCsv, num } from './csv.js';
import { TRAIT_EFFECTS, type TraitEffect, type UnitForm, type UnitTraitDef } from './combat-types.js';

export type { UnitTraitDef } from './combat-types.js';

/**
 * 基础设施 · 配置注册表（GameConfig）
 * 启动时从 config/*.csv 加载所有游戏数据，解析成模块用的结构。
 * 模块不再硬编码 *_DEFS，而是从这里读 → 改 CSV 即改游戏，不改代码。
 *
 * 成本/时间用"基数×增长率^(等级-1)"参数化，CSV 里存基数和增长率。
 *
 * ── 主键与引用约定（2.0 配置规范）──────────────────────────────
 * 目录表(fields/buildings/units/pve_targets)每行有两个标识：
 *   · id   数字主键——CSV 里**跨表引用一律用它**（requires=4:3、building=4、targetId=1）。
 *   · code 英文代码——**引擎内部与存档统一用它**（避免 kind===5 这种魔法数字、CSV 重排不破坏代码）。
 * 加载时把 CSV 里的数字引用解析回 code，所以本文件之外的代码只见 code。
 * 资源(resources)与部族(tribe)主键保持语义串(wood/romans…)，它们是 economy/wire/存档的结构属性名。
 *
 * icon 列只填**基名**（如 bld_barracks）；渲染方拼 `<美术根>/<基名>.png`（前端 artPath）。
 */

export interface FieldDef {
  id: number;
  type: string; // code
  name: string;
  icon: string; // 基名
  resource: string;
  prodBase: number;
  prodGrowth: number;
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
}

export interface BuildingDef {
  id: number;
  kind: string; // code
  name: string;
  icon: string; // 基名
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
  requires: { kind: string; level: number }[]; // kind=code（由数字ID解析而来）
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

/** 开局模板：按部族定义田地布局/初始建筑/初始资源。来自 village_templates.csv。 */
export interface VillageTemplate {
  tribe: string;
  /** 展开后的田地类型序列（如 18 个 code） */
  fieldLayout: string[];
  /** 初始建筑 code -> 等级 */
  startBuildings: Record<string, number>;
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
  baseProductionPerHour: number;
  mapSize: number;
  mapViewRadius: number;
  /** 战斗每 tick 间隔(ms)：越小越平滑越费算力（08设计§4.4 的 dt）。 */
  combatTickMs: number;
  /** 战斗全局强度系数 k：越大减员越快、战斗越短（08设计§4.4 的 k）。 */
  combatStrength: number;
  /** 原始 key->value（含未被强类型收录的扩展项） */
  raw: Record<string, number | boolean | string>;
}

export interface GameConfig {
  resources: { key: string; name: string; icon: string }[];
  fields: Record<string, FieldDef>;
  buildings: Record<string, BuildingDef>;
  units: Record<string, UnitDef>;
  /** 兵种特性表（unit_traits.csv），按 code 索引。 */
  unitTraits: Record<string, UnitTraitDef>;
  pveTemplates: Record<string, PveTemplate>;
  pveSpawns: PveSpawn[];
  constants: GameConstants;
  villageTemplates: Record<string, VillageTemplate>;
}

function costFn(base: { wood: number; clay: number; iron: number; crop: number }, growth: number) {
  return (lv: number) => ({
    wood: Math.round(base.wood * Math.pow(growth, lv - 1)),
    clay: Math.round(base.clay * Math.pow(growth, lv - 1)),
    iron: Math.round(base.iron * Math.pow(growth, lv - 1)),
    crop: Math.round(base.crop * Math.pow(growth, lv - 1)),
  });
}

function timeFn(base: number, growth: number) {
  return (lv: number) => Math.round(base * Math.pow(growth, lv - 1));
}

/** 解析 game_constants.csv 的一行值（按 type 列转型）。 */
function parseConstantValue(raw: string, type: string): number | boolean | string {
  if (type === 'bool') return raw === 'true' || raw === '1';
  if (type === 'string') return raw;
  return num(raw);
}

/** 解析 "woodcutter*4|claypit*4" → ['woodcutter','woodcutter','woodcutter','woodcutter','claypit'...]。 */
function parseFieldLayout(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const part of s.split('|')) {
    const [code, cnt] = part.split('*');
    const n = num(cnt, 1);
    for (let i = 0; i < n; i++) out.push(code.trim());
  }
  return out;
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
 * 解析兵种 traits 列。逗号分隔的特性**数字ID**（如 "1,3"）；traitIdToCode 映射回 code。
 * 空则返回 []。
 */
function parseTraitRefs(s: string, traitIdToCode: Map<number, string>): string[] {
  if (!s) return [];
  return s.split(',').map((part) => {
    const idStr = part.trim();
    if (!idStr) return '';
    return traitIdToCode.get(num(idStr)) ?? idStr;
  }).filter(Boolean);
}

/** 从指定目录加载所有 CSV。configDir 默认指向仓库根的 config/。 */
export function loadGameConfig(configDir: string): GameConfig {
  const p = (f: string) => join(configDir, f);

  const resources = loadCsv(p('resources.csv')).map((r) => ({ key: r.id, name: r.name, icon: r.icon }));

  const fields: Record<string, FieldDef> = {};
  for (const r of loadCsv(p('fields.csv'))) {
    fields[r.code] = {
      id: num(r.id), type: r.code, name: r.name, icon: r.icon, resource: r.resource,
      prodBase: num(r.prodBase, 10), prodGrowth: num(r.prodGrowth, 1.3),
      cost: costFn({ wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) }, num(r.costGrowth, 1.28)),
      timeSec: timeFn(num(r.timeBase, 15), num(r.timeGrowth, 1.6)),
      maxLevel: num(r.maxLevel, 10),
    };
  }

  // 先读建筑原始行，建立 数字ID→code 映射，再解析 requires（前置也是数字ID引用）
  const buildingRows = loadCsv(p('buildings.csv'));
  const buildingIdToCode = new Map<number, string>();
  for (const r of buildingRows) buildingIdToCode.set(num(r.id), r.code);

  const buildings: Record<string, BuildingDef> = {};
  for (const r of buildingRows) {
    buildings[r.code] = {
      id: num(r.id), kind: r.code, name: r.name, icon: r.icon,
      cost: costFn({ wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) }, num(r.costGrowth, 1.28)),
      timeSec: timeFn(num(r.timeBase, 15), num(r.timeGrowth, 1.6)),
      maxLevel: num(r.maxLevel, 10),
      requires: parseRequires(r.requires, buildingIdToCode),
    };
  }

  // 兵种特性表：先解析，units 的 traits 列用数字 id 引用它，解析回 code
  const unitTraits: Record<string, UnitTraitDef> = {};
  const traitIdToCode = new Map<number, string>();
  for (const r of loadCsv(p('unit_traits.csv'))) {
    if (!r.code) continue;
    traitIdToCode.set(num(r.id), r.code);
    unitTraits[r.code] = {
      id: num(r.id), code: r.code, name: r.name,
      effect: r.effect as TraitEffect, value: num(r.value),
    };
  }

  const units: Record<string, UnitDef> = {};
  for (const r of loadCsv(p('units.csv'))) {
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
    };
  }

  // PvE：主表 + 守军表 + 分布点，三表用数字目标ID互相引用，解析回 code
  const pveTemplates: Record<string, PveTemplate> = {};
  const pveIdToCode = new Map<number, string>();
  for (const r of loadCsv(p('pve_targets.csv'))) {
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
    if (!tpl) continue;
    tpl.defender[r.unitCode] = {
      count: num(r.count),
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef),
      carry: num(r.carry),
    };
  }

  const pveSpawns: PveSpawn[] = loadCsv(p('pve_spawns.csv')).map((r) => ({
    id: r.id,
    type: pveIdToCode.get(num(r.targetId)) ?? r.targetId, // 数字目标ID → code
    q: num(r.q), r: num(r.r),
  }));

  // 全局常量表
  const raw: Record<string, number | boolean | string> = {};
  for (const r of loadCsv(p('game_constants.csv'))) {
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
    baseProductionPerHour: cn('base_production_per_hour', 10),
    mapSize: cn('map_size', 20),
    mapViewRadius: cn('map_view_radius', 6),
    combatTickMs: cn('combat_tick_ms', 200),
    combatStrength: cn('combat_strength', 1),
    raw,
  };

  // 开局模板表（按部族）
  const villageTemplates: Record<string, VillageTemplate> = {};
  for (const r of loadCsv(p('village_templates.csv'))) {
    if (!r.tribe) continue;
    villageTemplates[r.tribe] = {
      tribe: r.tribe,
      fieldLayout: parseFieldLayout(r.field_layout),
      startBuildings: parseLeveledList(r.start_buildings),
      startResources: parseResourceList(r.start_resources),
    };
  }

  const config: GameConfig = {
    resources, fields, buildings, units, unitTraits, pveTemplates, pveSpawns, constants, villageTemplates,
  };
  validateGameConfig(config);
  return config;
}

/**
 * 启动期配置校验：把"运行时才暴露的错误"提前到启动失败，错误信息定位到表/字段。
 * 覆盖：跨表引用合法性、关键值范围、建筑 requires 循环依赖。
 * 任何错误抛出 Error（聚合所有问题一次性报出，便于一次改完）。
 */
export function validateGameConfig(config: GameConfig): void {
  const errors: string[] = [];
  const resourceKeys = new Set(config.resources.map((r) => r.key));

  // resources：必须含 economy 依赖的 4 种结构字段
  for (const need of ['wood', 'clay', 'iron', 'crop']) {
    if (!resourceKeys.has(need)) errors.push(`resources.csv 缺少必需资源 id=${need}（economy 结构字段）`);
  }

  // fields：产出资源必须存在；范围
  for (const f of Object.values(config.fields)) {
    if (!resourceKeys.has(f.resource)) errors.push(`fields.csv[${f.type}] resource=${f.resource} 不在 resources.csv`);
    if (f.maxLevel <= 0) errors.push(`fields.csv[${f.type}] maxLevel 必须>0（当前${f.maxLevel}）`);
    if (f.prodBase < 0) errors.push(`fields.csv[${f.type}] prodBase 不能为负`);
  }

  // buildings：requires 引用必须存在；范围
  const buildingCodes = new Set(Object.keys(config.buildings));
  for (const b of Object.values(config.buildings)) {
    if (b.maxLevel <= 0) errors.push(`buildings.csv[${b.kind}] maxLevel 必须>0（当前${b.maxLevel}）`);
    for (const r of b.requires) {
      if (!buildingCodes.has(r.kind)) errors.push(`buildings.csv[${b.kind}] requires 引用了不存在的建筑 ${r.kind}`);
      if (r.level <= 0) errors.push(`buildings.csv[${b.kind}] requires 等级必须>0`);
    }
  }

  // 建筑 requires 循环依赖检测（DFS 找环）
  const cycle = findRequiresCycle(config.buildings);
  if (cycle) errors.push(`buildings.csv requires 存在循环依赖：${cycle.join(' → ')}`);

  // unit_traits：effect 必须是已知枚举
  const traitEffects = new Set<TraitEffect>(TRAIT_EFFECTS);
  const traitCodes = new Set(Object.keys(config.unitTraits));
  for (const t of Object.values(config.unitTraits)) {
    if (!traitEffects.has(t.effect)) {
      errors.push(`unit_traits.csv[${t.code}] effect=${t.effect} 不是已知效果（${TRAIT_EFFECTS.join('/')}）`);
    }
  }

  // units：所需建筑必须存在；form 枚举；traits 引用存在；范围
  for (const u of Object.values(config.units)) {
    if (u.building && !buildingCodes.has(u.building)) {
      errors.push(`units.csv[${u.key}] building=${u.building} 不在 buildings.csv`);
    }
    if (u.form !== 'melee' && u.form !== 'ranged') {
      errors.push(`units.csv[${u.key}] form=${u.form} 必须是 melee 或 ranged`);
    }
    for (const tc of u.traits) {
      if (!traitCodes.has(tc)) errors.push(`units.csv[${u.key}] traits 引用了不存在的特性 ${tc}`);
    }
    if (u.trainSec <= 0) errors.push(`units.csv[${u.key}] trainSec 必须>0（防零除，当前${u.trainSec}）`);
    if (u.speed <= 0) errors.push(`units.csv[${u.key}] speed 必须>0（防零除，当前${u.speed}）`);
  }

  // pve：守军挂在已知目标上（解析阶段已丢弃孤儿，这里校验 spawn 引用）；spawn 目标必须存在
  const pveCodes = new Set(Object.keys(config.pveTemplates));
  for (const s of config.pveSpawns) {
    if (!pveCodes.has(s.type)) errors.push(`pve_spawns.csv[${s.id}] targetId 指向的目标 ${s.type} 不在 pve_targets.csv`);
  }

  // village_templates：田地/建筑 code 必须存在；资源覆盖 key 必须存在
  for (const t of Object.values(config.villageTemplates)) {
    for (const code of new Set(t.fieldLayout)) {
      if (!config.fields[code]) errors.push(`village_templates.csv[${t.tribe}] field_layout 含未知田地 ${code}`);
    }
    for (const code of Object.keys(t.startBuildings)) {
      if (!buildingCodes.has(code)) errors.push(`village_templates.csv[${t.tribe}] start_buildings 含未知建筑 ${code}`);
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
  if (c.mainBuildSpeedupCap < 0 || c.mainBuildSpeedupCap >= 1) errors.push(`game_constants.csv main_build_speedup_cap 必须在[0,1)`);
  if (c.storageBase <= 0) errors.push(`game_constants.csv storage_base 必须>0`);

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
