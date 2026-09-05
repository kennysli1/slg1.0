import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MovementModule } from '../modules/movement.js';
import { CombatModule } from '../modules/combat.js';
import { NotificationsModule } from '../modules/notifications.js';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import { loadGameConfig } from '../infra/config.js';

function fixture(store = new MemoryStore(), start = 1_000_000) {
  let now = start, visible = true, allied = false;
  const config = loadGameConfig(fileURLToPath(new URL('../../../../config/', import.meta.url)));
  config.constants.tradeCaravanSpeed = 3600;
  config.constants.tradeCaravanMinDurationSec = 0.001;
  config.constants.marchSpeedMultiplier = 1;
  config.constants.combatTickMs = 1;
  config.units.legionnaire.carry = 10;
  const commands = new CommandBus(), bus = new EventBus(), scheduler = new Scheduler(() => now, true);
  const villages: Record<string, any> = { a: { q: 0, r: 0 }, b: { q: 8, r: 0 }, r: { q: 0, r: 0 } };
  const grants: any[] = [], returns: any[] = [], reports: any[] = [], foreign: any[] = [], removed: any[] = [], warnings: any[] = [];
  commands.register<any, any>('player.GetByVillage', ({ payload }: any) => villages[payload.villageId] ? { ok: true, payload: { player: { id: payload.villageId, name: payload.villageId, villages: [{ id: payload.villageId, name: `村${payload.villageId}` }] } } } : { ok: false, payload: {} });
  commands.register('player.Get', ({ payload }: any) => ({ ok: true, payload: { player: { id: payload.playerId, villages: [{ id: payload.playerId }] } } }));
  commands.register('world.GetTileByRef', ({ payload }: any) => ({ ok: !!villages[payload.refId], payload: { tile: villages[payload.refId] ? { ...villages[payload.refId], kind: 'village', name: `村${payload.refId}`, refId: payload.refId } : undefined } }));
  commands.register('world.GetTile', () => ({ ok: true, payload: { tile: { terrain: 'plain', kind: 'empty' } } }));
  commands.register('vision.GetVisibility', () => ({ ok: true, payload: { visibility: visible ? 'visible' : 'explored' } }));
  commands.register('vision.GetVisibleTiles', () => ({ ok: true, payload: { tiles: visible ? Array.from({ length: 20 }, (_, q) => `${q},0`) : [] } }));
  commands.register('vision.GetObservers', () => ({ ok: true, payload: { playerIds: visible ? ['a', 'b', 'r'] : [] } }));
  commands.register('vision.Reveal', () => ({ ok: true, payload: { newlyRevealed: [] } }));
  commands.register('alliance.GetRelation', () => ({ ok: true, payload: { relation: allied ? 'allied' : 'neutral' } }));
  commands.register('diplomacy.GetRelation', () => ({ ok: true, payload: { relation: 'neutral' } }));
  commands.register('building.GetBuildingLevel', () => ({ ok: true, payload: { level: 100 } }));
  commands.register('military.GetMarchSpeedSnapshot', () => ({ ok: true, payload: { slowestSpeed: 7200 } }));
  commands.register('military.GetCombatSnapshot', ({ payload }: any) => ({ ok: true, payload: { snapshot: Object.fromEntries(Object.entries(payload.units ?? {}).map(([code, n]) => [code, { ...config.units[code], count: n }])) } }));
  commands.register('military.GetArmy', () => ({ ok: true, payload: { troops: { legionnaire: 100 }, availableTroops: { legionnaire: 100 } } }));
  commands.register('military.AdjustTroops', () => ({ ok: true, payload: {} }));
  commands.register('military.SetMarchingTroops', () => ({ ok: true, payload: {} }));
  commands.register('population.SetEnRoutePop', () => ({ ok: true, payload: {} }));
  commands.register('population.RecoverCasualties', () => ({ ok: true, payload: {} }));
  commands.register('treasure.LoseCarried', () => ({ ok: true, payload: {} }));
  commands.register('treasure.RestoreCarried', () => ({ ok: true, payload: {} }));
  commands.register('economy.Grant', ({ payload }: any) => { grants.push(payload); return { ok: true, payload: {} }; });
  bus.on('movement.CaravanReturned', (e) => { returns.push(e.payload); });
  bus.on('movement.CaravanRaidReport', (e) => { reports.push(e.payload); });
  bus.on('movement.ForeignStepped', (e) => { foreign.push(e.payload); });
  bus.on('movement.ForeignRemoved', (e) => { removed.push(e.payload); });
  bus.on('movement.IncomingWarningChanged', (e) => { warnings.push(e.payload); });
  const movement = new MovementModule(store, bus, commands, scheduler, () => now, config);
  movement.init();
  const combat = new CombatModule(store, bus, commands, scheduler, () => now, config); combat.init();
  new NotificationsModule(store, bus, commands, () => now, config).init();
  const send = (name: string, payload: any) => commands.send({ name, from: 'test', payload });
  return { store, movement, config, grants, returns, reports, foreign, removed, warnings, commands, bus, send, villages,
    clock: () => now,
    setVisible: (v: boolean) => { visible = v; }, setAllied: (v: boolean) => { allied = v; },
    advance: (ms: number) => scheduler.advanceTo(now + ms, (n) => { now = n; }),
    caravan: async (cargo = { wood: 100 }) => { const res = await send('movement.SendCaravan', { fromVillage: 'a', targetVillage: 'b', cargo, homeVillage: 'a', routesFreed: 1 }); assert.equal(res.ok, true, res.reason); return (res.payload as any).id as string; },
    mission: async (targetMovementId: string, type = 'Raid', villageId = 'r', count = 3) => { const res = await send(`movement.SendCaravan${type}`, { villageId, targetMovementId, troops: { legionnaire: count } }); assert.equal(res.ok, true, res.reason); return (res.payload as any).id as string; },
  };
}

test('商队追赶：段内追上，部分取货后分头原路返程/继续送达，资源守恒', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(333);
  const raid = await f.mission(car); await f.advance(400);
  const returned = f.store.get<any>('movement', raid);
  assert.equal(returned.type, 'return');
  assert.ok(returned.pos.q > 0 && returned.pos.q < 1, '必须在段内相遇原地掉头，不能跳到格心');
  assert.deepEqual(returned.loot, { wood: 30 });
  assert.deepEqual(f.store.get<any>('movement', car).cargo, { wood: 70 });
  assert.equal(f.reports[0].outcome, 'partial_delivery');
  assert.equal(f.reports[0].destinationVillageName, '村b');
  await f.advance(20_000);
  assert.equal(f.grants.find((x) => x.villageId === 'r')?.gain.wood, 30);
  assert.equal(f.grants.find((x) => x.villageId === 'b')?.gain.wood, 70);
  assert.equal(f.returns.length, 1);
});

test('抢空商队：立即原路回家，路线仅在返家释放，空返商队再被追上没有货物', async () => {
  const f = fixture(); const car = await f.caravan({ wood: 20 }); await f.advance(300);
  await f.mission(car); await f.advance(310);
  assert.equal(f.store.get<any>('movement', car).returning, true);
  assert.equal(f.reports[0].outcome, 'empty_return'); assert.equal(f.returns.length, 0);
  await f.advance(2_000); assert.equal(f.returns.length, 1);
  assert.equal(f.grants.some((x) => x.villageId === 'b'), false);
  const empty = await f.caravan({ wood: 50 }); await f.advance(8_000);
  const back = f.store.all<any>('movement').find((x) => x.type === 'caravan' && x.id !== empty)!;
  assert.ok(back.returning);
  const outcome = await f.send('movement.SendCaravanRaid', { villageId: 'b', targetMovementId: back.id, troops: { legionnaire: 1 } });
  assert.equal(outcome.ok, false, '关联自己的商队不可劫掠');
});

test('权限与隐藏：自己相关商队仅护送，盟友商队不能劫掠，视野外来货仍公开目的地', async () => {
  const f = fixture(); const car = await f.caravan();
  f.setVisible(false);
  const incoming = await f.send('movement.ListForeign', { playerId: 'b' });
  assert.equal((incoming.payload as any).movements.length, 1);
  assert.equal((incoming.payload as any).movements[0].caravan.canEscort, true);
  assert.equal((incoming.payload as any).movements[0].caravan.canRaid, false);
  const stranger = await f.send('movement.ListForeign', { playerId: 'r' });
  assert.deepEqual((stranger.payload as any).movements, []);
  f.setVisible(true); f.setAllied(true);
  assert.equal((await f.send('movement.SendCaravanRaid', { villageId: 'r', targetMovementId: car, troops: { legionnaire: 1 } })).ok, false);
  f.setAllied(false);
  const before = await f.send('movement.ListForeign', { playerId: 'r' });
  assert.equal((await f.send('movement.ProtectCaravan', { villageId: 'a', targetMovementId: car, troops: { legionnaire: 2 } })).ok, true);
  const after = await f.send('movement.ListForeign', { playerId: 'r' });
  assert.deepEqual(after, before, '王国护卫不能从商队公开快照判断');
  assert.equal((await f.send('movement.ProtectCaravan', { villageId: 'a', targetMovementId: car, troops: { legionnaire: 2 } })).ok, false);
});

test('商队劫掠初始预警：派出瞬间向商队所属玩家的可见村庄推送', async () => {
  const f = fixture();
  const car = await f.caravan();
  await f.advance(200);
  await f.mission(car, 'Raid', 'r');
  const raid = f.store.all<any>('movement').find((m) => m.type === 'caravan_raid');
  assert.ok(raid);
  assert.deepEqual(
    f.warnings.filter((warning: any) => warning.movementId === raid.id && warning.visible).map((warning: any) => warning.villageId).sort(),
    ['a', 'b'],
  );
});

test('驻扎军劫掠商队复用原 movement：不会从城镇重新派出一支军队', async () => {
  const f = fixture();
  const garrison = await f.send('movement.SendGarrison', { villageId: 'r', q: 0, r: 2, troops: { legionnaire: 3 } });
  assert.equal(garrison.ok, true, garrison.reason);
  const garrisonId = (garrison.payload as any).id as string;
  for (let i = 0; i < 10 && f.store.get<any>('movement', garrisonId)?.status !== 'stationed'; i++) await f.advance(600);
  assert.equal(f.store.get<any>('movement', garrisonId)?.status, 'stationed');

  const caravan = await f.caravan();
  const continued = await f.send('movement.ContinueGarrison', {
    villageId: 'r', movementId: garrisonId, q: 0, r: 0,
    mode: 'caravan_raid', targetMovementId: caravan,
  });
  assert.equal(continued.ok, true, continued.reason);
  const active = f.store.get<any>('movement', garrisonId);
  assert.equal(active?.type, 'caravan_raid');
  assert.equal(f.store.all<any>('movement').filter((m) => m.fromVillage === 'r' && m.type === 'caravan_raid').length, 1);
  assert.equal(f.store.get<any>('movement', (continued.payload as any).id)?.id, garrisonId);
});

test('护送：段内会合与商队同速，第三方不可见军队，抵达原派兵村直接收兵', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(200);
  const escort = await f.mission(car, 'Escort', 'b');
  await f.advance(3_000);
  assert.equal(f.store.get<any>('movement', escort).caravanMission.attached, true);
  const wire = await f.send('movement.ListPlayer', { playerId: 'b' });
  const army = (wire.payload as any).movements.find((m: any) => m.id === escort);
  const caravan = f.store.get<any>('movement', car);
  assert.deepEqual(army.pos, caravan.pos); assert.equal(army.nextStepAt, caravan.nextStepAt);
  const foreign = await f.send('movement.ListForeign', { playerId: 'r' });
  assert.equal((foreign.payload as any).movements.some((m: any) => m.id === escort), false);
  assert.ok(f.removed.some((e) => e.id === escort && e.playerIds.includes('r')), '合体时立即移除此前的外军图标');
  const escortRecord = f.store.get<any>('movement', escort);
  const landing = await (f.movement as any).garrisonLanding({ id: 'probe', toXY: escortRecord.pos, path: [{ q: 0, r: 0 }, escortRecord.pos], fromXY: { q: 0, r: 0 } });
  assert.deepEqual(landing, escortRecord.pos, '隐藏护送队不能通过阻挡驻扎泄露');
  await f.advance(5_000);
  assert.equal(f.store.get('movement', escort), undefined);
});

test('追赶失去视野：不等下一格即回头，保留段内位置和实际去程耗时', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(600);
  const raid = await f.mission(car); await f.advance(100); f.setVisible(false);
  await (f.movement as any).checkCaravanMission(f.store.get('movement', raid));
  const back = f.store.get<any>('movement', raid);
  assert.equal(back.type, 'return'); assert.equal(back.arriveAt - f.clock(), 100);
  const listed = await f.send('movement.List', { villageId: 'r' });
  assert.ok((listed.payload as any).movements[0].turningPoint);
});

test('并发劫掠：同一货物不会复制，每支军最多搬自己的运力', async () => {
  const f = fixture(); const car = await f.caravan({ wood: 40 }); await f.advance(300);
  await Promise.all([f.mission(car), f.mission(car)]); await f.advance(3_000);
  const total = f.grants.filter((x) => x.villageId === 'r').reduce((n, x) => n + (x.gain?.wood ?? 0), 0);
  assert.ok(total <= 40 && total >= 30);
  assert.ok(f.reports.every((r) => (r.loot.wood ?? 0) <= 30));
});

test('护卫战：真实战斗结算后按幸存者运力搬运，结果重放不重复取货', async () => {
  const f = fixture(); const car = await f.caravan({ wood: 500 }); await f.advance(300);
  await f.send('movement.ProtectCaravan', { villageId: 'a', targetMovementId: car, troops: { legionnaire: 1 } });
  const results: any[] = []; f.bus.on('combat.CaravanBattleEnded', (e) => { results.push(e); });
  const raid = await f.mission(car, 'Raid', 'r', 10); await f.advance(350);
  assert.equal(results.length, 1);
  const result = results[0].payload;
  const back = f.store.get<any>('movement', raid);
  assert.equal(back.type, 'return');
  assert.equal(back.loot.wood, result.attackers[0].carryCapacity);
  const remaining = f.store.get<any>('movement', car).cargo.wood;
  await f.bus.emit(results[0]);
  assert.equal(f.store.get<any>('movement', car).cargo.wood, remaining);
});

test('重启：追赶路径与计时恢复，已有行军不受新速度配置影响', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(600);
  const raid = await f.mission(car); await f.advance(100);
  const restart = fixture(f.store, f.clock()); restart.config.constants.tradeCaravanSpeed = 1;
  restart.movement.resume(); await restart.advance(1_000);
  assert.equal(restart.store.get<any>('movement', raid).type, 'return');
  assert.equal(restart.store.get<any>('movement', car).cargo.wood, 70);
});

test('可见受众变化：视野外来货折返或删除会立即移除收货方旧图标', async () => {
  const f = fixture(); const car = await f.caravan(); f.setVisible(false); await f.advance(300);
  await (f.movement as any).startReturn(f.store.get('movement', car));
  assert.ok(f.removed.some((e) => e.id === car && e.playerIds.includes('b')));
  const second = await f.caravan();
  const removed = new Promise<void>((resolve) => {
    const off = f.bus.on('movement.ForeignRemoved', (e) => {
      if ((e.payload as any).id === second) { off(); resolve(); }
    });
  });
  (f.movement as any).remove(second);
  await removed;
  assert.ok(f.removed.some((e) => e.id === second && e.playerIds.includes('b')));
});

test('交付失败统一保留货物：目标丢失和入库拒绝都原物带回', async () => {
  for (const missing of [true, false]) {
    const f = fixture(); await f.caravan(); await f.advance(100);
    if (missing) delete f.villages.b;
    else {
      const original = f.commands.send.bind(f.commands);
      f.commands.send = (async (c: any) => c.name === 'economy.Grant' && c.payload.villageId === 'b'
        ? { ok: false, payload: {}, reason: 'village_not_found' } : original(c)) as typeof f.commands.send;
    }
    await f.advance(20_000);
    assert.equal(f.grants.filter((g) => g.villageId === 'a').reduce((s, g) => s + (g.gain?.wood ?? 0), 0), 100);
    assert.equal(f.returns.length, 1);
  }
});

test('空返商队被第三方追上：不取货、不战斗，掠夺军正常返程', async () => {
  const f = fixture(); await f.caravan(); await f.advance(8_000);
  const back = f.store.all<any>('movement').find((m) => m.type === 'caravan' && m.returning)!;
  const raid = await f.mission(back.id); await f.advance(3_000);
  assert.equal(f.reports[0].outcome, 'empty');
  assert.deepEqual(f.reports[0].loot, {});
  assert.equal(f.store.get<any>('movement', raid).type, 'return');
  assert.equal(f.store.all('battle').length, 0);
});

test('商队交战暂停：追兵追到实际暂停点等待，商队恢复后继续追赶', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(600);
  const raid = await f.mission(car); await f.advance(100);
  (f.movement as any).splitCaravanSegment(f.store.get('movement', car));
  await f.advance(10_000);
  const waiting = f.store.get<any>('movement', raid);
  assert.equal(waiting.status, 'stopped');
  assert.ok(Math.abs(waiting.pos.q - 0.7) < 0.000001);
  assert.equal(waiting.type, 'caravan_raid', '旧arriveAt不能中断暂停中的追赶');
  (f.movement as any).resumeCaravanMotion(f.store.get('movement', car));
  await (f.movement as any).syncCaravanFollowers(f.store.get('movement', car));
  assert.equal(f.store.get<any>('movement', raid).type, 'return');
  assert.equal(f.store.get<any>('movement', raid).loot.wood, 30);
});

test('追兵等待期间失去视野：返程只计实际走过的路径，不计等待时间', async () => {
  const f = fixture(); const car = await f.caravan(); await f.advance(600);
  const raid = await f.mission(car); await f.advance(100);
  (f.movement as any).splitCaravanSegment(f.store.get('movement', car));
  await f.advance(5_000);
  const waiting = f.store.get<any>('movement', raid);
  const travelled = waiting.caravanTiming.slice(0, waiting.stepIndex).reduce((s: number, n: number) => s + n, 0);
  f.setVisible(false); await (f.movement as any).checkCaravanMission(waiting);
  const back = f.store.get<any>('movement', raid);
  assert.equal(back.type, 'return');
  assert.equal(back.arriveAt - f.clock(), travelled);
});

test('护卫交战期间目的地消失：战后剩余货物返回来源，不会送入已删除村', async () => {
  const f = fixture(); f.config.constants.combatTickMs = 1_000;
  const car = await f.caravan({ wood: 500 }); await f.advance(300);
  await f.send('movement.ProtectCaravan', { villageId: 'a', targetMovementId: car, troops: { legionnaire: 1 } });
  await f.mission(car, 'Raid', 'r', 10); await f.advance(350);
  assert.equal(f.store.get<any>('movement', car).status, 'paused');
  delete f.villages.b;
  await f.advance(20_000);
  const looted = f.grants.filter((g) => g.villageId === 'r').reduce((s, g) => s + (g.gain?.wood ?? 0), 0);
  const returned = f.grants.filter((g) => g.villageId === 'a').reduce((s, g) => s + (g.gain?.wood ?? 0), 0);
  assert.equal(looted + returned, 500);
  assert.ok(returned > 0);
  assert.equal(f.grants.some((g) => g.villageId === 'b'), false);
});
