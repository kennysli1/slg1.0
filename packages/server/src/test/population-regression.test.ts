/**
 * Population 补充回归测试：战死即时回收 / 单一减员任务守卫 / 旧存档兼容
 *
 * v3 硬上限模型：无伤兵池（woundedPool）、无伤兵治愈定时器；
 * 战死经 population.RecoverCasualties 按医院等级即时回收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

let clock = 1_000_000;
const setClock = (t: number) => { clock = t; };
function makeApp() {
  clock = 1_000_000;
  return createGameApp({ now: () => clock, manualScheduler: true });
}
async function flush(n = 60): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ── H) 战死即时回收（替代旧 AddWounded 伤兵池）─────────────────────────────

test('Population RecoverCasualties: v4 战死不回收人口（deadPop 全计永久损失，无伤兵池/无定时器）', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '回收测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // ConsumePop 仅校验动员上限（不再扣 currentPop）→ 不影响后续回收断言
  await app.commands.send({ name: 'population.ConsumePop', from: 't', payload: { villageId: vid, unit: 'legionnaire', count: 5 } });

  const snap0 = (await app.commands.send({ name: 'population.GetSnapshot', from: 't', payload: { villageId: vid } })).payload as any;
  const initPop = snap0.currentPop;

  const r = await app.commands.send({
    name: 'population.RecoverCasualties', from: 't',
    payload: { villageId: vid, losses: { legionnaire: 20 } },
  });
  assert.equal(r.ok, true, `RecoverCasualties 应成功: ${r.reason ?? ''}`);
  const p = r.payload as any;
  // v4 解耦：士兵不占人口 → 战死不再回收劳动人口（recovered 恒为 0）；deadPop=20 全计永久损失
  assert.equal(p.recovered, 0, `v4 回收数应为0，实际 ${p.recovered}`);
  assert.equal(p.permanentDead, 20, `永久阵亡应为20，实际 ${p.permanentDead}`);

  const snap1 = (await app.commands.send({ name: 'population.GetSnapshot', from: 't', payload: { villageId: vid } })).payload as any;
  assert.equal(snap1.currentPop, initPop, `v4 战死不应改变 currentPop（${initPop}→${snap1.currentPop}）`);
  assert.ok(snap1.currentPop <= snap1.hardCap, `currentPop 不应超过 hardCap（${snap1.currentPop} vs ${snap1.hardCap}）`);
  assert.equal(snap1.wounded, undefined, 'v4 快照不应含 wounded 字段');

  const popState = app.store.get<any>('population', vid);
  assert.equal(popState?.woundedPool, undefined, 'v4 PopulationState 不应有 woundedPool 字段');
});

// ── G) 单一减员任务守卫 ───────────────────────────────────────────────────

test('Population: CropDeficit 触发后只注册一个减员任务', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '减员守卫', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // 造成赤字
  await app.commands.send({
    name: 'economy.SetUpkeep', from: 't',
    payload: { villageId: vid, source: 'huge', cropPerHour: 99999 },
  });

  const beforePending = app.scheduler.pending;

  // 触发多次 CropDeficit
  for (let i = 0; i < 4; i++) {
    await app.bus.emit({ name: 'economy.CropDeficit', source: 't', ts: clock, payload: { villageId: vid } });
  }

  const afterPending = app.scheduler.pending;
  const added = afterPending - beforePending;
  assert.ok(added <= 1, `CropDeficit × 4 最多添加 1 个减员任务，实际: ${added}`);
});

// ── 旧存档兼容（缺 v3 新增字段）────────────────────────────────────────────

test('Population resume: 旧存档缺新字段自动补全，无 wounded', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '旧存档兼容', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // 模拟旧存档：抹掉 v3 新增字段
  const existing = app.store.get<any>('population', vid);
  assert.ok(existing, '应有 population 状态');
  delete existing.garrisonPopCost;
  delete existing.enRoutePopCost;
  delete existing.hardCap;
  delete existing.mainLevel;
  delete existing.tribe;
  delete existing.inFamine;
  app.store.set('population', vid, existing);

  // 模拟重启：调用 resume（应自动补全字段，不抛错；派生硬上限从建筑重算）
  const popModule = app.population;
  popModule.resume();
  await flush(60); // 等待 refreshHardCap（异步重算 hardCap/mainLevel）完成

  const snap = (await app.commands.send({ name: 'population.GetSnapshot', from: 't', payload: { villageId: vid } })).payload as any;
  assert.ok(typeof snap.currentPop === 'number', 'resume 后快照应有效');
  assert.ok(snap.hardCap > 0, 'resume 后应重算补出 hardCap');
  assert.equal(snap.wounded, undefined, 'v3 快照不应含 wounded');
});

// ── 金币：历史 null/NaN 自愈 + 周期结算累加 ────────────────────────────────

test('Economy: 历史残留 null 金币经 settle 自愈为 startGoldAmount(=100)', async () => {
  const app = makeApp();
  app.setupWorld();
  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '金币自愈', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // 模拟历史损坏：金币被写成 null（早期金币税算出 NaN 被 JSON.stringify 序列化成 null 的残留）
  const econ = app.store.get<any>('economy', vid);
  assert.ok(econ, '应有 economy 状态');
  econ.resources.gold = null;
  app.store.set('economy', vid, econ);

  // 任意一次结算（GetResources 走 settle → 迁移兜底）应把 null 自愈为合法数字
  const r = await app.commands.send({ name: 'economy.GetResources', from: 't', payload: { villageId: vid } });
  assert.ok(r.ok);
  const after = app.store.get<any>('economy', vid);
  assert.equal(typeof after.resources.gold, 'number', '金币应从 null 自愈为数字');
  assert.ok(Number.isFinite(after.resources.gold), '金币应为有限数字（非 NaN）');
  assert.equal(after.resources.gold, 100, '金币自愈应回退到 startGoldAmount(=100)');
});

test('Economy: 旧村庄 baseRate 缺 gold 键时金币自愈为 100（而非 NaN→0）', async () => {
  const app = makeApp();
  app.setupWorld();
  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '旧村baseRate', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // 模拟 gold 加入前的旧村庄：金币为 null 且 baseRate 缺 gold 键
  const econ = app.store.get<any>('economy', vid);
  econ.resources.gold = null;
  delete econ.baseRate.gold;
  app.store.set('economy', vid, econ);

  const r = await app.commands.send({ name: 'economy.GetResources', from: 't', payload: { villageId: vid } });
  assert.ok(r.ok);
  const after = app.store.get<any>('economy', vid);
  assert.equal(typeof after.resources.gold, 'number', '金币应为数字');
  assert.equal(after.resources.gold, 100, '旧村庄金币应自愈为 startGoldAmount(=100)，而非被 NaN 清成 0');
  assert.equal(typeof after.baseRate.gold, 'number', 'baseRate.gold 应被补齐为数字（0）');
});

test('Population 周期结算: 金币税随 tick 持续累加（不依赖客户端轮询/开面板）', async () => {
  const app = makeApp();
  app.setupWorld();
  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '金币tick', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();
  app.resume(); // 调度周期结算 tick（每 30s 结算全部村庄的金币税+人口增长）

  const goldBefore = (app.store.get<any>('economy', vid)).resources.gold;
  assert.ok(Number.isFinite(goldBefore), '起始金币应为有限数字');

  // 推进 1 小时：周期 tick 多次结算金币税，金币应持续累加
  await app.scheduler.advanceTo(clock + 3600_000, setClock);
  await flush(120);

  const goldAfter = (app.store.get<any>('economy', vid)).resources.gold;
  assert.ok(Number.isFinite(goldAfter), '结算后金币应为有限数字');
  assert.ok(goldAfter > goldBefore, `金币应随周期 tick 持续累加（${goldBefore} → ${goldAfter}）`);
});
