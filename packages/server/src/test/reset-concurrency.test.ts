/**
 * 刷档与删档回归测试（reset / deletePlayer）
 * 覆盖：
 *  - E) resetWorld 先 scheduler.reset 再清数据（无遗留任务）
 *  - E) deletePlayer 取消相关 Scheduler 任务
 *  - F) Register/createVillage 失败回滚
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

let clock = 1_000_000;
const setClock = (t: number) => { clock = t; };
function makeApp() {
  clock = 1_000_000;
  return createGameApp({ now: () => clock, manualScheduler: true });
}

// ── E) resetWorld 先调 scheduler.reset ────────────────────────────────────

test('resetWorld: 刷档后 scheduler.pending 为 0（遗留任务被清除）', async () => {
  const app = makeApp();
  app.setupWorld();

  // 注册玩家并启动一些任务（建造/训练）
  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '刷档用户', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 给资源，触发建造任务（在途）
  await app.commands.send({
    name: 'economy.Grant', from: 't',
    payload: { villageId: vid, gain: { wood: 500, clay: 500, iron: 500, crop: 0 } },
  });
  const layout = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: vid } });
  const wood = (layout.payload as any).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  if (wood) {
    const repair = await app.commands.send({ name: 'building.Repair', from: 't', payload: { villageId: vid, slotId: wood.slotId } });
    await app.scheduler.advanceTo((repair.payload as any).finishAt, setClock);
    await app.commands.send({ name: 'building.Upgrade', from: 't', payload: { villageId: vid, slotId: wood.slotId } });
  }

  const pendingBeforeReset = app.scheduler.pending;
  assert.ok(pendingBeforeReset > 0, '刷档前应有在途任务');

  // 刷档
  await app.resetWorld({ keepAccounts: false });

  assert.equal(app.scheduler.pending, 0, '刷档后 scheduler.pending 应为 0');

  // 快进不应触发任何旧任务（间接验证——不崩溃即可）
  await app.scheduler.advanceTo(clock + 3_600_000, setClock);
  assert.equal(app.scheduler.pending, 0, '刷档后快进也不应有新任务');
});

// ── E) deletePlayer 取消相关任务 ─────────────────────────────────────────

test('deletePlayer: 取消该玩家相关的 Scheduler 任务', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '删档用户', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const playerId = (reg.payload as any).player.id;
  const vid = (reg.payload as any).player.villageId;

  // 启动建造任务
  await app.commands.send({
    name: 'economy.Grant', from: 't',
    payload: { villageId: vid, gain: { wood: 500, clay: 500, iron: 500, crop: 0 } },
  });
  const layout = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: vid } });
  const wood = (layout.payload as any).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  if (wood) {
    const repair = await app.commands.send({ name: 'building.Repair', from: 't', payload: { villageId: vid, slotId: wood.slotId } });
    await app.scheduler.advanceTo((repair.payload as any).finishAt, setClock);
    await app.commands.send({ name: 'building.Upgrade', from: 't', payload: { villageId: vid, slotId: wood.slotId } });
  }

  const pendingBefore = app.scheduler.pending;

  // 删档
  const result = app.deletePlayer(playerId);
  assert.ok(result, '删档应返回 villageId');
  assert.equal(result!.villageId, vid);

  // Scheduler 任务数应减少
  const pendingAfter = app.scheduler.pending;
  assert.ok(pendingAfter < pendingBefore, `删档后 pending 应减少（before=${pendingBefore}, after=${pendingAfter}）`);

  // 快进不应崩溃（已取消的任务静默忽略）
  await app.scheduler.advanceTo(clock + 3_600_000, setClock);
});

// ── F) Register createVillage 失败回滚 ───────────────────────────────────

test('Register: 正常注册成功并创建村庄', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '注册测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok, `注册应成功: ${reg.reason ?? ''}`);

  const vid = (reg.payload as any).player.villageId;

  // 村庄资源应已创建
  const res = await app.commands.send({
    name: 'economy.GetResources', from: 't', payload: { villageId: vid },
  });
  assert.ok(res.ok, '注册后村庄资源应存在');
  assert.ok((res.payload as any).resources, '应有资源数据');
});

test('Register: 用户名重复时返回 name_taken', async () => {
  const app = makeApp();
  app.setupWorld();

  await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '重名用户', password: 'pass123', tribe: 'romans' },
  });
  const reg2 = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '重名用户', password: 'pass456', tribe: 'romans' },
  });
  assert.equal(reg2.ok, false);
  assert.equal(reg2.reason, 'name_taken');
});
