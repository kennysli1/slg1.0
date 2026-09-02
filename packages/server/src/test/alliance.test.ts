import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

function addAllianceHall(app: ReturnType<typeof createGameApp>, villageId: string): void {
  const building = app.store.get<any>('building', villageId)!;
  building.placed.push({ slotId: 'inner-alliance-test', zone: 'inner', kind: 'alliance_hall', level: 1 });
  app.store.set('building', villageId, building);
  const economy = app.store.get<any>('economy', villageId)!;
  economy.resources = { ...economy.resources, wood: 2000, clay: 2000, iron: 2000, crop: 2000, gold: 2000 };
  app.store.set('economy', villageId, economy);
}

function addTradeCenter(app: ReturnType<typeof createGameApp>, villageId: string): void {
  const building = app.store.get<any>('building', villageId)!;
  building.placed.push({ slotId: 'outer-trade-test', zone: 'outer', kind: 'tradecenter', level: 1 });
  app.store.set('building', villageId, building);
  app.store.set('trade', villageId, {
    villageId, level: 1, npcOrderPool: [], storedRefreshes: 0, nextRefreshAt: Date.now() + 3_600_000,
    tradeRoutesUsed: 0, createdOrders: [], npcDeliveryOrders: [],
  });
}

test('联盟：建造大厅后可创建、申请加入并建立盟友关系', async () => {
  const app = createGameApp({ manualScheduler: true });
  const leader = (await send(app, 'player.Register', { name: '联盟盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  const member = (await send(app, 'player.Register', { name: '联盟成员', password: 'pass1', tribe: 'gauls' })).payload as any;
  addAllianceHall(app, leader.player.villageId);

  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '测试联盟' });
  assert.equal(created.ok, true, created.reason);
  const applied = await send(app, 'alliance.Apply', { playerId: member.player.id, allianceId: (created.payload as any).allianceId });
  assert.equal(applied.ok, true, applied.reason);
  const reviewed = await send(app, 'alliance.ReviewRequest', { playerId: leader.player.id, applicantId: member.player.id, approve: true });
  assert.equal(reviewed.ok, true, reviewed.reason);
  const relation = await send(app, 'alliance.GetRelation', { playerId: leader.player.id, targetPlayerId: member.player.id });
  assert.equal((relation.payload as any).relation, 'allied');
  const assigned = await send(app, 'alliance.SetRole', { playerId: leader.player.id, targetPlayerId: leader.player.id, role: 'logistics' });
  assert.equal(assigned.ok, true, assigned.reason);
  const snapshot = await send(app, 'alliance.Get', { playerId: leader.player.id });
  assert.equal((snapshot.payload as any).alliance.members.length, 2);
  assert.deepEqual((snapshot.payload as any).alliance.roles[leader.player.id], ['logistics']);
});

test('联盟：同盟玩家不能发起侦察或攻击，但允许增援选项', async () => {
  const app = createGameApp({ manualScheduler: true });
  const a = (await send(app, 'player.Register', { name: '盟友甲', password: 'pass1', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '盟友乙', password: 'pass1', tribe: 'romans' })).payload as any;
  app.store.set('alliance', 'ally-test', { id: 'ally-test', name: '盟友', leaderId: a.player.id, leaderName: a.player.name, memberIds: [a.player.id, b.player.id], roles: { [a.player.id]: [], [b.player.id]: [] }, hallVillageId: a.player.villageId, level: 1, disconnected: false, joinRequests: {}, warehouse: { wood: 0, clay: 0, iron: 0, crop: 0 }, resourceContributions: {}, techPointStock: 0, techContributions: {}, buildings: {}, technologies: {}, warPlans: {} });
  app.store.set('alliance_by_player', a.player.id, 'ally-test');
  app.store.set('alliance_by_player', b.player.id, 'ally-test');
  const options = await send(app, 'movement.GetMarchOptions', { villageId: a.player.villageId, kind: 'village', refId: b.player.villageId, q: b.player.q, r: b.player.r });
  assert.deepEqual((options.payload as any).modes.map((m: any) => m.mode), ['reinforce']);
});

test('联盟：大厅修复完成后通过 Repaired 事件自动重连', async () => {
  const app = createGameApp({ manualScheduler: true });
  const leader = (await send(app, 'player.Register', { name: '重连盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '重连测试联盟' });
  assert.equal(created.ok, true, created.reason);
  const allianceId = (created.payload as any).allianceId as string;

  const alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.disconnected = true;
  alliance.roles[leader.player.id] = [];
  alliance.buildings = { alliance_warehouse: 2 };
  app.store.set('alliance', allianceId, alliance);
  const building = app.store.get<any>('building', leader.player.villageId)!;
  const hall = building.placed.find((p: any) => p.kind === 'alliance_hall');
  hall.level = 1;
  hall.repairTargetLevel = 1;
  app.store.set('building', leader.player.villageId, building);

  await app.bus.emit({ name: 'building.Repaired', source: 'test', ts: 0, payload: { villageId: leader.player.villageId, kind: 'alliance_hall', level: 1 } } as any);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = await send(app, 'alliance.Get', { playerId: leader.player.id });
  assert.equal((snapshot.payload as any).alliance.disconnected, false);
  assert.equal((snapshot.payload as any).alliance.level, 1);
  assert.equal((snapshot.payload as any).alliance.buildings.alliance_warehouse, 2, '已建建筑目录应保留，供成员按等级重新修复');
});

test('联盟：受损大厅空壳仍出现在建造清单中供盟主重建', async () => {
  const app = createGameApp({ manualScheduler: true });
  const leader = (await send(app, 'player.Register', { name: '重建入口盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  const building = app.store.get<any>('building', leader.player.villageId)!;
  const hall = building.placed.find((p: any) => p.kind === 'alliance_hall');
  hall.level = 0;
  hall.repairTargetLevel = 1;
  app.store.set('building', leader.player.villageId, building);
  const options = await send(app, 'building.GetBuildOptions', { villageId: leader.player.villageId, zone: 'inner' });
  const allianceHall = (options.payload as any).options.find((x: any) => x.kind === 'alliance_hall');
  assert.ok(allianceHall, '受损大厅应保留重建入口');
  assert.equal(allianceHall.builtCount, 0);
});

test('联盟资源贡献：必须有贸易中心、空闲路线和足够资源，且抵达大厅后才入库', async () => {
  let clock = 1_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  const leader = (await send(app, 'player.Register', { name: '运输盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  const villageId = leader.player.villageId as string;
  addAllianceHall(app, villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: villageId, name: '运输测试联盟' });
  assert.equal(created.ok, true, created.reason);
  // 没有贸易中心时明确拒绝，且不会从村庄扣资源。
  const noCenter = await send(app, 'alliance.DepositResources', { playerId: leader.player.id, sourceVillageId: villageId, amount: { wood: 100 } });
  assert.equal(noCenter.ok, false);
  assert.equal(noCenter.reason, 'no_center');

  addTradeCenter(app, villageId);
  const allianceId = (created.payload as any).allianceId as string;
  const alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.researchingBuilding = { code: 'alliance_warehouse', targetLevel: 1, required: { wood: 99999, clay: 0, iron: 0, crop: 0 } };
  app.store.set('alliance', allianceId, alliance);
  // 两条路线均占用时拒绝。
  const trade = app.store.get<any>('trade', villageId)!;
  trade.tradeRoutesUsed = 2;
  app.store.set('trade', villageId, trade);
  const noRoutes = await send(app, 'alliance.DepositResources', { playerId: leader.player.id, sourceVillageId: villageId, amount: { wood: 100 } });
  assert.equal(noRoutes.ok, false);
  assert.equal(noRoutes.reason, 'insufficient_routes');
  trade.tradeRoutesUsed = 0;
  app.store.set('trade', villageId, trade);

  // 资源不足时同样在发车前拒绝，不产生待运输记录。
  const economy = app.store.get<any>('economy', villageId)!;
  economy.resources = { ...economy.resources, wood: 50 };
  app.store.set('economy', villageId, economy);
  const noResources = await send(app, 'alliance.DepositResources', { playerId: leader.player.id, sourceVillageId: villageId, amount: { wood: 100 } });
  assert.equal(noResources.ok, false);
  assert.match(String(noResources.reason), /^insufficient/);
  economy.resources = { ...economy.resources, wood: 1000 };
  app.store.set('economy', villageId, economy);
  const before = (await send(app, 'economy.GetResources', { villageId })).payload as any;

  const sent = await send(app, 'alliance.DepositResources', { playerId: leader.player.id, sourceVillageId: villageId, amount: { wood: 100 } });
  assert.equal(sent.ok, true, sent.reason);
  const afterSend = (await send(app, 'alliance.Get', { playerId: leader.player.id })).payload as any;
  assert.equal(afterSend.alliance.warehouse.wood, 0, '商队抵达前联盟仓库不能瞬间增加');
  assert.equal(afterSend.alliance.pendingResourceDeliveries.length, 1);
  const afterSpend = (await send(app, 'economy.GetResources', { villageId })).payload as any;
  assert.equal(afterSpend.resources.wood, before.resources.wood - 100, '发车时应锁定来源村资源');

  await app.scheduler.advanceTo((sent.payload as any).arriveAt + 1, (t) => { clock = t; });
  const afterArrival = (await send(app, 'alliance.Get', { playerId: leader.player.id })).payload as any;
  assert.equal(afterArrival.alliance.warehouse.wood, 100, '商队抵达大厅后才入库');
  assert.equal(afterArrival.alliance.pendingResourceDeliveries.length, 0);
  assert.equal(afterArrival.alliance.resourceContributions[leader.player.id].wood, 100);
});
