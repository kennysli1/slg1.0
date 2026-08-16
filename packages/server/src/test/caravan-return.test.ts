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
const emit = (app: GameApp, name: string, payload: any) => app.bus.emit({ name, source: 'test', ts: clock, payload } as any);

async function register(app: GameApp, name: string) {
  const r = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(r.ok, true, `注册 ${name} 应成功: ${r.reason ?? ''}`);
  return (r.payload as any).player as { id: string; name: string; q: number; r: number; villageId: string };
}

function setMovement(app: GameApp, mv: any) {
  app.store.set('movement', mv.id, mv);
}
async function settle(app: GameApp) {
  // onTargetRemoved 用 void 抛浮空 promise，等几个 microtask/timeout 让其落定
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const anyFlipped = app.store.all('movement').some((m: any) => m.type === 'return' || (m.type === 'caravan' && m.returning));
    if (anyFlipped) return;
  }
}

test('商队：目标玩家村庄消失后应立即原路返程（world.VillageRemoved）', async () => {
  const app = freshApp();
  const A = await register(app, '村A');
  const B = await register(app, '村B');

  setMovement(app, {
    id: 'car-A-B', type: 'caravan', fromVillage: A.villageId,
    fromXY: { q: A.q, r: A.r }, toXY: { q: B.q, r: B.r },
    targetVillage: B.villageId, homeVillage: A.villageId, returning: false,
    troops: {}, cargo: { wood: 50 }, loot: {},
    departAt: clock, arriveAt: clock + 100000,
    path: [{ q: A.q, r: A.r }, { q: B.q, r: B.r }], stepIndex: 0,
    pos: { q: A.q, r: A.r }, perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });

  await emit(app, 'world.VillageRemoved', { villageId: B.villageId, q: B.q, r: B.r });
  await settle(app);

  const mv = app.store.get('movement', 'car-A-B') as any;
  assert.ok(mv, '商队应仍存在');
  assert.equal(mv.returning, true, '商队应置 returning=true（立即返程）');
  assert.deepEqual(mv.toXY, { q: A.q, r: A.r }, '商队应转向出发村 A');
  assert.equal(mv.targetId, undefined, 'targetId 应清空');
  assert.ok(mv.arriveAt > clock, '倒计时应重置为返程耗时（> clock）');
  assert.notEqual(mv.arriveAt, clock + 100000, 'arriveAt 不应仍是原送达耗时（证明已重置）');
});

test('商队：NPC/任务目标(pve)消失后应立即原路返程（pve.TargetRemoved）', async () => {
  const app = freshApp();
  const A = await register(app, '村A');
  const npcId = 'npc-happy-1';
  const npcXY = { q: A.q + 5, r: A.r + 5 };

  setMovement(app, {
    id: 'car-A-npc', type: 'caravan', fromVillage: A.villageId,
    fromXY: { q: A.q, r: A.r }, toXY: npcXY,
    targetVillage: npcId, homeVillage: A.villageId, returning: false,
    troops: {}, cargo: { crop: 30 }, loot: {},
    departAt: clock, arriveAt: clock + 100000,
    path: [{ q: A.q, r: A.r }, npcXY], stepIndex: 0,
    pos: { q: A.q, r: A.r }, perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });

  await emit(app, 'pve.TargetRemoved', { id: npcId, q: npcXY.q, r: npcXY.r });
  await settle(app);

  const mv = app.store.get('movement', 'car-A-npc') as any;
  assert.ok(mv, '商队应仍存在');
  assert.equal(mv.returning, true, '商队应置 returning=true（立即返程）');
  assert.deepEqual(mv.toXY, { q: A.q, r: A.r }, '商队应转向出发村 A');
});
