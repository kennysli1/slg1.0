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
  return m.ownerPlayerName ? `${m.ownerPlayerName} 的军队` : '敌方军队';
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
