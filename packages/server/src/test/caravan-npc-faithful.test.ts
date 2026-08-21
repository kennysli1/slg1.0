import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

async function register(app: GameApp, name: string) {
  const r = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(r.ok, true, `注册 ${name} 应成功: ${r.reason ?? ''}`);
  return (r.payload as any).player as { id: string; name: string; q: number; r: number; villageId: string };
}

async function settle(app: GameApp) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const anyFlipped = app.store.all('movement').some((m: any) => m.type === 'return' || (m.type === 'caravan' && m.returning));
    if (anyFlipped) return;
  }
}

// 沿真实命令链路复现：pve.Spawn 幸福村(生成地图地块 refId=happy-X) → movement.SendCaravan(发往 happy-X) → pve.Remove(幸福村消失)
test('真实链路：幸福村(pve.Spawn id=happy-X)消失后，发往它的商队应从当前位置返程', async () => {
  const app = freshApp();
  const A = await register(app, '村A');
  const npcId = `happy-${A.villageId}`;
  const npcXY = { q: A.q + 8, r: A.r + 8 };

  // 1) 任务模块按真实逻辑生成幸福村（pve.Spawn，id = happy-${villageId}，并放置地图地块 refId=该 id）
  const spawn = await send(app, 'pve.Spawn', {
    id: npcId, type: 'happy_village', q: npcXY.q, r: npcXY.r,
    task: false, ownerVillageId: A.villageId, loot: { wood: 200, clay: 200, iron: 200, gold: 100 }, noRespawn: true,
  });
  assert.equal(spawn.ok, true, `pve.Spawn 应成功: ${spawn.reason ?? ''}`);

  // 2) 玩家在贸易中心接单 → 派单向商队（真实走 movement.SendCaravan，targetVillage = order.npcId = happy-X）
  const carRes = await send(app, 'movement.SendCaravan', {
    fromVillage: A.villageId, targetVillage: npcId, cargo: { crop: 500 }, homeVillage: A.villageId, routesFreed: 1,
  });
  assert.equal(carRes.ok, true, `SendCaravan 应成功: ${carRes.reason ?? ''}`);
  const caravanId = (carRes.payload as any).id;

  const caravan = app.store.get('movement', caravanId) as any;
  assert.ok(caravan, '应存在一条发往幸福村的商队');
  assert.equal(caravan.targetVillage, npcId, '商队 targetVillage 应为 happy-X');
  assert.equal(caravan.returning, false, '去程商队 returning 应为 false');

  // 把商队位置推进到「半路」(当前位置远离出发村与幸福村)
  const mid = { q: A.q + 4, r: A.r + 4 };
  caravan.pos = mid;
  caravan.path = [mid, npcXY];
  caravan.stepIndex = 0;
  caravan.arriveAt = clock + 100000; // 原送达倒计时
  app.store.set('movement', caravanId, caravan);

  // 3) 幸福村消失（任务完成/放弃 → removeNpc → pve.Remove）
  const rm = await send(app, 'pve.Remove', { id: npcId });
  assert.equal(rm.ok, true, `pve.Remove 应成功: ${rm.reason ?? ''}`);

  await settle(app);

  const mv = app.store.get('movement', caravanId) as any;
  assert.ok(mv, '商队应仍存在（不应被删除）');
  assert.equal(mv.returning, true, '商队应置 returning=true（立即返程）');
  assert.deepEqual(mv.toXY, { q: A.q, r: A.r }, '商队应转向出发村 A');

  // 关键断言：返程倒计时应基于「当前位置 → 出发村」的距离，而非原送达倒计时
  const expectedReturnMs = Math.max(3000, Math.round((hexDist(mid, { q: A.q, r: A.r }) / 12) * 3600)) * 1000;
  assert.ok(Math.abs((mv.arriveAt - clock) - expectedReturnMs) < 2000,
    `返程倒计时应≈从当前位置返程(${expectedReturnMs}ms)，实际 arriveAt=${mv.arriveAt} clock=${clock} diff=${mv.arriveAt - clock}`);
  assert.notEqual(mv.arriveAt, clock + 100000, 'arriveAt 不应仍是原送达倒计时（证明已重置为返程）');
});

test('真实战斗链路：清空幸福村会移除目标并让途中的商队从当前进度返程', async () => {
  const app = freshApp();
  const A = await register(app, '村A-摧毁');
  const npcId = `happy-${A.villageId}`;
  const npcXY = { q: A.q + 8, r: A.r + 8 };
  const spawn = await send(app, 'pve.Spawn', {
    id: npcId, type: 'happy_village', q: npcXY.q, r: npcXY.r,
    task: false, ownerVillageId: A.villageId, noRespawn: true,
  });
  assert.equal(spawn.ok, true, `幸福村生成应成功: ${spawn.reason ?? ''}`);
  const car = await send(app, 'movement.SendCaravan', {
    fromVillage: A.villageId, targetVillage: npcId, cargo: { crop: 1 }, homeVillage: A.villageId, routesFreed: 1,
  });
  assert.equal(car.ok, true, `商队派出应成功: ${car.reason ?? ''}`);
  const caravanId = (car.payload as any).id;
  const caravan = app.store.get('movement', caravanId) as any;
  const midIndex = Math.max(1, Math.floor(caravan.path.length / 2));
  caravan.stepIndex = midIndex;
  caravan.pos = caravan.path[midIndex];
  caravan.nextStepAt = clock + caravan.perStepMs;
  app.store.set('movement', caravanId, caravan);

  // 幸福村是 0 守军 NPC，第一战斗 tick 即可判定清空。
  const engaged = await send(app, 'combat.Engage', {
    targetKind: 'pve', targetId: npcId, targetXY: npcXY,
    movementId: 'attack-happy', fromVillage: A.villageId, fromXY: { q: A.q, r: A.r },
    troops: { legionnaire: 1 },
    attackerSnapshot: { legionnaire: { count: 1, form: 'melee', meleeAtk: 40, rangedAtk: 0, meleeDef: 35, rangedDef: 50, carry: 10 } },
  });
  assert.equal(engaged.ok, true, `攻击幸福村应成功: ${engaged.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + app.config.constants.combatTickMs, (t) => { clock = t; });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((await send(app, 'pve.GetTarget', { id: npcId })).ok, false, '幸福村清空后应移除 PvE 实体');
  const returned = app.store.get('movement', caravanId) as any;
  assert.equal(returned.returning, true, '途中的商队应自动进入返程');
  assert.deepEqual(returned.toXY, { q: A.q, r: A.r }, '商队应返回原出发村');
  assert.ok(returned.arriveAt > clock, '自动返程应有新的到达时间');
});

test('手动撤回商队：返程 ETA 按当前行军进度计算而非重置为整段去程', async () => {
  const app = freshApp();
  const A = await register(app, '村A-撤回');
  const npcId = `happy-${A.villageId}`;
  const npcXY = { q: A.q + 8, r: A.r + 8 };
  await send(app, 'pve.Spawn', { id: npcId, type: 'happy_village', q: npcXY.q, r: npcXY.r, noRespawn: true });
  const car = await send(app, 'movement.SendCaravan', {
    fromVillage: A.villageId, targetVillage: npcId, cargo: { crop: 1 }, homeVillage: A.villageId, routesFreed: 1,
  });
  assert.equal(car.ok, true);
  const caravanId = (car.payload as any).id;
  const caravan = app.store.get('movement', caravanId) as any;
  const midIndex = Math.max(1, Math.floor(caravan.path.length / 2));
  caravan.stepIndex = midIndex;
  caravan.pos = caravan.path[midIndex];
  caravan.nextStepAt = clock + caravan.perStepMs;
  app.store.set('movement', caravanId, caravan);
  const oldTotalMs = caravan.arriveAt - caravan.departAt;
  const recall = await send(app, 'movement.RecallMarch', { villageId: A.villageId, movementId: caravanId });
  assert.equal(recall.ok, true, `撤回应成功: ${recall.reason ?? ''}`);
  const returned = app.store.get('movement', caravanId) as any;
  assert.ok(returned.arriveAt - clock < oldTotalMs, '从半路撤回的 ETA 不应重新等于整段去程');
  assert.equal(returned.returning, true);
});

function hexDist(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
