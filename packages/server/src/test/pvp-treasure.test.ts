import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 宝物在 PvP 出征中的携带/归属规则回归测试。
 *
 * 规则（用户需求）：
 *  1) 仅在自己的村落之间移动（改驻扎地）时，宝物随军队转移到目的地村落。
 *  2) 进攻/支援/掠夺/屠城其他玩家村落时：
 *     - 军队未被全灭、能返程 → 宝物带回出发村落（origin）。
 *     - 军队被全灭 → 宝物成为防守方村落的战利品（deliver pending）。
 *
 * 历史 bug：movement.arriveEngage 未把 mv.treasures 转发给 combat.Engage，
 * 导致 combat.BattleEnded.treasures 恒为空，全灭分支的 treasure.LoseCarried
 * 永不触发 → 携带记录被孤立 → 宝物凭空消失。本文件锁定修复后的行为。
 *
 * （规则 1 的“本村之间转移”由 transport 路径 offloadForeign 处理，另有测试覆盖；
 *  本文件聚焦规则 2 的两条 PvP 出征分支。）
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd: string, tribe = 'romans') =>
  send(app, 'player.Register', { name, password: pwd, tribe });

async function drain(app: GameApp, bigStepMs = 3_600_000, maxIters = 30000): Promise<void> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < maxIters) {
    await app.scheduler.advanceTo(clock + bigStepMs, setClock);
    iters++;
  }
}

const listTreasures = async (app: GameApp, vid: string): Promise<string[]> => {
  const r = await send(app, 'treasure.List', { villageId: vid });
  return ((r.payload as any)?.treasures ?? []).map((t: any) => t.code);
};
const listPending = async (app: GameApp, vid: string): Promise<string[]> => {
  const r = await send(app, 'treasure.List', { villageId: vid });
  return ((r.payload as any)?.pending ?? []).map((p: any) => p.code);
};
const px = (p: any) => p.q ?? p.x ?? 0;
const py = (p: any) => p.r ?? p.y ?? 0;

test('PvP 进攻带宝物：军队未被全灭返程 → 宝物带回出发村落', async () => {
  const app = freshApp();
  const a = (await reg(app, '进攻方', 'p1234')).payload as any;
  const b = (await reg(app, '防守方', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  // 给 A 一个宝物
  const g = await send(app, 'treasure.Grant', { villageId: va, code: 'chainsaw' });
  assert.equal(g.ok, true, `授予宝物应成功: ${g.reason ?? ''}`);

  // 携带需要 >=200 兵（treasure_carry_troops_per_slot=200）。直接调兵绕过训练。
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 300 } });

  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { q: px(a.player), r: py(a.player) },
    targetVillage: vb, toXY: { q: px(b.player), r: py(b.player) },
    troops: { legionnaire: 300 }, treasures: ['chainsaw'],
  });
  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);

  // 出征途中：宝物应已装上军队，不在 A 村落栏内
  const inTransit = await listTreasures(app, va);
  assert.ok(!inTransit.includes('chainsaw'), `出征途中宝物应在军队上，不应留在 A 栏: ${JSON.stringify(inTransit)}`);

  // B 无守军 → A 全胜返程
  await drain(app);

  const after = await listTreasures(app, va);
  assert.ok(after.includes('chainsaw'), `宝物应随军队返回 A，实际: ${JSON.stringify(after)}`);

  // 防守方 B 不应获得该宝物
  const bAfter = await listTreasures(app, vb);
  assert.ok(!bAfter.includes('chainsaw'), `B 不应获得宝物: ${JSON.stringify(bAfter)}`);
});

test('PvP 进攻带宝物：军队被全灭 → 宝物成为防守方战利品', async () => {
  const app = freshApp();
  const a = (await reg(app, '送死方', 'p1234')).payload as any;
  const b = (await reg(app, '守军方', 'p1234')).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;

  const g = await send(app, 'treasure.Grant', { villageId: va, code: 'chainsaw' });
  assert.equal(g.ok, true, `授予宝物应成功: ${g.reason ?? ''}`);

  // A 派 300 兵(带宝物)，B 有 1000 守军 → A 全灭
  await send(app, 'military.AdjustTroops', { villageId: va, delta: { legionnaire: 300 } });
  await send(app, 'military.AdjustTroops', { villageId: vb, delta: { legionnaire: 1000 } });

  const atk = await send(app, 'movement.SendAttack', {
    villageId: va, fromXY: { q: px(a.player), r: py(a.player) },
    targetVillage: vb, toXY: { q: px(b.player), r: py(b.player) },
    troops: { legionnaire: 300 }, treasures: ['chainsaw'],
  });
  assert.equal(atk.ok, true, `攻击应发出: ${atk.reason ?? ''}`);

  // 逐步推进（每次 60s），在 B 的 deliver pending 超时(3600s)前抓取它
  let foundPending = false;
  for (let i = 0; i < 200 && app.scheduler.pending > 0; i++) {
    await app.scheduler.advanceTo(clock + 60_000, setClock);
    const pend = await listPending(app, vb);
    if (pend.includes('chainsaw')) { foundPending = true; break; }
  }

  const bTreasures = await listTreasures(app, vb);
  const finalPending = await listPending(app, vb);
  assert.ok(
    foundPending || bTreasures.includes('chainsaw') || finalPending.includes('chainsaw'),
    `宝物应成为 B 的战利品(pending 或已入栏)，实际 B栏:${JSON.stringify(bTreasures)} B待领:${JSON.stringify(finalPending)}`,
  );

  // 出发方 A 不应再持有该宝物
  const aAfter = await listTreasures(app, va);
  assert.ok(!aAfter.includes('chainsaw'), `A 被全灭不应仍持有宝物: ${JSON.stringify(aAfter)}`);
});
