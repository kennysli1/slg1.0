/**
 * 远弦圣地地图公开投影。
 *
 * 这是一个纯函数模块：基础 HexMap 不读取圣地状态。只有独立的圣地覆盖层
 * 在服务端明确返回活动投影后才会调用它，dormant 阶段永远返回空标记。
 */

export interface SanctumMapMarker {
  id: string;
  kind: 'condition' | 'sanctum';
  name: string;
  q: number;
  r: number;
}

const VISIBLE_PHASES = new Set(['active', 'sanctum_hidden', 'sanctum_active', 'relic_in_transit']);

function sanctumPoint(value: any): { q: number; r: number } | null {
  const point = value?.point ?? value?.location ?? value;
  const q = Number(point?.q);
  const r = Number(point?.r);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
}

/** 只把服务端已公开的活动目标转成地图标记，不读取 site 或 private clues。 */
export function sanctumMapMarkersFromState(snapshot: any): SanctumMapMarker[] {
  const state = snapshot?.event && typeof snapshot.event === 'object' ? { ...snapshot, ...snapshot.event } : snapshot;
  const phase = String(state?.phase ?? '').trim().toLowerCase();
  if (!state || !VISIBLE_PHASES.has(phase)) return [];

  const out: SanctumMapMarker[] = [];
  const seen = new Set<string>();
  for (const target of (Array.isArray(state.publicTargets) ? state.publicTargets : [])) {
    if (!target || target.status === 'removed') continue;
    const point = sanctumPoint(target);
    if (!point) continue;
    const id = String(target.id ?? target.conditionId ?? target.code ?? `${point.q},${point.r}`);
    const key = `condition:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      kind: 'condition',
      name: typeof target.name === 'string' && target.name ? target.name : '远弦条件',
      ...point,
    });
  }

  const visibleSanctum = state.sanctum;
  const point = sanctumPoint(visibleSanctum);
  if (visibleSanctum && point) {
    out.push({
      id: String(visibleSanctum.id ?? visibleSanctum.sanctumId ?? 'farstring-sanctum'),
      kind: 'sanctum',
      name: typeof visibleSanctum.name === 'string' && visibleSanctum.name ? visibleSanctum.name : '远弦圣地',
      ...point,
    });
  }
  return out;
}
