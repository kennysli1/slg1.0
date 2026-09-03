interface UnitCardStatValues {
  attack?: unknown;
  defense?: unknown;
  hp?: unknown;
  speed?: unknown;
}

interface UnitCardStatSource extends UnitCardStatValues {
  baseStats?: UnitCardStatValues;
}

function finiteValue(primary: unknown, fallback: unknown): number {
  const preferred = Number(primary);
  if (Number.isFinite(preferred)) return preferred;
  const legacy = Number(fallback);
  return Number.isFinite(legacy) ? legacy : 0;
}

/** 训练卡只展示 CSV 基础属性；最终属性由服务端用于实际战斗。 */
export function unitCardBaseStats(unit: UnitCardStatSource): { attack: number; defense: number; hp: number; speed: number } {
  const base = unit.baseStats;
  return {
    attack: Math.round(finiteValue(base?.attack, unit.attack)),
    defense: Math.round(finiteValue(base?.defense, unit.defense)),
    hp: Math.round(finiteValue(base?.hp, unit.hp)),
    speed: Math.round(finiteValue(base?.speed, unit.speed)),
  };
}
