import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/** 野战（targetKind:field）Combat 推送与可见性测试。 */

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('野战：双方村庄均收到 BattleStarted，且均可 GetBattle', async () => {
  const app = freshApp();
  const ra = await send(app, 'player.Register', { name: '野战红', password: 'pass123', tribe: 'romans' });
  const rb = await send(app, 'player.Register', { name: '野战蓝', password: 'pass123', tribe: 'romans' });
  const A = (ra.payload as any).player;
  const B = (rb.payload as any).player;
  await send(app, 'military.AdjustTroops', { villageId: A.villageId, delta: { legionnaire: 20 } });
  await send(app, 'military.AdjustTroops', { villageId: B.villageId, delta: { legionnaire: 15 } });

  await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 20 },
  });
  const bAtk = await send(app, 'movement.SendAttack', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { legionnaire: 15 },
  });
  assert.ok((bAtk.payload as any).id, '反向行军应成功创建');

  const started: string[] = [];
  app.bus.on('combat.BattleStarted', (e) => {
    started.push((e.payload as any).villageId);
  });

  let iters = 0;
  while (started.length < 2 && app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }
  assert.ok(started.includes(A.villageId), '进攻方村应收到 BattleStarted');
  assert.ok(started.includes(B.villageId), '野战防守方村应收到 BattleStarted');

  const fieldBattle = app.store.all<any>('battle').find((battle) => battle.targetKind === 'field');
  assert.ok(fieldBattle, '应存在进行中的野战');
  const viewA = await send(app, 'combat.GetBattle', { targetId: fieldBattle.targetId, villageId: A.villageId });
  const viewB = await send(app, 'combat.GetBattle', { targetId: fieldBattle.targetId, villageId: B.villageId });
  assert.equal(viewA.ok, true);
  assert.equal(viewB.ok, true);
  assert.equal((viewA.payload as any).battle?.targetKind, 'field');
  assert.equal((viewB.payload as any).battle?.targetKind, 'field');
});
