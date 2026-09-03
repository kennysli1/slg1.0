import type { Command, CommandResult } from '@slg/shared';
import type { GameConfig, UnitDef } from '../infra/config.js';
import type { Snapshot } from '../infra/combat-types.js';
import { simulateTotalAdRound, totalSnapshotCount, type DamageCarries } from '../infra/total-ad-combat.js';
import type { CommandBus } from '../infra/command-bus.js';

/** 独立模拟器与线上 Combat 共用同一回合函数，不存在两套战斗口径。 */
export type SimulatorMode = 'field';
export interface SimulatorTechModifiers { attackPct?: number; defensePct?: number; hpPct?: number; }
export interface SimulatorSideInput { troops: Record<string, number>; tech?: SimulatorTechModifiers; }
export interface BattleSimulationInput { mode?: SimulatorMode; attacker: SimulatorSideInput; defender: SimulatorSideInput; }

export interface SimulatorStep {
  round: number;
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
    distribution: '按回合开始时各兵种人数比例分摊；每兵种按自身 hp 累积余伤折算阵亡';
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
  while (totalSnapshotCount(attacker) > 0 && totalSnapshotCount(defender) > 0) {
    const result = simulateTotalAdRound({ attacker, defender, attackerDamageCarry: attackerCarry, defenderDamageCarry: defenderCarry });
    const lossesToAttacker = loss(result.attackerBefore, result.attackerAfter);
    const lossesToDefender = loss(result.defenderBefore, result.defenderAfter);
    steps.push({
      round: steps.length + 1,
      before: { attacker: result.attackerBefore, defender: result.defenderBefore }, after: { attacker: result.attackerAfter, defender: result.defenderAfter },
      attackPower: { attacker: result.attackerTotalAttack, defender: result.defenderTotalAttack },
      defensePower: { attacker: result.attackerTotalDefense, defender: result.defenderTotalDefense },
      damageToAttacker: result.damageToAttacker, damageToDefender: result.damageToDefender, lossesToAttacker, lossesToDefender,
    });
    attacker = result.attacker; defender = result.defender;
    attackerCarry = result.attackerDamageCarry; defenderCarry = result.defenderDamageCarry;
    // 不是回合上限：双方均无法造成伤害时，公式已没有可推进的结果。
    if (result.damageToAttacker <= 0 && result.damageToDefender <= 0) break;
  }
  const attackerTotal = totalSnapshotCount(attacker);
  const defenderTotal = totalSnapshotCount(defender);
  if (attackerTotal > 0 && defenderTotal === 0) winner = 'attacker';
  if (defenderTotal > 0 && attackerTotal === 0) winner = 'defender';
  return {
    mode: 'field', winner, final: { attacker: countMap(attacker), defender: countMap(defender) }, totals: { attacker: attackerTotal, defender: defenderTotal },
    stages: [{ name: '总攻击 / 总防御回合', steps }],
    rules: {
      damageFormula: 'A²/(A+D)', simultaneous: true,
      distribution: '按回合开始时各兵种人数比例分摊；每兵种按自身 hp 累积余伤折算阵亡',
      traits: ['条顿掠袭棍兵：仅原始进攻方攻击 +7.40%', '高卢盾矛方阵：仅原始防守方防御 +22.06%'],
    },
  };
}

function catalogUnit(def: UnitDef) {
  const traits: { code: string; name: string; description: string }[] = [];
  if (def.key === 'clubswinger') traits.push({ code: 'teuton_attack', name: '条顿进攻特性', description: '仅原始进攻方攻击 +7.40%' });
  if (def.key === 'phalanx') traits.push({ code: 'gaul_defense', name: '高卢防守特性', description: '仅原始防守方防御 +22.06%' });
  return { code: def.key, name: def.name, tribe: def.tribe, attack: stat(def, 'attack'), defense: stat(def, 'defense'), hp: def.hp, traits, source: def.isMercenary ? 'merc' : 'unit' };
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
      units: Object.values(this.config.units).map(catalogUnit), modes: ['field'],
      constants: { damageFormula: 'A²/(A+D)', traits: ['条顿进攻 +7.40%', '高卢防守 +22.06%'] },
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
