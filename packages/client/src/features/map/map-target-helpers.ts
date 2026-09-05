/** 地图选格辅助：他国军队 / 己方驻扎军与格子坐标的对应关系。 */
import type { ForeignArmy, Movement } from '@slg/shared';
import { getCache } from '../../app/state.js';
import { foreignMoves } from '../../app/store.js';
import { worldW, worldH } from '../../app/config.js';

export function foreignArmyAt(q: number, r: number): ForeignArmy | null {
  for (const m of foreignMoves.value?.movements ?? []) {
    const grid = displayGridForMovement(m, Date.now());
    if (grid?.q === q && grid?.r === r) return m;
  }
  return null;
}

function wrapDelta(value: number, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return value;
  if (value > size / 2) return value - size;
  if (value < -size / 2) return value + size;
  return value;
}

/** 与地图图标动画使用同一离散口径：图标中心跨过六边形边界后即属于下一格。 */
export function displayGridForMovement(
  movement: { pos?: { q: number; r: number }; path?: Array<{ q: number; r: number }>; stepIndex?: number; status?: string; nextStepAt?: number; perStepMs?: number; heading?: { q: number; r: number } | null },
  now = Date.now(),
): { q: number; r: number } | null {
  const pos = movement.pos;
  if (!pos) return null;
  if (movement.status !== 'marching' || !movement.nextStepAt || !movement.perStepMs) return { q: pos.q, r: pos.r };
  const t = Math.max(0, Math.min(1, 1 - (movement.nextStepAt - now) / movement.perStepMs));
  const path = movement.path;
  const index = Number.isInteger(movement.stepIndex) ? Number(movement.stepIndex) : 0;
  const next = path?.[index + 1] ?? (movement.heading ? { q: pos.q + movement.heading.q, r: pos.r + movement.heading.r } : undefined);
  if (!next) return { q: pos.q, r: pos.r };
  const q = pos.q + wrapDelta(next.q - pos.q, worldW()) * t;
  const r = pos.r + wrapDelta(next.r - pos.r, worldH()) * t;
  // pointy-top axial cube rounding; ties resolve to the next cell at the midpoint.
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function foreignArmyName(m: ForeignArmy): string {
  if (m.caravan) return `${m.ownerPlayerName ? `${m.ownerPlayerName} 的` : ''}商队 → ${m.caravan.destinationVillageName}`;
  return m.ownerPlayerName ? `${m.ownerPlayerName} 的军队` : '敌方军队';
}

/** 标记点击锁定行军 ID；目标离开后不能自动选中占据旧格子的另一支军队。 */
export function selectedMapMovement(
  selection: { kind: string; refId: string; q: number; r: number; stackedTargets?: unknown[] },
  own: Movement[], foreign: ForeignArmy[],
): { kind: 'own_army'; movement: Movement } | { kind: 'enemy_army'; movement: ForeignArmy } | null {
  const ownMove = selection.kind === 'own_army' ? own.find((m) => m.id === selection.refId) : undefined;
  const foreignMove = selection.kind === 'enemy_army' ? foreign.find((m) => m.id === selection.refId) : undefined;
  if (ownMove) return { kind: 'own_army', movement: ownMove };
  if (foreignMove) return { kind: 'enemy_army', movement: foreignMove };
  if (selection.kind === 'own_army' || selection.kind === 'enemy_army') return null;
  // 同格目标选择器中的村庄/营地是明确目标，不能再次被旧的“按坐标找军队”
  // 兜底逻辑抢走，否则用户无法从叠放列表切回底层地块。
  if (selection.stackedTargets?.length) return null;
  const at = (m: { pos: { q: number; r: number } }) => m.pos?.q === selection.q && m.pos?.r === selection.r;
  const foe = foreign.find(at);
  if (foe) return { kind: 'enemy_army', movement: foe };
  const friendly = own.find(at);
  return friendly ? { kind: 'own_army', movement: friendly } : null;
}

/** 自己关联商队只提供护送；发令时服务端再次验证权限。 */
export function caravanAction(caravan?: { canRaid: boolean; canEscort: boolean }): 'caravan_raid' | 'caravan_escort' | null {
  return caravan?.canEscort ? 'caravan_escort' : caravan?.canRaid ? 'caravan_raid' : null;
}

/** 仅己方附着护送军队并列显示；不改变地图位置与路线。 */
export function escortMarkerOffset(move: { escortAttached?: boolean }): number {
  return move.escortAttached ? 25 : 0;
}

/** 地图跨村展示的己方军队；与当前村庄军队页的 moves 快照分开。 */
export function ownArmyAt(q: number, r: number): Movement | null {
  for (const m of getCache().playerMoves?.movements ?? []) {
    const grid = displayGridForMovement(m, Date.now());
    if (grid?.q === q && grid?.r === r) return m;
  }
  return null;
}

/** 己方驻扎在野外的军队（不含返程/来袭方向）。 */
export function ownStationedMoveAt(q: number, r: number): Movement | null {
  for (const m of getCache().playerMoves?.movements ?? getCache().moves?.movements ?? []) {
    if (m.dir === 'in') continue;
    if (m.status !== 'stationed') continue;
    if (m.pos?.q === q && m.pos?.r === r) return m;
  }
  return null;
}
