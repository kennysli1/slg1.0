import type { SelectedTarget } from '../../app/store.js';

export interface OwnedVillageLocation {
  id: string;
  name: string;
  q: number;
  r: number;
}

/** 地图选择只是观察状态：定位并打开目标卡，绝不隐式改变当前操作村。 */
export function inspectOwnedVillage(
  village: OwnedVillageLocation,
  setCenter: (center: { q: number; r: number }) => void,
  setSelected: (target: SelectedTarget) => void,
): void {
  setCenter({ q: village.q, r: village.r });
  setSelected({ refId: village.id, kind: 'own_village', q: village.q, r: village.r, name: village.name, icon: 'map_player_village_lv1' });
}

/** 只有目标卡的确认按钮可进入这个分支，当前村则无需重复发请求。 */
export async function confirmOwnedVillage(
  villageId: string,
  currentVillageId: string | undefined,
  switcher: (id: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: boolean; error?: string }> {
  if (!villageId || villageId === currentVillageId) return { ok: true };
  return switcher(villageId);
}
