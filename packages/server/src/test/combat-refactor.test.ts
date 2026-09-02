import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCombatTick } from '../modules/combat/engine.js';
import { buildSettlementPlan } from '../modules/combat/resolution.js';
import type { Battle } from '../modules/combat/types.js';
import { createGameApp, type GameApp } from '../app.js';

function melee(count: number, attack: number, defense: number, carry = 0) {
  return { count, form: 'melee' as const, meleeAtk: attack, rangedAtk: 0, meleeDef: defense, rangedDef: defense, carry };
}

test('combat engine：逐 tick 计算是纯函数，不修改输入快照', () => {
  const attacker = { legionnaire: melee(2, 10, 10) };
  const defender = { club: melee(2, 10, 10) };
  const result = simulateCombatTick({
    attacker,
    defender,
    attackerPending: 0,
    defenderPending: 0,
    combatStrength: 0.1,
    dt: 1,
    defenderWallMultiplier: 1,
  });

  assert.equal(attacker.legionnaire.count, 2);
  assert.equal(defender.club.count, 2);
  assert.equal(result.attacker.legionnaire.count, 2);
  assert.equal(result.defender.club.count, 2);
  assert.ok(result.attackerPending > 0);
  assert.ok(result.defenderPending > 0);
});

test('combat engine：攻击低于防御时仍会累积伤害', () => {
  const result = simulateCombatTick({
    attacker: { legionnaire: melee(1, 1, 1) },
    defender: { club: melee(1, 1, 100) },
    attackerPending: 0,
    defenderPending: 0,
    combatStrength: 0.1,
    dt: 1,
    defenderWallMultiplier: 1,
  });

  assert.ok(result.killsToDefender > 0, '低于防御时也必须产生正的减员速率');
  assert.ok(result.defenderPending > 0, '小额伤害应通过 pending 跨 tick 累积');
});

test('combat engine：兰开斯特平方律会放大人数优势', () => {
  const oneAgainstOne = simulateCombatTick({
    attacker: { legionnaire: melee(1, 10, 10) },
    defender: { club: melee(1, 10, 10) },
    attackerPending: 0,
    defenderPending: 0,
    combatStrength: 0.1,
    dt: 6,
    defenderWallMultiplier: 1,
  });
  const twoAgainstOne = simulateCombatTick({
    attacker: { legionnaire: melee(2, 10, 10) },
    defender: { club: melee(1, 10, 10) },
    attackerPending: 0,
    defenderPending: 0,
    combatStrength: 0.1,
    dt: 6,
    defenderWallMultiplier: 1,
  });

  assert.ok(oneAgainstOne.defender.club, '势均力敌时双方都应有幸存者');
  assert.equal(twoAgainstOne.defender.club, undefined, '两倍兵力的一方应在相同时间内清空单个敌人');
  assert.equal(twoAgainstOne.attacker.legionnaire.count, 2, '人数优势方应保留幸存兵力');
});

test('settlement plan：按来源拆分伤亡，并计算幸存者运力', () => {
  const battle = {
    id: 'bt-refactor',
    targetKind: 'village',
    targetId: 'v1',
    targetXY: { q: 0, r: 0 },
    wallLevel: 0,
    attacker: { 'mv-a#legionnaire': melee(3, 10, 10, 5), 'mv-b#legionnaire': melee(1, 10, 10, 5) },
    defender: { 'resident:v1#club': melee(2, 10, 10), 'reinforcement:mv-d#club': melee(1, 10, 10) },
    defenderOriginal: { 'resident:v1#club': 2, 'reinforcement:mv-d#club': 1 },
    defenderContributions: {
      'resident:v1': { sourceId: 'resident:v1', fromVillage: 'v1', troops: { club: 2 } },
      'reinforcement:mv-d': { sourceId: 'reinforcement:mv-d', movementId: 'mv-d', fromVillage: 'v2', troops: { club: 1 } },
    },
    contributions: {
      'mv-a': { movementId: 'mv-a', fromVillage: 'v1', fromXY: { q: 0, r: 0 }, troops: { legionnaire: 3 }, treasures: [] },
      'mv-b': { movementId: 'mv-b', fromVillage: 'v2', fromXY: { q: 1, r: 0 }, troops: { legionnaire: 1 }, treasures: [] },
    },
    attackerPending: 0,
    defenderPending: 0,
    initialAttacker: { legionnaire: 4 },
    initialDefender: { club: 3 },
    rounds: [],
    attackPower0: 40,
    defensePower0: 30,
    startedAt: 1,
    ticks: 1,
    status: 'resolving',
  } satisfies Battle;

  battle.attacker['mv-a#legionnaire']!.count = 2;
  battle.defender['resident:v1#club']!.count = 1;
  battle.defender['reinforcement:mv-d#club']!.count = 0;
  const plan = buildSettlementPlan(battle);

  assert.equal(plan.attackerWins, false);
  assert.deepEqual(plan.attackerLosses, { legionnaire: 1 });
  assert.deepEqual(plan.defenderLosses, { club: 2 });
  assert.deepEqual(plan.residentDefenderLosses, { club: 1 });
  assert.deepEqual(plan.defenderLossesByMovement, { 'mv-d': { club: 1 } });
  assert.equal(plan.totalCarry, 15);
});

test('combat resume：resolving 状态会继续结算并清理战场记录', async () => {
  let clock = 1_000_000;
  const app: GameApp = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  const battle: Battle = {
    id: 'bt-resume',
    targetKind: 'pve',
    targetId: 'pve-0',
    targetXY: { q: 0, r: 0 },
    wallLevel: 0,
    attacker: { 'mv-resume#legionnaire': melee(1, 100, 10, 10) },
    defender: {},
    defenderOriginal: {},
    contributions: {
      'mv-resume': { movementId: 'mv-resume', fromVillage: 'v1', fromXY: { q: 0, r: 0 }, troops: { legionnaire: 1 }, treasures: [] },
    },
    attackerPending: 0,
    defenderPending: 0,
    initialAttacker: { legionnaire: 1 },
    initialDefender: {},
    rounds: [],
    attackPower0: 100,
    defensePower0: 0,
    startedAt: clock,
    ticks: 1,
    status: 'resolving',
    resolution: { id: 'bt-resume:resolution', step: 'apply_domain', startedAt: clock },
  };
  app.store.set('battle', battle.id, battle);

  app.combat.resume();
  clock += 1;
  await app.scheduler.advanceTo(clock, (time) => { clock = time; });
  assert.equal(app.store.get('battle', battle.id), undefined);
});
