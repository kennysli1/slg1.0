import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('声望：新玩家默认为0，调整后返回善恶及派生效果', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '声望甲', password: 'p1234', tribe: 'romans' });
  const villageId = (reg.payload as any).player.villageId;
  const before = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((before.payload as any).value, 0);
  const adjusted = await send(app, 'reputation.AdjustByVillage', { villageId, delta: 20, reason: 'test' });
  assert.equal(adjusted.ok, true);
  assert.equal((adjusted.payload as any).alignment, 'good');
  assert.equal((adjusted.payload as any).populationGrowthMult, 1.1);
  const pop = await send(app, 'population.GetSnapshot', { villageId });
  assert.equal((pop.payload as any).growthPerHour > 0, true);
});

test('声望：S4两种抉择使用可调参数，善恶值方向相反', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '声望乙', password: 'p1234', tribe: 'romans' });
  const villageId = (reg.payload as any).player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: 2, reason: 's4_release_natalies' });
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: -2, reason: 's4_keep_natalies' });
  const rep = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((rep.payload as any).value, 0);
});

test('声望：符合门槛的善恶PvP攻击各只在派出时结算一次', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '声望善', password: 'p1234', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '声望恶', password: 'p1234', tribe: 'romans' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId: va, delta: 1 });
  await send(app, 'reputation.AdjustByVillage', { villageId: vb, delta: -11 });
  const hit = await send(app, 'reputation.ProcessPvpAttack', { attackerVillageId: va, targetVillageId: vb });
  assert.equal((hit.payload as any).value, 3);
  const second = await send(app, 'reputation.ProcessPvpAttack', { attackerVillageId: va, targetVillageId: vb });
  assert.equal((second.payload as any).value, 5);
});

test('声望：真实SendAttack派出后触发善恶奖励', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '声望丙', password: 'p1234', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '声望丁', password: 'p1234', tribe: 'romans' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId: va, delta: 1 });
  await send(app, 'reputation.AdjustByVillage', { villageId: vb, delta: -11 });
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 5 } });
  const launched = await send(app, 'movement.SendAttack', { villageId: va, targetVillage: vb, troops: { legionnaire: 5 }, declareWar: true });
  assert.equal(launched.ok, true);
  const rep = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((rep.payload as any).value, 3);
});
