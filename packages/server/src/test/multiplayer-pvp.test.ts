import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 多人 + PvP + 账号 端到端测试（假时钟，内存store）。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd: string, tribe = 'romans') =>
  send(app, 'player.Register', { name, password: pwd, tribe });

test('注册：用户名+密码+种族，返回玩家但不含密码', async () => {
  const app = freshApp();
  const r = await reg(app, '阿尔法', 'pass123', 'gauls');
  assert.equal(r.ok, true);
  const p = (r.payload as any).player;
  assert.equal(p.name, '阿尔法');
  assert.equal(p.tribe, 'gauls');
  assert.equal((p as any).pwd, undefined, '不应泄露密码');
});

test('账号校验：重名拒绝、密码太短拒绝、登录错密码拒绝', async () => {
  const app = freshApp();
  await reg(app, '贝塔', 'pass123');
  assert.equal((await reg(app, '贝塔', 'other')).reason, 'name_taken');
  assert.equal((await reg(app, '新人', '12')).reason, 'password_too_short');
  assert.equal((await send(app, 'player.Login', { name: '贝塔', password: '错的' })).reason, 'wrong_password');
  assert.equal((await send(app, 'player.Login', { name: '贝塔', password: 'pass123' })).ok, true);
  assert.equal((await send(app, 'player.Login', { name: '查无此人', password: 'x' })).reason, 'no_such_user');
});

test('种族：高卢玩家不能训练罗马兵', async () => {
  const app = freshApp();
  const g = (await reg(app, '高卢人', 'pass123', 'gauls')).payload as any;
  const vid = g.player.villageId;
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  // 罗马军团兵 → 拒绝
  const bad = await send(app, 'military.TrainTroops', { villageId: vid, unit: 'legionnaire', count: 1 });
  assert.equal(bad.reason, 'wrong_tribe_unit');
  // 高卢方阵兵 → 允许
  const ok = await send(app, 'military.TrainTroops', { villageId: vid, unit: 'phalanx', count: 1 });
  assert.equal(ok.ok, true, `高卢应能练方阵兵: ${ok.reason ?? ''}`);
});

test('两玩家坐标不同 + 村庄归属反查', async () => {
  const app = freshApp();
  const a = (await reg(app, 'A', 'p1234')).payload as any;
  const b = (await reg(app, 'B', 'p1234')).payload as any;
  assert.ok(a.player.x !== b.player.x || a.player.y !== b.player.y);
  const owner = await send(app, 'player.GetByVillage', { villageId: a.player.villageId });
  assert.equal((owner.payload as any).player.name, 'A');
});

test('PvP：A 攻击 B，双方战报、掠夺、返程', async () => {
  const app = freshApp();
  const a = (await reg(app, '进攻方', 'p1234')).payload as any;
  const b = (await reg(app, '防守方', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: 5 });
  for (let i = 0; i < 5; i++) await app.scheduler.advanceTo(clock + 27_000, setClock);

  await send(app, 'economy.Grant', { villageId: vb, gain: { wood: 500, clay: 500, iron: 500, crop: 500 } });
  const bBefore = (await send(app, 'economy.GetResources', { villageId: vb })).payload as any;

  let atkReport: any = null, defReport: any = null, incoming: any = null;
  app.bus.on('movement.AttackResolved', (e: any) => { if (e.payload.side === 'attacker') atkReport = e.payload; else defReport = e.payload; });
  app.bus.on('movement.IncomingAttack', (e: any) => (incoming = e.payload));

  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { x: a.player.x, y: a.player.y },
    targetVillage: vb, toXY: { x: b.player.x, y: b.player.y }, troops: { legionnaire: 5 },
  });
  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);
  assert.ok(incoming, 'B 应收到来袭警报');

  await app.scheduler.advanceTo((atk.payload as any).arriveAt + 1000, setClock);
  assert.ok(atkReport && defReport, '双方都应收到战报');
  assert.equal(atkReport.attackerWins, true);

  const bAfter = (await send(app, 'economy.GetResources', { villageId: vb })).payload as any;
  assert.ok(bAfter.resources.wood < bBefore.resources.wood, 'B 资源应被抢');

  await app.scheduler.advanceTo(clock + 3_600_000, setClock);
  const army = (await send(app, 'military.GetArmy', { villageId: va })).payload as any;
  assert.ok((army.troops.legionnaire ?? 0) > 0, 'A 幸存兵应返回');
});

test('安全：不能攻击自己', async () => {
  const app = freshApp();
  const a = (await reg(app, '自攻', 'p1234')).payload as any;
  const va = a.player.villageId;
  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: 1 });
  await app.scheduler.advanceTo(clock + 27_000, setClock);
  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { x: a.player.x, y: a.player.y },
    targetVillage: va, toXY: { x: a.player.x, y: a.player.y }, troops: { legionnaire: 1 },
  });
  assert.equal(atk.reason, 'cannot_attack_self');
});
