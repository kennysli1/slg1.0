import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistanceWrapped } from '../infra/hex.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd = 'pass1') =>
  send(app, 'player.Register', { name, password: pwd, tribe: 'romans' });
const tick = () => new Promise((r) => setTimeout(r, 0));
const grant = (app: GameApp, vid: string, gain: Record<string, number>) =>
  send(app, 'economy.Grant', { villageId: vid, gain });
const spawnResidentCamp = (app: GameApp, id = 'camp-other') =>
  send(app, 'pve.Spawn', { id, type: 'rats', q: 30, r: 30, task: false, noRespawn: false });

const m1Fields = ['woodcutter', 'claypit', 'ironmine', 'cropland'];

test('任务营地选点：同一搜索范围内按稳定种子随机分散，不固定命中相邻格', async () => {
  const app = freshApp();
  const registered = await reg(app, '任务营地随机选点');
  assert.equal(registered.ok, true, `注册应成功: ${registered.reason ?? ''}`);
  const player = (registered.payload as any).player;
  const center = { q: player.q, r: player.r };
  const radius = 4;
  const picks = new Map<string, number>();
  for (let i = 0; i < 20; i++) {
    const result = await send(app, 'world.FindFreeTile', {
      centerQ: center.q, centerR: center.r, radius, salt: `taskcamp-test-${i}`,
    });
    assert.equal(result.ok, true, `范围内应能找到空地: ${result.reason ?? ''}`);
    const point = result.payload as { q: number; r: number };
    picks.set(`${point.q},${point.r}`, hexDistanceWrapped(center, point, app.config.constants.worldW, app.config.constants.worldH));
  }
  assert.ok(picks.size > 1, '不同任务营地种子不应总命中同一格');
  assert.ok([...picks.values()].some((distance) => distance > 1), '应有任务营地落在非紧邻村庄的范围内');
});

async function repairM1Fields(app: GameApp, villageId: string): Promise<void> {
  await grant(app, villageId, { wood: 99999, clay: 99999, iron: 99999, crop: 99999 });
  for (const kind of m1Fields) {
    const layout = (await send(app, 'building.GetLayout', { villageId })).payload as any;
    const field = layout.zones.outer.placed.find((item: any) => item.kind === kind);
    assert.ok(field, `应存在 ${kind} 资源田`);
    const repair = await send(app, 'building.Repair', { villageId, slotId: field.slotId });
    assert.equal(repair.ok, true, `${kind} 修复应成功: ${repair.reason ?? ''}`);
    await app.scheduler.advanceTo((repair.payload as any).finishAt, setClock);
  }
}

test('建村即自动解锁主线 m1（repair_buildings），不自动接随机', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试1');
  assert.equal(regRes.ok, true, `注册应成功: ${regRes.reason ?? ''}`);
  const va = (regRes.payload as any).player.villageId;
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  assert.equal(st.ok, true);
  const p = st.payload as any;
  const activeCodes = p.active.map((a: any) => a.code);
  assert.deepEqual(activeCodes.sort(), ['m1'], `开局应仅自动激活 m1，实际: ${activeCodes}`);
  assert.deepEqual(p.offered, [], '无酒馆时 offered 应为空');
  assert.deepEqual(p.completedMain, []);
});

test('M1 隐藏 success 兜底：没有仍需修复的1级资源田即可交付', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务隐藏条件');
  const va = (regRes.payload as any).player.villageId;
  const building = app.store.get<any>('building', va);
  assert.ok(building, '应存在建筑状态');
  for (const item of building.placed) {
    if (m1Fields.includes(item.kind)) {
      item.level = 1;
      delete item.repairTargetLevel;
    }
  }
  app.store.set('building', va, building);
  const state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const m1 = state.active.find((item: any) => item.code === 'm1');
  assert.equal(m1?.ready, true, '隐藏条件满足时 M1 应可直接领取');
  assert.equal(m1?.objective.kind, 'repair_buildings', '玩家仍只看到原有修复目标');
});

test('GM 可一次性重置所有玩家和村庄任务进度而保留其他存档', async () => {
  const app = freshApp();
  const a = (await reg(app, '任务重置甲')).payload as any;
  const b = (await reg(app, '任务重置乙')).payload as any;
  const villages = [a.player.villageId, b.player.villageId];
  for (const villageId of villages) {
    const state = app.store.get<any>('task', villageId)!;
    state.completedMain = ['m1'];
    state.active = { m2: { code: 'm2', type: 'main' } };
    state.offeredMain = ['m3'];
    app.store.set('task', villageId, state);
  }
  const orphan = await send(app, 'pve.Spawn', {
    id: 'taskcamp-orphan-reset', type: 'rats', q: 11, r: 11, task: true, ownerVillageId: villages[0],
  });
  assert.equal(orphan.ok, true, '应能建立用于回归的孤儿任务营地');
  const beforeEconomy = app.store.get<any>('economy', villages[0]);
  const reset = await send(app, 'task.GmResetAll', {});
  assert.equal(reset.ok, true);
  assert.equal((reset.payload as any).resetPlayers, 2);
  assert.equal((reset.payload as any).resetVillages, 2);
  assert.equal((reset.payload as any).clearedTaskCamps, 1, '重置应统计并清理 pve 目录中的任务营地');
  for (const villageId of villages) {
    const state = app.store.get<any>('task', villageId);
    assert.ok(state, '每个玩家村庄都应重新建立任务状态');
    assert.ok(state.active.m1, '重置后应重新激活 m1');
    assert.deepEqual(state.completedMain, []);
    assert.deepEqual(state.offeredMain, []);
  }
  const orphanAfter = await send(app, 'pve.GetTarget', { id: 'taskcamp-orphan-reset' });
  assert.equal(orphanAfter.ok, false, '与任务状态脱节的孤儿任务营地也必须被移除');
  assert.deepEqual(app.store.get<any>('economy', villages[0]), beforeEconomy, '任务重置不应修改资源存档');
});

test('修复四块资源田 m1 → 就绪 → 交付后提示手动接取 m2 并发放 GM 配置奖励', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试2');
  const va = (regRes.payload as any).player.villageId;
  await tick();

  await repairM1Fields(app, va);

  // 未交付：m1 仍 active 且就绪，未进 completedMain，m2 未解锁，无奖励
  const st0 = await send(app, 'task.GetState', { villageId: va });
  const p0 = st0.payload as any;
  const m1a = p0.active.find((a: any) => a.code === 'm1');
  assert.ok(m1a && m1a.ready === true, 'm1 应处于就绪可交付');
  assert.ok(!p0.completedMain.includes('m1'), '未交付 m1 不应在 completedMain');
  assert.ok(!p0.active.find((a: any) => a.code === 'm2'), '未交付 m2 不应解锁');

  // 交付 → 发放奖励 + 解锁下游
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 'm1' });
  assert.equal(dv.ok, true, `交付应成功: ${dv.reason ?? ''}`);
  const rewards = (dv.payload as any).rewards;
  assert.ok(rewards && rewards.resources, '交付应返回资源奖励');
  assert.deepEqual(rewards.resources, { wood: 100, clay: 100, iron: 100, crop: 100 }, '应发放 GM 配置的四种资源');

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.completedMain.includes('m1'), 'm1 应在 completedMain');
  const activeCodes = p.active.map((a: any) => a.code).sort();
  const offeredMainCodes = p.offeredMain.map((a: any) => a.code).sort();
  assert.ok(!activeCodes.includes('m2'), 'm2 解锁后不应自动激活');
  assert.ok(!activeCodes.includes('m3'), 'm3 解锁后不应自动激活');
  assert.deepEqual(offeredMainCodes, ['m2'], '当前 GM 主线关系应只提示 m2');
  // 资源可能因容量上限被截留；交付回执中的奖励对象才是本次配置实际结算值。
  assert.equal((rewards.resources as any).wood, 100, 'wood 应按 GM 配置发放 +100');
});

test('主线 m2 建造两栋城内建筑；m5 累计探索含初始视野；m6 检查主城金币而非扣除', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务门槛测试');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();
  await repairM1Fields(app, va);
  await send(app, 'task.Deliver', { villageId: va, code: 'm1' });

  const acceptedM2 = await send(app, 'task.Accept', { villageId: va, code: 'm2' });
  assert.equal(acceptedM2.ok, true, 'm2 应可手动接取');
  const first = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  const second = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(first.ok, true, '第一栋城内建筑应可建造');
  assert.equal(second.ok, true, '第二栋城内建筑应可建造');
  await app.scheduler.advanceTo(Math.max((first.payload as any).finishAt, (second.payload as any).finishAt), setClock);
  const afterBuild = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const m2 = afterBuild.active.find((item: any) => item.code === 'm2');
  assert.ok(m2?.ready, '两栋城内建筑完成后 m2 应就绪');
  assert.equal(m2.progress, 2, 'm2 进度应为 2/2');
  await send(app, 'task.Deliver', { villageId: va, code: 'm2' });

  // 主线前置由 GM 关系表控制；为隔离 m5 目标测试，模拟前置任务已解锁 m5。
  const taskState = app.store.get<any>('task', va)!;
  taskState.offeredMain = ['m5'];
  app.store.set('task', va, taskState);
  const acceptedM5 = await send(app, 'task.Accept', { villageId: va, code: 'm5' });
  assert.equal(acceptedM5.ok, true, 'm5 应可手动接取');
  const exploredAtStart = await send(app, 'vision.GetExploredCount', { playerId: (regRes.payload as any).player.id });
  assert.ok((exploredAtStart.payload as any).count > 0, '城镇初始视野应计入已探索格数');
  const vision = app.store.get<any>('vision', (regRes.payload as any).player.id) ?? { playerId: (regRes.payload as any).player.id, explored: {} };
  for (let i = 0; i < 110; i++) vision.explored[`${i % 96},${Math.floor(i / 96)}`] ??= { q: i % 96, r: Math.floor(i / 96), kind: 'empty' };
  app.store.set('vision', vision.playerId, vision);
  const afterExplore = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const m5 = afterExplore.active.find((item: any) => item.code === 'm5');
  assert.ok(m5?.ready, '累计探索达到 100 格后 m5 应就绪');
  assert.ok(m5.progress >= 100, 'm5 应记录累计探索进度');
  const m5Delivery = await send(app, 'task.Deliver', { villageId: va, code: 'm5' });
  assert.deepEqual(
    { percent: (m5Delivery.payload as any).rewards.populationGrowth.percent, durationSec: (m5Delivery.payload as any).rewards.populationGrowth.durationSec },
    { percent: 10, durationSec: 86400 },
    'M5 交付应返回 +10%/24小时人口增长奖励',
  );
  const growthSnapshot = await send(app, 'population.GetSnapshot', { villageId: va });
  assert.equal((growthSnapshot.payload as any).taskGrowthBuff.mult, 1.1, 'M5 交付后应启用 1.1 倍临时增长');
  await app.scheduler.advanceTo(clock + 86_400_000, setClock);
  const expiredSnapshot = await send(app, 'population.GetSnapshot', { villageId: va });
  assert.equal((expiredSnapshot.payload as any).taskGrowthBuff, null, 'M5 临时增长奖励 24 小时后应失效');

  const acceptedM6 = await send(app, 'task.Accept', { villageId: va, code: 'm6' });
  assert.equal(acceptedM6.ok, true, 'm6 应可手动接取');
  const afterGold = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const m6 = afterGold.active.find((item: any) => item.code === 'm6');
  assert.ok(m6?.ready, '主城拥有至少 100 金币时 m6 应立即就绪');
  const beforeDeliver = (await send(app, 'economy.GetResources', { villageId: va })).payload as any;
  await send(app, 'task.Deliver', { villageId: va, code: 'm6' });
  const afterDeliver = (await send(app, 'economy.GetResources', { villageId: va })).payload as any;
  assert.ok(afterDeliver.resources.gold >= beforeDeliver.resources.gold, 'm6 目标检查不应扣除金币');
});

test('主线 m10/m11：二级主基地触发，M10 可立即就绪，M11 交付解锁唯一建筑', async () => {
  const app = freshApp();
  const regRes = await reg(app, '主基地阶段任务');
  const player = (regRes.payload as any).player;
  const villageId = player.villageId as string;
  await grant(app, villageId, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });

  // 二级主基地完成后，M11（无前置、仅主基地门槛）应进入可接取列表。
  const upgrade = await send(app, 'building.Upgrade', { villageId, slotId: 'center' });
  assert.equal(upgrade.ok, true, `主基地升级应成功: ${upgrade.reason ?? ''}`);
  await app.scheduler.advanceTo((upgrade.payload as any).finishAt, setClock);
  let state = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(state.offeredMain.some((item: any) => item.code === 'm11'), '二级主基地应触发 M11');

  // 模拟前置主线已完成后接取 M10；已有二级主基地应立即就绪。
  const taskState = app.store.get<any>('task', villageId)!;
  taskState.completedMain.push('m9');
  taskState.offeredMain.push('m10');
  app.store.set('task', villageId, taskState);
  assert.equal((await send(app, 'task.Accept', { villageId, code: 'm10' })).ok, true);
  state = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(state.active.find((item: any) => item.code === 'm10')?.ready, '已有二级主基地的 M10 应直接就绪');
  const m10 = await send(app, 'task.Deliver', { villageId, code: 'm10' });
  const m10Growth = (m10.payload as any).rewards.resourceGrowth ?? {};
  assert.equal(m10Growth.percent, 25, 'M10 应发放四资源 +25%');
  assert.equal(m10Growth.durationSec, 43200, 'M10 应持续12小时');

  assert.equal((await send(app, 'task.Accept', { villageId, code: 'm11' })).ok, true);
  const vision = app.store.get<any>('vision', player.id) ?? { playerId: player.id, explored: {} };
  for (let i = 0; i < 210; i++) vision.explored[`m11-${i}`] ??= { q: i, r: 0, kind: 'empty' };
  app.store.set('vision', player.id, vision);
  state = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(state.active.find((item: any) => item.code === 'm11')?.ready, 'M11 达到 200 格后应就绪');
  const m11 = await send(app, 'task.Deliver', { villageId, code: 'm11' });
  assert.deepEqual((m11.payload as any).rewards.buildingUnlocks, ['alliance_hall', 'council']);
  const building = app.store.get<any>('building', villageId)!;
  assert.deepEqual(building.unlockedBuildings.sort(), ['alliance_hall', 'council']);
});

test('M2：已有建筑拆除后重建不计数，新的空槽 1 级建造才计数', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'M2 重建计数');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999 });
  await tick();
  await repairM1Fields(app, va);
  await send(app, 'task.Deliver', { villageId: va, code: 'm1' });
  assert.equal((await send(app, 'task.Accept', { villageId: va, code: 'm2' })).ok, true);

  const first = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  assert.equal(first.ok, true, `首次建造应成功: ${first.reason ?? ''}`);
  await app.scheduler.advanceTo((first.payload as any).finishAt, setClock);
  let state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  let m2 = state.active.find((item: any) => item.code === 'm2');
  assert.equal(m2.progress, 1, '第一次建造应计数 1');

  const layout = (await send(app, 'building.GetLayout', { villageId: va })).payload as any;
  const warehouse = layout.zones.inner.placed.find((p: any) => p.kind === 'warehouse' && p.level >= 1);
  assert.ok(warehouse, '应能找到已建成的仓库');
  const demolition = await send(app, 'building.Demolish', { villageId: va, slotId: warehouse.slotId });
  assert.equal(demolition.ok, true, `拆除应成功: ${demolition.reason ?? ''}`);
  await app.scheduler.advanceTo((demolition.payload as any).finishAt, setClock);

  const rebuilt = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  assert.equal(rebuilt.ok, true, `重建应成功: ${rebuilt.reason ?? ''}`);
  await app.scheduler.advanceTo((rebuilt.payload as any).finishAt, setClock);
  state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  m2 = state.active.find((item: any) => item.code === 'm2');
  assert.equal(m2.progress, 1, '已有建筑拆除后在原槽位重建不应计数');
  assert.equal(m2.ready, false, '尚未在新的空槽完成第二次新建');

  const second = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(second.ok, true, `新的空槽建造应成功: ${second.reason ?? ''}`);
  await app.scheduler.advanceTo((second.payload as any).finishAt, setClock);
  state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  m2 = state.active.find((item: any) => item.code === 'm2');
  assert.equal(m2.progress, 2, '新的空槽建成 1 级应计数');
  assert.equal(m2.ready, true, '达到 2 次新空槽建造后应就绪');
});

test('M2：接取时城内槽位已满，拆除释放槽位后新建仍按完成事件计数', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'M2 满槽计数');
  const va = (regRes.payload as any).player.villageId;
  await repairM1Fields(app, va);
  await send(app, 'task.Deliver', { villageId: va, code: 'm1' });
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999 });

  // 1 级主城有 4 个城内槽位：集结点 + 三栋新建筑，先把槽位填满。
  const first = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  const second = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'granary' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  await app.scheduler.advanceTo(Math.max((first.payload as any).finishAt, (second.payload as any).finishAt), setClock);
  const third = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'barracks' });
  assert.equal(third.ok, true);
  await app.scheduler.advanceTo((third.payload as any).finishAt, setClock);
  const full = (await send(app, 'building.GetLayout', { villageId: va })).payload as any;
  assert.equal(full.zones.inner.placed.length, 4, '接取前城内槽位应已全部占用');

  assert.equal((await send(app, 'task.Accept', { villageId: va, code: 'm2' })).ok, true);
  const warehouse = full.zones.inner.placed.find((item: any) => item.kind === 'warehouse');
  assert.ok(warehouse, '应能找到接取前的建筑');
  const demolition = await send(app, 'building.Demolish', { villageId: va, slotId: warehouse.slotId });
  assert.equal(demolition.ok, true);
  await app.scheduler.advanceTo((demolition.payload as any).finishAt, setClock);

  const rebuilt = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(rebuilt.ok, true, `释放槽位后应能新建: ${rebuilt.reason ?? ''}`);
  await app.scheduler.advanceTo((rebuilt.payload as any).finishAt, setClock);
  let state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  let m2 = state.active.find((item: any) => item.code === 'm2');
  assert.equal(m2.progress, 1, '接取时已满槽，拆除后在空槽完成 1 级新建应计数');
  assert.equal(m2.ready, false);

  const granary = (await send(app, 'building.GetLayout', { villageId: va })).payload.zones.inner.placed.find((item: any) => item.kind === 'granary');
  assert.ok(granary);
  const demolition2 = await send(app, 'building.Demolish', { villageId: va, slotId: granary.slotId });
  assert.equal(demolition2.ok, true);
  await app.scheduler.advanceTo((demolition2.payload as any).finishAt, setClock);
  const rebuilt2 = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  assert.equal(rebuilt2.ok, true);
  await app.scheduler.advanceTo((rebuilt2.payload as any).finishAt, setClock);
  state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  m2 = state.active.find((item: any) => item.code === 'm2');
  assert.equal(m2.progress, 2, '第二个被释放的空槽完成新建后应累计到 2');
  assert.equal(m2.ready, true, '达到两次新建完成事件后 m2 应就绪');
});

test('主线 m3 人口门槛与 m4 老鼠窝营地目标按顺序手动接取', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试3');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();
  // 完成并交付 m1 → 按当前 GM 关系先完成 m2，再让 m3 进入可接取提示。
  await repairM1Fields(app, va);
  await send(app, 'task.Deliver', { villageId: va, code: 'm1' });

  const acceptedM2 = await send(app, 'task.Accept', { villageId: va, code: 'm2' });
  assert.equal(acceptedM2.ok, true, `手动接取 m2 应成功: ${acceptedM2.reason ?? ''}`);
  const first = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'warehouse' });
  const second = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(first.ok, true, 'm2 第一栋城内建筑应可建造');
  assert.equal(second.ok, true, 'm2 第二栋城内建筑应可建造');
  await app.scheduler.advanceTo(Math.max((first.payload as any).finishAt, (second.payload as any).finishAt), setClock);
  const m2Delivery = await send(app, 'task.Deliver', { villageId: va, code: 'm2' });
  assert.equal(m2Delivery.ok, true, `交付 m2 应成功: ${m2Delivery.reason ?? ''}`);

  const offered = await send(app, 'task.GetState', { villageId: va });
  assert.ok((offered.payload as any).offeredMain.some((item: any) => item.code === 'm3'), 'm3 应先显示可接取');
  const accepted = await send(app, 'task.Accept', { villageId: va, code: 'm3' });
  assert.equal(accepted.ok, true, `手动接取 m3 应成功: ${accepted.reason ?? ''}`);
  const pop = app.store.get<any>('population', va);
  assert.ok(pop, '应存在主城人口状态');
  pop.hardCap = 40;
  pop.currentPop = 30;
  app.store.set('population', va, pop);
  const st = await send(app, 'task.GetState', { villageId: va });
  const m3 = (st.payload as any).active.find((a: any) => a.code === 'm3');
  assert.ok(m3, 'm3 应处于 active');
  assert.equal(m3.progress, 30, 'm3 应记录主城人口进度');
  assert.equal(m3.ready, true, '主城人口达到 30 后 m3 应就绪');
  const m3Delivery = await send(app, 'task.Deliver', { villageId: va, code: 'm3' });
  assert.equal((m3Delivery.payload as any).rewards.population, 5, 'M3 交付应实际增加 5 人口');
  const afterM3Pop = await send(app, 'population.GetSnapshot', { villageId: va });
  assert.equal((afterM3Pop.payload as any).currentPop, 35, 'M3 人口奖励应加入平民人口');

  const offeredM4 = await send(app, 'task.GetState', { villageId: va });
  assert.ok((offeredM4.payload as any).offeredMain.some((item: any) => item.code === 'm4'), 'm4 应在 m3 交付后进入可接取');
  const acceptedM4 = await send(app, 'task.Accept', { villageId: va, code: 'm4' });
  assert.equal(acceptedM4.ok, true, `手动接取 m4 应成功: ${acceptedM4.reason ?? ''}`);
  const stM4 = await send(app, 'task.GetState', { villageId: va });
  const m4 = (stM4.payload as any).active.find((a: any) => a.code === 'm4');
  assert.ok(m4, 'm4 应处于 active');
  assert.equal(m4.campTotal, 1, 'm4 应生成 1 个附近老鼠窝强度营地');
  assert.equal(m4.objective.campTemplate, 'rats', 'm4 营地模板应为 rats');
  const camp = m4.camps[0];
  assert.ok(camp && camp.id, '营地应有 id 与坐标');
  const campId = camp.id;
  let latestMapUpdate: any;
  const stopWatchingTaskMap = app.bus.on('task.MapUpdated', (evt) => {
    if ((evt.payload as any).villageId === va) latestMapUpdate = evt.payload;
  });

  // 任务营地使用独立 taskcamp 地块，既真实占格又不进入其他玩家的全局视野。
  const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tile.ok, true, '营地应在地图上有 taskcamp 地块');
  const target = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((target.payload as any).ownerVillageId, va, '新任务营地必须绑定所属村庄');

  // 回归：旧版本可能把 PvE 实体落在另一坐标，任务卡仍保存接取时坐标；恢复时应以任务快照统一实体。
  const mismatched = { ...(target.payload as any), q: camp.q + 1, r: camp.r + 1 };
  app.store.set('pve', campId, mismatched);
  await send(app, 'world.RemoveTile', { q: camp.q, r: camp.r, refId: campId });
  await app.task.resume();
  const syncedTarget = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((syncedTarget.payload as any).q, camp.q, '恢复后 PvE 营地 q 必须与任务卡一致');
  assert.equal((syncedTarget.payload as any).r, camp.r, '恢复后 PvE 营地 r 必须与任务卡一致');

  // 模拟旧存档：任务营地缺 owner，且地块曾被错误保存为全局 pve。
  const legacy = { ...(target.payload as any), ownerVillageId: undefined };
  app.store.set('pve', campId, legacy);
  await send(app, 'world.RemoveTile', { q: camp.q, r: camp.r, refId: campId });
  await send(app, 'world.PlacePve', { q: camp.q, r: camp.r, refId: campId, name: '任务营地', task: false });
  await app.task.resume();
  const repaired = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((repaired.payload as any).ownerVillageId, va, '恢复时必须回填历史任务营地 owner');
  const repairedTile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(repairedTile.ok, true, '恢复时必须把历史全局 pve 收回 taskcamp');
  const area = await send(app, 'world.GetArea', { cq: camp.q, cr: camp.r, r: 0 });
  assert.ok(!(area.payload as any).tiles.some((t: any) => t.refId === campId), '任务营地不得出现在其他玩家共享的地图区域数据中');

  // 模拟战斗结束：玩家清空该营地
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId, attackerWins: true, battleId: 'b-test' },
  } as any);
  await tick();

  // 战斗后就绪，但未交付前不完成、不移除营地、不发宝物
  const st1 = await send(app, 'task.GetState', { villageId: va });
  const p1 = st1.payload as any;
  const m4a = p1.active.find((a: any) => a.code === 'm4');
  assert.ok(m4a && m4a.ready === true, 'm4 战斗后应就绪可交付');
  assert.ok(!p1.completedMain.includes('m4'), '未交付 m4 不应完成');
  assert.equal((app.store.all('treasure_pending') as any[]).filter((p) => p.villageId === va).length, 0,
    'M4 临时任务营地不应按 droprate 或其它任务规则掉落宝物');
  assert.deepEqual(latestMapUpdate?.camps, [], '已清理营地不得继续出现在 TaskMapUpdated 地图标记中');
  stopWatchingTaskMap();

  // 交付 m4 → 完成 + 移除营地
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 'm4' });
  assert.equal(dv.ok, true, `交付 m4 应成功: ${dv.reason ?? ''}`);

  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok(p2.completedMain.includes('m4'), 'm4 应已完成');
  assert.ok(!p2.active.find((a: any) => a.code === 'm4'), 'm4 应从 active 移除');

  // 营地地块应被移除
  const tileAfter = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tileAfter.ok, false, '营地地块应已被清除');

  assert.ok((dv.payload as any).rewards.resources.gold >= 40, 'm4 交付应按 GM 配置发放金币奖励');
});

test('任务营地战败不推进任务，营地仍在地图上等待再次出征', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务营地战败保留');
  const va = (regRes.payload as any).player.villageId as string;
  const campId = 'taskcamp-defeat-keep';
  app.store.set('task', va, {
    villageId: va, completedMain: [], completedSide: [], abandonedSide: [], offered: [], offeredSide: [], firedTriggers: [],
    active: {
      m4: {
        code: 'm4', type: 'main', acceptedAt: clock, spawnVillageId: va,
        submitted: {}, camps: [{ id: campId, q: 6, r: 6, cleared: false }], campCleared: 0, progress: 0,
      },
    },
  });
  const spawned = await send(app, 'pve.Spawn', { id: campId, type: 'rats', q: 6, r: 6, task: true, ownerVillageId: va });
  assert.equal(spawned.ok, true, `测试任务营地生成失败: ${spawned.reason ?? ''}`);

  // 模拟战败链路中旧逻辑已经清掉实体；战败事件本身不应推进任务，且应自动补回营地。
  await send(app, 'pve.Remove', { id: campId });
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId, attackerWins: false, battleId: 'b-defeat' },
  } as any);
  await tick();

  const target = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal(target.ok, true, '战败后任务营地实体必须仍存在');
  assert.equal((target.payload as any).cleared, false, '战败不应清空任务营地');
  const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tile.ok, true, '战败后任务营地地块必须仍存在');
  const state = await send(app, 'task.GetState', { villageId: va });
  const m4 = (state.payload as any).active.find((item: any) => item.code === 'm4');
  assert.ok(m4, '战败后任务仍应 active');
  assert.equal(m4.campCleared, 0, '战败不应推进清营进度');
  assert.equal(m4.camps[0].cleared, false, '战败不应标记营地已清理');
});

test('任务营地被先到军队清除后，仍在途的后续军队立即返程', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务营地清除返程');
  const va = (regRes.payload as any).player.villageId as string;
  const campId = 'taskcamp-return-after-clear';
  app.store.set('task', va, {
    villageId: va, completedMain: [], completedSide: [], abandonedSide: [], offered: [], offeredSide: [], firedTriggers: [],
    active: {
      m4: {
        code: 'm4', type: 'main', acceptedAt: clock, spawnVillageId: va,
        submitted: {}, camps: [{ id: campId, q: 6, r: 6, cleared: false }], campCleared: 0, progress: 0,
      },
    },
  });
  const spawned = await send(app, 'pve.Spawn', { id: campId, type: 'rats', q: 6, r: 6, task: true, ownerVillageId: va });
  assert.equal(spawned.ok, true, `测试任务营地生成失败: ${spawned.reason ?? ''}`);
  await grant(app, va, { wood: 100, clay: 100, iron: 100, crop: 100 });
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 1 } });
  const fast = await send(app, 'movement.SendRaid', { villageId: va, targetId: campId, troops: { legionnaire: 1 } });
  assert.equal(fast.ok, true, `先到军队出发失败: ${fast.reason ?? ''}`);
  const fastMovement = app.store.get<any>('movement', (fast.payload as any).id);
  assert.ok(fastMovement, '先到军队应写入 movement');

  // 复制一条尚未抵达的慢军队，保持同一目标但使用独立 id，模拟多支军队先后抵达。
  const slowMovement = {
    ...fastMovement,
    id: 'mv-taskcamp-slow',
    arriveAt: fastMovement.arriveAt + 60_000,
    nextStepAt: fastMovement.nextStepAt + 60_000,
    stepToken: fastMovement.stepToken + 10,
  };
  app.store.set('movement', slowMovement.id, slowMovement);

  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: {
      villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId,
      attackerWins: true, campCleared: true, movementId: fastMovement.id,
      fromXY: fastMovement.fromXY, toXY: fastMovement.toXY, originalFromXY: fastMovement.originalFromXY ?? fastMovement.fromXY,
      survivors: { legionnaire: 1 }, deployedTroops: { legionnaire: 1 }, looted: {},
    },
  } as any);

  const recalled = app.store.get<any>('movement', slowMovement.id);
  assert.ok(recalled, '慢军队应保留为返程 movement');
  assert.equal(recalled.type, 'return', '任务营地清除后慢军队应立即返程');
  assert.equal(recalled.targetId, undefined, '返程军队不应继续保留已清除营地目标');
});

test('「耀武扬威」携旗清空 PvE 营地后记录待回城的出征', async () => {
  const app = freshApp();
  const regRes = await reg(app, '携旗测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();

  // 直接建立已接取的支线，聚焦验证战斗结束事件的结算契约。
  const state = app.store.get<any>('task', va);
  state.active.s2 = {
    code: 's2', type: 'side', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0,
  };
  app.store.set('task', va, state);

  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: {
      villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-test',
      attackerWins: true, movementId: 'mv-flag', treasures: ['war_flag'],
      deployedTroops: { legionnaire: 20 }, campCleared: true,
    },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const s2 = (st.payload as any).active.find((a: any) => a.code === 's2');
  assert.equal(s2.awaitingReturn, 1, '清空营地且携旗达到二十人时，应记录待回城出征');
});

test('「耀武扬威」合格军旗归城后须手动交付，交付时才兑换胜利旗帜', async () => {
  const app = freshApp();
  const regRes = await reg(app, '手动交付测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  const taskState = app.store.get<any>('task', va);
  taskState.active.s2 = {
    code: 's2', type: 'side', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0,
    qualifiedMovements: [], qualifiedFlagMovements: ['mv-qualified'], readyToDeliver: true,
  };
  app.store.set('task', va, taskState);
  app.store.set('treasure', va, {
    villageId: va, town: ['war_flag'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });

  const before = await send(app, 'task.GetState', { villageId: va });
  assert.ok((before.payload as any).active.find((x: any) => x.code === 's2'), '归城后任务仍应等待玩家手动交付');
  const delivered = await send(app, 'task.Deliver', { villageId: va, code: 's2' });
  assert.equal(delivered.ok, true, `手动交付应成功: ${delivered.reason ?? ''}`);
  const after = await send(app, 'task.GetState', { villageId: va });
  assert.ok((after.payload as any).completedSide.includes('s2'), '交付后才记录完成');
  const treasure = app.store.get<any>('treasure', va);
  assert.deepEqual(treasure.town, ['victory_flag'], '交付时应原子消耗军旗并获得胜利旗帜');
});

test('GM 可将已完成支线标记未完成，且必须重新触发后才可接取', async () => {
  const app = freshApp();
  const regRes = await reg(app, '支线重置测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  const state = app.store.get<any>('task', va);
  state.completedSide = ['s2'];
  state.firedTriggers = ['troops_reached:20'];
  app.store.set('task', va, state);

  const reopen = await send(app, 'task.GmReopenCompleted', { villageId: va, code: 's2' });
  assert.equal(reopen.ok, true, `GM 重置应成功: ${reopen.reason ?? ''}`);
  const after = reopen.payload as any;
  assert.ok(!after.completedSide.includes('s2'), '重置后不应保留完成记录');
  assert.ok(!after.offeredSide.some((q: any) => q.code === 's2'), '未重新触发前不得再次接取');

  const raw = app.store.get<any>('task', va);
  assert.ok(!raw.firedTriggers.includes('troops_reached:20'), '重置后必须清除该任务的触发状态');
  const main = await send(app, 'task.GmReopenCompleted', { villageId: va, code: 'm1' });
  assert.equal(main.ok, false, '主线不可经此 GM 操作重置');
  assert.equal(main.reason, 'only_completed_side_supported');
});

test('酒馆建造触发随机任务刷新；接取 → 上交 → 完成', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试4');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  // 建造酒馆（inner，无前置）
  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, `建酒馆应成功: ${build.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 120_000, setClock); // 等待落成 → building.Built → onTavernChanged
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offered.length > 0, `酒馆应刷出随机任务，实际 offered=${p.offered.length}`);

  // 接取第一个随机任务
  const code = p.offered[0].code;
  const acc = await send(app, 'task.Accept', { villageId: va, code });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok(p2.active.find((a: any) => a.code === code), '接取后应进入 active');
  assert.ok(!p2.offered.includes(code), '接取后应从 offered 移除');

  // 若为目标为 submit_resources，上交 → 就绪 → 交付
  const inst = p2.active.find((a: any) => a.code === code);
  if (inst.objective.kind === 'submit_resources') {
    const res = inst.objective.resources ?? {};
    await grant(app, va, res); // 确保有足够资源
    const sub = await send(app, 'task.SubmitResources', { villageId: va, code, resources: res });
    assert.equal(sub.ok, true, `上交应成功: ${sub.reason ?? ''}`);
    assert.equal((sub.payload as any).completed, true, '日常 submit 任务目标应达成');
    const st3 = await send(app, 'task.GetState', { villageId: va });
    const inst3 = (st3.payload as any).active.find((a: any) => a.code === code);
    assert.ok(inst3 && inst3.ready === true, '上交后应就绪可交付');
    const dv = await send(app, 'task.Deliver', { villageId: va, code });
    assert.equal(dv.ok, true, '交付应成功');
    const st4 = await send(app, 'task.GetState', { villageId: va });
    assert.ok(!(st4.payload as any).active.find((a: any) => a.code === code), '交付后应移出 active');
    assert.ok(!((st4.payload as any).completedSide ?? []).includes(code), '日常任务不记入已完成支线（可反复）');
  }
});

test('主线任务不可放弃；随机任务可放弃且移除营地', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试5');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  // 主线 m1 不可放弃
  const abMain = await send(app, 'task.Abandon', { villageId: va, code: 'm1' });
  assert.equal(abMain.ok, false, '主线放弃应被拒');
  assert.equal(abMain.reason, 'main_cannot_abandon');

  // 建酒馆 + 接取随机 clear_camp（若有），放弃应移除营地
  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true);
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  // 找一个 clear_camp 的随机任务来测营地移除
  const campOffer = p.offered.find((o: any) => o.objective.kind === 'clear_camp');
  if (campOffer) {
    const acc = await send(app, 'task.Accept', { villageId: va, code: campOffer.code });
    assert.equal(acc.ok, true);
    const st2 = await send(app, 'task.GetState', { villageId: va });
    const inst = st2.payload.active.find((a: any) => a.code === campOffer.code);
    const campId = inst.camps[0]?.id;
    assert.ok(campId, 'clear_camp 随机任务应生成营地');
    const ab = await send(app, 'task.Abandon', { villageId: va, code: campOffer.code });
    assert.equal(ab.ok, true, '随机任务放弃应成功');
    const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'pve' });
    assert.equal(tile.ok, false, '放弃后营地地块应被清除');
  } else {
    // 没有 clear_camp 随机任务也至少验证一个随机可放弃（submit 类）
    assert.ok(p.offered.length > 0, '酒馆应有随机任务');
    const code = p.offered[0].code;
    const acc = await send(app, 'task.Accept', { villageId: va, code });
    assert.equal(acc.ok, true);
    const ab = await send(app, 'task.Abandon', { villageId: va, code });
    assert.equal(ab.ok, true, '随机 submit 任务放弃应成功');
  }
});

test('修复资源田只计入目标建筑，重复修复事件不会重复推进', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试6');
  const va = (regRes.payload as any).player.villageId;
  await tick();

  const layout = (await send(app, 'building.GetLayout', { villageId: va })).payload as any;
  const wood = layout.zones.outer.placed.find((item: any) => item.kind === 'woodcutter');
  const before = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.deepEqual(before.active.find((item: any) => item.code === 'm1').repairedBuildings, []);
  const repair = await send(app, 'building.Repair', { villageId: va, slotId: wood.slotId });
  assert.equal(repair.ok, true);
  await app.scheduler.advanceTo((repair.payload as any).finishAt, setClock);
  const after = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.deepEqual(after.active.find((item: any) => item.code === 'm1').repairedBuildings, ['woodcutter']);
  assert.equal(after.active.find((item: any) => item.code === 'm1').ready, false);
});

test('酒馆支线：按槽位概率刷新 → 接取 → 放弃后永久不再出现', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试7');
  const va = (regRes.payload as any).player.villageId;
  // 固定该村酒馆支线概率为 1，验证 S1 进入酒馆 mixed offered，而不是 offeredSide。
  app.config.buildings.tavern.levels[1].taskSideQuestChance = 1;
  // s6 也属于新加入的酒馆支线；本用例专测既有 s1，禁用 s6 权重以保持确定性。
  app.config.quests.s6.weight = 0;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, '建酒馆应成功');
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok((p.offered ?? []).some((o: any) => o.code === 's1'), '酒馆建成后 S1 应进入 mixed offered');
  // chance=1 时每个槽位都可被支线替换，因此不保证同时存在日常任务。
  assert.ok(!(p.offeredSide ?? []).some((o: any) => o.code === 's1'), '酒馆支线不应进入事件型 offeredSide');

  const acc = await send(app, 'task.Accept', { villageId: va, code: 's1' });
  assert.equal(acc.ok, true, '接取支线应成功');

  const ab = await send(app, 'task.Abandon', { villageId: va, code: 's1' });
  assert.equal(ab.ok, true, '支线放弃应成功');
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok((p2.abandonedSide ?? []).includes('s1'), '放弃后 S1 应记入 abandonedSide');
  assert.ok(!(p2.offered ?? []).some((o: any) => o.code === 's1'), '放弃后 S1 不应再在酒馆可接取');
  assert.ok(!(p2.offeredSide ?? []).some((o: any) => o.code === 's1'), '放弃后 S1 不应再在事件型可接取');
  assert.ok(!(p2.active ?? []).some((a: any) => a.code === 's1'), '放弃后 S1 不应再 active');
});

test('酒馆刷新会替换未接取任务且保留已接取任务', async () => {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const regRes = await reg(app, '酒馆刷新替换');
  const va = (regRes.payload as any).player.villageId;
  app.config.buildings.tavern.levels[1].taskRefreshSec = 1;
  app.config.buildings.tavern.levels[1].taskSideQuestChance = 0;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, '建酒馆应成功');
  await app.scheduler.advanceTo((build.payload as any).finishAt, setClock);
  await tick();
  await tick();

  const state = app.store.get<any>('task', va)!;
  assert.equal(state.offered.length, 2, '酒馆初次建成应填满两个任务槽');
  state.offered = ['s1'];
  app.store.set('task', va, state);

  const manual = await send(app, 'task.GmRefreshRandom', { villageId: va });
  assert.equal(manual.ok, true, 'GM 刷新应成功');
  assert.equal(state.offered.length, 2, '刷新后应重新填满所有槽位');
  assert.ok(!state.offered.includes('s1'), '刷新后不应保留被替换的未接取任务');
  assert.ok(state.active.m1, '刷新不应影响已接取任务');

  state.offered = ['s1'];
  app.store.set('task', va, state);
  await app.scheduler.advanceTo(clock + 1_000, setClock);
  await tick();
  await tick();
  assert.ok(!state.offered.includes('s1'), '定时刷新也应替换未接取任务');
});

test('猎马人：按配置门槛累计击杀骑兵人口，跨战斗累加并就绪', async () => {
  const app = freshApp();
  const regRes = await reg(app, '猎马人累计击杀');
  const va = (regRes.payload as any).player.villageId;
  const state = app.store.get<any>('task', va)!;
  state.active.s5 = {
    code: 's5', type: 'side', acceptedAt: clock, submitted: {}, repairedBuildings: [],
    camps: [], campCleared: 0, progress: 0,
  };
  app.store.set('task', va, state);

  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: {
    villageId: va, side: 'attacker', targetKind: 'field', targetId: 'movement-defender', attackerWins: false,
    defenderLosses: { equlegati: 2, equimperatoris: 1, legionnaire: 10 },
  } } as any);
  let current = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  let hunter = current.active.find((item: any) => item.code === 's5');
  assert.equal(hunter.progress, 5, '第一场应按当前骑兵 popCost 累计 5 人口');
  assert.equal(hunter.ready, false);

  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: {
    villageId: va, side: 'attacker', targetKind: 'field', targetId: 'movement-defender-2', attackerWins: true,
    defenderLossesAttributed: { equimperatoris: 1 },
  } } as any);
  current = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  hunter = current.active.find((item: any) => item.code === 's5');
  assert.equal(hunter.progress, 8, '第二场应继续累加并按配置门槛截断到 8 人');
  assert.equal(hunter.ready, true, '达到配置门槛后应可领取绞马索');
});

test('日常任务可反复：完成后刷新可再次刷出', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试8');
  const va = (regRes.payload as any).player.villageId;
  // 该回归只验证日常任务循环，关闭支线槽概率避免随机抽到 S1。
  app.config.buildings.tavern.levels[1].taskSideQuestChance = 0;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, '建酒馆应成功');
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const offer = (st.payload as any).offered.find((o: any) => o.objective.kind === 'submit_resources');
  assert.ok(offer, '酒馆应刷出 submit 类日常任务');
  const code = offer.code;
  const acc = await send(app, 'task.Accept', { villageId: va, code });
  assert.equal(acc.ok, true, '接取应成功');
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const inst = st2.payload.active.find((a: any) => a.code === code);
  const res = inst.objective.resources ?? {};
  await grant(app, va, res);
  await send(app, 'task.SubmitResources', { villageId: va, code, resources: res });
  await send(app, 'task.Deliver', { villageId: va, code });
  const st3 = await send(app, 'task.GetState', { villageId: va });
  assert.ok(!(st3.payload as any).active.find((a: any) => a.code === code), '交付后应移出 active');
  assert.ok(!((st3.payload as any).completedSide ?? []).includes(code), '日常任务完成不记入支线完成');

  await app.scheduler.advanceTo(clock + 7200_000, setClock);
  await tick();
  const st4 = await send(app, 'task.GetState', { villageId: va });
  assert.ok((st4.payload as any).offered.length > 0, '刷新后酒馆仍应有日常任务可刷');
});

test('村民的请求：接取即生成幸福村；贸易中心只决定送达订单', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求触发测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  // 强制触发概率=1，消除随机性
  app.config.constants.raw['villager_request_trigger_chance'] = 1;

  // 模拟成功掠夺一个真实存在的常驻普通 PvE 营地
  const camp = await spawnResidentCamp(app);
  assert.equal(camp.ok, true, '测试用常驻营地应生成成功');
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offeredSide.some((q: any) => q.code === 's3'), '清空普通 PvE 营地后应点亮「村民的请求」支线');

  // 接取支线
  const acc = await send(app, 'task.Accept', { villageId: va, code: 's3' });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  await tick();

  // 幸福村 pve 目标应已生成
  const npcId = `happy-${va}`;
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, true, '幸福村 NPC 目标应已生成');
  const npcPayload = npc.payload as any;
  assert.equal(npcPayload.ownerVillageId, va, '幸福村应绑定玩家村（仅主人可掠夺）');
  assert.deepEqual(npcPayload.loot, { wood: 200, clay: 200, iron: 200, gold: 100 }, '幸福村掠夺资源应为 200/200/200/100');
  assert.equal(npcPayload.noRespawn, true, '幸福村应标记不重生');

  // 未建贸易中心时没有订单，但幸福村不能因此延迟出现。
  let tc = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal(((tc.payload as any).npcDeliveryOrders ?? []).length, 0, '无贸易中心时不应创建订单');

  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();

  // 贸易中心应有幸福村送达订单（crop 500）
  tc = await send(app, 'trade.GetCenter', { villageId: va });
  const orders = (tc.payload as any).npcDeliveryOrders ?? [];
  assert.equal(orders.length, 1, '贸易中心应有 1 条幸福村订单');
  assert.equal(orders[0].want.crop, 500, '订单应为 500 粮食');
  assert.equal(orders[0].npcId, npcId, '订单应指向幸福村');
});

test('村民的请求：任务临时营地清理不触发支线', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务营地不触发村民请求');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.config.constants.raw['villager_request_trigger_chance'] = 1;
  const camp = await send(app, 'pve.Spawn', {
    id: 'task-camp-no-s3', type: 'rats', q: 31, r: 31, task: true, ownerVillageId: va,
  });
  assert.equal(camp.ok, true, '测试用任务营地应生成成功');
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'task-camp-no-s3', attackerWins: true, campCleared: true, battleId: 'task-camp-b1' },
  } as any);
  const state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(!(state.offeredSide ?? []).some((item: any) => item.code === 's3'), '任务临时营地不应触发村民的请求');
});

test('村民的请求：掠夺幸福村（而非送达）→ 任务失败且获得秘密字条', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求失败测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.config.constants.raw['villager_request_trigger_chance'] = 1;
  const camp = await spawnResidentCamp(app);
  assert.equal(camp.ok, true, '测试用常驻营地应生成成功');
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' } } as any);
  await tick();
  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();
  await send(app, 'task.Accept', { villageId: va, code: 's3' });
  await tick();

  const npcId = `happy-${va}`;
  // 掠夺幸福村（失败路径）
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: npcId, attackerWins: true, campCleared: true, battleId: 'b2' },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  const failed = p.active.find((a: any) => a.code === 's3');
  assert.ok(failed, '失败确认前任务应保留在任务栏');
  assert.equal(failed.failureReady, true, '失败路径应等待玩家手动确认');
  assert.equal(failed.ready, false, '失败任务不应显示为可领奖');
  let pending = app.store.all<any>('treasure_pending').filter((x) => x.villageId === va && x.code === 'secret_note');
  assert.equal(pending.length, 0, '确认失败前不应提前发放秘密字条');
  const failedResult = await send(app, 'task.Fail', { villageId: va, code: 's3' });
  assert.equal(failedResult.ok, true, `确认失败应成功: ${failedResult.reason ?? ''}`);
  const afterFail = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(!afterFail.active.some((a: any) => a.code === 's3'), '确认失败后任务应终止');
  assert.ok(afterFail.abandonedSide.includes('s3'), '确认失败应记入 abandonedSide（不再出现）');
  pending = app.store.all<any>('treasure_pending').filter((x) => x.villageId === va && x.code === 'secret_note');
  assert.equal(pending.length, 1, '确认失败后应在报告中显示带回的秘密字条');
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, false, '幸福村地块应已被移除');
});

test('村民的请求：接单送粮完成 → 获得娜塔莉，幸福村与订单消失', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求完成测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.config.constants.raw['villager_request_trigger_chance'] = 1;
  const camp = await spawnResidentCamp(app);
  assert.equal(camp.ok, true, '测试用常驻营地应生成成功');
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' } } as any);
  await tick();
  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();
  await send(app, 'task.Accept', { villageId: va, code: 's3' });
  await tick();

  const npcId = `happy-${va}`;
  // 接取幸福村送达订单（扣粮 + 派商队 + 移除订单）
  await grant(app, va, { crop: 1000 });
  const tc = await send(app, 'trade.GetCenter', { villageId: va });
  const orderId = (tc.payload as any).npcDeliveryOrders[0].id;
  const acc = await send(app, 'trade.AcceptNpcDelivery', { villageId: va, orderId });
  assert.equal(acc.ok, true, `接单应成功: ${acc.reason ?? ''}`);
  await tick();
  const tc2 = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal((tc2.payload as any).npcDeliveryOrders.length, 0, '接单后订单应从贸易中心移除');

  // 商队抵达幸福村（movement.arriveCaravan 会发此事件）
  await app.bus.emit({
    name: 'movement.CaravanArrivedNpc', source: 'test', ts: clock,
    payload: { villageId: va, npcId, cargo: { crop: 500 } },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.completedSide.includes('s3'), '送达后任务应完成');
  assert.ok(!p.active.some((a: any) => a.code === 's3'), '任务应移出 active');
  const treasure = app.store.get<any>('treasure', va);
  const codes = [...(treasure?.town ?? []), ...(treasure?.treasury ?? [])];
  assert.ok(codes.includes('natalie'), '完成应获得娜塔莉');
  const reputation = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((reputation.payload as any).value, -1, 'S3 完成获得娜塔莉时应结算 -1 声望');
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, false, '幸福村应随任务完成消失');
});

test('秘密字条：使用后生成战报并解锁「调查坐标」', async () => {
  const app = freshApp();
  const regRes = await reg(app, '秘密字条测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.store.set('treasure', va, {
    villageId: va, town: ['secret_note'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });
  const use = await send(app, 'treasure.Use', { villageId: va, code: 'secret_note' });
  assert.equal(use.ok, true, `使用秘密字条应成功: ${use.reason ?? ''}`);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offeredSide.some((q: any) => q.code === 's4'), '使用秘密字条后应解锁「调查坐标」支线');
  const treasure = app.store.get<any>('treasure', va);
  const codes = [...(treasure?.town ?? []), ...(treasure?.treasury ?? [])];
  assert.ok(!codes.includes('secret_note'), '秘密字条使用后应被消耗');
});

test('调查坐标：接取 → 清剿3个rats营地 → 第3处掉落被囚禁的娜塔莉们 → 放入宝库后失败', async () => {
  const app = freshApp();
  const regRes = await reg(app, '调查坐标完整流程');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  // 强制初始化各模块村状态，避免 recomputeAndPush 下游 state 缺失导致字段未写入
  await send(app, 'population.GetState', { villageId: va });
  await send(app, 'military.GetState', { villageId: va });
  await send(app, 'research.GetState', { villageId: va });

  // 解锁 s4（使用秘密字条）
  app.store.set('treasure', va, {
    villageId: va, town: ['secret_note'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });
  await send(app, 'treasure.Use', { villageId: va, code: 'secret_note' });
  await tick();

  const st0 = await send(app, 'task.GetState', { villageId: va });
  const off = (st0.payload as any).offeredSide.find((q: any) => q.code === 's4');
  assert.ok(off, '使用秘密字条后应解锁「调查坐标」');
  assert.equal(off.objective.kind, 'clear_camp', '目标应为 clear_camp');
  assert.equal(off.objective.campTemplate, 'rats', '营地模板应为 rats（与老鼠窝同驻兵/资源）');
  assert.equal(off.objective.count, 3, '需清剿 3 个营地');

  // 接取
  const acc = await send(app, 'task.Accept', { villageId: va, code: 's4' });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  await tick();

  const st1 = await send(app, 'task.GetState', { villageId: va });
  const inst = st1.payload.active.find((a: any) => a.code === 's4');
  assert.equal(inst.camps.length, 3, '应生成 3 个任务营地');
  const campIds = inst.camps.map((c: any) => c.id);

  // 清剿前 2 个营地（不应掉落 captured_natalies）
  for (let i = 0; i < 2; i++) {
    await app.bus.emit({
      name: 'combat.BattleEnded', source: 'test', ts: clock,
      payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campIds[i], attackerWins: true, campCleared: true, movementId: `mv-p${i}`, battleId: `b${i}` },
    } as any);
    await tick();
  }
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const inst2 = st2.payload.active.find((a: any) => a.code === 's4');
  assert.equal(inst2.campCleared, 2, '应已清剿 2 处');
  const pendBefore = (app.store.all('treasure_pending') as any[]).filter((p) => p.villageId === va);
  assert.equal(pendBefore.length, 0, '前 2 处清剿不应掉落 captured_natalies（仅普通掠夺资源）');

  // 第 3 处清剿 → 掉落 captured_natalies（走标准待领取报告流程）
  const mvNatalie = 'mv-natalie';
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campIds[2], attackerWins: true, campCleared: true, movementId: mvNatalie, battleId: 'b2' },
  } as any);
  await tick();

  const st3 = await send(app, 'task.GetState', { villageId: va });
  const inst3 = st3.payload.active.find((a: any) => a.code === 's4');
  assert.ok(inst3.ready === false, '清剿 3 处后未抉择 captured_natalies 前不应就绪可交付');
  assert.ok(inst3.awaitingNatalieDecision === true, '清剿 3 处后应等待玩家抉择 captured_natalies');
  assert.equal(inst3.natalieDecision, null, '抉择前 natalieDecision 应为空');
  const pend = (app.store.all('treasure_pending') as any[]).filter((p) => p.villageId === va);
  assert.equal(pend.length, 1, '第 3 处清剿应掉落 1 件待领取宝物');
  assert.equal(pend[0].code, 'captured_natalies', '掉落应为「被囚禁的娜塔莉们」');
  assert.equal(pend[0].kind, 'camp', '掉落类型应为 camp（需军队归村后处理）');
  assert.ok(!pend[0].arrivedAt, '未归村前 arrivedAt 应未设置');

  // 模拟军队归村 → 标记到达
  const mark = await send(app, 'treasure.MarkPendingArrived', { movementId: mvNatalie });
  assert.equal(mark.ok, true, '标记归村应成功');
  const pendArr = app.store.get<any>('treasure_pending', mvNatalie);
  assert.ok(pendArr.arrivedAt, '归村后 arrivedAt 应设置');

  // 路径A：放入宝库（take）→ 入库 captured_natalies，获得 +20% 人口增长，无额外奖励
  const take = await send(app, 'treasure.ClaimPending', { movementId: mvNatalie, decision: 'take' });
  assert.equal(take.ok, true, `放入宝库应成功: ${take.reason ?? ''}`);
  const trA = app.store.get<any>('treasure', va);
  assert.ok([...trA.town, ...trA.treasury].includes('captured_natalies'), '放入宝库应入库 captured_natalies');
  assert.ok(![...trA.town, ...trA.treasury].includes('honest_heart'), '放入宝库不应给予正直的心（无任务奖励）');
  await tick();
  const popA = app.store.get<any>('population', va);
  assert.ok(popA.treasureGrowthMult >= 1.2 - 1e-9, `放入宝库应使人口增长倍率≥1.2（实际 ${popA.treasureGrowthMult}）`);
  // 放入宝库（take）后任务失败：保留宝物，但绝不能领取 S4 奖励。
  const stA = await send(app, 'task.GetState', { villageId: va });
  const instA = stA.payload.active.find((a: any) => a.code === 's4');
  assert.equal(instA, undefined, '放入宝库后调查坐标应以失败结束');
  assert.ok(stA.payload.abandonedSide.includes('s4'), '放入宝库后应记入已失败支线');
});
