import { join } from 'node:path';
import { loadCsv, num } from './csv.js';

/**
 * 基础设施 · 配置注册表（GameConfig）
 * 启动时从 config/*.csv 加载所有游戏数据，解析成模块用的结构。
 * 模块不再硬编码 *_DEFS，而是从这里读 → 改 CSV 即改游戏，不改代码。
 *
 * 成本/时间用"基数×增长率^(等级-1)"参数化，CSV 里存基数和增长率。
 */

export interface FieldDef {
  type: string;
  name: string;
  icon: string;
  resource: string;
  prodBase: number;
  prodGrowth: number;
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
}

export interface BuildingDef {
  kind: string;
  name: string;
  icon: string;
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
  requires: { kind: string; level: number }[];
}

export interface UnitDef {
  key: string;
  tribe: string;
  name: string;
  icon: string;
  cat: 'infantry' | 'cavalry' | 'scout' | 'siege' | 'admin' | 'settler';
  atk: number;
  defInf: number;
  defCav: number;
  speed: number;
  carry: number;
  upkeep: number;
  cost: Record<string, number>;
  trainSec: number;
  building: string;
}

export interface PveTemplate {
  type: string;
  name: string;
  icon: string;
  defender: Record<string, { count: number; atk: number; defInf: number; defCav: number; carry: number }>;
  loot: Record<string, number>;
  respawnSec: number;
}

export interface PveSpawn {
  id: string;
  type: string;
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

function parseRequires(s: string): { kind: string; level: number }[] {
  // 格式 "barracks:3" 或多个用 "|" 分隔 "a:1|b:2"；空则无前置
  if (!s) return [];
  return s.split('|').map((part) => {
    const [kind, lv] = part.split(':');
    return { kind: kind.trim(), level: num(lv, 1) };
  });
}

/** 从指定目录加载所有 CSV。configDir 默认指向仓库根的 config/。 */
export function loadGameConfig(configDir: string): GameConfig {
  const p = (f: string) => join(configDir, f);

  const resources = loadCsv(p('resources.csv')).map((r) => ({ key: r.key, name: r.name, icon: r.icon }));

  const fields: Record<string, FieldDef> = {};
  for (const r of loadCsv(p('fields.csv'))) {
    fields[r.type] = {
      type: r.type, name: r.name, icon: r.icon, resource: r.resource,
      prodBase: num(r.prodBase, 10), prodGrowth: num(r.prodGrowth, 1.3),
      cost: costFn({ wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) }, num(r.costGrowth, 1.28)),
      timeSec: timeFn(num(r.timeBase, 15), num(r.timeGrowth, 1.6)),
      maxLevel: num(r.maxLevel, 10),
    };
  }

  const buildings: Record<string, BuildingDef> = {};
  for (const r of loadCsv(p('buildings.csv'))) {
    buildings[r.kind] = {
      kind: r.kind, name: r.name, icon: r.icon,
      cost: costFn({ wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) }, num(r.costGrowth, 1.28)),
      timeSec: timeFn(num(r.timeBase, 15), num(r.timeGrowth, 1.6)),
      maxLevel: num(r.maxLevel, 10),
      requires: parseRequires(r.requires),
    };
  }

  const units: Record<string, UnitDef> = {};
  for (const r of loadCsv(p('units.csv'))) {
    units[r.key] = {
      key: r.key, tribe: r.tribe || 'romans', name: r.name, icon: r.icon, cat: r.cat as UnitDef['cat'],
      atk: num(r.atk), defInf: num(r.defInf), defCav: num(r.defCav),
      speed: num(r.speed, 6), carry: num(r.carry), upkeep: num(r.upkeep, 1),
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      trainSec: num(r.trainSec, 30), building: r.building,
    };
  }

  // PvE：主表 + 守军表合并
  const pveTemplates: Record<string, PveTemplate> = {};
  for (const r of loadCsv(p('pve_targets.csv'))) {
    pveTemplates[r.type] = {
      type: r.type, name: r.name, icon: r.icon, respawnSec: num(r.respawnSec, 120),
      defender: {},
      loot: { wood: num(r.lootWood), clay: num(r.lootClay), iron: num(r.lootIron), crop: num(r.lootCrop) },
    };
  }
  for (const r of loadCsv(p('pve_defenders.csv'))) {
    const tpl = pveTemplates[r.targetType];
    if (!tpl) continue;
    tpl.defender[r.unitKey] = { count: num(r.count), atk: num(r.atk), defInf: num(r.defInf), defCav: num(r.defCav), carry: num(r.carry) };
  }

  const pveSpawns: PveSpawn[] = loadCsv(p('pve_spawns.csv')).map((r) => ({ id: r.id, type: r.type, x: num(r.x), y: num(r.y) }));

  return { resources, fields, buildings, units, pveTemplates, pveSpawns };
}
