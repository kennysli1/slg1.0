import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 宝物系统集成测试：验证「宝物栏存储 + 效果应用（铁律#4 推送）」端到端生效。
 *  - woodRate 被动 → 经济木产率 +5%（economy.SetRateModifier）
 *  - atkMult  被动 → 军事攻防快照 +5%（military.SetTreasureCombatMult）
 *  - popGrowth 被动 → 人口增长 +40%（population.SetTreasureGrowthMult）
 *  - instantGold 即时 → treasure.Use 发放金币并移除
 *  - 槽位限制：城镇中心基础 1 格，满则拒绝授予
 */

let clock = 1_000_000;
async function freshApp(): Promise<GameApp> {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  // 必须 await —— treasure.createVillage 在 doCreateVillage 的首个 await 之后执行，
  // 不同步等待会导致宝物状态尚未写入，Grant 报 village_not_found。
  await app.createVillage('v1', 0, 0, '测试村');
  return app;
}
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}

test('宝物：woodRate 被动提升木产率 (+5%)', async () => {
  const app = await freshApp();
  const before = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const woodBefore = before.netRate.wood;
  assert.ok(woodBefore > 0, '开局应有木产率');

  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(g.ok, true, `授予 chainsaw 应成功: ${g.reason ?? ''}`);

  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  // grossRate = base × (1 + Σ mult.wood)；chainsaw woodRate=5 → mult.wood=0.05
  assert.ok(Math.abs(after.netRate.wood - woodBefore * 1.05) < 1e-6,
    `木产率应 ×1.05: before=${woodBefore} after=${after.netRate.wood}`);
});

test('宝物：atkMult 被动提升军事攻防快照 (+5%)', async () => {
  const app = await freshApp();
  const a0 = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  const baseAtk = a0.trainable.find((u: any) => u.key === 'legionnaire').meleeAtk;
  assert.ok(baseAtk > 0, 'legionnaire 应有基础攻');

  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  assert.equal(g.ok, true, `授予 war_flag 应成功: ${g.reason ?? ''}`);

  const a1 = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  const newAtk = a1.trainable.find((u: any) => u.key === 'legionnaire').meleeAtk;
  // 铁匠0级→bonus=1；war_flag atkMult=5 → ×1.05
  assert.ok(Math.abs(newAtk - baseAtk * 1.05) < 1e-6,
    `攻防应 ×1.05: base=${baseAtk} new=${newAtk}`);
});

test('宝物：popGrowth 被动提升人口增长 (+40%)', async () => {
  const app = await freshApp();
  const s0 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  const grow0 = s0.potentialGrowthPerHour;
  assert.ok(grow0 > 0, '开局应有正增长');

  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'blessing_of_gods' });
  assert.equal(g.ok, true, `授予 blessing_of_gods 应成功: ${g.reason ?? ''}`);

  const s1 = (await send(app, 'population.GetSnapshot', { villageId: 'v1' })).payload as any;
  // blessing_of_gods popGrowth=40 → ×1.40
  assert.equal(s1.potentialGrowthPerHour, Math.round(grow0 * 1.4),
    `增长应 ×1.40: before=${grow0} after=${s1.potentialGrowthPerHour}`);
});

test('宝物：instantGold 经 Use 发放金币并移除', async () => {
  const app = await freshApp();
  const r0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gold0 = r0.resources.gold;

  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'money_bag' });
  assert.equal(g.ok, true, `授予 money_bag 应成功: ${g.reason ?? ''}`);

  const u = await send(app, 'treasure.Use', { villageId: 'v1', code: 'money_bag' });
  assert.equal(u.ok, true, `使用 money_bag 应成功: ${u.reason ?? ''}`);
  assert.equal(u.payload.gold, 300, '应发放 300 金币');

  const r1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r1.resources.gold, gold0 + 300, '金币应 +300');

  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], '使用后 code 应已被移除');
});

test('宝物：槽位满时拒绝授予', async () => {
  const app = await freshApp();
  const g1 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(g1.ok, true, '首格授予应成功');

  const g2 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  assert.equal(g2.ok, false, '第二格应被拒');
  assert.equal(g2.reason, 'treasure_slots_full', '应返回槽位满原因');
});
