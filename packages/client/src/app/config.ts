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
export interface BuildingInfo { name: string; icon: string }
export interface UnitInfo { name: string; icon: string; cat: string }
export interface PveInfo { name?: string; icon: string }

interface ServerConfig {
  resources: { key: string; name: string; icon: string }[];
  fields: { type: string; name: string; icon: string; resource: string }[];
  buildings: { kind: string; name: string; icon: string }[];
  units: { key: string; tribe: string; name: string; icon: string; cat: string }[];
  pveTemplates: { type: string; name: string; icon: string }[];
  constants: { mapViewRadius: number; mapSize: number };
}

let cfg: ServerConfig | null = null;
const res: Record<string, ResInfo> = {};
const fields: Record<string, FieldInfo> = {};
const buildings: Record<string, BuildingInfo> = {};
const units: Record<string, UnitInfo> = {};
const pve: Record<string, PveInfo> = {};

/** 拉取并缓存服务端配置。失败时静默回退到 info.ts 本地表。 */
export async function loadGameConfig(): Promise<void> {
  try {
    const r = await req('GetGameConfig');
    if (!r.ok) return;
    cfg = r.payload as unknown as ServerConfig;
    for (const x of cfg.resources) res[x.key] = { name: x.name, icon: x.icon };
    for (const x of cfg.fields) fields[x.type] = { name: x.name, icon: x.icon, resource: x.resource };
    for (const x of cfg.buildings) buildings[x.kind] = { name: x.name, icon: x.icon };
    for (const x of cfg.units) units[x.key] = { name: x.name, icon: x.icon, cat: x.cat };
    for (const x of cfg.pveTemplates) pve[x.type] = { name: x.name, icon: x.icon };
  } catch {
    /* 网络/协议异常 → 继续用 info.ts 回退 */
  }
}

/** 前端地图视野半径：服务端白名单常量优先，缺省 6。 */
export function mapViewRadius(): number {
  return cfg?.constants?.mapViewRadius ?? 6;
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
export function unitInfo(key: string): UnitInfo {
  return units[key] ?? fallback.UNIT_INFO[key] ?? { name: key, icon: `unit_${key}`, cat: 'infantry' };
}
/** PvE：服务端按 code 给名称/图标。地图 tile 只有 name 时按关键字猜测回退。 */
export function pveInfoByType(type: string): PveInfo | undefined {
  return pve[type] ?? (fallback.PVE_INFO[type] ? { icon: fallback.PVE_INFO[type].icon } : undefined);
}
/** 已知全部资源 key（服务端优先，回退木泥铁粮）。 */
export function resourceKeys(): string[] {
  return cfg ? cfg.resources.map((r) => r.key) : ['wood', 'clay', 'iron', 'crop'];
}
