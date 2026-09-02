import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGameConfig, type GameConfig, type UnitDef } from '../infra/config.js';
import { simulateBattle } from '../modules/battle-simulator.js';
import { combatInfluence, combatValue } from '../infra/combat-balance.js';
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
  assert.equal(cfg.units.praetorian.hp, 300);
  assert.deepEqual(cfg.units.praetorian.simTraits, ['cavalry_hunter']);
  assert.deepEqual(cfg.units.legionnaire.simTraits, ['legion_ranged_guard']);
  assert.deepEqual(cfg.units.axeman.simTraits, ['axe_linebreaker']);
  assert.deepEqual(cfg.units.equimperatoris.simTraits, ['cavalry_charge']);
  assert.equal(cfg.units.merc_slinger.hp, 80);
  assert.equal(cfg.units.praetorian.popCost, 2);
  assert.equal(cfg.units.legionnaire.techTier, 1);
  assert.equal(cfg.units.equcaesaris.techTier, 3);
  assert.deepEqual(cfg.units.merc_slinger.simTraits, []);
  assert.ok(Object.values(cfg.pveTemplates).some((template) => Object.values(template.defender).some((unit) => unit.hp !== undefined)), 'PvE 守军应有生命池字段');
});

test('阶段化模拟器：只读取 simTraits，不把线上 traits 重复计入', () => {
  const cfg = config();
  cfg.units.equimperatoris.traits = ['charge'];
  cfg.units.equimperatoris.simTraits = [];
  const report = simulateBattle(cfg, {
    mode: 'field', seed: 17,
    attacker: { troops: { equimperatoris: 10 } },
    defender: { troops: { imperian: 100 } },
  });
  const charge = report.stages.find((stage) => stage.name === 'cavalry_charge')?.steps.find((step) => step.name === 'cavalry_charge_melee');
  const melee = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(charge && melee);
  assert.equal(charge.attackerStats.equimperatoris?.meleeAtk, melee.attackerStats.equimperatoris?.meleeAtk, '线上 charge 不应进入阶段模拟器');
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
  assert.ok(noMeleeStep.damageToDefender > 0 || noMeleeStep.damageToAttacker > 0, '双方都无近战时远程应互射并产生正伤害');
});

test('阶段化模拟器：生命伤亡池按总人口累计小数伤亡', () => {
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
  assert.ok(step.damageToDefender > 0, '有效战斗质量折算后仍应保留正伤害');
  assert.equal(step.lossesToDefender, 0, '单轮小额伤害不应被向上取整放大');
  assert.equal(step.after.defender.sim_defender, 10);
  assert.equal(report.rules.lossRounding, 'accumulate');
});

test('阶段化模拟器：人口影响力按质量非线性映射，等人口同构兵种保持同等战力', () => {
  const cfg = config();
  addTestUnit(cfg, 'pop_one', { form: 'melee', popCost: 1, meleeAtk: 50, rangedAtk: 0, meleeDef: 50, rangedDef: 50, hp: 100 });
  addTestUnit(cfg, 'pop_two', { form: 'melee', popCost: 2, meleeAtk: 100, rangedAtk: 0, meleeDef: 100, rangedDef: 100, hp: 200 });
  addTestUnit(cfg, 'target', { form: 'melee', popCost: 1, meleeAtk: 40, rangedAtk: 0, meleeDef: 60, rangedDef: 60, hp: 120 });
  const one = simulateBattle(cfg, { mode: 'field', seed: 31, attacker: { troops: { pop_one: 100 } }, defender: { troops: { target: 100 } } });
  const two = simulateBattle(cfg, { mode: 'field', seed: 31, attacker: { troops: { pop_two: 50 } }, defender: { troops: { target: 100 } } });
  const oneStep = one.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  const twoStep = two.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(oneStep && twoStep);
  assert.ok(Math.abs(oneStep.attackPower.attacker - twoStep.attackPower.attacker) < 0.0001, '相同人口、按比例缩放的兵种应有相同有效攻击池');
  assert.ok(Math.abs(oneStep.defensePower.attacker - twoStep.defensePower.attacker) < 0.0001, '相同人口、按比例缩放的兵种应有相同有效防御池');
  assert.equal(oneStep.lossesToDefender, twoStep.lossesToDefender);
  assert.equal(one.rules.populationInfluence, 'effectivePopulation=count×popCost×quality');
});

test('阶段化模拟器：同人口克制与混搭能改变战果，高科技保持溢价但不能无损碾压', () => {
  const cfg = config();
  // 本测试只验证基础数值的策略性，特性价值在后面的对照模拟中单独观察。
  for (const unit of Object.values(cfg.units)) {
    unit.traits = [];
    unit.simTraits = [];
  }
  const counter = simulateBattle(cfg, {
    mode: 'field', seed: 17,
    attacker: { troops: { spearman: 50, axeman: 50 } },
    defender: { troops: { equimperatoris: 33 } },
  });
  const influenceConfig = {
    referenceValue: cfg.constants.combatInfluenceReferenceValue,
    qualityExponent: cfg.constants.combatInfluenceQualityExponent,
    minQuality: cfg.constants.combatInfluenceMinQuality,
    maxQuality: cfg.constants.combatInfluenceMaxQuality,
    meleeAttackWeight: cfg.constants.combatValueMeleeAttackWeight,
    rangedAttackWeight: cfg.constants.combatValueRangedAttackWeight,
    meleeDefenseWeight: cfg.constants.combatValueMeleeDefenseWeight,
    rangedDefenseWeight: cfg.constants.combatValueRangedDefenseWeight,
    hpWeight: cfg.constants.combatValueHpWeight,
  };
  const finalInfluence = (rows: Record<string, number>) => Object.entries(rows)
    .reduce((sum, [code, count]) => sum + count * combatInfluence(cfg.units[code]!, influenceConfig), 0);
  assert.ok(finalInfluence(counter.final.attacker) > finalInfluence(counter.final.defender) * 1.1, '矛阵+斧兵混搭应能以有效战斗人口压制同人口冲角骑兵');

  const tech = simulateBattle(cfg, {
    mode: 'field', seed: 17,
    attacker: { troops: { gaul_warboar_rider: 33 } },
    defender: { troops: { legionnaire: 100 } },
  });
  assert.ok((tech.final.attacker.gaul_warboar_rider ?? 0) > 0);
  assert.ok(finalInfluence(tech.final.attacker) > finalInfluence(tech.final.defender), '高科技骑兵应在有效战斗人口上保持优势');
  assert.equal(tech.final.defender.legionnaire ?? 0, 0, '高科技骑兵在明显攻防优势下应能在战术窗口内速胜');
});

test('阶段化模拟器：基准、战术窗口和基础克制关系可复盘', () => {
  const cfg = config();
  for (const unit of Object.values(cfg.units)) {
    unit.traits = [];
    unit.simTraits = [];
  }
  const simulate = (attacker: Record<string, number>, defender: Record<string, number>) => simulateBattle(cfg, {
    mode: 'field', seed: 17, attacker: { troops: attacker }, defender: { troops: defender },
  });
  const mirror = simulate({ legionnaire: 100 }, { legionnaire: 100 });
  assert.equal(mirror.winner, 'draw');
  assert.ok((mirror.final.attacker.legionnaire ?? 0) >= 25 && (mirror.final.attacker.legionnaire ?? 0) <= 45, '100v100 镜像应在战术窗口内产生明显伤亡，但不应首轮结束');
  const outnumbered = simulate({ legionnaire: 100 }, { legionnaire: 10 });
  assert.equal(outnumbered.winner, 'attacker');
  assert.ok((outnumbered.final.attacker.legionnaire ?? 0) >= 95, '10% 兵力应在一个交换内被平方律压制');
  assert.equal(mirror.stages.find((stage) => stage.name === 'melee_pool')?.steps.length, 8, '镜像战斗应完整走完 8 轮战术窗口');
  assert.equal(outnumbered.stages.find((stage) => stage.name === 'melee_pool')?.steps.length, 1, '10:1 兵力差应在第一轮结束');
  assert.equal(simulate({ roman_sagittarii: 100 }, { spearman: 100 }).winner, 'attacker', '远程兵应能压制低远防的长枪兵');
  assert.equal(simulate({ spearman: 100 }, { equimperatoris: 50 }).winner, 'attacker', '同人口长枪兵应明确克制冲角骑兵');
  assert.equal(simulate({ equimperatoris: 50 }, { roman_sagittarii: 100 }).winner, 'attacker', '同人口骑兵应通过冲击压制远程兵');
  const mixed = simulate({ spearman: 50, axeman: 50 }, { equimperatoris: 50 });
  assert.equal(mixed.winner, 'attacker', '长枪承伤与斧兵输出的混搭应优于单一骑兵');
  const influenceConfig = {
    referenceValue: cfg.constants.combatInfluenceReferenceValue,
    qualityExponent: cfg.constants.combatInfluenceQualityExponent,
    minQuality: cfg.constants.combatInfluenceMinQuality,
    maxQuality: cfg.constants.combatInfluenceMaxQuality,
    meleeAttackWeight: cfg.constants.combatValueMeleeAttackWeight,
    rangedAttackWeight: cfg.constants.combatValueRangedAttackWeight,
    meleeDefenseWeight: cfg.constants.combatValueMeleeDefenseWeight,
    rangedDefenseWeight: cfg.constants.combatValueRangedDefenseWeight,
    hpWeight: cfg.constants.combatValueHpWeight,
  };
  const baseline = combatValue(cfg.units.legionnaire, influenceConfig);
  assert.ok(Math.abs(baseline.valuePerPopulation - 200) < 5, '参考步兵应锚定在 200 战斗价值/人口附近');
  assert.equal(cfg.units.equcaesaris.techTier, 3);
  assert.ok(combatValue(cfg.units.gaul_warboar_rider, influenceConfig).valuePerPopulation > baseline.valuePerPopulation * 1.1, '三档科技兵应至少保有 10% 基础人口溢价');
});

test('阶段化模拟器：特性收益可用无特性对照量化', () => {
  const plainCfg = config();
  for (const unit of Object.values(plainCfg.units)) {
    unit.traits = [];
    unit.simTraits = [];
  }
  const plain = simulateBattle(plainCfg, { mode: 'field', seed: 17, attacker: { troops: { spearman: 100 } }, defender: { troops: { equimperatoris: 50 } } });
  const withTraits = simulateBattle(config(), { mode: 'field', seed: 17, attacker: { troops: { spearman: 100 } }, defender: { troops: { equimperatoris: 50 } } });
  assert.ok((withTraits.final.attacker.spearman ?? 0) > (plain.final.attacker.spearman ?? 0), '反骑兵特性应降低骑兵造成的伤亡');
  const plainCharge = plain.stages.flatMap((stage) => stage.steps).find((step) => step.name === 'cavalry_charge_melee');
  const traitCharge = withTraits.stages.flatMap((stage) => stage.steps).find((step) => step.name === 'cavalry_charge_melee');
  assert.ok(plainCharge && traitCharge);
  assert.ok((traitCharge?.damageToAttacker ?? 0) < (plainCharge?.damageToAttacker ?? 0), '特性影响应能在步骤伤害中单独观察');
});

test('阶段化模拟器：攻击低于防御时仍会产生可累积伤害', () => {
  const cfg = config();
  addTestUnit(cfg, 'low_attack', { meleeAtk: 20, rangedAtk: 0, meleeDef: 0, rangedDef: 0, hp: 10, form: 'melee' });
  addTestUnit(cfg, 'high_defense', { meleeAtk: 0, rangedAtk: 0, meleeDef: 100, rangedDef: 100, hp: 100, form: 'melee' });
  cfg.constants.battleSimulatorMeleeRounds = 60;
  const report = simulateBattle(cfg, {
    mode: 'field', seed: 3,
    attacker: { troops: { low_attack: 10 } },
    defender: { troops: { high_defense: 10 } },
  });
  const step = report.stages.find((stage) => stage.name === 'melee_pool')?.steps[0];
  assert.ok(step);
  assert.ok(step.attackPower.attacker < step.defensePower.defender);
  assert.ok(step.damageToDefender > 0, '低于防御时不能被硬截断为 0 伤害');
  assert.ok(report.stages.flatMap((stage) => stage.steps).some((item) => item.lossesToDefender > 0), '持续正伤害应能在累计后转化为至少 1 个单位的阶段伤亡');
  assert.equal(report.rules.damageFormula, 'k×A×A/(A+D)×(1+g×max(0,(A-D)/(A+D)))');
  assert.equal(report.rules.damageCoefficients.advantageAmplifier, cfg.constants.battlePhaseAdvantageAmplifier);
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
