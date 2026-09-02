import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGameConfig, type GameConfig, type UnitDef } from '../infra/config.js';
import { simulateBattle } from '../modules/battle-simulator.js';
import { BALANCE_TABLES } from '../gateway/gm.js';
import { MODULE_MANIFESTS } from '../gateway/routes.js';

const configDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../config');

function config(): GameConfig {
  return loadGameConfig(configDir);
}

function addTestUnit(target: GameConfig, code: string, overrides: Partial<UnitDef> = {}): void {
  target.units[code] = {
    ...target.units.praetorian!,
    id: 9000 + Object.keys(target.units).length,
    key: code,
    name: code,
    icon: code,
    traits: [],
    simTraits: [],
    ...overrides,
  };
}

test('阶段化模拟器配置：兵种生命值与模拟器特性来自 CSV，雇佣兵/NPC 默认可为空', () => {
  const cfg = config();
  assert.equal(cfg.units.praetorian.hp, 220);
  assert.deepEqual(cfg.units.praetorian.simTraits, ['cavalry_hunter']);
  assert.deepEqual(cfg.units.legionnaire.simTraits, ['legion_ranged_guard']);
  assert.deepEqual(cfg.units.axeman.simTraits, ['axe_linebreaker']);
  assert.deepEqual(cfg.units.equimperatoris.simTraits, ['cavalry_charge']);
  assert.equal(cfg.units.merc_slinger.hp, 80);
  assert.deepEqual(cfg.units.merc_slinger.simTraits, []);
  assert.ok(Object.values(cfg.pveTemplates).some((template) => Object.values(template.defender).some((unit) => unit.hp !== undefined)), 'PvE 守军应有生命池字段');
});

test('配置中心与网关：生命值/特性可编辑，模拟器目录和执行动作已注册', () => {
  assert.ok(BALANCE_TABLES.units.numeric?.includes('hp'));
  assert.ok(BALANCE_TABLES.units.text?.includes('simTraits'));
  assert.ok(BALANCE_TABLES.mercenaries.numeric?.includes('hp'));
  assert.ok(BALANCE_TABLES.mercenaries.text?.includes('simTraits'));
  assert.ok(BALANCE_TABLES.pve_defenders.numeric?.includes('hp'));
  assert.ok(BALANCE_TABLES.pve_defenders.text?.includes('traits'));
  assert.ok(BALANCE_TABLES.unit_traits);
  const manifest = MODULE_MANIFESTS.find((item) => item.moduleName === 'battle-simulator');
  assert.equal(manifest?.publicActions.GetCatalog?.command, 'battleSimulator.GetCatalog');
  assert.equal(manifest?.publicActions.Simulate?.command, 'battleSimulator.Simulate');
});

test('阶段化模拟器：骑兵冲击不承受步兵反击，冲锋特性只在冲锋阶段生效', () => {
  const report = simulateBattle(config(), {
    mode: 'field', seed: 17,
    attacker: { troops: { equimperatoris: 10 } },
    defender: { troops: { imperian: 100 } },
  });
  const charge = report.stages.find((stage) => stage.name === 'cavalry_charge')?.steps.find((step) => step.name === 'cavalry_charge_melee');
  assert.ok(charge);
  assert.equal(charge.lossesToAttacker, 0);
  assert.equal(charge.damageToAttacker, 0);
  assert.ok(charge.attackPower.attacker > 0 && charge.attackPower.defender === 0);
  const melee = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(melee);
  assert.ok((charge.attackerStats.equimperatoris?.meleeAtk ?? 0) > (melee.attackerStats.equimperatoris?.meleeAtk ?? 0));
});

test('阶段化模拟器：特性目标均匀分配并按加法叠加', () => {
  const cfg = config();
  // 禁用本测试无关的骑兵冲击，避免目标骑兵先把特性来源步兵冲掉。
  cfg.constants.battlePhaseCavalryVsMeleeCoeff = 0;
  const report = simulateBattle(cfg, {
    mode: 'field', seed: 123,
    attacker: { troops: { praetorian: 10 } },
    defender: { troops: { equimperatoris: 5, equcaesaris: 5 } },
  });
  const step = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(step);
  const assignments = step.traitAssignments.filter((item) => item.sourceCode === 'praetorian' && item.effect === 'enemy_cavalry_atk' && item.targetCode);
  assert.equal(assignments.length, 2, '两个骑兵目标栈都应收到分配');
  assert.deepEqual(assignments.map((item) => item.assigned).sort((a, b) => a - b), [5, 5]);
  for (const code of ['equimperatoris', 'equcaesaris']) {
    const row = step.defenderStats[code];
    assert.ok(row && row.meleeAtk > 0);
  }

  const stacked = simulateBattle(cfg, {
    mode: 'field', seed: 123,
    attacker: { troops: { praetorian: 20 } },
    defender: { troops: { equimperatoris: 1 } },
  });
  const stackedStep = stacked.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(stackedStep);
  assert.equal(stackedStep.traitAssignments.find((item) => item.targetCode === 'equimperatoris' && item.effect === 'enemy_cavalry_atk')?.assigned, 20);
  // 20 个 -30% 命中 1 个目标时先相加，debuff 被夹到 0，而不是相乘出正攻击力。
  assert.equal(stackedStep.defenderStats.equimperatoris?.meleeAtk, 0);
});

test('阶段化模拟器：远程阶段有近战先射近战，否则射远程，目标均使用远程防御', () => {
  const withMelee = simulateBattle(config(), {
    mode: 'field', seed: 5,
    attacker: { troops: { catapult: 10 } },
    defender: { troops: { praetorian: 5, catapult: 5 } },
  });
  const step = withMelee.stages.find((stage) => stage.name === 'ranged_fire')?.steps[0];
  assert.ok(step);
  assert.equal(step.before.defender.praetorian, 5);
  assert.equal(step.before.defender.catapult, 5);
  assert.ok(!step.after.defender.praetorian || step.after.defender.praetorian <= 5);
  assert.equal(step.after.defender.catapult, 5, '敌方仍有近战时远程打击不应先损失敌方远程');
  assert.match(step.description, /远程防御/);

  const noMelee = simulateBattle(config(), {
    mode: 'field', seed: 5,
    attacker: { troops: { catapult: 10 } },
    defender: { troops: { catapult: 10 } },
  });
  const noMeleeStep = noMelee.stages.find((stage) => stage.name === 'ranged_fire')?.steps[0];
  assert.ok(noMeleeStep);
  assert.ok(noMeleeStep.after.defender.catapult < 10 || noMeleeStep.after.attacker.catapult < 10);
});

test('阶段化模拟器：生命伤亡池按总人口向上取整', () => {
  const cfg = config();
  addTestUnit(cfg, 'sim_attacker', { meleeAtk: 1, rangedAtk: 0, meleeDef: 0, rangedDef: 0, hp: 10, form: 'melee' });
  addTestUnit(cfg, 'sim_defender', { meleeAtk: 0, rangedAtk: 0, meleeDef: 0, rangedDef: 0, hp: 10, form: 'melee' });
  const report = simulateBattle(cfg, {
    mode: 'field', seed: 2,
    attacker: { troops: { sim_attacker: 10 } },
    defender: { troops: { sim_defender: 10 } },
  });
  const step = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(step);
  assert.equal(step.healthPool.defender, 100);
  assert.equal(step.damageToDefender, 2);
  assert.equal(step.lossesToDefender, 1, '正伤害转换为阶段伤亡时应向上取整为1个单位');
  assert.equal(step.after.defender.sim_defender, 9);
});

test('阶段化模拟器：攻击低于防御时仍会产生可累积伤害', () => {
  const cfg = config();
  addTestUnit(cfg, 'low_attack', { meleeAtk: 20, rangedAtk: 0, meleeDef: 0, rangedDef: 0, hp: 10, form: 'melee' });
  addTestUnit(cfg, 'high_defense', { meleeAtk: 0, rangedAtk: 0, meleeDef: 100, rangedDef: 100, hp: 100, form: 'melee' });
  const report = simulateBattle(cfg, {
    mode: 'field', seed: 3,
    attacker: { troops: { low_attack: 10 } },
    defender: { troops: { high_defense: 10 } },
  });
  const step = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(step);
  assert.ok(step.attackPower.attacker < step.defensePower.defender);
  assert.ok(step.damageToDefender > 0, '低于防御时不能被硬截断为 0 伤害');
  assert.ok(step.lossesToDefender > 0, '正伤害应能转化为至少 1 个单位的阶段伤亡');
  assert.equal(report.rules.damageFormula, 'A²/(A+D)');
});

test('阶段化模拟器：攻城最终阶段按攻击/防御/生命值顺序比较，完全相等由防守方留1', () => {
  const cfg = config();
  cfg.constants.battleSimulatorMeleeRounds = 1;
  addTestUnit(cfg, 'sim_attacker', { meleeAtk: 10, rangedAtk: 0, meleeDef: 10, rangedDef: 10, hp: 10, form: 'melee' });
  addTestUnit(cfg, 'sim_defender', { meleeAtk: 10, rangedAtk: 0, meleeDef: 10, rangedDef: 10, hp: 10, form: 'melee' });
  const report = simulateBattle(cfg, {
    mode: 'siege', seed: 9,
    attacker: { troops: { sim_attacker: 3 } },
    defender: { troops: { sim_defender: 3 } },
  });
  assert.equal(report.winner, 'defender');
  assert.equal(report.final.attacker.sim_attacker, undefined);
  assert.equal(report.final.defender.sim_defender, 1);
  const final = report.stages.find((stage) => stage.name === 'siege_final')?.steps[0];
  assert.match(final?.description ?? '', /完全相等/);
});
