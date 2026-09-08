import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGameConfig } from '../infra/config.js';
import { simulateBattle } from '../modules/battle-simulator.js';
import { BALANCE_TABLES } from '../gateway/gm.js';

const configDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../config');

test('模拟器使用攻击、防御、生命三属性配置，并同步同一回合公式', () => {
  const cfg = loadGameConfig(configDir);
  assert.deepEqual(BALANCE_TABLES.units.numeric?.slice(0, 3), ['attack', 'defense', 'hp']);
  const report = simulateBattle(cfg, {
    attacker: { troops: { legionnaire: 100 } },
    defender: { troops: { phalanx: 100 } },
  });
  assert.equal(report.winner, 'defender');
  assert.equal(report.totals.attacker, 0);
  assert.equal(report.totals.defender, 30);
  assert.equal(report.rules.damageFormula, 'A²/(A+D)');
  assert.ok(report.stages[0]!.steps.length > 0);
});

test('v3 整数基础步兵：六组 100 对 100 精确满足存活锚点', () => {
  const cfg = loadGameConfig(configDir);
  const cases: Array<[string, string, string, number]> = [
    ['clubswinger', 'legionnaire', 'clubswinger', 30],
    ['clubswinger', 'phalanx', 'clubswinger', 10],
    ['legionnaire', 'clubswinger', 'legionnaire', 20],
    ['legionnaire', 'phalanx', 'phalanx', 30],
    ['phalanx', 'clubswinger', 'phalanx', 10],
    ['phalanx', 'legionnaire', 'legionnaire', 20],
  ];
  for (const [attacker, defender, survivor, expected] of cases) {
    const report = simulateBattle(cfg, { attacker: { troops: { [attacker]: 100 } }, defender: { troops: { [defender]: 100 } } });
    assert.equal(report.final.attacker[survivor] ?? report.final.defender[survivor] ?? 0, expected, `${attacker} 攻 ${defender}`);
  }
});

test('模拟器不再接受阶段、城墙或兵种形态作为伤害来源', () => {
  const cfg = loadGameConfig(configDir);
  const base = simulateBattle(cfg, { attacker: { troops: { clubswinger: 100 } }, defender: { troops: { legionnaire: 100 } } });
  const same = simulateBattle(cfg, { mode: 'field', attacker: { troops: { clubswinger: 100 }, tech: {} }, defender: { troops: { legionnaire: 100 }, tech: {} } });
  assert.deepEqual(same.final, base.final);
});
