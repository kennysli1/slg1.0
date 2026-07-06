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
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string) => send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
async function buildBarracks(app: GameApp, villageId: string): Promise<void> {
  const r = await send(app, 'building.Build', { villageId, zone: 'outer', kind: 'barracks' });
  assert.equal(r.ok, true, `建兵营应成功: ${r.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);
}
async function drain(app: GameApp): Promise<void> {
  let i = 0;
  while (app.scheduler.pending > 0 && i < 30000) { await app.scheduler.advanceTo(clock + 3_600_000, setClock); i++; }
}

test('notifications: 建筑升级事件被记录', async () => {
  const app = freshApp();
  const r = (await reg(app, '建村人')).payload as any;
  const vid = r.player.villageId;
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const layout = (await send(app, 'building.GetLayout', { villageId: vid })).payload as any;
  const wood = layout.zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
  const up = await send(app, 'building.Upgrade', { villageId: vid, slotId: wood.slotId });
  assert.equal(up.ok, true, `升级田应成功: ${up.reason ?? ''}`);
  await drain(app);

  const res = (await send(app, 'notifications.List', { villageId: vid })).payload as any;
  const events = (res.notifications as any[]).map((n: any) => n.event);
  assert.ok(events.includes('BuildingUpgraded'), `应有 BuildingUpgraded，实际: ${JSON.stringify(events)}`);
});

test('notifications: PvP 攻守双方各收一条 BattleEnded', async () => {
  const app = freshApp();
  const a = (await reg(app, '攻')).payload as any;
  const b = (await reg(app, '守')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 999, clay: 999, iron: 999, crop: 999 } });
  await buildBarracks(app, va);
  await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: 5 });
  for (let i = 0; i < 5; i++) await app.scheduler.advanceTo(clock + 27_000, setClock);

  await send(app, 'movement.SendAttack', {
    villageId: va, targetVillage: vb, troops: { legionnaire: 5 },
  });
  await drain(app);

  const atkRes = (await send(app, 'notifications.List', { villageId: va })).payload as any;
  const defRes = (await send(app, 'notifications.List', { villageId: vb })).payload as any;
  const atkEvents = (atkRes.notifications as any[]).map((n: any) => n.event);
  const defEvents = (defRes.notifications as any[]).map((n: any) => n.event);

  assert.ok(atkEvents.includes('BattleEnded'), `攻方应有 BattleEnded，实际: ${JSON.stringify(atkEvents)}`);
  assert.ok(defEvents.includes('BattleEnded'), `守方应有 BattleEnded，实际: ${JSON.stringify(defEvents)}`);
  assert.ok(atkEvents.includes('MarchReturned'), `攻方应有 MarchReturned，实际: ${JSON.stringify(atkEvents)}`);
  assert.ok(defEvents.includes('IncomingAttack'), `守方应有 IncomingAttack，实际: ${JSON.stringify(defEvents)}`);
});

test('notifications: 超过上限时丢最旧条目', async () => {
  const app = freshApp();
  const r = (await reg(app, '压测')).payload as any;
  const vid = r.player.villageId;
  const cap = app.config.constants.notificationsPerVillage;

  // 直接往 bus 发超量的 building.Upgraded 事件
  for (let i = 0; i < cap + 10; i++) {
    await app.bus.emit({ name: 'building.Upgraded', source: 'test', ts: clock + i, payload: { villageId: vid, kind: 'field_wood', level: i + 1 } } as any);
  }

  const res = (await send(app, 'notifications.List', { villageId: vid })).payload as any;
  assert.equal((res.notifications as any[]).length, cap, `应恰好保留 ${cap} 条`);
  // 最旧的(level=1)应被丢弃，最新的(level=cap+10)应留着
  const levels = (res.notifications as any[]).map((n: any) => n.payload.level);
  assert.ok(!levels.includes(1), '最旧条目应被丢弃');
  assert.ok(levels.includes(cap + 10), '最新条目应保留');
});

test('notifications: 没有 villageId 的事件不记录', async () => {
  const app = freshApp();
  const r = (await reg(app, '空事件')).payload as any;
  const vid = r.player.villageId;

  // 发一个没有 villageId 的伪事件
  await app.bus.emit({ name: 'building.Upgraded', source: 'test', ts: clock, payload: { kind: 'field_wood', level: 1 } } as any);

  const res = (await send(app, 'notifications.List', { villageId: vid })).payload as any;
  assert.equal((res.notifications as any[]).length, 0, '无 villageId 事件不应被记录');
});
