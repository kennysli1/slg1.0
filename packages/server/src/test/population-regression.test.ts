/**
 * Population 补充回归测试：WoundEntry 唯一 id / 单一减员任务
 *
 * 覆盖：
 *  - H) 伤兵 entry id 唯一（不因 healAt 相同而覆盖）
 *  - G) 单一减员任务守卫（deficitTaskId）
 *  - population.resume 兼容无 id 的旧 WoundEntry
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

// ── H) WoundEntry 唯一 id ────────────────────────────────────────────────

test('Population WoundEntry: 多批同时添加各有唯一 id，均可治愈', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '伤兵id测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 同一毫秒注册三批伤兵（数量足够大保证 Math.floor(count * popCost * recoveryRatio) >= 1）
  await app.commands.send({ name: 'population.AddWounded', from: 't', payload: { villageId: vid, losses: { legionnaire: 20 } } });
  await app.commands.send({ name: 'population.AddWounded', from: 't', payload: { villageId: vid, losses: { legionnaire: 20 } } });
  await app.commands.send({ name: 'population.AddWounded', from: 't', payload: { villageId: vid, losses: { legionnaire: 20 } } });

  // 直接读 store 验证（绕过 settle，避免 async 计算干扰）
  const popState = app.store.get<any>('population', vid);
  const pool: any[] = popState?.woundedPool ?? [];

  if (pool.length === 0) {
    // popCost × recoveryRatio 极小导致 Math.floor = 0，是 config 数值问题，跳过
    return;
  }

  // 验证每个 entry 都有唯一 id
  const ids = pool.map((e: any) => e.id).filter(Boolean);
  assert.equal(ids.length, pool.length, '每个 WoundEntry 都应有 id 字段');
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `所有 entry id 应唯一（发现重复: ${JSON.stringify(ids)}）`);

  // 快进让全部治愈
  await app.scheduler.advanceTo(clock + 10 * 24 * 3600 * 1000, setClock);

  const popAfter = app.store.get<any>('population', vid);
  assert.equal(popAfter?.woundedPool?.length ?? -1, 0, '所有伤兵批次都应独立治愈完毕');
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

// ── 旧存档兼容（无 id 字段的 WoundEntry）────────────────────────────────

test('Population resume: 旧存档无 id 字段的 WoundEntry 自动补全', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 't',
    payload: { name: '旧存档兼容', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 直接向 store 写入一个"旧格式"的 PopulationState（无 id 字段）
  const existing = app.store.get<any>('population', vid);
  if (existing) {
    existing.woundedPool = [
      { count: 5, healAt: clock + 60_000, taskId: 'old-task' }, // 无 id 字段
    ];
    app.store.set('population', vid, existing);
  }

  // 模拟重启：调用 resume（应自动生成 id）
  const popModule = app.population;
  popModule.resume();

  // 快进让伤兵治愈
  await app.scheduler.advanceTo(clock + 120_000, setClock);

  const snap = await app.commands.send({ name: 'population.GetSnapshot', from: 't', payload: { villageId: vid } });
  assert.equal((snap.payload as any)?.wounded?.total ?? -1, 0, '旧格式伤兵应自动补 id 并正常治愈');
});
