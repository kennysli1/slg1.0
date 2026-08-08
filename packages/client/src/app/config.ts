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
export interface UnitInfo { name: string; icon: string; form: string; popCost: number; isMercenary?: boolean }
export interface MercenaryInfo { name: string; icon: string; form: string; meleeAtk: number; rangedAtk: number; meleeDef: number; rangedDef: number; speed: number; carry: number; goldCost: number }
export interface PveInfo { name?: string; icon: string }

interface ServerConfig {
  resources: { key: string; name: string; icon: string }[];
  buildings: { kind: string; name: string; icon: string; zone: string; resource: string | null; desc?: string; effect?: string; popCapPerLevel: number; popCapByLevel: number[] }[];
  units: { key: string; tribe: string; name: string; icon: string; form: string; popCost?: number; isMercenary?: boolean }[];
  /** 雇佣兵清单（tribe=merc）：含完整战斗属性 + 金币单价。 */
  mercenaries: { key: string; name: string; icon: string; form: string; meleeAtk: number; rangedAtk: number; meleeDef: number; rangedDef: number; speed: number; carry: number; goldCost: number }[];
  pveTemplates: { type: string; name: string; icon: string }[];
  constants: { mapViewRadius: number; mapSize: number; worldW: number; worldH: number; goldTaxPerCivilianPerHour: number; startGoldAmount: number };
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
    for (const x of cfg.units) units[x.key] = { name: x.name, icon: x.icon, form: x.form, popCost: x.popCost ?? 1, isMercenary: !!x.isMercenary };
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
    return { name: u.name, icon: u.icon, form: u.form, popCost: u.isMercenary ? 0 : (u.popCost ?? 1), isMercenary: !!u.isMercenary };
  }
  const fb = fallback.UNIT_INFO[key];
  const isMerc = key.startsWith('merc_');
  if (fb) return { ...fb, popCost: isMerc ? 0 : 1, isMercenary: isMerc };
  return { name: key, icon: `unit_${key}`, form: 'melee', popCost: 1, isMercenary: isMerc };
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
