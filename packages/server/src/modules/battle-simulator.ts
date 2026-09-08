import type { Command, CommandResult } from '@slg/shared';
import type { GameConfig, UnitDef } from '../infra/config.js';
import type { Snapshot } from '../infra/combat-types.js';
import { simulatePhaseStep, totalSnapshotCount, type BattleStepKind, type DamageCarries } from '../infra/total-ad-combat.js';
import type { CommandBus } from '../infra/command-bus.js';

/** 独立模拟器与线上 Combat 共用同一回合函数，不存在两套战斗口径。 */
export type SimulatorMode = 'field';
export interface SimulatorTechModifiers { attackPct?: number; defensePct?: number; hpPct?: number; }
export interface SimulatorSideInput { troops: Record<string, number>; tech?: SimulatorTechModifiers; }
export interface BattleSimulationInput { mode?: SimulatorMode; attacker: SimulatorSideInput; defender: SimulatorSideInput; }

export interface SimulatorStep {
  round: number;
  phase: 'charge' | 'ranged' | 'melee';
  step?: BattleStepKind;
  /** 本步骤实际仍有来源单位的特性 code；供客户端逐步骤解释。 */
  traits: string[];
  before: { attacker: Record<string, number>; defender: Record<string, number> };
  after: { attacker: Record<string, number>; defender: Record<string, number> };
  attackPower: { attacker: number; defender: number };
  defensePower: { attacker: number; defender: number };
  damageToAttacker: number;
  damageToDefender: number;
  lossesToAttacker: number;
  lossesToDefender: number;
}

export interface BattleSimulationReport {
  mode: SimulatorMode;
  winner: 'attacker' | 'defender' | 'draw';
  final: { attacker: Record<string, number>; defender: Record<string, number> };
  totals: { attacker: number; defender: number };
  stages: { name: string; steps: SimulatorStep[] }[];
  rules: {
    damageFormula: 'A²/(A+D)';
    simultaneous: true;
    distribution: string;
    traits: string[];
  };
}

function percent(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-0.99, n) : 0;
}

function stat(def: UnitDef, key: 'attack' | 'defense'): number {
  const direct = Number((def as unknown as Record<string, unknown>)[key]);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const legacy = def as unknown as Record<string, unknown>;
  return key === 'attack'
    ? Math.max(Number(legacy.meleeAtk) || 0, Number(legacy.rangedAtk) || 0)
    : Math.max(Number(legacy.meleeDef) || 0, Number(legacy.rangedDef) || 0);
}

function countMap(snapshot: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, unit] of Object.entries(snapshot)) if (unit.count > 0) out[code] = unit.count;
  return out;
}

function loss(before: Record<string, number>, after: Record<string, number>): number {
  return Object.keys(before).reduce((sum, code) => sum + Math.max(0, before[code] - (after[code] ?? 0)), 0);
}

function activeTraits(snapshot: Snapshot, phase: 'charge' | 'ranged' | 'melee'): string[] {
  const seenUnits = new Set<string>();
  const traits = new Set<string>();
  for (const [key, unit] of Object.entries(snapshot)) {
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    if (unit.count <= 0 || seenUnits.has(code)) continue;
    seenUnits.add(code);
    for (const trait of unit.traits ?? []) if (trait.effects.some((effect) => !effect.phase || effect.phase === 'all' || effect.phase === phase)) traits.add(trait.code);
  }
  return [...traits].sort();
}

function makeSnapshot(config: GameConfig, input: SimulatorSideInput | undefined): Snapshot {
  const side = input ?? { troops: {} };
  const attackMultiplier = 1 + percent(side.tech?.attackPct);
  const defenseMultiplier = 1 + percent(side.tech?.defensePct);
  const hpMultiplier = 1 + percent(side.tech?.hpPct);
  const snapshot: Snapshot = {};
  for (const [code, rawCount] of Object.entries(side.troops ?? {})) {
    const def = config.units[code];
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (!def || count <= 0) continue;
    snapshot[code] = {
      count, attack: stat(def, 'attack') * attackMultiplier,
      defense: stat(def, 'defense') * defenseMultiplier,
      hp: Math.max(1, def.hp * hpMultiplier), carry: def.carry, popCost: def.popCost,
      form: def.form, role: def.role,
      traits: def.traits.map((trait) => config.unitTraits[trait]).filter(Boolean),
    };
  }
  return snapshot;
}

export function simulateBattle(config: GameConfig, raw: BattleSimulationInput): BattleSimulationReport {
  let attacker = makeSnapshot(config, raw?.attacker);
  let defender = makeSnapshot(config, raw?.defender);
  let attackerCarry: DamageCarries = {};
  let defenderCarry: DamageCarries = {};
  const steps: SimulatorStep[] = [];
  let winner: BattleSimulationReport['winner'] = 'draw';
  const run = (step: BattleStepKind, meleeRound = 1) => {
    if (totalSnapshotCount(attacker) <= 0 || totalSnapshotCount(defender) <= 0) return;
    const result = simulatePhaseStep({ attacker, defender, attackerDamageCarry: attackerCarry, defenderDamageCarry: defenderCarry, step, meleeRound });
    const traits = [...new Set([...activeTraits(attacker, result.phase), ...activeTraits(defender, result.phase)])].sort();
    const lossesToAttacker = loss(result.attackerBefore, result.attackerAfter);
    const lossesToDefender = loss(result.defenderBefore, result.defenderAfter);
    steps.push({
      round: steps.length + 1,
      phase: result.phase, step: result.step, traits,
      before: { attacker: result.attackerBefore, defender: result.defenderBefore }, after: { attacker: result.attackerAfter, defender: result.defenderAfter },
      attackPower: { attacker: result.attackerTotalAttack, defender: result.defenderTotalAttack },
      defensePower: { attacker: result.attackerTotalDefense, defender: result.defenderTotalDefense },
      damageToAttacker: result.damageToAttacker, damageToDefender: result.damageToDefender, lossesToAttacker, lossesToDefender,
    });
    attacker = result.attacker; defender = result.defender;
    attackerCarry = result.attackerDamageCarry; defenderCarry = result.defenderDamageCarry;
  };
  // 固定阶段顺序；无对应单位的步骤会产生 0 伤害，但不会把特性带到下一阶段。
  run('bow_cavalry');
  run('cavalry_charge');
  run('ranged');
  let meleeRound = 1;
  while (totalSnapshotCount(attacker) > 0 && totalSnapshotCount(defender) > 0) {
    const before = steps.length;
    run('melee', meleeRound++);
    if (steps.length === before || (steps.at(-1)!.damageToAttacker <= 0 && steps.at(-1)!.damageToDefender <= 0)) break;
  }
  const attackerTotal = totalSnapshotCount(attacker);
  const defenderTotal = totalSnapshotCount(defender);
  if (attackerTotal > 0 && defenderTotal === 0) winner = 'attacker';
  if (defenderTotal > 0 && attackerTotal === 0) winner = 'defender';
  return {
    mode: 'field', winner, final: { attacker: countMap(attacker), defender: countMap(defender) }, totals: { attacker: attackerTotal, defender: defenderTotal },
    stages: [
      { name: '第一阶段：弓骑预射与近战骑冲锋', steps: steps.filter((item) => item.phase === 'charge') },
      { name: '第二阶段：远程打击', steps: steps.filter((item) => item.phase === 'ranged') },
      { name: '第三阶段：近战互殴至一方全灭', steps: steps.filter((item) => item.phase === 'melee') },
    ],
    rules: {
      damageFormula: 'A²/(A+D)', simultaneous: true,
      distribution: '按步骤开始时各兵种人数比例分摊；每兵种按自身 hp 累积余伤折算阵亡',
      traits: ['特性仅在配置阶段生效；同 code 有幸存者只生效一次，不同 code 相加'],
    },
  };
}

function catalogUnit(def: UnitDef, config: GameConfig) {
  const traits = def.traits.map((code) => config.unitTraits[code]).filter(Boolean).map((trait) => ({
    code: trait!.code, name: trait!.name,
    description: trait!.effects.map((effect) => `${effect.phase}:${effect.effect} ${Math.round(effect.value * 100)}%`).join('；'),
  }));
  return {
    code: def.key, name: def.name, tribe: def.tribe,
    form: def.form, role: def.role,
    attack: stat(def, 'attack'), defense: stat(def, 'defense'), hp: def.hp,
    traits, source: def.isMercenary ? 'merc' : 'unit',
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
    return { ok: true, payload: {
      units: Object.values(this.config.units).map((unit) => catalogUnit(unit, this.config)), modes: ['field'],
      constants: { damageFormula: 'A²/(A+D)', traits: ['弓骑预射→近战骑冲锋→远程→全员近战；特性严格单阶段'] },
    } };
  }
  private async simulate(command: Command): Promise<CommandResult> {
    try {
      const payload = (command.payload ?? {}) as Record<string, unknown>;
      const scenario = payload.scenario && typeof payload.scenario === 'object' ? payload.scenario : payload;
      return { ok: true, payload: simulateBattle(this.config, scenario as BattleSimulationInput) as unknown as Record<string, unknown> };
    } catch (error) {
      return { ok: false, payload: {}, reason: error instanceof Error ? error.message : 'simulation_failed' };
    }
  }
}
