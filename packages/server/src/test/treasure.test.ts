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
const setClock = (t: number) => { clock = t; };
async function freshApp(rng?: () => number): Promise<GameApp> {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true, rng });
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

test('宝物：旧村庄缺 treasure 文档也能授予（懒创建 ensureState）', async () => {
  const app = await freshApp();
  // 模拟宝物模块上线前创建的村庄：删掉已生成的 treasure 文档，再授予
  app.store.delete('treasure', 'v1');
  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(g.ok, true, '缺文档的旧村庄授予也应成功（懒创建）: ' + (g.reason ?? ''));
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], '懒创建后应有 chainsaw');
});

test('宝物掉落：门控命中(forceCode) → 直接入栏', async () => {
  const app = await freshApp();
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', forceCode: 'chainsaw' });
  assert.equal(drop.ok, true, 'RollDrop 应成功');
  assert.ok(drop.payload.dropped, '应掉落');
  assert.equal(drop.payload.dropped.code, 'chainsaw', '强制抽中 chainsaw');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], 'chainsaw 应入栏');
});

test('宝物掉落：栏满自动售卖换金', async () => {
  const app = await freshApp();
  const r0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gold0 = r0.resources.gold;
  // 先占满唯一栏位（城镇中心基础 1 格）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  // 再掉落一个不同宝物 → 栏满 → 自动售卖（chainsaw 售价 60 金币）
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', forceCode: 'chainsaw' });
  assert.equal(drop.ok, true);
  assert.ok(drop.payload.dropped, '应掉落（即便溢出）');
  assert.equal(drop.payload.dropped.sold, true, '栏满应标记售出');
  assert.equal(drop.payload.dropped.gold, 60, '售出价应=chainsaw 的 priceGold');
  const r1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r1.resources.gold, gold0 + 60, '金币应增加售出价');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['war_flag'], '栏位未被 chainsaw 占用');
});

test('宝物掉落：门控未命中(高 RNG) → 无掉落', async () => {
  // rng 恒返回 0.99，远高于默认 camp 概率 0.15 → 不掉落
  const app = await freshApp(() => 0.99);
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp' });
  assert.equal(drop.ok, true);
  assert.equal(drop.payload.dropped, null, '应无掉落');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], '不应有宝物');
});

test('宝物掉落：门控命中(低 RNG) → 加权抽到某宝物并入栏', async () => {
  // rng 恒返回 0 → 命中门控(0<0.15)，且 weightedPick 取首个 dropRate>0 的宝物(chainsaw)
  const app = await freshApp(() => 0);
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp' });
  assert.equal(drop.ok, true);
  assert.ok(drop.payload.dropped, '应掉落');
  assert.equal(drop.payload.dropped.code, 'chainsaw', 'rng=0 应抽中首个宝物');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list.codes.length, 1, '应入栏一个宝物');
});

test('宝物出售：被动宝物卖给 NPC 换金币并移除', async () => {
  const app = await freshApp();
  const r0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gold0 = r0.resources.gold;
  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(g.ok, true, '授予 chainsaw 应成功');
  // chainsaw priceGold=60
  const s = await send(app, 'treasure.Sell', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(s.ok, true, '出售应成功');
  assert.equal(s.payload.gold, 60, '应得 priceGold=60 金币');
  const r1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r1.resources.gold, gold0 + 60, '金币应 +60');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], 'chainsaw 应已移除');
});

test('宝物丢弃：直接移除不给金币', async () => {
  const app = await freshApp();
  const r0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gold0 = r0.resources.gold;
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const d = await send(app, 'treasure.Discard', { villageId: 'v1', code: 'war_flag' });
  assert.equal(d.ok, true, '丢弃应成功');
  const r1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r1.resources.gold, gold0, '丢弃不应给金币');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], 'war_flag 应已移除');
});

test('宝物出售：未持有的宝物返回 not_held', async () => {
  const app = await freshApp();
  const s = await send(app, 'treasure.Sell', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(s.ok, false, '未持有应失败');
  assert.equal(s.reason, 'not_held', '应返回 not_held');
});

test('宝库：SetSlots 推高槽位后可储存更多宝物', async () => {
  const app = await freshApp();
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l0.slots, 1, '开局仅城镇中心 1 格');

  // 占满唯一栏位
  const g1 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  assert.equal(g1.ok, true);
  const g2 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  assert.equal(g2.ok, false, '栏满应拒绝第二个');
  assert.equal(g2.reason, 'treasure_slots_full');

  // 建造宝库效果等价：building 推送额外 5 格
  const set = await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 5 });
  assert.equal(set.ok, true, 'SetSlots 应成功');
  const l1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l1.slots, 6, '总槽位应为 1+5=6');

  const g3 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  assert.equal(g3.ok, true, '槽位扩充后应可入库');
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l2.codes.sort(), ['chainsaw', 'war_flag'], '两个宝物均应入库');
});

test('宝库：建造/落成经 building 推送 SetSlots，槽位随等级增加', async () => {
  const app = await freshApp();
  // 给足资源以秒建
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l0.slots, 1, '开局仅 1 格');

  // 城内建造宝库（requires 主城1级，开局已满足）
  const b = await send(app, 'building.Build', { villageId: 'v1', zone: 'inner', kind: 'treasury' });
  assert.equal(b.ok, true, `建造宝库应成功: ${b.reason ?? ''}`);
  // 完成（treasury L1 的 timeSec=2，推进 60s 一定落成）
  await app.scheduler.advanceTo(clock + 60_000, (t) => { clock = t; });

  const l1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  // treasury L1 每级 +1 槽位 ⇒ 总槽位 2
  assert.equal(l1.slots, 2, '宝库 L1 落成后总槽位应为 2');

  // 升级到 L2 ⇒ 总槽位 3
  const up = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: (await layoutOf(app)).slotId, });
  assert.equal(up.ok, true, `升级宝库应成功: ${up.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 60_000, (t) => { clock = t; });
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l2.slots, 3, '宝库 L2 落成后总槽位应为 3');
});

test('宝库：拆除宝库后槽位回退到城镇中心基础 1 格（不强制挤出已持有）', async () => {
  const app = await freshApp();
  // 先塞两个宝物到栏（开局只有 1 格，先扩到 2）
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l0.slots, 2, '扩槽后应为 2');

  // 槽位回退到 0（等价拆除宝库）
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 0 });
  const l1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l1.slots, 1, '回退后槽位应为 1');
  assert.equal(l1.codes.length, 2, '已持有宝物不被强制挤出（仅阻止后续新增）');
  const g = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'blessing_of_gods' });
  assert.equal(g.ok, false, '槽位不足时应拒绝新增');
  assert.equal(g.reason, 'treasure_slots_full');
});

// 取本村宝库在布局中的 slotId（用于升级测试）
async function layoutOf(app: GameApp): Promise<{ slotId: string }> {
  const l = (await send(app, 'building.GetLayout', { villageId: 'v1' })).payload as any;
  const t = l.zones.inner.placed.find((p: any) => p.kind === 'treasury');
  if (!t) throw new Error('宝库未找到');
  return { slotId: t.slotId };
}

