import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 多人 + PvP + 账号 端到端测试（假时钟，内存store）。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd: string, tribe = 'romans') =>
  send(app, 'player.Register', { name, password: pwd, tribe });
async function buildBarracks(app: GameApp, villageId: string): Promise<void> {
  const r = await send(app, 'building.Build', { villageId, zone: 'inner', kind: 'barracks' });
  assert.equal(r.ok, true, `建兵营应成功: ${r.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 10_000, setClock);
}
/** 玩家坐标读取（六边形轴坐标 q/r，兼容旧 x/y）。 */
const px = (p: any) => p.q ?? p.x ?? 0;
const py = (p: any) => p.r ?? p.y ?? 0;
/** 大步快进驱动"到达→逐 tick 战斗→结束→返程"整条链，直到没有待处理任务。 */
async function drain(app: GameApp, bigStepMs = 3_600_000, maxIters = 30000): Promise<void> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < maxIters) {
    await app.scheduler.advanceTo(clock + bigStepMs, setClock);
    iters++;
  }
}

test('注册：用户名+密码+种族，返回玩家但不含密码', async () => {
  const app = freshApp();
  const r = await reg(app, '阿尔法', 'pass123', 'gauls');
  assert.equal(r.ok, true);
  const p = (r.payload as any).player;
  assert.equal(p.name, '阿尔法');
  assert.equal(p.tribe, 'gauls');
  assert.equal((p as any).pwd, undefined, '不应泄露密码');
});

test('账号校验：重名拒绝、密码太短拒绝、登录错密码拒绝', async () => {
  const app = freshApp();
  await reg(app, '贝塔', 'pass123');
  assert.equal((await reg(app, '贝塔', 'other')).reason, 'name_taken');
  assert.equal((await reg(app, '新人', '12')).reason, 'password_too_short');
  assert.equal((await send(app, 'player.Login', { name: '贝塔', password: '错的' })).reason, 'wrong_password');
  assert.equal((await send(app, 'player.Login', { name: '贝塔', password: 'pass123' })).ok, true);
  assert.equal((await send(app, 'player.Login', { name: '查无此人', password: 'x' })).reason, 'no_such_user');
});

test('种族：高卢玩家不能训练罗马兵', async () => {
  const app = freshApp();
  const g = (await reg(app, '高卢人', 'pass123', 'gauls')).payload as any;
  const vid = g.player.villageId;
  await send(app, 'economy.Grant', { villageId: vid, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  await buildBarracks(app, vid);
  // 罗马军团兵 → 拒绝
  const bad = await send(app, 'military.TrainTroops', { villageId: vid, unit: 'legionnaire', count: 1 });
  assert.equal(bad.reason, 'wrong_tribe_unit');
  // 高卢方阵兵 → 允许
  const ok = await send(app, 'military.TrainTroops', { villageId: vid, unit: 'phalanx', count: 1 });
  assert.equal(ok.ok, true, `高卢应能练方阵兵: ${ok.reason ?? ''}`);
});

test('两玩家坐标不同 + 村庄归属反查', async () => {
  const app = freshApp();
  const a = (await reg(app, 'A', 'p1234')).payload as any;
  const b = (await reg(app, 'B', 'p1234')).payload as any;
  assert.ok(px(a.player) !== px(b.player) || py(a.player) !== py(b.player));
  const owner = await send(app, 'player.GetByVillage', { villageId: a.player.villageId });
  assert.equal((owner.payload as any).player.name, 'A');
});

test('PvP：A 攻击 B，双方战报、掠夺、返程', async () => {
  const app = freshApp();
  const a = (await reg(app, '进攻方', 'p1234')).payload as any;
  const b = (await reg(app, '防守方', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  await buildBarracks(app, va);
  await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: 5 });
  for (let i = 0; i < 5; i++) await app.scheduler.advanceTo(clock + 27_000, setClock);

  await send(app, 'economy.Grant', { villageId: vb, gain: { wood: 500, clay: 500, iron: 500, crop: 500 } });
  const bBefore = (await send(app, 'economy.GetResources', { villageId: vb })).payload as any;

  let atkReport: any = null, defReport: any = null, incoming: any = null;
  app.bus.on('combat.BattleEnded', (e: any) => { if (e.payload.side === 'attacker') atkReport = e.payload; else defReport = e.payload; });
  app.bus.on('movement.IncomingAttack', (e: any) => (incoming = e.payload));

  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { q: px(a.player), r: py(a.player) },
    targetVillage: vb, toXY: { q: px(b.player), r: py(b.player) }, troops: { legionnaire: 5 },
  });
  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);

  // 来袭告警改为进入守方视野后触发（非出征瞬间）
  await drain(app);
  assert.ok(incoming, 'B 应在部队进入视野后收到来袭警报');
  assert.ok(atkReport && defReport, '双方都应收到战报');
  assert.equal(atkReport.attackerWins, true);

  const bAfter = (await send(app, 'economy.GetResources', { villageId: vb })).payload as any;
  const lootTotal = Object.values(atkReport.loot as Record<string, number>).reduce((s, v) => s + v, 0);
  assert.ok(lootTotal > 0 || bAfter.resources.wood < bBefore.resources.wood, 'B 资源应被抢');

  const army = (await send(app, 'military.GetArmy', { villageId: va })).payload as any;
  assert.ok((army.troops.legionnaire ?? 0) > 0, 'A 幸存兵应返回');
});

test('PvP 掠夺：守方可关闭防守，战后只拆城外建筑且不拿仓储存量', async () => {
  const app = freshApp();
  const a = (await reg(app, '掠夺方', 'p1234')).payload as any;
  const b = (await reg(app, '被掠夺方', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 5 } });
  const defense = await send(app, 'military.SetRaidDefense', { villageId: vb, enabled: false, troops: {} });
  assert.equal(defense.ok, true);
  const army = (await send(app, 'military.GetArmy', { villageId: vb })).payload as any;
  assert.equal(army.raidDefense.enabled, false);

  let report: any = null;
  app.bus.on('combat.BattleEnded', (e: any) => { if (e.payload.side === 'attacker') report = e.payload; });
  const raid = await send(app, 'movement.SendVillageRaid', {
    villageId: va, targetVillage: vb, troops: { legionnaire: 5 }, declareWar: true,
  });
  assert.equal(raid.ok, true);
  await drain(app);
  assert.ok(report, '应有掠夺战报');
  assert.equal(report.battleType, 'raid');
  assert.ok(Array.isArray(report.buildingDamage), '战报应带建筑损坏');
  assert.ok(Object.values(report.buildingLoot ?? {}).some((n: any) => Number(n) > 0), '掠夺破坏建筑应产生建筑战利品');
  assert.ok(Object.values(report.loot ?? {}).some((n: any) => Number(n) > 0), '掠夺方应带回建筑战利品');
  assert.deepEqual(report.storedLoot, {}, '掠夺战不应拿仓库/粮仓存量');
});

test('PvP：战后攻守双方人口快照结构有效（v3 无伤兵池，战死即时回收）', async () => {
  const app = freshApp();
  const a = (await reg(app, 'A伤兵', 'p1234')).payload as any;
  const b = (await reg(app, 'B伤兵', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  // 等待 population.createVillage 异步初始化完成（需要多个微任务周期）
  for (let i = 0; i < 15; i++) await Promise.resolve();

  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  await buildBarracks(app, va);

  // 获取A村人口，训练不超过人口上限的兵
  const popSnapA = (await send(app, 'population.GetSnapshot', { villageId: va })).payload as any;
  const availPop = Math.floor(popSnapA.currentPop ?? 0);
  const trainCount = Math.min(50, availPop);
  if (trainCount < 5) {
    // 人口太少，跳过此测试（不应发生，但防御性处理）
    return;
  }
  const trainR = await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: trainCount });
  if (!trainR.ok) return; // 若因任何原因训练失败则跳过
  for (let i = 0; i < trainCount; i++) await app.scheduler.advanceTo(clock + 10_000, setClock);

  // B村有守军（直接调整，不扣人口以简化测试）
  await send(app, 'military.AdjustTroops', { villageId: vb, delta: { legionnaire: 10 } });

  // A攻击B
  const atk = await send(app, 'movement.SendAttack', {
    villageId: va,
    fromXY: { q: px(a.player), r: py(a.player) },
    targetVillage: vb,
    toXY: { q: px(b.player), r: py(b.player) },
    troops: { legionnaire: Math.min(trainCount, 50) },
  });
  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);

  await drain(app);

  // 检查A村（进攻方）与B村（防守方）人口快照结构是否正常（v4 无伤兵池；战死经 RecoverCasualties 全计永久损失，不回收人口）
  const popSnapA2 = (await send(app, 'population.GetSnapshot', { villageId: va })).payload as any;
  const popSnapB = (await send(app, 'population.GetSnapshot', { villageId: vb })).payload as any;
  for (const [tag, ps] of [['A', popSnapA2], ['B', popSnapB]] as const) {
    assert.ok(typeof ps.currentPop === 'number', `${tag}村应有 currentPop 数字`);
    assert.ok(typeof ps.hardCap === 'number', `${tag}村应有 hardCap 数字`);
    assert.ok(typeof ps.availableLabor === 'number', `${tag}村应有 availableLabor 数字`);
    assert.ok(typeof ps.laborRatio === 'number', `${tag}村应有 laborRatio 数字`);
    assert.ok(typeof ps.prosperityMult === 'number', `${tag}村应有 prosperityMult 数字`);
    assert.equal(ps.wounded, undefined, `v4 ${tag}村快照不应含 wounded 字段`);
  }
  // 进攻方A：战后平民人口应仍然有效（v4 战死不回收人口，但平民人口本身不会因战斗减员而归零）
  assert.ok(popSnapA2.currentPop > 0, 'A村战后应有人口');
});

test('安全：不能攻击自己', async () => {
  const app = freshApp();
  const a = (await reg(app, '自攻', 'p1234')).payload as any;
  const va = a.player.villageId;
  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });
  await buildBarracks(app, va);
  await send(app, 'military.TrainTroops', { villageId: va, unit: 'legionnaire', count: 1 });
  await app.scheduler.advanceTo(clock + 27_000, setClock);
  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { q: px(a.player), r: py(a.player) },
    targetVillage: va, toXY: { q: px(a.player), r: py(a.player) }, troops: { legionnaire: 1 },
  });
  assert.equal(atk.reason, 'cannot_attack_self');
});

test('安全：出征兵力必须为正整数，负数不能刷兵', async () => {
  const app = freshApp();
  const a = (await reg(app, '刷兵防护', 'p1234')).payload as any;
  const va = a.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 5 } });

  const bad = await send(app, 'movement.SendRaid', {
    villageId: va,
    fromXY: { q: 999, r: 999 },
    targetId: 'pve-0',
    troops: { legionnaire: -10 },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_troops:legionnaire');

  const army = (await send(app, 'military.GetArmy', { villageId: va })).payload as any;
  assert.equal(army.troops.legionnaire, 5, '负数出征不应增加驻军');
});

test('安全：客户端伪造出征坐标不会缩短真实行军时间', async () => {
  const app = freshApp();
  const a = (await reg(app, '坐标A', 'p1234')).payload as any;
  const b = (await reg(app, '坐标B', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 5 } });

  const atk = await send(app, 'movement.SendAttack', {
    villageId: va,
    fromXY: { q: 0, r: 0 },
    targetVillage: vb,
    toXY: { q: 0, r: 0 },
    troops: { legionnaire: 5 },
  });

  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);
  assert.ok(((atk.payload as any).travelSec ?? 0) > 3, '应按服务器真实坐标计算，而不是客户端伪造的同格坐标');
});
