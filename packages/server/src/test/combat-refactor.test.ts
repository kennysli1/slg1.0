import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCombatTick } from '../modules/combat/engine.js';
import { simulateTotalAdRound } from '../infra/total-ad-combat.js';

const unit = (count: number, attack: number, defense: number, hp: number) => ({ count, attack, defense, hp, carry: 0 });

test('总攻击/总防御：双方使用回合开始兵力同时结算', () => {
  const attacker = { a: unit(10, 10, 5, 20) };
  const defender = { d: unit(10, 10, 5, 20) };
  const result = simulateCombatTick({ attacker, defender });
  assert.equal(attacker.a.count, 10);
  assert.equal(defender.d.count, 10);
  assert.equal(result.damageToAttacker, 10000 / 150);
  assert.equal(result.damageToDefender, 10000 / 150);
  assert.equal(result.attacker.a.count, 7);
  assert.equal(result.defender.d.count, 7);
});

test('生命值余伤按兵种独立累计，且伤害按人数比例分摊', () => {
  const first = simulateTotalAdRound({
    attacker: { a: unit(1, 10, 1, 10) },
    defender: { low: unit(1, 7, 1, 5), high: unit(1, 7, 1, 20) },
  });
  assert.equal(first.damageToDefender, 100 / 12);
  assert.equal(first.defender.low.count, 1);
  assert.equal(first.defender.high.count, 1);
  assert.ok((first.defenderDamageCarry.low ?? 0) > 0);
  assert.ok((first.defenderDamageCarry.high ?? 0) > 0);
});

test('旧快照的零攻击会归一为最低攻击 10，战斗可在无回合上限下结束', () => {
  let attacker = { a: unit(10, 0, 20, 60) };
  let defender = { d: unit(10, 0, 20, 60) };
  let attackerCarry = {}; let defenderCarry = {};
  for (let round = 0; round < 1000 && (attacker.a?.count ?? 0) > 0 && (defender.d?.count ?? 0) > 0; round += 1) {
    const next = simulateTotalAdRound({ attacker, defender, attackerDamageCarry: attackerCarry, defenderDamageCarry: defenderCarry });
    attacker = next.attacker as typeof attacker; defender = next.defender as typeof defender;
    attackerCarry = next.attackerDamageCarry; defenderCarry = next.defenderDamageCarry;
  }
  assert.ok((attacker.a?.count ?? 0) === 0 || (defender.d?.count ?? 0) === 0);
});

test('纯攻击、防御、生命的基础步兵轮次可决出胜负', () => {
  const values = {
    legionnaire: unit(100, 60, 43, 273),
    clubswinger: unit(100, 81, 58, 153),
    phalanx: unit(100, 81, 51, 163),
  };
  const fights: Array<[keyof typeof values, keyof typeof values]> = [
    ['clubswinger', 'legionnaire'],
    ['clubswinger', 'phalanx'],
    ['legionnaire', 'clubswinger'],
    ['legionnaire', 'phalanx'],
    ['phalanx', 'clubswinger'],
    ['phalanx', 'legionnaire'],
  ];
  for (const [attackerCode, defenderCode] of fights) {
    let attacker = { [attackerCode]: { ...values[attackerCode] } };
    let defender = { [defenderCode]: { ...values[defenderCode] } };
    let attackerCarry = {}; let defenderCarry = {};
    while (Object.values(attacker).some((u) => u.count > 0) && Object.values(defender).some((u) => u.count > 0)) {
      const next = simulateTotalAdRound({ attacker, defender, attackerDamageCarry: attackerCarry, defenderDamageCarry: defenderCarry });
      attacker = next.attacker as typeof attacker; defender = next.defender as typeof defender;
      attackerCarry = next.attackerDamageCarry; defenderCarry = next.defenderDamageCarry;
    }
    assert.ok(Object.values(attacker).every((u) => u.count === 0) || Object.values(defender).every((u) => u.count === 0), `${attackerCode} 攻 ${defenderCode}`);
  }
});
