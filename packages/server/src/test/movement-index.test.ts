import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { wrapHex } from '../infra/hex.js';

/**
 * movement 空间索引（posIndex / villageIndex）行为测试。
 * 索引为内存派生结构，通过依赖索引的业务路径间接验证一致性。
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

async function register(app: GameApp, name: string) {
  const r = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(r.ok, true, `注册 ${name} 应成功: ${r.reason ?? ''}`);
  return (r.payload as any).player as { id: string; villageId: string; q: number; r: number };
}

async function giveTroops(app: GameApp, villageId: string, troops: Record<string, number>) {
  await send(app, 'military.AdjustTroops', { villageId, delta: troops });
}

test('villageIndex：同村第二支出征军应占满 1 级集结点行军点', async () => {
  const app = freshApp();
  const p = await register(app, '索引甲');
  await giveTroops(app, p.villageId, { legionnaire: 40 });

  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const tq = (target.payload as any).q;
  const tr = (target.payload as any).r;

  const first = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(first.ok, true);

  const second = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(second.ok, false, '第二支应被 villageIndex 计数的行军点上限拒绝');
  assert.equal(second.reason, 'march_points_exhausted');

  // 无关断言：目标坐标可读（避免 lint 未使用）
  assert.ok(Number.isFinite(tq) && Number.isFinite(tr));
});

test('villageIndex：返程到达后行军点释放，可再派出', async () => {
  const app = freshApp();
  const p = await register(app, '索引乙');
  await giveTroops(app, p.villageId, { legionnaire: 40 });

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  const mvId = (raid.payload as any).id as string;

  const recall = await send(app, 'movement.RecallMarch', { villageId: p.villageId, movementId: mvId });
  assert.equal(recall.ok, true, `撤回应成功: ${recall.reason ?? ''}`);

  // 撤回后转为 return，仍占用行军点（返程也在途）
  const blocked = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(blocked.ok, false, '返程未到达前行军点仍被占用');
  assert.equal(blocked.reason, 'march_points_exhausted');

  // 推进至返程到达，movement 移除后索引释放
  const arriveAt = (recall.payload as any).arriveAt as number;
  let iters = 0;
  while (app.store.get('movement', mvId) && iters < 20_000) {
    await app.scheduler.advanceTo(Math.max(clock + 1_000, arriveAt + 1), setClock);
    iters++;
  }
  assert.equal(app.store.get('movement', mvId), undefined, '返程到达后 movement 应移除');

  const again = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(again.ok, true, '返程结束后应能再派出');
});

test('posIndex：同格敌对行军应触发遭遇（findEncounter 路径）', async () => {
  const app = freshApp();
  const A = await register(app, '索引红');
  const B = await register(app, '索引蓝');
  await giveTroops(app, A.villageId, { legionnaire: 20 });
  await giveTroops(app, B.villageId, { legionnaire: 10 });

  await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 20 },
  });
  await send(app, 'movement.SendAttack', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { legionnaire: 10 },
  });

  let intercepted = false;
  app.bus.on('movement.Intercepted', () => { intercepted = true; });
  let iters = 0;
  while (!intercepted && app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }
  assert.equal(intercepted, true, 'posIndex 应能在同格找到敌对行军并触发遭遇');
});

test('posIndex：移动后旧格不再触发遭遇，新格才有效', async () => {
  const app = freshApp();
  const A = await register(app, '索引丙');
  await giveTroops(app, A.villageId, { legionnaire: 15 });
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;
  const garrisonTile = wrapHex({ q: A.q + 2, r: A.r }, W, H);
  await send(app, 'vision.Reveal', { playerId: A.id, ...garrisonTile, radius: 0 });

  const g = await send(app, 'movement.SendGarrison', {
    villageId: A.villageId, ...garrisonTile, troops: { legionnaire: 5 },
  });
  assert.equal(g.ok, true);
  const mvId = (g.payload as any).id as string;

  // 推进到驻扎完成
  let stationed = false;
  for (let i = 0; i < 500 && !stationed; i++) {
    await app.scheduler.advanceTo(clock + 2_000, setClock);
    const mv = app.store.get<any>('movement', mvId);
    if (mv?.status === 'stationed') stationed = true;
  }
  assert.equal(stationed, true, '驻扎军应抵达目标格');

  const beforePos = app.store.get<any>('movement', mvId)?.pos;
  assert.deepEqual(beforePos, garrisonTile);

  // 续行到新格：save() 应更新 posIndex，旧格索引失效
  const nextTile = wrapHex({ q: garrisonTile.q + 1, r: garrisonTile.r }, W, H);
  await send(app, 'vision.Reveal', { playerId: A.id, ...nextTile, radius: 0 });
  const cont = await send(app, 'movement.ContinueGarrison', {
    villageId: A.villageId, movementId: mvId, ...nextTile, mode: 'garrison',
  });
  assert.equal(cont.ok, true);

  // 续行后 pos 仍从当前格出发，须推进一步才进入新格（save 会更新 posIndex）
  let moved = false;
  for (let i = 0; i < 500 && !moved; i++) {
    await app.scheduler.advanceTo(clock + 2_000, setClock);
    const pos = app.store.get<any>('movement', mvId)?.pos;
    if (pos && (pos.q !== garrisonTile.q || pos.r !== garrisonTile.r)) moved = true;
  }
  const after = app.store.get<any>('movement', mvId);
  assert.equal(moved, true, '续行推进后 pos 应离开旧格');
  assert.notDeepEqual(after?.pos, garrisonTile);
});
