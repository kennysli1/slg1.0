interface UnitCardStatValues {
  meleeAtk?: unknown;
  rangedAtk?: unknown;
  meleeDef?: unknown;
  rangedDef?: unknown;
  speed?: unknown;
}

interface UnitCardStatSource extends UnitCardStatValues {
  form?: string;
  baseStats?: UnitCardStatValues;
}

function finiteValue(primary: unknown, fallback: unknown): number {
  const preferred = Number(primary);
  if (Number.isFinite(preferred)) return preferred;
  const legacy = Number(fallback);
  return Number.isFinite(legacy) ? legacy : 0;
}

/** 训练卡只展示 CSV 基础属性；旧服务端没有 baseStats 时兼容回退原字段。 */
export function unitCardBaseStats(unit: UnitCardStatSource): { attack: number; defense: number; speed: number } {
  const ranged = unit.form === 'ranged';
  const base = unit.baseStats;
  return {
    attack: Math.round(ranged
      ? finiteValue(base?.rangedAtk, unit.rangedAtk)
      : finiteValue(base?.meleeAtk, unit.meleeAtk)),
    defense: Math.round(ranged
      ? finiteValue(base?.rangedDef, unit.rangedDef)
      : finiteValue(base?.meleeDef, unit.meleeDef)),
    speed: Math.round(finiteValue(base?.speed, unit.speed)),
  };
}
