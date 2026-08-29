import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistance, hexDistanceWrapped } from '../infra/hex.js';

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
  const dist = hexDistanceWrapped(
    { q: p.q, r: p.r }, { q: tq, r: tr },
    app.config.constants.worldW, app.config.constants.worldH,
  );
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
  const sent = 30;
  const enemy = 25;
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
  let battleEnded = false;
  app.bus.on('combat.BattleEnded', (e) => {
    if ((e.payload as any).fromVillage === A.villageId) battleEnded = true;
  });
  let iters = 0;
  while ((!intercepted || !battleEnded) && app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }
  assert.equal(intercepted, true, '两军应在途中相遇');
  assert.equal(battleEnded, true, '野战应已结束');

  const mv = movements(app).find((m) => m.fromVillage === A.villageId && m.type !== 'return');
  assert.ok(mv, '胜方应仍在途');
  const survivors = Object.values(mv.troops as Record<string, number>).reduce((a, n) => a + n, 0);
  assert.ok(survivors > 0 && survivors < sent, '胜方应有减员且未全灭');

  await Promise.resolve();
  const snap = (await send(app, 'population.GetSnapshot', { villageId: A.villageId })).payload as any;
  assert.equal(snap.soldierPop, survivors * unitPop, '胜方阵亡者不应残留在在途人口足迹中');
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

test('驻扎军续行：PvE 目标列出侦察与掠夺，并可沿用原编队执行侦察', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '驻扎侦察', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { equlegati: 5 });

  // 先把侦察兵派到空地驻扎，再从驻扎点选择 PvE 目标。
  const target = { q: p.q + 3, r: p.r + 2 };
  await send(app, 'vision.Reveal', { playerId: p.id, ...target, radius: 0 });
  const first = await send(app, 'movement.SendGarrison', { villageId: p.villageId, ...target, troops: { equlegati: 1 } });
  assert.equal(first.ok, true, `驻扎派遣应成功: ${first.reason ?? ''}`);
  const id = (first.payload as any).id as string;
  for (let i = 0; i < 30; i++) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    if (app.store.get<any>('movement', id)?.status === 'stationed') break;
  }
  assert.equal(app.store.get<any>('movement', id)?.status, 'stationed', '侦察兵应先抵达驻扎点');

  const pve = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  assert.equal(pve.ok, true);
  const pveXY = { q: (pve.payload as any).q, r: (pve.payload as any).r };
  await send(app, 'vision.Reveal', { playerId: p.id, ...pveXY, radius: 0 });
  const options = await send(app, 'movement.GetMarchOptions', {
    villageId: p.villageId, kind: 'pve', refId: 'pve-0', ...pveXY,
  });
  assert.equal(options.ok, true);
  const modes = ((options.payload as any).modes ?? []).map((entry: { mode: string }) => entry.mode);
  assert.deepEqual(modes, ['scout', 'raid'], 'PvE 驻扎军续行应列出全部适用模式');

  const continued = await send(app, 'movement.ContinueGarrison', {
    villageId: p.villageId, movementId: id, mode: 'scout', targetId: 'pve-0', ...pveXY,
  });
  assert.equal(continued.ok, true, `驻扎军续行侦察应成功: ${continued.reason ?? ''}`);
  const moving = app.store.get<any>('movement', id);
  assert.equal(moving?.type, 'scout', '续行侦察应切换为 scout 行军');
  assert.equal(moving?.targetId, 'pve-0');
  assert.deepEqual(moving?.troops, { equlegati: 1 }, '续行不应重新选择或扣除编队');
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

test('自动探索：新视野发现公共营地即返程，不驻扎也不触发战斗', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '自动探索甲', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 20 });
  const camp = app.store.all<any>('pve').find((target) => {
    const d = hexDistance({ q: p.q, r: p.r }, { q: target.q, r: target.r });
    return d > 4;
  });
  assert.ok(camp, '测试地图应有城池视野外的公共营地');

  const sent = await send(app, 'movement.SendAutoExplore', {
    villageId: p.villageId, q: camp.q, r: camp.r, troops: { legionnaire: 10 },
  });
  assert.equal(sent.ok, true, `自动探索应可出发: ${sent.reason ?? ''}`);
  const outbound = movements(app).find((m) => m.id === (sent.payload as any).id);
  assert.equal(outbound?.type, 'auto_explore');

  for (let step = 0; step < outbound.path.length + 2; step++) {
    await app.scheduler.advanceTo(clock + outbound.perStepMs + 1, setClock);
    const returning = movements(app).find((m) => m.type === 'return' && m.autoExplore?.reason === 'pve');
    if (returning) {
      const found = returning.autoExplore.foundAt;
      assert.ok(app.store.all<any>('pve').some((target) => target.q === found?.q && target.r === found?.r), '返程坐标应是首次发现的公共营地');
      assert.equal(app.store.all<any>('battle').length, 0, '自动探索发现营地时不得开战');
      assert.equal(movements(app).some((m) => m.status === 'stationed'), false, '自动探索不得驻扎');
      return;
    }
  }
  assert.fail('自动探索应在发现公共营地后返程');
});

test('伏击军续行：从已驻扎伏击点出发仍保持 ambush 类型', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: '伏击续行', password: 'pass123', tribe: 'romans' });
  const p = (reg.payload as any).player;
  await giveTroops(app, p.villageId, { legionnaire: 30 });
  const firstTarget = { q: p.q + 2, r: p.r + 2 };
  const nextTarget = { q: p.q + 4, r: p.r + 3 };
  await send(app, 'vision.Reveal', { playerId: p.id, ...firstTarget, radius: 0 });
  await send(app, 'vision.Reveal', { playerId: p.id, ...nextTarget, radius: 0 });

  const sent = await send(app, 'movement.SendAmbush', { villageId: p.villageId, ...firstTarget, troops: { legionnaire: 20 } });
  assert.equal(sent.ok, true, `伏击派遣应成功: ${sent.reason ?? ''}`);
  const id = (sent.payload as any).id as string;
  let current: any;
  for (let i = 0; i < 20; i++) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    current = movements(app).find((m) => m.id === id);
    if (current?.status === 'stationed') break;
  }
  assert.equal(current?.status, 'stationed', '伏击军应先在第一处目标驻扎');

  const continued = await send(app, 'movement.ContinueGarrison', {
    villageId: p.villageId, movementId: id, ...nextTarget, mode: 'ambush',
  });
  assert.equal(continued.ok, true, `伏击军续行应成功: ${continued.reason ?? ''}`);
  current = movements(app).find((m) => m.id === id);
  assert.equal(current?.type, 'ambush', '伏击军续行不能退化为普通驻扎');
  assert.equal(current?.status, 'marching', '续行后应重新进入行军状态');

  for (let i = 0; i < 20; i++) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    current = movements(app).find((m) => m.id === id);
    if (current?.status === 'stationed') break;
  }
  assert.equal(current?.status, 'stationed', '续行到第二处目标后仍应进入驻扎状态');
  assert.deepEqual(current?.pos, current?.toXY, '续行后的伏击点应是第二处目标');
});

test('伏击：驻扎后只在一格内触发，战斗结束双方幸存者均返城', async () => {
  const app = freshApp();
  assert.equal(typeof app.config.constants.ambushAttackBonus, 'number', '伏击攻击加成应来自配置中心');
  assert.ok(app.config.constants.ambushAttackBonus >= 0, '伏击攻击加成应为非负数');
  const ra = await send(app, 'player.Register', { name: '伏击甲', password: 'pass123', tribe: 'romans' });
  const rb = await send(app, 'player.Register', { name: '伏击乙', password: 'pass123', tribe: 'romans' });
  const A = (ra.payload as any).player;
  const B = (rb.payload as any).player;
  const target = { q: (A.q + 2) % 41, r: A.r };
  await giveTroops(app, A.villageId, { legionnaire: 30 });
  await giveTroops(app, B.villageId, { equimperatoris: 10, merc_archer: 10 });
  await send(app, 'vision.Reveal', { playerId: A.id, ...target, radius: 0 });
  await send(app, 'vision.Reveal', { playerId: B.id, ...target, radius: 0 });
  const ambush = await send(app, 'movement.SendAmbush', { villageId: A.villageId, ...target, troops: { legionnaire: 20 } });
  assert.equal(ambush.ok, true, `伏击派遣应成功: ${ambush.reason ?? ''}`);
  const ambushId = (ambush.payload as any).id as string;
  let stationed = false;
  for (let i = 0; i < 20; i++) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    stationed = movements(app).find((m) => m.id === ambushId)?.status === 'stationed';
    if (stationed) break;
  }
  assert.equal(stationed, true, '伏击军抵达后应驻扎');

  let triggered = false;
  app.bus.on('movement.Intercepted', (e) => { if ((e.payload as any).battleType === 'ambush') triggered = true; });
  const battleReports: any[] = [];
  app.bus.on('combat.BattleEnded', (e) => {
    if ((e.payload as any).battleType === 'ambush') battleReports.push(e.payload);
  });
  const enemy = await send(app, 'movement.SendGarrison', { villageId: B.villageId, ...target, troops: { equimperatoris: 10, merc_archer: 10 } });
  assert.equal(enemy.ok, true, `诱饵军派遣应成功: ${enemy.reason ?? ''}`);
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    iters++;
  }
  assert.equal(triggered, true, '敌方进入一格内应触发伏击');
  assert.equal(movements(app).some((m) => m.type === 'ambush' && m.status === 'stationed'), false, '伏击战后伏击记录应转为返程或结束');
  const ambusherReport = battleReports.find((p) => p.villageId === A.villageId);
  const victimReport = battleReports.find((p) => p.villageId === B.villageId);
  assert.equal(ambusherReport?.side, 'attacker', '伏击方战报应保持 attacker 视角');
  assert.equal(victimReport?.side, 'defender', '被伏击方战报应标记为 defender，不能伪装成 attacker');
  assert.equal(victimReport?.attackerWins, ambusherReport?.attackerWins, '双方战报应共享同一个客观胜负，不得给被伏击方取反');
  assert.deepEqual(victimReport?.defenderLineup, { equimperatoris: 10, merc_archer: 10 }, '被伏击方阵容应是近卫骑兵与雇佣弓手');
  assert.equal(victimReport?.attackerLineup?.legionnaire, 20, '伏击方阵容应是军团兵');
  assert.equal(Object.hasOwn(victimReport?.defenderLosses ?? {}, 'legionnaire'), false, '被伏击方损失中不能混入伏击方军团兵');
  assert.equal(Object.keys(victimReport?.defenderLosses ?? {}).every((code) => code === 'equimperatoris' || code === 'merc_archer'), true, '被伏击方损失只能来自自己的兵种');
});
