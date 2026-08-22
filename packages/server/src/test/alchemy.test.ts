import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 9_000_000;
const setClock = (t: number) => (clock = t);
function freshApp(): GameApp {
  clock = 9_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '炼金测试村');
  return app;
}
async function send(app: GameApp, name: string, payload: any = {}) {
  return app.commands.send({ name, from: 'test', payload });
}

test('炼金炉：三个同品质宝物炼化为更高品质并按掉率产出', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 } });
  const build = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'alchemy' });
  assert.equal(build.ok, true, `炼金炉建造应成功: ${build.reason ?? ''}`);
  await app.scheduler.advanceTo((build.payload as any).finishAt + 1, setClock);
  assert.equal((await send(app, 'building.GetBuildingLevel', { villageId: 'v1', kind: 'alchemy' })).payload.level, 1);

  // 扩展宝物栏，三个 common 宝物分别占据宝库主栏/城镇中心/备用栏。
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  for (let i = 0; i < 3; i++) assert.equal((await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' })).ok, true);
  const before = (await send(app, 'alchemy.Get', { villageId: 'v1' })).payload as any;
  assert.equal(before.available.length, 3);
  for (let slot = 0; slot < 3; slot++) {
    const item = before.available[slot];
    assert.equal((await send(app, 'alchemy.Select', { villageId: 'v1', slot, code: item.code, location: item.location })).ok, true);
  }
  assert.equal((await send(app, 'alchemy.Start', { villageId: 'v1' })).ok, true);
  await app.scheduler.advanceTo(clock + app.config.constants.alchemyRefineSec * 1000 + 1, setClock);
  const done = (await send(app, 'alchemy.Get', { villageId: 'v1' })).payload as any;
  assert.equal(done.refining, false);
  assert.ok(done.result, '炼化完成后应有待收获结果');
  assert.equal(done.result.rarity, 'rare', 'common 炼化结果应为 rare');
  assert.equal((await send(app, 'alchemy.Claim', { villageId: 'v1' })).ok, true);
  assert.equal((await send(app, 'alchemy.Get', { villageId: 'v1' })).payload.result, null);
});

test('炼金炉：第二、第三槽拒绝不同品质，最高品质没有可炼化目标', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 } });
  const build = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'alchemy' });
  await app.scheduler.advanceTo((build.payload as any).finishAt + 1, setClock);
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 2 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'iron_wall_medal' });
  const data = (await send(app, 'alchemy.Get', { villageId: 'v1' })).payload as any;
  const common = data.available.find((x: any) => x.code === 'war_flag');
  const rare = data.available.find((x: any) => x.code === 'iron_wall_medal');
  assert.equal((await send(app, 'alchemy.Select', { villageId: 'v1', slot: 0, code: common.code, location: common.location })).reason, undefined);
  const mismatch = await send(app, 'alchemy.Select', { villageId: 'v1', slot: 1, code: rare.code, location: rare.location });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'alchemy_quality_mismatch');
});
