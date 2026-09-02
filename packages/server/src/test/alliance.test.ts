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
  assert.deepEqual((snapshot.payload as any).alliance.roleCatalog.map((r: any) => r.code), ['logistics', 'war', 'tech', 'ambassador']);
  assert.equal((snapshot.payload as any).alliance.roleCatalog.find((r: any) => r.code === 'war').requiredAllianceLevel, 3);
  assert.match((snapshot.payload as any).alliance.roleCatalog.find((r: any) => r.code === 'logistics').effect, /资源产量/);
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

test('联盟项目：规划可更改，资源/科技点满足后进入可配置计时并按时完成', async () => {
  let clock = 2_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  const leader = (await send(app, 'player.Register', { name: '项目盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '项目测试联盟' });
  assert.equal(created.ok, true, created.reason);
  const allianceId = (created.payload as any).allianceId as string;
  let alliance = app.store.get<any>('alliance', allianceId)!;

  alliance.warehouse = { wood: 2000, clay: 2000, iron: 2000, crop: 2000 };
  app.store.set('alliance', allianceId, alliance);
  const startedBuilding = await send(app, 'alliance.StartBuilding', { playerId: leader.player.id, code: 'alliance_warehouse' });
  assert.equal(startedBuilding.ok, true, startedBuilding.reason);
  const buildingPlan = app.store.get<any>('alliance', allianceId)!.researchingBuilding;
  assert.equal(buildingPlan.state, 'in_progress');
  assert.equal(buildingPlan.completeAt - buildingPlan.startedAt, 10_000, '默认联盟项目耗时应为10秒');
  assert.equal(app.store.get<any>('alliance', allianceId)!.buildings.alliance_warehouse ?? 0, 0, '开工不应瞬间完成');
  await app.scheduler.advanceTo(buildingPlan.completeAt - 1, (t) => { clock = t; });
  assert.equal(app.store.get<any>('alliance', allianceId)!.buildings.alliance_warehouse ?? 0, 0);
  await app.scheduler.advanceTo(buildingPlan.completeAt + 1, (t) => { clock = t; });
  assert.equal(app.store.get<any>('alliance', allianceId)!.buildings.alliance_warehouse, 1);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingBuilding, null);

  // 未开工规划可以随时换项；换项后若仓库已满足则立即进入计时。
  alliance.level = 7;
  alliance.warehouse = { wood: 0, clay: 0, iron: 0, crop: 0 };
  app.store.set('alliance', allianceId, alliance);
  const planned = await send(app, 'alliance.StartBuilding', { playerId: leader.player.id, code: 'alliance_barracks' });
  assert.equal(planned.ok, true, planned.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingBuilding.code, 'alliance_barracks');
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingBuilding.state, 'planned');
  const changed = await send(app, 'alliance.StartBuilding', { playerId: leader.player.id, code: 'alliance_embassy' });
  assert.equal(changed.ok, true, changed.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingBuilding.code, 'alliance_embassy');
  alliance.warehouse = { wood: 3500, clay: 3500, iron: 3500, crop: 2500 };
  app.store.set('alliance', allianceId, alliance);
  const startedChanged = await send(app, 'alliance.StartBuilding', { playerId: leader.player.id, code: 'alliance_embassy' });
  assert.equal(startedChanged.ok, true, startedChanged.reason);
  const changedPlan = app.store.get<any>('alliance', allianceId)!.researchingBuilding;
  assert.equal(changedPlan.state, 'in_progress');
  assert.equal(changedPlan.completeAt - changedPlan.startedAt, 10_000);
  const blockedChange = await send(app, 'alliance.StartBuilding', { playerId: leader.player.id, code: 'alliance_barracks' });
  assert.equal(blockedChange.ok, false);
  assert.equal(blockedChange.reason, 'building_in_progress');
  await app.scheduler.advanceTo(changedPlan.completeAt + 1, (t) => { clock = t; });
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingBuilding, null);

  // 科技同样等待资源后自动开工，完成前不计入已研发等级。
  alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.researchingBuilding = null;
  alliance.techPointStock = 0;
  app.store.set('alliance', allianceId, alliance);
  const techPlan = await send(app, 'alliance.StartTech', { playerId: leader.player.id, code: 'shared_logistics' });
  assert.equal(techPlan.ok, true, techPlan.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingTech.state, 'planned');
  const techChanged = await send(app, 'alliance.StartTech', { playerId: leader.player.id, code: 'defensive_doctrine' });
  assert.equal(techChanged.ok, true, techChanged.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingTech.code, 'defensive_doctrine');
  alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.techPointStock = 150;
  app.store.set('alliance', allianceId, alliance);
  const techStarted = await send(app, 'alliance.StartTech', { playerId: leader.player.id, code: 'defensive_doctrine' });
  assert.equal(techStarted.ok, true, techStarted.reason);
  const techInProgress = app.store.get<any>('alliance', allianceId)!.researchingTech;
  assert.equal(techInProgress.state, 'in_progress');
  assert.equal(app.store.get<any>('alliance', allianceId)!.technologies.defensive_doctrine ?? 0, 0);
  await app.scheduler.advanceTo(techInProgress.completeAt + 1, (t) => { clock = t; });
  assert.equal(app.store.get<any>('alliance', allianceId)!.technologies.defensive_doctrine, 1);
  assert.equal(app.store.get<any>('alliance', allianceId)!.researchingTech, null);
});
