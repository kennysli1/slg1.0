/**
 * 王国工作区的本地展开偏好。
 *
 * 这不是游戏数据：仅按玩家与当前操作村写入浏览器，切村、刷新和快照更新
 * 都不会误改另一座村的工作区状态。
 */

export interface VillageWorkbenchPreferences {
  developmentOpen: boolean;
  militaryOpen: boolean;
}

export type VillageWorkbenchLayout =
  | 'both-closed'
  | 'development-open'
  | 'military-open'
  | 'both-open';

/** Toggle one workbench without changing the other one. */
export function toggleVillageWorkbench(
  preferences: VillageWorkbenchPreferences,
  field: keyof VillageWorkbenchPreferences,
): VillageWorkbenchPreferences {
  return { ...preferences, [field]: !preferences[field] };
}

/**
 * Resolve the workbench geometry from state, rather than asking CSS to infer
 * it from descendants. This keeps the one-open layouts full width and makes
 * the four interaction states straightforward to test.
 */
export function villageWorkbenchLayoutClass(
  preferences: Pick<VillageWorkbenchPreferences, 'developmentOpen' | 'militaryOpen'>,
): `empire-workspace-grid--${VillageWorkbenchLayout}` {
  const { developmentOpen, militaryOpen } = preferences;
  const layout: VillageWorkbenchLayout = developmentOpen
    ? militaryOpen ? 'both-open' : 'development-open'
    : militaryOpen ? 'military-open' : 'both-closed';
  return `empire-workspace-grid--${layout}`;
}

export interface VillageWorkbenchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'kow.village-workbench.';

const DEFAULT_PREFERENCES: VillageWorkbenchPreferences = {
  developmentOpen: false,
  militaryOpen: false,
};

export function villageWorkbenchStorageKey(playerId: string, villageId: string): string {
  return `${PREFIX}${playerId || 'guest'}.${villageId || 'unknown'}`;
}

export function readVillageWorkbenchPreferences(
  playerId: string,
  villageId: string,
  storage?: VillageWorkbenchStorage,
): VillageWorkbenchPreferences {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = target.getItem(villageWorkbenchStorageKey(playerId, villageId));
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_PREFERENCES };
    const value = parsed as Record<string, unknown>;
    return {
      developmentOpen: value.developmentOpen === true,
      militaryOpen: value.militaryOpen === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeVillageWorkbenchPreferences(
  playerId: string,
  villageId: string,
  preferences: VillageWorkbenchPreferences,
  storage?: VillageWorkbenchStorage,
): void {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return;
  try {
    target.setItem(villageWorkbenchStorageKey(playerId, villageId), JSON.stringify({
      developmentOpen: preferences.developmentOpen === true,
      militaryOpen: preferences.militaryOpen === true,
    }));
  } catch {
    // 隐私模式或存储额度不足时只保留当前页面的展开状态。
  }
}
