import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const emit = (app: GameApp, name: string, payload: any) =>
  app.bus.emit({ name, source: 'test', ts: clock, payload } as any);
const reg = async (app: GameApp, name: string): Promise<string> => {
  const r = await send(app, 'player.Register', { name, password: 'pass1', tribe: 'romans' });
  assert.equal(r.ok, true, '注册应成功: ' + (r.reason ?? ''));
  return (r.payload as any).player.villageId as string;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const baseState = (va: string, active: any) => ({
  villageId: va, completedMain: [], completedSide: [], abandonedSide: [],
  active, offered: [], offeredSide: [], firedTriggers: [], cooldownUntil: {},
});

// ② 调查坐标：末营清剿后不立即可交付，须等 captured_natalies 被抉择后才就绪
test('② 调查坐标：末营清剿后等待玩家抉择 captured_natalies 才标记就绪', async () => {
  const app = freshApp();
  const va = await reg(app, 'natalie1');
  app.store.set('task', va, baseState(va, {
    s4: {
      code: 's4', type: 'side', acceptedAt: clock,
      submitted: {}, camps: [
        { id: 'c1', q: 1, r: 1, cleared: false },
        { id: 'c2', q: 2, r: 2, cleared: false },
        { id: 'c3', q: 3, r: 3, cleared: false },
      ],
      campCleared: 0, progress: 0, awaitingNatalieDecision: false,
    },
  }));
  await tick();

  const battleEnded = (targetId: string) => emit(app, 'combat.BattleEnded', {
    side: 'attacker', attackerWins: true, villageId: va, targetId,
    targetKind: 'pve', campCleared: true, movementId: 'mv' + targetId, treasures: [], looted: {},
  });

  await battleEnded('c1');
  await battleEnded('c2');
  await battleEnded('c3');
  await tick();

  const st = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const t = st.active.find((a: any) => a.code === 's4');
  assert.ok(t, '调查坐标应仍 active');
  assert.equal(t.ready, false, '抉择前不应就绪可交付');
  assert.equal(t.awaitingNatalieDecision, true, '应置 awaitingNatalieDecision');
  assert.equal(t.natalieDecision, null, '抉择前 natalieDecision 应为空');

  // 释放 → 领取奖励
  await emit(app, 'treasure.PendingClaimed', { villageId: va, code: 'captured_natalies', released: true, stored: false });
  await tick();
  const st2 = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const t2 = st2.active.find((a: any) => a.code === 's4');
  assert.equal(t2.ready, true, '释放后任务应就绪');
  assert.equal(t2.natalieDecision, 'release', '释放应记 natalieDecision=release');

  // 交付完成任务
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 's4' });
  assert.equal(dv.ok, true, '交付应成功: ' + (dv.reason ?? ''));
  assert.deepEqual((dv.payload as any).rewards.resources, { gold: 500 }, 'S4 释放路径领奖返回值应明确包含 500 金币');
  const st3 = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(st3.completedSide.includes('s4'), '完成后应进 completedSide');
});

// ② 变体：入库 → 任务失败（只保留宝物）
test('② 变体：放入宝库 -> 调查坐标失败且不可领取奖励', async () => {
  const app = freshApp();
  const va = await reg(app, 'natalie2');
  app.store.set('task', va, baseState(va, {
    s4: {
      code: 's4', type: 'side', acceptedAt: clock,
      submitted: {}, camps: [{ id: 'c1', q: 1, r: 1, cleared: false }],
      campCleared: 0, progress: 0, awaitingNatalieDecision: false,
    },
  }));
  await tick();
  await emit(app, 'combat.BattleEnded', {
    side: 'attacker', attackerWins: true, villageId: va, targetId: 'c1',
    targetKind: 'pve', campCleared: true, movementId: 'mv1', treasures: [], looted: {},
  });
  await tick();
  await emit(app, 'treasure.PendingClaimed', { villageId: va, code: 'captured_natalies', released: false, stored: true });
  await tick();
  const st = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.equal(st.active.find((a: any) => a.code === 's4'), undefined, '入库后任务应结束');
  assert.ok(st.abandonedSide.includes('s4'), '入库后应记为失败支线');
});

// ③ GM 重新触发已放弃支线 -> 移出 abandonedSide 并重新可接取
test('③ GM 重新触发已放弃支线 -> 移出 abandonedSide 并重新可接取', async () => {
  const app = freshApp();
  const va = await reg(app, 'retrig1');
  app.store.set('task', va, baseState(va, {}));
  const st0 = app.store.get('task', va) as any;
  st0.abandonedSide = ['s4'];
  app.store.set('task', va, st0);
  await tick();

  const r = await send(app, 'task.GmRetriggerAbandoned', { villageId: va, code: 's4' });
  assert.equal(r.ok, true, '重新触发应成功: ' + (r.reason ?? ''));
  const st = r.payload as any;
  assert.ok(!st.abandonedSide.includes('s4'), '应移出 abandonedSide');
  assert.ok(st.offeredSide.some((o: any) => o.code === 's4'), '应重新进入可接取列表');
});

test('任务代码迁移：旧 villager_request / investigate_coords 自动映射到 s3 / s4', async () => {
  const app = freshApp();
  const va = await reg(app, 'code-migrate');
  app.store.set('task', va, baseState(va, {
    investigate_coords: {
      code: 'investigate_coords', type: 'side', acceptedAt: clock,
      submitted: {}, camps: [], campCleared: 0, progress: 0,
    },
  }));
  const raw = app.store.get<any>('task', va);
  raw.completedSide = ['villager_request'];
  raw.cooldownUntil = { investigate_coords: clock + 60_000 };
  app.store.set('task', va, raw);
  const state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(state.active.some((x: any) => x.code === 's4'), '旧 active 实例应改为 s4');
  assert.ok(state.completedSide.includes('s3'), '旧完成记录应改为 s3');
  const persisted = app.store.get<any>('task', va);
  assert.ok(persisted.active.s4 && !persisted.active.investigate_coords, '迁移应写回实例键');
  assert.equal(persisted.cooldownUntil.s4, clock + 60_000, '冷却键应一并迁移');
});

// ④ 胜利旗帜经「报告(满栏转 pending)」收下 -> 仍获得 +2% 加成
test('④ 胜利旗帜放入报告(满栏转 pending)收下仍获得 +2% 加成', async () => {
  const app = freshApp();
  const va = await reg(app, 'vf1');
  app.store.set('treasure_pending', 'pend-vf', {
    movementId: 'pend-vf', villageId: va, code: 'victory_flag',
    name: '胜利旗帜', icon: '', category: 'flag', rarity: 'legendary',
    effectType: 'victoryFlag', effectValue: 2, applyType: 'passive', priceGold: 0,
    kind: 'deliver', createdAt: clock, expiresAt: clock + 9_999_999, fromCarry: true,
    victoryFlagQualified: true,
  });
  const r = await send(app, 'treasure.ClaimPending', { movementId: 'pend-vf', decision: 'take' });
  assert.equal(r.ok, true, '收下应成功: ' + (r.reason ?? ''));
  assert.equal((r.payload as any).stored, true, '应入库');
  const after = app.store.get('treasure', va) as any;
  assert.equal(after.victoryFlagBonus, 2, '报告收下应兑现 +2% 加成');
});

// ④ 对照：无资格标记时收下胜利旗帜不加成
test('④ 对照：无 victoryFlagQualified 时收下胜利旗帜不加成', async () => {
  const app = freshApp();
  const va = await reg(app, 'vf2');
  app.store.set('treasure_pending', 'pend-vf2', {
    movementId: 'pend-vf2', villageId: va, code: 'victory_flag',
    name: '胜利旗帜', icon: '', category: 'flag', rarity: 'legendary',
    effectType: 'victoryFlag', effectValue: 2, applyType: 'passive', priceGold: 0,
    kind: 'deliver', createdAt: clock, expiresAt: clock + 9_999_999, fromCarry: true,
    victoryFlagQualified: false,
  });
  const r = await send(app, 'treasure.ClaimPending', { movementId: 'pend-vf2', decision: 'take' });
  assert.equal(r.ok, true);
  const after = app.store.get('treasure', va) as any;
  assert.equal(after.victoryFlagBonus, 0, '无资格标记不应加成');
});
