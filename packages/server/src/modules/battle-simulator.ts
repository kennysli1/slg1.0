import type { Command, CommandResult } from '@slg/shared';
import type { GameConfig } from '../infra/config.js';
import type { TraitEffect, UnitForm } from '../infra/combat-types.js';
import { combatValue } from '../infra/combat-balance.js';
import type { CommandBus } from '../infra/command-bus.js';

/**
 * 独立的阶段化战斗模拟器。
 *
 * 这是一个无状态实验模块：输入来自请求，兵种/特性目录来自 CSV 解析后的
 * GameConfig，绝不读取 Store，也不调用 combat/movement/pve 等领域模块。
 * 因此修改模拟器不会改变线上战斗结算或已有存档。
 */

export type SimulatorMode = 'ambush' | 'raid' | 'field' | 'siege';

export interface SimulatorTechModifiers {
  meleeAtkPct?: number;
  rangedAtkPct?: number;
  meleeDefPct?: number;
  rangedDefPct?: number;
  hpPct?: number;
}

export interface SimulatorSideInput {
  troops: Record<string, number>;
  tech?: SimulatorTechModifiers;
  /** 从 research.csv 选择的科技 code；与手工 tech 加成叠加并按 cap 截断。 */
  research?: string[];
  treasures?: string[];
  wallLevel?: number;
  wallBonusPct?: number;
}

export interface BattleSimulationInput {
  mode: SimulatorMode;
  attacker: SimulatorSideInput;
  defender: SimulatorSideInput;
  seed?: number;
}

interface StatSet {
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  hp: number;
}

interface SimStack {
  code: string;
  name: string;
  form: UnitForm;
  count: number;
  hp: number;
  isCavalry: boolean;
  isScout: boolean;
  stats: UnitDefLike;
  /** 基于兵种基础面板的非线性战斗质量；特性不计入此值。 */
  combatQuality: number;
  attackQuality: number;
  defenseQuality: number;
  influencePerUnit: number;
  traits: TraitSource[];
}

interface UnitDefLike {
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  hp: number;
  popCost: number;
}

interface TraitSource {
  code: string;
  name: string;
  effects: { effect: TraitEffect; value: number }[];
}

interface SideState {
  stacks: SimStack[];
  input: SimulatorSideInput;
  tech: Required<SimulatorTechModifiers>;
  treasure: TreasureModifiers;
  /** 伏击模式的进攻方全攻击倍率；其它模式为 0。 */
  modeAttackPct: number;
}

interface TreasureModifiers {
  atkPct: number;
  defPct: number;
  enemyCavalryDefPct: number;
}

interface TraitAssignment {
  sourceSide: 'attacker' | 'defender';
  sourceCode: string;
  sourceTrait: string;
  effect: TraitEffect;
  targetSide: 'attacker' | 'defender';
  targetCode: string | null;
  assigned: number;
  value: number;
  wasted: number;
}

interface StepResult {
  name: string;
  description: string;
  before: { attacker: Record<string, number>; defender: Record<string, number> };
  after: { attacker: Record<string, number>; defender: Record<string, number> };
  attackerStats: Record<string, StatSet>;
  defenderStats: Record<string, StatSet>;
  damageToAttacker: number;
  damageToDefender: number;
  /** 本步骤结算前的聚合攻防与伤亡池，便于复盘公式而不必从单兵数值反推。 */
  attackPower: { attacker: number; defender: number };
  defensePower: { attacker: number; defender: number };
  healthPool: { attacker: number; defender: number };
  lossesToAttacker: number;
  lossesToDefender: number;
  lossRatioToAttacker: number;
  lossRatioToDefender: number;
  traitAssignments: TraitAssignment[];
  notes: string[];
}

export interface BattleSimulationReport {
  mode: SimulatorMode;
  seed: number;
  winner: 'attacker' | 'defender' | 'draw';
  stages: { name: string; steps: StepResult[] }[];
  final: { attacker: Record<string, number>; defender: Record<string, number> };
  totals: { attacker: number; defender: number };
  rules: {
    damageFormula: 'A²/(A+D)';
    populationInfluence: 'effectivePopulation=count×popCost×quality';
    qualityExponent: number;
    referenceValue: number;
    meleeRounds: number;
    damageCoefficients: { cavalryVsCavalry: number; cavalryVsMelee: number; cavalryVsRanged: number; rangedStrike: number; meleeRound: number };
    traitStacking: 'additive';
    lossRounding: 'ceil';
    minSurvivorUnits: number;
    wallBonusPerLevel: number;
  };
}

interface CatalogUnit {
  code: string;
  name: string;
  tribe: string;
  form: UnitForm;
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  hp: number;
  popCost: number;
  traits: { code: string; name: string; effects: { effect: TraitEffect; value: number }[] }[];
  isCavalry: boolean;
  isScout: boolean;
  source: 'unit' | 'merc' | 'npc';
}

function clampPct(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function cloneCounts(side: SideState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stack of side.stacks) if (stack.count > 0) out[stack.code] = (out[stack.code] ?? 0) + stack.count;
  return out;
}

function totalCount(side: SideState): number {
  return side.stacks.reduce((sum, stack) => sum + Math.max(0, stack.count), 0);
}

function hasForm(side: SideState, form: UnitForm, includeCavalry = true): boolean {
  return side.stacks.some((stack) => stack.count > 0 && stack.form === form && (includeCavalry || !stack.isCavalry));
}

function stacksFor(side: SideState, predicate: (stack: SimStack) => boolean): SimStack[] {
  return side.stacks.filter((stack) => stack.count > 0 && predicate(stack));
}

function statMultiplier(base: number, extra: number): number {
  return Math.max(0, base * Math.max(0, 1 + extra));
}

function createRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function isScoutCode(code: string): boolean {
  return /(^|_)(scout|pathfinder|equlegati)(_|$)/i.test(code)
    || code === 'equlegati' || code === 'pathfinder' || code === 'teuscout';
}

function buildTreasureModifiers(config: GameConfig, codes: string[] | undefined): TreasureModifiers {
  const out: TreasureModifiers = { atkPct: 0, defPct: 0, enemyCavalryDefPct: 0 };
  for (const code of Array.isArray(codes) ? codes : []) {
    const treasure = config.treasures[code];
    if (!treasure) continue;
    const value = Number(treasure.effectValue) / 100;
    if (treasure.effectType === 'atkMult' || treasure.effectType === 'victoryFlag' || treasure.effectType === 'blackBadge') out.atkPct += value;
    if (treasure.effectType === 'defMult' || treasure.effectType === 'honestHeart' || treasure.effectType === 'blackBadge') out.defPct += value;
    if (treasure.effectType === 'enemyCavalryDef') out.enemyCavalryDefPct += value;
  }
  return out;
}

function combatInfluenceConfig(config: GameConfig) {
  return {
    referenceValue: config.constants.combatInfluenceReferenceValue,
    qualityExponent: config.constants.combatInfluenceQualityExponent,
    minQuality: config.constants.combatInfluenceMinQuality,
    maxQuality: config.constants.combatInfluenceMaxQuality,
    meleeAttackWeight: config.constants.combatValueMeleeAttackWeight,
    rangedAttackWeight: config.constants.combatValueRangedAttackWeight,
    meleeDefenseWeight: config.constants.combatValueMeleeDefenseWeight,
    rangedDefenseWeight: config.constants.combatValueRangedDefenseWeight,
    hpWeight: config.constants.combatValueHpWeight,
  };
}

function buildTechModifiers(config: GameConfig, side: SimulatorSideInput): Required<SimulatorTechModifiers> {
  const tech: Required<SimulatorTechModifiers> = {
    meleeAtkPct: clampPct(side.tech?.meleeAtkPct), rangedAtkPct: clampPct(side.tech?.rangedAtkPct),
    meleeDefPct: clampPct(side.tech?.meleeDefPct), rangedDefPct: clampPct(side.tech?.rangedDefPct), hpPct: clampPct(side.tech?.hpPct),
  };
  const selected = Array.isArray(side.research) ? side.research : [];
  const caps: Record<string, number> = {};
  for (const code of selected) {
    const def = config.research[String(code)];
    if (!def) continue;
    for (const effect of def.effects ?? []) {
      if (effect.effectType !== 'combat_atk' && effect.effectType !== 'combat_def') continue;
      const key = effect.effectType === 'combat_atk'
        ? (effect.effectKey === 'form:ranged' ? 'rangedAtkPct' : 'meleeAtkPct')
        : (effect.effectKey === 'form:ranged' ? 'rangedDefPct' : 'meleeDefPct');
      const capKey = `${effect.effectType}:${effect.effectKey}`;
      const next = (tech as any)[key] + Number(effect.effectValue || 0);
      const cap = Number(effect.cap);
      (tech as any)[key] = Number.isFinite(cap) && cap > 0 ? Math.min(next, caps[capKey] ?? cap) : next;
      caps[capKey] = Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
    }
  }
  return tech;
}

function unitCatalog(config: GameConfig): CatalogUnit[] {
  const result: CatalogUnit[] = [];
  for (const unit of Object.values(config.units)) {
    result.push({
      code: unit.key, name: unit.name, tribe: unit.tribe, form: unit.form,
      meleeAtk: unit.meleeAtk, rangedAtk: unit.rangedAtk, meleeDef: unit.meleeDef, rangedDef: unit.rangedDef,
      hp: Math.max(1, unit.hp),
      popCost: Math.max(0, unit.popCost),
      traits: [...unit.traits, ...(unit.simTraits ?? [])].map((code) => config.unitTraits[code]).filter(Boolean).map((trait) => ({ code: trait.code, name: trait.name, effects: trait.effects })),
      isCavalry: config.constants.cavalryUnitCodes.includes(unit.key), isScout: isScoutCode(unit.key), source: unit.isMercenary ? 'merc' : 'unit',
    });
  }
  for (const template of Object.values(config.pveTemplates)) {
    for (const [code, def] of Object.entries(template.defender)) {
      // PvE templates may reuse the same base unit code with different
      // values. Keep every template entry selectable instead of silently
      // collapsing it into the player/mercenary unit catalog entry.
      const catalogCode = `npc:${template.type}:${code}`;
      result.push({
        code: catalogCode, name: `${template.name} · ${code}`, tribe: `npc:${template.type}`, form: def.form,
        meleeAtk: def.meleeAtk, rangedAtk: def.rangedAtk, meleeDef: def.meleeDef, rangedDef: def.rangedDef,
        hp: Math.max(1, def.hp ?? 100),
        popCost: Math.max(0, config.units[code]?.popCost ?? 1),
        traits: (def.traitCodes ?? []).map((traitCode) => config.unitTraits[traitCode]).filter(Boolean).map((trait) => ({ code: trait.code, name: trait.name, effects: trait.effects })),
        isCavalry: config.constants.cavalryUnitCodes.includes(code), isScout: isScoutCode(code), source: 'npc',
      });
    }
  }
  return result.sort((a, b) => a.code.localeCompare(b.code));
}

function makeSide(config: GameConfig, input: SimulatorSideInput, catalog: Map<string, CatalogUnit>): SideState {
  const troops = input?.troops && typeof input.troops === 'object' ? input.troops : {};
  const stacks: SimStack[] = [];
  for (const [code, rawCount] of Object.entries(troops)) {
    const unit = catalog.get(code);
    const count = Math.min(100_000, positiveInt(rawCount));
    if (!unit || count <= 0) continue;
    const influence = combatValue(unit, combatInfluenceConfig(config));
    stacks.push({
      code, name: unit.name, form: unit.form, count, hp: unit.hp,
      isCavalry: unit.isCavalry, isScout: unit.isScout,
      stats: unit, combatQuality: influence.quality, attackQuality: influence.attackQuality,
      defenseQuality: influence.defenseQuality, influencePerUnit: influence.influencePerUnit,
      traits: unit.traits.map((trait) => ({ code: trait.code, name: trait.name, effects: trait.effects })),
    });
  }
  return { stacks, input, tech: buildTechModifiers(config, input), treasure: buildTreasureModifiers(config, input.treasures), modeAttackPct: 0 };
}

function traitAssignments(source: SideState, target: SideState, sourceSide: 'attacker' | 'defender', targetSide: 'attacker' | 'defender', rng: () => number): TraitAssignment[] {
  const result: TraitAssignment[] = [];
  for (const sourceStack of source.stacks) {
    if (sourceStack.count <= 0) continue;
    for (const trait of sourceStack.traits) {
      for (const effect of trait.effects) {
        let eligible: SimStack[] = [];
        const assignmentTargetSide: 'attacker' | 'defender' = effect.effect === 'ally_ranged_def' ? sourceSide : targetSide;
        if (effect.effect === 'enemy_cavalry_atk') eligible = stacksFor(target, (stack) => stack.isCavalry);
        else if (effect.effect === 'enemy_ranged_melee_def') eligible = stacksFor(target, (stack) => stack.form === 'ranged');
        else if (effect.effect === 'ally_ranged_def') eligible = stacksFor(source, (stack) => stack.code !== sourceStack.code);
        else continue;
        eligible = shuffle(eligible, rng);
        const total = eligible.reduce((sum, stack) => sum + stack.count, 0);
        if (total <= 0) {
          result.push({ sourceSide, sourceCode: sourceStack.code, sourceTrait: trait.code, effect: effect.effect, targetSide: assignmentTargetSide, targetCode: null, assigned: 0, value: effect.value, wasted: sourceStack.count });
          continue;
        }
        const cursor = Math.floor(rng() * total);
        let consumed = 0;
        let remaining = sourceStack.count;
        for (let i = 0; i < sourceStack.count; i++) {
          const ordinal = (cursor + i) % total;
          let cumulative = 0;
          const found = eligible.find((stack) => {
            cumulative += stack.count;
            return ordinal < cumulative;
          }) ?? eligible[eligible.length - 1]!;
          const key = `${found.code}`;
          const existing = result.find((item) => item.sourceSide === sourceSide && item.sourceCode === sourceStack.code && item.sourceTrait === trait.code && item.effect === effect.effect && item.targetSide === assignmentTargetSide && item.targetCode === key);
          if (existing) existing.assigned += 1;
          else result.push({ sourceSide, sourceCode: sourceStack.code, sourceTrait: trait.code, effect: effect.effect, targetSide: assignmentTargetSide, targetCode: key, assigned: 1, value: effect.value, wasted: 0 });
          consumed += 1;
          remaining -= 1;
        }
        if (remaining > 0) {
          result.push({ sourceSide, sourceCode: sourceStack.code, sourceTrait: trait.code, effect: effect.effect, targetSide: assignmentTargetSide, targetCode: null, assigned: 0, value: effect.value, wasted: remaining });
        }
        void consumed;
      }
    }
  }
  return result;
}

function aggregateTraitModifiers(assignments: TraitAssignment[], attacker: SideState, defender: SideState): Map<string, Partial<Record<'meleeAtk' | 'rangedAtk' | 'meleeDef' | 'rangedDef', number>>> {
  const mods = new Map<string, Partial<Record<'meleeAtk' | 'rangedAtk' | 'meleeDef' | 'rangedDef', number>>>();
  for (const assignment of assignments) {
    if (!assignment.targetCode || assignment.assigned <= 0) continue;
    const key = `${assignment.targetSide}:${assignment.targetCode}`;
    const mod = mods.get(key) ?? {};
    const targetSide = assignment.targetSide === 'attacker' ? attacker : defender;
    const targetStack = targetSide.stacks.find((stack) => stack.code === assignment.targetCode);
    const perUnit = assignment.assigned / Math.max(1, targetStack?.count ?? 1);
    const add = (field: 'meleeAtk' | 'rangedAtk' | 'meleeDef' | 'rangedDef') => { mod[field] = (mod[field] ?? 0) + assignment.value * perUnit; };
    if (assignment.effect === 'enemy_cavalry_atk') add('meleeAtk');
    if (assignment.effect === 'enemy_ranged_melee_def') add('meleeDef');
    if (assignment.effect === 'ally_ranged_def') add('rangedDef');
    mods.set(key, mod);
  }
  return mods;
}

function effectiveStats(side: SideState, sideName: 'attacker' | 'defender', assignments: TraitAssignment[], phase: 'melee' | 'ranged' | 'charge', wallMultiplier: number, attacker?: SideState, defender?: SideState): Map<string, StatSet> {
  const targetMods = aggregateTraitModifiers(assignments, attacker ?? side, defender ?? side);
  const out = new Map<string, StatSet>();
  for (const stack of side.stacks) {
    const own = { meleeAtk: 0, rangedAtk: 0, meleeDef: 0, rangedDef: 0 };
    for (const trait of stack.traits) for (const effect of trait.effects) {
      if (effect.effect === 'atk_melee') own.meleeAtk += effect.value;
      if (effect.effect === 'atk_ranged') own.rangedAtk += effect.value;
      if (effect.effect === 'def_melee') own.meleeDef += effect.value;
      if (effect.effect === 'def_ranged') own.rangedDef += effect.value;
      if (effect.effect === 'cavalry_charge_atk' && phase === 'charge' && stack.isCavalry && !stack.isScout) own.meleeAtk += effect.value;
    }
    const incoming = targetMods.get(`${sideName}:${stack.code}`) ?? {};
    const enemyCavalryDebuff = stack.isCavalry ? -side.treasure.enemyCavalryDefPct : 0;
    out.set(stack.code, {
      meleeAtk: statMultiplier(stack.stats.meleeAtk, side.tech.meleeAtkPct + side.treasure.atkPct + side.modeAttackPct + own.meleeAtk + (incoming.meleeAtk ?? 0)),
      rangedAtk: statMultiplier(stack.stats.rangedAtk, side.tech.rangedAtkPct + side.treasure.atkPct + side.modeAttackPct + own.rangedAtk + (incoming.rangedAtk ?? 0)),
      meleeDef: statMultiplier(stack.stats.meleeDef, side.tech.meleeDefPct + side.treasure.defPct + own.meleeDef + (incoming.meleeDef ?? 0) + enemyCavalryDebuff) * wallMultiplier,
      rangedDef: statMultiplier(stack.stats.rangedDef, side.tech.rangedDefPct + side.treasure.defPct + own.rangedDef + (incoming.rangedDef ?? 0) + enemyCavalryDebuff) * wallMultiplier,
      hp: statMultiplier(stack.hp, side.tech.hpPct),
    });
  }
  return out;
}

function power(stacks: SimStack[], stats: Map<string, StatSet>, type: 'meleeAtk' | 'rangedAtk', predicate: (stack: SimStack) => boolean): number {
  return stacks.filter((stack) => stack.count > 0 && predicate(stack)).reduce((sum, stack) => sum + stack.count * stack.attackQuality * (stats.get(stack.code)?.[type] ?? 0), 0);
}

function defense(stacks: SimStack[], stats: Map<string, StatSet>, type: 'meleeDef' | 'rangedDef', predicate: (stack: SimStack) => boolean): number {
  return stacks.filter((stack) => stack.count > 0 && predicate(stack)).reduce((sum, stack) => sum + stack.count * stack.defenseQuality * (stats.get(stack.code)?.[type] ?? 0), 0);
}

function health(stacks: SimStack[], stats: Map<string, StatSet>, predicate: (stack: SimStack) => boolean): number {
  return stacks.filter((stack) => stack.count > 0 && predicate(stack)).reduce((sum, stack) => sum + stack.count * (stats.get(stack.code)?.hp ?? stack.hp), 0);
}

/**
 * 伤亡池的有效生命值。旧版 shield/heavy_armor 等特性不是把 HP 写死到兵种，
 * 而是改变“承受某类伤害”的倍率，因此在计算该步骤伤亡比例时折算为有效 HP。
 * value=-0.30 表示少受 30% 伤害（有效 HP ÷ 0.70）；分母下限避免异常配置
 * 让伤害类型完全免疫。阶段化模拟器专用的目标型特性已经在 effectiveStats
 * 中按目标分配并叠加，这里只处理目标自身的承伤特性。
 */
function effectiveHealth(stacks: SimStack[], stats: Map<string, StatSet>, predicate: (stack: SimStack) => boolean, damageKind: 'melee' | 'ranged'): number {
  return stacks.filter((stack) => stack.count > 0 && predicate(stack)).reduce((sum, stack) => {
    let incoming = 0;
    for (const trait of stack.traits) for (const effect of trait.effects) {
      if (effect.effect === (damageKind === 'melee' ? 'dmg_taken_melee' : 'dmg_taken_ranged')) incoming += effect.value;
    }
    const denominator = Math.max(0.05, 1 + incoming);
    return sum + stack.count * (stats.get(stack.code)?.hp ?? stack.hp) / denominator;
  }, 0);
}

function distributeLosses(stacks: SimStack[], lossRatio: number, rng: () => number, predicate: (stack: SimStack) => boolean): number {
  const targets = stacks.filter((stack) => stack.count > 0 && predicate(stack));
  const total = targets.reduce((sum, stack) => sum + stack.count, 0);
  if (total <= 0 || lossRatio <= 0) return 0;
  const wanted = Math.min(total, Math.ceil(total * Math.min(1, lossRatio)));
  const losses = new Map<SimStack, number>();
  let assigned = 0;
  const remainders: { stack: SimStack; remainder: number }[] = [];
  for (const stack of targets) {
    const exact = stack.count * Math.min(1, lossRatio);
    const base = Math.min(stack.count, Math.floor(exact));
    losses.set(stack, base); assigned += base;
    remainders.push({ stack, remainder: exact - base });
  }
  for (const row of shuffle(remainders.sort((a, b) => b.remainder - a.remainder), rng)) {
    if (assigned >= wanted) break;
    const current = losses.get(row.stack) ?? 0;
    if (current < row.stack.count) { losses.set(row.stack, current + 1); assigned += 1; }
  }
  for (const stack of targets) stack.count = Math.max(0, stack.count - (losses.get(stack) ?? 0));
  return assigned;
}

/**
 * 平滑除法伤害：攻击低于防御时仍有伤害，攻击优势则收益递减。
 * 阶段系数负责表达冲锋、齐射和近战轮次的战术权重。
 */
function divisionDamage(attackPower: number, defensePower: number, phaseCoefficient: number): number {
  const attack = Math.max(0, attackPower);
  const defense = Math.max(0, defensePower);
  const coefficient = Math.max(0, phaseCoefficient);
  if (attack <= 0 || coefficient <= 0) return 0;
  return coefficient * attack * attack / Math.max(0.0001, attack + defense);
}

function snapshotStep(name: string, description: string, attacker: SideState, defenderSide: SideState, attackerStats: Map<string, StatSet>, defenderStats: Map<string, StatSet>, assignments: TraitAssignment[], damageToAttacker: number, damageToDefender: number, lossRatioToAttacker: number, lossRatioToDefender: number, lossesToAttacker: number, lossesToDefender: number, notes: string[], metrics?: { attackPower: { attacker: number; defender: number }; defensePower: { attacker: number; defender: number }; healthPool: { attacker: number; defender: number } }): StepResult {
  const flatten = (stats: Map<string, StatSet>) => Object.fromEntries([...stats.entries()].map(([code, row]) => [code, {
    meleeAtk: Number(row.meleeAtk.toFixed(4)), rangedAtk: Number(row.rangedAtk.toFixed(4)),
    meleeDef: Number(row.meleeDef.toFixed(4)), rangedDef: Number(row.rangedDef.toFixed(4)), hp: Number(row.hp.toFixed(4)),
  }]));
  return {
    name, description,
    before: { attacker: {}, defender: {} },
    after: { attacker: cloneCounts(attacker), defender: cloneCounts(defenderSide) },
    attackerStats: flatten(attackerStats), defenderStats: flatten(defenderStats),
    damageToAttacker, damageToDefender, lossesToAttacker, lossesToDefender,
    attackPower: metrics?.attackPower ?? { attacker: 0, defender: 0 },
    defensePower: metrics?.defensePower ?? { attacker: 0, defender: 0 },
    healthPool: metrics?.healthPool ?? { attacker: 0, defender: 0 },
    lossRatioToAttacker, lossRatioToDefender, traitAssignments: assignments, notes,
  };
}

function resolveExchange(opts: {
  name: string; description: string; attacker: SideState; defender: SideState;
  attackerPredicate: (stack: SimStack) => boolean; defenderPredicate: (stack: SimStack) => boolean;
  targetAttackerPredicate: (stack: SimStack) => boolean; targetDefenderPredicate: (stack: SimStack) => boolean;
  attackerAttack: 'meleeAtk' | 'rangedAtk'; defenderAttack: 'meleeAtk' | 'rangedAtk';
  targetDefense: 'meleeDef' | 'rangedDef'; rng: () => number; phase: 'melee' | 'ranged' | 'charge';
  damageCoefficient: number;
  wallAttacker: number; wallDefender: number;
}): StepResult {
  const beforeA = cloneCounts(opts.attacker), beforeD = cloneCounts(opts.defender);
  const aToD = traitAssignments(opts.attacker, opts.defender, 'attacker', 'defender', opts.rng);
  const dToA = traitAssignments(opts.defender, opts.attacker, 'defender', 'attacker', opts.rng);
  const assignments = [...aToD, ...dToA];
  const aStats = effectiveStats(opts.attacker, 'attacker', assignments, opts.phase, opts.wallAttacker, opts.attacker, opts.defender);
  const dStats = effectiveStats(opts.defender, 'defender', assignments, opts.phase, opts.wallDefender, opts.attacker, opts.defender);
  const aAttack = power(opts.attacker.stacks, aStats, opts.attackerAttack, opts.attackerPredicate);
  const dAttack = power(opts.defender.stacks, dStats, opts.defenderAttack, opts.defenderPredicate);
  const dDefense = defense(opts.defender.stacks, dStats, opts.targetDefense, opts.targetDefenderPredicate);
  const aDefense = defense(opts.attacker.stacks, aStats, opts.targetDefense, opts.targetAttackerPredicate);
  const coefficient = Math.max(0, opts.damageCoefficient);
  const damageKind = opts.targetDefense === 'rangedDef' ? 'ranged' : 'melee';
  const dHp = effectiveHealth(opts.defender.stacks, dStats, opts.targetDefenderPredicate, damageKind);
  const aHp = effectiveHealth(opts.attacker.stacks, aStats, opts.targetAttackerPredicate, damageKind);
  // 没有目标的冲锋反击侧（例如骑兵冲击步兵时骑兵不受伤）不产生伤害，
  // 即使该侧仍有未参与本步骤的其它兵种。
  const damageToD = dHp > 0 ? divisionDamage(aAttack, dDefense, coefficient) : 0;
  const damageToA = aHp > 0 ? divisionDamage(dAttack, aDefense, coefficient) : 0;
  const ratioD = dHp > 0 ? Math.min(1, damageToD / dHp) : 0;
  const ratioA = aHp > 0 ? Math.min(1, damageToA / aHp) : 0;
  const lossesD = distributeLosses(opts.defender.stacks, ratioD, opts.rng, opts.targetDefenderPredicate);
  const lossesA = distributeLosses(opts.attacker.stacks, ratioA, opts.rng, opts.targetAttackerPredicate);
  const step = snapshotStep(opts.name, opts.description, opts.attacker, opts.defender, aStats, dStats, assignments, damageToA, damageToD, ratioA, ratioD, lossesA, lossesD, [], {
    attackPower: { attacker: aAttack, defender: dAttack },
    defensePower: { attacker: aDefense, defender: dDefense },
    healthPool: { attacker: aHp, defender: dHp },
  });
  step.before = { attacker: beforeA, defender: beforeD };
  return step;
}

function makeStage(name: string, steps: StepResult[]): { name: string; steps: StepResult[] } {
  return { name, steps };
}

function finalSiege(attacker: SideState, defender: SideState, rng: () => number, wallDefender: number, assignments: TraitAssignment[], minSurvivorUnits: number, compareEpsilon: number): StepResult {
  const beforeA = cloneCounts(attacker), beforeD = cloneCounts(defender);
  const aStats = effectiveStats(attacker, 'attacker', assignments, 'melee', 1, attacker, defender);
  const dStats = effectiveStats(defender, 'defender', assignments, 'melee', wallDefender, attacker, defender);
  const aAtk = power(attacker.stacks, aStats, 'meleeAtk', () => true);
  const dAtk = power(defender.stacks, dStats, 'meleeAtk', () => true);
  const aDef = defense(attacker.stacks, aStats, 'meleeDef', () => true);
  const dDef = defense(defender.stacks, dStats, 'meleeDef', () => true);
  const aHp = health(attacker.stacks, aStats, () => true);
  const dHp = health(defender.stacks, dStats, () => true);
  const equal = (left: number, right: number) => Math.abs(left - right) <= Math.max(0, compareEpsilon);
  let winner: 'attacker' | 'defender' = dAtk >= aAtk ? 'defender' : 'attacker';
  let ratio = 0;
  let criterion = '攻击力';
  if (equal(aAtk, dAtk)) {
    if (!equal(aDef, dDef)) { winner = dDef >= aDef ? 'defender' : 'attacker'; ratio = Math.min(1, Math.min(aDef, dDef) / Math.max(aDef, dDef, 1)); criterion = '防御力'; }
    else if (!equal(aHp, dHp)) { winner = dHp >= aHp ? 'defender' : 'attacker'; ratio = Math.min(1, Math.min(aHp, dHp) / Math.max(aHp, dHp, 1)); criterion = '生命值'; }
    else { winner = 'defender'; ratio = 1; criterion = '完全相等（防守方保留随机单位）'; }
  } else {
    const winnerAttack = winner === 'attacker' ? aAtk : dAtk;
    const loserAttack = winner === 'attacker' ? dAtk : aAtk;
    ratio = winnerAttack > 0 ? Math.min(1, loserAttack / winnerAttack) : 1;
    if ((winner === 'attacker' ? dDef : aDef) <= 0) ratio = 0;
  }
  const winnerSide = winner === 'attacker' ? attacker : defender;
  const loserSide = winner === 'attacker' ? defender : attacker;
  for (const stack of loserSide.stacks) stack.count = 0;
  const winnerBefore = totalCount(winnerSide);
  const requiredKeep = Math.min(winnerBefore, Math.max(1, Math.floor(minSurvivorUnits)));
  const requestedLoss = Math.min(winnerBefore, Math.ceil(winnerBefore * ratio));
  const appliedLoss = Math.min(requestedLoss, Math.max(0, winnerBefore - requiredKeep));
  if (requestedLoss >= winnerBefore - requiredKeep && winnerBefore > 0) {
    const survivors = winnerSide.stacks.filter((stack) => stack.count > 0);
    let keep = requiredKeep;
    const shuffled = shuffle(survivors, rng);
    for (const stack of shuffled) {
      const retained = Math.min(stack.count, keep);
      stack.count = retained;
      keep -= retained;
    }
  } else distributeLosses(winnerSide.stacks, ratio, rng, () => true);
  if (totalCount(winnerSide) <= 0) {
    const fallback = winnerSide.stacks.find((stack) => stack.count > 0) ?? winnerSide.stacks[0];
    if (fallback) fallback.count = 1;
  }
  const damageToAttacker = winner === 'defender' ? aAtk : 0;
  const damageToDefender = winner === 'attacker' ? dAtk : 0;
  const actualWinnerLoss = winnerBefore - totalCount(winnerSide);
  const step = snapshotStep('siege_final', `攻城最终阶段：按${criterion}决定胜负`, attacker, defender, aStats, dStats, assignments, damageToAttacker, damageToDefender, winner === 'defender' ? ratio : 0, winner === 'attacker' ? ratio : 0, winner === 'defender' ? actualWinnerLoss : 0, winner === 'attacker' ? actualWinnerLoss : 0, [`胜方=${winner}`, `攻击 ${aAtk.toFixed(2)} / ${dAtk.toFixed(2)}`, `防御 ${aDef.toFixed(2)} / ${dDef.toFixed(2)}`, `生命 ${aHp.toFixed(2)} / ${dHp.toFixed(2)}`, `请求损失 ${requestedLoss}，实际损失 ${appliedLoss}，最少保留 ${requiredKeep}`], {
    attackPower: { attacker: aAtk, defender: dAtk },
    defensePower: { attacker: aDef, defender: dDef },
    healthPool: { attacker: aHp, defender: dHp },
  });
  step.before = { attacker: beforeA, defender: beforeD };
  return step;
}

function normalizeInput(input: BattleSimulationInput): BattleSimulationInput {
  const source = input && typeof input === 'object' ? input : {} as BattleSimulationInput;
  const mode: SimulatorMode = source.mode === 'ambush' || source.mode === 'raid' || source.mode === 'siege' ? source.mode : 'field';
  return { mode, attacker: source.attacker ?? { troops: {} }, defender: source.defender ?? { troops: {} }, seed: Number.isFinite(Number(source.seed)) ? Number(source.seed) : Date.now() };
}

export function simulateBattle(config: GameConfig, rawInput: BattleSimulationInput): BattleSimulationReport {
  const input = normalizeInput(rawInput);
  const catalog = new Map(unitCatalog(config).map((unit) => [unit.code, unit]));
  const attacker = makeSide(config, input.attacker, catalog);
  const defender = makeSide(config, input.defender, catalog);
  if (totalCount(attacker) <= 0 || totalCount(defender) <= 0) throw new Error('双方至少各需要一个单位');
  attacker.modeAttackPct = input.mode === 'ambush' ? Math.max(0, config.constants.ambushAttackBonus) : 0;
  const rng = createRng(input.seed ?? Date.now());
  const wallA = 1 + Math.max(0, Number(input.attacker.wallBonusPct ?? 0)) + Math.max(0, Number(input.attacker.wallLevel ?? 0)) * config.constants.wallBonusPerLevel;
  const wallD = 1 + Math.max(0, Number(input.defender.wallBonusPct ?? 0)) + Math.max(0, Number(input.defender.wallLevel ?? 0)) * config.constants.wallBonusPerLevel;
  const stages: { name: string; steps: StepResult[] }[] = [];

  const chargeSteps: StepResult[] = [];
  const aCav = (stack: SimStack) => stack.isCavalry;
  const dCav = (stack: SimStack) => stack.isCavalry;
  if (hasForm(attacker, 'melee') && hasForm(defender, 'melee') && stacksFor(attacker, aCav).length > 0 && stacksFor(defender, dCav).length > 0) {
    chargeSteps.push(resolveExchange({ name: 'cavalry_vs_cavalry', description: '双方骑兵对冲；非侦察骑兵获得冲锋攻击加成', attacker, defender, attackerPredicate: aCav, defenderPredicate: dCav, targetAttackerPredicate: aCav, targetDefenderPredicate: dCav, attackerAttack: 'meleeAtk', defenderAttack: 'meleeAtk', targetDefense: 'meleeDef', rng, phase: 'charge', damageCoefficient: config.constants.battlePhaseCavalryVsCavalryCoeff, wallAttacker: wallA, wallDefender: wallD }));
  }
  const aMelee = (stack: SimStack) => stack.form === 'melee' && !stack.isCavalry;
  const dMelee = (stack: SimStack) => stack.form === 'melee' && !stack.isCavalry;
  // 冲击近战步兵：双方幸存骑兵同时攻击对方的非骑兵近战池；
  // 步兵不会在此步骤反击，故 source predicate 只取骑兵、target predicate 只取步兵。
  if ((stacksFor(attacker, aCav).length > 0 && stacksFor(defender, dMelee).length > 0)
    || (stacksFor(defender, dCav).length > 0 && stacksFor(attacker, aMelee).length > 0)) {
    chargeSteps.push(resolveExchange({ name: 'cavalry_charge_melee', description: '双方幸存骑兵同时冲击敌方近战步兵；骑兵不承受步兵反击', attacker, defender, attackerPredicate: aCav, defenderPredicate: dCav, targetAttackerPredicate: aMelee, targetDefenderPredicate: dMelee, attackerAttack: 'meleeAtk', defenderAttack: 'meleeAtk', targetDefense: 'meleeDef', rng, phase: 'charge', damageCoefficient: config.constants.battlePhaseCavalryVsMeleeCoeff, wallAttacker: wallA, wallDefender: wallD }));
  }
  const aRanged = (stack: SimStack) => stack.form === 'ranged';
  const dRanged = (stack: SimStack) => stack.form === 'ranged';
  const targetDefenderRanged = (stack: SimStack) => stack.form === 'ranged' && stacksFor(defender, dMelee).length === 0;
  const targetAttackerRanged = (stack: SimStack) => stack.form === 'ranged' && stacksFor(attacker, aMelee).length === 0;
  if ((stacksFor(attacker, aCav).length > 0 && stacksFor(defender, targetDefenderRanged).length > 0)
    || (stacksFor(defender, dCav).length > 0 && stacksFor(attacker, targetAttackerRanged).length > 0)) {
    chargeSteps.push(resolveExchange({ name: 'cavalry_charge_ranged', description: '双方在敌方近战清空后冲击远程兵；目标使用近战防御且无反击', attacker, defender, attackerPredicate: aCav, defenderPredicate: dCav, targetAttackerPredicate: targetAttackerRanged, targetDefenderPredicate: targetDefenderRanged, attackerAttack: 'meleeAtk', defenderAttack: 'meleeAtk', targetDefense: 'meleeDef', rng, phase: 'charge', damageCoefficient: config.constants.battlePhaseCavalryVsRangedCoeff, wallAttacker: wallA, wallDefender: wallD }));
  }
  if (chargeSteps.length > 0) stages.push(makeStage('cavalry_charge', chargeSteps));

  const rangedSteps: StepResult[] = [];
  const targetA = stacksFor(defender, (stack) => stack.form === 'melee').length > 0 ? (stack: SimStack) => stack.form === 'melee' : dRanged;
  const targetD = stacksFor(attacker, (stack) => stack.form === 'melee').length > 0 ? (stack: SimStack) => stack.form === 'melee' : aRanged;
  if (stacksFor(attacker, aRanged).length > 0 || stacksFor(defender, dRanged).length > 0) {
    rangedSteps.push(resolveExchange({ name: 'ranged_fire', description: '远程阶段：有近战则射击近战（含幸存骑兵），否则射击远程；目标防御统一使用远程防御', attacker, defender, attackerPredicate: aRanged, defenderPredicate: dRanged, targetAttackerPredicate: targetD, targetDefenderPredicate: targetA, attackerAttack: 'rangedAtk', defenderAttack: 'rangedAtk', targetDefense: 'rangedDef', rng, phase: 'ranged', damageCoefficient: config.constants.battlePhaseRangedStrikeCoeff, wallAttacker: wallA, wallDefender: wallD }));
  }
  if (rangedSteps.length > 0) stages.push(makeStage('ranged_fire', rangedSteps));

  const meleeSteps: StepResult[] = [];
  const rounds = Math.max(1, Math.floor(config.constants.battleSimulatorMeleeRounds));
  for (let round = 1; round <= rounds && totalCount(attacker) > 0 && totalCount(defender) > 0; round++) {
    meleeSteps.push(resolveExchange({ name: `melee_round_${round}`, description: `全军近战兵力池互殴（第 ${round}/${rounds} 轮）`, attacker, defender, attackerPredicate: () => true, defenderPredicate: () => true, targetAttackerPredicate: () => true, targetDefenderPredicate: () => true, attackerAttack: 'meleeAtk', defenderAttack: 'meleeAtk', targetDefense: 'meleeDef', rng, phase: 'melee', damageCoefficient: config.constants.battlePhaseMeleeRoundCoeff, wallAttacker: wallA, wallDefender: wallD }));
  }
  if (meleeSteps.length > 0) stages.push(makeStage('melee_pool', meleeSteps));

  let winner: 'attacker' | 'defender' | 'draw';
  if (totalCount(attacker) <= 0 && totalCount(defender) <= 0) winner = 'draw';
  else if (totalCount(attacker) <= 0) winner = 'defender';
  else if (totalCount(defender) <= 0) winner = 'attacker';
  else if (input.mode === 'siege') {
    const finalAssignments = [...traitAssignments(attacker, defender, 'attacker', 'defender', rng), ...traitAssignments(defender, attacker, 'defender', 'attacker', rng)];
    const final = finalSiege(attacker, defender, rng, wallD, finalAssignments, config.constants.battlePhaseMinSurvivorUnits, config.constants.battlePhaseCompareEpsilon);
    stages.push(makeStage('siege_final', [final]));
    winner = totalCount(attacker) > 0 ? 'attacker' : 'defender';
  } else if (input.mode === 'field') winner = 'draw';
  else winner = 'defender';

  return {
    mode: input.mode, seed: input.seed ?? 0, winner, stages,
    final: { attacker: cloneCounts(attacker), defender: cloneCounts(defender) },
    totals: { attacker: totalCount(attacker), defender: totalCount(defender) },
    rules: {
      damageFormula: 'A²/(A+D)',
      populationInfluence: 'effectivePopulation=count×popCost×quality',
      qualityExponent: config.constants.combatInfluenceQualityExponent,
      referenceValue: config.constants.combatInfluenceReferenceValue,
      meleeRounds: rounds,
      damageCoefficients: {
        cavalryVsCavalry: config.constants.battlePhaseCavalryVsCavalryCoeff,
        cavalryVsMelee: config.constants.battlePhaseCavalryVsMeleeCoeff,
        cavalryVsRanged: config.constants.battlePhaseCavalryVsRangedCoeff,
        rangedStrike: config.constants.battlePhaseRangedStrikeCoeff,
        meleeRound: config.constants.battlePhaseMeleeRoundCoeff,
      },
      traitStacking: 'additive', lossRounding: 'ceil', minSurvivorUnits: config.constants.battlePhaseMinSurvivorUnits,
      wallBonusPerLevel: config.constants.wallBonusPerLevel,
    },
  };
}

export class BattleSimulatorModule {
  static readonly NAME = 'battle-simulator';
  constructor(private commands: CommandBus, private config: GameConfig) {}
  setConfig(config: GameConfig): void { this.config = config; }
  init(): void {
    this.commands.register('battleSimulator.GetCatalog', () => this.getCatalog());
    this.commands.register('battleSimulator.Simulate', (command) => this.simulate(command));
  }
  private async getCatalog(): Promise<CommandResult> {
    const units = unitCatalog(this.config).map((unit) => ({ ...unit, combatValue: combatValue(unit, combatInfluenceConfig(this.config)) }));
    const treasures = Object.values(this.config.treasures).map((treasure) => ({ code: treasure.code, name: treasure.name, effectType: treasure.effectType, effectValue: treasure.effectValue }));
    const research = Object.values(this.config.research).map((tech) => ({ code: tech.code, name: tech.name, effectType: tech.effectType, effectValue: tech.effectValue, effects: tech.effects }));
    return { ok: true, payload: { units, treasures, research, modes: ['ambush', 'raid', 'field', 'siege'], constants: {
      damageFormula: 'A²/(A+D)',
      populationInfluence: 'effectivePopulation=count×popCost×quality',
      qualityExponent: this.config.constants.combatInfluenceQualityExponent,
      referenceValue: this.config.constants.combatInfluenceReferenceValue,
      wallBonusPerLevel: this.config.constants.wallBonusPerLevel,
      meleeRounds: this.config.constants.battleSimulatorMeleeRounds,
      cavalryVsCavalryCoeff: this.config.constants.battlePhaseCavalryVsCavalryCoeff,
      cavalryVsMeleeCoeff: this.config.constants.battlePhaseCavalryVsMeleeCoeff,
      cavalryVsRangedCoeff: this.config.constants.battlePhaseCavalryVsRangedCoeff,
      rangedStrikeCoeff: this.config.constants.battlePhaseRangedStrikeCoeff,
      meleeRoundCoeff: this.config.constants.battlePhaseMeleeRoundCoeff,
    } } };
  }
  private async simulate(command: Command): Promise<CommandResult> {
    try {
      const payload = (command.payload ?? {}) as Record<string, unknown>;
      const scenario = payload.scenario && typeof payload.scenario === 'object' ? payload.scenario : payload;
      const report = simulateBattle(this.config, scenario as unknown as BattleSimulationInput);
      return { ok: true, payload: report as unknown as Record<string, unknown> };
    } catch (error) {
      return { ok: false, payload: {}, reason: error instanceof Error ? error.message : 'simulation_failed' };
    }
  }
}
