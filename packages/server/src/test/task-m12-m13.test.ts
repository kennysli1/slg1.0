import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 4_000_000;

function freshApp(): GameApp {
  clock = 4_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  return app;
}

const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'task-m12-m13-test', payload });
const emit = (app: GameApp, name: string, payload: any) =>
  app.bus.emit({ name, source: 'task-m12-m13-test', ts: clock, payload } as any);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function register(app: GameApp, name: string): Promise<string> {
  const result = await send(app, 'player.Register', { name, password: 'pass1', tribe: 'romans' });
  assert.equal(result.ok, true, result.reason);
  await tick();
  return (result.payload as any).player.villageId as string;
}

test('M12 配置与流程：前置/两处强盗营地/最后一处固定掉落我的努力/手动领取奖励', async () => {
  const app = freshApp();
  const villageId = await register(app, 'm12-flow');

  assert.deepEqual(app.config.quests.m12.requires, ['m11']);
  assert.equal(app.config.quests.m12.objective.kind, 'clear_camp');
  assert.equal(app.config.quests.m12.objective.campTemplate, 'bandits');
  assert.equal(app.config.quests.m12.objective.count, 2);
  assert.equal(app.config.questGraph.conditions.find((row) => row.questCode === 'm12')?.value, 'council:1');

  const state = app.store.get<any>('task', villageId)!;
  state.completedMain = ['m11'];
  state.offeredMain = ['m12'];
  app.store.set('task', villageId, state);
  const preview = await send(app, 'task.StartAccept', { villageId, code: 'm12' });
  assert.equal(preview.ok, true, preview.reason);
  const previewDialogue = (preview.payload as any).dialogue;
  assert.equal(previewDialogue.npcName, '王国使者');
  assert.match(previewDialogue.npcText, /m12-flow的村庄的首领/);
  assert.match(previewDialogue.npcText, /东北封地的领主大人/);
  assert.doesNotMatch(previewDialogue.npcText, /\{(?:villageName|fiefName)\}/);
  const accepted = await send(app, 'task.Accept', { villageId, code: 'm12' });
  assert.equal(accepted.ok, true, accepted.reason);
  const active = app.store.get<any>('task', villageId)?.active.m12;
  assert.equal(active.camps.length, 2);
  for (const camp of active.camps) {
    const target = await send(app, 'pve.GetTarget', { id: camp.id });
    assert.equal(target.ok, true);
    assert.equal((target.payload as any).type, 'bandits');
    assert.equal((target.payload as any).task, true);
  }

  for (const [index, camp] of active.camps.entries()) {
    await emit(app, 'combat.BattleEnded', {
      side: 'attacker', attackerWins: true, villageId, targetKind: 'pve', targetId: camp.id,
      campCleared: true, movementId: `m12-battle-${index}`, treasures: [], looted: {},
    });
    await tick();
  }
  const after = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.equal(after.active.find((task: any) => task.code === 'm12')?.ready, true);
  const pending = app.store.all<any>('treasure_pending').find((item) => item.villageId === villageId && item.code === 'my_effort');
  assert.ok(pending, 'M12 最后一处营地应在报告生成我的努力');

  const delivered = await send(app, 'task.Deliver', { villageId, code: 'm12' });
  assert.equal(delivered.ok, true, delivered.reason);
  assert.deepEqual((delivered.payload as any).rewards.resources, { gold: 50 });
  assert.equal((delivered.payload as any).rewards.reputation, 5);
  assert.ok(app.store.get<any>('treasure_pending', pending.movementId), '任务宝物应独立等待报告处理，不被交任务吞掉');
});
test('M13 流程：使用我的努力解锁并生成二近丘陵秘密营地，调查抵达后驻扎并标记可领取', async () => {
  const app = freshApp();
  const villageId = await register(app, 'm13-flow');

  const granted = await send(app, 'treasure.Grant', { villageId, code: 'my_effort' });
  assert.equal(granted.ok, true, granted.reason);
  const used = await send(app, 'treasure.Use', { villageId, code: 'my_effort' });
  assert.equal(used.ok, true, used.reason);
  assert.equal((used.payload as any).dialogue?.code, 'my_effort_use');
  await tick();

  const offered = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(offered.offeredMain.some((task: any) => task.code === 'm13'), '使用我的努力后应出现 M13');
  let latestMapUpdate: any;
  const stopWatchingTaskMap = app.bus.on('task.MapUpdated', (event) => {
    if ((event.payload as any).villageId === villageId) latestMapUpdate = event.payload;
  });
  const accepted = await send(app, 'task.Accept', { villageId, code: 'm13' });
  assert.equal(accepted.ok, true, accepted.reason);
  const instance = app.store.get<any>('task', villageId)?.active.m13;
  assert.ok(instance?.taskVillageId);
  const target = (await send(app, 'pve.GetTarget', { id: instance.taskVillageId })).payload as any;
  assert.equal(target.type, 'secret_camp');
  assert.equal(target.task, true);
  assert.equal(target.ownerVillageId, villageId);
  assert.deepEqual(target.loot, { wood: 1000, clay: 1000, iron: 1000, crop: 1000, gold: 500 });
  assert.equal(target.defender.mercGuard.count, 8);
  assert.equal(target.defender.mercArcher.count, 3);

  // 秘密营地的坐标只在玩家当前视野内时随地图标记下发；视野外必须先探索，
  // 任务快照也不能泄露坐标。该断言按服务端权威视野结果判断，不依赖随机生成位置。
  const visibility = await send(app, 'vision.GetVisibility', { playerId: (await send(app, 'player.GetByVillage', { villageId })).payload.player.id, q: target.q, r: target.r });
  const isVisible = (visibility.payload as any).visibility === 'visible';
  const marker = (latestMapUpdate?.camps ?? []).find((camp: any) => camp.id === instance.taskVillageId);
  assert.equal(Boolean(marker), isVisible, '秘密营地只有在生成时处于玩家视野才显示地图标记');
  const stateAfterAccept = (await send(app, 'task.GetState', { villageId })).payload as any;
  const serialized = stateAfterAccept.active.find((task: any) => task.code === 'm13');
  assert.equal(Boolean(serialized?.taskVillageVisible), isVisible);
  if (!isVisible) {
    assert.equal(serialized?.taskVillageId, null, '视野外秘密营地不能从任务快照泄露坐标');
    assert.equal(serialized?.taskVillageXY, null, '视野外秘密营地不能从任务快照泄露坐标');
  }
  stopWatchingTaskMap();

  const troops = await send(app, 'military.AdjustTroops', { villageId, delta: { legionnaire: 1 } });
  assert.equal(troops.ok, true, troops.reason);
  const sent = await send(app, 'movement.SendInvestigate', {
    villageId, targetId: instance.taskVillageId, troops: { legionnaire: 1 },
  });
  assert.equal(sent.ok, true, sent.reason);
  const movementId = (sent.payload as any).id as string;
  for (let i = 0; i < 200; i++) {
    const movement = app.store.get<any>('movement', movementId);
    if (!movement || movement.status !== 'marching') break;
    clock = Math.max(clock, Number(movement.nextStepAt) || clock + 1);
    await app.scheduler.advanceTo(clock, (next) => { clock = next; });
    await tick();
  }
  const stationed = app.store.get<any>('movement', movementId);
  assert.equal(stationed?.type, 'investigate');
  assert.equal(stationed?.status, 'stationed');
  const state = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.equal(state.active.find((task: any) => task.code === 'm13')?.ready, true, '调查抵达后 M13 应等待手动领取');
});

test('M12 归入开眼看世界；M14 正声望兑换无期限佣兵；M15 负声望阈值奖励', async () => {
  const app = freshApp();
  const villageId = await register(app, 'm14-m15-flow');

  assert.equal(app.config.quests.m12.lineCode, 'world_exploration');
  assert.equal(app.config.quests.m14.lineCode, 'world_exploration');
  assert.equal(app.config.quests.m15.lineCode, 'world_exploration');
  assert.deepEqual(app.config.quests.m14.requires, ['m13']);
  assert.deepEqual(app.config.quests.m15.requires, ['m14']);
  assert.equal(app.config.quests.m14.objective.kind, 'submit_resources');
  assert.deepEqual(app.config.quests.m14.objective.resources, { crop: 500 });
  assert.equal(app.config.quests.m15.objective.kind, 'reputation_at_most');
  assert.equal(app.config.quests.m15.objective.threshold, -5);
  assert.deepEqual(app.config.quests.m14.rewards.reputationMercenaryExchange, { unitCode: 'merc_sword', perPoint: 2 });

  const state = app.store.get<any>('task', villageId)!;
  state.completedMain = ['m13'];
  state.offeredMain = ['m14'];
  app.store.set('task', villageId, state);
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: 3 });
  await send(app, 'economy.Grant', { villageId, gain: { crop: 500 } });
  assert.equal((await send(app, 'task.Accept', { villageId, code: 'm14' })).ok, true);
  const submitted = await send(app, 'task.SubmitResources', { villageId, code: 'm14', resources: { crop: 500 } });
  assert.equal(submitted.ok, true, submitted.reason);
  const delivered = await send(app, 'task.Deliver', { villageId, code: 'm14' });
  assert.equal(delivered.ok, true, delivered.reason);
  assert.deepEqual((delivered.payload as any).rewards.mercenaries, { merc_sword: 6 });
  assert.equal((delivered.payload as any).rewards.reputationResetFrom, 3);
  const repAfterM14 = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((repAfterM14.payload as any).value, 0, 'M14 交付后正声望应归零');
  const armyAfterM14 = await send(app, 'military.GetArmy', { villageId });
  assert.equal((armyAfterM14.payload as any).troops.merc_sword, 6, 'M14 应直接增加无期限佣兵');
  const mercState = app.store.get<any>('merc', villageId);
  assert.equal((mercState?.contracts ?? []).length, 0, '任务奖励佣兵不应登记营地合同');

  const afterM14 = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(afterM14.offeredMain.some((item: any) => item.code === 'm15'), '完成 M14 后应解锁 M15');
  assert.equal((await send(app, 'task.Accept', { villageId, code: 'm15' })).ok, true);
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: -5 });
  await tick();
  const m15State = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.equal(m15State.active.find((item: any) => item.code === 'm15')?.ready, true, '声望达到 -5 后 M15 应就绪');
  const m15Delivered = await send(app, 'task.Deliver', { villageId, code: 'm15' });
  assert.equal(m15Delivered.ok, true, m15Delivered.reason);
  assert.equal((m15Delivered.payload as any).rewards.researchPoints, 10);
  assert.equal((m15Delivered.payload as any).rewards.resourceGrowth?.percent, 25);
  assert.equal((m15Delivered.payload as any).rewards.resourceGrowth?.resource, 'crop');
  assert.equal((m15Delivered.payload as any).rewards.resourceGrowth?.durationSec, 86400);
  assert.ok(Number((m15Delivered.payload as any).rewards.resourceGrowth?.expiresAt) > 0);
  const economy = app.store.get<any>('economy', villageId);
  const cropBuff = (economy?.timedBuffs ?? []).find((buff: any) => buff.source === 'task:m15:resource_growth');
  assert.deepEqual(cropBuff?.mult, { crop: 0.25 }, 'M15 产量奖励只能作用于粮食');
});
