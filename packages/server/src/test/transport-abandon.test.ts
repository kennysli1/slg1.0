import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}
async function drain(app: GameApp, bigStepMs = 3_600_000, maxIters = 30000): Promise<void> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < maxIters) {
    await app.scheduler.advanceTo(clock + bigStepMs, setClock);
    iters++;
  }
}

async function makeTwoVillages(app: GameApp) {
  const reg = await send(app, 'player.Register', {
    name: `tr${Math.floor(Math.random() * 1e9)}`, password: 'pass1', tribe: 'romans',
  });
  const player = (reg.payload as any).player;
  const capital = player.villageId as string;
  const alloc = await send(app, 'player.AllocVillageId', { playerId: player.id });
  const vid2 = (alloc.payload as any).villageId as string;
  const q2 = 12, r2 = -8;
  await app.createVillage(vid2, q2, r2, '分城运');
  await send(app, 'player.AttachVillage', {
    playerId: player.id, villageId: vid2, q: q2, r: r2, name: '分城运',
  });
  return { player, capital, vid2 };
}

test('运输：到达后部队留守且货物入库（可超额）', async () => {
  const app = freshApp();
  const { capital, vid2 } = await makeTwoVillages(app);

  // 目标村有露天仓库科技，可溢出至 2 倍容量（超额入库的前提）
  await send(app, 'economy.SetOverflowCap', { villageId: vid2, cap: 1.0 });

  await send(app, 'military.AdjustTroops', { villageId: capital, delta: { legionnaire: 2 } });
  await send(app, 'economy.Grant', { villageId: capital, gain: { wood: 100 } });

  const beforeCap = (await send(app, 'economy.GetResources', { villageId: vid2 })).payload as any;
  // 灌满目标仓到刚好满容量，再运入验证溢出
  await send(app, 'economy.Grant', {
    villageId: vid2,
    gain: { wood: Math.max(0, beforeCap.capacity.wood - beforeCap.resources.wood) },
  });

  const tr = await send(app, 'movement.SendTransport', {
    villageId: capital,
    targetVillage: vid2,
    troops: { legionnaire: 2 },
    cargo: { wood: 80 },
  });
  assert.equal(tr.ok, true, tr.reason);

  const woodAtTargetBefore = ((await send(app, 'economy.GetResources', { villageId: vid2 })).payload as any).resources.wood;

  await drain(app);

  const army2 = (await send(app, 'military.GetArmy', { villageId: vid2 })).payload as any;
  assert.equal(army2.troops?.legionnaire ?? 0, 2, '部队应留守目标村');

  const army1 = (await send(app, 'military.GetArmy', { villageId: capital })).payload as any;
  assert.equal(army1.troops?.legionnaire ?? 0, 0);

  const after = (await send(app, 'economy.GetResources', { villageId: vid2 })).payload as any;
  assert.ok(after.resources.wood >= woodAtTargetBefore + 80 - 0.01, '货物应全额入库');
  assert.equal(after.productionPaused.wood, true);
});

test('运输：拒绝运给非己方村', async () => {
  const app = freshApp();
  const a = await makeTwoVillages(app);
  const regB = await send(app, 'player.Register', {
    name: `trb${Date.now()}`, password: 'pass2', tribe: 'gauls',
  });
  const other = (regB.payload as any).player.villageId as string;

  await send(app, 'military.AdjustTroops', { villageId: a.capital, delta: { legionnaire: 1 } });
  await send(app, 'economy.Grant', { villageId: a.capital, gain: { wood: 50 } });

  const r = await send(app, 'movement.SendTransport', {
    villageId: a.capital,
    targetVillage: other,
    troops: { legionnaire: 1 },
    cargo: { wood: 10 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_own_village');
});

test('转移行军：只能携带部队/宝物，禁止携带物资', async () => {
  const app = freshApp();
  const { capital, vid2 } = await makeTwoVillages(app);
  const self = await send(app, 'movement.SendTransport', {
    villageId: capital, targetVillage: capital, troops: {}, cargo: {}, mode: 'transfer',
  });
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'same_village');
  await send(app, 'military.AdjustTroops', { villageId: capital, delta: { legionnaire: 2 } });

  const ok = await send(app, 'movement.SendTransport', {
    villageId: capital, targetVillage: vid2, troops: { legionnaire: 1 }, cargo: {}, mode: 'transfer',
  });
  assert.equal(ok.ok, true, ok.reason);

  await send(app, 'military.AdjustTroops', { villageId: capital, delta: { legionnaire: 1 } });
  const blocked = await send(app, 'movement.SendTransport', {
    villageId: capital, targetVillage: vid2, troops: { legionnaire: 1 }, cargo: { wood: 1 }, mode: 'transfer',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'transfer_no_cargo');
});

test('放弃：主城不可弃；锁定期内不可弃；解锁后可弃', async () => {
  const app = freshApp();
  const { player, capital, vid2 } = await makeTwoVillages(app);

  const cap = await send(app, 'player.AbandonVillage', {
    playerId: player.id, villageId: capital,
  });
  assert.equal(cap.ok, false);
  assert.equal(cap.reason, 'cannot_abandon_capital');

  const locked = await send(app, 'player.AbandonVillage', {
    playerId: player.id, villageId: vid2,
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'abandon_locked');

  // 解开锁定：建成时间早于锁定期
  const raw = app.store.get<any>('player', player.id);
  const v = raw.ownedVillages.find((x: any) => x.id === vid2);
  v.foundedAt = clock - app.config.constants.foundAbandonLockSec * 1000 - 1;
  app.store.set('player', player.id, raw);

  const ok = await send(app, 'player.AbandonVillage', {
    playerId: player.id, villageId: vid2,
  });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal((ok.payload as any).player.villages.length, 1);
  assert.equal(app.store.get('economy', vid2), undefined);
});

/** 等待事件总线把（被 void 忽略的）领域事件异步派发完毕，避免测试竞态。 */
function flushEvents(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test('运输：目标村途中消失→军队原路返回，货物与兵力退回发货村', async () => {
  const app = freshApp();
  const { capital, vid2 } = await makeTwoVillages(app);
  await send(app, 'military.AdjustTroops', { villageId: capital, delta: { legionnaire: 3 } });
  await send(app, 'economy.Grant', { villageId: capital, gain: { wood: 100 } });

  const tr = await send(app, 'movement.SendTransport', {
    villageId: capital, targetVillage: vid2, troops: { legionnaire: 3 }, cargo: { wood: 80 },
  });
  assert.equal(tr.ok, true, tr.reason);

  // 推进到行程中段，确认仍在途、未抵达
  const list0 = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mv0 = list0.movements.find((m: any) => m.id === tr.payload.id);
  assert.ok(mv0, '运输应已发出');
  const midMs = Math.floor((mv0.arriveAt - clock) / 2);
  await app.scheduler.advanceTo(clock + midMs, setClock);

  const listMid = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mvMid = listMid.movements.find((m: any) => m.id === tr.payload.id);
  assert.ok(mvMid, '运输仍应在途');
  assert.notEqual(mvMid.type, 'return', '尚未折返');

  // 目标村消失（放弃/删村）
  const clear = await send(app, 'world.ClearVillage', { refId: vid2 });
  assert.equal(clear.ok, true, clear.reason);
  await flushEvents();

  // 立即断言：运输已折返，且终点指向出发村（原路返回）
  const listAfter = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mvAfter = listAfter.movements.find((m: any) => m.id === tr.payload.id);
  assert.ok(mvAfter, '折返后仍应在途');
  assert.equal(mvAfter.type, 'return', '应已转为返程');
  assert.deepEqual(mvAfter.to, mv0.from, '折返终点应为出发村坐标');
  assert.equal(mvAfter.targetVillage, undefined, '应已清空目标村');

  // 跑完剩余行程
  await drain(app);

  // 兵力与货物都应回到发货村 capital
  const army = (await send(app, 'military.GetArmy', { villageId: capital })).payload as any;
  assert.equal(army.troops?.legionnaire ?? 0, 3, '兵力应回到发货村');
  const res = (await send(app, 'economy.GetResources', { villageId: capital })).payload as any;
  assert.ok(res.resources.wood >= 100 - 0.01, '货物应退回发货村（含原 80 木）');
  const listDone = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  assert.equal(listDone.movements.length, 0, '折返后 movement 应已清理');
});

test('出征：PvE 目标途中被移除→军队原路返回，兵力退回出发村', async () => {
  const app = freshApp();
  const { capital } = await makeTwoVillages(app);
  // 默认世界已生成 pve-0（rats），位于 (3,1) 附近；先确认目标存在
  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  assert.equal(target.ok, true, '默认 PvE 目标 pve-0 应存在');

  await send(app, 'military.AdjustTroops', { villageId: capital, delta: { legionnaire: 4 } });

  const raid = await send(app, 'movement.SendRaid', {
    villageId: capital, targetId: 'pve-0', troops: { legionnaire: 4 },
  });
  assert.equal(raid.ok, true, raid.reason);

  // 推进到行程中段，确认仍在途
  const list0 = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mv0 = list0.movements.find((m: any) => m.id === raid.payload.id);
  assert.ok(mv0, '出征应已发出');
  const midMs = Math.floor((mv0.arriveAt - clock) / 2);
  await app.scheduler.advanceTo(clock + midMs, setClock);

  const listMid = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mvMid = listMid.movements.find((m: any) => m.id === raid.payload.id);
  assert.ok(mvMid, '出征仍应在途');
  assert.notEqual(mvMid.type, 'return', '尚未折返');

  // 目标被移除（营地清除 / 幸福村移除等）
  const rm = await send(app, 'pve.Remove', { id: 'pve-0' });
  assert.equal(rm.ok, true, rm.reason);
  await flushEvents();

  // 立即断言：出征已折返
  const listAfter = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mvAfter = listAfter.movements.find((m: any) => m.id === raid.payload.id);
  assert.ok(mvAfter, '折返后仍应在途');
  assert.equal(mvAfter.type, 'return', '应已转为返程');
  assert.equal(mvAfter.targetId, undefined, '应已清空目标');

  // 跑完剩余行程
  await drain(app);

  // 兵力应回到出发村
  const army = (await send(app, 'military.GetArmy', { villageId: capital })).payload as any;
  assert.equal(army.troops?.legionnaire ?? 0, 4, '兵力应回到出发村');
  const listDone = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  assert.equal(listDone.movements.length, 0, '折返后 movement 应已清理');
});

test('商队：目标村被放弃(wipeSingleVillage)后也应原路返程（补 world.VillageRemoved 触发缺口）', async () => {
  const app = freshApp();
  const { player, capital, vid2 } = await makeTwoVillages(app);
  await send(app, 'economy.Grant', { villageId: capital, gain: { wood: 100 } });

  // 一条从 capital 发往 vid2 的在途商队
  const car = await send(app, 'movement.SendCaravan', { fromVillage: capital, targetVillage: vid2, cargo: { wood: 50 } });
  assert.equal(car.ok, true, car.reason);
  const departureAt = clock;

  // 推进到行程中段，确认仍在途
  const list0 = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mv0 = list0.movements.find((m: any) => m.id === (car.payload as any).id);
  assert.ok(mv0, '商队应已发出');
  const midMs = Math.floor((mv0.arriveAt - clock) / 2);
  await app.scheduler.advanceTo(clock + midMs, setClock);

  // 突破放弃锁定期
  const raw = app.store.get<any>('player', player.id);
  const v = raw.ownedVillages.find((x: any) => x.id === vid2);
  v.foundedAt = clock - app.config.constants.foundAbandonLockSec * 1000 - 1;
  app.store.set('player', player.id, raw);

  // 放弃目标村（走 wipeSingleVillage 真实路径，原 bug 此处不触发返程）
  const ab = await send(app, 'player.AbandonVillage', { playerId: player.id, villageId: vid2 });
  assert.equal(ab.ok, true, ab.reason);
  await flushEvents();

  // 立即断言：商队已折返（movement.List 为只读视图，不含 returning；用原始 store 校验）
  const listAfter = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  const mvAfter = listAfter.movements.find((m: any) => m.id === (car.payload as any).id);
  assert.ok(mvAfter, '放弃目标村后商队应仍在途（已改返程）');
  assert.equal(mvAfter.type, 'caravan', '商队类型保持 caravan');
  assert.deepEqual(mvAfter.to, mv0.from, '商队应转向出发村 capital（立即返程）');
  const rawMv = app.store.get<any>('movement', (car.payload as any).id);
  assert.equal(rawMv.returning, true, '商队应置 returning=true（原始 store）');
  assert.equal(rawMv.arriveAt - clock, clock - departureAt, '倒计时应按出发后实际经过时间重置为返程耗时');

  // 跑完剩余行程，货物应退回发货村 capital
  await drain(app);
  const res = (await send(app, 'economy.GetResources', { villageId: capital })).payload as any;
  assert.ok(res.resources.wood >= 100 - 0.01, '商队应把货物退回发货村 capital');
  const listDone = (await send(app, 'movement.List', { villageId: capital })).payload as any;
  assert.equal(listDone.movements.length, 0, '折返后 movement 应已清理');
});
