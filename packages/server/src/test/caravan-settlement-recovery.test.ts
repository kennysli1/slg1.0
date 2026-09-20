import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { DomainEvent } from '@slg/shared';
import { MovementModule } from '../modules/movement.js';
import { CombatModule } from '../modules/combat.js';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import { loadGameConfig } from '../infra/config.js';

type State = Array<[string, Array<[string, unknown]>]>;

/** WAL 快照必须复制值，不能把 Store 的可变内存引用误当作已经持久化的数据。 */
class CheckpointStore extends MemoryStore {
  durable = new Map<string, Map<string, unknown>>();
  checkpoints: State[] = [];
  recording = false;
  failNext: ((key: string, value: any) => boolean) | undefined;
  override set<T>(collection: string, key: string, value: T): void {
    if (this.failNext?.(key, value)) { this.failNext = undefined; throw new Error('injected WAL interruption'); }
    let col = this.durable.get(collection);
    if (!col) { col = new Map(); this.durable.set(collection, col); }
    col.set(key, structuredClone(value));
    super.set(collection, key, value);
    if (this.recording) this.checkpoints.push(this.snapshot());
  }
  override delete(collection: string, key: string): boolean {
    this.durable.get(collection)?.delete(key);
    const result = super.delete(collection, key);
    if (this.recording) this.checkpoints.push(this.snapshot());
    return result;
  }
  snapshot(): State { return structuredClone([...this.durable].map(([c, values]) => [c, [...values]])); }
  static restore(state: State): CheckpointStore {
    const store = new CheckpointStore();
    for (const [collection, rows] of state) for (const [id, value] of rows) store.set(collection, id, structuredClone(value));
    return store;
  }
}

function fixture(store = new CheckpointStore(), start = 1_000_000) {
  let now = start;
  const config = loadGameConfig(fileURLToPath(new URL('../../../../config/', import.meta.url)));
  config.constants.tradeCaravanSpeed = 3600;
  config.constants.tradeCaravanMinDurationSec = 0.001;
  config.constants.marchSpeedMultiplier = 1;
  config.constants.combatTickMs = 1;
  config.units.legionnaire.carry = 10;
  const commands = new CommandBus(), bus = new EventBus(), scheduler = new Scheduler(() => now, true);
  const grants: any[] = [], reports: any[] = [], losses: any[] = [];
  const villages: Record<string, { q: number; r: number }> = { a: { q: 0, r: 0 }, b: { q: 8, r: 0 }, r: { q: 0, r: 0 }, e: { q: 0, r: 0 } };
  let failSnapshot = false, failReturn = false;
  commands.register('player.GetByVillage', ({ payload }: any) => ({ ok: true, payload: { player: { id: payload.villageId, name: payload.villageId, villages: [{ id: payload.villageId, name: `村${payload.villageId}` }] } } }));
  commands.register('player.Get', ({ payload }: any) => ({ ok: true, payload: { player: { id: payload.playerId, villages: [{ id: payload.playerId }] } } }));
  commands.register('world.GetTileByRef', ({ payload }: any) => ({ ok: true, payload: { tile: { ...villages[payload.refId], kind: 'village', name: `村${payload.refId}`, refId: payload.refId } } }));
  commands.register('world.GetTile', () => ({ ok: true, payload: { tile: { terrain: 'plain', kind: 'empty' } } }));
  commands.register('vision.GetVisibility', () => ({ ok: true, payload: { visibility: 'visible' } }));
  commands.register('vision.GetObservers', () => ({ ok: true, payload: { playerIds: ['a', 'b', 'r', 'e'] } }));
  commands.register('alliance.GetRelation', () => ({ ok: true, payload: { relation: 'neutral' } }));
  commands.register('diplomacy.GetRelation', () => ({ ok: true, payload: { relation: 'neutral' } }));
  commands.register('military.GetMarchSpeedSnapshot', () => {
    if (failReturn) { failReturn = false; throw new Error('injected return timing interruption'); }
    return { ok: true, payload: { slowestSpeed: 7200 } };
  });
  commands.register('military.GetCombatSnapshot', ({ payload }: any) => {
    if (failSnapshot) { failSnapshot = false; throw new Error('injected snapshot interruption'); }
    return { ok: true, payload: { snapshot: Object.fromEntries(Object.entries(payload.units ?? {}).map(([code, n]) => [code, { ...config.units[code], count: n }])) } };
  });
  for (const command of ['military.AdjustTroops', 'military.SetMarchingTroops', 'population.SetEnRoutePop', 'population.RecoverCasualties', 'treasure.StoreCarried', 'treasure.MarkPendingArrived']) {
    commands.register(command, () => ({ ok: true, payload: {} }));
  }
  commands.register('treasure.LoseCarried', ({ payload }: any) => { losses.push(payload); return { ok: true, payload: {} }; });
  commands.register('economy.Grant', ({ payload }: any) => { grants.push(payload); return { ok: true, payload: {} }; });
  bus.on('movement.CaravanRaidReport', (event) => { reports.push(event.payload); });
  const movement = new MovementModule(store, bus, commands, scheduler, () => now, config); movement.init();
  return { store, movement, bus, commands, config, scheduler, grants, reports, losses, clock: () => now,
    advance: (ms: number) => scheduler.advanceTo(now + ms, (value) => { now = value; }),
    failSnapshot: () => { failSnapshot = true; }, failReturn: () => { failReturn = true; },
  };
}

function seed(store: CheckpointStore, battle = false, cargo = 100) {
  const base = { fromVillage: 'a', fromXY: { q: 0, r: 0 }, originalFromXY: { q: 0, r: 0 }, toXY: { q: 8, r: 0 },
    pos: { q: 1, r: 0 }, troops: {}, departAt: 999_000, launchedAt: 999_000, arriveAt: 1_007_000,
    nextStepAt: 1_001_000, perStepMs: 1000, stepIndex: 1, stepToken: 1, status: 'paused' };
  store.set('movement', 'car', { ...base, id: 'car', type: 'caravan', targetVillage: 'b', homeVillage: 'a', routesFreed: 1,
    path: Array.from({ length: 9 }, (_, q) => ({ q, r: 0 })), caravanTiming: Array(8).fill(1000), caravanPausedRemainingMs: 1000,
    cargo: { wood: cargo }, ...(battle ? { caravanBattleId: 'battle-1' } : {}) });
  store.set('movement', 'raid', { ...base, id: 'raid', type: 'caravan_raid', fromVillage: 'r', targetMovementId: 'car',
    troops: { legionnaire: 3 }, path: [{ q: 0, r: 0 }, { q: 1, r: 0 }], caravanTiming: [500], perStepMs: 500,
    caravanMission: { flatMs: 500, hillsMs: 750 } });
  if (battle) store.set('movement', 'escort', { ...base, id: 'escort', type: 'caravan_escort', fromVillage: 'e', targetMovementId: 'car',
    troops: { legionnaire: 4 }, path: [{ q: 0, r: 0 }, { q: 1, r: 0 }], caravanTiming: [500], perStepMs: 500,
    caravanMission: { attached: true, flatMs: 500, hillsMs: 750 } });
}

function battleEvent(survivingDefenders = 2): DomainEvent {
  return { name: 'combat.CaravanBattleEnded', source: 'combat', ts: 1_000_000, payload: {
    caravanId: 'car', battleId: 'battle-1', attackerWins: true,
    attackers: [{ movementId: 'raid', survivors: { legionnaire: 2 }, carryCapacity: 20 }],
    defenders: [{ movementId: 'escort', survivors: survivingDefenders ? { legionnaire: survivingDefenders } : {} }],
  } };
}

function granted(f: ReturnType<typeof fixture>, village: string): number {
  return f.grants.filter((g) => g.villageId === village).reduce((sum, g) => sum + (g.gain.wood ?? 0), 0);
}

test('分货每个 WAL 边界重启：cargo/loot 绝对恢复，不重复搬货或遗漏返程', async () => {
  for (const cargo of [20, 100]) {
    const f = fixture(); seed(f.store, false, cargo); f.store.recording = true;
    await (f.movement as any).lootCaravan(f.store.get('movement', 'raid'), f.store.get('movement', 'car'), true);
    assert.ok(f.store.checkpoints.length > 5);
    for (const state of f.store.checkpoints) {
      const r = fixture(CheckpointStore.restore(state)); r.movement.resume(); await r.advance(20_000);
      assert.equal(granted(r, 'r'), Math.min(30, cargo)); assert.equal(granted(r, 'b'), Math.max(0, cargo - 30));
      assert.equal(r.store.get('movement', 'raid'), undefined);
    }
  }
});

test('cargo 已写而 loot 保存中断：在线重试完成计划，资源总量不变', async () => {
  const f = fixture(); seed(f.store);
  f.store.failNext = (id, value) => id === 'raid' && value.loot?.wood === 30;
  await (f.movement as any).lootCaravan(f.store.get('movement', 'raid'), f.store.get('movement', 'car'), true);
  assert.equal(f.store.get<any>('movement', 'car').cargo.wood, 70);
  assert.ok(f.store.get<any>('movement', 'car').caravanSettlement);
  assert.equal(f.store.get<any>('movement', 'raid').loot, undefined);
  await f.advance(20_000);
  assert.equal(granted(f, 'r'), 30); assert.equal(granted(f, 'b'), 70);
});

test('计划查询 await 中断：请求已经持久化，重启恢复，不让商队交付原货物', async () => {
  const f = fixture(); seed(f.store); f.failSnapshot();
  await (f.movement as any).lootCaravan(f.store.get('movement', 'raid'), f.store.get('movement', 'car'), true);
  assert.equal(f.store.get<any>('movement', 'car').status, 'paused');
  assert.equal(f.store.get<any>('movement', 'car').caravanSettlement.plan, undefined);
  const r = fixture(CheckpointStore.restore(f.store.snapshot())); r.movement.resume(); await r.advance(20_000);
  assert.equal(granted(r, 'r'), 30); assert.equal(granted(r, 'b'), 70);
});

test('商队战每个 WAL 边界重启：事件无需重新发送，幸存护送军恢复且结果最后确认', async () => {
  const f = fixture(); seed(f.store, true); f.store.recording = true;
  await f.bus.emit(battleEvent());
  assert.equal(f.store.get<any>('movement', 'car').caravanResolvedBattleId, 'battle-1');
  assert.ok(f.reports.some((report) => report.villageId === 'e' && report.loot.wood === 20 && report.remaining.wood === 80));
  for (const state of f.store.checkpoints) {
    const r = fixture(CheckpointStore.restore(state)); r.movement.resume(); await r.advance(1);
    const car = r.store.get<any>('movement', 'car');
    assert.equal(car.caravanResolvedBattleId, 'battle-1');
    assert.equal(car.caravanBattleResult, undefined); assert.equal(car.caravanSettlement, undefined);
    assert.equal(r.store.get<any>('movement', 'escort').status, 'marching');
    assert.deepEqual(r.store.get<any>('movement', 'escort').troops, { legionnaire: 2 });
    await r.bus.emit(battleEvent()); await r.advance(20_000);
    assert.equal(granted(r, 'r'), 20); assert.equal(granted(r, 'b'), 80);
  }
});

test('返程计算 await 失败后重启：不重新杀伤、重复分货；护卫全灭仍收到货物摘要', async () => {
  const f = fixture(); seed(f.store, true); f.failReturn();
  await f.bus.emit(battleEvent(0));
  assert.ok(f.store.get<any>('movement', 'car').caravanBattleResult);
  assert.equal(f.store.get<any>('movement', 'car').caravanResolvedBattleId, undefined);
  assert.equal(f.store.get('movement', 'escort'), undefined);
  assert.ok(f.reports.some((report) => report.villageId === 'e'));
  const r = fixture(CheckpointStore.restore(f.store.snapshot())); r.movement.resume(); await r.advance(20_000);
  assert.equal(granted(r, 'r'), 20); assert.equal(granted(r, 'b'), 80);
  assert.equal(r.store.get('movement', 'escort'), undefined); assert.equal(r.store.get('movement', 'raid'), undefined);
});

test('返程军已回家但商队 journal 尚未清除：重放不得复活军队或再发一次 loot', async () => {
  const f = fixture(); seed(f.store); f.store.recording = true;
  await (f.movement as any).lootCaravan(f.store.get('movement', 'raid'), f.store.get('movement', 'car'), true);
  const snapshot = f.store.checkpoints.find((state) => {
    const rows = new Map(state.find(([collection]) => collection === 'movement')![1]);
    return (rows.get('raid') as any)?.type === 'return' && (rows.get('car') as any)?.caravanSettlement;
  })!;
  assert.ok(snapshot);
  const store = CheckpointStore.restore(snapshot); store.delete('movement', 'raid');
  const r = fixture(store); r.movement.resume(); await r.advance(20_000);
  assert.equal(granted(r, 'r'), 0); assert.equal(granted(r, 'b'), 70);
  assert.equal(r.store.get('movement', 'raid'), undefined);
});

test('首次结果 journal 落盘失败：combat 不确认已发送，重启继续交付结果', async () => {
  const f = fixture(); seed(f.store, true);
  const combat = new CombatModule(f.store, f.bus, f.commands, f.scheduler, f.clock, f.config); combat.init();
  const engaged = await f.commands.send({ name: 'combat.Engage', from: 'test', payload: {
    targetKind: 'field', targetId: 'caravan:car', caravanId: 'car', battleType: 'raid', targetXY: { q: 1, r: 0 },
    movementId: 'raid', fromVillage: 'r', fromXY: { q: 0, r: 0 }, troops: { legionnaire: 3 },
    attackerSnapshot: { legionnaire: { count: 3, attack: 10000, defense: 10000, hp: 10000, carry: 10 } },
    defendersField: [{ movementId: 'escort', fromVillage: 'e', fromXY: { q: 0, r: 0 }, troops: { legionnaire: 4 },
      attackerSnapshot: { legionnaire: { count: 4, attack: 1, defense: 1, hp: 1, carry: 10 } } }],
  } });
  assert.equal(engaged.ok, true);
  const car = f.store.get<any>('movement', 'car'); car.caravanBattleId = (engaged.payload as any).battleId; f.store.set('movement', car.id, car);
  f.store.failNext = (id, value) => id === 'car' && !!value.caravanBattleResult;
  await f.advance(5);
  assert.equal(f.store.get<any>('movement', 'car').caravanBattleResult, undefined);
  assert.equal(f.store.all<any>('battle')[0]?.status, 'resolving');
  assert.notEqual(f.store.all<any>('battle')[0]?.resolution?.caravanResultEmitted, true);
  const r = fixture(CheckpointStore.restore(f.store.snapshot()), f.clock());
  const resumed = new CombatModule(r.store, r.bus, r.commands, r.scheduler, r.clock, r.config); resumed.init();
  r.movement.resume(); resumed.resume(); await r.advance(20_000);
  assert.equal(r.store.all('battle').length, 0);
  assert.equal(granted(r, 'r'), 30); assert.equal(granted(r, 'b'), 70);
});
