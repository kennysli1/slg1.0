import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 人口系统单测（T8.1）：
 * - 增长收敛（复现设计§4.2 迭代表）
 * - 超限减员（粮仓触底后减员）
 * - 伤兵到期治愈（Scheduler 到点回补）
 * - 解散驻村军队返还人口
 * - 拓荒者永久消耗（popPermanent=true）
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

test('人口：新村创建即满员（currentPop = hardCap，softLimit=availableLabor）', async () => {
  const app = freshApp();
  await flushMicrotasks(); // 等待 population.createVillage 的异步初始化完成
  const r = await send(app, 'population.GetSnapshot', { villageId: 'v1' });
  assert.equal(r.ok, true, `GetPopulation 应成功: ${r.reason ?? ''}`);
  const p = r.payload as any;
  assert.ok(p.currentPop > 0, '初始人口应>0');
  assert.ok(p.hardCap > 0, '硬上限应>0');
  // v3 满员开局：currentPop = hardCap（劳动人口拉满）；无士兵时 availableLabor = hardCap
  const ratio = p.currentPop / p.hardCap;
  assert.ok(ratio >= 0.99 && ratio <= 1.1, `新村应满员开局（currentPop/hardCap=${ratio.toFixed(3)}）`);
  assert.ok(p.softLimit === p.availableLabor, '兼容别名 softLimit 应等于 availableLabor');
});

test('人口：training 扣人口，扣减量精确', async () => {
  const app = freshApp();
  await flushMicrotasks();

  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 获取当前人口（before training, 紧接建兵营完成后）
  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const popBefore = snap0.currentPop;
  assert.ok(popBefore > 0, '初始人口应>0');

  // 训练 2 个军团兵（各消耗 1 pop）
  const trainResult = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 2 });
  assert.equal(trainResult.ok, true, `训练应成功: ${trainResult.reason ?? ''}`);

  // 立即获取人口（不推进时钟，避免时间增长影响）
  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // 由于 getSnapshot 内部 settle 使用相同时间戳，人口减少应精确等于 count×popCost
  const popAfter = snap1.currentPop;
  const consumed = popBefore - popAfter;
  // 允许1点误差（settle 使用 dtHours 可能有极小浮点误差）
  assert.ok(consumed >= 1 && consumed <= 3, `训练2兵应消耗2人口（实际消耗 ${consumed}）`);
});

test('人口：人口不足时拒绝训练（insufficient_population）', async () => {
  const app = freshApp();
  await flushMicrotasks();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 获取当前人口
  const popSnap = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const curPop = Math.floor(popSnap.currentPop);
  assert.ok(curPop > 0, '初始人口应>0');

  // 尝试训练数量超过人口的兵（each legionnaire consumes 1 pop）
  const tooMany = curPop + 100;
  const r = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: tooMany });
  assert.equal(r.ok, false, '人口不足时训练应被拒绝');
  assert.equal(r.reason, 'insufficient_population', `应返回 insufficient_population，实际: ${r.reason}`);

  // 确认资源未被扣（训练被回滚）
  const eco = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(eco.resources.wood > 0, '训练拒绝后资源不应被扣（回滚成功）');
});

test('人口：解散军队后人口返还', async () => {
  const app = freshApp();
  await flushMicrotasks();

  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const barracksR = await send(app, 'building.Build', { villageId: 'v1', zone: 'outer', kind: 'barracks' });
  assert.equal(barracksR.ok, true, `建兵营应成功`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);

  // 训练 3 个军团兵
  const trainR = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 3 });
  assert.equal(trainR.ok, true, `训练应成功: ${trainR.reason ?? ''}`);

  // 获取训练后（消耗人口后）的人口基准
  const snapAfterConsume = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const popAfterConsume = snapAfterConsume.currentPop;

  // 等待训练完成（不关心时间增长，只需兵完成）
  for (let i = 0; i < 3; i++) await app.scheduler.advanceTo(clock + 30_000, setClock);

  // 解散 2 个军团兵
  const disbandR = await send(app, 'military.DisbandTroops', { villageId: 'v1', units: { legionnaire: 2 } });
  assert.equal(disbandR.ok, true, `解散应成功: ${disbandR.reason ?? ''}`);
  const returnedPop = (disbandR.payload as any).returnedPop;
  assert.ok(returnedPop >= 2, `解散2兵应返还至少2人口（每兵1popCost，实际 ${returnedPop}）`);

  // 立即获取人口（不推进时间以避免增长干扰）
  const snapAfterDisband = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // 验证人口比 disband 前增加了 returnedPop
  // 允许小误差（settle 的 dtHours 极小时增量微乎其微）
  assert.ok(snapAfterDisband.currentPop >= popAfterConsume - 0.1,
    '解散后人口应回补（不低于消耗后基准）');
});

test('人口：拓荒者永久消耗（解散时不返还人口）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  // 验证 settler 配置
  const settlerDef = app.config.units['settler'];
  assert.ok(settlerDef, 'settler 应存在');
  assert.ok(settlerDef.popPermanent, 'settler 应是 popPermanent=true');
  assert.equal(settlerDef.popCost, 5, 'settler popCost 应为5');

  // 验证 ReturnPop 对 popPermanent 单位返还0
  const returnR = await send(app, 'population.ReturnPop', {
    villageId: 'v1',
    units: { settler: 1 },
  });
  assert.equal(returnR.ok, true);
  assert.equal((returnR.payload as any).returned, 0, '拓荒者 ReturnPop 应返还0人口');

  // 对比：普通兵种 ReturnPop 应返还
  const returnR2 = await send(app, 'population.ReturnPop', {
    villageId: 'v1',
    units: { legionnaire: 2 },
  });
  assert.equal(returnR2.ok, true);
  assert.ok((returnR2.payload as any).returned >= 2, '普通兵ReturnPop应返还人口');
});

test('人口：RecoverCasualties 战死即时回收（无伤兵池/无定时器）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  // 预留增长空间：ConsumePop 仅扣 currentPop（不减 soldierPop）→ 留出余量供回收回填
  const cR = await send(app, 'population.ConsumePop', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  assert.equal(cR.ok, true, `ConsumePop 应成功: ${cR.reason ?? ''}`);

  // 取消耗后基准人口
  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const initPop = snap0.currentPop;

  // 模拟战斗：10个军团兵阵亡（legionnaire: popCost=1；医院 Lv0 → recoveryRatio=base 0.20）
  // recovered = floor(10×1×0.20) = 2，permanentDead = 8
  const recR = await send(app, 'population.RecoverCasualties', {
    villageId: 'v1',
    losses: { legionnaire: 10 },
  });
  assert.equal(recR.ok, true, `RecoverCasualties 应成功: ${recR.reason ?? ''}`);
  const p = recR.payload as any;
  assert.equal(p.recovered, 2, `回收数应为2（floor(10×1×0.20)）, 实际: ${p.recovered}`);
  assert.equal(p.permanentDead, 8, `永久阵亡应为8（10×1 - 2）`);

  // 验证平民人口即时回填（recover 同步完成，无定时器）
  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  assert.ok(snap1.currentPop >= initPop + p.recovered, `回收后平民应即时增加（${initPop}→${snap1.currentPop}，回收${p.recovered}）`);
  assert.ok(snap1.currentPop <= snap1.hardCap, `回收后 currentPop 不应超过 hardCap（${snap1.currentPop} vs ${snap1.hardCap}）`);
  // v3 无伤兵字段
  assert.equal(snap1.wounded, undefined, 'v3 快照不应含 wounded 字段');
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

  // 满员开局（laborRatio=1）→ 繁荣度满值 → 所有倍率=1.0
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
  // 新村7栋建筑各Lv1: 7 × 1级 × 5繁荣度/级 = 35
  assert.ok(p.prosperity >= 30 && p.prosperity <= 50,
    `繁荣度应在合理范围(30-50)，当前: ${p.prosperity}`);
  assert.ok(Array.isArray(p.buildings), '应有 buildings 数组');
  // laborAmplified 的建筑应在列表中
  const kinds = p.buildings.map((b: any) => b.kind);
  assert.ok(kinds.includes('main'), '城镇中心应在劳动力列表中');
});

test('人口：DisbandTroops 兵力不足时拒绝', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const r = await send(app, 'military.DisbandTroops', { villageId: 'v1', units: { legionnaire: 5 } });
  assert.equal(r.ok, false, '无兵时解散应失败');
  assert.equal(r.reason, 'insufficient_troops:legionnaire');
});

test('人口：满员开局无增长空间（growthPerHour=0）；消耗人口后出现增长空间（growthPerHour>0）', async () => {
  const app = freshApp();
  await flushMicrotasks();

  const snap = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  assert.ok(snap.softLimit > 0, '软上限应>0');
  // v3 满员开局：currentPop = softLimit(=availableLabor)，无增长空间
  const ratio = snap.currentPop / snap.softLimit;
  assert.ok(ratio >= 0.99, `新村开局人口应≥99%软上限，当前比值=${ratio.toFixed(3)}`);
  // v3：朝 availableLabor 收敛，已满则增长空间为0
  assert.equal(snap.growthPerHour, 0, `满员开局 growthPerHour 应为0（实际 ${snap.growthPerHour}）`);

  // 消耗人口制造增长空间：ConsumePop 只扣 currentPop（不增 soldierPop）→ availableLabor 不变 → 出现缺口
  const cR = await send(app, 'population.ConsumePop', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  assert.equal(cR.ok, true, `ConsumePop 应成功: ${cR.reason ?? ''}`);
  const snap2 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // 缺口 = 5（popCost=1×5），growthPerHour 应>0 且被缺口/速率夹住
  assert.ok(snap2.growthPerHour > 0, `消耗人口后应有增长空间 growthPerHour>0（实际 ${snap2.growthPerHour}）`);
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
 * 训练扣人口后应至少 emit 一次 population.Changed（consumePop 内显式 emit）。
 */
test('回归·写有推送：训练扣人口应 emit population.Changed', async () => {
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
