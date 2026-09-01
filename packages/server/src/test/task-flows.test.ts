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
  const repBeforeClaim = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((repBeforeClaim.payload as any).value, 0, '释放选择阶段不应提前结算声望');
  const st2 = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const t2 = st2.active.find((a: any) => a.code === 's4');
  assert.equal(t2.ready, true, '释放后任务应就绪');
  assert.equal(t2.natalieDecision, 'release', '释放应记 natalieDecision=release');

  // 交付完成任务
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 's4' });
  assert.equal(dv.ok, true, '交付应成功: ' + (dv.reason ?? ''));
  assert.deepEqual((dv.payload as any).rewards.resources, { gold: 500 }, 'S4 释放路径领奖返回值应明确包含 500 金币');
  assert.equal((dv.payload as any).rewards.reputation, 2, 'S4 释放路径领奖返回值应包含 +2 声望');
  const repAfterClaim = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((repAfterClaim.payload as any).value, 2, '领取 S4 奖励后才应结算 +2 声望');
  const st3 = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(st3.completedSide.includes('s4'), '完成后应进 completedSide');
});

test('② 释放路径：真实 pending 领取后仅交付任务时结算金币、声望与正直的心', async () => {
  const app = freshApp();
  const va = await reg(app, 'natalie-release');
  await send(app, 'population.GetState', { villageId: va });
  await send(app, 'military.GetState', { villageId: va });
  await send(app, 'research.GetState', { villageId: va });
  app.store.set('task', va, baseState(va, {
    s4: {
      code: 's4', type: 'side', acceptedAt: clock,
      submitted: {}, camps: [], campCleared: 3, progress: 3,
      awaitingNatalieDecision: true, awaitingNatalieCode: 'captured_natalies',
    },
  }));
  const before = await send(app, 'economy.GetResources', { villageId: va });
  const beforeGold = Number((before.payload as any).resources.gold ?? 0);

  const rolled = await send(app, 'treasure.RollDrop', {
    villageId: va, source: 'camp', movementId: 'release-chain',
    forceCode: 'captured_natalies', taskRelated: true,
  });
  assert.equal(rolled.ok, true, '应创建真实待领取宝物');
  assert.equal((await send(app, 'treasure.MarkPendingArrived', { movementId: 'release-chain' })).ok, true);
  const released = await send(app, 'treasure.ClaimPending', { movementId: 'release-chain', decision: 'release' });
  assert.equal(released.ok, true, '释放应成功: ' + (released.reason ?? ''));
  await tick();

  const beforeDeliver = await send(app, 'economy.GetResources', { villageId: va });
  assert.equal(Number((beforeDeliver.payload as any).resources.gold ?? 0), beforeGold, '释放本身不得发金币');
  const ready = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.equal(ready.active.find((task: any) => task.code === 's4')?.ready, true, '释放后必须等待手动交付');

  const delivered = await send(app, 'task.Deliver', { villageId: va, code: 's4' });
  assert.equal(delivered.ok, true, '交付应成功: ' + (delivered.reason ?? ''));
  assert.deepEqual((delivered.payload as any).rewards.resources, { gold: 500 });
  assert.equal((delivered.payload as any).rewards.reputation, 2);
  const after = await send(app, 'economy.GetResources', { villageId: va });
  assert.equal(Number((after.payload as any).resources.gold ?? 0), beforeGold + 500);
  const treasure = app.store.get<any>('treasure', va);
  assert.ok([...treasure.town, ...treasure.treasury].includes('honest_heart'), '交付后才应发放正直的心');
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
  const reputation = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((reputation.payload as any).value, -2, 'S4 收纳失败应结算 -2 声望');
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

test('主线人口门槛包含驻军人口', async () => {
  const app = freshApp();
  const va = await reg(app, 'population-task');
  // 开局人口由主基地逐级配置决定（当前配置为10，而不是旧版固定20）。
  // 将平民池设为20，保持本测试对“再增加10名士兵后总人口=30”的验证目标。
  const population = app.store.get<any>('population', va);
  assert.ok(population, '注册后应存在人口状态');
  population.currentPop = 20;
  app.store.set('population', va, population);
  app.store.set('task', va, baseState(va, {
    m3: { code: 'm3', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0 },
  }));
  const trained = await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 10 } });
  assert.equal(trained.ok, true);
  await tick();
  const state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const task = state.active.find((item: any) => item.code === 'm3');
  assert.equal(task.progress, 30, '20 平民 + 10 士兵应按总人口达到 30');
  assert.equal(task.ready, true);
});
test('M8：玩家主动清空天王老子村也会记录为成功并保留任务村', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-direct');
  const targetId = 'taskvillage-direct-m8';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 6, r: 6, task: true, ownerVillageId: va,
    loot: { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 },
  });
  assert.equal(spawned.ok, true, `M8 任务村应能生成: ${spawned.reason ?? ''}`);
  app.store.set('task', va, baseState(va, {
    m8: {
      code: 'm8', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0,
      taskVillageId: targetId, taskVillageXY: { q: 6, r: 6 }, taskVillageAttackAt: clock + 28_800_000,
    },
  }));
  await emit(app, 'combat.BattleEnded', {
    side: 'attacker', attackerWins: true, villageId: va, targetKind: 'pve', targetId,
    campCleared: true, survivors: {}, movementId: 'm8-direct-attack', deployedTroops: { legionnaire: 20 },
  });
  await tick();
  const state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const task = state.active.find((item: any) => item.code === 'm8');
  assert.equal(task.outcome, 'success');
  assert.equal(task.ready, true, '主动清空后 M8 应等待手动领取');
  const target = (await send(app, 'pve.GetTarget', { id: targetId })).payload as any;
  assert.equal(target.cleared, false, '天王老子村不应因 M8 战斗消失');
  assert.equal(Object.values(target.defender).reduce((sum: number, unit: any) => sum + Number(unit.count ?? 0), 0), 0, '主动清空后任务村守军应归零');
  assert.deepEqual(target.loot, { wood: 250, clay: 250, iron: 250, crop: 250, gold: 0 }, 'M8 结算后资源应减半且金币归零');
});

test('M8 旧任务村的过量初始库存在重启恢复时迁移到 CSV 默认值', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-loot-migrate');
  const targetId = 'taskvillage-legacy-m8';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 8, r: 8, task: true, ownerVillageId: va,
    loot: { wood: 9000, clay: 9100, iron: 9200, crop: 9300, gold: 9500 },
  });
  assert.equal(spawned.ok, true);
  const freshTarget = (await send(app, 'pve.GetTarget', { id: targetId })).payload as any;
  assert.deepEqual(freshTarget.loot, { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 }, '新建天王老子村必须固定使用各 500 初始库存');
  const old = app.store.get<any>('pve', targetId)!;
  // 模拟部署前已写入存档的旧库存；新创建的任务村始终忽略调用方库存。
  old.loot = { wood: 9000, clay: 9100, iron: 9200, crop: 9300, gold: 9500 };
  old.defender = { club: { count: 15, form: 'melee', meleeAtk: 20, rangedAtk: 0, meleeDef: 15, rangedDef: 15, carry: 0 } };
  delete old.taskVillageLootInitialized;
  app.store.set('pve', targetId, old);
  app.pve.resume();
  const migrated = app.store.get<any>('pve', targetId)!;
  assert.deepEqual(migrated.loot, { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 });
  assert.equal(migrated.defender.clubswinger.count, 15, '旧 club 守军应迁移为条顿 clubswinger');
  assert.equal(migrated.defender.clubswinger.meleeAtk, 58, '迁移后的守军应使用条顿棍棒兵攻击力');
  assert.equal(migrated.defender.club, undefined, '存档不应继续保留旧 club 标签');
  assert.equal(migrated.taskVillageLootInitialized, true);
});

test('M8 到时会生成 NPC 攻城行军并向目标村提供可见预警', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8sched');
  const state = baseState(va, {});
  (state as any).offeredMain = ['m8'];
  app.store.set('task', va, state);
  const accepted = await send(app, 'task.Accept', { villageId: va, code: 'm8' });
  assert.equal(accepted.ok, true);
  clock += app.config.constants.m8AttackDelaySec * 1000;
  await app.scheduler.advanceTo(clock, (next) => { clock = next; });
  await tick();
  let movement = app.store.all<any>('movement').find((item) => item.npcService && item.taskCode === 'm8');
  assert.ok(movement, '倒计时结束后应生成天王老子村 NPC 攻城行军');
  const warnings: any[] = [];
  for (let i = 0; i < movement.path.length && movement.status === 'marching'; i++) {
    const listed = await send(app, 'movement.List', { villageId: va });
    warnings.push(...(((listed.payload as any)?.incomingWarnings ?? [])));
    clock = Math.max(clock, movement.nextStepAt);
    await app.scheduler.advanceTo(clock, (next) => { clock = next; });
    await tick();
    movement = app.store.all<any>('movement').find((item) => item.npcService && item.taskCode === 'm8') ?? movement;
  }
  assert.ok(warnings.some((item) => item.id === movement.id), 'NPC 攻城路径进入城市视野时应出现在来袭预警');
  const warning = warnings.find((item) => item.id === movement.id);
  assert.ok(warning?.pos, '来袭预警必须下发 NPC 攻城军当前位置，地图才能绘制实时图标');
  assert.deepEqual(warning.pos, warning.path[warning.stepIndex], '来袭预警当前位置必须与路径步进索引一致');
  const battle = app.store.all<any>('battle').find((item) => item.taskCode === 'm8');
  assert.ok(battle, 'NPC 攻城行军抵达后应创建战场');
});

test('M8 守城失败须手动确认，确认后无奖励并解锁按结局分支的 M9', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-fail');
  const targetId = 'taskvillage-failure-m8';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 6, r: 6, task: true, ownerVillageId: va,
    loot: { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 },
    defenders: { clubswinger: 15 },
  });
  assert.equal(spawned.ok, true);
  app.store.set('task', va, baseState(va, {
    m8: {
      code: 'm8', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0,
      progress: 0, taskVillageId: targetId, taskVillageXY: { q: 6, r: 6 },
      taskVillageAttackAt: clock + app.config.constants.m8AttackDelaySec * 1000,
    },
  }));
  await emit(app, 'combat.BattleEnded', {
    villageId: `task:${targetId}`, side: 'attacker', targetKind: 'village', targetId: va,
    attackerWins: true, npcService: true, taskCode: 'm8', movementId: 'm8-attack',
    survivors: { clubswinger: 15 },
  });
  await tick();
  let state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  const failed = state.active.find((item: any) => item.code === 'm8');
  assert.ok(failed, '守城失败后 M8 应保留在任务栏');
  assert.equal(failed.failureReady, true);
  assert.equal(failed.ready, false);
  const confirm = await send(app, 'task.Fail', { villageId: va, code: 'm8' });
  assert.equal(confirm.ok, true, `M8 失败确认应成功: ${confirm.reason ?? ''}`);
  assert.deepEqual((confirm.payload as any).rewards.treasures, [], 'M8 失败不应发放宝物');
  state = (await send(app, 'task.GetState', { villageId: va })).payload as any;
  assert.ok(!state.active.some((item: any) => item.code === 'm8'));
  assert.ok(state.completedMain.includes('m8'));
  assert.equal(app.store.get<any>('task', va)?.outcomes?.m8, 'failure');
  assert.ok(state.offeredMain.some((item: any) => item.code === 'm9'), `确认 M8 失败后应解锁 M9，当前 offeredMain=${JSON.stringify(state.offeredMain)} completedMain=${JSON.stringify(state.completedMain)}`);
});
test('天王老子村侦察目标坐标以 World 地块为准并回写 PvE 状态', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-coordinate');
  const targetId = 'taskvillage-coordinate-m8';
  await send(app, 'pve.Spawn', { id: targetId, type: 'tianwang_village', q: 5, r: 5, task: true, ownerVillageId: va });
  await tick();
  // 模拟旧档：PvE 状态仍为 (5,5)，但地图 refId 已位于 (7,7)。
  await send(app, 'world.RemoveTile', { q: 5, r: 5, refId: targetId });
  await send(app, 'world.PlacePve', { q: 7, r: 7, refId: targetId, name: '天王老子村', task: true });
  const target = await send(app, 'pve.GetTarget', { id: targetId });
  assert.equal(target.ok, true);
  assert.deepEqual({ q: (target.payload as any).q, r: (target.payload as any).r }, { q: 7, r: 7 });
  const persisted = app.store.get<any>('pve', targetId);
  assert.equal(persisted.q, 7);
  assert.equal(persisted.r, 7);
});

test('GM 可重新触发已完成主线，或将进行中主线回退为未触发', async () => {
  const app = freshApp();
  const va = await reg(app, 'gm-main-state');
  app.store.set('task', va, baseState(va, {}));
  const stored = app.store.get<any>('task', va)!;
  stored.completedMain = ['m2'];
  app.store.set('task', va, stored);
  const retrigger = await send(app, 'task.GmRetriggerCompletedMain', { villageId: va, code: 'm2' });
  assert.equal(retrigger.ok, true, `主线应能重新触发: ${retrigger.reason ?? ''}`);
  assert.ok((retrigger.payload as any).offeredMain.some((item: any) => item.code === 'm2'));

  const active = app.store.get<any>('task', va)!;
  active.offeredMain = [];
  active.active = { m2: { code: 'm2', type: 'main', camps: [] } };
  app.store.set('task', va, active);
  const untrigger = await send(app, 'task.GmUntriggerMain', { villageId: va, code: 'm2' });
  assert.equal(untrigger.ok, true, `进行中主线应能回退: ${untrigger.reason ?? ''}`);
  const after = untrigger.payload as any;
  assert.equal(after.active.find((item: any) => item.code === 'm2'), undefined);
  assert.ok(!after.offeredMain.some((item: any) => item.code === 'm2'));
});

test('GM 重新触发 M8 会清理上一轮任务村并按模板重建守军与库存', async () => {
  const app = freshApp();
  const va = await reg(app, 'gm-m8-retrigger');
  const targetId = 'taskvillage-gm-m8';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 6, r: 6, task: true, ownerVillageId: va,
    loot: { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 },
  });
  assert.equal(spawned.ok, true);
  const state: any = baseState(va, {});
  state.completedMain = ['m8'];
  state.taskVillages = { m8: { id: targetId, q: 6, r: 6, name: '天王老子村' } };
  state.outcomes = { m8: 'failure' };
  app.store.set('task', va, state);
  const old = app.store.get<any>('pve', targetId)!;
  old.defender.clubswinger.count = 0;
  old.loot = { wood: 2498, clay: 2497, iron: 2498, crop: 2497, gold: 0 };
  app.store.set('pve', targetId, old);

  const retrigger = await send(app, 'task.GmRetriggerCompletedMain', { villageId: va, code: 'm8' });
  assert.equal(retrigger.ok, true, `M8 应能重新触发: ${retrigger.reason ?? ''}`);
  assert.ok((retrigger.payload as any).offeredMain.some((item: any) => item.code === 'm8'));
  assert.equal(app.store.get<any>('pve', targetId), undefined, '重新触发前一轮任务村应先移除');

  const accepted = await send(app, 'task.Accept', { villageId: va, code: 'm8' });
  assert.equal(accepted.ok, true, `重新接取 M8 应成功: ${accepted.reason ?? ''}`);
  const active = app.store.get<any>('task', va)?.active?.m8;
  assert.ok(active?.taskVillageId, '重新接取后应绑定新任务村实体');
  const fresh = (await send(app, 'pve.GetTarget', { id: active.taskVillageId })).payload as any;
  assert.deepEqual(fresh.loot, { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 });
  assert.equal(fresh.defender.clubswinger.count, 15);
  assert.equal(fresh.defender.club, undefined);
});

test('GM 重置本村任务也会清理 M8 任务村，避免稳定 id 复用空营地', async () => {
  const app = freshApp();
  const va = await reg(app, 'gm-m8-reset');
  const targetId = 'taskvillage-gm-reset-m8';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 7, r: 7, task: true, ownerVillageId: va,
    loot: { wood: 0, clay: 0, iron: 0, crop: 0, gold: 0 },
  });
  assert.equal(spawned.ok, true);
  const state: any = baseState(va, {
    m8: {
      code: 'm8', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0,
      progress: 0, taskVillageId: targetId, taskVillageXY: { q: 7, r: 7 },
    },
  });
  state.taskVillages = { m8: { id: targetId, q: 7, r: 7, name: '天王老子村' } };
  app.store.set('task', va, state);

  const reset = await send(app, 'task.GmReset', { villageId: va });
  assert.equal(reset.ok, true, `本村任务重置应成功: ${reset.reason ?? ''}`);
  assert.equal(app.store.get<any>('pve', targetId), undefined, '本村任务重置必须移除 M8 任务村实体');

  // 模拟前置主线已完成后重新接取 M8，验证不会复用旧的空库存/空守军实体。
  const afterReset: any = app.store.get('task', va)!;
  afterReset.completedMain = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
  afterReset.offeredMain = ['m8'];
  app.store.set('task', va, afterReset);
  const accepted = await send(app, 'task.Accept', { villageId: va, code: 'm8' });
  assert.equal(accepted.ok, true, `重置后重新接取 M8 应成功: ${accepted.reason ?? ''}`);
  const active = app.store.get<any>('task', va)?.active?.m8;
  const fresh = (await send(app, 'pve.GetTarget', { id: active.taskVillageId })).payload as any;
  assert.deepEqual(fresh.loot, { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 });
  assert.equal(fresh.defender.clubswinger.count, 15);
});

test('重启恢复会修复 active M8 指向已清空任务村的旧半结算状态', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-resume-repair');
  const targetId = 'taskvillage-m8-resume-repair';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 9, r: 9, task: true, ownerVillageId: va,
    loot: { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 },
  });
  assert.equal(spawned.ok, true);
  const target = app.store.get<any>('pve', targetId)!;
  target.defender.clubswinger.count = 0;
  target.loot = { wood: 6, clay: 0, iron: 8, crop: 0, gold: 0 };
  target.cleared = true;
  target.clearCount = 2;
  app.store.set('pve', targetId, target);
  const state: any = baseState(va, {
    m8: {
      code: 'm8', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0,
      progress: 0, taskVillageId: targetId, taskVillageXY: { q: 9, r: 9 },
    },
  });
  state.taskVillages = { m8: { id: targetId, q: 9, r: 9, name: '天王老子村' } };
  app.store.set('task', va, state);

  await app.task.resume();
  const active = app.store.get<any>('task', va)?.active?.m8;
  const repaired = (await send(app, 'pve.GetTarget', { id: active.taskVillageId })).payload as any;
  assert.deepEqual(repaired.loot, { wood: 500, clay: 500, iron: 500, crop: 500, gold: 500 });
  assert.equal(repaired.defender.clubswinger.count, 15);
  assert.equal(repaired.cleared, false);
});

test('M8 奖励领取并发时铁壁勋章只发放一次', async () => {
  const app = freshApp();
  const va = await reg(app, 'm8-reward-once');
  app.store.set('task', va, baseState(va, {
    m8: {
      code: 'm8', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0,
      progress: 0, readyToDeliver: true, outcome: 'success',
    },
  }));

  // 两个请求同时到达时，只有一个可以进入奖励结算；另一个会在任务被删除
  // 后得到 not_active，不能再次创建铁壁勋章。
  const results = await Promise.all([
    send(app, 'task.Deliver', { villageId: va, code: 'm8' }),
    send(app, 'task.Deliver', { villageId: va, code: 'm8' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, '并发领取只能成功一次');
  const stored = app.store.get<any>('treasure', va);
  const storedMedals = [...(stored?.town ?? []), ...(stored?.treasury ?? []), ...(stored?.treasuryReserve ?? [])]
    .filter((code) => code === 'iron_wall_medal').length;
  const pendingMedals = app.store.all<any>('treasure_pending').filter((item) => item.villageId === va && item.code === 'iron_wall_medal').length;
  assert.equal(storedMedals + pendingMedals, 1, 'M8 奖励路径最多产生一枚铁壁勋章');
});

test('M9（M8 失败分支）奖励领取并发时铁壁勋章只发放一次', async () => {
  const app = freshApp();
  const va = await reg(app, 'm9-reward-once');
  app.store.set('task', va, {
    ...baseState(va, {
      m9: {
        code: 'm9', type: 'main', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0,
        progress: 0, readyToDeliver: true,
      },
    }),
    outcomes: { m8: 'failure' },
  });

  const results = await Promise.all([
    send(app, 'task.Deliver', { villageId: va, code: 'm9' }),
    send(app, 'task.Deliver', { villageId: va, code: 'm9' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, '并发领取只能成功一次');
  const stored = app.store.get<any>('treasure', va);
  const storedMedals = [...(stored?.town ?? []), ...(stored?.treasury ?? []), ...(stored?.treasuryReserve ?? [])]
    .filter((code) => code === 'iron_wall_medal').length;
  const pendingMedals = app.store.all<any>('treasure_pending').filter((item) => item.villageId === va && item.code === 'iron_wall_medal').length;
  assert.equal(storedMedals + pendingMedals, 1, 'M9 失败分支奖励路径最多产生一枚铁壁勋章');
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
