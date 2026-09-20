import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import { MovementModule } from '../modules/movement.js';
import type { GameConfig } from '../infra/config.js';

/**
 * 远弦圣地不直接读取 movement 集合。本组覆盖其受控驻军验证和
 * 同 id 原路返乡：避免选错同玩家驻军，也避免取宝后生成新 id 令圣物丢链。
 */

let clock = 12_000_000;

function freshApp(): GameApp {
  clock = 12_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

const setClock = (next: number) => { clock = next; };
const send = (app: GameApp, name: string, payload: Record<string, unknown>, from = 'test') =>
  app.commands.send({ name, from, payload });

async function register(app: GameApp, name: string) {
  const result = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(result.ok, true, result.reason);
  return (result.payload as any).player as { id: string; villageId: string; q: number; r: number };
}

async function stationAtEmptyTile(app: GameApp, player: { id: string; villageId: string; q: number; r: number }) {
  const target = { q: player.q + 9, r: player.r + 7 };
  await send(app, 'military.AdjustTroops', { villageId: player.villageId, delta: { legionnaire: 10 } });
  await send(app, 'vision.Reveal', { playerId: player.id, ...target, radius: 0 });
  const sent = await send(app, 'movement.SendGarrison', { villageId: player.villageId, ...target, troops: { legionnaire: 10 } });
  assert.equal(sent.ok, true, `驻军派遣失败: ${sent.reason ?? ''}`);
  const movementId = (sent.payload as any).id as string;
  for (let i = 0; i < 100; i++) {
    const current = app.store.get<any>('movement', movementId);
    if (current?.status === 'stationed') return current;
    assert.ok(current, '驻军不应在抵达前消失');
    await app.scheduler.advanceTo(clock + current.perStepMs + 1, setClock);
  }
  assert.fail('驻军未在预期时间内抵达');
}

test('圣地行军接口：只接受同玩家同格驻军，省略 movementId 仅在唯一匹配时解析', async () => {
  const app = freshApp();
  const player = await register(app, '圣地驻军校验');
  const stationed = await stationAtEmptyTile(app, player);

  const blocked = await send(app, 'movement.ValidateSanctumPresence', {
    playerId: player.id, villageId: player.villageId, movementId: stationed.id, q: stationed.pos.q, r: stationed.pos.r,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'sanctum_owner_required', '客户端不得直接验证圣地驻军');

  const found = await send(app, 'movement.ValidateSanctumPresence', {
    playerId: player.id, villageId: player.villageId, q: stationed.pos.q, r: stationed.pos.r,
  }, 'sanctum');
  assert.equal(found.ok, true, found.reason);
  assert.equal((found.payload as any).movementId, stationed.id, '省略 movementId 时应安全匹配唯一驻军');
  assert.equal((found.payload as any).troopCount, 10);

  const wrongCoordinate = await send(app, 'movement.ValidateSanctumPresence', {
    playerId: player.id, villageId: player.villageId, movementId: stationed.id, q: stationed.pos.q + 1, r: stationed.pos.r,
  }, 'sanctum');
  assert.equal(wrongCoordinate.ok, false);
  assert.equal(wrongCoordinate.reason, 'sanctum_coordinate_mismatch');

  const wrongHome = await send(app, 'movement.ValidateSanctumRelicCarrier', {
    playerId: player.id, villageId: player.villageId, movementId: stationed.id,
    returnVillageId: 'other-village', q: stationed.pos.q, r: stationed.pos.r,
  }, 'sanctum');
  assert.equal(wrongHome.ok, false);
  assert.equal(wrongHome.reason, 'sanctum_return_must_use_origin_village');
});

test('圣物取走：驻军保留同一 movement id 并严格沿已走路径返乡，返程事件含归属', async () => {
  const app = freshApp();
  const player = await register(app, '圣物返乡');
  const stationed = await stationAtEmptyTile(app, player);
  const originalPath = stationed.path.map((point: { q: number; r: number }) => ({ ...point }));
  const returned: any[] = [];
  app.bus.on('movement.Returned', (event) => { returned.push(event.payload); });

  await app.bus.emit({
    name: 'sanctum.RelicTaken', source: 'sanctum', ts: clock,
    payload: {
      playerId: player.id,
      villageId: player.villageId,
      movementId: stationed.id,
      returnVillageId: player.villageId,
      roundId: 'farstring-test',
    },
  } as any);

  const returning = app.store.get<any>('movement', stationed.id);
  assert.equal(returning?.type, 'return', '取宝后必须在同一条 movement 上切换为返程');
  assert.equal(returning?.sanctumRelic?.returnVillageId, player.villageId);
  assert.deepEqual(returning?.path, [...originalPath].reverse(), '返程必须反走已抵达驻军的原路线');
  assert.deepEqual(returning?.pos, originalPath[originalPath.length - 1], '返程从圣地现场起步，不应跳格');

  for (let i = 0; i < 150 && app.store.get<any>('movement', stationed.id); i++) {
    const current = app.store.get<any>('movement', stationed.id);
    await app.scheduler.advanceTo(clock + current.perStepMs + 1, setClock);
  }
  assert.equal(app.store.get<any>('movement', stationed.id), undefined, '返程抵达来源村后应移除行军记录');
  const arrival = returned.find((payload) => payload.movementId === stationed.id);
  assert.ok(arrival, '返程事件应携带 movementId，供 Sanctum 幂等结算');
  assert.equal(arrival.playerId, player.id);
  assert.equal(arrival.villageId, player.villageId);
  assert.equal(arrival.sanctumRelic, true);
});

test('圣地已清理的 PvE 格可驻扎，普通 PvE 仍强制停在前一格', async () => {
  const store = new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => 1, true);
  let allowed = false;
  let sanctumChecks = 0;
  commands.register('world.GetTile', () => ({ ok: true, payload: { tile: { kind: 'pve' } } }));
  commands.register('sanctum.CanGarrisonAt', (command) => {
    sanctumChecks += 1;
    assert.equal(command.from, 'movement');
    assert.deepEqual(command.payload, { q: 7, r: 8 });
    return { ok: true, payload: { passable: allowed } };
  });
  const movement = new MovementModule(
    store, bus, commands, scheduler, () => 1,
    { constants: { worldW: 41, worldH: 41 } } as GameConfig,
  );
  const record = {
    id: 'sanctum-garrison',
    toXY: { q: 7, r: 8 },
    path: [{ q: 6, r: 8 }, { q: 7, r: 8 }],
  };

  const blocked = await (movement as any).garrisonLanding(record);
  assert.deepEqual(blocked, { q: 6, r: 8 }, '未被 Sanctum 放行的普通 PvE 仍不可驻扎');
  allowed = true;
  const landed = await (movement as any).garrisonLanding(record);
  assert.deepEqual(landed, { q: 7, r: 8 }, '只有已清理且 Sanctum 明确放行的圣地格可驻扎');
  assert.equal(sanctumChecks, 2, '仅 PVE 目标向 Sanctum 查询一次放行状态');
});

test('圣地守军快照仅由 Sanctum 获取，残印清理同步移除所有在途副本', async () => {
  const store = new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => 1, true);
  const config = {
    constants: { worldW: 41, worldH: 41 },
    units: { legionnaire: { popCost: 1 } },
  } as unknown as GameConfig;
  commands.register('player.GetByVillage', (command) => {
    const villageId = String((command.payload as { villageId?: unknown }).villageId ?? '');
    return { ok: true, payload: { player: { id: villageId === 'v-b' ? 'player-b' : 'player-a' } } };
  });
  const enRouteUpdates: any[] = [];
  commands.register('population.SetEnRoutePop', (command) => { enRouteUpdates.push(command.payload); return { ok: true, payload: {} }; });
  commands.register('military.SetMarchingTroops', () => ({ ok: true, payload: {} }));
  commands.register('military.GetCombatSnapshot', (command) => {
    const units = (command.payload as { units?: Record<string, number> }).units ?? {};
    return {
      ok: true,
      payload: {
        snapshot: {
          legionnaire: {
            count: units.legionnaire ?? 0,
            attack: 12,
            defense: 8,
            hp: 100,
            carry: 20,
            popCost: 1,
            form: 'melee',
            role: 'infantry',
            traits: [],
          },
        },
      },
    };
  });
  const movement = new MovementModule(store, bus, commands, scheduler, () => 1, config);
  movement.init();
  store.set('movement', 'sanctum-defender', {
    id: 'sanctum-defender', type: 'garrison', fromVillage: 'v-a', fromXY: { q: 1, r: 1 }, toXY: { q: 7, r: 8 },
    originalFromXY: { q: 1, r: 1 }, troops: { legionnaire: 6 }, treasures: ['sanctum_fragment', 'ordinary_charm', 'sanctum_fragment'],
    departAt: 1, arriveAt: 2, path: [{ q: 1, r: 1 }, { q: 7, r: 8 }], stepIndex: 1, pos: { q: 7, r: 8 },
    perStepMs: 1, nextStepAt: 0, status: 'stationed', stepToken: 1, capturedTreasures: ['sanctum_fragment'],
  });
  store.set('movement', 'returning-token', {
    id: 'returning-token', type: 'return', fromVillage: 'v-b', fromXY: { q: 3, r: 3 }, toXY: { q: 2, r: 2 },
    troops: { legionnaire: 1 }, treasures: ['sanctum_fragment'], departAt: 1, arriveAt: 2,
    path: [{ q: 3, r: 3 }, { q: 2, r: 2 }], stepIndex: 0, pos: { q: 3, r: 3 }, perStepMs: 1, nextStepAt: 2, status: 'marching', stepToken: 1,
  });

  const blocked = await commands.send({ name: 'movement.GetSanctumDefenderSnapshot', from: 'test', payload: { movementId: 'sanctum-defender' } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'sanctum_owner_required');
  const snapshot = await commands.send({ name: 'movement.GetSanctumDefenderSnapshot', from: 'sanctum', payload: { movementId: 'sanctum-defender' } });
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.deepEqual(snapshot.payload, {
    movementId: 'sanctum-defender', villageId: 'v-a', playerId: 'player-a', pos: { q: 7, r: 8 },
    troops: { legionnaire: 6 }, treasures: ['sanctum_fragment', 'ordinary_charm', 'sanctum_fragment'], troopCount: 6, effectivePop: 6,
    snapshot: {
      legionnaire: {
        count: 6, attack: 12, defense: 8, hp: 100, carry: 20, popCost: 1,
        form: 'melee', role: 'infantry', traits: [],
      },
    },
  });
  const status = await commands.send({ name: 'movement.GetSanctumDefenderStatus', from: 'sanctum', payload: { movementId: 'sanctum-defender' } });
  assert.equal(status.ok, true);
  assert.equal((status.payload as any).stillStationed, true);

  const lossBlocked = await commands.send({ name: 'movement.ApplySanctumDefenderLosses', from: 'sanctum', payload: { movementId: 'sanctum-defender', losses: { legionnaire: 2 } } });
  assert.equal(lossBlocked.ok, false);
  assert.equal(lossBlocked.reason, 'combat_owner_required');
  const wounded = await commands.send({ name: 'movement.ApplySanctumDefenderLosses', from: 'combat', payload: { movementId: 'sanctum-defender', losses: { legionnaire: 2 } } });
  assert.deepEqual(wounded, { ok: true, payload: { villageId: 'v-a', playerId: 'player-a', destroyed: false, survivors: { legionnaire: 4 } } });
  assert.equal(enRouteUpdates.some((payload) => payload.villageId === 'v-a' && payload.popCostSum === 4), true, '驻军战损后必须刷新来源村在途人口');
  const reducedSnapshot = await commands.send({ name: 'movement.GetSanctumDefenderSnapshot', from: 'sanctum', payload: { movementId: 'sanctum-defender' } });
  assert.equal((reducedSnapshot.payload as any).snapshot.legionnaire.count, 4, '下一次快照必须使用幸存兵力');

  const consumeBlocked = await commands.send({ name: 'movement.ConsumeCarriedTreasure', from: 'test', payload: { code: 'sanctum_fragment' } });
  assert.equal(consumeBlocked.ok, false);
  assert.equal(consumeBlocked.reason, 'treasure_owner_required');
  const consumed = await commands.send({ name: 'movement.ConsumeCarriedTreasure', from: 'treasure', payload: { code: 'sanctum_fragment', playerId: 'player-a' } });
  assert.equal(consumed.ok, true, consumed.reason);
  assert.deepEqual(consumed.payload, { code: 'sanctum_fragment', removed: 2, movementIds: ['sanctum-defender'] });
  assert.deepEqual(store.get<any>('movement', 'sanctum-defender')?.treasures, ['ordinary_charm']);
  assert.deepEqual(store.get<any>('movement', 'returning-token')?.treasures, ['sanctum_fragment'], '按玩家清除不能影响其他玩家的在途副本');
  const otherVillage = await commands.send({ name: 'movement.ConsumeCarriedTreasure', from: 'treasure', payload: { code: 'sanctum_fragment', villageId: 'v-b' } });
  assert.deepEqual(otherVillage.payload, { code: 'sanctum_fragment', removed: 1, movementIds: ['returning-token'] });
  assert.equal(store.get<any>('movement', 'returning-token')?.treasures, undefined);
  assert.deepEqual(store.get<any>('movement', 'sanctum-defender')?.capturedTreasures, ['sanctum_fragment'], '战利品字段不属于随军栏，不能被活动凭证清理误删');
  const destroyed = await commands.send({ name: 'movement.ApplySanctumDefenderLosses', from: 'combat', payload: { movementId: 'sanctum-defender', losses: { legionnaire: 99 } } });
  assert.deepEqual(destroyed, { ok: true, payload: { villageId: 'v-a', playerId: 'player-a', destroyed: true, survivors: {} } });
  const gone = await commands.send({ name: 'movement.GetSanctumDefenderStatus', from: 'sanctum', payload: { movementId: 'sanctum-defender' } });
  assert.deepEqual(gone.payload, { movementId: 'sanctum-defender', exists: false, stillStationed: false });
});
