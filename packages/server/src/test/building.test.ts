import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 建筑三区系统端到端测试：城镇中心解锁槽位 + 城内/城外分池 + 点空槽建造 + 多队列。
 * 对应 11_建筑系统重做.md / 12_建筑系统重构架构规划.md。
 */

let clock = 3_000_000;
const setClock = (t: number) => (clock = t);

function freshApp(): GameApp {
  clock = 3_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '测试村');
  return app;
}
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}
const layout = async (app: GameApp) =>
  (await send(app, 'building.GetLayout', { villageId: 'v1' })).payload as any;

test('三区布局：开局有城镇中心 + 城内/城外槽位 + 预置资源田', async () => {
  const app = freshApp();
  const l = await layout(app);
  assert.equal(l.townCenter.kind, 'main', '有城镇中心');
  assert.equal(l.townCenter.level, 1);
  assert.ok(l.zones.inner.slots > 0, '城内有槽位');
  assert.ok(l.zones.outer.slots > 0, '城外有槽位');
  // 4 种资源田预置在城外
  const fields = l.zones.outer.placed.filter((p: any) => p.producing);
  assert.equal(fields.length, 4, '开局 4 种资源田');
  assert.ok(fields.every((f: any) => f.level === 1), '资源田开局 1 级');
  assert.ok(l.queue.capacity >= 2, '开局队列容量≥2');
});

test('可建清单：城内/城外各只列本区建筑，前置未满足给灰显理由', async () => {
  const app = freshApp();
  const inner = (await send(app, 'building.GetBuildOptions', { villageId: 'v1', zone: 'inner' })).payload as any;
  const outer = (await send(app, 'building.GetBuildOptions', { villageId: 'v1', zone: 'outer' })).payload as any;
  assert.ok(inner.options.some((o: any) => o.kind === 'warehouse'), '城内可建仓库');
  assert.ok(!inner.options.some((o: any) => o.kind === 'barracks'), '城内不列兵营');
  assert.ok(outer.options.some((o: any) => o.kind === 'barracks'), '城外可建兵营');
  // 学院需城镇中心 3 级 → 开局锁定并给理由
  const academy = inner.options.find((o: any) => o.kind === 'academy');
  assert.ok(academy && !academy.unlocked && academy.lockReason, '学院应锁定且有理由');
});

test('点空槽建造：城内建仓库 → 占槽 → 完成落成', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const before = await layout(app);
  const freeBefore = before.zones.inner.freeSlots;

  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'warehouse' });
  assert.equal(r.ok, true, `建造应成功: ${r.reason ?? ''}`);

  // 立即占槽（建造中占位）
  const during = await layout(app);
  assert.equal(during.zones.inner.freeSlots, freeBefore - 1, '建造即占一个空槽');
  assert.equal(during.queue.items.length, 1, '队列有一项');

  // 完成
  await app.scheduler.advanceTo(clock + 60_000, setClock);
  const after = await layout(app);
  const wh = after.zones.inner.placed.find((p: any) => p.kind === 'warehouse');
  assert.ok(wh && wh.level === 1, '仓库落成 1 级');
  assert.equal(after.queue.items.length, 0, '队列清空');
});

test('槽位上限：城内槽满后拒绝继续建造', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const l0 = await layout(app);
  const free = l0.zones.inner.freeSlots;
  const cap = l0.queue.capacity;

  // 逐个填满城内空槽（用不同建筑避免同类堆叠无所谓，这里都建仓库亦可）
  const kinds = ['warehouse', 'granary', 'wall', 'rallypoint', 'smithy'];
  let built = 0;
  for (let i = 0; i < free && built < kinds.length; i++) {
    // 队列满则先推进清空
    let cur = await layout(app);
    if (cur.queue.items.length >= cap) { await app.scheduler.advanceTo(clock + 120_000, setClock); }
    const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: kinds[built] });
    if (r.ok) built++;
  }
  await app.scheduler.advanceTo(clock + 600_000, setClock);

  const filled = await layout(app);
  // 城内已无空槽时，再建应被拒
  if (filled.zones.inner.freeSlots === 0) {
    const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'warehouse' });
    assert.equal(r.ok, false, '城内槽满应拒绝');
    assert.equal(r.reason, 'no_free_slot');
  }
});

test('前置门控：学院开局锁定（需城镇中心3级），Build 应拒绝', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'academy' });
  assert.equal(r.ok, false, '前置未满足应拒绝');
  assert.equal(r.reason, 'requires_not_met');
});

test('zone 校验：把城外建筑建到城内应拒绝', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'barracks' });
  assert.equal(r.ok, false, '兵营是城外建筑，建到城内应拒绝');
  assert.equal(r.reason, 'zone_mismatch');
});

test('多队列并发：可同时排两条（开局容量2），第三条被拒', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const l0 = await layout(app);
  const cap = l0.queue.capacity;
  assert.ok(cap >= 2, '开局容量应≥2');
  // 用升级已有资源田排队（不占用空槽，纯测队列容量）
  const fields = l0.zones.outer.placed.filter((p: any) => p.producing);
  assert.ok(fields.length >= 3, '需要至少 3 块资源田来测队列');

  const r1 = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: fields[0].slotId });
  const r2 = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: fields[1].slotId });
  assert.equal(r1.ok, true, '第一条应入队');
  assert.equal(r2.ok, true, '第二条应入队');

  const l = await layout(app);
  assert.equal(l.queue.items.length, 2, '两条并行');

  if (cap === 2) {
    const r3 = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: fields[2].slotId });
    assert.equal(r3.ok, false, '超容量应拒绝');
    assert.equal(r3.reason, 'queue_full');
  }
});

test('城镇中心升级：解锁更多槽位', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const l0 = await layout(app);
  const innerBefore = l0.zones.inner.slots;
  const outerBefore = l0.zones.outer.slots;

  // 升城镇中心到 3 级
  for (let target = 2; target <= 3; target++) {
    const r = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: 'center' });
    assert.equal(r.ok, true, `升城镇中心到 ${target} 应成功: ${r.reason ?? ''}`);
    await app.scheduler.advanceTo(clock + 300_000, setClock);
  }
  const l1 = await layout(app);
  assert.equal(l1.townCenter.level, 3, '城镇中心达 3 级');
  assert.ok(l1.zones.inner.slots >= innerBefore, '城内槽位不减');
  assert.ok(l1.zones.outer.slots >= outerBefore, '城外槽位不减');
  assert.ok(l1.zones.inner.slots + l1.zones.outer.slots > innerBefore + outerBefore, '总槽位应增加');
});

test('仓储容量：建仓库后 economy 容量上升', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const before = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'warehouse' });
  await app.scheduler.advanceTo(clock + 60_000, setClock);
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(after.capacity.wood > before.capacity.wood, '建仓库后木材容量应上升');
});
