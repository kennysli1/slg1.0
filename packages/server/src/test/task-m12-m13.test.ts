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
  assert.equal((used.payload as any).dialogue, null, '空白 GM 对话模板不应弹出空对话框');
  await tick();

  const offered = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(offered.offeredMain.some((task: any) => task.code === 'm13'), '使用我的努力后应出现 M13');
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
