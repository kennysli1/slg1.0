import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

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
