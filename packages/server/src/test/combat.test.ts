import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { planPvpLoot, subtractProtected } from '../modules/combat.js';

/**
 * 战斗引擎测试（有状态逐 tick）：直接驱动 combat.Engage，用假时钟跑完整场，
 * 断言"势均力敌打得久、一边倒最快"以及前后排/远近战/特性生效。
 *
 * 用两个同村的 PvE 目标做靶子不方便，这里直接构造 attackerSnapshot + 用 PvE 目标做防守方。
 * 更纯粹地：直接发 combat.Engage 打一个 PvE 目标，观察 tick 数与结果。
 */

let clock = 1_000_000;
const setClock = (t: number) => (clock = t);
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('PvP 战利品规划：金币优先于所有基础资源', () => {
  const plan = planPvpLoot(
    { gold: 2, wood: 1, clay: 1, iron: 1, crop: 1 },
    { gold: 50, wood: 100, clay: 100, iron: 100, crop: 100 },
    10,
  );
  assert.deepEqual(plan.stored, { gold: 2 }, '应先带回仓储金币');
  assert.deepEqual(plan.building, { gold: 8 }, '仓储金币不足时继续带回建筑收益中的金币');
  assert.deepEqual(plan.looted, { gold: 10 });
});

test('攻城保险库：保护额从拆建筑后的仓储可掠夺量中扣除', () => {
  assert.deepEqual(
    subtractProtected(
      { wood: 1000, clay: 800, iron: 200, crop: 0, gold: 2500 },
      { wood: 100, clay: 900, iron: 0, crop: 100, gold: 500 },
    ),
    { wood: 900, clay: 0, iron: 200, crop: 0, gold: 2000 },
  );
});

test('绞马索：携带后敌方骑兵防御降低 30%', async () => {
  const run = async (withRope: boolean) => {
    const app = freshApp();
    const target = app.store.get<any>('pve', 'pve-0')!;
    target.defender = {
      equimperatoris: { count: 10, form: 'melee', meleeAtk: 25, rangedAtk: 0, meleeDef: 60, rangedDef: 50, carry: 0, traits: [] },
    };
    target.cleared = false;
    app.store.set('pve', 'pve-0', target);
    let ended: any = null;
    app.bus.on('combat.BattleEnded', (event) => { if ((event.payload as any).side === 'attacker') ended = event.payload; });
    await send(app, 'combat.Engage', {
      targetKind: 'pve', targetId: 'pve-0', targetXY: { q: 0, r: 0 },
      movementId: withRope ? 'rope-attack' : 'plain-attack', fromVillage: 'v1', fromXY: { q: 0, r: 0 },
      troops: { legionnaire: 10 }, attackerSnapshot: { legionnaire: melee(10, 40, 35) },
      treasures: withRope ? ['horse_rope'] : [],
    });
    await drain(app);
    return ended;
  };
  const plain = await run(false);
  const rope = await run(true);
  assert.ok(plain && rope, '两场战斗都应完成');
  assert.equal(plain.attackerWins, false, '未携带绞马索时该编队应败北');
  assert.equal(rope.attackerWins, true, '绞马索降低骑兵防御后该编队应获胜');
});

test('PvP 战利品规划：四种资源平均且仓储来源优先', () => {
  const plan = planPvpLoot(
    { gold: 0, wood: 1, clay: 1, iron: 1, crop: 1 },
    { gold: 0, wood: 100, clay: 100, iron: 100, crop: 100 },
    8,
  );
  assert.deepEqual(plan.stored, { wood: 1, clay: 1, iron: 1, crop: 1 }, '应先带回仓库/粮仓中的四种资源');
  assert.deepEqual(
    { wood: plan.building.wood, clay: plan.building.clay, iron: plan.building.iron, crop: plan.building.crop },
    { wood: 1, clay: 1, iron: 1, crop: 1 },
  );
  assert.equal(Object.values(plan.looted).reduce((sum, n) => sum + n, 0), 8);
});

/** 大步快进直到没有待处理任务（战斗跑完）。返回迭代次数（≈tick 数，用于比较战斗时长）。 */
async function drain(app: GameApp): Promise<number> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < 30000) {
    await app.scheduler.advanceTo(clock + 3_600_000, setClock);
    iters++;
  }
  return iters;
}

/** 造一个近战兵快照条目。 */
function melee(count: number, atk: number, def: number) {
  return { count, form: 'melee', meleeAtk: atk, rangedAtk: 0, meleeDef: def, rangedDef: def, carry: 10 };
}

/** 用 combat.Engage 打 PvE 目标 pve-0(老鼠窝)，返回结束事件。 */
async function engagePve(app: GameApp, targetId: string, attackerSnapshot: Record<string, any>, troops: Record<string, number>) {
  let ended: any = null;
  app.bus.on('combat.BattleEnded', (e) => { if ((e.payload as any).side === 'attacker') ended = e.payload; });
  await send(app, 'combat.Engage', {
    targetKind: 'pve', targetId, targetXY: { q: 0, r: 0 },
    movementId: 'mv-test', fromVillage: 'v1', fromXY: { q: 0, r: 0 },
    troops, attackerSnapshot,
  });
  await drain(app);
  return ended;
}

test('战斗：压倒性兵力速胜且几乎无损', async () => {
  const app = freshApp();
  // 老鼠窝：10 只老鼠(近战5/防10)。派 50 军团兵 → 应速胜，损失极小。
  const ended = await engagePve(app, 'pve-0', { legionnaire: melee(50, 40, 35) }, { legionnaire: 50 });
  assert.ok(ended, '应有战斗结束事件');
  assert.equal(ended.attackerWins, true, '压倒性兵力应胜');
  const lost = ended.attackerLosses.legionnaire ?? 0;
  assert.ok(lost < 5, `压倒性胜利损失应很小，实际损失 ${lost}`);
});

test('PvE 掠夺：运力足够时可搬空营地全部资源且不超过 carry', async () => {
  const app = freshApp();
  // 用任务标记的测试营地避免 drain 快进触发普通营地的自动重生，便于核对库存归零。
  const spawned = await send(app, 'pve.Spawn', { id: 'pve-loot-all', type: 'rats', q: 20, r: 20, task: true, ownerVillageId: 'v1' });
  assert.equal(spawned.ok, true, '测试营地应生成成功');
  const ended = await engagePve(app, 'pve-loot-all', { legionnaire: melee(100, 40, 35) }, { legionnaire: 100 });
  assert.equal(ended.attackerWins, true, '应清空老鼠窝');
  assert.deepEqual(
    { wood: ended.looted.wood, clay: ended.looted.clay, iron: ended.looted.iron, crop: ended.looted.crop },
    { wood: 200, clay: 200, iron: 100, crop: 100 },
    '运力足够时四种营地资源都应完整带回',
  );
  const totalLoot = Object.values(ended.looted as Record<string, number>).reduce((sum, amount) => sum + amount, 0);
  assert.ok(totalLoot <= 1000, `带回总量 ${totalLoot} 不得超过 100 个单位的 carry=1000`);
  const target = await send(app, 'pve.GetTarget', { id: 'pve-loot-all' });
  assert.deepEqual((target.payload as any).loot, { wood: 0, clay: 0, iron: 0, crop: 0 }, '搬空后营地库存应归零');
});

test('PvE 掠夺：金币优先，余下运力平均带回四种资源', async () => {
  const app = freshApp();
  const targetId = 'pve-loot-gold-first';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'rats', q: 21, r: 21, task: true, ownerVillageId: 'v1',
    loot: { wood: 100, clay: 100, iron: 100, crop: 100, gold: 3 },
  });
  assert.equal(spawned.ok, true, '测试营地应生成成功');
  const ended = await engagePve(app, targetId, { legionnaire: melee(2, 40, 35) }, { legionnaire: 2 });
  assert.equal(ended.attackerWins, true, '应清空测试营地');
  assert.deepEqual(
    ended.looted,
    { gold: 3, wood: 5, clay: 4, iron: 4, crop: 4 },
    '应先带走全部金币，再将剩余运力平均分给四种资源',
  );
  assert.equal(Object.values(ended.looted as Record<string, number>).reduce((sum, amount) => sum + amount, 0), 20, '不得超过两名军团兵的 carry=20');
});

test('PvE 失败战斗：幸存守军不能因快照引用被结算重复扣除', async () => {
  const app = freshApp();
  const targetId = 'pve-defender-snapshot-isolation';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId, type: 'tianwang_village', q: 6, r: 6, task: true, ownerVillageId: 'v1',
  });
  assert.equal(spawned.ok, true);
  // 10 个军团兵对 13 个条顿棍棒兵时，战斗失败但应留下 3 个守军。
  const targetState = app.store.get<any>('pve', targetId)!;
  targetState.defender.clubswinger.count = 13;
  app.store.set('pve', targetId, targetState);

  let ended: any;
  app.bus.on('combat.BattleEnded', (event) => {
    if ((event.payload as any).side === 'attacker') ended = event.payload;
  });
  await send(app, 'combat.Engage', {
    targetKind: 'pve', targetId, targetXY: { q: 6, r: 6 },
    movementId: 'pve-defender-snapshot-attack', fromVillage: 'v1', fromXY: { q: 5, r: 6 },
    troops: { legionnaire: 10 },
    attackerSnapshot: { legionnaire: melee(10, 40.4, 35.35) },
  });
  await drain(app);

  assert.equal(ended?.attackerWins, false, '该配置应由守方获胜');
  assert.deepEqual(ended?.defenderLosses, { clubswinger: 10 }, '战报应记录实际守军损失');
  const after = (await send(app, 'pve.GetTarget', { id: targetId })).payload as any;
  assert.equal(after.cleared, false, '失败战斗不应清空任务村');
  assert.equal(after.defender.clubswinger.count, 3, '失败战斗后 3 个幸存守军必须保留');
});

test('战斗：势均力敌打得久、一边倒打得快（tick 数对比）', async () => {
  // 一边倒：50 打 10 老鼠
  const app1 = freshApp();
  let onesidedTicks = 0;
  app1.bus.on('combat.BattleEnded', () => {});
  await send(app1, 'combat.Engage', {
    targetKind: 'pve', targetId: 'pve-0', targetXY: { q: 0, r: 0 },
    movementId: 'mv-a', fromVillage: 'v1', fromXY: { q: 0, r: 0 },
    troops: { legionnaire: 50 }, attackerSnapshot: { legionnaire: melee(50, 40, 35) },
  });
  onesidedTicks = await drain(app1);

  // 势均力敌：用刚好能打赢但接近的兵力打同一个窝
  const app2 = freshApp();
  await send(app2, 'combat.Engage', {
    targetKind: 'pve', targetId: 'pve-0', targetXY: { q: 0, r: 0 },
    movementId: 'mv-b', fromVillage: 'v1', fromXY: { q: 0, r: 0 },
    troops: { legionnaire: 3 }, attackerSnapshot: { legionnaire: melee(3, 40, 35) },
  });
  const evenTicks = await drain(app2);

  // 势均力敌的战斗应比一边倒耗更多 tick（打得更久）
  assert.ok(evenTicks >= onesidedTicks, `势均力敌(${evenTicks}) 应 >= 一边倒(${onesidedTicks}) tick`);
});

test('战斗：防守方全胜时进攻方全灭、无返程', async () => {
  const app = freshApp();
  // 1 个弱兵打 40 强盗营地 → 必败，全灭
  let ended: any = null;
  app.bus.on('combat.BattleEnded', (e) => { if ((e.payload as any).side === 'attacker') ended = e.payload; });
  await send(app, 'combat.Engage', {
    targetKind: 'pve', targetId: 'pve-4', targetXY: { q: 0, r: 0 },
    movementId: 'mv-c', fromVillage: 'v1', fromXY: { q: 0, r: 0 },
    troops: { legionnaire: 1 }, attackerSnapshot: { legionnaire: melee(1, 40, 35) },
  });
  await drain(app);
  assert.ok(ended, '应有战斗结束事件');
  assert.equal(ended.attackerWins, false, '弱兵应败');
  assert.equal(Object.keys(ended.survivors).length, 0, '败方应全灭无幸存');
});

test('M8/M9 天王老子村即使缺少旧 task 标记也不直接掉落宝物', async () => {
  // 旧存档可能只有 tianwang_village 类型，没有 task=true。即使强制让普通
  // 掉落概率命中，也不能把铁壁勋章（或其它宝物）作为清营战利品直接发放；
  // 铁壁勋章只能由 m8/m9 的手动领取奖励路径产生。
  const app = createGameApp({ now: () => clock, manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const targetId = 'legacy-tianwang-no-task';
  const spawned = await send(app, 'pve.Spawn', {
    id: targetId,
    type: 'tianwang_village',
    q: 20,
    r: 20,
    ownerVillageId: 'legacy-owner',
  });
  assert.equal(spawned.ok, true);

  const pending: any[] = [];
  app.bus.on('treasure.PendingDropped', (evt) => { pending.push(evt.payload); });
  await send(app, 'combat.Engage', {
    targetKind: 'pve', targetId, targetXY: { q: 20, r: 20 },
    movementId: 'legacy-tianwang-attack', fromVillage: 'legacy-owner', fromXY: { q: 19, r: 20 },
    troops: { legionnaire: 100 }, attackerSnapshot: { legionnaire: melee(100, 1000, 100) },
  });
  await drain(app);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pending.length, 0, '天王老子村清空不能走普通 PvE 宝物掉落');
  assert.equal(app.store.all<any>('treasure_pending').length, 0, '不能创建直接掉落的待领取宝物');
});
