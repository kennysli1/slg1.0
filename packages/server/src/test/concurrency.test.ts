/**
 * 并发安全回归测试：Combat TOCTOU / Gateway 串行化 / Scheduler 重入
 *
 * 重点覆盖：
 *  - 同一目标两次并发 Engage 只开一场战（一地一场战不变式）
 *  - Population: 多次 CropDeficit 只注册一个减员任务
 *  - WoundEntry 唯一 id（同时间多批伤兵不碰撞）
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

// ── D) Combat TOCTOU：同一目标两次并发 Engage 只开一场战 ─────────────────

test('Combat: 同目标并发 Engage 只创建一场战斗', async () => {
  const app = makeApp();
  app.setupWorld();

  const battleIds: string[] = [];
  app.bus.on('combat.BattleStarted', (e) => {
    battleIds.push((e.payload as any).battleId);
  });

  // 同时发出两个 Engage 命令（同一 PvE 目标）
  const [r1, r2] = await Promise.all([
    app.commands.send({
      name: 'combat.Engage', from: 'test',
      payload: {
        targetKind: 'pve', targetId: 'pve-4', targetXY: { q: 0, r: 0 },
        movementId: 'mv-1', fromVillage: 'v-ghost-1', fromXY: { q: 1, r: 0 },
        troops: { legionnaire: 20 },
        attackerSnapshot: { legionnaire: { count: 20, form: 'melee', meleeAtk: 40, rangedAtk: 0, meleeDef: 35, rangedDef: 50, carry: 10 } },
      },
    }),
    app.commands.send({
      name: 'combat.Engage', from: 'test',
      payload: {
        targetKind: 'pve', targetId: 'pve-4', targetXY: { q: 0, r: 0 },
        movementId: 'mv-2', fromVillage: 'v-ghost-2', fromXY: { q: -1, r: 0 },
        troops: { legionnaire: 20 },
        attackerSnapshot: { legionnaire: { count: 20, form: 'melee', meleeAtk: 40, rangedAtk: 0, meleeDef: 35, rangedDef: 50, carry: 10 } },
      },
    }),
  ]);

  assert.ok(r1.ok, '第一次 Engage 应成功');
  assert.ok(r2.ok, '第二次 Engage 应成功');

  // 无论哪个先创建，第二个应并入；BattleStarted 只发一次
  assert.equal(battleIds.length, 1, '一地只能开一场战');

  // 两次 Engage 的 battleId 应相同（一个新建，一个并入）
  const id1 = (r1.payload as any).battleId;
  const id2 = (r2.payload as any).battleId;
  assert.equal(id1, id2, '两次 Engage 应对应同一个 battleId');
});

// ── G) CropDeficit 边沿触发：只发一次 ────────────────────────────────────

test('Economy: CropDeficit 边沿触发，多次 settle 只 emit 一次', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 'test',
    payload: { name: '赤字测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 先 settle 一次（基准 lastTick）
  await app.commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });

  // 制造粮食赤字：设置极高消耗
  await app.commands.send({
    name: 'economy.SetUpkeep', from: 'test',
    payload: { villageId: vid, source: 'test_upkeep', cropPerHour: 999999 },
  });

  // 订阅在设置赤字 AFTER，避免 SetUpkeep 自身的 settle 被计入
  const deficits: string[] = [];
  app.bus.on('economy.CropDeficit', (e) => {
    deficits.push((e.payload as any).villageId);
  });

  // 推进时钟 1 小时（让 settle 看到足够的 elapsed，drain 掉全部 crop）
  clock += 3_600_000;

  // 多次 settle（通过 GetResources 触发）
  for (let i = 0; i < 3; i++) {
    await app.commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
  }

  assert.equal(deficits.length, 1, '边沿触发：多次 settle 处于赤字状态只应 emit 一次 CropDeficit');
});

// ── G) Population 单一减员任务：多次 CropDeficit 不堆积 ───────────────────

test('Population: 多次 CropDeficit 事件只注册一个减员 Scheduler 任务', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 'test',
    payload: { name: '减员测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 制造持续赤字
  await app.commands.send({
    name: 'economy.SetUpkeep', from: 'test',
    payload: { villageId: vid, source: 'huge', cropPerHour: 999999 },
  });

  const pendingBefore = app.scheduler.pending;

  // 手动触发多次 CropDeficit 事件
  for (let i = 0; i < 5; i++) {
    await app.bus.emit({
      name: 'economy.CropDeficit', source: 'test', ts: clock,
      payload: { villageId: vid },
    });
  }

  const added = app.scheduler.pending - pendingBefore;
  assert.ok(added <= 1, `多次 CropDeficit 应最多新增 1 个减员任务，实际新增 ${added}`);
});

// ── H) RecoverCasualties 即时回收（v3 无伤兵池/无定时器）───────────────────

test('Population: 多次 RecoverCasualties 各自即时结算，无伤兵池无定时器（v4 不回收人口）', async () => {
  const app = makeApp();
  app.setupWorld();

  const reg = await app.commands.send({
    name: 'player.Register', from: 'test',
    payload: { name: '伤兵测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;
  await flush();

  // ConsumePop 仅校验动员上限（不再扣 currentPop）→ 不影响后续回收断言
  await app.commands.send({ name: 'population.ConsumePop', from: 'test', payload: { villageId: vid, unit: 'legionnaire', count: 10 } });

  const snap0 = (await app.commands.send({ name: 'population.GetSnapshot', from: 'test', payload: { villageId: vid } })).payload as any;
  const initPop = snap0.currentPop;

  // 同时发两批战死回收（clock 相同）
  const r1 = await app.commands.send({
    name: 'population.RecoverCasualties', from: 'test',
    payload: { villageId: vid, losses: { legionnaire: 20 } },
  });
  const r2 = await app.commands.send({
    name: 'population.RecoverCasualties', from: 'test',
    payload: { villageId: vid, losses: { legionnaire: 20 } },
  });

  assert.ok(r1.ok, `RecoverCasualties 1 应成功: ${r1.reason ?? ''}`);
  assert.ok(r2.ok, `RecoverCasualties 2 应成功: ${r2.reason ?? ''}`);
  // v4 解耦：士兵不占人口 → 战死不再回收劳动人口（recovered 恒为 0）；deadPop=20 全计永久损失
  assert.equal((r1.payload as any).recovered, 0, 'v4 第一批应回收0');
  assert.equal((r2.payload as any).recovered, 0, 'v4 第二批应回收0');
  assert.equal((r1.payload as any).permanentDead, 20, 'v4 第一批永久损失应为20');
  assert.equal((r2.payload as any).permanentDead, 20, 'v4 第二批永久损失应为20');

  // 平民人口不变（不回收、不扣减）
  const snap1 = (await app.commands.send({ name: 'population.GetSnapshot', from: 'test', payload: { villageId: vid } })).payload as any;
  assert.equal(snap1.currentPop, initPop, `v4 战死不应改变 currentPop（${initPop}→${snap1.currentPop}）`);
  assert.ok(snap1.currentPop <= snap1.hardCap, `currentPop 不应超过 hardCap（${snap1.currentPop} vs ${snap1.hardCap}）`);

  // v4 无伤兵池（无 woundedPool / 无 heal 定时器）
  const popState = app.store.get<any>('population', vid);
  assert.equal(popState?.woundedPool, undefined, 'v4 不应有 woundedPool（无伤兵池）');
});
