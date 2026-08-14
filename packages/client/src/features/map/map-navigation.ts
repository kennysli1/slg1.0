import type { Me } from '../../api.js';

export interface MapCoordinate {
  q: number;
  r: number;
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
