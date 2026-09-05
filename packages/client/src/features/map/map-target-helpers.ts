/** 地图选格辅助：他国军队 / 己方驻扎军与格子坐标的对应关系。 */
import type { ForeignArmy, Movement } from '@slg/shared';
import { getCache } from '../../app/state.js';
import { foreignMoves } from '../../app/store.js';

export function foreignArmyAt(q: number, r: number): ForeignArmy | null {
  for (const m of foreignMoves.value?.movements ?? []) {
    if (m.pos?.q === q && m.pos?.r === r) return m;
  }
  return null;
}

export function foreignArmyName(m: ForeignArmy): string {
  if (m.caravan) return `${m.ownerPlayerName ? `${m.ownerPlayerName} 的` : ''}商队 → ${m.caravan.destinationVillageName}`;
  return m.ownerPlayerName ? `${m.ownerPlayerName} 的军队` : '敌方军队';
}

/** 标记点击锁定行军 ID；目标离开后不能自动选中占据旧格子的另一支军队。 */
export function selectedMapMovement(
  selection: { kind: string; refId: string; q: number; r: number },
  own: Movement[], foreign: ForeignArmy[],
): { kind: 'own_army'; movement: Movement } | { kind: 'enemy_army'; movement: ForeignArmy } | null {
  const ownMove = selection.kind === 'own_army' ? own.find((m) => m.id === selection.refId) : undefined;
  const foreignMove = selection.kind === 'enemy_army' ? foreign.find((m) => m.id === selection.refId) : undefined;
  if (ownMove) return { kind: 'own_army', movement: ownMove };
  if (foreignMove) return { kind: 'enemy_army', movement: foreignMove };
  if (selection.kind === 'own_army' || selection.kind === 'enemy_army') return null;
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
    if (m.pos?.q === q && m.pos?.r === r) return m;
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
