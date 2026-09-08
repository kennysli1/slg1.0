import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatePhaseStep, totalSnapshotCount } from '../infra/total-ad-combat.js';

const unit = (count: number, attack: number, defense: number, hp: number, role: 'infantry' | 'cavalry' = 'infantry', form: 'melee' | 'ranged' = 'melee', traits: any[] = []) => ({ count, attack, defense, hp, role, form, traits, carry: 0 });

test('v3：弓骑预射、近战骑冲锋、远程、近战严格按阶段出手', () => {
  const attacker = {
    bow: unit(10, 100, 20, 100, 'cavalry', 'ranged'),
    cav: unit(10, 100, 20, 100, 'cavalry'),
    archer: unit(10, 100, 20, 100, 'infantry', 'ranged'),
    foot: unit(10, 100, 20, 100),
  };
  const defender = { foot: unit(100, 1, 20, 100) };
  const bow = simulatePhaseStep({ attacker, defender, step: 'bow_cavalry' });
  assert.deepEqual(bow.attackerParticipants, { bow: 10 });
  const charge = simulatePhaseStep({ attacker, defender, step: 'cavalry_charge' });
  assert.deepEqual(charge.attackerParticipants, { cav: 10 });
  const ranged = simulatePhaseStep({ attacker, defender, step: 'ranged' });
  assert.deepEqual(ranged.attackerParticipants, { bow: 10, archer: 10 });
  const melee = simulatePhaseStep({ attacker, defender, step: 'melee' });
  assert.equal(Object.values(melee.attackerParticipants).reduce((n, count) => n + count, 0), 40);
});

test('v3：特性只在标注阶段生效，同 code 不按数量叠加', () => {
  const chargeOnly = [{ code: 'charge', name: '冲锋', effects: [{ effect: 'self_attack', value: 0.25, phase: 'charge' as const }] }];
  const attacker = { 'march-1#cav': unit(10, 100, 10, 100, 'cavalry', 'melee', chargeOnly), 'march-2#cav': unit(10, 100, 10, 100, 'cavalry', 'melee', chargeOnly) };
  const defender = { d: unit(100, 1, 10, 100) };
  const charge = simulatePhaseStep({ attacker, defender, step: 'cavalry_charge' });
  const melee = simulatePhaseStep({ attacker, defender, step: 'melee' });
  assert.equal(charge.attackerTotalAttack, 2500, '同 code 的 25% 仅触发一次，而非 2×25%');
  assert.equal(melee.attackerTotalAttack, 2000, '冲锋特性不得进入第三阶段');
});

test('v3：生命余伤跨阶段保留，近战持续到任一方归零', () => {
  let attacker = { a: unit(1, 20, 1, 100) };
  let defender = { d: unit(1, 20, 1, 100) };
  let ac = {}; let dc = {};
  for (let round = 1; round <= 50 && totalSnapshotCount(attacker) && totalSnapshotCount(defender); round += 1) {
    const result = simulatePhaseStep({ attacker, defender, attackerDamageCarry: ac, defenderDamageCarry: dc, step: 'melee', meleeRound: round });
    attacker = result.attacker as typeof attacker; defender = result.defender as typeof defender;
    ac = result.attackerDamageCarry; dc = result.defenderDamageCarry;
  }
  assert.ok(totalSnapshotCount(attacker) === 0 || totalSnapshotCount(defender) === 0);
});
