import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';
import { kingdomLandmarkAnchors } from '../infra/world-generation.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('王国地标：王都位于世界中心，四封地位于四象限中心且成为真实 PvE', () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  const expected = kingdomLandmarkAnchors(app.config.constants.worldW, app.config.constants.worldH, Number(app.config.constants.raw.kingdom_fief_offset_ratio));
  for (const anchor of expected) {
    const pve = app.store.get<any>('pve', anchor.id);
    assert.ok(pve, `${anchor.id} 应创建 PvE 状态`);
    assert.equal(pve.type, anchor.type);
    assert.deepEqual({ q: pve.q, r: pve.r }, { q: anchor.q, r: anchor.r });
    assert.ok(Object.values(pve.defender as Record<string, { count: number }>).reduce((sum, unit) => sum + unit.count, 0) > 0);
  }
});

test('王国任务：循环上贡有期限，目标完成后手动领取才结算声望', async () => {
  let clock = 1_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock, rng: () => 0 });
  app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '王国任务甲', password: 'p1234', tribe: 'romans' });
  const player = (reg.payload as any).player;
  await app.scheduler.advanceTo(clock + 300_000, (t) => { clock = t; });
  const issued = await send(app, 'kingdom.GetState', { playerId: player.id, villageId: player.villageId });
  const task = (issued.payload as any).task;
  assert.equal(task.kind, 'tribute');
  assert.equal(task.status, 'active');
  await send(app, 'economy.Grant', { villageId: player.villageId, gain: { [task.resource]: task.amount } });
  const submitted = await send(app, 'kingdom.SubmitTribute', { playerId: player.id, villageId: player.villageId });
  assert.equal(submitted.ok, true);
  assert.equal(((await send(app, 'reputation.Get', { playerId: player.id })).payload as any).value, 0, '目标完成不能自动发声望');
  const claimed = await send(app, 'kingdom.ClaimTask', { playerId: player.id, villageId: player.villageId });
  assert.equal(claimed.ok, true);
  assert.equal(((await send(app, 'reputation.Get', { playerId: player.id })).payload as any).value, 2);
  assert.ok((claimed.payload as any).nextIssueAt > clock, '领取后应安排下一轮任务');
});

test('王国任务：指定同象限现有 PvE，清空前不会完成', async () => {
  let clock = 2_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock, rng: () => 0.5 });
  app.setupWorld();
  app.config.constants.raw.kingdom_task_tribute_weight = 0;
  app.config.constants.raw.kingdom_task_clear_pve_weight = 1;
  app.config.constants.raw.kingdom_task_attack_evil_weight = 0;
  app.config.constants.raw.kingdom_task_eliminate_troops_weight = 0;
  const reg = await send(app, 'player.Register', { name: '王国任务乙', password: 'p1234', tribe: 'romans' });
  const player = (reg.payload as any).player;
  await app.scheduler.advanceTo(clock + 450_000, (t) => { clock = t; });
  const issued = await send(app, 'kingdom.GetState', { playerId: player.id, villageId: player.villageId });
  const task = (issued.payload as any).task;
  assert.equal(task.kind, 'clear_pve');
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: {
    side: 'attacker', fromVillage: player.villageId, targetKind: 'pve', targetId: task.targetPveId,
    campCleared: false,
  } } as any);
  assert.equal(app.store.get<any>('kingdom', player.id).task.status, 'active');
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: {
    side: 'attacker', fromVillage: player.villageId, targetKind: 'pve', targetId: task.targetPveId,
    campCleared: true,
  } } as any);
  assert.equal(app.store.get<any>('kingdom', player.id).task.status, 'ready');
});

test('王国任务：超时失败不扣声望，并保留下一轮循环时间', async () => {
  let clock = 3_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock, rng: () => 0 });
  app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '王国任务丙', password: 'p1234', tribe: 'romans' });
  const player = (reg.payload as any).player;
  await app.scheduler.advanceTo(clock + 300_000, (t) => { clock = t; });
  const issued = await send(app, 'kingdom.GetState', { playerId: player.id, villageId: player.villageId });
  const task = (issued.payload as any).task;
  await send(app, 'reputation.Adjust', { playerId: player.id, delta: 7, reason: 'test' });
  await app.scheduler.advanceTo(task.expiresAt, (t) => { clock = t; });
  const state = app.store.get<any>('kingdom', player.id);
  assert.equal(state.task.status, 'failed');
  assert.ok(state.nextIssueAt > clock, '失败后应安排下一轮任务');
  assert.equal(((await send(app, 'reputation.Get', { playerId: player.id })).payload as any).value, 7, '超时失败没有惩罚');
});

test('议会厅：按等级购买服务并原子扣声望，声望不足不能透支', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 }); app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '议会厅甲', password: 'p1234', tribe: 'romans' });
  const player = (reg.payload as any).player;
  const building = app.store.get<any>('building', player.villageId);
  building.placed.push({ slotId: 'inner-council-test', kind: 'council', zone: 'inner', level: 1 });
  app.store.set('building', player.villageId, building);
  await send(app, 'reputation.Adjust', { playerId: player.id, delta: 3, reason: 'test' });
  const bought = await send(app, 'kingdom.BuyService', { playerId: player.id, villageId: player.villageId, serviceCode: 'supplies_small' });
  assert.equal(bought.ok, true);
  assert.equal(((await send(app, 'reputation.Get', { playerId: player.id })).payload as any).value, 1);
  const rejected = await send(app, 'kingdom.BuyService', { playerId: player.id, villageId: player.villageId, serviceCode: 'reinforcement_guard' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'insufficient_reputation');
  assert.equal(((await send(app, 'reputation.Get', { playerId: player.id })).payload as any).value, 1);
});
