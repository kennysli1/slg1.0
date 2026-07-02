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
