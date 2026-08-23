import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('外交与行军模式：默认中立、选项由关系决定、显式宣战才转敌对', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '外交甲', password: 'p1234' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '外交乙', password: 'p1234' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  const selfOpts = await send(app, 'movement.GetMarchOptions', { villageId: va, kind: 'village', refId: va, q: a.player.q, r: a.player.r });
  assert.deepEqual((selfOpts.payload as any).modes, [], '当前操作村不应显示转移或切换行为');
  const ownerA = (await send(app, 'player.GetByVillage', { villageId: va })).payload as any;
  const ownerB = (await send(app, 'player.GetByVillage', { villageId: vb })).payload as any;
  const rel = await send(app, 'diplomacy.GetRelation', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal((rel.payload as any).relation, 'neutral');
  const opts = await send(app, 'movement.GetMarchOptions', { villageId: va, kind: 'village', refId: vb, q: b.player.q, r: b.player.r });
  assert.deepEqual((opts.payload as any).modes.map((m: any) => m.mode), ['reinforce', 'scout', 'raid', 'attack']);
  const war = await send(app, 'diplomacy.DeclareWar', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal(war.ok, true);
  const hostile = await send(app, 'diplomacy.GetRelation', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal((hostile.payload as any).relation, 'hostile');
  const hostileOpts = await send(app, 'movement.GetMarchOptions', { villageId: va, kind: 'village', refId: vb, q: b.player.q, r: b.player.r });
  assert.deepEqual((hostileOpts.payload as any).modes.map((m: any) => m.mode), ['scout', 'raid', 'attack']);
});

test('PvE 营地可侦察：只返回资源与守军，建筑侦察在服务端降级为资源报告', async () => {
  let clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true }); app.setupWorld();
  const reg = (await send(app, 'player.Register', { name: 'PvE侦察甲', password: 'p1234' })).payload as any;
  const villageId = reg.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId, delta: { equlegati: 3 } });

  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  assert.equal(target.ok, true);
  const options = await send(app, 'movement.GetMarchOptions', {
    villageId, kind: 'pve', refId: 'pve-0', q: (target.payload as any).q, r: (target.payload as any).r,
  });
  assert.deepEqual((options.payload as any).modes.map((m: any) => m.mode), ['scout', 'raid']);

  const reports: any[] = [];
  app.bus.on('movement.ScoutReport', (event: any) => { reports.push(event.payload); });
  const scout = await send(app, 'movement.SendScout', {
    villageId, targetId: 'pve-0', troops: { equlegati: 3 }, scoutType: 'scout_buildings',
  });
  assert.equal(scout.ok, true, `PvE 侦察应成功: ${scout.reason ?? ''}`);
  const outbound = app.store.get<any>('movement', (scout.payload as any).id);
  assert.equal(outbound.targetId, 'pve-0');
  assert.equal(outbound.targetVillage, undefined);
  assert.equal(outbound.scoutType, 'scout_resources');

  let ticks = 0;
  while (!reports.length && app.scheduler.pending > 0 && ticks < 100) {
    clock += 3_600_000;
    await app.scheduler.advanceTo(clock, (next) => { clock = next; });
    ticks++;
  }
  const attackerReport = reports.find((report) => report.side === 'attacker');
  assert.ok(attackerReport, '幸存侦察兵应收到 PvE 报告');
  assert.equal(attackerReport.targetKind, 'pve');
  assert.ok(attackerReport.resources && Object.hasOwn(attackerReport.resources, 'wood'), 'PvE 报告应包含营地资源');
  assert.equal(attackerReport.buildings, undefined, 'PvE 报告不应包含建筑信息');
});

test('PvP 建筑侦察：城内外建筑报告同时包含守军快照', async () => {
  let clock = 7_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true }); app.setupWorld();
  const attacker = (await send(app, 'player.Register', { name: '建筑侦察甲', password: 'p1234' })).payload as any;
  const defender = (await send(app, 'player.Register', { name: '建筑侦察乙', password: 'p1234' })).payload as any;
  const villageId = attacker.player.villageId;
  const targetVillage = defender.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId, delta: { equlegati: 3 } });
  await send(app, 'military.AdjustTroops', { villageId: targetVillage, delta: { legionnaire: 4 } });
  const reports: any[] = [];
  app.bus.on('movement.ScoutReport', (event: any) => { reports.push(event.payload); });
  const scout = await send(app, 'movement.SendScout', {
    villageId,
    targetVillage,
    fromXY: { q: attacker.player.q, r: attacker.player.r },
    toXY: { q: defender.player.q, r: defender.player.r },
    troops: { equlegati: 3 },
    scoutType: 'scout_buildings',
  });
  assert.equal(scout.ok, true, `建筑侦察应成功: ${scout.reason ?? ''}`);
  let ticks = 0;
  while (!reports.some((report) => report.side === 'attacker') && app.scheduler.pending > 0 && ticks < 100) {
    clock += 3_600_000;
    await app.scheduler.advanceTo(clock, (next) => { clock = next; });
    ticks++;
  }
  const report = reports.find((candidate) => candidate.side === 'attacker');
  assert.ok(report, '幸存侦察兵应收到建筑报告');
  assert.equal(report.scoutType, 'scout_buildings');
  assert.ok(report.buildings?.center && report.buildings?.inner && report.buildings?.outer, '报告应包含城内外建筑');
  assert.equal(report.defenderTroops.legionnaire, 4, '建筑侦察报告应同时包含守军兵力');
});
