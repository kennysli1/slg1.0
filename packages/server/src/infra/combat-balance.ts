/**
 * 战斗数值的公共口径。
 *
 * 这里不计算特性价值。特性是战术层的独立预算，只在战斗结算时改变
 * 实际攻击、防御或承伤；基础战斗价值只看兵种面板与人口占用。
 */

export interface CombatValueStats {
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  hp?: number;
  popCost?: number;
}

export interface CombatInfluenceConfig {
  referenceValue: number;
  qualityExponent: number;
  minQuality: number;
  maxQuality: number;
  meleeAttackWeight: number;
  rangedAttackWeight: number;
  meleeDefenseWeight: number;
  rangedDefenseWeight: number;
  hpWeight: number;
}

export interface CombatValueBreakdown {
  popCost: number;
  attackValue: number;
  defenseValue: number;
  baseCombatValue: number;
  valuePerPopulation: number;
  attackQuality: number;
  defenseQuality: number;
  quality: number;
  influencePerUnit: number;
}

/** 面板价值 200/人口、攻防质量以同一基准折半归一。 */
export const DEFAULT_COMBAT_INFLUENCE_CONFIG: CombatInfluenceConfig = {
  referenceValue: 200,
  qualityExponent: 1.15,
  minQuality: 0.65,
  maxQuality: 1.55,
  meleeAttackWeight: 1,
  rangedAttackWeight: 1.1,
  meleeDefenseWeight: 0.85,
  rangedDefenseWeight: 0.75,
  hpWeight: 0.65,
};

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function axisQuality(axisValue: number, popCost: number, config: CombatInfluenceConfig): number {
  const reference = positive(config.referenceValue, DEFAULT_COMBAT_INFLUENCE_CONFIG.referenceValue) / 2;
  const exponent = positive(config.qualityExponent, DEFAULT_COMBAT_INFLUENCE_CONFIG.qualityExponent);
  const min = Math.max(0, Number(config.minQuality) || DEFAULT_COMBAT_INFLUENCE_CONFIG.minQuality);
  const max = Math.max(min, Number(config.maxQuality) || DEFAULT_COMBAT_INFLUENCE_CONFIG.maxQuality);
  return clamp(Math.pow(Math.max(0, axisValue) / (popCost * reference), exponent), min, max);
}

/**
 * 计算基础战斗价值。
 * rangedAtk 的权重略高于 meleeAtk，因为远程可以在接触前制造伤亡；
 * 防御权重略低于攻击，生命值作为跨攻击类型的稳定耐久池。
 */
export function combatValue(stats: CombatValueStats, config: CombatInfluenceConfig = DEFAULT_COMBAT_INFLUENCE_CONFIG): CombatValueBreakdown {
  const popCost = Math.max(1, Number(stats.popCost) || 1);
  const meleeAttackWeight = positive(config.meleeAttackWeight, 1);
  const rangedAttackWeight = positive(config.rangedAttackWeight, 1.1);
  const meleeDefenseWeight = positive(config.meleeDefenseWeight, 0.85);
  const rangedDefenseWeight = positive(config.rangedDefenseWeight, 0.75);
  const hpWeight = positive(config.hpWeight, 0.65);
  const attackValue = Math.max(0, Number(stats.meleeAtk) || 0) * meleeAttackWeight
    + Math.max(0, Number(stats.rangedAtk) || 0) * rangedAttackWeight;
  const defenseValue = Math.max(0, Number(stats.meleeDef) || 0) * meleeDefenseWeight
    + Math.max(0, Number(stats.rangedDef) || 0) * rangedDefenseWeight
    + Math.max(0, Number(stats.hp) || 0) * hpWeight;
  const baseCombatValue = attackValue + defenseValue;
  const valuePerPopulation = baseCombatValue / popCost;
  const reference = positive(config.referenceValue, DEFAULT_COMBAT_INFLUENCE_CONFIG.referenceValue);
  const exponent = positive(config.qualityExponent, DEFAULT_COMBAT_INFLUENCE_CONFIG.qualityExponent);
  const min = Math.max(0, Number(config.minQuality) || DEFAULT_COMBAT_INFLUENCE_CONFIG.minQuality);
  const max = Math.max(min, Number(config.maxQuality) || DEFAULT_COMBAT_INFLUENCE_CONFIG.maxQuality);
  const quality = clamp(Math.pow(valuePerPopulation / reference, exponent), min, max);
  return {
    popCost,
    attackValue,
    defenseValue,
    baseCombatValue,
    valuePerPopulation,
    attackQuality: axisQuality(attackValue, popCost, config),
    defenseQuality: axisQuality(defenseValue, popCost, config),
    quality,
    influencePerUnit: popCost * quality,
  };
}

export function combatInfluence(stats: CombatValueStats, config: CombatInfluenceConfig = DEFAULT_COMBAT_INFLUENCE_CONFIG): number {
  return combatValue(stats, config).influencePerUnit;
}
