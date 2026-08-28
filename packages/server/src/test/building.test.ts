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
  const fields = l.zones.outer.placed.filter((p: any) => ['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(p.kind));
  assert.equal(fields.length, 4, '开局 4 种资源田');
  assert.ok(fields.every((f: any) => f.level === 0 && f.damaged && f.repairTargetLevel === 1), '资源田开局应为 0 级受损并可修复至 1 级');
  assert.ok(l.queue.capacity >= 2, '开局队列容量≥2');
});

test('可建清单：城内/城外各只列本区建筑，前置未满足给灰显理由', async () => {
  const app = freshApp();
  const inner = (await send(app, 'building.GetBuildOptions', { villageId: 'v1', zone: 'inner' })).payload as any;
  const outer = (await send(app, 'building.GetBuildOptions', { villageId: 'v1', zone: 'outer' })).payload as any;
  assert.ok(inner.options.some((o: any) => o.kind === 'warehouse'), '城内可建仓库');
  assert.ok(inner.options.some((o: any) => o.kind === 'barracks'), '城内可建兵营');
  assert.ok(!outer.options.some((o: any) => o.kind === 'barracks'), '城外不列兵营');
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
  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'wall' });
  assert.equal(r.ok, false, '城墙是城外建筑，建到城内应拒绝');
  assert.equal(r.reason, 'zone_mismatch');
});

test('多队列并发：可同时排两条（开局容量2），第三条被拒', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const l0 = await layout(app);
  const cap = l0.queue.capacity;
  assert.ok(cap >= 2, '开局容量应≥2');
  // 用升级已有资源田排队（不占用空槽，纯测队列容量）
  const fields = l0.zones.outer.placed.filter((p: any) => ['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(p.kind));
  assert.ok(fields.length >= 3, '需要至少 3 块资源田来测队列');

  const r1 = await send(app, 'building.Repair', { villageId: 'v1', slotId: fields[0].slotId });
  const r2 = await send(app, 'building.Repair', { villageId: 'v1', slotId: fields[1].slotId });
  assert.equal(r1.ok, true, '第一条应入队');
  assert.equal(r2.ok, true, '第二条应入队');

  const l = await layout(app);
  assert.equal(l.queue.items.length, 2, '两条并行');

  if (cap === 2) {
    const r3 = await send(app, 'building.Repair', { villageId: 'v1', slotId: fields[2].slotId });
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

test('迁移：旧存档军事建筑从城外归位到城内（reconcileZones）', async () => {
  const app = freshApp();
  // 模拟 CSV 改区前创建的旧存档：兵营被持久化为城外（zone/slotId 冻结在原区）
  const raw = app.store.get('building', 'v1') as any;
  assert.ok(raw, '应有建筑存档');
  // 兵营不再属于新村固定开局建筑，先注入一条旧存档记录来模拟迁移。
  const barracks = { slotId: 'outer-9', zone: 'outer', kind: 'barracks', level: 1 };
  raw.placed.push(barracks);
  barracks.zone = 'outer';
  barracks.slotId = 'outer-9';
  app.store.set('building', 'v1', raw);

  // 触发迁移（resume 内部调用 reconcileZones，把 zone 对齐回当前 CSV 的 def.zone）
  app.resume();

  const l = await layout(app);
  assert.ok(l.zones.inner.placed.some((p: any) => p.kind === 'barracks'), '兵营应归入城内');
  assert.ok(!l.zones.outer.placed.some((p: any) => p.kind === 'barracks'), '城外不应再有兵营');
  assert.ok(l.zones.inner.slots > 0, '城内仍有槽位');
});

test('城镇中心升级逐等级开放城内槽位（无平坡）', async () => {
  const app = freshApp();
  const l0 = await layout(app);
  const inner1 = l0.zones.inner.slots;
  assert.equal(l0.townCenter.level, 1);
  // 逐等级升城镇中心，记录城内槽位变化
  let prev = inner1;
  for (let target = 2; target <= 4; target++) {
    const r = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: 'center' });
    assert.equal(r.ok, true, `升城镇中心到 ${target} 应成功: ${r.reason ?? ''}`);
    await app.scheduler.advanceTo(clock + 300_000, setClock);
    const l = await layout(app);
    assert.equal(l.townCenter.level, target, `城镇中心达 ${target} 级`);
    assert.ok(l.zones.inner.slots >= prev, `城内槽位不应减少（TC${target}）`);
    prev = l.zones.inner.slots;
  }
  // 1→4 本至少应净增多个城内槽位
  assert.ok(prev > inner1, `主基地升级应开放更多城内槽位（1本=${inner1} -> 4本=${prev}）`);
});

// ── 拆除（DemolishBuilding）────────────────────────────────────────
test('拆除：已建成非城镇中心建筑 → 成功占槽、拆除期间无加成、完成后整栋移除并释放槽位', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });

  // 建居民楼（纯人口建筑，提供 popCap）
  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'residence' });
  assert.equal(r.ok, true, `建居民楼应成功: ${r.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 600_000, setClock);

  const built = await layout(app);
  const res = built.zones.inner.placed.find((p: any) => p.kind === 'residence');
  assert.ok(res && res.level === 1, '居民楼落成 1 级');
  const freeBefore = built.zones.inner.freeSlots;

  const capBefore = (await send(app, 'building.GetPopCap', { villageId: 'v1' })).payload as any;
  assert.ok(capBefore.hardCap > 0, '开局已有硬上限');

  // 拆除
  const d = await send(app, 'building.Demolish', { villageId: 'v1', slotId: res.slotId });
  assert.equal(d.ok, true, `拆除应成功: ${d.reason ?? ''}`);
  assert.ok(typeof d.payload.finishAt === 'number', '应返回 finishAt');

  // 拆除期间：level=0、demolishing=true、不产出、仍占槽、硬上限已扣除
  const during = await layout(app);
  const dslot = during.zones.inner.placed.find((p: any) => p.kind === 'residence');
  assert.ok(dslot, '拆除期间建筑仍在槽位');
  assert.equal(dslot.level, 0, '拆除期间 level 置 0（无加成）');
  assert.equal(dslot.demolishing, true, '应标记 demolishing');
  assert.ok(!dslot.producing, '拆除期间不产出');
  assert.equal(during.zones.inner.freeSlots, freeBefore, '拆除期间仍占槽（未释放）');

  const capDuring = (await send(app, 'building.GetPopCap', { villageId: 'v1' })).payload as any;
  assert.ok(capDuring.hardCap < capBefore.hardCap, '拆除期间人口上限应已扣除居民楼贡献');

  // 完成
  await app.scheduler.advanceTo((d.payload.finishAt as number) + 1000, setClock);
  const after = await layout(app);
  const gone = after.zones.inner.placed.find((p: any) => p.kind === 'residence');
  assert.ok(!gone, '完成后居民楼整栋移除');
  assert.equal(after.zones.inner.freeSlots, freeBefore + 1, '完成后槽位释放');

  const capAfter = (await send(app, 'building.GetPopCap', { villageId: 'v1' })).payload as any;
  assert.equal(capAfter.hardCap, capDuring.hardCap, '完成后硬上限与拆除期间一致（居民楼贡献为 0）');
});

test('拆除：城镇中心不可拆除', async () => {
  const app = freshApp();
  const r = await send(app, 'building.Demolish', { villageId: 'v1', slotId: 'center' });
  assert.equal(r.ok, false, '城镇中心应拒绝拆除');
  assert.equal(r.reason, 'cannot_demolish_center');
});

test('拆除：建造中的建筑（level<1）不可拆除', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const r = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'warehouse' });
  assert.equal(r.ok, true, '建造应成功');
  const wh = (await layout(app)).zones.inner.placed.find((p: any) => p.kind === 'warehouse');
  const r2 = await send(app, 'building.Demolish', { villageId: 'v1', slotId: wh.slotId });
  assert.equal(r2.ok, false, '建造中不可拆除');
  assert.equal(r2.reason, 'still_constructing');
});

test('拆除：重复拆除同一建筑应被拒（already_demolishing）', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'warehouse' });
  await app.scheduler.advanceTo(clock + 600_000, setClock);
  const wh = (await layout(app)).zones.inner.placed.find((p: any) => p.kind === 'warehouse');
  const d1 = await send(app, 'building.Demolish', { villageId: 'v1', slotId: wh.slotId });
  assert.equal(d1.ok, true, '首次拆除应成功');
  const d2 = await send(app, 'building.Demolish', { villageId: 'v1', slotId: wh.slotId });
  assert.equal(d2.ok, false, '重复拆除应被拒');
  assert.equal(d2.reason, 'already_demolishing');
});

test('战斗拆除：按最高等级逐级拆除并返回对应升级资源', async () => {
  const app = freshApp();
  const raw = app.store.get('building', 'v1') as any;
  const wood = raw.placed.find((p: any) => p.kind === 'woodcutter');
  const clay = raw.placed.find((p: any) => p.kind === 'claypit');
  assert.ok(wood && clay);
  wood.level = 5;
  clay.level = 5;
  app.store.set('building', 'v1', raw);

  const damaged = await send(app, 'building.ApplyBattleDamage', {
    villageId: 'v1', zone: 'outer', power: 300, powerPerLevel: 100,
  });
  assert.equal(damaged.ok, true);
  const rows = (damaged.payload as any).destroyed;
  assert.equal(rows.length, 3, '300 战力应拆 3 级');
  assert.ok(rows.every((x: any) => x.fromLevel >= 4), '应从最高等级建筑开始拆');
  const after = await layout(app);
  const afterWood = after.zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  const afterClay = after.zones.outer.placed.find((p: any) => p.kind === 'claypit');
  assert.equal((afterWood?.level ?? 0) + (afterClay?.level ?? 0), 7, '总等级应从10降到7');
  assert.ok(Object.values((damaged.payload as any).loot).some((x: any) => Number(x) > 0), '应返回拆除对应升级资源');
});

test('战斗破坏：建筑保留在槽位、不可升级，可按累计成本三分之一时间一次性修复', async () => {
  const app = freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 999999, clay: 999999, iron: 999999, crop: 999999, gold: 999999 } });
  const raw = app.store.get('building', 'v1') as any;
  const wood = raw.placed.find((p: any) => p.kind === 'woodcutter');
  assert.ok(wood);
  wood.level = 3;
  for (const p of raw.placed) if (p.zone === 'outer') { p.level = p === wood ? 3 : 0; delete p.repairTargetLevel; }
  app.store.set('building', 'v1', raw);

  const hit = await send(app, 'building.ApplyBattleDamage', {
    villageId: 'v1', zone: 'outer', power: 300, powerPerLevel: 100, mode: 'damage',
  });
  assert.equal(hit.ok, true);
  const rows = (hit.payload as any).destroyed;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x: any) => x.mode === 'damage' && x.loot && Object.values(x.loot).some((n: any) => Number(n) > 0)));
  assert.ok(Object.values((hit.payload as any).loot).some((n: any) => Number(n) > 0), '普通部队破坏建筑也应返回对应等级的建筑战利品');
  const during = await layout(app);
  const damaged = during.zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  assert.ok(damaged, '破坏到0级仍应保留建筑槽位');
  assert.equal(damaged.level, 0);
  assert.equal(damaged.damaged, true);
  assert.equal(damaged.repairTargetLevel, 3);
  assert.equal(damaged.nextCost, null, '受损建筑不能继续升级');
  assert.ok(damaged.repairCost && Object.values(damaged.repairCost).some((n: any) => n > 0));

  const repair = await send(app, 'building.Repair', { villageId: 'v1', slotId: damaged.slotId });
  assert.equal(repair.ok, true, `修复应成功: ${repair.reason ?? ''}`);
  assert.ok((repair.payload as any).timeSec >= 1);
  await app.scheduler.advanceTo((repair.payload as any).finishAt + 1, setClock);
  const restored = (await layout(app)).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  assert.ok(restored);
  assert.equal(restored.level, 3);
  assert.equal(restored.damaged, false);
  assert.equal(restored.repairTargetLevel, undefined);
});

test('战斗拆除：攻城武器可以移除已经被普通部队打到0级的建筑空壳', async () => {
  const app = freshApp();
  const raw = app.store.get('building', 'v1') as any;
  const wood = raw.placed.find((p: any) => p.kind === 'woodcutter');
  assert.ok(wood);
  wood.level = 1;
  for (const p of raw.placed) if (p.zone === 'outer') { p.level = p === wood ? 1 : 0; delete p.repairTargetLevel; }
  app.store.set('building', 'v1', raw);

  await send(app, 'building.ApplyBattleDamage', {
    villageId: 'v1', zone: 'outer', power: 100, powerPerLevel: 100, mode: 'damage',
  });
  const damaged = (await layout(app)).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  assert.equal(damaged?.level, 0);
  assert.equal(damaged?.repairTargetLevel, 1);

  const removed = await send(app, 'building.ApplyBattleDamage', {
    villageId: 'v1', zone: 'outer', power: 100, powerPerLevel: 100, mode: 'demolish',
  });
  assert.equal(removed.ok, true);
  assert.equal((removed.payload as any).destroyed[0].fromLevel, 0);
  assert.equal((removed.payload as any).destroyed[0].toLevel, 0);
  assert.equal((removed.payload as any).destroyed[0].removed, true);
  assert.equal((await layout(app)).zones.outer.placed.some((p: any) => p.kind === 'woodcutter'), false);
});

test('保险库：保护量按等级累加，攻城拆除后立即减少', async () => {
  const app = freshApp();
  const raw = app.store.get('building', 'v1') as any;
  raw.placed.push({ slotId: 'inner-vault-test', zone: 'inner', kind: 'vault', level: 2 });
  app.store.set('building', 'v1', raw);

  const before = await send(app, 'building.GetVaultProtection', { villageId: 'v1' });
  assert.deepEqual((before.payload as any).protection, { wood: 250, clay: 250, iron: 250, crop: 250, gold: 2500 });

  const damaged = await send(app, 'building.ApplyBattleDamage', {
    villageId: 'v1', zone: 'inner', power: 100, powerPerLevel: 100,
  });
  assert.equal(damaged.ok, true);
  const afterOne = await send(app, 'building.GetVaultProtection', { villageId: 'v1' });
  assert.deepEqual((afterOne.payload as any).protection, { wood: 100, clay: 100, iron: 100, crop: 100, gold: 1000 });

  await send(app, 'building.ApplyBattleDamage', { villageId: 'v1', zone: 'inner', power: 100, powerPerLevel: 100 });
  const afterDestroyed = await send(app, 'building.GetVaultProtection', { villageId: 'v1' });
  assert.deepEqual((afterDestroyed.payload as any).protection, { wood: 0, clay: 0, iron: 0, crop: 0, gold: 0 });
});

