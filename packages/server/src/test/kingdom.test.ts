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

test('王国地标：即使未探索也会在地图返回公开地标标记', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  const registered = await send(app, 'player.Register', { name: '王国地标可见', password: 'p1234', tribe: 'romans' });
  const player = (registered.payload as any).player;
  const area = await send(app, 'world.GetArea', {
    cq: player.q, cr: player.r, r: 1, full: true, playerId: player.id,
  });
  const tiles = (area.payload as any).tiles as any[];
  for (const id of ['kingdom-capital', 'kingdom-fief-ne', 'kingdom-fief-se', 'kingdom-fief-sw', 'kingdom-fief-nw']) {
    const tile = tiles.find((t) => t.refId === id);
    assert.ok(tile, `${id} 应存在地图标记`);
    assert.notEqual(tile.visibility, 'unexplored', `${id} 不应被战争迷雾隐藏`);
  }
});

test('议会厅/玩家增援：抵达后不并入目标村军队，来源村仍承担军队足迹', async () => {
  let clock = 1_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  app.setupWorld();
  const registered = await send(app, 'player.Register', { name: '临时增援测试', password: 'p1234', tribe: 'romans' });
  const player = (registered.payload as any).player;
  const target = await send(app, 'military.GetArmy', { villageId: player.villageId });
  const before = (target.payload as any).troops;
  const tile = await send(app, 'world.GetTileByRef', { refId: player.villageId, kind: 'village' });
  const xy = (tile.payload as any).tile;
  const sent = await send(app, 'movement.SendKingdomReinforcement', {
    targetVillage: player.villageId, fromXY: { q: xy.q, r: xy.r },
    troops: { legionnaire: 240 }, durationSec: 1, orderId: 'test-reinforcement',
  });
  assert.equal(sent.ok, true, sent.reason);
  const movement = app.store.get<any>('movement', (sent.payload as any).id);
  await app.scheduler.advanceTo(movement.arriveAt, (t) => { clock = t; });
  const after = await send(app, 'military.GetArmy', { villageId: player.villageId });
  assert.deepEqual((after.payload as any).troops, before, '临时增援不应写入目标村常驻军队');
  const reinforcement = await send(app, 'movement.GetReinforcementSnapshot', { villageId: player.villageId });
  assert.equal((reinforcement.payload as any).snapshot.legionnaire.count, 240);
  await app.scheduler.advanceTo(clock + 1000, (t) => { clock = t; });
  assert.equal(app.store.get<any>('movement', (sent.payload as any).id), undefined, '王国增援到期自动离开');
});

test('玩家增援：目标村不接管兵力，来源村保留口粮足迹且可召回', async () => {
  let clock = 1_500_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '玩家增援甲', password: 'p1234', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '玩家增援乙', password: 'p1234', tribe: 'gauls' })).payload as any;
  await send(app, 'military.AdjustTroops', { villageId: a.player.villageId, delta: { legionnaire: 3 } });
  const targetBefore = await send(app, 'military.GetArmy', { villageId: b.player.villageId });
  const sent = await send(app, 'movement.SendTransport', {
    villageId: a.player.villageId, targetVillage: b.player.villageId,
    troops: { legionnaire: 3 }, cargo: {}, mode: 'reinforce',
  });
  assert.equal(sent.ok, true, sent.reason);
  const sourceMoving = (await send(app, 'economy.GetCropContext', { villageId: a.player.villageId })).payload as any;
  assert.ok(sourceMoving.troopUpkeepPerHour > 0, '来源村应继续承担增援军的行军口粮');
  while (app.store.get<any>('movement', (sent.payload as any).id)?.status === 'marching') {
    await app.scheduler.advanceTo(clock + 3_600_000, (t) => { clock = t; });
  }
  const targetAfter = await send(app, 'military.GetArmy', { villageId: b.player.villageId });
  assert.deepEqual((targetAfter.payload as any).troops, (targetBefore.payload as any).troops, '增援不应并入目标村常驻军队');
  const shown = (targetAfter.payload as any).reinforcements?.find((entry: any) => entry.id === sent.payload.id);
  assert.equal(shown?.fromVillage, a.player.villageId, '军队页应保留增援来源村庄');
  assert.equal(shown?.fromPlayerName, a.player.name, '军队页应显示增援来源玩家');
  assert.equal(shown?.troops?.legionnaire, 3, '军队页应显示该批增援兵力');
  const stationed = await send(app, 'movement.GetReinforcementSnapshot', { villageId: b.player.villageId });
  assert.equal((stationed.payload as any).snapshot.legionnaire.count, 3);
  const recalled = await send(app, 'movement.RecallGarrison', { villageId: a.player.villageId, movementId: sent.payload.id });
  assert.equal(recalled.ok, true, recalled.reason);
  while (app.store.get<any>('movement', (recalled.payload as any).id)) {
    await app.scheduler.advanceTo(clock + 3_600_000, (t) => { clock = t; });
  }
  const sourceReturned = (await send(app, 'military.GetArmy', { villageId: a.player.villageId })).payload as any;
  assert.equal(sourceReturned.troops.legionnaire, 3, '召回后兵力应回到来源村');
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
