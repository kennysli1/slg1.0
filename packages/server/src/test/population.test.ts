import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 人口系统单测（T8.1）：
 * - 增长收敛（复现设计§4.2 迭代表）
 * - 超限减员（粮仓触底后减员）
 * - 战死处理（v4 解耦：士兵不占人口，战死不回收人口，deadPop 全计永久损失）
 * - 解散驻村军队不返还人口（v4 解耦：士兵不占人口）
 * - 拓荒者配置（popPermanent=true）；v4 下 ReturnPop 对所有单位均返回 0
 * - 劳动力饱和加权收敛（effMult 随人口增加趋向 1.0）
 *
 * 注意：population.createVillage 是异步的（内部有多个 await commands.send），
 * 需要 flushMicrotasks() 等待其完成后再查询状态。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '人口测试村');
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

/**
 * population.createVillage 内部有 3 个 await points（GetLaborContext→GetCropContext→reportToEconomy），
 * 每个 await point 需要至少一个微任务周期。刷新 10 次确保完全完成。
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('人口：新村创建开局人口=城镇中心popCap（currentPop = mainPopCap，hardCap>currentPop）', async () => {
  const app = freshApp();
  await flushMicrotasks(); // 等待 population.createVillage 的异步初始化完成
  const r = await send(app, 'population.GetSnapshot', { villageId: 'v1' });
  assert.equal(r.ok, true, `GetPopulation 应成功: ${r.reason ?? ''}`);
  const p = r.payload as any;
  assert.ok(p.currentPop > 0, '初始人口应>0');
  assert.ok(p.hardCap > 0, '硬上限应>0');
  // v3 新模型：开局人口 = 城镇中心 1..mainLevel 的 popCap 之和（其他默认建筑只提供硬上限，不提供人口）
  const mainDef = app.config.buildings.main;
  let expectedMainPopCap = 0;
  for (let lv = 1; lv <= p.mainLevel; lv++) expectedMainPopCap += mainDef.levels[lv]?.popCap ?? 0;
  assert.equal(p.currentPop, expectedMainPopCap, `开局人口应=城镇中心popCap(${expectedMainPopCap})，实际 ${p.currentPop}`);
  assert.ok(p.hardCap > p.currentPop, `hardCap(${p.hardCap}) 应>currentPop(${p.currentPop})（其他建筑只提供上限）`);
  assert.ok(p.softLimit === p.availableLabor, '兼容别名 softLimit 应等于 availableLabor');
  // 开局未满员 → 存在正增长潜力
  assert.ok(p.growthPerHour > 0, `开局应有正增长潜力 growthPerHour，实际 ${p.growthPerHour}`);
});

test('人口：v4 训练不再扣人口（population 不变，仅士兵加耗粮）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 训练前人口（紧接建兵营完成后，未推进时钟）
  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const popBefore = snap0.currentPop;
  assert.ok(popBefore > 0, '初始人口应>0');

  // 训练 2 个军团兵
  const trainResult = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 2 });
  assert.equal(trainResult.ok, true, `训练应成功: ${trainResult.reason ?? ''}`);

  // 立即获取人口（不推进时钟，避免时间增长干扰）
  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // v4：训练对人口无任何影响（不再先扣后补）
  assert.equal(snap1.currentPop, popBefore, `v4 训练不应改变 currentPop（${popBefore}→${snap1.currentPop}）`);

  // ConsumePop 现在返回 consumed=0（不再扣除人口）
  const cR = await send(app, 'population.ConsumePop', { villageId: 'v1', unit: 'legionnaire', count: 2 });
  assert.equal(cR.ok, true, `ConsumePop 应成功: ${cR.reason ?? ''}`);
  assert.equal((cR.payload as any).consumed, 0, 'v4 ConsumePop 应返回 consumed=0（士兵不占人口）');
});

test('人口：v4 训练不再受人口不足限制（无 insufficient_population 拒绝）', async () => {
  const app = freshApp();
  await flushMicrotasks();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 训练前资源
  const ecoBefore = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;

  // v4：训练不受人口数量限制——充足资源下始终可训练（人口只影响增长，不影响出兵门槛）
  const r = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  assert.equal(r.ok, true, `v4 训练不应因人口不足被拒: ${r.reason ?? ''}`);
  assert.notEqual(r.reason, 'insufficient_population', 'v4 不应再有 insufficient_population 拒绝原因');

  // 资源被正常扣减（训练路径本身仍生效）
  const ecoAfter = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(ecoAfter.resources.wood < ecoBefore.resources.wood, '训练应扣资源（wood 下降）');
});

test('人口：v4 解散军队不返还人口（人口不变，仅减耗粮）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 训练 3 个军团兵
  const trainR = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 3 });
  assert.equal(trainR.ok, true, `训练应成功: ${trainR.reason ?? ''}`);

  // 等待训练完成（推进时间清空队列，使兵归队）
  for (let i = 0; i < 4; i++) await app.scheduler.advanceTo(clock + 30_000, setClock);
  await flushMicrotasks();

  // 解散前人口基准（此刻不推进时间，仅作为解散动作前的基准）
  const snapBefore = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const popBefore = snapBefore.currentPop;

  // 解散 2 个军团兵
  const disbandR = await send(app, 'military.DisbandTroops', { villageId: 'v1', units: { legionnaire: 2 } });
  assert.equal(disbandR.ok, true, `解散应成功: ${disbandR.reason ?? ''}`);
  assert.equal((disbandR.payload as any).returnedPop, 0, 'v4 解散不应返还人口（returnedPop=0）');

  // 立即获取人口（不推进时间以避免自然增长干扰）
  const snapAfter = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // v4：解散不改变人口（不返还）
  assert.equal(snapAfter.currentPop, popBefore, `v4 解散不应改变 currentPop（${popBefore}→${snapAfter.currentPop}）`);
  // 但军队减少、耗粮下降
  assert.ok(snapAfter.soldierPop <= snapBefore.soldierPop - 2 + 1e-6, `解散后 soldierPop 应下降（${snapBefore.soldierPop}→${snapAfter.soldierPop}）`);
});

test('人口：v4 所有单位 ReturnPop 均返回 0（士兵不占人口）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  // 验证 settler 配置
  const settlerDef = app.config.units['settler'];
  assert.ok(settlerDef, 'settler 应存在');
  assert.ok(settlerDef.popPermanent, 'settler 应是 popPermanent=true');
  assert.equal(settlerDef.popCost, 5, 'settler popCost 应为5');

  // v4：士兵不占人口 → ReturnPop 对任何单位都返回 0（无人口可返还）
  const returnR = await send(app, 'population.ReturnPop', {
    villageId: 'v1',
    units: { settler: 1 },
  });
  assert.equal(returnR.ok, true);
  assert.equal((returnR.payload as any).returned, 0, 'v4 settler ReturnPop 应返还0人口');

  // 普通兵种同样返回 0（v4 解耦，士兵不占人口 → 无人口可返还）
  const returnR2 = await send(app, 'population.ReturnPop', {
    villageId: 'v1',
    units: { legionnaire: 2 },
  });
  assert.equal(returnR2.ok, true);
  assert.equal((returnR2.payload as any).returned, 0, 'v4 普通兵 ReturnPop 应返还0人口');
});

test('人口：v4 RecoverCasualties 战死不回收人口（deadPop 全计永久损失）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  // ConsumePop 仅校验动员上限（不再扣 currentPop）→ 不影响后续回收断言
  const cR = await send(app, 'population.ConsumePop', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  assert.equal(cR.ok, true, `ConsumePop 应成功: ${cR.reason ?? ''}`);

  // 取基准人口（ConsumePop 不改变 currentPop，故即为当前值）
  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const initPop = snap0.currentPop;

  // 模拟战斗：10个军团兵阵亡（legionnaire: popCost=1 → deadPop=10）
  const recR = await send(app, 'population.RecoverCasualties', {
    villageId: 'v1',
    losses: { legionnaire: 10 },
  });
  assert.equal(recR.ok, true, `RecoverCasualties 应成功: ${recR.reason ?? ''}`);
  const p = recR.payload as any;
  // v4 解耦：士兵不占人口，战死不再回收劳动人口（recovered 恒为 0）；全部 deadPop 计为永久损失
  assert.equal(p.recovered, 0, `v4 回收数应为0（实际: ${p.recovered}）`);
  assert.equal(p.permanentDead, 10, `永久阵亡应为10（10×1）`);

  // 验证平民人口不变（不回收、不扣减）
  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  assert.equal(snap1.currentPop, initPop, `v4 战死不应改变 currentPop（${initPop}→${snap1.currentPop}）`);
  assert.ok(snap1.currentPop <= snap1.hardCap, `currentPop 不应超过 hardCap（${snap1.currentPop} vs ${snap1.hardCap}）`);
  // v4 无伤兵字段
  assert.equal(snap1.wounded, undefined, 'v4 快照不应含 wounded 字段');
});

test('人口：五轴繁荣度乘数（laborMults 字段正确，v3 统一为数值）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const r = await send(app, 'population.GetSnapshot', { villageId: 'v1' });
  assert.equal(r.ok, true, `GetPopulation 应成功: ${r.reason ?? ''}`);
  const snap = r.payload as any;

  // v3：laborMults 五个轴均为数值（五轴统一 prosperityMult）
  assert.ok(snap.laborMults, '应有劳动力倍率对象');
  for (const axis of ['production', 'build', 'train', 'research', 'smithy'] as const) {
    assert.ok(typeof snap.laborMults[axis] === 'number', `应有 ${axis} 倍率（数值）`);
  }

  // 五轴统一：所有倍率 = prosperityMult，且 ∈ [popLaborFloor, 1.0]（新模型：新村无士兵→平民占比100%→满值1.0）
  const c = app.config.constants;
  for (const axis of ['production', 'build', 'train', 'research', 'smithy'] as const) {
    const m = snap.laborMults[axis];
    assert.ok(m >= c.popLaborFloor - 0.01 && m <= 1.01,
      `${axis} 倍率应在[${c.popLaborFloor},1.0]，当前 ${m.toFixed(3)}`);
  }
  assert.ok(Math.abs(snap.laborMults.production - snap.prosperityMult) < 1e-6,
    'production 倍率应与 prosperityMult 一致');
});

test('人口：GetCropContext 口径验证（不含civilian_pop）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const cropCtx = await send(app, 'economy.GetCropContext', { villageId: 'v1' });
  assert.equal(cropCtx.ok, true);
  const p = cropCtx.payload as any;
  assert.ok(p.baseCropPerHour >= 0, 'baseCropPerHour 应≥0');
  assert.ok(p.buildingUpkeepPerHour >= 0, 'buildingUpkeepPerHour 应≥0');
  assert.ok(p.troopUpkeepPerHour >= 0, 'troopUpkeepPerHour 应≥0');
  // v3 人口模型：建筑不再耗粮（建筑只提供人口上限），buildingUpkeepPerHour 恒为 0
  assert.equal(p.buildingUpkeepPerHour, 0, 'v3：建筑不再耗粮，buildingUpkeepPerHour 应=0');
  assert.equal(p.troopUpkeepPerHour, 0, '新村无兵，军队维护应=0');
  // civilian_pop 不应计入这里（GetCropContext 口径定义：不含 civilian_pop）
  // 无法直接验证，但可以验证 upkeep 数值合理（不超过总产率）
  assert.ok(p.buildingUpkeepPerHour < p.baseCropPerHour * 2, '建筑维护应远小于总产率');
});

test('人口：building.GetLaborContext 返回正确格式', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const r = await send(app, 'building.GetLaborContext', { villageId: 'v1' });
  assert.equal(r.ok, true);
  const p = r.payload as any;
  assert.ok(typeof p.prosperity === 'number', '应有 prosperity 数字');
  // 新村预置建筑各Lv1：Σ level×prosperityPerLevel > 0
  assert.ok(p.prosperity > 0, `繁荣度应>0（当前 ${p.prosperity}）`);
  // v4：getLaborContext 不再返回 buildings 数组（laborAmplified 机制已删除，v4 删掉未投入使用的劳动力增幅）
  assert.equal(p.buildings, undefined, 'v4：GetLaborContext 不应含 buildings 数组');
});

test('人口：DisbandTroops 兵力不足时拒绝', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const r = await send(app, 'military.DisbandTroops', { villageId: 'v1', units: { legionnaire: 5 } });
  assert.equal(r.ok, false, '无兵时解散应失败');
  assert.equal(r.reason, 'insufficient_troops:legionnaire');
});

test('人口：开局未满员有增长空间（growthPerHour>0）；消耗人口后增长空间仍>0；长期收敛到硬上限后 growthPerHour=0', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const snap = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  assert.ok(snap.softLimit > 0, '软上限应>0');
  // v3 新模型：开局人口 = 城镇中心popCap < hardCap → 存在增长空间（速率=main.popGrowthPerLevel×mainLevel）
  assert.ok(snap.currentPop < snap.hardCap, `开局人口(${snap.currentPop}) 应<硬上限(${snap.hardCap})`);
  assert.ok(snap.growthPerHour > 0, `开局应有增长空间 growthPerHour>0（实际 ${snap.growthPerHour}）`);

  // v4：ConsumePop 不再改变 currentPop（士兵不占人口）——此处仅验证调用成功、增长空间仍>0
  const cR = await send(app, 'population.ConsumePop', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  assert.equal(cR.ok, true, `ConsumePop 应成功: ${cR.reason ?? ''}`);
  const snap2 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // 缺口 = 5（popCost=1×5），growthPerHour 应>0 且被缺口/速率夹住
  assert.ok(snap2.growthPerHour > 0, `消耗人口后应有增长空间 growthPerHour>0（实际 ${snap2.growthPerHour}）`);

  // 长期快进 → 收敛到 hardCap，增速归 0
  clock += 3_600_000 * 300;
  await app.scheduler.advanceTo(clock, setClock);
  await flushMicrotasks();
  const snap3 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  assert.equal(snap3.currentPop, snap3.hardCap, '长期快进后人口应收敛到 hardCap');
  assert.equal(snap3.growthPerHour, 0, '满员后 growthPerHour 应归0');
});

/**
 * 回归守卫（对应 2026-07-28 线上 BUG）：
 * 读操作 GetPopulation/GetSnapshot 必须对客户端推送「零副作用」——绝不能 emit population.Changed。
 *
 * 曾经的 BUG：settle() 在末尾无条件 emit population.Changed，而 settle 被 getSnapshot(读) 触发。
 * 于是客户端 refreshAll→GetPopulation→settle→emit→网关推 PopulationChanged→
 * 客户端 onPush→refreshAll→…… 形成正反馈死循环，页面每秒重渲成百次，
 * 用户点击时 DOM 节点被反复销毁重建 → 建筑空槽/升级、地图方向键「点了没反应」。
 *
 * 单元测试为何没兜住：所有测试都是「服务端单进程 直接调 command 断言结果」，
 * 从不模拟「客户端收到 push 后再次发起读请求」这条闭环——而死循环恰恰只在该闭环下浮现。
 * 本守卫用最小代价复现闭环的第一跳：读一次，断言它不产生任何推送。
 */
test('回归·读无副作用：GetPopulation 不得产生 population.Changed 推送', async () => {
  const app = freshApp();
  await flushMicrotasks();

  // 推进时钟，确保 settle 的 dtHours>0（否则会提前 return，无法复现 buggy 分支）
  setClock(clock + 60_000);

  let pushes = 0;
  app.bus.on('population.Changed', () => { pushes += 1; });

  // 纯读：连续读多次模拟客户端轮询/推送回环的首跳
  await send(app, 'population.GetSnapshot', { villageId: 'v1' });
  await send(app, 'population.GetSnapshot', { villageId: 'v1' });
  await send(app, 'population.GetSnapshot', { villageId: 'v1' });

  assert.equal(pushes, 0,
    `读操作(GetPopulation)不得 emit population.Changed（实际 ${pushes} 次）——` +
    '否则客户端 onPush→refreshAll→再读 会形成推送死循环，页面持续重渲导致点击失效');
});

/**
 * 与上条互补：离散写操作仍必须推送（否则客户端看不到即时变化）。
 * 训练（ConsumePop）仍应至少 emit 一次 population.Changed（consumePop 内显式 emit，consumed=0）。
 */
test('回归·写有推送：训练（ConsumePop）应 emit population.Changed', async () => {
  const app = freshApp();
  await flushMicrotasks();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  let pushes = 0;
  app.bus.on('population.Changed', () => { pushes += 1; });
  const r = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 2 });
  assert.equal(r.ok, true, `训练应成功: ${r.reason ?? ''}`);
  assert.ok(pushes >= 1, `训练扣人口应至少推送一次 population.Changed（实际 ${pushes} 次）`);
});
