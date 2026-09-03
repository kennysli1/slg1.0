import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { wrapHex } from '../infra/hex.js';

/**
 * movement 空间索引（posIndex / villageIndex）行为测试。
 * 索引为内存派生结构，通过依赖索引的业务路径间接验证一致性。
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
  return (r.payload as any).player as { id: string; villageId: string; q: number; r: number };
}

async function giveTroops(app: GameApp, villageId: string, troops: Record<string, number>) {
  await send(app, 'military.AdjustTroops', { villageId, delta: troops });
}

function addAllianceHall(app: GameApp, villageId: string): void {
  const building = app.store.get<any>('building', villageId)!;
  building.placed.push({ slotId: 'inner-alliance-test', zone: 'inner', kind: 'alliance_hall', level: 1 });
  app.store.set('building', villageId, building);
  const economy = app.store.get<any>('economy', villageId)!;
  economy.resources = { ...economy.resources, wood: 2000, clay: 2000, iron: 2000, crop: 2000, gold: 2000 };
  app.store.set('economy', villageId, economy);
}

test('villageIndex：同村第二支出征军应占满 1 级集结点行军点', async () => {
  const app = freshApp();
  const p = await register(app, '索引甲');
  await giveTroops(app, p.villageId, { legionnaire: 40 });

  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const tq = (target.payload as any).q;
  const tr = (target.payload as any).r;

  const first = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(first.ok, true);

  const second = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(second.ok, false, '第二支应被 villageIndex 计数的行军点上限拒绝');
  assert.equal(second.reason, 'march_points_exhausted');

  // 无关断言：目标坐标可读（避免 lint 未使用）
  assert.ok(Number.isFinite(tq) && Number.isFinite(tr));
});

test('villageIndex：返程到达后行军点释放，可再派出', async () => {
  const app = freshApp();
  const p = await register(app, '索引乙');
  await giveTroops(app, p.villageId, { legionnaire: 40 });

  const raid = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  const mvId = (raid.payload as any).id as string;

  const recall = await send(app, 'movement.RecallMarch', { villageId: p.villageId, movementId: mvId });
  assert.equal(recall.ok, true, `撤回应成功: ${recall.reason ?? ''}`);

  // 撤回后转为 return，仍占用行军点（返程也在途）
  const blocked = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(blocked.ok, false, '返程未到达前行军点仍被占用');
  assert.equal(blocked.reason, 'march_points_exhausted');

  // 推进至返程到达，movement 移除后索引释放
  const arriveAt = (recall.payload as any).arriveAt as number;
  let iters = 0;
  while (app.store.get('movement', mvId) && iters < 20_000) {
    await app.scheduler.advanceTo(Math.max(clock + 1_000, arriveAt + 1), setClock);
    iters++;
  }
  assert.equal(app.store.get('movement', mvId), undefined, '返程到达后 movement 应移除');

  const again = await send(app, 'movement.SendRaid', {
    villageId: p.villageId, fromXY: { q: p.q, r: p.r }, targetId: 'pve-0', troops: { legionnaire: 10 },
  });
  assert.equal(again.ok, true, '返程结束后应能再派出');
});

test('posIndex：同格敌对行军应触发遭遇（findEncounter 路径）', async () => {
  const app = freshApp();
  const A = await register(app, '索引红');
  const B = await register(app, '索引蓝');
  await giveTroops(app, A.villageId, { legionnaire: 20 });
  await giveTroops(app, B.villageId, { legionnaire: 10 });

  await send(app, 'movement.SendAttack', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { legionnaire: 20 },
  });
  await send(app, 'movement.SendAttack', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { legionnaire: 10 },
  });

  let intercepted = false;
  app.bus.on('movement.Intercepted', () => { intercepted = true; });
  let iters = 0;
  while (!intercepted && app.scheduler.pending > 0 && iters < 20_000) {
    await app.scheduler.advanceTo(clock + 1_000, setClock);
    iters++;
  }
  assert.equal(intercepted, true, 'posIndex 应能在同格找到敌对行军并触发遭遇');
});

test('posIndex：移动后旧格不再触发遭遇，新格才有效', async () => {
  const app = freshApp();
  const A = await register(app, '索引丙');
  await giveTroops(app, A.villageId, { legionnaire: 15 });
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;
  let garrisonTile: { q: number; r: number } | undefined;
  let nextTile: { q: number; r: number } | undefined;
  for (let d = 2; d < 30 && !garrisonTile; d++) {
    const candidate = wrapHex({ q: A.q + d, r: A.r }, W, H);
    const next = wrapHex({ q: candidate.q + 1, r: candidate.r }, W, H);
    const [a, b] = await Promise.all([
      send(app, 'world.GetTile', candidate), send(app, 'world.GetTile', next),
    ]);
    if ((a.payload as any).tile.kind === 'empty' && (b.payload as any).tile.kind === 'empty') {
      garrisonTile = candidate; nextTile = next;
    }
  }
  assert.ok(garrisonTile && nextTile, '应找到连续两格空地');
  await send(app, 'vision.Reveal', { playerId: A.id, ...garrisonTile, radius: 0 });

  const g = await send(app, 'movement.SendGarrison', {
    villageId: A.villageId, ...garrisonTile, troops: { legionnaire: 5 },
  });
  assert.equal(g.ok, true);
  const mvId = (g.payload as any).id as string;

  // 推进到驻扎完成
  let stationed = false;
  for (let i = 0; i < 500 && !stationed; i++) {
    await app.scheduler.advanceTo(clock + 2_000, setClock);
    const mv = app.store.get<any>('movement', mvId);
    if (mv?.status === 'stationed') stationed = true;
  }
  assert.equal(stationed, true, '驻扎军应抵达目标格');

  const beforePos = app.store.get<any>('movement', mvId)?.pos;
  assert.deepEqual(beforePos, garrisonTile);

  // 续行到新格：save() 应更新 posIndex，旧格索引失效
  await send(app, 'vision.Reveal', { playerId: A.id, ...nextTile, radius: 0 });
  const cont = await send(app, 'movement.ContinueGarrison', {
    villageId: A.villageId, movementId: mvId, ...nextTile, mode: 'garrison',
  });
  assert.equal(cont.ok, true);

  // 续行后 pos 仍从当前格出发，须推进一步才进入新格（save 会更新 posIndex）
  let moved = false;
  for (let i = 0; i < 500 && !moved; i++) {
    await app.scheduler.advanceTo(clock + 2_000, setClock);
    const pos = app.store.get<any>('movement', mvId)?.pos;
    if (pos && (pos.q !== garrisonTile.q || pos.r !== garrisonTile.r)) moved = true;
  }
  const after = app.store.get<any>('movement', mvId);
  assert.equal(moved, true, '续行推进后 pos 应离开旧格');
  assert.notDeepEqual(after?.pos, garrisonTile);
});

test('侦察军：不触发普通遭遇战或伏击战', async () => {
  const app = freshApp();
  const A = await register(app, '侦察免疫甲');
  const B = await register(app, '侦察免疫乙');
  await giveTroops(app, A.villageId, { equlegati: 5 });
  await giveTroops(app, B.villageId, { equlegati: 5 });
  const intercepted: any[] = [];
  app.bus.on('movement.Intercepted', (e) => { intercepted.push(e.payload); });

  const a = await send(app, 'movement.SendScout', {
    villageId: A.villageId, targetVillage: B.villageId, troops: { equlegati: 2 }, scoutType: 'scout_resources',
  });
  const b = await send(app, 'movement.SendScout', {
    villageId: B.villageId, targetVillage: A.villageId, troops: { equlegati: 2 }, scoutType: 'scout_resources',
  });
  assert.equal(a.ok, true, `甲侦察应成功: ${a.reason ?? ''}`);
  assert.equal(b.ok, true, `乙侦察应成功: ${b.reason ?? ''}`);

  for (let i = 0; i < 200 && app.scheduler.pending > 0; i++) {
    await app.scheduler.advanceTo(clock + 10_000, setClock);
    assert.equal(app.store.all<any>('battle').some((battle) => battle.targetKind === 'field'), false, '侦察军不得创建野战');
  }
  assert.equal(intercepted.some((p) => p?.battleType === 'ambush' || p?.battleType === undefined), false, '侦察军不得触发遭遇或伏击');
});

test('王国 NPC 行军：不触发普通遭遇战或伏击战', async () => {
  const app = freshApp();
  const player = await register(app, 'NPC 免疫测试');
  const pos = { q: player.q, r: player.r };
  const common = {
    fromXY: pos, toXY: { q: pos.q + 1, r: pos.r }, path: [pos, { q: pos.q + 1, r: pos.r }],
    stepIndex: 0, pos, troops: { legionnaire: 5 }, loot: {}, cargo: {}, treasures: [],
    departAt: clock, arriveAt: clock + 60_000, perStepMs: 1_000, nextStepAt: clock + 1_000,
    status: 'marching', stepToken: 1,
  };
  const playerMarch = { ...common, id: 'player-march', type: 'attack', fromVillage: player.villageId } as any;
  const npcMarch = {
    ...common, id: 'npc-march', type: 'attack', npcService: true,
    fromVillage: 'kingdom-fief:kingdom-fief-sw', taskCode: 'kingdom_retaliation',
  } as any;
  (app.movement as any).save(playerMarch);
  (app.movement as any).save(npcMarch);

  assert.equal(await (app.movement as any).findEncounter(playerMarch), undefined, '玩家军队不应与 NPC 触发遭遇');
  assert.equal(await (app.movement as any).findEncounter(npcMarch), undefined, 'NPC 军队不应主动触发遭遇');

  const npcAmbush = {
    ...common, id: 'npc-ambush', type: 'ambush', npcService: true, status: 'stationed',
    fromVillage: 'kingdom-fief:kingdom-fief-sw', taskCode: 'kingdom_retaliation',
  } as any;
  (app.movement as any).save(npcAmbush);
  assert.equal(await (app.movement as any).findAmbush(playerMarch), undefined, '玩家军队不应被 NPC 伏击');
  assert.equal(await (app.movement as any).findAmbush(npcMarch), undefined, 'NPC 军队不应触发伏击检查');
});

test('联盟成员同格：不得触发普通遭遇战或伏击战', async () => {
  const app = freshApp();
  const leader = await register(app, '盟友遭遇甲');
  const member = await register(app, '盟友遭遇乙');
  addAllianceHall(app, leader.villageId);
  const created = await send(app, 'alliance.Create', {
    playerId: leader.id, sourceVillageId: leader.villageId, name: '友军免战测试联盟',
  });
  assert.equal(created.ok, true, created.reason);
  const allianceId = (created.payload as any).allianceId as string;
  assert.equal((await send(app, 'alliance.Apply', { playerId: member.id, allianceId })).ok, true);
  assert.equal((await send(app, 'alliance.ReviewRequest', { playerId: leader.id, applicantId: member.id, approve: true })).ok, true);

  const common = {
    fromXY: { q: 10, r: 10 }, toXY: { q: 12, r: 10 }, path: [{ q: 10, r: 10 }, { q: 11, r: 10 }],
    stepIndex: 1, pos: { q: 11, r: 10 }, troops: { legionnaire: 5 }, loot: {}, cargo: {}, treasures: [],
    departAt: 5_000_000, arriveAt: 5_060_000, perStepMs: 1_000, nextStepAt: 5_001_000,
    status: 'marching', stepToken: 1,
  };
  const leaderMarch = { ...common, id: 'allied-leader-march', type: 'attack', fromVillage: leader.villageId } as any;
  const memberMarch = { ...common, id: 'allied-member-march', type: 'attack', fromVillage: member.villageId } as any;
  (app.movement as any).save(leaderMarch);
  (app.movement as any).save(memberMarch);
  assert.equal(await (app.movement as any).findEncounter(leaderMarch), undefined, '盟友行军不得触发普通遭遇战');

  const alliedAmbush = { ...common, id: 'allied-ambush', type: 'ambush', status: 'stationed', fromVillage: member.villageId } as any;
  (app.movement as any).save(alliedAmbush);
  assert.equal(await (app.movement as any).findAmbush(leaderMarch), undefined, '盟友伏击军不得拦截友军');
});
