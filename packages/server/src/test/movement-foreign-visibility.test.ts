import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { wrapHex } from '../infra/hex.js';

/**
 * movement.ListForeign 可见性单元测试（白盒）。
 * 覆盖：视野内他国军队对外可见、不可见格不出现、不泄露 troops/loot/cargo/treasures、
 * 不含己方军队、且包含商队（caravan）。
 */

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

async function register(app: GameApp, name: string) {
  const r = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(r.ok, true, `注册 ${name} 应成功: ${r.reason ?? ''}`);
  return (r.payload as any).player as { id: string; name: string; q: number; r: number; villageId: string };
}

function setMovement(app: GameApp, mv: any) {
  app.store.set('movement', mv.id, mv);
}

test('ListForeign：视野内他国军队对外可见且脱敏，己方/不可见格不出现，含商队', async () => {
  const app = freshApp();
  const A = await register(app, '观察者A');
  const B = await register(app, '敌国B');
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;

  // 紧邻 A 城镇、必在 A 城市视野(半径4)内的格（注意环面归一，避免越界坐标）
  const vis = wrapHex({ q: A.q + 1, r: A.r }, W, H);
  // 远离 A 城镇、必在视野外的格
  const far = wrapHex({ q: A.q + 15, r: A.r + 15 }, W, H);

  // B 的驻扎军：停在 A 视野内可见格
  setMovement(app, {
    id: 'mv-B-vis', type: 'garrison', fromVillage: B.villageId,
    fromXY: { q: B.q, r: B.r }, toXY: vis,
    troops: { legionnaire: 10 }, loot: { wood: 5 }, cargo: { wood: 3 }, treasures: ['t1'],
    departAt: clock, arriveAt: clock + 100000,
    path: [vis, vis], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // B 的商队：停在 A 视野内可见格（验证商队也对外可见）
  setMovement(app, {
    id: 'mv-B-caravan', type: 'caravan', fromVillage: B.villageId,
    fromXY: { q: B.q, r: B.r }, toXY: vis,
    troops: {}, cargo: { wood: 99 }, loot: {}, treasures: [],
    homeVillage: B.villageId, returning: true,
    departAt: clock, arriveAt: clock + 200000,
    path: [vis, vis], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // B 的军队：停在 A 视野外
  setMovement(app, {
    id: 'mv-B-far', type: 'raid', fromVillage: B.villageId,
    fromXY: { q: B.q, r: B.r }, toXY: far,
    troops: { legionnaire: 30 }, loot: {}, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 300000,
    path: [far, far], stepIndex: 0, pos: far,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // 王国封地复仇军返程使用内部来源 ID，没有玩家村庄归属；即使在玩家视野内，
  // 也必须作为脱敏的“王国军队”出现在外军列表中。
  setMovement(app, {
    id: 'mv-kingdom-retaliation-return', type: 'return', npcService: true,
    kingdomMercenary: true, taskCode: 'kingdom_retaliation', returnPveId: 'kingdom-fief-sw',
    fromVillage: 'kingdom-fief:kingdom-fief-sw', fromXY: vis, toXY: { q: 0, r: 0 },
    troops: { merc_knight: 12 }, loot: { wood: 30 }, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 300000,
    path: [vis, { q: vis.q + 1, r: vis.r }], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // B 的主动侦察军：即使停在 A 的可见格，也不能通过地图外军列表发现
  setMovement(app, {
    id: 'mv-B-scout', type: 'scout', fromVillage: B.villageId, targetVillage: A.villageId,
    fromXY: { q: B.q, r: B.r }, toXY: vis,
    troops: { equlegati: 8 }, loot: {}, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 300000,
    path: [vis, vis], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // 主动侦察抵达/撤回后会被改写为 return，但仍必须保持地图隐身
  setMovement(app, {
    id: 'mv-B-scout-return', type: 'return', scoutReturn: true, fromVillage: B.villageId,
    fromXY: vis, toXY: { q: B.q, r: B.r },
    troops: { equlegati: 8 }, loot: {}, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 300000,
    path: [vis, vis], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });
  // A 自己的一支军队：停在 A 视野内（验证己方军队不被列入对外列表）
  setMovement(app, {
    id: 'mv-A-own', type: 'garrison', fromVillage: A.villageId,
    fromXY: { q: A.q, r: A.r }, toXY: vis,
    troops: { legionnaire: 5 }, loot: {}, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 50000,
    path: [vis, vis], stepIndex: 0, pos: vis,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'marching', stepToken: 1,
  });

  const res = await send(app, 'movement.ListForeign', { playerId: A.id });
  assert.equal(res.ok, true, `ListForeign 应成功: ${res.reason ?? ''}`);
  const list = (res.payload as any).movements as any[];
  const ids = list.map((m) => m.id);

  // 1) 视野内他国军队出现
  assert.ok(ids.includes('mv-B-vis'), '视野内他国驻扎军应出现');
  // 2) 含商队
  assert.ok(ids.includes('mv-B-caravan'), '视野内他国商队应出现');
  // 2b) 王国 NPC（含封地复仇军返程）也应出现在视野内
  assert.ok(ids.includes('mv-kingdom-retaliation-return'), '视野内王国复仇军返程应出现');
  // 3) 不可见格的他国军队不出现
  assert.ok(!ids.includes('mv-B-far'), '视野外他国军队不应出现');
  assert.ok(!ids.includes('mv-B-scout'), '他国侦察军不应出现在地图外军列表');
  assert.ok(!ids.includes('mv-B-scout-return'), '返程中的他国侦察军不应出现在地图外军列表');
  // 4) 己方军队不出现
  assert.ok(!ids.includes('mv-A-own'), '己方军队不应出现在对外列表');

  // 5) 脱敏：不得泄露 troops/loot/cargo/treasures；应带归属信息
  const foreign = list.find((m) => m.id === 'mv-B-vis')!;
  assert.equal(foreign.troops, undefined, '不得泄露 troops');
  assert.equal(foreign.loot, undefined, '不得泄露 loot');
  assert.equal(foreign.cargo, undefined, '不得泄露 cargo');
  assert.equal(foreign.treasures, undefined, '不得泄露 treasures');
  assert.equal(foreign.ownerPlayerId, B.id, '应带归属玩家 id');
  assert.equal(foreign.ownerPlayerName, B.name, '应带归属玩家名');
  assert.ok(foreign.ownerVillageName, '应带归属城镇名');
  assert.equal(foreign.type, 'garrison');
  assert.deepEqual(foreign.pos, vis, '应带当前位置');
  assert.equal(foreign.path, undefined, '不得泄露 path');
  assert.equal(foreign.to, undefined, '不得泄露 to');
  assert.equal(foreign.arriveAt, undefined, '不得泄露 arriveAt');
  assert.ok(foreign.heading === null || (typeof foreign.heading.q === 'number' && typeof foreign.heading.r === 'number'), '应带 heading 或 null');

  // 商队同样脱敏，且 type 应为 caravan
  const caravan = list.find((m) => m.id === 'mv-B-caravan')!;
  assert.equal(caravan.troops, undefined, '商队不得泄露 troops');
  assert.equal(caravan.cargo, undefined, '商队不得泄露 cargo');
  assert.equal(caravan.type, 'caravan', '商队 type 应为 caravan');
  assert.equal(caravan.ownerPlayerId, B.id, '商队应归属敌国 B');

  const kingdom = list.find((m) => m.id === 'mv-kingdom-retaliation-return')!;
  assert.equal(kingdom.ownerPlayerId, undefined, '王国 NPC 不应伪造玩家 id');
  assert.equal(kingdom.ownerPlayerName, '王国', '王国 NPC 应显示王国归属');
  assert.equal(kingdom.ownerVillageName, '封地复仇军', '复仇军应显示来源类型');
  assert.equal(kingdom.type, 'return', '复仇军战后应保持返程类型');
  assert.equal(kingdom.troops, undefined, '王国 NPC 返程不得泄露兵力');
});

test('王国复仇军战后返程保留 NPC 标识并在地图外军列表可见', async () => {
  const app = freshApp();
  const A = await register(app, '复仇军返程观察者');
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;
  const origin = wrapHex({ q: A.q + 3, r: A.r + 1 }, W, H);
  const target = { q: A.q, r: A.r };
  const movementId = 'mv-retaliation-attacking';
  setMovement(app, {
    id: movementId, type: 'attack', battleType: 'raid', npcService: true,
    kingdomMercenary: true, taskCode: 'kingdom_retaliation', returnPveId: 'kingdom-fief-sw',
    fromVillage: 'kingdom-fief:kingdom-fief-sw', targetVillage: A.villageId,
    fromXY: origin, originalFromXY: origin, toXY: target,
    troops: { merc_knight: 12 }, loot: {}, treasures: [],
    departAt: clock, arriveAt: clock + 100000,
    path: [origin, target], stepIndex: 1, pos: target,
    perStepMs: 1000, nextStepAt: clock + 1000, status: 'paused', stepToken: 1,
  });

  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: {
    side: 'attacker', targetKind: 'village', targetId: A.villageId,
    movementId, fromVillage: 'kingdom-fief:kingdom-fief-sw', fromXY: origin,
    toXY: target, originalFromXY: origin, survivors: { merc_knight: 10 }, loot: { wood: 20 },
    npcService: true, taskCode: 'kingdom_retaliation', kingdomMercenary: true,
    returnPveId: 'kingdom-fief-sw',
  } } as any);

  const returned = app.store.all<any>('movement').find((m) => m.kingdomMercenary && m.type === 'return');
  assert.ok(returned, '战斗胜利后应生成复仇军返程记录');
  assert.equal(returned.npcService, true, '返程必须保留 npcService');
  assert.equal(returned.taskCode, 'kingdom_retaliation', '返程必须保留复仇军 taskCode');
  assert.equal(returned.returnPveId, 'kingdom-fief-sw', '返程必须保留来源封地');

  const foreign = await send(app, 'movement.ListForeign', { playerId: A.id });
  assert.equal(foreign.ok, true, `ListForeign 应成功: ${foreign.reason ?? ''}`);
  const visible = (foreign.payload as any).movements.find((m: any) => m.id === returned.id);
  assert.ok(visible, '玩家视野内的复仇军返程应出现在地图外军列表');
  assert.equal(visible.ownerVillageName, '封地复仇军');
});
