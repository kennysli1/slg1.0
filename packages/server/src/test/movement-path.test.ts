import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistance } from '../infra/hex.js';

/**
 * 行军路径与相遇单元测试（假时钟）。
 * 覆盖：逐格推进（pos 随时间前移）、到达触发战斗、两支敌对出征军同格相遇即战。
 */

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

/** 直接读 movement 集合（测试内省用）。 */
function movements(app: GameApp): any[] {
  return app.store.all<any>('movement');
}

/** 给某村足量兵力（绕过训练，直接调 military 增兵）。 */
async function giveTroops(app: GameApp, villageId: string, troops: Record<string, number>) {
  await send(app, 'military.AdjustTroops', { villageId, delta: troops });
}

test('逐格推进：raid 部队 pos 随时间沿路径前移，到达前不结算', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '甲', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 20 });

  // pve-0 在 (3,1)。派兵掠夺。
  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const tq = (target.payload as any).q, tr = (target.payload as any).r;
  const dist = hexDistance({ q: p.q, r: p.r }, { q: tq, r: tr });
  assert.ok(dist >= 1, '目标应与出发点有距离');

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 20 },
  });
  assert.equal(raid.ok, true, `派兵应成功: ${raid.reason ?? ''}`);

  const mv0 = movements(app).find((m) => m.type === 'raid');
  assert.ok(mv0, '应有一条 raid 行军');
  assert.equal(mv0.path.length, dist + 1, '路径长度=距离+1');
  assert.deepEqual(mv0.pos, { q: p.q, r: p.r }, '初始 pos 在出发格');
  assert.equal(mv0.stepIndex, 0);

  // 推进一格：pos 应前移到 path[1]，仍在行军、未到达
  const perStep = mv0.perStepMs;
  await app.scheduler.advanceTo(clock + perStep, setClock);
  const mv1 = movements(app).find((m) => m.type === 'raid');
  assert.ok(mv1, '一步后仍在途');
  assert.equal(mv1.stepIndex, 1, '前进了一格');
  assert.deepEqual(mv1.pos, mv0.path[1], 'pos = path[1]');
  assert.equal(hexDistance(mv1.pos, mv0.path[0]), 1, '新位置与起点相邻');
});

test('到达触发战斗接入：raid 走完全程后交给 combat（movement 消失，产生战斗或返程）', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '乙', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 50 });
  await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 50 },
  });

  // 大步快进直到没有待处理任务（到达→战斗逐 tick→结束→返程）
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < 20000) {
    await app.scheduler.advanceTo(clock + 3_600_000, setClock);
    iters++;
  }
  // 去程 raid 应已消失（要么进战斗要么已返程完成）
  assert.equal(movements(app).filter((m) => m.type === 'raid').length, 0, 'raid 去程应已结束');
});

test('战斗中的部队持续占用人口足迹，幸存者返程不会凭空增加村庄人口', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '人口行军', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  const troops = { legionnaire: 10 };
  const troopPop = app.config.units.legionnaire.popCost * troops.legionnaire;
  await giveTroops(app, p.villageId, troops);

  // 构造一个恰好住满「扣除出征士兵后容量」的村庄。若战斗中的士兵从人口池消失，
  // 一小时后的结算就会错误增长；正确行为是整个战斗期间人口与容量均保持不变。
  const popState = app.store.get<any>('population', p.villageId);
  assert.ok(popState, '村庄应有人口状态');
  popState.currentPop = popState.hardCap - troopPop;
  popState.garrisonPopCost = troopPop;
  popState.enRoutePopCost = 0;
  popState.trainingPopCost = 0;
  popState.lastTick = clock;
  app.store.set('population', p.villageId, popState);

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, targetId: 'pve-0', troops,
  });
  assert.equal(raid.ok, true, `派兵应成功: ${raid.reason ?? ''}`);
  const outbound = movements(app).find((m) => m.id === (raid.payload as any).id);
  assert.ok(outbound, '应记录去程行军');

  // 逐格推进到终点，只启动战斗而不推进下一次 combat tick，故部队仍在战斗中。
  // Scheduler 每轮只消费当时已登记的任务，不能用一次大跳代替逐格推进。
  let engaged: any;
  for (let i = 0; i <= outbound.path.length; i++) {
    await app.scheduler.advanceTo(clock + outbound.perStepMs + 1, setClock);
    engaged = movements(app).find((m) => m.id === outbound.id);
    if (engaged?.status === 'paused') break;
  }
  assert.equal(engaged?.status, 'paused', '交战期间去程应保留为 paused，持续计入在途人口');

  // 模拟战斗持续一小时后读取人口快照：不应因为士兵在战斗中暂时消失而获得额外增长。
  setClock(clock + 3_600_000);
  const snap = (await send(app, 'population.GetSnapshot', { villageId: p.villageId })).payload as any;
  assert.equal(snap.currentPop, popState.hardCap - troopPop, '战斗期间平民不应凭空增长');
  assert.equal(snap.soldierPop, troopPop, '战斗中的部队仍应计入士兵人口');
  assert.equal(snap.totalPop, popState.hardCap, '战斗中的总人口应保持守恒');
});

test('同格相遇即战：两支敌对出征军在途相遇，弱者全灭、强者继续', async () => {
  const app = freshApp();
  // 两名玩家
  const ra = await send(app, 'player.Register', { name: '红', password: 'pass123', tribe: 'romans' });
  const rb = await send(app, 'player.Register', { name: '蓝', password: 'pass123', tribe: 'romans' });
  const A = (ra.payload as any).player;
  const B = (rb.payload as any).player;
  await giveTroops(app, A.villageId, { legionnaire: 100 });
  await giveTroops(app, B.villageId, { legionnaire: 5 });

  // 让两军互攻对方村：路径必然相向，中途会共处某格。
  await send(app, 'movement.SendAttack', {
    villageId: A.villageId, fromXY: { q: A.q, r: A.r }, targetVillage: B.villageId, toXY: { q: B.q, r: B.r }, troops: { legionnaire: 100 },
  });
  await send(app, 'movement.SendAttack', {
    villageId: B.villageId, fromXY: { q: B.q, r: B.r }, targetVillage: A.villageId, toXY: { q: A.q, r: A.r }, troops: { legionnaire: 5 },
  });

  let intercepted = false;
  app.bus.on('movement.Intercepted', () => { intercepted = true; });

  // 逐格推进直到无任务
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < 20000) {
    await app.scheduler.advanceTo(clock + 1000, setClock);
    iters++;
  }

  assert.equal(intercepted, true, '两军相向应发生相遇战');
  // 弱方(蓝,5兵)出征军应已全灭消失；不应有蓝方出征在途
  const blueOutbound = movements(app).filter((m) => m.fromVillage === B.villageId && m.type !== 'return');
  assert.equal(blueOutbound.length, 0, '弱方出征军应被歼灭');
});

test('同格相遇：胜方减员后立即更新在途人口足迹', async () => {
  const app = freshApp();
  const ra = await send(app, 'player.Register', { name: '人口红', password: 'pass123', tribe: 'romans' });
  const rb = await send(app, 'player.Register', { name: '人口蓝', password: 'pass123', tribe: 'romans' });
  const A = (ra.payload as any).player;
  const B = (rb.payload as any).player;
  const sent = 100;
  const enemy = 5;
  const unitPop = app.config.units.legionnaire.popCost;
  await giveTroops(app, A.villageId, { legionnaire: sent });
  await giveTroops(app, B.villageId, { legionnaire: enemy });

  const popState = app.store.get<any>('population', A.villageId);
  assert.ok(popState, '进攻村应有人口状态');
  popState.currentPop = popState.hardCap - sent * unitPop;
  popState.garrisonPopCost = sent * unitPop;
  popState.enRoutePopCost = 0;
  popState.trainingPopCost = 0;
  popState.lastTick = clock;
  app.store.set('population', A.villageId, popState);

  await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: sent },
  });
  await send(app, 'movement.SendAttack', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { legionnaire: enemy },
  });

  let intercepted = false;
  app.bus.on('movement.Intercepted', () => { intercepted = true; });
  let iters = 0;
  while (!intercepted && app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }
  assert.equal(intercepted, true, '两军应在途中相遇');

  // 敌军 5 人会使 100 人的胜方损失 1 人；人口快照必须立即反映 99 人，
  // 不能继续把阵亡者计为在途部队直到返程才修正。
  await Promise.resolve();
  const snap = (await send(app, 'population.GetSnapshot', { villageId: A.villageId })).payload as any;
  assert.equal(snap.soldierPop, (sent - 1) * unitPop, '胜方阵亡者不应残留在在途人口足迹中');
});

test('野外驻扎：抵达空地后持续占用一个行军点，可续行并召回', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '驻扎甲', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 30 });

  const target = { q: p.q + 9, r: p.r + 7 };
  await send(app, 'vision.Reveal', { playerId: p.id, ...target, radius: 0 });
  const first = await send(app, 'movement.SendGarrison', { villageId: p.villageId, ...target, troops: { legionnaire: 10 } });
  assert.equal(first.ok, true, `驻扎派遣应成功: ${first.reason ?? ''}`);
  const mv = movements(app).find((m) => m.id === (first.payload as any).id);
  assert.ok(mv, '应创建驻扎行军');
  for (let step = 0; step < mv.path.length + 1; step++) {
    await app.scheduler.advanceTo(clock + mv.perStepMs + 1, setClock);
    if (movements(app).find((m) => m.id === mv.id)?.status === 'stationed') break;
  }
  const stationed = movements(app).find((m) => m.id === mv.id);
  assert.equal(stationed?.status, 'stationed', '抵达空地后应保持驻扎');
  assert.deepEqual(stationed?.pos, mv.toXY, '空地应在目标格驻扎');

  const exhausted = await send(app, 'movement.SendGarrison', {
    villageId: p.villageId, q: p.q + 11, r: p.r + 7, troops: { legionnaire: 10 },
  });
  assert.equal(exhausted.ok, false, '1级集结点只能同时派出一支军队');
  assert.equal(exhausted.reason, 'march_points_exhausted');

  const continued = await send(app, 'movement.ContinueGarrison', {
    villageId: p.villageId, movementId: mv.id, q: target.q + 1, r: target.r, mode: 'garrison',
  });
  assert.equal(continued.ok, true, `驻扎军续行应成功: ${continued.reason ?? ''}`);
  assert.equal(movements(app).filter((m) => m.fromVillage === p.villageId).length, 1, '续行不应额外占用行军点');

  const moving = movements(app).find((m) => m.id === mv.id);
  await app.scheduler.advanceTo(clock + moving.perStepMs + 1, setClock);
  const restationed = movements(app).find((m) => m.id === mv.id);
  assert.equal(restationed?.status, 'stationed');
  const recalled = await send(app, 'movement.RecallGarrison', { villageId: p.villageId, movementId: mv.id });
  assert.equal(recalled.ok, true, `驻扎军召回应成功: ${recalled.reason ?? ''}`);
  assert.equal(movements(app).some((m) => m.id === mv.id), false, '原驻扎记录应被返程军替换');
  assert.equal(movements(app).filter((m) => m.type === 'return').length, 1, '应生成返程军');
});

test('野外驻扎：目标在抵达前变为被占据格时停在路径前一格', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '驻扎乙', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 20 });
  const pve = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const target = { q: (pve.payload as any).q, r: (pve.payload as any).r };
  await send(app, 'vision.Reveal', { playerId: p.id, ...target, radius: 0 });
  const sent = await send(app, 'movement.SendGarrison', { villageId: p.villageId, ...target, troops: { legionnaire: 10 } });
  assert.equal(sent.ok, true, `可先向未知占据格派驻扎军: ${sent.reason ?? ''}`);
  const mv = movements(app).find((m) => m.id === (sent.payload as any).id);
  for (let step = 0; step < mv.path.length + 1; step++) {
    await app.scheduler.advanceTo(clock + mv.perStepMs + 1, setClock);
    if (movements(app).find((m) => m.id === mv.id)?.status === 'stationed') break;
  }
  const stationed = movements(app).find((m) => m.id === mv.id);
  assert.equal(stationed?.status, 'stationed');
  assert.deepEqual(stationed?.pos, mv.path[mv.path.length - 2], '目标格被占据时应停在进入目标的前一格');
});

test('未探索格只能探索：1级集结点可探索一格深，抵达后返程并写入探索历史', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '探索甲', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 20 });
  // 城池默认视野为4；离城5格正好是未探索深度1。
  const target = { q: p.q + 5, r: p.r };
  const badGarrison = await send(app, 'movement.SendGarrison', { villageId: p.villageId, ...target, troops: { legionnaire: 10 } });
  assert.equal(badGarrison.ok, false);
  assert.equal(badGarrison.reason, 'target_unexplored');
  const exploring = await send(app, 'movement.SendExplore', { villageId: p.villageId, ...target, troops: { legionnaire: 10 } });
  assert.equal(exploring.ok, true, `1级集结点应可探索1格深: ${exploring.reason ?? ''}`);
  const mv = movements(app).find((m) => m.id === (exploring.payload as any).id);
  for (let step = 0; step < mv.path.length * 3; step++) {
    await app.scheduler.advanceTo(clock + mv.perStepMs + 1, setClock);
    if (!movements(app).length) break;
  }
  assert.equal(movements(app).length, 0, '探索军应抵达后立即返程并归队');
  const visible = await send(app, 'vision.GetVisibility', { playerId: p.id, ...target });
  assert.equal((visible.payload as any).visibility, 'explored', '行军视野覆盖过的目标格应保留为已探索');
});
