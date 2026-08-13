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
