import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 仓储超额 + 分资源停产（分城运输/掠夺通用规则）。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '测试村');
  const raw = app.store.get<any>('building', 'v1');
  for (const p of raw.placed) {
    if (['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(p.kind)) {
      p.level = 1;
      delete p.repairTargetLevel;
    }
  }
  app.store.set('building', 'v1', raw);
  app.building.reReportProduction('v1');
  return app;
}
const setClock = (t: number) => (clock = t);
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}

test('Grant 无露天仓库超额丢弃；有科技可溢出至 2 倍容量', async () => {
  const app = freshApp();
  const before = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const cap = before.capacity.wood as number;
  const gain = cap * 2;

  // 无露天仓库：超额丢弃，钳到容量
  const g1 = await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: gain } });
  assert.equal(g1.ok, true);
  const applied1 = (g1.payload as any).applied.wood;
  const discarded1 = (g1.payload as any).discarded.wood;
  const after1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(after1.resources.wood, cap, '无科技应钳到容量');
  assert.ok(discarded1 > 0, '超额部分应被丢弃');
  assert.equal(applied1, cap - before.resources.wood, '实际入库=容量-已有');

  // 有露天仓库科技：可溢出至 2 倍容量
  await send(app, 'economy.SetOverflowCap', { villageId: 'v1', cap: 1.0 });
  const g2 = await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: gain } });
  assert.equal(g2.ok, true);
  const after2 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(after2.resources.wood, cap * 2, '有科技应溢出至 2 倍容量');
  assert.ok(after2.overCapacity.wood > 0, 'overCapacity.wood > 0');
  assert.equal(after2.productionPaused.wood, true, '木材生产应暂停');
});

test('超额资源自然产出停止；未超额资源仍可产', async () => {
  const app = freshApp();
  // 有露天仓库科技才能超额
  await send(app, 'economy.SetOverflowCap', { villageId: 'v1', cap: 1.0 });
  const snap0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const cap = snap0.capacity.wood as number;
  // 把 wood 灌到超额；clay 保持未满
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: cap * 2 } });
  const mid = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const woodAtOver = mid.resources.wood as number;
  const clayBefore = mid.resources.clay as number;
  assert.equal(mid.productionPaused.wood, true);
  assert.equal(mid.productionPaused.clay, false);
  assert.ok(mid.netRate.wood <= 0, '超额木材净产率应为 0');

  // 快进 1 小时
  clock += 3_600_000;
  setClock(clock);
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(after.resources.wood, woodAtOver, '超额木材不应因生产增加');
  assert.ok(after.resources.clay > clayBefore || after.resources.clay >= after.capacity.clay,
    '未超额粘土应继续产出（或已顶满容量）');
});

test('消费使库存回落后生产恢复', async () => {
  const app = freshApp();
  const snap0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const cap = snap0.capacity.wood as number;
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: cap * 2 } });
  const over = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const excess = over.resources.wood - over.capacity.wood;
  // 花掉超额 + 一点，回到容量以下
  const spend = excess + 10;
  const sp = await send(app, 'economy.TrySpend', { villageId: 'v1', cost: { wood: spend } });
  assert.equal(sp.ok, true, `Spend 应成功: ${sp.reason ?? ''}`);
  const back = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(back.resources.wood <= back.capacity.wood, '应回到容量内');
  assert.equal(back.productionPaused.wood, false);
  assert.ok(back.netRate.wood > 0, '回落后木材应恢复正产率');

  const woodBefore = back.resources.wood as number;
  clock += 3_600_000;
  setClock(clock);
  const grown = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(grown.resources.wood > woodBefore || grown.resources.wood >= grown.capacity.wood,
    '恢复后应能自然产出');
});

test('SetCapacity 下调不砍库存，仍超额则继续停产', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 500 } });
  const mid = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const wood = mid.resources.wood as number;
  // 把容量压到存量以下
  const newCap = Math.max(1, Math.floor(wood / 2));
  const r = await send(app, 'economy.SetCapacity', {
    villageId: 'v1',
    capacity: { wood: newCap, clay: mid.capacity.clay, iron: mid.capacity.iron, crop: mid.capacity.crop },
  });
  assert.equal(r.ok, true);
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(after.resources.wood, wood, '下调容量不得砍库存');
  assert.equal(after.capacity.wood, newCap);
  assert.equal(after.productionPaused.wood, true);
});

test('自然产出顶在 capacity，不会自己涨到超额', async () => {
  const app = freshApp();
  // 先几乎填满木材
  const snap = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const room = snap.capacity.wood - snap.resources.wood;
  if (room > 1) {
    await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: room - 1 } });
  }
  // 长时间快进
  clock += 24 * 3_600_000;
  setClock(clock);
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(after.resources.wood <= after.capacity.wood, '自然产出不得超额');
  assert.equal(after.productionPaused.wood, true, '满仓应标记为停产');
});
