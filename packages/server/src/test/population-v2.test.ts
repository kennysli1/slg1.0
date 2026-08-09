/**
 * 人口系统 v3 回归测试（硬上限模型）
 *
 * 覆盖设计文档 13/14「硬上限重做」核心不变量：
 *  C1  三部族 createVillage 开局人口=城镇中心popCap：currentPop=Σmain[1..level].popCap，hardCap>currentPop（其他默认建筑只提供上限），softLimit===availableLabor
 *  C2  平民占比驱动繁荣度：新村无士兵→平民占总人口100%→繁荣度满值1.0；建兵营抬高硬上限不降繁荣度（与上限解耦，原「升级得负收益」bug 已修复）；
 *      征兵(setGarrisonPop)降平民占比→降繁荣度（仍≥popLaborFloor）；五轴统一；开局存在正增长潜力(growthPerHour>0)
 *  C3  全部兵种 cropPerHourEach>0（士兵以 upkeep 计入口粮，训练严格增加粮食压力）
 *  C4  增长朝 availableLabor 线性收敛：growthPerHour = main.popGrowthPerLevel×mainLevel，夹在缺口内
 *  C5  平民口粮口径 = currentPop×popCropPerLabor（快照 civilianCropPerHour）
 *  C6  极端粮荒 currentPop 降至 0，v3 无伤兵字段（无 woundedPool/无定时器）
 *  C7  粮荒正确停止 → recovery 事件，inFamine 变 false
 *  C8  训练后 currentPop 不变、soldierPop 上升（v4 解耦：士兵不占人口）
 *  C9  resume 对已有驻军也上报 soldierPop
 *  C10 GetSnapshot 公共字段齐全（v3 字段集）
 *  C11 settle 永不 emit（GetSnapshot 纯读零副作用）
 * 补充 nonCivilianUpkeep 不含 civilian_pop
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

// ── 测试工具 ────────────────────────────────────────────────────────────────

let clock = 1_000_000;
const setClock = (t: number) => { clock = t; };
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const tick = (ms: number) => { clock += ms; };
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
async function flush(n = 60): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** 注册玩家并等待其村庄（含 population 状态）异步初始化完成。 */
async function reg(app: GameApp, name: string, tribe = 'romans'): Promise<string> {
  const r = await app.commands.send({
    name: 'player.Register', from: 'test',
    payload: { name, password: 'pass123', tribe },
  });
  assert.ok(r.ok, `注册 ${name} 应成功`);
  const vid = (r.payload as any).player.villageId as string;
  await flush();
  return vid;
}

// ── C1：三部族满员 ────────────────────────────────────────────────────────

for (const tribe of ['romans', 'gauls', 'teutons'] as const) {
  test(`v3 C1 [${tribe}] createVillage 开局人口=城镇中心popCap：hardCap>currentPop 且 softLimit===availableLabor`, async () => {
    const app = freshApp();
    const vid = await reg(app, `c1-${tribe}`, tribe);
    const snap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
    assert.ok(snap.hardCap > 0, `[${tribe}] hardCap 应>0（实际 ${snap.hardCap}）`);
    // 开局人口 = 城镇中心 1..mainLevel 的 popCap 之和（其他默认建筑只提供硬上限，不提供人口）
    const mainDef = app.config.buildings.main;
    let expectedMainPopCap = 0;
    for (let lv = 1; lv <= snap.mainLevel; lv++) expectedMainPopCap += mainDef.levels[lv]?.popCap ?? 0;
    assert.equal(snap.currentPop, expectedMainPopCap, `[${tribe}] currentPop 应=城镇中心popCap(${expectedMainPopCap})，实际 ${snap.currentPop}`);
    assert.ok(snap.hardCap > snap.currentPop, `[${tribe}] hardCap(${snap.hardCap}) 应>currentPop(${snap.currentPop})（其他建筑只提供上限）`);
    assert.equal(snap.softLimit, snap.availableLabor, 'v3 兼容别名 softLimit 应等于 availableLabor');
    assert.equal(snap.soldierPop, 0, '新村无士兵，soldierPop=0');
  });
}

// ── C2：平民占比驱动繁荣度（与硬上限解耦）─────────────────────────────────

test('v3 C2：平民占比驱动繁荣度——新村满值、升上限不变、征兵下降', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c2', 'romans');
  const floor = app.config.constants.popLaborFloor;

  // 1) 新村：无士兵 → 平民占总人口=100% → 繁荣度满值（与硬上限无关）
  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.equal(snap0.soldierPop, 0, '新村应无士兵');
  assert.ok(snap0.laborRatio > 0 && snap0.laborRatio <= 1.0 + 1e-6, `laborRatio 应∈(0,1]，实际 ${snap0.laborRatio}`);
  assert.ok(Math.abs(snap0.laborRatio - 1) < 1e-6, `无士兵→平民占比应≈100%，实际 ${snap0.laborRatio}`);
  // 平民占比 100% → prosperityBonus=1 → prosperityMult=1.0（满值，与人口上限无关）
  assert.ok(Math.abs(snap0.prosperityMult - 1) < 1e-6, `无士兵 prosperityMult 应≈1.0，实际 ${snap0.prosperityMult}`);
  // 存在增长潜力：growthPerHour>0（速率=main.popGrowthPerLevel×mainLevel，缺口>0）
  assert.ok(snap0.growthPerHour > 0, `开局应有正增长潜力 growthPerHour，实际 ${snap0.growthPerHour}`);
  // 五轴统一
  for (const axis of ['production', 'build', 'train', 'research', 'smithy'] as const) {
    assert.ok(typeof snap0.laborMults[axis] === 'number', `应有 ${axis} 倍率（数值）`);
    assert.ok(Math.abs(snap0.laborMults[axis] - snap0.prosperityMult) < 1e-6, `${axis} 倍率应=prosperityMult`);
  }

  // 2) 建兵营抬高硬上限：currentPop/soldierPop 不变 → 平民占比与繁荣度不变（证明与硬上限解耦，原「升级得负收益」bug 已修复）
  const before = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const buildRes = await send(app, 'building.Build', { villageId: vid, zone: 'outer', kind: 'barracks' });
  assert.equal(buildRes.ok, true, `建兵营应成功: ${buildRes.reason ?? ''}`);
  tick(60_000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush();
  const afterBuild = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.ok(afterBuild.hardCap > before.hardCap, `建兵营应提高 hardCap（${before.hardCap}→${afterBuild.hardCap}）`);
  assert.ok(
    Math.abs(afterBuild.prosperityMult - before.prosperityMult) < 1e-6,
    `升上限不应降低繁荣度（${before.prosperityMult}→${afterBuild.prosperityMult}）`,
  );
  assert.ok(
    Math.abs(afterBuild.laborRatio - before.laborRatio) < 1e-6,
    `升上限不应改变平民占比（${before.laborRatio}→${afterBuild.laborRatio}）`,
  );

  // 3) 征兵（SetGarrisonPop）：平民占比下降 → 繁荣度下降（仍≥popLaborFloor）
  await send(app, 'population.SetGarrisonPop', { villageId: vid, popCostSum: 1000 });
  await flush();
  const afterSoldiers = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.ok(afterSoldiers.soldierPop > 0, `应有士兵上报，实际 ${afterSoldiers.soldierPop}`);
  assert.ok(afterSoldiers.laborRatio < before.laborRatio - 1e-6, `征兵后平民占比应下降（${before.laborRatio}→${afterSoldiers.laborRatio}）`);
  assert.ok(afterSoldiers.prosperityMult < before.prosperityMult - 1e-6, `征兵后繁荣度应下降（${before.prosperityMult}→${afterSoldiers.prosperityMult}）`);
  assert.ok(afterSoldiers.prosperityMult >= floor - 1e-6, `繁荣度不应低于 popLaborFloor(${floor})，实际 ${afterSoldiers.prosperityMult}`);
});

// ── C3：兵种口粮 ──────────────────────────────────────────────────────────

test('v3 C3：GetArmy.trainable 每兵种 cropPerHourEach > 0（士兵以 upkeep 计入口粮）', async () => {
  const app = freshApp();
  const r = await reg(app, 'c3r', 'romans');
  const g = await reg(app, 'c3g', 'gauls');
  const t = await reg(app, 'c3t', 'teutons');
  for (const vid of [r, g, t]) {
    const res = await send(app, 'military.GetArmy', { villageId: vid });
    assert.equal(res.ok, true, `${vid} GetArmy 应成功`);
    const trainable = (res.payload as any).trainable as any[];
    assert.ok(trainable.length > 0, `${vid} 应有可训练兵种`);
    for (const u of trainable) {
      assert.ok(u.cropPerHourEach > 0, `[${vid}] 兵种 ${u.key} cropPerHourEach=${u.cropPerHourEach} 应>0`);
    }
  }
  const allCount = (
    await Promise.all([r, g, t].map((vid) => send(app, 'military.GetArmy', { villageId: vid })))
  ).reduce((sum, rr) => sum + ((rr.payload as any).trainable as any[]).length, 0);
  assert.ok(allCount >= 9, `三部族总兵种数应≥9（实际 ${allCount}）`);
});

// ── C4：增长线性收敛 ──────────────────────────────────────────────────────

test('v3 C4：增长朝 availableLabor 线性收敛（main.popGrowthPerLevel × mainLevel）', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c4', 'romans');

  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const hardCap: number = snap0.hardCap;
  const mainLevel: number = snap0.mainLevel;
  const rate = (app.config.buildings.main?.popGrowthPerLevel ?? 0) * mainLevel;
  // 开局人口=城镇中心popCap(未满员)：缺口>0 → 增速=min(gap, rate)=rate
  assert.equal(snap0.growthPerHour, Math.min(hardCap - snap0.currentPop, rate), '开局 growthPerHour 应为 min(gap, rate)');

  // 扣一部分劳动人口（不超过当前人口），制造增长缺口
  const consumeCount = Math.max(1, Math.min(5, snap0.currentPop - 1));
  const cRes = await send(app, 'population.ConsumePop', { villageId: vid, unit: 'legionnaire', count: consumeCount });
  assert.equal(cRes.ok, true, `ConsumePop 应成功: ${cRes.reason ?? ''}`);
  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const gap = hardCap - snap1.currentPop;
  const expectedGrowth = Math.min(gap, rate);
  assert.ok(
    Math.abs(snap1.growthPerHour - expectedGrowth) < 1e-6,
    `growthPerHour 应为 min(gap, main.popGrowthPerLevel*mainLevel)=${expectedGrowth}，实际 ${snap1.growthPerHour}`,
  );

  // 快进 1 小时：人口应增长（不超 rate）
  tick(3_600_000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush();
  const snap2 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const grown = snap2.currentPop - snap1.currentPop;
  assert.ok(grown > 0 && grown <= expectedGrowth + 1, `1 小时后人口应增长(${grown})，不超过 ${expectedGrowth}`);

  // 长期快进 → 收敛到 hardCap，增速归 0
  tick(3_600_000 * 300);
  await app.scheduler.advanceTo(clock, setClock);
  await flush();
  const snap3 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.equal(snap3.currentPop, hardCap, '长期快进后人口应收敛到 hardCap');
  assert.equal(snap3.growthPerHour, 0, '满员后 growthPerHour 应归0');
});

// ── C5：平民口粮口径 ──────────────────────────────────────────────────────

test('v3 C5：平民口粮口径 = currentPop × popCropPerLabor（快照 civilianCropPerHour）', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c5', 'romans');
  const snap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const c = app.config.constants;
  const expected = Math.round(snap.currentPop * c.popCropPerLabor * 10) / 10;
  assert.ok(
    Math.abs(snap.civilianCropPerHour - expected) < 1e-6,
    `civilianCropPerHour 应=currentPop×popCropPerLabor(${expected})，实际 ${snap.civilianCropPerHour}`,
  );
});

// ── C6：极端粮荒 → P=0，无伤兵字段 ───────────────────────────────────────

test('v3 C6：极端粮荒 currentPop 最终降至 0，无 wounded 字段', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c6', 'romans');

  // 制造极端赤字：净产率 << 0
  await send(app, 'economy.SetBaseRate', { villageId: vid, resource: 'crop', ratePerHour: 0.001 });
  await send(app, 'economy.SetUpkeep', { villageId: vid, source: 'test_extreme', cropPerHour: 9999999 });

  tick(3_600_000);
  await app.scheduler.advanceTo(clock, setClock);
  await send(app, 'economy.GetResources', { villageId: vid });
  await flush(100);

  const famineEvents: any[] = [];
  app.bus.on('population.Changed', (e: any) => { famineEvents.push(e); });

  const tickSec = app.config.constants.popFamineTickSec;
  for (let i = 0; i < 400; i++) {
    tick(tickSec * 1000 + 1000);
    await app.scheduler.advanceTo(clock, setClock);
    await flush(20);
    const s = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
    if (s.currentPop <= 0) break;
  }

  const snapFinal = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.equal(snapFinal.currentPop, 0, `极端粮荒后 currentPop 应为0（实际 ${snapFinal.currentPop}）`);
  assert.equal(snapFinal.wounded, undefined, 'v3 不应含 wounded 字段');

  assert.ok(famineEvents.length > 0, '应有 population.Changed 事件（famine/death）');
  for (const evt of famineEvents) {
    const p = evt.payload;
    assert.ok(typeof p.currentPop === 'number', 'famine 事件应有 currentPop');
    assert.ok(typeof p.inFamine === 'boolean', 'famine 事件应有 inFamine');
    assert.ok(typeof p.laborRatio === 'number', 'famine 事件应有 laborRatio');
    assert.ok(typeof p.availableLabor === 'number', 'famine 事件应有 availableLabor');
    assert.ok(typeof p.prosperityMult === 'number', 'famine 事件应有 prosperityMult');
    assert.equal(p.wounded, undefined, 'v3 事件不应含 wounded');
  }
});

// ── C7：粮荒恢复事件 ──────────────────────────────────────────────────────

test('v3 C7：粮荒停止后发出 recovery 事件，inFamine 变 false', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c7', 'romans');

  const c7c = app.config.constants;
  const initSnap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const initPop = initSnap.currentPop as number;
  // 新模型开局人口=城镇中心popCap（约20，远低于硬上限），需把口粮压力放大足以在 8h 内耗尽存量
  const modestUpkeep = initPop * c7c.popCropPerLabor * 8;
  await send(app, 'economy.SetBaseRate', { villageId: vid, resource: 'crop', ratePerHour: 0.001 });
  await send(app, 'economy.SetUpkeep', { villageId: vid, source: 'test_heavy', cropPerHour: modestUpkeep });

  // 推进足够长时间使粮食存量耗尽并触发赤字边沿（modestUpkeep≈initPop×2/hr，起始 crop=750 需约 6h 触底）
  tick(8 * 3600_000);
  await app.scheduler.advanceTo(clock, setClock);
  await send(app, 'economy.GetResources', { villageId: vid });
  await flush(100);

  // 进入第一个 famine tick
  tick(c7c.popFamineTickSec * 1000 + 1000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush(100);

  const snapInFamine = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.equal(snapInFamine.inFamine, true, '粮荒状态下 inFamine 应为 true');

  // 注册 recovery 监听
  const recoveryEvents: any[] = [];
  app.bus.on('population.Changed', (e: any) => {
    if (e.payload?.event === 'recovery') recoveryEvents.push(e);
  });

  // 恢复粮食
  await send(app, 'economy.SetUpkeep', { villageId: vid, source: 'test_heavy', cropPerHour: 0 });
  await send(app, 'economy.SetBaseRate', { villageId: vid, resource: 'crop', ratePerHour: 99999 });
  await send(app, 'economy.Grant', { villageId: vid, gain: { crop: 9999999 } });
  await flush(50);

  tick(c7c.popFamineTickSec * 1000 + 1000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush(100);

  assert.ok(recoveryEvents.length > 0, '恢复粮食后的 famine tick 应发出 recovery 事件');
  const snapRecovered = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.equal(snapRecovered.inFamine, false, '恢复后 inFamine 应为 false');
});

// ── C8：训练 → currentPop 不变（v4 解耦）、soldierPop 升 ──────────────────

test('v4 C8：训练后 currentPop 不变、soldierPop 上升（经济一致）', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c8', 'romans');
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  await send(app, 'building.Build', { villageId: vid, zone: 'outer', kind: 'barracks' });
  tick(30_000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush();

  const snap0 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const pop0 = snap0.currentPop;

  await send(app, 'military.TrainTroops', { villageId: vid, unit: 'legionnaire', count: 3 });
  for (let i = 0; i < 3; i++) { tick(5_000); await app.scheduler.advanceTo(clock, setClock); await flush(); }

  const snap1 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  // v4：训练不再改动人口（无先扣后补），故 currentPop 不会下降（自然增长只可能上升）
  assert.ok(snap1.currentPop >= pop0 - 1e-6, `v4 训练不应减少 currentPop（${pop0}→${snap1.currentPop}）`);
  assert.ok(snap1.soldierPop >= 3 - 0.01, `soldierPop 应≈3（${snap1.soldierPop}）`);
});

// ── C9：resume 上报 soldierPop ────────────────────────────────────────────

test('v3 C9：military.resume 对已有驻军也上报 soldierPop', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c9', 'romans');
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  await send(app, 'building.Build', { villageId: vid, zone: 'outer', kind: 'barracks' });
  tick(30_000);
  await app.scheduler.advanceTo(clock, setClock);
  await flush();
  await send(app, 'military.TrainTroops', { villageId: vid, unit: 'legionnaire', count: 4 });
  for (let i = 0; i < 4; i++) { tick(5_000); await app.scheduler.advanceTo(clock, setClock); await flush(); }

  const army = (await send(app, 'military.GetArmy', { villageId: vid })).payload as any;
  assert.equal(army.troops?.legionnaire ?? 0, 4, '驻村应有4个军团兵');

  // 模拟重启：清零 economy 的 troops upkeep
  await send(app, 'economy.SetUpkeep', { villageId: vid, source: 'troops', cropPerHour: 0 });
  await flush(20);
  const ctxBefore = (await send(app, 'economy.GetCropContext', { villageId: vid })).payload as any;
  assert.equal(ctxBefore.troopUpkeepPerHour, 0, '清零后 troopUpkeep 应为0');

  app.military.resume();
  await flush(100);
  const ctxAfter = (await send(app, 'economy.GetCropContext', { villageId: vid })).payload as any;
  const legDef = app.config.units['legionnaire']!;
  assert.ok(ctxAfter.troopUpkeepPerHour >= 4 * legDef.upkeep - 0.01, 'resume 后 troopUpkeep 应恢复');

  const snapAfter = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  assert.ok(snapAfter.soldierPop >= 4 * legDef.popCost - 0.01, `resume 后 soldierPop(${snapAfter.soldierPop}) 应≥${4 * legDef.popCost}`);
});

// ── C10：GetSnapshot 公共字段齐全 ─────────────────────────────────────────

test('v3 C10：GetSnapshot 公共字段完整（v3 字段集）', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c10', 'romans');
  const snap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;

  const required = [
    'villageId', 'currentPop', 'soldierPop', 'hardCap', 'availableLabor',
    'laborRatio', 'prosperityBonus', 'prosperityMult', 'growthPerHour',
    'mobilizeCap', 'mainLevel', 'inFamine', 'civilianCropPerHour', 'softLimit',
  ] as const;
  for (const field of required) {
    assert.ok(field in snap, `GetSnapshot 应包含字段: ${field}`);
    assert.ok(snap[field] !== undefined, `字段 ${field} 不应为 undefined`);
  }
  assert.ok(snap.laborMults && typeof snap.laborMults === 'object', '应有 laborMults 对象');
  for (const axis of ['production', 'build', 'train', 'research', 'smithy'] as const) {
    assert.ok(typeof snap.laborMults[axis] === 'number', `laborMults.${axis} 应为数值`);
  }
  // 类型校验
  assert.equal(typeof snap.currentPop, 'number');
  assert.equal(typeof snap.soldierPop, 'number');
  assert.equal(typeof snap.hardCap, 'number');
  assert.equal(typeof snap.availableLabor, 'number');
  assert.equal(typeof snap.prosperityMult, 'number');
  assert.equal(typeof snap.inFamine, 'boolean');
  // 范围
  assert.ok(snap.laborRatio >= 0 && snap.laborRatio <= 1, `laborRatio(${snap.laborRatio}) 应在 [0,1]`);
  assert.ok(snap.prosperityMult >= app.config.constants.popLaborFloor - 0.01 && snap.prosperityMult <= 1.01,
    `prosperityMult 应在 [popLaborFloor,1.0]（${snap.prosperityMult}）`);
  assert.equal(snap.softLimit, snap.availableLabor, 'softLimit 应等于 availableLabor');

  // push 事件也含这些字段（通过 ConsumePop 触发）
  const pushed: any[] = [];
  app.bus.on('population.Changed', (e: any) => { pushed.push(e); });
  await send(app, 'population.ConsumePop', { villageId: vid, unit: 'legionnaire', count: 1 });
  await flush(50);
  if (pushed.length > 0) {
    const ep = pushed[0].payload;
    for (const field of required) {
      assert.ok(field in ep, `population.Changed 事件应包含字段: ${field}`);
    }
    assert.ok('event' in ep, '事件应有 event 字段（consumed/famine/recovery/recovered/...）');
  }
});

// ── C11：settle 永不 emit ─────────────────────────────────────────────────

test('v3 C11：GetSnapshot × 10 不产生任何 population.Changed 推送', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c11', 'romans');

  let pushCount = 0;
  app.bus.on('population.Changed', () => { pushCount += 1; });

  for (let i = 0; i < 10; i++) {
    tick(600_000);
    await send(app, 'population.GetSnapshot', { villageId: vid });
    await flush(50);
  }

  assert.equal(pushCount, 0, `GetSnapshot × 10 不应 emit population.Changed（实际 ${pushCount} 次）`);
});

// ── 补充：nonCivilianUpkeep 不含 civilian_pop ─────────────────────────────

test('v3 补充：nonCivilianUpkeep 不含 civilian_pop，且建筑不再耗粮', async () => {
  const app = freshApp();
  const vid = await reg(app, 'cex', 'romans');

  const r = await send(app, 'economy.GetCropContext', { villageId: vid });
  assert.equal(r.ok, true);
  const p = r.payload as any;

  assert.ok(typeof p.nonCivilianUpkeep === 'number');
  assert.ok(p.nonCivilianUpkeep >= 0);
  // v3：建筑不再耗粮，buildingUpkeepPerHour 恒为 0
  assert.equal(p.buildingUpkeepPerHour, 0, 'v3：建筑不再耗粮，buildingUpkeepPerHour 应=0');
  assert.ok(p.nonCivilianUpkeep >= p.buildingUpkeepPerHour, `nonCivilianUpkeep(${p.nonCivilianUpkeep}) ≥ buildingUpkeep(${p.buildingUpkeepPerHour})`);

  const snap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const c = app.config.constants;
  const civilianCrop = snap.currentPop * c.popCropPerLabor;
  assert.ok(
    p.nonCivilianUpkeep < civilianCrop * 0.5 || snap.currentPop === 0,
    `nonCivilianUpkeep(${p.nonCivilianUpkeep}) 不应包含 civilian_pop 口粮（≈${civilianCrop.toFixed(1)}）`,
  );
});

// ── C12：动员上限（popRaceMobilizeMax）───────────────────────────────────────

test('v3 C12：动员上限——士兵占总人口比例不得超过本部族 popRaceMobilizeMax（罗马0.75）', async () => {
  const app = freshApp();
  const vid = await reg(app, 'c12', 'romans'); // 罗马 cap=0.75
  const cap = app.config.constants.popRaceMobilizeMax.romans;
  assert.ok(cap > 0 && cap <= 1, `cap 应在(0,1]，实际 ${cap}`);

  // 反复训练 1 个军团兵（popCost=1）：总兵力达上限附近后，下一批应被 mobilize_cap_exceeded 拒绝。
  // 注意：v4 解耦后 availableLabor=hardCap（士兵不再挤占增长目标），训练过程中平民可长到满 housing，
  // 故动员上限（士兵 ≤ 75%×(平民+士兵)）需要更多兵才触顶——迭代上限需足够大（远超 v3 的 60）。
  let rejected = false;
  for (let i = 0; i < 400 && !rejected; i++) {
    await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
    const r = await send(app, 'military.TrainTroops', { villageId: vid, unit: 'legionnaire', count: 1 });
    if (!r.ok) {
      if (r.reason === 'requires_building:barracks') {
        // 首轮建兵营
        const b = await send(app, 'building.Build', { villageId: vid, zone: 'outer', kind: 'barracks' });
        assert.equal(b.ok, true, `建兵营应成功: ${b.reason ?? ''}`);
        tick(30_000); await app.scheduler.advanceTo(clock, setClock); await flush();
        continue;
      }
      if (r.reason === 'mobilize_cap_exceeded') { rejected = true; break; }
      // queue_busy 等：推进时间清空队列后重试
      for (let j = 0; j < 8; j++) { tick(5_000); await app.scheduler.advanceTo(clock, setClock); await flush(); }
      continue;
    }
    // 训练成功：推进时间清空训练队列
    for (let j = 0; j < 8; j++) { tick(5_000); await app.scheduler.advanceTo(clock, setClock); await flush(); }
  }

  assert.ok(rejected, '训练至超过 75% 应被 mobilize_cap_exceeded 拒绝');

  const snap = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
  const total = snap.currentPop + snap.soldierPop;
  const soldierFrac = total > 0 ? snap.soldierPop / total : 0;
  assert.ok(soldierFrac <= cap + 1e-6, `士兵占比(${soldierFrac.toFixed(3)}) 应≤ cap(${cap})`);
  assert.ok(snap.mobilizeCap === cap, `快照应下发 mobilizeCap=${cap}（实际 ${snap.mobilizeCap}）`);
});

test('v3 C12b：高卢(0.70)/条顿(0.80) 动员上限按部族生效', async () => {
  const unitByTribe = { gauls: 'phalanx', teutons: 'clubswinger' } as const;
  for (const tribe of ['gauls', 'teutons'] as const) {
    const app = freshApp();
    const vid = await reg(app, `c12-${tribe}`, tribe);
    const cap = app.config.constants.popRaceMobilizeMax[tribe];
    // 模拟已重度动员：士兵远超平民，使 soldierFrac 已超过 cap → 继续征兵应被拒
    const snap0 = (await send(app, 'population.GetSnapshot', { villageId: vid })).payload as any;
    const soldierPop = snap0.currentPop * 5 + 10; // 足够大，使 soldierFrac > cap（条顿 cap=0.80 → 需>4倍平民）
    await send(app, 'population.SetGarrisonPop', { villageId: vid, popCostSum: soldierPop });
    await flush();

    await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
    let r = await send(app, 'military.TrainTroops', { villageId: vid, unit: unitByTribe[tribe], count: 1 });
    if (!r.ok && r.reason === 'requires_building:barracks') {
      const b = await send(app, 'building.Build', { villageId: vid, zone: 'outer', kind: 'barracks' });
      assert.equal(b.ok, true, `[${tribe}] 建兵营应成功`);
      tick(30_000); await app.scheduler.advanceTo(clock, setClock); await flush();
      r = await send(app, 'military.TrainTroops', { villageId: vid, unit: unitByTribe[tribe], count: 1 });
    }
    assert.equal(r.ok, false, `[${tribe}] 已达动员上限应拒绝训练`);
    assert.equal(r.reason, 'mobilize_cap_exceeded', `[${tribe}] 应返回 mobilize_cap_exceeded（实际 ${r.reason}）`);
  }
});
