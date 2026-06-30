import { join } from 'node:path';
import { loadCsv, num } from './csv.js';

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
  cat: 'infantry' | 'cavalry' | 'scout' | 'siege' | 'admin' | 'settler';
  atk: number;
  defInf: number;
  defCav: number;
  speed: number;
  carry: number;
  upkeep: number;
  cost: Record<string, number>;
  trainSec: number;
  building: string; // 所需建筑 code（由数字ID解析而来）
}

export interface PveTemplate {
  id: number;
  type: string; // code
  name: string;
  icon: string; // 基名
  defender: Record<string, { count: number; atk: number; defInf: number; defCav: number; carry: number }>;
  loot: Record<string, number>;
  respawnSec: number;
}

export interface PveSpawn {
  id: string;
  type: string; // pve 目标 code（由数字ID解析而来）
  x: number;
  y: number;
}

export interface GameConfig {
  resources: { key: string; name: string; icon: string }[];
  fields: Record<string, FieldDef>;
  buildings: Record<string, BuildingDef>;
  units: Record<string, UnitDef>;
  pveTemplates: Record<string, PveTemplate>;
  pveSpawns: PveSpawn[];
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

  const units: Record<string, UnitDef> = {};
  for (const r of loadCsv(p('units.csv'))) {
    units[r.code] = {
      id: num(r.id), key: r.code, tribe: r.tribe || 'romans', name: r.name, icon: r.icon, cat: r.cat as UnitDef['cat'],
      atk: num(r.atk), defInf: num(r.defInf), defCav: num(r.defCav),
      speed: num(r.speed, 6), carry: num(r.carry), upkeep: num(r.upkeep, 1),
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      trainSec: num(r.trainSec, 30),
      building: buildingIdToCode.get(num(r.building)) ?? r.building, // 数字建筑ID → code
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
    tpl.defender[r.unitCode] = { count: num(r.count), atk: num(r.atk), defInf: num(r.defInf), defCav: num(r.defCav), carry: num(r.carry) };
  }

  const pveSpawns: PveSpawn[] = loadCsv(p('pve_spawns.csv')).map((r) => ({
    id: r.id,
    type: pveIdToCode.get(num(r.targetId)) ?? r.targetId, // 数字目标ID → code
    x: num(r.x), y: num(r.y),
  }));

  return { resources, fields, buildings, units, pveTemplates, pveSpawns };
}
