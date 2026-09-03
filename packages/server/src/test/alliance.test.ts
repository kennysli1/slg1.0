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
  assert.equal((snapshot.payload as any).alliance.roleCatalog.find((r: any) => r.code === 'war').requiredAllianceLevel, 2);
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

test('联盟：大厅摧毁清空项目与累计仓库，并让前往大厅的贡献商队原地返程', async () => {
  const app = createGameApp({ manualScheduler: true, now: () => 5_000_000 });
  const leader = (await send(app, 'player.Register', { name: '大厅失联盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  const villageId = leader.player.villageId as string;
  addAllianceHall(app, villageId);
  addTradeCenter(app, villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: villageId, name: '大厅摧毁测试联盟' });
  assert.equal(created.ok, true, created.reason);
  const allianceId = (created.payload as any).allianceId as string;
  const alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.buildings = { alliance_warehouse: 2 };
  alliance.technologies = { shared_logistics: 1 };
  alliance.warehouse = { wood: 900, clay: 800, iron: 700, crop: 600 };
  alliance.resourceContributions[leader.player.id] = { wood: 100, clay: 100, iron: 100, crop: 100 };
  app.store.set('alliance', allianceId, alliance);
  const sent = await send(app, 'alliance.DepositResources', { playerId: leader.player.id, sourceVillageId: villageId, amount: { wood: 100 } });
  assert.equal(sent.ok, true, sent.reason);
  const building = app.store.get<any>('building', villageId)!;
  building.placed.find((p: any) => p.kind === 'alliance_hall').level = 0;
  app.store.set('building', villageId, building);
  await app.bus.emit({ name: 'building.Demolished', source: 'test', ts: 0, payload: { villageId, kind: 'alliance_hall', level: 0 } } as any);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const disconnected = app.store.get<any>('alliance', allianceId)!;
  assert.equal(disconnected.disconnected, true);
  assert.deepEqual(disconnected.buildings, {});
  assert.deepEqual(disconnected.technologies, {});
  assert.deepEqual(disconnected.warehouse, { wood: 0, clay: 0, iron: 0, crop: 0 });
  assert.deepEqual(disconnected.resourceContributions, {});
  assert.deepEqual(disconnected.pendingResourceDeliveries, {});
  const outbound = app.store.get<any>('movement', (sent.payload as any).deliveryId);
  assert.equal(outbound?.returning, true, '大厅摧毁后贡献商队应从当前位置转为返程');
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

test('联盟战事：倒计时创建、逐兵种可用兵力与取消/全员撤回', async () => {
  let clock = 3_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  app.setupWorld();
  const leader = (await send(app, 'player.Register', { name: '战事盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  await send(app, 'military.AdjustTroops', { villageId: leader.player.villageId, delta: { legionnaire: 8, equlegati: 2 } });
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '战事测试联盟' });
  assert.equal(created.ok, true, created.reason);
  const allianceId = (created.payload as any).allianceId as string;
  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const planResult = await send(app, 'alliance.CreateWarPlan', { playerId: leader.player.id, mode: 'raid', targetKind: 'pve', targetId: 'pve-0', q: (target.payload as any).q, r: (target.payload as any).r, countdownSec: 3600 });
  assert.equal(planResult.ok, true, planResult.reason);
  const planId = (planResult.payload as any).plan.id as string;
  assert.equal((planResult.payload as any).plan.countdownSec, 3600);
  const snapshot = await send(app, 'alliance.Get', { playerId: leader.player.id });
  assert.equal((snapshot.payload as any).alliance.availableTroopsByVillage[leader.player.villageId].legionnaire, 8);
  assert.equal((snapshot.payload as any).alliance.availableTroopsByVillage[leader.player.villageId].equlegati, 2);

  const joined = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId, sourceVillageId: leader.player.villageId, troops: { legionnaire: 3, equlegati: 1 } });
  assert.equal(joined.ok, true, joined.reason);
  const joinedPlan = app.store.get<any>('alliance', allianceId)!.warPlans[planId];
  assert.equal(joinedPlan.participants[leader.player.id].status, 'joined');
  const joinedSnapshot = await send(app, 'alliance.Get', { playerId: leader.player.id });
  const listedPlan = (joinedSnapshot.payload as any).alliance.warPlans.find((plan: any) => plan.id === planId);
  assert.deepEqual(listedPlan.participants[leader.player.id].troops, { legionnaire: 3, equlegati: 1 }, '联盟战事快照应向成员显示每位参与者的派兵明细');
  const cancelled = await send(app, 'alliance.CancelWarPlan', { playerId: leader.player.id, planId });
  assert.equal(cancelled.ok, true, cancelled.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.warPlans[planId].status, 'cancelled');
  assert.equal(app.store.all<any>('movement').length, 0, '倒计时内取消不应派出军队');

  // 再建一个目标，推进到实际派出后验证 90 秒内的一键全员撤回。
  const plan2 = await send(app, 'alliance.CreateWarPlan', { playerId: leader.player.id, mode: 'raid', targetKind: 'pve', targetId: 'pve-0', q: (target.payload as any).q, r: (target.payload as any).r, countdownSec: 3600 });
  const plan2Id = (plan2.payload as any).plan.id as string;
  const joined2 = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId: plan2Id, sourceVillageId: leader.player.villageId, troops: { legionnaire: 2 } });
  assert.equal(joined2.ok, true, joined2.reason);
  const plan2State = app.store.get<any>('alliance', allianceId)!.warPlans[plan2Id];
  const dispatchAt = plan2State.deadlineAt - plan2State.participants[leader.player.id].travelSec * 1000;
  await app.scheduler.advanceTo(dispatchAt, (t) => { clock = t; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dispatched = app.store.get<any>('alliance', allianceId)!.warPlans[plan2Id].participants[leader.player.id];
  assert.equal(dispatched.status, 'dispatched');
  assert.ok(dispatched.movementId);
  const recalled = await send(app, 'alliance.RecallWarPlan', { playerId: leader.player.id, planId: plan2Id });
  assert.equal(recalled.ok, true, recalled.reason);
  assert.equal(app.store.get<any>('alliance', allianceId)!.warPlans[plan2Id].status, 'cancelled');
  assert.equal(app.store.get<any>('alliance', allianceId)!.warPlans[plan2Id].participants[leader.player.id].status, 'recalled');
});

test('联盟战事：报名预备队锁定兵力，成员可取消报名，报名截止后拒绝新成员', async () => {
  let clock = 6_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  app.setupWorld();
  const leader = (await send(app, 'player.Register', { name: '预备队盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  await send(app, 'military.AdjustTroops', { villageId: leader.player.villageId, delta: { legionnaire: 10 } });
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '预备队测试联盟' });
  const allianceId = (created.payload as any).allianceId as string;
  const target = await send(app, 'pve.GetTarget', { id: 'pve-0' });
  const planResult = await send(app, 'alliance.CreateWarPlan', { playerId: leader.player.id, mode: 'raid', targetKind: 'pve', targetId: 'pve-0', q: (target.payload as any).q, r: (target.payload as any).r, countdownSec: 3600, participationCountdownSec: 60 });
  assert.equal(planResult.ok, true, planResult.reason);
  const planId = (planResult.payload as any).plan.id as string;
  const joined = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId, sourceVillageId: leader.player.villageId, troops: { legionnaire: 6 } });
  assert.equal(joined.ok, true, joined.reason);
  const army = await send(app, 'military.GetArmy', { villageId: leader.player.villageId });
  assert.equal((army.payload as any).availableTroops.legionnaire, 4);
  assert.equal((army.payload as any).allianceReservedTroops.legionnaire, 6);
  const blocked = await send(app, 'military.AdjustTroops', { villageId: leader.player.villageId, delta: { legionnaire: -5 } });
  assert.equal(blocked.ok, false);
  const cancelled = await send(app, 'alliance.CancelWarParticipation', { playerId: leader.player.id, planId });
  assert.equal(cancelled.ok, true, cancelled.reason);
  const released = await send(app, 'military.GetArmy', { villageId: leader.player.villageId });
  assert.equal((released.payload as any).availableTroops.legionnaire, 10);
  const plan = app.store.get<any>('alliance', allianceId)!.warPlans[planId];
  clock = plan.createdAt + 1_000;
  const joinedAgain = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId, sourceVillageId: leader.player.villageId, troops: { legionnaire: 6 } });
  assert.equal(joinedAgain.ok, true, joinedAgain.reason);
  clock = plan.joinDeadlineAt + 1;
  const cancelledAfterCutoff = await send(app, 'alliance.CancelWarParticipation', { playerId: leader.player.id, planId });
  assert.equal(cancelledAfterCutoff.ok, true, cancelledAfterCutoff.reason);
  const releasedAfterCutoff = await send(app, 'military.GetArmy', { villageId: leader.player.villageId });
  assert.equal((releasedAfterCutoff.payload as any).availableTroops.legionnaire, 10);
  const late = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId, sourceVillageId: leader.player.villageId, troops: { legionnaire: 1 } });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'war_join_deadline_passed');

  const shortPlan = await send(app, 'alliance.CreateWarPlan', { playerId: leader.player.id, mode: 'raid', targetKind: 'pve', targetId: 'pve-0', q: (target.payload as any).q, r: (target.payload as any).r, countdownSec: 10, participationCountdownSec: 9 });
  assert.equal(shortPlan.ok, true, shortPlan.reason);
  const tooLong = await send(app, 'alliance.JoinWarPlan', { playerId: leader.player.id, planId: (shortPlan.payload as any).plan.id, sourceVillageId: leader.player.villageId, troops: { legionnaire: 1 } });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'war_travel_too_long');
});

test('联盟职位：四级按配置解锁，形象大使声望成为联盟声望并放大成员加成', async () => {
  const app = createGameApp({ manualScheduler: true });
  const leader = (await send(app, 'player.Register', { name: '声望大使', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '声望联盟' });
  const allianceId = (created.payload as any).allianceId as string;
  const hall = app.store.get<any>('building', leader.player.villageId)!;
  hall.placed.find((p: any) => p.kind === 'alliance_hall').level = 4;
  app.store.set('building', leader.player.villageId, hall);
  const alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.level = 4;
  alliance.roles[leader.player.id] = ['ambassador', 'logistics'];
  app.store.set('alliance', allianceId, alliance);
  await send(app, 'reputation.Adjust', { playerId: leader.player.id, delta: 20 });
  const snapshot = await send(app, 'alliance.Get', { playerId: leader.player.id });
  const view = (snapshot.payload as any).alliance;
  assert.equal(view.allianceReputation, 20);
  assert.equal(view.allianceModifierMultiplier, 1.2);
  assert.deepEqual(view.roleCatalog.map((r: any) => r.requiredAllianceLevel), [1, 2, 3, 4]);
  assert.ok(view.roleCatalog.find((r: any) => r.code === 'logistics').effect.includes('24%'));
});

test('联盟王国服务：只有形象大使可购买，资源抵达后入联盟仓库，增援抵达大厅', async () => {
  let clock = 4_000_000;
  const app = createGameApp({ manualScheduler: true, now: () => clock });
  const leader = (await send(app, 'player.Register', { name: '服务盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  addAllianceHall(app, leader.player.villageId);
  const created = await send(app, 'alliance.Create', { playerId: leader.player.id, sourceVillageId: leader.player.villageId, name: '服务联盟' });
  const allianceId = (created.payload as any).allianceId as string;
  const alliance = app.store.get<any>('alliance', allianceId)!;
  alliance.level = 4;
  alliance.roles[leader.player.id] = ['ambassador'];
  app.store.set('alliance', allianceId, alliance);
  const hall = app.store.get<any>('building', leader.player.villageId)!;
  hall.placed.find((p: any) => p.kind === 'alliance_hall').level = 4;
  app.store.set('building', leader.player.villageId, hall);
  await send(app, 'reputation.Adjust', { playerId: leader.player.id, delta: 30 });
  const bought = await send(app, 'alliance.BuyService', { playerId: leader.player.id, serviceCode: 'alliance_supplies_small' });
  assert.equal(bought.ok, true, bought.reason);
  const order = (bought.payload as any).order;
  assert.equal(order.status, 'pending');
  assert.equal(app.store.get<any>('alliance', allianceId)!.warehouse.wood, 0);
  await app.scheduler.advanceTo((bought.payload as any).movement.arriveAt + 1, (t) => { clock = t; });
  assert.equal(app.store.get<any>('alliance', allianceId)!.warehouse.wood, 1000);
  assert.equal(app.store.get<any>('alliance', allianceId)!.serviceOrders.find((x: any) => x.id === order.id).status, 'completed');
  const reinforcement = await send(app, 'alliance.BuyService', { playerId: leader.player.id, serviceCode: 'alliance_reinforcement_guard' });
  assert.equal(reinforcement.ok, true, reinforcement.reason);
  await app.scheduler.advanceTo((reinforcement.payload as any).movement.arriveAt + 1, (t) => { clock = t; });
  const stationed = app.store.all<any>('movement').find((m) => m.serviceOrderId === (reinforcement.payload as any).order.id);
  assert.equal(stationed?.status, 'stationed');
  const ordinary = (await send(app, 'player.Register', { name: '普通成员', password: 'pass1', tribe: 'gauls' })).payload as any;
  app.store.set('alliance_by_player', ordinary.player.id, allianceId);
  const denied = await send(app, 'alliance.BuyService', { playerId: ordinary.player.id, serviceCode: 'alliance_supplies_small' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'ambassador_required');
});
