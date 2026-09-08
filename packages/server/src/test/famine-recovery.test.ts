import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

async function fixture(pop = 2, food = 800) {
  let clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.config.constants.popFamineTickSec = 60;
  app.config.constants.popDeathRateFactor = 0.5;
  app.config.constants.popCropPerLabor = 1;
  app.config.buildings.main.popGrowthPerLevel = 6;
  app.createVillage('famine-test', 0, 0, '饥荒恢复测试');
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  await flush();
  const state = app.store.get<any>('population', 'famine-test');
  Object.assign(state, { currentPop: pop, inFamine: true, starveTaskId: 'task-78195', lastTick: clock });
  const economy = app.store.get<any>('economy', 'famine-test');
  economy.resources.crop = food;
  economy.baseRate.crop = food > 0 ? 1300 / 3600 : 0;
  economy.wasCropDeficit = food <= 0;
  const recoveries: any[] = [];
  app.bus.on('population.Changed', e => { if ((e.payload as any).event === 'recovery') recoveries.push(e); });
  const advance = async (ms: number) => {
    await app.scheduler.advanceTo(clock + ms, t => { clock = t; });
    await flush();
  };
  const snapshot = async () => (await app.commands.send({
    name: 'population.GetSnapshot', from: 'test', payload: { villageId: 'famine-test' },
  })).payload as any;
  return { app, state, economy, recoveries, advance, flush, snapshot };
}

test('饥荒恢复：重启丢弃旧任务编号，立即恢复且重复 resume 不产生重复事件', async () => {
  const f = await fixture();
  // 旧编号还可能与新进程其他 owner 的任务撞号，不能按持久化 id 取消。
  let unrelatedRan = false;
  f.state.starveTaskId = f.app.scheduler.schedule(0, () => { unrelatedRan = true; }, 'unrelated-owner');
  f.state.lastTick -= 3600_000;
  f.app.population.resume();
  f.app.population.resume();
  await f.advance(0);
  assert.equal(unrelatedRan, true);
  assert.equal(f.state.inFamine, false);
  assert.equal(f.state.starveTaskId, undefined);
  assert.equal(f.state.currentPop, 2, '不能补算饥荒期间人口');
  assert.equal(f.recoveries.length, 1);
  assert.equal((await f.snapshot()).growthPerHour, 6);
  await f.advance(30_000);
  assert.ok(f.state.currentPop > 2, '恢复后周期结算实际增长');
  assert.equal(f.recoveries.length, 1);
});

for (const inFamine of [true, false]) {
  test(`饥荒恢复：重启时仍缺粮（原状态 ${inFamine}），重建单个任务且不提前减员`, async () => {
    const f = await fixture(10, 0);
    f.state.inFamine = inFamine;
    f.app.config.buildings.main.popGrowthPerLevel = 0;
    f.app.population.resume();
    f.app.population.resume();
    await f.advance(0);
    assert.equal(f.state.currentPop, 10);
    assert.notEqual(f.state.starveTaskId, 'task-78195');
    await f.advance(59_999);
    assert.equal(f.state.currentPop, 10);
    await f.advance(1);
    assert.ok(Math.abs(f.state.currentPop - 10 * Math.exp(-0.5 / 60)) < 1e-8);
    assert.equal(f.state.inFamine, true);
    assert.ok(f.state.starveTaskId);
    assert.equal(f.recoveries.length, 0);
  });
}

for (const pop of [0, 0.002]) {
  test(`饥荒恢复：运行中检查任务丢失后补粮，${pop} 人口仍由周期结算自愈`, async () => {
    const f = await fixture(pop, 0);
    f.economy.cropUpkeep.test_non_civilian = 8;
    f.app.population.resume();
    await f.advance(0);
    assert.equal(f.state.inFamine, true);
    assert.equal(f.recoveries.length, 0);
    f.app.scheduler.cancelByOwner('population:starve:famine-test');
    f.state.starveTaskId = undefined;
    f.economy.resources.crop = 800;
    f.economy.baseRate.crop = 1300 / 3600;
    await f.advance(30_000);
    assert.equal(f.state.inFamine, false);
    assert.equal(f.recoveries.length, 1);
    await f.advance(30_000);
    assert.ok(f.state.currentPop > pop);
  });
}

test('饥荒恢复：减员后粮食刚好收支平衡，当轮退出饥荒且不遗留任务', async () => {
  const f = await fixture(10, 0);
  f.app.config.constants.popProsperityMaxBonus = 0;
  f.economy.baseRate.crop = 9.96 / 3600;
  f.app.population.resume();
  await f.advance(0);
  await f.advance(60_000);
  assert.ok(f.state.currentPop < 9.96);
  assert.equal(f.state.inFamine, false);
  assert.equal(f.state.starveTaskId, undefined);
  assert.equal(f.recoveries.length, 1);
});

for (const failure of ['not_ok', 'missing_fields', 'reject']) {
  test(`饥荒恢复：粮食查询 ${failure} 时保留饥荒与人口，恢复查询后自动重试`, async () => {
    const f = await fixture(0, 0);
    f.economy.cropUpkeep.test_non_civilian = 8;
    const originalSend = f.app.commands.send.bind(f.app.commands);
    f.app.commands.send = async cmd => {
      if (cmd.name === 'economy.GetCropContext') {
        if (failure === 'reject') throw new Error('injected unavailable crop context');
        return { ok: failure === 'missing_fields', payload: {} as never };
      }
      return originalSend(cmd);
    };
    f.app.population.resume();
    await f.advance(0);
    await f.advance(60_000);
    assert.equal(f.state.inFamine, true);
    assert.equal(f.state.currentPop, 0);
    assert.ok(f.state.starveTaskId, '未知粮食状态不能丢失重试');
    assert.equal(f.recoveries.length, 0);
    f.app.commands.send = originalSend;
    f.economy.resources.crop = 800;
    await f.advance(30_000);
    assert.equal(f.state.inFamine, false);
    assert.equal(f.recoveries.length, 1);
  });
}
