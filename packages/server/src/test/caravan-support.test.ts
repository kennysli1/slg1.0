import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CombatModule } from '../modules/combat.js';
import { AllianceModule } from '../modules/alliance.js';
import { CommandBus } from '../infra/command-bus.js';
import { EventBus } from '../infra/event-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import { MemoryStore } from '../infra/store.js';
import { loadGameConfig } from '../infra/config.js';
import { createGameApp } from '../app.js';

const send = (commands: CommandBus, name: string, payload: any) => commands.send({ name, from: 'test', payload });
const stats = (count: number, attack = 40, carry = 10) => ({ count, attack, defense: 20, hp: 50, carry });

function combatFixture(store = new MemoryStore()) {
  let now = 1_000_000;
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => now, true);
  const config = loadGameConfig(fileURLToPath(new URL('../../../../config/', import.meta.url)));
  config.constants.combatTickMs = 10;
  const recoveries: any[] = [];
  commands.register('population.RecoverCasualties', (c) => { recoveries.push(c.payload); return { ok: true, payload: {} }; });
  commands.register('movement.RecordCaravanBattleResult', () => ({ ok: true, payload: {} }));
  const combat = new CombatModule(store, bus, commands, scheduler, () => now, config);
  combat.init();
  return { store, bus, commands, scheduler, combat, recoveries, advance: (ms: number) => scheduler.advanceTo(now + ms, (n) => { now = n; }) };
}

const engagement = () => ({
  targetKind: 'field', targetId: 'caravan:m-c', caravanId: 'm-c', targetXY: { q: 4, r: 4 },
  movementId: 'm-a', fromVillage: 'v-a', fromXY: { q: 0, r: 0 }, troops: { legionnaire: 20 },
  attackerSnapshot: { legionnaire: stats(20, 100) },
  defendersField: [
    { movementId: 'm-d1', fromVillage: 'v-d1', fromXY: { q: 2, r: 2 }, troops: { legionnaire: 5 }, attackerSnapshot: { legionnaire: stats(5, 25) }, treasures: ['warrior_banner'] },
    { movementId: 'm-d2', fromVillage: 'v-d2', fromXY: { q: 3, r: 3 }, troops: { legionnaire: 5 }, attackerSnapshot: { legionnaire: stats(5, 50) } },
    { movementId: 'm-guard', fromVillage: 'kingdom:escort', fromXY: { q: 4, r: 4 }, troops: { legionnaire: 5 }, attackerSnapshot: { legionnaire: stats(5, 60) }, npcService: true },
  ],
});

test('商队护卫战：相同兵种按护送来源保留数值，重复 Engage 不复活已受损部队', async () => {
  const f = combatFixture();
  const input = engagement();
  const result = await send(f.commands, 'combat.Engage', input);
  assert.equal(result.ok, true);
  const battle = f.store.all<any>('battle')[0]!;
  assert.equal(battle.defender['m-d1#legionnaire'].attack, 25);
  assert.equal(battle.defender['m-d2#legionnaire'].attack, 50);
  assert.deepEqual(battle.defenderFieldContributions['m-d1'].treasures, ['warrior_banner']);
  assert.deepEqual(battle.defenderFieldContributions['m-d2'].treasures, []);
  for (const villageId of ['v-a', 'v-d1', 'v-d2']) {
    assert.equal((await send(f.commands, 'combat.GetBattle', { targetKind: 'field', targetId: input.targetId, villageId })).ok, true);
  }
  const field = await send(f.commands, 'combat.GetFieldBattle', { movementId: 'm-d2' });
  assert.deepEqual(new Set((field.payload as any).battle.movementIds), new Set(['m-a', 'm-d1', 'm-d2', 'm-guard']));
  battle.attacker['m-a#legionnaire'].count = 17;
  f.store.set('battle', battle.id, battle);
  await send(f.commands, 'combat.Engage', input);
  assert.equal(f.store.get<any>('battle', battle.id).attacker['m-a#legionnaire'].count, 17);
});

test('商队护卫战：一次完整结果含各军幸存者和真实运力，NPC 不回收人口', async () => {
  const f = combatFixture();
  const caravanEvents: any[] = [];
  const reports: any[] = [];
  f.bus.on('combat.CaravanBattleEnded', (evt) => { caravanEvents.push(evt.payload); });
  f.bus.on('combat.BattleEnded', (evt) => { reports.push(evt.payload); });
  await send(f.commands, 'combat.Engage', engagement());
  await f.advance(10_000);
  assert.equal(f.store.all('battle').length, 0);
  assert.equal(caravanEvents.length, 1);
  assert.equal(caravanEvents[0].attackerWins, true);
  assert.equal(caravanEvents[0].defenders.length, 3);
  const attacker = caravanEvents[0].attackers[0];
  assert.equal(attacker.carryCapacity, attacker.survivors.legionnaire * 10);
  assert.ok(attacker.survivors.legionnaire < 20, '战后装载只按幸存兵力');
  assert.ok(f.recoveries.some((r) => r.villageId === 'v-d1'));
  assert.ok(f.recoveries.some((r) => r.villageId === 'v-d2'));
  assert.ok(!f.recoveries.some((r) => r.villageId === 'kingdom:escort'));
  assert.deepEqual(new Set(reports.map((r) => r.villageId)), new Set(['v-a', 'v-d1', 'v-d2']));
  assert.ok(reports.every((r) => r.caravanId === 'm-c'));
  assert.deepEqual(reports.find((r) => r.villageId === 'v-d1').ownLosses, { legionnaire: 5 });
});

test('商队护卫战：结算重启从已保存游标继续，不重复回收、分货或已发战报', async () => {
  const f = combatFixture();
  await send(f.commands, 'combat.Engage', engagement());
  const battle = structuredClone(f.store.all<any>('battle')[0]);
  battle.status = 'resolving';
  battle.attacker['m-a#legionnaire'].count = 12;
  for (const unit of Object.values(battle.defender) as any[]) unit.count = 0;
  battle.resolution = {
    id: `${battle.id}:${battle.startedAt}`, step: 'emit_defender_report', startedAt: 1_000_000,
    attackerWins: true, fieldCasualtyIndex: 4, caravanResultEmitted: true, attackerReportIndex: 1, defenderReportIndex: 1,
  };
  const restored = new MemoryStore();
  restored.set('battle', battle.id, battle);
  const next = combatFixture(restored);
  const results: any[] = []; const reports: any[] = [];
  next.bus.on('combat.CaravanBattleEnded', (evt) => { results.push(evt.payload); });
  next.bus.on('combat.BattleEnded', (evt) => { reports.push(evt.payload); });
  next.combat.resume();
  await next.advance(0);
  assert.equal(next.recoveries.length, 0);
  assert.equal(results.length, 0);
  assert.deepEqual(reports.map((r) => r.villageId), ['v-d2']);
  assert.equal(next.store.all('battle').length, 0);
});

function allianceFixture() {
  const store = new MemoryStore(); const bus = new EventBus(); const commands = new CommandBus();
  const config = loadGameConfig(fileURLToPath(new URL('../../../../config/', import.meta.url))); const scheduler = new Scheduler(() => 1_000_000, true);
  new AllianceModule(store, bus, commands, scheduler, () => 1_000_000, config).init();
  const state = {
    id: 'a-1', name: '测试联盟', leaderId: 'p-1', leaderName: '盟主', memberIds: [], roles: {}, hallVillageId: 'v-hall',
    level: 1, disconnected: false, joinRequests: {}, warehouse: { wood: 0, clay: 0, iron: 0, crop: 0 },
    resourceContributions: {}, techPointStock: 0, techContributions: {}, buildings: {}, technologies: {}, warPlans: {},
    pendingResourceDeliveries: {
      'm-c': { playerId: 'p-1', sourceVillageId: 'v-source', amount: { wood: 100, clay: 50, iron: 0, crop: 0 }, sentAt: 0, arriveAt: 100 },
    }, serviceOrders: [] as any[],
  };
  store.set('alliance', state.id, state);
  return { store, bus, commands, config, state };
}

test('联盟贡献商队被部分劫掠：只以实际送达数量入库与累计历史贡献', async () => {
  const f = allianceFixture();
  const delivered = await send(f.commands, 'alliance.ReceiveResourceCaravan', {
    allianceId: 'a-1', movementId: 'm-c', targetVillageId: 'v-hall', cargo: { wood: 60, clay: 10 },
  });
  assert.equal(delivered.ok, true, delivered.reason);
  const state = f.store.get<any>('alliance', 'a-1');
  assert.deepEqual(state.warehouse, { wood: 60, clay: 10, iron: 0, crop: 0 });
  assert.deepEqual(state.resourceContributions['p-1'], state.warehouse);
  assert.equal(state.pendingResourceDeliveries['m-c'], undefined);
  const repeat = await send(f.commands, 'alliance.ReceiveResourceCaravan', { allianceId: 'a-1', movementId: 'm-c', cargo: { wood: 60 } });
  assert.equal(repeat.ok, false);
  assert.equal(f.store.get<any>('alliance', 'a-1').warehouse.wood, 60);
});

test('联盟商队拒绝超额交付，被抢空的贡献和服务订单均清理等待状态', async () => {
  const f = allianceFixture();
  const invalid = await send(f.commands, 'alliance.ReceiveResourceCaravan', { allianceId: 'a-1', movementId: 'm-c', cargo: { wood: 101 } });
  assert.equal(invalid.ok, false);
  assert.equal(f.store.get<any>('alliance', 'a-1').warehouse.wood, 0);
  f.state.pendingResourceDeliveries['m-c'] = { playerId: 'p-1', sourceVillageId: 'v-source', amount: { wood: 100, clay: 50, iron: 0, crop: 0 }, sentAt: 0, arriveAt: 100 };
  f.state.serviceOrders.push({ id: 's-1', movementId: 'm-c', status: 'pending' });
  f.store.set('alliance', 'a-1', f.state);
  await f.bus.emit({ name: 'movement.CaravanDeliveryAborted', source: 'test', ts: 0, payload: { allianceId: 'a-1', movementId: 'm-c' } });
  assert.deepEqual(f.store.get<any>('alliance', 'a-1').pendingResourceDeliveries, {});
  assert.equal(f.store.get<any>('alliance', 'a-1').serviceOrders[0].status, 'failed');
});

test('联盟王国资源服务接受剩余货物，重复交付不重复入库', async () => {
  const f = allianceFixture();
  const service = Object.values(f.config.allianceServices).find((s) => s.category === 'supplies')!;
  assert.ok(service);
  f.state.serviceOrders.push({ id: 's-1', movementId: 'm-service', status: 'pending', serviceCode: service.code, category: 'supplies' });
  f.store.set('alliance', 'a-1', f.state);
  const cargo = { wood: Math.floor(service.resources.wood / 2) };
  const payload = { allianceId: 'a-1', serviceOrderId: 's-1', cargo };
  assert.equal((await send(f.commands, 'alliance.ReceiveServiceResources', payload)).ok, true);
  assert.equal((await send(f.commands, 'alliance.ReceiveServiceResources', payload)).ok, true);
  assert.equal(f.store.get<any>('alliance', 'a-1').warehouse.wood, cargo.wood);
  assert.deepEqual(f.store.get<any>('alliance', 'a-1').resourceContributions, {});
});

test('议会厅商队护卫：列出可选商队，先验证再扣声望；失效及重复购买退款', async () => {
  const app = createGameApp({ manualScheduler: true, now: () => 1_000_000 });
  const registered = await send(app.commands, 'player.Register', { name: '商队护卫购买', password: 'pass123', tribe: 'romans' });
  const player = (registered.payload as any).player;
  const building = app.store.get<any>('building', player.villageId);
  building.placed.push({ slotId: 'inner-council-test', kind: 'council', zone: 'inner', level: 1 });
  app.store.set('building', player.villageId, building);
  await send(app.commands, 'reputation.Adjust', { playerId: player.id, delta: 10, reason: 'test' });
  await send(app.commands, 'reputation.SetAllianceBonus', { playerId: player.id, bonus: 1 });
  app.config.kingdomServices.test_escort = { ...app.config.kingdomServices.reinforcement_guard!, code: 'test_escort', category: 'escort' as any, reputationCost: 3 };
  let valid = true; let protectionSucceeds = false; let protections = 0;
  const originalSend = app.commands.send.bind(app.commands);
  app.commands.send = (async (c: any) => {
    if (c.name === 'movement.ListEscortCaravans') return { ok: true, payload: { caravans: [{ id: 'm-c', targetVillage: player.villageId }] } };
    if (c.name === 'movement.ValidateCaravanProtection') return { ok: valid, payload: {}, reason: valid ? undefined : 'caravan_already_protected' };
    if (c.name === 'movement.ProtectCaravan') { protections++; return { ok: protectionSucceeds, payload: {}, reason: protectionSucceeds ? undefined : 'caravan_not_found' }; }
    return originalSend(c);
  }) as typeof app.commands.send;
  const overview = await send(app.commands, 'kingdom.GetState', { playerId: player.id, villageId: player.villageId });
  assert.equal((overview.payload as any).eligibleCaravans[0].id, 'm-c');
  const input = { playerId: player.id, villageId: player.villageId, serviceCode: 'test_escort', targetMovementId: 'm-c' };
  const failed = await send(app.commands, 'kingdom.BuyService', input);
  assert.equal(failed.reason, 'caravan_not_found');
  assert.equal(((await send(app.commands, 'reputation.Get', { playerId: player.id })).payload as any).value, 10);
  protectionSucceeds = true;
  assert.equal((await send(app.commands, 'kingdom.BuyService', input)).ok, true);
  assert.equal(((await send(app.commands, 'reputation.Get', { playerId: player.id })).payload as any).value, 7);
  valid = false;
  assert.equal((await send(app.commands, 'kingdom.BuyService', input)).reason, 'caravan_already_protected');
  assert.equal(protections, 2);
  assert.equal(((await send(app.commands, 'reputation.Get', { playerId: player.id })).payload as any).value, 7);
});
