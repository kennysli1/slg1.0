/** 地图选格辅助：他国军队 / 己方驻扎军与格子坐标的对应关系。 */
import type { ForeignArmy, Movement } from '@slg/shared';
import { getCache } from '../../app/state.js';
import { foreignMoves } from '../../app/store.js';
import type { SelectedTarget } from '../../app/store.js';
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

function canonicalGrid(q: number, r: number): { q: number; r: number } {
  const W = worldW(), H = worldH();
  return {
    q: W > 0 ? ((q % W) + W) % W : q,
    r: H > 0 ? ((r % H) + H) % H : r,
  };
}

/** 与地图图标动画使用同一离散口径：图标中心跨过六边形边界后即属于下一格。 */
export function displayGridForMovement(
  movement: { pos?: { q: number; r: number }; path?: Array<{ q: number; r: number }>; stepIndex?: number; status?: string; nextStepAt?: number; perStepMs?: number; heading?: { q: number; r: number } | null },
  now = Date.now(),
): { q: number; r: number } | null {
  const pos = movement.pos;
  if (!pos) return null;
  if (movement.status !== 'marching' || !movement.nextStepAt || !movement.perStepMs) return canonicalGrid(pos.q, pos.r);
  const t = Math.max(0, Math.min(1, 1 - (movement.nextStepAt - now) / movement.perStepMs));
  const path = movement.path;
  const index = Number.isInteger(movement.stepIndex) ? Number(movement.stepIndex) : 0;
  const next = path?.[index + 1] ?? (movement.heading ? { q: pos.q + movement.heading.q, r: pos.r + movement.heading.r } : undefined);
  if (!next) return canonicalGrid(pos.q, pos.r);
  const q = pos.q + wrapDelta(next.q - pos.q, worldW()) * t;
  const r = pos.r + wrapDelta(next.r - pos.r, worldH()) * t;
  // pointy-top axial cube rounding; ties resolve to the next cell at the midpoint.
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // 地图是环面：跨越 0/世界宽度边界时，像素仍落在规范格子的副本上，
  // 但 cube rounding 会暂时得到 W/H 之外的坐标。目标栈必须使用规范坐标，
  // 否则商队会被视为在一个没有地块和其他目标的“幽灵格”上。
  return canonicalGrid(rq, rr);
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
  // 商队是移动记录而不是地块实体。目标选择器将其标记为 caravan，
  // 但为了兼容 TargetPanel 既有的 own/enemy movement 分支，仍返回原来的
  // army 外壳；关键是必须按 ID 锁定，不能回退到同格第一支军队。
  const ownMove = selection.kind === 'own_army' || selection.kind === 'caravan'
    ? own.find((m) => m.id === selection.refId)
    : undefined;
  const foreignMove = selection.kind === 'enemy_army' || selection.kind === 'caravan'
    ? foreign.find((m) => m.id === selection.refId)
    : undefined;
  if (ownMove) return { kind: 'own_army', movement: ownMove };
  if (foreignMove) return { kind: 'enemy_army', movement: foreignMove };
  if (selection.kind === 'own_army' || selection.kind === 'enemy_army' || selection.kind === 'caravan') return null;
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
  for (const m of ownMovementsFromCache()) {
    const grid = displayGridForMovement(m, Date.now());
    if (grid?.q === q && grid?.r === r) return m;
  }
  return null;
}

/** 己方驻扎在野外的军队（不含返程/来袭方向）。 */
export function ownStationedMoveAt(q: number, r: number): Movement | null {
  for (const m of ownMovementsFromCache()) {
    if (m.dir === 'in') continue;
    if (m.status !== 'stationed') continue;
    if (m.pos?.q === q && m.pos?.r === r) return m;
  }
  return null;
}

/**
 * 地图用的己方行军联合快照。
 *
 * `ListMovements` 只覆盖当前操作村，而 `ListPlayerMovements` 覆盖玩家所有村；
 * 两者在刷新和推送期间可能短暂不同步，不能使用 `a ?? b`（空数组也会短路）。
 * 按 movement id 合并后，既保留跨村军队，也不会因某个快照暂时为空而漏掉同格目标。
 */
export function ownMovementsFromCache(): Movement[] {
  const byId = new Map<string, Movement>();
  // 玩家级快照补齐跨村行军；当前村快照对重复 movement 保留优先权，
  // 避免并行刷新时较旧的 ListPlayer 响应覆盖当前村的最新位置。
  for (const movement of getCache().playerMoves?.movements ?? []) {
    if (movement?.id) byId.set(movement.id, movement);
  }
  for (const movement of getCache().moves?.movements ?? []) {
    if (movement?.id) byId.set(movement.id, movement);
  }
  return [...byId.values()];
}

/** 预警也来自两个范围不同的快照，按 movement id 去重后供地图目标栈使用。 */
export function ownIncomingWarningsFromCache(): any[] {
  const byId = new Map<string, any>();
  for (const warning of getCache().playerMoves?.incomingWarnings ?? []) {
    if (warning?.id) byId.set(warning.id, warning);
  }
  for (const warning of getCache().moves?.incomingWarnings ?? []) {
    if (warning?.id) byId.set(warning.id, warning);
  }
  return [...byId.values()];
}

/**
 * 根据同一屏幕格收集所有可交互目标。这里把“目标身份按 movement id”与
 * “同格地块始终保留”放在一个纯函数里，避免点击处理再次只返回最上层商队。
 */
export function collectMapTargetStack(
  baseTarget: SelectedTarget,
  q: number,
  r: number,
  clickedOwn: Movement | undefined,
  clickedForeign: ForeignArmy | undefined,
  clickedIncoming: any | undefined,
  ownAt: Movement[],
  foreignAt: ForeignArmy[],
  incomingAt: any[],
): { active: SelectedTarget; targets: SelectedTarget[] } {
  const targetForOwn = (movement: Movement): SelectedTarget => ({
    refId: movement.id,
    kind: movement.caravan ? 'caravan' : 'own_army',
    q, r,
    name: movement.caravan ? `商队 → ${movement.caravan.destinationVillageName}` : '己方军队',
  });
  const targetForForeign = (movement: ForeignArmy): SelectedTarget => ({
    refId: movement.id,
    kind: movement.caravan ? 'caravan' : 'enemy_army',
    q, r,
    name: foreignArmyName(movement),
  });
  const targetForIncoming = (warning: any): SelectedTarget => ({ refId: warning.id, kind: 'incoming_warning', q, r, name: '来袭军队' });
  const targets: SelectedTarget[] = [];
  const pushUnique = (target: SelectedTarget) => {
    if (!targets.some((entry) => entry.kind === target.kind && entry.refId === target.refId)) targets.push(target);
  };
  if (clickedOwn) pushUnique(targetForOwn(clickedOwn));
  if (clickedForeign) pushUnique(targetForForeign(clickedForeign));
  if (clickedIncoming) pushUnique(targetForIncoming(clickedIncoming));
  pushUnique(baseTarget);
  ownAt.forEach((movement) => pushUnique(targetForOwn(movement)));
  foreignAt.forEach((movement) => pushUnique(targetForForeign(movement)));
  incomingAt.forEach((warning) => pushUnique(targetForIncoming(warning)));
  const active = clickedOwn
    ? targetForOwn(clickedOwn)
    : clickedForeign
      ? targetForForeign(clickedForeign)
      : clickedIncoming
        ? targetForIncoming(clickedIncoming)
        : baseTarget;
  return { active, targets };
}
