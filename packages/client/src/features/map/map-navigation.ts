import type { Me } from '../../api.js';

export interface MapCoordinate {
  q: number;
  r: number;
}

/** 清理营地任务下发的地图坐标。已清理营地会保留在任务进度中，不能再用于导航。 */
export interface TaskCampCoordinate extends MapCoordinate {
  id: string;
  cleared?: boolean;
}

/** 返回仍需清理的营地，供任务卡坐标展示与“前往地图”复用同一判断。 */
export function pendingTaskCamps(camps: TaskCampCoordinate[] | null | undefined): TaskCampCoordinate[] {
  return (camps ?? []).filter((camp) => !camp.cleared);
}

export type CoordinateParseResult =
  | { ok: true; coordinate: MapCoordinate }
  | { ok: false; error: string };

/** 地图“回主城”的唯一坐标解析：优先 capitalVillageId，其次 isCapital，最后回退当前操作村。 */
export function capitalCoordinate(player: Me | null): MapCoordinate | null {
  if (!player) return null;
  const villages = player.villages ?? [];
  const capital = villages.find((v) => v.id === player.capitalVillageId)
    ?? villages.find((v) => v.isCapital);
  return capital ? { q: capital.q, r: capital.r } : { q: player.q, r: player.r };
}

/** 地图当前村定位：跟随会话当前操作村，不受主城位置影响。 */
export function currentVillageCoordinate(player: Me | null): MapCoordinate | null {
  return player ? { q: player.q, r: player.r } : null;
}

/** 当前操作村的显示名称；地图标签必须使用村名，而不是玩家名。 */
export function currentVillageName(player: Me | null): string | null {
  if (!player) return null;
  return player.villages?.find((v) => v.id === player.villageId)?.name ?? null;
}

/** 坐标跳转只接受地图内的整数，避免空值被 Number('') 误判成 0。 */
export function parseMapCoordinate(
  qRaw: string,
  rRaw: string,
  worldWidth: number,
  worldHeight: number,
): CoordinateParseResult {
  const q = Number(qRaw);
  const r = Number(rRaw);
  if (!qRaw.trim() || !rRaw.trim() || !Number.isInteger(q) || !Number.isInteger(r)) {
    return { ok: false, error: '请输入完整的整数坐标' };
  }
  if (q < 0 || q >= worldWidth || r < 0 || r >= worldHeight) {
    return { ok: false, error: `坐标范围：X 0–${worldWidth - 1}，Y 0–${worldHeight - 1}` };
  }
  return { ok: true, coordinate: { q, r } };
}
