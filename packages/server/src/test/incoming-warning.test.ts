import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { linePathWrapped, wrapHex } from '../infra/hex.js';

let clock = 9_000_000;
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

function freshApp(): GameApp {
  clock = 9_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

async function register(app: GameApp, name: string) {
  const result = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(result.ok, true);
  return (result.payload as any).player;
}

function incomingRecord(app: GameApp, attacker: any, defender: any, troops: Record<string, number>, treasures: string[] = []): any {
  const W = app.config.constants.worldW ?? 96;
  const H = app.config.constants.worldH ?? 96;
  const from = { q: attacker.q, r: attacker.r };
  const to = { q: defender.q, r: defender.r };
  const path = linePathWrapped(from, to, W, H);
  const pos = wrapHex({ q: defender.q + 1, r: defender.r }, W, H);
  return {
    id: 'incoming-1', type: 'attack', battleType: 'siege',
    fromVillage: attacker.villageId, targetVillage: defender.villageId,
    fromXY: from, originalFromXY: from, toXY: to,
    troops: { ...troops }, treasures: [...treasures],
    departAt: clock - 10_000, launchedAt: clock - 10_000, arriveAt: clock + 600_000,
    path, stepIndex: Math.max(0, path.length - 2), pos,
    perStepMs: 10_000, nextStepAt: clock + 10_000,
    status: 'marching', stepToken: 1,
  };
}

test('来袭预警：仅当前可见时存在，完整来袭 movement 与兵力不会泄露，也不写入战报', async () => {
  const app = freshApp();
  const attacker = await register(app, '预警攻方');
  const defender = await register(app, '预警守方');
  const incoming = incomingRecord(app, attacker, defender, { legionnaire: 20, equlegati: 2 }, ['victory_flag']);
  app.store.set('movement', incoming.id, incoming);
  // 主动侦察抵达守方村庄时不应作为完整来袭 movement 或预警暴露给守方。
  app.store.set('movement', 'incoming-scout-hidden', {
    ...incoming,
    id: 'incoming-scout-hidden',
    type: 'scout',
    troops: { equlegati: 4 },
    treasures: [],
  });

  const changes: any[] = [];
  app.bus.on('movement.IncomingWarningChanged', (event: any) => { changes.push(event.payload); });
  await (app.movement as any).syncIncomingWarningVisibility(incoming);

  const visible = await send(app, 'movement.List', { villageId: defender.villageId });
  const payload = visible.payload as any;
  assert.equal(payload.movements.some((movement: any) => movement.id === incoming.id), false, '守方不得取得敌方完整 movement');
  assert.equal(payload.movements.some((movement: any) => movement.id === 'incoming-scout-hidden'), false, '守方不得看到来袭侦察 movement');
  assert.equal(payload.incomingWarnings.length, 1);
  assert.equal(payload.incomingWarnings[0].troops, undefined, '未侦察前不得泄露兵力');
  assert.equal(payload.incomingWarnings[0].treasures, undefined, '未侦察前不得泄露宝物');
  assert.ok(Array.isArray(payload.incomingWarnings[0].path), '预警应提供来袭路径');
  assert.equal(payload.incomingWarnings[0].targetVillageName, defender.villages?.[0]?.name ?? defender.name);
  assert.equal(changes.at(-1)?.visible, true);

  const playerView = await send(app, 'movement.ListPlayer', { playerId: defender.id });
  assert.equal((playerView.payload as any).incomingWarnings.length, 1, '玩家级行军列表应聚合所有己方村庄的实时预警');

  const far = wrapHex({ q: defender.q + 24, r: defender.r + 24 }, app.config.constants.worldW, app.config.constants.worldH);
  incoming.pos = far;
  app.store.set('movement', incoming.id, incoming);
  await (app.movement as any).syncIncomingWarningVisibility(incoming);
  const hidden = await send(app, 'movement.List', { villageId: defender.villageId });
  assert.equal((hidden.payload as any).incomingWarnings.length, 0, '失去实时视野后预警必须消失');
  assert.equal(changes.at(-1)?.visible, false);

  const notifications = await send(app, 'notifications.List', { villageId: defender.villageId });
  assert.equal((notifications.payload as any).notifications.some((item: any) => item.event === 'IncomingAttack'), false);
  assert.equal((notifications.payload as any).notifications.some((item: any) => item.event === 'IncomingWarningChanged'), false);
});

test('途中侦察：守方侦察兵按普通反侦察准则杀伤进攻方，来袭路径与 ETA 不变', async () => {
  const app = freshApp();
  const attacker = await register(app, '途中侦察来袭方');
  const defender = await register(app, '途中侦察守方');
  await send(app, 'military.AdjustTroops', { villageId: defender.villageId, delta: { equlegati: 3 } });
  const incoming = incomingRecord(app, attacker, defender, { legionnaire: 12, equlegati: 2 }, ['victory_flag']);
  const originalPath = structuredClone(incoming.path);
  const originalArriveAt = incoming.arriveAt;
  app.store.set('movement', incoming.id, incoming);

  const reports: any[] = [];
  app.bus.on('movement.ScoutReport', (event: any) => { reports.push(event.payload); });
  const sent = await send(app, 'movement.SendIncomingScout', {
    villageId: defender.villageId, movementId: incoming.id, troops: { equlegati: 3 },
  });
  assert.equal(sent.ok, true, `途中侦察应能派出: ${sent.reason ?? ''}`);
  const scout = app.store.get<any>('movement', (sent.payload as any).id)!;
  scout.pos = { ...incoming.pos };
  scout.previousPos = { ...incoming.pos };
  incoming.previousPos = { ...incoming.pos };
  await (app.movement as any).resolveIncomingScout(scout, incoming);

  const stillIncoming = app.store.get<any>('movement', incoming.id);
  assert.ok(stillIncoming, '仍有非侦察兵时来袭军必须继续行军');
  assert.deepEqual(stillIncoming.path, originalPath, '侦察战不得改变来袭路径');
  assert.equal(stillIncoming.arriveAt, originalArriveAt, '侦察战不得重置来袭倒计时');
  assert.equal(stillIncoming.troops.legionnaire, 12);
  assert.equal(stillIncoming.troops.equlegati, 2, '普通反侦察不会消耗守方侦察兵');
  assert.equal(stillIncoming.incomingIntel.troops.legionnaire, 12);
  assert.equal(stillIncoming.incomingIntel.treasures, undefined, '本方有侦察兵损失，不构成完胜');

  const attackerReport = reports.find((report) => report.side === 'attacker');
  const defenderReport = reports.find((report) => report.side === 'defender');
  assert.ok(attackerReport, '有幸存侦察兵时守方应收到兵力报告');
  assert.ok(defenderReport, '来袭军拥有侦察兵时应收到反侦察报告');
  assert.equal(attackerReport.attackerLosses.equlegati, 2);
  assert.deepEqual(attackerReport.defenderLosses, {});
  assert.equal(attackerReport.perfectVictory, false);

  const warning = await send(app, 'movement.List', { villageId: defender.villageId });
  assert.equal((warning.payload as any).incomingWarnings[0].intelligence.troops.legionnaire, 12, '预警应更新侦察取得的兵力');
});

test('途中侦察完胜：零损失且有幸存者时识别宝物；无敌方侦察兵则来袭方不收到报告', async () => {
  const app = freshApp();
  const attacker = await register(app, '完胜来袭方');
  const defender = await register(app, '完胜侦察方');
  await send(app, 'military.AdjustTroops', { villageId: defender.villageId, delta: { equlegati: 1 } });
  const incoming = incomingRecord(app, attacker, defender, { legionnaire: 8 }, ['victory_flag']);
  app.store.set('movement', incoming.id, incoming);
  const reports: any[] = [];
  app.bus.on('movement.ScoutReport', (event: any) => { reports.push(event.payload); });
  const sent = await send(app, 'movement.SendIncomingScout', {
    villageId: defender.villageId, movementId: incoming.id, troops: { equlegati: 1 },
  });
  assert.equal(sent.ok, true);
  const scout = app.store.get<any>('movement', (sent.payload as any).id)!;
  scout.pos = { ...incoming.pos };
  await (app.movement as any).resolveIncomingScout(scout, incoming);

  const resolved = app.store.get<any>('movement', incoming.id);
  assert.equal(resolved.incomingIntel.perfectVictory, true);
  assert.deepEqual(resolved.incomingIntel.treasures, ['victory_flag']);
  assert.equal(reports.filter((report) => report.side === 'attacker').length, 1);
  assert.equal(reports.filter((report) => report.side === 'defender').length, 0, '来袭军无侦察兵时不能发现反侦察行动');
});

test('冒险者可以执行途中侦察，但不能担任防守侦察兵', async () => {
  const app = freshApp();
  const attacker = await register(app, '冒险者来袭方');
  const defender = await register(app, '冒险者防守方');
  await send(app, 'military.AdjustTroops', { villageId: defender.villageId, delta: { adventurer: 1 } });
  // 来袭军包含冒险者但没有真实侦察兵：冒险者可以取得情报，且不应被当成防守侦察兵。
  const incoming = incomingRecord(app, attacker, defender, { legionnaire: 5, adventurer: 3 });
  app.store.set('movement', incoming.id, incoming);
  await (app.movement as any).syncIncomingWarningVisibility(incoming);
  const sent = await send(app, 'movement.SendIncomingScout', {
    villageId: defender.villageId, movementId: incoming.id, troops: { adventurer: 1 },
  });
  assert.equal(sent.ok, true, `冒险者应可执行途中侦察: ${sent.reason ?? ''}`);
  const scout = app.store.get<any>('movement', (sent.payload as any).id)!;
  scout.pos = { ...incoming.pos };
  scout.previousPos = { ...incoming.pos };
  incoming.previousPos = { ...incoming.pos };
  await (app.movement as any).resolveIncomingScout(scout, incoming);
  const resolved = app.store.get<any>('movement', incoming.id);
  assert.deepEqual(resolved.incomingIntel.troops, incoming.troops, '冒险者应取得来袭部队的实时兵力');
  assert.deepEqual(resolved.incomingIntel.treasures, [], '无携带宝物时完胜情报应为空数组');
});
