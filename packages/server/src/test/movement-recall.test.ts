import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * movement.RecallMarch 行为测试。
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
  assert.equal(r.ok, true);
  return (r.payload as any).player as { id: string; villageId: string; q: number; r: number };
}

test('RecallMarch：在途 attack 可撤回并记录 abandonedTo', async () => {
  const app = freshApp();
  const A = await register(app, '撤回甲');
  const B = await register(app, '撤回乙');
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 20 } });

  const atk = await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 10 },
  });
  const mvId = (atk.payload as any).id as string;
  const before = app.store.get<any>('movement', mvId);
  const abandonedTo = before.toXY;

  const recall = await send(app, 'movement.RecallMarch', { villageId: A.villageId, movementId: mvId });
  assert.equal(recall.ok, true, `撤回应成功: ${recall.reason ?? ''}`);
  assert.deepEqual((recall.payload as any).abandonedTo, abandonedTo);

  const list = await send(app, 'movement.List', { villageId: A.villageId });
  const items = (list.payload as any).movements as any[];
  const recalled = items.find((m) => m.id === mvId);
  assert.ok(recalled, 'List 应仍包含该 movement');
  assert.equal(recalled.type, 'return');
  assert.equal(recalled.recallable, false);
  assert.deepEqual(recalled.abandonedTo, abandonedTo);
});

test('RecallMarch：战斗中（paused）不可撤回', async () => {
  const app = freshApp();
  const A = await register(app, '撤回红');
  const B = await register(app, '撤回蓝');
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 30 } });
  await send(app, 'military.AdjustTroops', { villageId: B.villageId, delta: { legionnaire: 25 } });

  const a = await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 30 },
  });
  await send(app, 'movement.SendAttack', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { legionnaire: 25 },
  });
  const mvId = (a.payload as any).id as string;

  let paused = false;
  for (let i = 0; i < 500 && !paused; i++) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    if (app.store.get<any>('movement', mvId)?.status === 'paused') paused = true;
  }
  assert.equal(paused, true, '相遇后应进入 paused（战斗中）');

  const recall = await send(app, 'movement.RecallMarch', { villageId: A.villageId, movementId: mvId });
  assert.equal(recall.ok, false);
  assert.equal(recall.reason, 'in_combat');
});

test('RecallMarch：返程中不可再次撤回', async () => {
  const app = freshApp();
  const p = await register(app, '撤回丙');
  await send(app, 'military.AdjustTroops', { villageId: p.villageId, delta: { legionnaire: 15 } });
  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 5 },
  });
  const mvId = (raid.payload as any).id as string;
  const recall1 = await send(app, 'movement.RecallMarch', { villageId: p.villageId, movementId: mvId });
  assert.equal(recall1.ok, true);

  const recall2 = await send(app, 'movement.RecallMarch', { villageId: p.villageId, movementId: mvId });
  assert.equal(recall2.ok, false);
  assert.equal(recall2.reason, 'already_returning');
});

test('军队：派出超过 90 秒后不可撤回，且不再提供停止命令', async () => {
  const app = freshApp();
  const A = await register(app, '撤回窗口甲');
  const B = await register(app, '撤回窗口乙');
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 20 } });

  const attack = await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 10 },
  });
  const movementId = (attack.payload as any).id as string;
  const initial = await send(app, 'movement.List', { villageId: A.villageId });
  const initialMove = (initial.payload as any).movements.find((m: any) => m.id === movementId);
  assert.equal(initialMove.recallable, true, '派出后 90 秒内应可撤回');
  assert.equal(initialMove.stoppable, false, '军队不应提供停止命令');

  const stopped = await send(app, 'movement.StopMarch', { villageId: A.villageId, movementId });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'not_stoppable');

  clock += 90_001;
  const expired = await send(app, 'movement.List', { villageId: A.villageId });
  const expiredMove = (expired.payload as any).movements.find((m: any) => m.id === movementId);
  assert.equal(expiredMove.recallable, false, '派出超过 90 秒后撤回按钮应消失');
  const recall = await send(app, 'movement.RecallMarch', { villageId: A.villageId, movementId });
  assert.equal(recall.ok, false);
  assert.equal(recall.reason, 'not_recallable');
});
