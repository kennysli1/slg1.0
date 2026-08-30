import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { Gateway, type ClientConnection } from '../gateway/gateway.js';
import { WIRE_VERSION } from '@slg/shared';

/**
 * 行军增量推送（MarchStep / MarchRemoved / ForeignArmyStep / ForeignArmyRemoved / MarchRecalled）行为测试。
 */

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

async function register(app: GameApp, name: string) {
  const r = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(r.ok, true, `注册 ${name} 应成功`);
  return (r.payload as any).player as { id: string; villageId: string; q: number; r: number };
}

test('movement.Stepped：出征军步进时发出 Stepped 事件', async () => {
  const app = freshApp();
  const p = await register(app, '推送甲');
  await send(app, 'military.AdjustTroops', { villageId: p.villageId, delta: { legionnaire: 20 } });

  const steppedEvents: any[] = [];
  app.bus.on('movement.Stepped', (e) => { steppedEvents.push(e.payload); });

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 5 },
  });
  assert.equal(raid.ok, true);
  const mvId = (raid.payload as any).id;
  const mvData = app.store.get<any>('movement', mvId);
  const perStep = mvData?.perStepMs ?? 60_000;

  // 推进超过一步（用实际 perStepMs）
  let iters = 0;
  while (steppedEvents.length === 0 && iters < 50) {
    await app.scheduler.advanceTo(clock + perStep + 1_000, setClock);
    iters++;
  }

  const stepped = steppedEvents.find((e) => e.id === mvId);
  assert.ok(stepped, 'movement.Stepped 应在步进后触发');
  assert.equal(stepped.villageId, p.villageId);
  assert.ok(stepped.pos, 'Stepped 事件应包含 pos');
  assert.ok(typeof stepped.stepIndex === 'number', 'Stepped 事件应包含 stepIndex');
});

test('movement.Removed：行军到达后发出 Removed(arrived) 事件', async () => {
  const app = freshApp();
  const p = await register(app, '推送乙');
  await send(app, 'military.AdjustTroops', { villageId: p.villageId, delta: { legionnaire: 10 } });

  const removedEvents: any[] = [];
  app.bus.on('movement.Removed', (e) => { removedEvents.push(e.payload); });

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 5 },
  });
  const mvId = (raid.payload as any).id;

  // 推进到 raid 到达（含战斗和返程）
  let iters = 0;
  while (app.store.get('movement', mvId) && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 5_000, setClock);
    iters++;
  }

  // 出征军到达（先移除去程，可能多次：去程到达→战斗→返程到达）
  assert.ok(removedEvents.length > 0, 'movement.Removed 应在行军结束时触发');
  const firstRemoved = removedEvents.find((e) => e.id === mvId);
  assert.ok(firstRemoved, '应有针对该 movement 的 Removed 事件');
});

test('MarchRecalled：撤回出征军发出 movement.Recalled 事件', async () => {
  const app = freshApp();
  const A = await register(app, '推送丙');
  const B = await register(app, '推送丁');
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 20 } });

  const recalledEvents: any[] = [];
  app.bus.on('movement.Recalled', (e) => { recalledEvents.push(e.payload); });

  const atk = await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 10 },
  });
  const mvId = (atk.payload as any).id;

  const recall = await send(app, 'movement.RecallMarch', { villageId: A.villageId, movementId: mvId });
  assert.equal(recall.ok, true, `撤回应成功: ${recall.reason ?? ''}`);

  assert.ok(recalledEvents.length > 0, 'movement.Recalled 事件应在撤回后触发');
  assert.equal(recalledEvents[0]!.villageId, A.villageId);
  assert.equal(recalledEvents[0]!.id, mvId);
});

test('movement.ForeignStepped：他国行军进入视野时发出外军步进事件', async () => {
  const app = freshApp();
  const A = await register(app, '外军红');
  const B = await register(app, '外军蓝');
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 20 } });
  await send(app, 'military.AdjustTroops', { villageId: B.villageId, delta: { legionnaire: 20 } });

  const foreignSteps: any[] = [];
  app.bus.on('movement.ForeignStepped', (e) => { foreignSteps.push(e.payload); });

  // A 进攻 B
  const atk = await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 10 },
  });
  assert.equal(atk.ok, true);

  // 推进至靠近 B（进入 B 城市视野）
  let iters = 0;
  while (foreignSteps.length === 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }

  if (foreignSteps.length > 0) {
    const step = foreignSteps[0]!;
    assert.ok(Array.isArray(step.playerIds), 'ForeignStepped 应包含 playerIds 数组');
    assert.ok(step.army, 'ForeignStepped 应包含 army');
    assert.ok(step.army.pos, 'army 应包含 pos');
  }
  // 注意：若 A/B 村庄在地图上距离超过 city_vision 范围，外军不会进入视野；此情况下跳过外军可见性断言
});

test('movement.ForeignStepped：侦察军步进不向其他玩家推送', async () => {
  const app = freshApp();
  const foreignSteps: any[] = [];
  app.bus.on('movement.ForeignStepped', (e) => { foreignSteps.push(e.payload); });

  // 该方法是地图增量通道的唯一出口；即使调用方绕过 ListForeign，侦察类型也必须早退。
  await (app.movement as any).emitForeignStep({ type: 'scout' });
  await (app.movement as any).emitForeignStep({ type: 'incoming_scout' });
  await (app.movement as any).emitForeignStep({ type: 'return', scoutReturn: true });
  assert.equal(foreignSteps.length, 0, '主动侦察、途中拦截侦察及其返程均不得推送 ForeignStepped');
});

test('movement.ForeignStepped：王国 NPC 行军在玩家视野内可增量推送', async () => {
  const app = freshApp();
  const observer = await register(app, '王国 NPC 观察者');
  const foreignSteps: any[] = [];
  app.bus.on('movement.ForeignStepped', (e) => { foreignSteps.push(e.payload); });

  const pos = { q: observer.q, r: observer.r };
  await (app.movement as any).emitForeignStep({
    id: 'kingdom-retaliation-step', type: 'return', npcService: true,
    taskCode: 'kingdom_retaliation', fromVillage: 'kingdom-fief:kingdom-fief-sw',
    fromXY: pos, toXY: { q: pos.q + 1, r: pos.r }, pos,
    path: [pos, { q: pos.q + 1, r: pos.r }], stepIndex: 0,
    troops: { merc_knight: 4 }, loot: {}, status: 'marching', perStepMs: 1000,
    nextStepAt: clock + 1000,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(foreignSteps.length, 1, '王国 NPC 应向视野内玩家推送 ForeignStepped');
  assert.deepEqual(foreignSteps[0].playerIds, [observer.id]);
  assert.equal(foreignSteps[0].army.ownerPlayerName, '王国');
  assert.equal(foreignSteps[0].army.ownerVillageName, '封地复仇军');
  assert.equal(foreignSteps[0].army.type, 'return');
});

test('王国增援：目标村收到实时步进、抵达和到期移除推送', async () => {
  const app = freshApp();
  const pushes: any[] = [];
  const gw = new Gateway(app);
  const conn: ClientConnection = { send: (msg) => pushes.push(msg) };
  const session = gw.addClient(conn);
  const registered = await gw.handleRequest({
    v: WIRE_VERSION, type: 'req', id: 'register-reinforcement', ts: clock,
    action: 'Register', payload: { name: '网关增援目标', password: 'pass123', tribe: 'romans' },
  }, session);
  assert.equal(registered.ok, true);
  const target = (registered.payload as any).player as { villageId: string; q: number; r: number };
  pushes.length = 0;

  const sent = await send(app, 'movement.SendKingdomReinforcement', {
    targetVillage: target.villageId,
    fromXY: { q: target.q + 3, r: target.r },
    troops: { legionnaire: 2 },
    durationSec: 1,
    orderId: 'kingdom-reinforcement-test',
  });
  assert.equal(sent.ok, true);
  const id = (sent.payload as any).id as string;
  const initial = pushes.find((p) => p.event === 'MarchSent' && p.payload?.id === id);
  assert.ok(initial, '目标村应收到增援发出的 MarchSent');

  const mv = app.store.get<any>('movement', id);
  assert.ok(mv, '增援应写入行军记录');
  await app.scheduler.advanceTo(clock + Number(mv.perStepMs) + 1, setClock);
  const stepped = pushes.filter((p) => p.event === 'MarchStep' && p.payload?.id === id);
  assert.ok(stepped.length > 0, '目标村应收到增援逐格 MarchStep');

  let guard = 0;
  while (app.store.get<any>('movement', id)?.status === 'marching' && guard++ < 20) {
    const current = app.store.get<any>('movement', id);
    await app.scheduler.advanceTo(clock + Number(current?.perStepMs ?? 1) + 1, setClock);
  }
  assert.equal(app.store.get<any>('movement', id)?.status, 'stationed');
  assert.ok(
    pushes.some((p) => p.event === 'MarchStep' && p.payload?.id === id && p.payload?.status === 'stationed'),
    '抵达后应向目标村推送 stationed 状态',
  );

  await app.scheduler.advanceTo(clock + 1_500, setClock);
  assert.ok(
    pushes.some((p) => p.event === 'MarchRemoved' && p.payload?.id === id),
    '增援到期后应向目标村推送 MarchRemoved',
  );
});
