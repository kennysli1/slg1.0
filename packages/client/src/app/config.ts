import { req } from '../api.js';
import * as fallback from '../info.js';

/**
 * 前端配置缓存层（SSOT 客户端侧）。
 * 启动时拉一次服务端 GetGameConfig，缓存名称/图标/分类映射；
 * 渲染层只调这里的 *Info() 取展示数据 —— 服务端有就用服务端，否则回退 info.ts。
 *
 * 好处：仅在 CSV 新增兵种/建筑/PvE，前端无需改代码即可正确显示名称与分类。
 */

export interface ResInfo { name: string; icon: string }
export interface FieldInfo { name: string; icon: string; resource?: string }
export interface BuildingInfo { name: string; icon: string; zone?: string; resource?: string; desc?: string; effect?: string; popCapPerLevel?: number; popCapByLevel?: number[] }
export interface UnitInfo { name: string; icon: string; form: string; popCost: number; upkeep?: number; isMercenary?: boolean }
export interface MercenaryInfo { name: string; icon: string; form: string; meleeAtk: number; rangedAtk: number; meleeDef: number; rangedDef: number; speed: number; carry: number; goldCost: number }
export interface PveInfo { name?: string; icon: string }

interface ServerConfig {
  resources: { key: string; name: string; icon: string }[];
  buildings: { kind: string; name: string; icon: string; zone: string; resource: string | null; desc?: string; effect?: string; popCapPerLevel: number; popCapByLevel: number[] }[];
  units: { key: string; tribe: string; name: string; icon: string; form: string; popCost?: number; upkeep?: number; isMercenary?: boolean }[];
  /** 雇佣兵清单（tribe=merc）：含完整战斗属性 + 金币单价。 */
  mercenaries: { key: string; name: string; icon: string; form: string; meleeAtk: number; rangedAtk: number; meleeDef: number; rangedDef: number; speed: number; carry: number; goldCost: number }[];
  pveTemplates: { type: string; name: string; icon: string }[];
  constants: {
    mapViewRadius: number; mapSize: number; worldW: number; worldH: number;
    goldTaxPerCivilianPerHour: number; startGoldAmount: number; popCropPerLabor: number;
    /** 仓储容量：base×(1+Σ等级×growth)，仓库→木泥铁 / 粮仓→粮。 */
    storageBase: number; storageGrowthPerLevel: number;
    /** 铁匠每级全军攻防加成系数（ratio=1+等级×该值）。 */
    smithyBonusPerLevel: number;
    /** 城墙每级守城防御加成系数（ratio=1+等级×该值）。 */
    wallBonusPerLevel: number;
    /** 医院战死回收比例：min(max, base+等级×perLevel)。 */
    popHospitalRecoveryBase: number; popHospitalRecoveryPerLevel: number; popHospitalRecoveryMax: number;
    /** 军事建筑每级训练提速/降费（前端按建筑等级展示固定减幅，与兵种无关）。 */
    trainTimeReducePerLevel: number; trainTimeReduceCap: number;
    trainCostReducePerLevel: number; trainCostReduceCap: number;
  };
}

let cfg: ServerConfig | null = null;
const res: Record<string, ResInfo> = {};
const fields: Record<string, FieldInfo> = {};
const buildings: Record<string, BuildingInfo> = {};
const units: Record<string, UnitInfo> = {};
const mercenaries: Record<string, MercenaryInfo> = {};
const pve: Record<string, PveInfo> = {};

/** 拉取并缓存服务端配置。失败时静默回退到 info.ts 本地表。 */
export async function loadGameConfig(): Promise<void> {
  try {
    const r = await req('GetGameConfig');
    if (!r.ok) return;
    cfg = r.payload as unknown as ServerConfig;
    for (const x of cfg.resources) res[x.key] = { name: x.name, icon: x.icon };
    for (const x of cfg.buildings) {
      buildings[x.kind] = { name: x.name, icon: x.icon, zone: x.zone, resource: x.resource ?? undefined, desc: x.desc, effect: x.effect, popCapPerLevel: x.popCapPerLevel, popCapByLevel: x.popCapByLevel };
      // 资源田同时并入 fields 表，让沿用 fieldInfo 的旧渲染路径继续工作
      if (x.resource) fields[x.kind] = { name: x.name, icon: x.icon, resource: x.resource };
    }
    for (const x of cfg.units) units[x.key] = { name: x.name, icon: x.icon, form: x.form, popCost: x.popCost ?? 1, upkeep: x.upkeep ?? 0, isMercenary: !!x.isMercenary };
    for (const x of (cfg.mercenaries ?? [])) mercenaries[x.key] = { name: x.name, icon: x.icon, form: x.form, meleeAtk: x.meleeAtk, rangedAtk: x.rangedAtk, meleeDef: x.meleeDef, rangedDef: x.rangedDef, speed: x.speed, carry: x.carry, goldCost: x.goldCost };
    for (const x of cfg.pveTemplates) pve[x.type] = { name: x.name, icon: x.icon };
  } catch {
    /* 网络/协议异常 → 继续用 info.ts 回退 */
  }
}

/** 前端地图视野半径：服务端白名单常量优先，缺省 6。 */
export function mapViewRadius(): number {
  return cfg?.constants?.mapViewRadius ?? 6;
}

/** 地图总半径（服务端 map_size），用于边界检测。 */
export function mapSize(): number {
  return cfg?.constants?.mapSize ?? 20;
}

/** 环绕平行四边形世界宽（axial q 周期 worldW），默认 41。 */
export function worldW(): number {
  return cfg?.constants?.worldW ?? 41;
}

/** 环绕平行四边形世界高（axial r 周期 worldH），默认 41。 */
export function worldH(): number {
  return cfg?.constants?.worldH ?? 41;
}

export function resInfo(key: string): ResInfo {
  return res[key] ?? fallback.RES_INFO[key] ?? { name: key, icon: 'res_wood' };
}
export function fieldInfo(type: string): FieldInfo {
  return fields[type] ?? fallback.FIELD_INFO[type] ?? { name: type, icon: 'field_woodcutter' };
}
export function buildingInfo(kind: string): BuildingInfo {
  return buildings[kind] ?? fallback.BUILDING_INFO[kind] ?? { name: kind, icon: 'bld_main' };
}
/** 建筑每级提供的人口上限基数（popCapPerLevel）；缺省 0（非人口建筑）。 */
export function buildingPopCapPerLevel(kind: string): number {
  return buildingInfo(kind).popCapPerLevel ?? 0;
}
export function unitInfo(key: string): UnitInfo {
  if (units[key]) {
    const u = units[key];
    return { name: u.name, icon: u.icon, form: u.form, popCost: u.isMercenary ? 0 : (u.popCost ?? 1), upkeep: u.upkeep ?? 0, isMercenary: !!u.isMercenary };
  }
  const fb = fallback.UNIT_INFO[key];
  const isMerc = key.startsWith('merc_');
  if (fb) return { ...fb, popCost: isMerc ? 0 : 1, upkeep: 0, isMercenary: isMerc };
  return { name: key, icon: `unit_${key}`, form: 'melee', popCost: 1, upkeep: 0, isMercenary: isMerc };
}
/** 雇佣兵详情（含金币单价 + 战斗属性）；仅 merc_* 兵种有。 */
export function mercenaryInfo(key: string): MercenaryInfo | undefined {
  return mercenaries[key];
}
/** PvE：服务端按 code 给名称/图标。地图 tile 只有 name 时按关键字猜测回退。 */
export function pveInfoByType(type: string): PveInfo | undefined {
  return pve[type] ?? (fallback.PVE_INFO[type] ? { icon: fallback.PVE_INFO[type].icon } : undefined);
}
/** 已知全部资源 key（服务端优先，回退木泥铁粮）。 */
export function resourceKeys(): string[] {
  return cfg ? cfg.resources.map((r) => r.key) : ['wood', 'clay', 'iron', 'crop'];
}

/** 金币：每个劳动人口每小时交税额（绑定城镇中心，不受繁荣度影响）。 */
export function goldTaxPerCivilianPerHour(): number {
  return cfg?.constants?.goldTaxPerCivilianPerHour ?? 1;
}
/** 金币：新村初始金币存量。 */
export function startGoldAmount(): number {
  return cfg?.constants?.startGoldAmount ?? 100;
}
/** 每个劳动人口/士兵每小时默认口粮（平民与士兵基础耗粮同源）。 */
export function popCropPerLabor(): number {
  return cfg?.constants?.popCropPerLabor ?? 1;
}
/** 单个兵（popCost 份人口）每小时耗粮 = popCost×(默认口粮 + upkeep)。 */
export function unitCropPerHour(key: string): number {
  const u = unitInfo(key);
  const base = popCropPerLabor();
  const upkeep = u.upkeep ?? 0;
  const popCost = u.popCost ?? 1;
  return popCost * (base + upkeep);
}

// ---------- 建筑"功能/提供"展示用常量（服务端白名单下发） ----------

/** 全部白名单常量（详情弹窗计算仓储上限/加成用）；未加载返回 null。 */
export function gameConstants(): ServerConfig['constants'] | null {
  return cfg?.constants ?? null;
}
/** 仓库/粮仓基础容量（base×(1+Σ等级×growth) 中的 base）。 */
export function storageBase(): number {
  return cfg?.constants?.storageBase ?? 800;
}
/** 仓库/粮仓每级容量增长系数。 */
export function storageGrowthPerLevel(): number {
  return cfg?.constants?.storageGrowthPerLevel ?? 0.5;
}
/** 铁匠每级全军攻防加成系数。 */
export function smithyBonusPerLevel(): number {
  return cfg?.constants?.smithyBonusPerLevel ?? 0.1;
}
/** 城墙每级守城防御加成系数。 */
export function wallBonusPerLevel(): number {
  return cfg?.constants?.wallBonusPerLevel ?? 0.03;
}
/** 医院战死回收：基础比例。 */
export function popHospitalRecoveryBase(): number {
  return cfg?.constants?.popHospitalRecoveryBase ?? 0.2;
}
/** 医院战死回收：每级额外比例。 */
export function popHospitalRecoveryPerLevel(): number {
  return cfg?.constants?.popHospitalRecoveryPerLevel ?? 0.1;
}
/** 医院战死回收：比例上限。 */
export function popHospitalRecoveryMax(): number {
  return cfg?.constants?.popHospitalRecoveryMax ?? 0.8;
}
/** 军事建筑每级训练提速比例（cap∈[0,1)）；前端按比例显示固定减幅。 */
export function trainTimeReducePerLevel(): number {
  return cfg?.constants?.trainTimeReducePerLevel ?? 0.05;
}
/** 军事建筑训练提速比例上限（cap∈[0,1)）。 */
export function trainTimeReduceCap(): number {
  return cfg?.constants?.trainTimeReduceCap ?? 0.6;
}
/** 军事建筑每级训练降费比例（cap∈[0,1)）；前端按比例显示固定减幅。 */
export function trainCostReducePerLevel(): number {
  return cfg?.constants?.trainCostReducePerLevel ?? 0.03;
}
/** 军事建筑训练降费比例上限（cap∈[0,1)）。 */
export function trainCostReduceCap(): number {
  return cfg?.constants?.trainCostReduceCap ?? 0.5;
}
