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
  const raw = app.store.get<any>('building', 'v1');
  for (const p of raw.placed) {
    if (['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(p.kind)) {
      p.level = 1;
      delete p.repairTargetLevel;
    }
  }
  app.store.set('building', 'v1', raw);
  app.building.reReportProduction('v1');
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

test('宝物：旧版 locked 桶中的勇士之证迁入城镇中心，可正常交互', async () => {
  const app = await freshApp();
  const legacy = app.store.get<any>('treasure', 'v1');
  app.store.set('treasure', 'v1', { ...legacy, town: [], treasury: [], locked: ['warrior_token'] });

  const listed = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(listed.town, ['warrior_token'], '旧凭证应迁入城镇中心栏位');
  assert.deepEqual(listed.treasury, [], '未建宝库时不应显示在宝库');
  assert.deepEqual(listed.locked, [], '旧锁定桶应被清空');
  assert.deepEqual(listed.codes, ['warrior_token'], '列表应返回可管理的凭证');

  const discarded = await send(app, 'treasure.Discard', { villageId: 'v1', code: 'warrior_token' });
  assert.equal(discarded.ok, true, `迁移后的凭证应可交互: ${discarded.reason ?? ''}`);
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

test('宝物：栏内全部被动宝物生效，同名宝物也叠加', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 3 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'dragon_banner' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'dragon_banner' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'spear_of_ares' });
  const listed = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(listed.activeCodes, ['dragon_banner', 'dragon_banner', 'spear_of_ares'], '主栏宝物应作为生效列表下发');
  assert.equal(listed.effect.atkMult, 1.78);
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

test('宝物掉落：门控命中(forceCode) → 生成待领取记录（不直接入栏）', async () => {
  const app = await freshApp();
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-1', forceCode: 'chainsaw' });
  assert.equal(drop.ok, true, 'RollDrop 应成功');
  assert.ok(drop.payload.dropped, '应掉落');
  assert.equal(drop.payload.dropped.code, 'chainsaw', '强制抽中 chainsaw');
  assert.equal(drop.payload.dropped.pending, true, '应为待领取');
  // 未确认前不应入栏
  let list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], '确认前不应入栏');
  assert.equal(list.pending.length, 1, '应有 1 条待领取');
  assert.equal(list.pending[0].code, 'chainsaw', '待领取 code 应为 chainsaw');
  // 模拟军队归村（标记 pending 已到达），方可领取
  const pend1 = app.store.get<any>('treasure_pending', 'mv-1');
  pend1.arrivedAt = 1_000_001;
  app.store.set('treasure_pending', 'mv-1', pend1);
  // 确认领取 → 入栏
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'mv-1' });
  assert.equal(claim.ok, true, '确认应成功');
  list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], '确认后 chainsaw 应入栏');
  assert.equal(list.pending.length, 0, '确认后待领取应清空');
});

test('宝物掉落：栏满时确认 → 拒绝领取(no_room)，需显式出售/遗弃', async () => {
  const app = await freshApp();
  // 启用贸易中心，使「出售」可用（无贸易中心时只能「丢弃」，不换金）
  await send(app, 'treasure.SetTradeCenter', { villageId: 'v1', hasTradeCenter: true });
  const r0 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gold0 = r0.resources.gold;
  // 先占满唯一栏位（城镇中心基础 1 格）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  // 掉落一个不同宝物 → 待领取
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-2', forceCode: 'chainsaw' });
  assert.equal(drop.ok, true);
  assert.ok(drop.payload.dropped, '应掉落（待领取）');
  // 模拟军队归村（标记 pending 已到达），方可领取
  const pend2 = app.store.get<any>('treasure_pending', 'mv-2');
  pend2.arrivedAt = 1_000_001;
  app.store.set('treasure_pending', 'mv-2', pend2);
  // 确认领取（默认收下）→ 栏满 → 拒绝 no_room，绝不静默自动售卖
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'mv-2' });
  assert.equal(claim.ok, false, '栏满时确认应被拒');
  assert.equal(claim.reason, 'no_room', '应返回 no_room');
  const r1 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r1.resources.gold, gold0, '金币不应因误领而变动');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['war_flag'], '栏位仍只含 war_flag');
  assert.equal(list.pending.length, 1, '待领取应保留');
  // 显式「出售」→ 换金并移除报告
  const sell = await send(app, 'treasure.ClaimPending', { movementId: 'mv-2', decision: 'sell' });
  assert.equal(sell.ok, true, `出售应成功: ${sell.reason ?? ''}`);
  assert.equal(sell.payload.sold, true, '应标记为已售');
  assert.equal(sell.payload.gold, 60, '售出价应=chainsaw 的 priceGold');
  const r2 = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(r2.resources.gold, gold0 + 60, '金币应增加售出价');
  const list2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list2.pending.length, 0, '出售后报告应清除');
  assert.deepEqual(list2.codes, ['war_flag'], '栏位未被 chainsaw 占用');
});

test('宝物掉落：门控未命中(高 RNG) → 无掉落', async () => {
  // rng 恒返回 0.99，远高于默认 camp 概率 0.15 → 不掉落
  const app = await freshApp(() => 0.99);
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-3' });
  assert.equal(drop.ok, true);
  assert.equal(drop.payload.dropped, null, '应无掉落');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], '不应有宝物');
  assert.equal(list.pending.length, 0, '不应有待领取');
});

test('宝物掉落：门控命中(低 RNG) → 加权抽到某宝物并待领取', async () => {
  // rng 恒返回 0 → 命中门控(0<0.15)，且 weightedPick 取首个 dropRate>0 的宝物(chainsaw)
  const app = await freshApp(() => 0);
  const drop = await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-4' });
  assert.equal(drop.ok, true);
  assert.ok(drop.payload.dropped, '应掉落');
  assert.equal(drop.payload.dropped.code, 'chainsaw', 'rng=0 应抽中首个宝物');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list.pending.length, 1, '应生成 1 条待领取');
  assert.equal(list.pending[0].code, 'chainsaw', '待领取 code 应为 chainsaw');
});

test('任务/送达宝物：待处理报告不设置倒计时，超时后仍可领取', async () => {
  const app = await freshApp();
  // 占满主栏，让任务奖励走报告待处理路径。
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const granted = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw', pendingIfFull: true, rewardVillageId: 'v1' });
  assert.equal(granted.ok, true);
  const listed = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(listed.pending.length, 1);
  const pendingId = listed.pending[0].movementId;
  const raw = app.store.get<any>('treasure_pending', pendingId);
  assert.equal(raw.expiresAt, undefined, '任务奖励不应有过期时间');
  await app.scheduler.advanceTo(clock + 10 * 60 * 60 * 1000, setClock);
  assert.ok(app.store.get<any>('treasure_pending', pendingId), '任务奖励不应被超时回收');
  const discarded = await send(app, 'treasure.ClaimPending', { movementId: pendingId, decision: 'discard' });
  assert.equal(discarded.ok, true, '超时后仍可处理任务奖励');

  const drop = await send(app, 'treasure.RollDrop', {
    villageId: 'v1', source: 'camp', movementId: 'mv-task-drop', forceCode: 'captured_natalies', taskRelated: true,
  });
  assert.equal(drop.ok, true);
  const taskPending = app.store.get<any>('treasure_pending', 'mv-task-drop');
  assert.equal(taskPending.expiresAt, undefined, '任务专属 PvE 掉落不应有过期时间');
});

test('待领取：不存在的 movementId 确认 → pending_not_found', async () => {
  const app = await freshApp();
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'nope' });
  assert.equal(claim.ok, false, '应失败');
  assert.equal(claim.reason, 'pending_not_found', '应返回 pending_not_found');
});

test('待领取：过期后确认 → pending_expired 且记录已清除', async () => {
  const app = await freshApp();
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-exp', forceCode: 'chainsaw' });
  // 直接把待领取记录的 expiresAt 改成过去，模拟已超时
  const p = app.store.get<any>('treasure_pending', 'mv-exp');
  p.expiresAt = 1; // 远小于当前 clock(1_000_000)
  app.store.set('treasure_pending', 'mv-exp', p);
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'mv-exp' });
  assert.equal(claim.ok, false, '应失败');
  assert.equal(claim.reason, 'pending_expired', '应返回 pending_expired');
  assert.equal(app.store.get('treasure_pending', 'mv-exp'), undefined, '过期记录应被清除');
});

test('待领取：军队未归村时确认 → army_not_returned（Bug3 回归）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-noret', forceCode: 'chainsaw' });
  // 未标记 arrivedAt（军队尚未归村），直接确认应被拒绝
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'mv-noret' });
  assert.equal(claim.ok, false, '应失败');
  assert.equal(claim.reason, 'army_not_returned', '应返回 army_not_returned');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list.pending.length, 1, '待领取记录应仍存在（未误删）');
  // 标记归村后再次确认应成功
  const pend = app.store.get<any>('treasure_pending', 'mv-noret');
  pend.arrivedAt = 1_000_001;
  app.store.set('treasure_pending', 'mv-noret', pend);
  const claim2 = await send(app, 'treasure.ClaimPending', { movementId: 'mv-noret' });
  assert.equal(claim2.ok, true, '归村后确认应成功');
});

test('待领取：MarkPendingArrived 仅对 camp 生效且幂等', async () => {
  const app = await freshApp();
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-arr', forceCode: 'chainsaw' });
  const r1 = await send(app, 'treasure.MarkPendingArrived', { movementId: 'mv-arr' });
  assert.equal(r1.ok, true, '应成功');
  assert.equal(r1.payload.marked, true, '首次标记应 marked=true');
  const p1 = app.store.get<any>('treasure_pending', 'mv-arr');
  assert.ok(p1.arrivedAt, 'arrivedAt 应被设置');
  const r2 = await send(app, 'treasure.MarkPendingArrived', { movementId: 'mv-arr' });
  assert.equal(r2.payload.marked, false, '重复标记应 marked=false');
  const r3 = await send(app, 'treasure.MarkPendingArrived', { movementId: 'mv-missing' });
  assert.equal(r3.ok, true, '不存在的 movementId 也应 ok');
  assert.equal(r3.payload.marked, false, '不存在应 marked=false');
});

test('待领取：超时由调度器自动遗弃（真实时钟推进）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-timeout', forceCode: 'chainsaw' });
  const p = app.store.get<any>('treasure_pending', 'mv-timeout');
  assert.ok(p, '应存在待领取记录');
  // 推进时钟越过 expiresAt，并触发调度器到点任务
  await app.scheduler.advanceTo(p.expiresAt + 1000, setClock);
  assert.equal(app.store.get('treasure_pending', 'mv-timeout'), undefined, '超时后待领取记录应被自动遗弃');
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
  assert.equal(l1.slots, 11, '总槽位应为城镇中心1+主栏5+备用栏5=11');

  const g3 = await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  assert.equal(g3.ok, true, '槽位扩充后应可入库');
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l2.codes.sort(), ['chainsaw', 'war_flag'], '两个宝物均应入库');
});

test('宝库：主栏生效、备用栏不生效，卸下/装载均需玩家主动操作', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  const stored = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(stored.town, ['war_flag'], '新获得的宝物应优先进入城镇中心');
  assert.deepEqual(stored.treasury, ['chainsaw'], '城镇中心满后才进入宝库主栏');
  const before = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  const baseAtk = before.trainable.find((u: any) => u.key === 'legionnaire').meleeAtk;
  assert.ok(baseAtk > 0);

  const unload = await send(app, 'treasure.Unload', { villageId: 'v1', code: 'war_flag', from: 'town' });
  assert.equal(unload.ok, true, `主栏宝物应可卸下: ${unload.reason ?? ''}`);
  const parked = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(parked.treasury, ['chainsaw'], '宝库主栏宝物不应被隐式搬运');
  assert.deepEqual(parked.town, [], '卸下后城镇中心主栏应为空');
  assert.deepEqual(parked.treasuryReserve, ['war_flag'], '卸下后应进入备用栏');
  assert.equal(parked.needsLoad, true, '主栏出现空位且备用栏有宝物时应提醒');
  const parkedAtk = ((await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any).trainable.find((u: any) => u.key === 'legionnaire').meleeAtk;
  assert.equal(parkedAtk, baseAtk / 1.05, '备用栏宝物不应继续提供攻防加成');

  const load = await send(app, 'treasure.Load', { villageId: 'v1', code: 'war_flag' });
  assert.equal(load.ok, true, `备用栏宝物应可装载: ${load.reason ?? ''}`);
  const active = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(active.town, ['war_flag'], '装载后有城镇中心空位时应优先回到城镇中心');
  assert.deepEqual(active.treasury, ['chainsaw'], '装载不应挪动原宝库主栏宝物');
  assert.deepEqual(active.treasuryReserve, [], '装载后备用栏应为空');
  const activeAtk = ((await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any).trainable.find((u: any) => u.key === 'legionnaire').meleeAtk;
  assert.equal(activeAtk, baseAtk, '装载后攻防加成应恢复');
});

test('宝库：备用栏装载在城镇中心和宝库主栏都有空位时优先城镇中心', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const unload = await send(app, 'treasure.Unload', { villageId: 'v1', code: 'war_flag', from: 'town' });
  assert.equal(unload.ok, true);

  const load = await send(app, 'treasure.Load', { villageId: 'v1', code: 'war_flag' });
  assert.equal(load.ok, true, `备用栏有宝物且两个主栏都有空位时应可装载: ${load.reason ?? ''}`);
  assert.equal(load.payload.to, 'town', '装载落点应优先为城镇中心');
  const listed = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(listed.town, ['war_flag']);
  assert.deepEqual(listed.treasury, []);
  assert.deepEqual(listed.treasuryReserve, []);
});

test('宝库：备用栏已满或主栏已满时移动返回明确错误', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  const u1 = await send(app, 'treasure.Unload', { villageId: 'v1', code: 'war_flag', from: 'town' });
  assert.equal(u1.ok, true);
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'spear_of_ares' });
  const u2 = await send(app, 'treasure.Unload', { villageId: 'v1', code: 'spear_of_ares', from: 'town' });
  assert.equal(u2.ok, false);
  assert.equal(u2.reason, 'no_reserve_room');
  await send(app, 'treasure.Discard', { villageId: 'v1', code: 'spear_of_ares', location: 'town' });
  const l = await send(app, 'treasure.Load', { villageId: 'v1', code: 'war_flag' });
  assert.equal(l.ok, true, '主栏有空位时应可装载');
});

test('宝库：SetSlots 扩容时城镇中心宝物自动迁入宝库（Bug1 根因回归）', async () => {
  const app = await freshApp();
  // 起初只有城镇中心 1 格
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l0.slots, 1, '开局仅 1 格');
  assert.deepEqual(l0.treasury, [], '宝库初始为空');
  // 宝库未建时拿到的宝物一定落城镇中心
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  const l1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l1.town, ['chainsaw'], '宝物应在城镇中心');
  assert.deepEqual(l1.treasury, [], '宝库仍为空');
  // 建造宝库（等价 SetSlots extra=1）：城镇中心的宝物应自动迁入宝库
  const set = await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  assert.equal(set.ok, true);
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l2.town, [], '城镇中心应清空');
  assert.deepEqual(l2.treasury, ['chainsaw'], '原城镇中心宝物应迁入宝库');
});

test('宝库：旧存档（town 有宝+extraSlots 已存在）加载时保持主栏位置', async () => {
  // 模拟部署前的真实线上数据：宝库已建（extraSlots=1），但城镇中心仍留有 1 个旧宝物
  const app = await freshApp();
  app.store.set('treasure', 'v1', { villageId: 'v1', town: ['chainsaw'], treasury: [], carried: {}, extraSlots: 1 });
  // 任意触发 ensureState 的命令都会触发迁移
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l.town, ['chainsaw'], '加载时城镇中心宝物仍属于主栏');
  assert.deepEqual(l.treasury, [], '加载时宝库主栏仍为空');
  // 再次 List 应幂等
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l2.town, ['chainsaw'], '幂等：城镇中心仍含 1 个');
  assert.deepEqual(l2.treasury, [], '幂等：宝库仍为空');
});

test('迁移：resume 修复 pre-Bug3 遗留 pending（无 arrivedAt 且行军已删除）→ 标记归村', async () => {
  const app = await freshApp();
  // 模拟 pre-Bug3 真实线上数据：camp pending 无 arrivedAt，对应行军记录已被删除
  app.store.set('treasure_pending', 'mv-legacy-1', {
    movementId: 'mv-legacy-1', villageId: 'v1', code: 'chainsaw',
    name: '电锯', icon: '', category: 'economy', rarity: 'rare',
    effectType: 'woodRate', effectValue: 5, applyType: 'passive', priceGold: 30,
    kind: 'camp', createdAt: 100, expiresAt: clock + 3600_000,
  });
  await app.treasure.resume();
  const after = app.store.get<any>('treasure_pending', 'mv-legacy-1');
  assert.ok(after, '未过期记录应仍存在');
  assert.ok(after.arrivedAt, '无 arrivedAt 且行军已删除 → 应被标记归村（玩家可领取）');
});

test('迁移：resume 清理已超时的遗留 pending', async () => {
  const app = await freshApp();
  app.store.set('treasure_pending', 'mv-legacy-2', {
    movementId: 'mv-legacy-2', villageId: 'v1', code: 'war_flag',
    name: '军旗', icon: '', category: 'military', rarity: 'common',
    effectType: 'atkMult', effectValue: 5, applyType: 'passive', priceGold: 10,
    kind: 'camp', createdAt: 100, expiresAt: clock - 1000,
  });
  await app.treasure.resume();
  assert.equal(app.store.get('treasure_pending', 'mv-legacy-2'), undefined, '已超时记录应被清理');
});

test('迁移：resume 不误标仍在外的行军 pending（保持等待归村）', async () => {
  const app = await freshApp();
  // 行军记录仍存在（军队还在外，未归村）
  app.store.set('movement', 'mv-inflight', { id: 'mv-inflight', status: 'out', fromVillage: 'v1' });
  app.store.set('treasure_pending', 'mv-inflight', {
    movementId: 'mv-inflight', villageId: 'v1', code: 'chainsaw',
    name: '电锯', icon: '', category: 'economy', rarity: 'rare',
    effectType: 'woodRate', effectValue: 5, applyType: 'passive', priceGold: 30,
    kind: 'camp', createdAt: 100, expiresAt: clock + 3600_000,
  });
  await app.treasure.resume();
  const after = app.store.get<any>('treasure_pending', 'mv-inflight');
  assert.ok(after, '记录应存在');
  assert.equal(after.arrivedAt, undefined, '行军仍在场 → 不应标记归村（保持等待归村）');
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
  assert.equal(l1.slots, 3, '宝库 L1 落成后总槽位应为城镇中心1+主栏1+备用栏1=3');

  // 升级到 L2 ⇒ 总槽位 3
  const up = await send(app, 'building.Upgrade', { villageId: 'v1', slotId: (await layoutOf(app)).slotId, });
  assert.equal(up.ok, true, `升级宝库应成功: ${up.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 60_000, (t) => { clock = t; });
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l2.slots, 5, '宝库 L2 落成后总槽位应为城镇中心1+主栏2+备用栏2=5');
});

test('宝库：拆除宝库后归属转移——价值最高宝物留城镇中心，其余转为送达报告', async () => {
  const app = await freshApp();
  // 先塞两个宝物到栏（开局只有 1 格，先扩到 2）
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });   // priceGold 60
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });     // priceGold 70
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l0.slots, 3, '扩槽后应为 3（主栏1+备用栏1+城镇中心1）');

  // 槽位回退到 0（等价拆除宝库）
  const dem = await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 0 });
  assert.equal(dem.ok, true, '拆除应成功');
  assert.equal(dem.payload.slots, 1, '回退后槽位应为 1');
  assert.deepEqual(dem.payload.kept, ['war_flag'], '价值最高(war_flag)应留城镇中心');
  assert.deepEqual(dem.payload.pending, ['chainsaw'], '其余(chainsaw)应转送达报告');

  const l1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l1.slots, 1, '回退后槽位应为 1');
  assert.equal(l1.codes.length, 1, '仅留最高价值宝物在栏');
  assert.equal(l1.codes[0], 'war_flag', '留栏的应是价值最高的 war_flag');
  assert.equal(l1.pending.length, 1, '应产生 1 条送达报告');
  assert.equal(l1.pending[0].kind, 'deliver', '报告类型应为 deliver');
  assert.equal(l1.pending[0].code, 'chainsaw', '报告里的应是被挤出的 chainsaw');

  // 玩家决定「收下」但新宝物价值(60)不高于已留栏(70) → 拒绝降级，保留报告让玩家改选
  const claim = await send(app, 'treasure.ClaimPending', { villageId: 'v1', movementId: l1.pending[0].movementId, decision: 'take' });
  assert.equal(claim.ok, false, '价值较低时 take 应被拒');
  assert.equal(claim.reason, 'no_room', '应返回 no_room');
  const l2 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l2.codes.length, 1, '拒收后留栏数不变');
  assert.equal(l2.pending.length, 1, '报告仍保留待玩家处理');

  // 改选「出售」：换回金币并移除报告（出售需贸易中心，先启用）
  await send(app, 'treasure.SetTradeCenter', { villageId: 'v1', hasTradeCenter: true });
  const sell = await send(app, 'treasure.ClaimPending', { villageId: 'v1', movementId: l1.pending[0].movementId, decision: 'sell' });
  assert.equal(sell.ok, true, `出售应成功: ${sell.reason ?? ''}`);
  assert.equal(sell.payload.sold, true, '应标记为已售');
  assert.equal(sell.payload.gold, 60, '应换回 chainsaw 的 priceGold=60');
  const l3 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l3.pending.length, 0, '出售后报告应清除');
  assert.equal(l3.codes.length, 1, '留栏的 war_flag 不受影响');

  // 栏已满时，新宝物应被拒绝
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

/** 直接给 v1 植入一条贸易中心「宝物出售」订单（绕过随机 roll，便于确定性测试）。 */
function seedTreasureOffer(app: GameApp, over: Partial<{ code: string; buyPrice: number; sellPrice: number }> = {}): void {
  const code = over.code ?? 'chainsaw';
  const def = (app.config as any).treasures[code];
  app.store.set('trade', 'v1', {
    villageId: 'v1', level: 1,
    npcOrderPool: [{
      id: 'offer1', give: {}, want: { gold: over.buyPrice ?? 96 }, distance: 0, expiresAt: 1_000_000 + 999_999,
      treasure: {
        code: def.code, name: def.name, icon: def.icon, category: def.category, rarity: def.rarity,
        effectType: def.effectType, effectValue: def.effectValue, applyType: def.applyType,
        buyPrice: over.buyPrice ?? 96, sellPrice: over.sellPrice ?? 60,
      },
    }],
    storedRefreshes: 0, nextRefreshAt: 1_000_000 + 3_600_000, tradeRoutesUsed: 0, createdOrders: [],
  });
}
const tradePoolLen = (app: GameApp) => (app.store.get<any>('trade', 'v1')?.npcOrderPool?.length ?? -1);
async function goldOf(app: GameApp): Promise<number> {
  return ((await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any).resources.gold;
}

test('宝物购买：栏有空位时直接买入入栏（扣 buyPrice）', async () => {
  const app = await freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { gold: 1000 } });
  seedTreasureOffer(app); // chainsaw buyPrice=96 sellPrice=60
  const gold0 = await goldOf(app);

  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1' });
  assert.equal(r.ok, true, `购买应成功: ${r.reason ?? ''}`);
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], 'chainsaw 应入栏');
  assert.equal(await goldOf(app), gold0 - 96, '应扣 buyPrice=96 金币');
  assert.equal(tradePoolLen(app), 0, '订单应被消费');
});

test('宝物购买：栏满且无 action 时返回 overflow（不扣金、不消费订单）', async () => {
  const app = await freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { gold: 1000 } });
  seedTreasureOffer(app);
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' }); // 占满唯一格
  const gold0 = await goldOf(app);

  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.overflow, true, '栏满应回 overflow');
  assert.equal(r.payload.reason, 'treasure_slots_full');
  assert.deepEqual(r.payload.codes, ['war_flag'], '应带当前持有 codes 供替换选择');
  assert.equal(r.payload.slots, 1);
  assert.equal(r.payload.treasure.code, 'chainsaw');
  assert.equal(await goldOf(app), gold0, 'overflow 不应扣金');
  assert.equal(tradePoolLen(app), 1, 'overflow 不应消费订单');
});

test('宝物购买：栏满选 replace → 出售旧宝物并入新宝物', async () => {
  const app = await freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { gold: 1000 } });
  seedTreasureOffer(app); // 新宝物 chainsaw
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' }); // 已持有 war_flag
  const gold0 = await goldOf(app);

  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1', action: 'replace', replaceCode: 'war_flag' });
  assert.equal(r.ok, true, `replace 应成功: ${r.reason ?? ''}`);
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], 'war_flag 应被 chainsaw 替换');
  assert.equal(await goldOf(app), gold0 - 96 + 70, '应扣 buyPrice=96，并出售 war_flag 得 70 金币');
  assert.equal(tradePoolLen(app), 0, '订单应被消费');
});

test('宝物购买：栏满选 sell → 新宝物转卖 NPC 回收 sellPrice（净亏 buyPrice-sellPrice，不占格）', async () => {
  const app = await freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { gold: 1000 } });
  seedTreasureOffer(app); // buyPrice=96 sellPrice=60
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' }); // 占满
  const gold0 = await goldOf(app);

  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1', action: 'sell' });
  assert.equal(r.ok, true, `sell 应成功: ${r.reason ?? ''}`);
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['war_flag'], '新宝物不占格，仍只有 war_flag');
  assert.equal(await goldOf(app), gold0 - 96 + 60, '净亏 buyPrice-sellPrice=36');
  assert.equal(tradePoolLen(app), 0, '订单应被消费');
});

test('宝物购买：栏满选 discard → 放弃购买（不扣金、订单保留）', async () => {
  const app = await freshApp();
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { gold: 1000 } });
  seedTreasureOffer(app);
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const gold0 = await goldOf(app);

  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1', action: 'discard' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.discarded, true);
  assert.equal(await goldOf(app), gold0, 'discard 不应扣金');
  assert.equal(tradePoolLen(app), 1, 'discard 不应消费订单');
});

test('宝物购买：金币不足时 spend_failed（不入栏）', async () => {
  const app = await freshApp();
  seedTreasureOffer(app, { buyPrice: 999_999, sellPrice: 60 }); // 远超开局金币，必定不足
  const r = await send(app, 'trade.AcceptNpcTreasure', { villageId: 'v1', orderId: 'offer1' });
  assert.equal(r.ok, false, '金币不足应失败');
  assert.equal(r.reason, 'insufficient:gold', '应返回金币不足');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, [], '不应入栏');
  assert.equal(tradePoolLen(app), 1, '失败不应消费订单');
});

test('宝物替换：treasure.Replace 丢弃旧宝物入新宝物', async () => {
  const app = await freshApp();
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  const r = await send(app, 'treasure.Replace', { villageId: 'v1', oldCode: 'chainsaw', newCode: 'war_flag' });
  assert.equal(r.ok, true, `replace 应成功: ${r.reason ?? ''}`);
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['war_flag'], 'chainsaw 应被 war_flag 替换');
});

test('宝物替换：旧宝物未持有被拒；multiset 下新宝物重复持有允许（再入一份）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 扩到 2 格
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const r1 = await send(app, 'treasure.Replace', { villageId: 'v1', oldCode: 'money_bag', newCode: 'holy_water' });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'not_held', '未持有 oldCode 应 not_held');
  // multiset：新宝物已持有也允许（再入一份）；旧 chainsaw 被替换掉
  const r2 = await send(app, 'treasure.Replace', { villageId: 'v1', oldCode: 'chainsaw', newCode: 'war_flag' });
  assert.equal(r2.ok, true, `重复持有 newCode 应允许: ${r2.reason ?? ''}`);
  const after = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(after.codes.length, 2, '替换后仍持有 2 件（war_flag x2）');
  assert.ok(!after.codes.includes('chainsaw'), 'chainsaw 已被替换移除');
  assert.equal(after.codes.filter((c: string) => c === 'war_flag').length, 2, 'war_flag 现在有 2 份');
});

// ---------- 军队携带宝物（上限随兵力） ----------

test('携带：AssignToArmy 把宝物移出城镇栏并记入军队携带，城镇加成随之消失', async () => {
  const app = await freshApp();
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' }); // woodRate +5%
  const before = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(before.codes.length, 1, '应先持有 1 件');
  assert.ok((before.effect.resMult?.wood ?? 0) > 0, '持有时应有木产率加成');

  const r = await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv1', maxCarry: 2 });
  assert.equal(r.ok, true, `AssignToArmy 应成功: ${r.reason ?? ''}`);
  assert.deepEqual(r.payload.codes, ['chainsaw'], '携带记录应含 chainsaw');

  const after = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(after.codes.length, 0, '宝物应已移出城镇栏');
  assert.equal((after.effect.resMult?.wood ?? 0), 0, '移出后城镇木产率加成应归零');
  assert.deepEqual(after.carried.mv1, ['chainsaw'], 'list 应暴露 carried');

  const eff = await send(app, 'treasure.GetCarriedEffects', { movementId: 'mv1' });
  assert.ok((eff.payload.effects.resMult?.wood ?? 0) > 0, '军队携带时应提供木产率加成');
});

test('携带：超过携带上限被拒（carry_cap_exceeded）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 2 格
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const r = await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw', 'war_flag'], movementId: 'mv1', maxCarry: 1 });
  assert.equal(r.ok, false, '超上限应失败');
  assert.equal(r.reason, 'carry_cap_exceeded', '应返回 carry_cap_exceeded');
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l.codes.length, 2, '宝物应仍留在城镇栏');
});

test('携带：StoreCarried 返程到家存回城镇栏（优先城镇中心格）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 宝库 1 格
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv3', maxCarry: 2 });
  const r = await send(app, 'treasure.StoreCarried', { movementId: 'mv3', villageId: 'v1' });
  assert.equal(r.ok, true, `StoreCarried 应成功: ${r.reason ?? ''}`);
  assert.deepEqual(r.payload.stored, ['chainsaw'], '应存回 chainsaw');
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(l.codes.length, 1, '宝物应回到城镇栏');
  assert.equal(Object.keys(l.carried).length, 0, '携带记录应清除');
});

test('携带/掉落回归：返程 movement 为新 id，须用 outwardId 回链出征 id', async () => {
  // Bug：返程军队是 launch 出的新 id（与出征 id 不同），arriveReturn 曾误用返程 id 去匹配
  // treasure.carried / treasure_pending（均按出征 id 索引）→ 携带宝物丢失、掉落 pending 卡死。
  // 修复后 arriveReturn 优先用 mv.outwardId 回链。
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 宝库 1 格
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  // 出征 id = mv-out，把 chainsaw 装上该军队
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv-out', maxCarry: 2 });
  // 清营掉落一条 pending，按出征 id 索引、尚未归村
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-out', forceCode: 'war_flag' });

  // 模拟返程：新 id=mv-ret，但 outwardId 指向出征 id=mv-out
  app.store.set('movement', 'mv-ret', {
    id: 'mv-ret', type: 'return', fromVillage: 'v1',
    fromXY: { q: 0, r: 0 }, toXY: { q: 0, r: 0 },
    troops: {}, treasures: ['chainsaw'], outwardId: 'mv-out',
    departAt: 1_000_000, arriveAt: 1_000_001,
    path: [{ q: 0, r: 0 }, { q: 0, r: 0 }], stepIndex: 1, pos: { q: 0, r: 0 },
    perStepMs: 1, nextStepAt: 0, status: 'marching', stepToken: 1,
  } as any);

  // 直接驱动返程到达（arriveReturn 为 private，运行时可访问）
  await (app.movement as any).arriveReturn('mv-ret');

  // 携带宝物应随返程存回城镇栏（按 outwardId=mv-out 匹配 carried）
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.ok(l.codes.includes('chainsaw'), '携带的 chainsaw 应随返程存回城镇栏');
  assert.equal(Object.keys(l.carried).length, 0, '携带记录应清除');

  // 掉落 pending 应被标记为已归村（arrivedAt 被设置），可领取
  const pend = app.store.get<any>('treasure_pending', 'mv-out');
  assert.ok(pend, '掉落 pending 应仍存在');
  assert.ok(pend.arrivedAt, 'pending.arrivedAt 应被 MarkPendingArrived 设置（不再卡死）');
});

test('携带：OffloadForeign 军队抵达他村 → 转为该村民 deliver 报告', async () => {
  const app = await freshApp();
  await app.createVillage('v2', 1, 1, '测试村2');
  // 目的村只有城镇中心 1 格，先占满以验证“满位才进报告”。
  await send(app, 'treasure.Grant', { villageId: 'v2', code: 'war_flag' });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv4', maxCarry: 2 });
  const r = await send(app, 'treasure.OffloadForeign', { villageId: 'v2', fromMovementId: 'mv4', fromVillageId: 'v1', fromVillageName: '测试村1' });
  assert.equal(r.ok, true, `OffloadForeign 应成功: ${r.reason ?? ''}`);
  assert.deepEqual(r.payload.codes, ['chainsaw'], '应转出 chainsaw');
  assert.deepEqual(r.payload.stored, [], '目的村满位时不应直接入栏');
  assert.deepEqual(r.payload.pending, ['chainsaw'], '目的村满位时应进入报告');

  const pend = (await send(app, 'treasure.List', { villageId: 'v2' })).payload as any;
  assert.equal(pend.pending.length, 1, 'v2 应产生 1 条报告');
  assert.equal(pend.pending[0].kind, 'deliver', '报告类型应为 deliver');
  assert.equal(pend.pending[0].code, 'chainsaw', '报告应为 chainsaw');
  assert.equal(pend.pending[0].fromVillageId, 'v1', '报告应记录来源村 id');
  assert.equal(pend.pending[0].fromVillageName, '测试村1', '报告应记录来源村名');

  const src = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(Object.keys(src.carried).length, 0, '源村携带记录应清除');
});

test('携带：OffloadForeign 目的村有空位时直接入栏且不生成报告', async () => {
  const app = await freshApp();
  await app.createVillage('v2', 1, 1, '测试村2');
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv4-room', maxCarry: 2 });
  const r = await send(app, 'treasure.OffloadForeign', { villageId: 'v2', fromMovementId: 'mv4-room', fromVillageId: 'v1', fromVillageName: '测试村1' });
  assert.equal(r.ok, true, `OffloadForeign 应成功: ${r.reason ?? ''}`);
  assert.deepEqual(r.payload.stored, ['chainsaw'], '目的村有空位时应直接入栏');
  assert.deepEqual(r.payload.pending, [], '目的村有空位时不应生成报告');
  const dest = (await send(app, 'treasure.List', { villageId: 'v2' })).payload as any;
  assert.deepEqual(dest.codes, ['chainsaw'], '宝物应进入目的村宝物栏');
  assert.equal(dest.pending.length, 0, '目的村不应有待处理报告');
});

test('携带：LoseCarried pve=回收到系统宝物池（携带记录与栏位均清除）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv5', maxCarry: 2 });
  const r = await send(app, 'treasure.LoseCarried', { movementId: 'mv5', mode: 'pve' });
  assert.equal(r.ok, true, `LoseCarried(pve) 应成功: ${r.reason ?? ''}`);
  const src = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(Object.keys(src.carried).length, 0, '携带记录应清除');
  assert.equal(src.codes.length, 0, '宝物应已回收（不在城镇栏）');
});

test('携带：LoseCarried pvp=宝物归防守方村庄 deliver 报告', async () => {
  const app = await freshApp();
  await app.createVillage('v2', 1, 1, '测试村2');
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['war_flag'], movementId: 'mv6', maxCarry: 2 });
  const r = await send(app, 'treasure.LoseCarried', { movementId: 'mv6', mode: 'pvp', defenderVillage: 'v2' });
  assert.equal(r.ok, true, `LoseCarried(pvp) 应成功: ${r.reason ?? ''}`);
  const def = (await send(app, 'treasure.List', { villageId: 'v2' })).payload as any;
  assert.equal(def.pending.length, 1, '防守方 v2 应产生 1 条报告');
  assert.equal(def.pending[0].code, 'war_flag', '报告应为 war_flag');
  assert.equal(def.pending[0].kind, 'deliver', '报告类型应为 deliver');
  const src = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(Object.keys(src.carried).length, 0, '源村携带记录应清除');
});

test('宝物：resume 兼容旧扁平 codes 格式（不崩溃且归一化）', async () => {
  const app = await freshApp();
  // 回归：线上某村庄宝物文档为旧扁平 codes 格式（缺 town/treasury 字段），
  // 旧实现 resume() 在 recomputeAndPush 中 spread s.town 抛 "is not iterable" 导致崩溃循环。
  app.store.set('treasure', 'v1', { villageId: 'v1', codes: ['chainsaw'] } as any);
  // resume 遍历所有村庄宝物状态并重算——旧格式必须被归一化而非抛错
  await app.resume();
  const s = app.store.get('treasure', 'v1') as any;
  assert.ok(Array.isArray(s.town), 'resume 后 town 应为数组');
  assert.ok(s.town.includes('chainsaw'), '旧 codes 应被迁移到 town');
  assert.ok(Array.isArray(s.treasury), 'treasury 应为数组');
  assert.equal(typeof s.extraSlots, 'number', 'extraSlots 应为数字');
});

test('宝物：multiset 下重复掉落并领取 → 直接再入一份（codes 含 2 份同名宝物）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 共 2 槽，可同时持有 2 份同名宝物
  await send(app, 'treasure.SetTradeCenter', { villageId: 'v1', hasTradeCenter: true }); // 启用贸易中心以支持「出售」
  // 先持有 war_flag（priceGold=70）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  const l0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l0.codes, ['war_flag'], '应先仅持有 1 个 war_flag');
  // 清营又掉落同一个 war_flag（待领取）
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-dup', forceCode: 'war_flag' });
  const pend = app.store.get<any>('treasure_pending', 'mv-dup');
  pend.arrivedAt = 1_000_001;
  app.store.set('treasure_pending', 'mv-dup', pend);
  // multiset：确认领取（默认收下）→ 直接再入一份，绝不静默自动售卖
  const gold0 = await goldOf(app);
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'mv-dup' });
  assert.equal(claim.ok, true, `重复收下 multiset 下应成功: ${claim.reason ?? ''}`);
  assert.equal(claim.payload.stored, true, '应标记为已存入');
  assert.equal(await goldOf(app), gold0, '金币不应因收下重复而变动');
  const list0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list0.codes, ['war_flag', 'war_flag'], '栏内应有 2 个 war_flag（multiset）');
  assert.equal(list0.pending.length, 0, '收下后报告应清除');
  // 显式「出售」(启用贸易中心) → 换金并移除一份
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-dup2', forceCode: 'war_flag' });
  const pend2 = app.store.get<any>('treasure_pending', 'mv-dup2');
  pend2.arrivedAt = 1_000_002;
  app.store.set('treasure_pending', 'mv-dup2', pend2);
  const sell = await send(app, 'treasure.ClaimPending', { movementId: 'mv-dup2', decision: 'sell' });
  assert.equal(sell.ok, true, `出售应成功: ${sell.reason ?? ''}`);
  assert.equal(sell.payload.sold, true, '应标记为已售');
  assert.equal(sell.payload.gold, 70, '应换回 war_flag 的 priceGold=70');
  assert.equal(await goldOf(app), gold0 + 70, '金币应 +70');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['war_flag', 'war_flag'], '出售后栏内仍有 2 个 war_flag（multiset 不动原有那份）');
  assert.equal(list.pending.length, 0, '出售后报告应清除');
});

test('宝物：multiset 下 town 与 treasury 可同时含同一宝物 → ensureState 不再跨栏去重', async () => {
  // multiset 语义：同一宝物可同时出现在城镇中心与宝库（计为 2 份）。ensureState 仅做非字符串清理，不做去重。
  const app = await freshApp();
  app.store.set('treasure', 'v1', {
    villageId: 'v1',
    town: ['iron_wall_medal'],
    treasury: ['war_flag', 'iron_wall_medal'],
    carried: {}, extraSlots: 2,
  } as any);
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(l.codes, ['iron_wall_medal', 'war_flag', 'iron_wall_medal'], 'multiset 下 codes 保留跨栏重复（含 2 份 iron_wall_medal）');
  assert.deepEqual(l.town, ['iron_wall_medal'], '城镇中心保留 iron_wall_medal');
  assert.deepEqual(l.treasury, ['war_flag', 'iron_wall_medal'], '宝库的副本不再被移除');
});

test('宝物：StoreCarried 携带回村时若已持有且宝物栏已满 → 重复份转待处理报告（不静默自动售卖）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 0 }); // 仅城镇中心 1 格（满则无空位）
  // 城镇中心已持有 chainsaw；军队又携带 chainsaw 回村
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv-dup-carry', maxCarry: 2 });
  // 把 chainsaw 再塞一份到该军队的携带（模拟重复携带）
  const st = app.store.get<any>('treasure', 'v1');
  st.carried['mv-dup-carry'].codes.push('chainsaw');
  app.store.set('treasure', 'v1', st);
  const gold0 = await goldOf(app);
  const r = await send(app, 'treasure.StoreCarried', { movementId: 'mv-dup-carry', villageId: 'v1' });
  assert.equal(r.ok, true, 'StoreCarried 应成功');
  assert.deepEqual(r.payload.stored, ['chainsaw'], '首份应入库');
  assert.deepEqual(r.payload.pending, ['chainsaw'], '重复份应转为待处理报告（不再自动售卖）');
  assert.equal(await goldOf(app), gold0, '金币不应因重复携带而变动');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw'], '栏内仍只有 1 个 chainsaw（无重复）');
  assert.equal(list.pending.length, 1, '重复份应以待领取报告形式保留');
  assert.equal(list.pending[0].code, 'chainsaw', '待领取 code 应为 chainsaw');
  assert.equal(list.pending[0].kind, 'deliver', '重复携带回来应作 deliver 报告');
  assert.equal(list.pending[0].fromCarry, true, '该报告应标记为 fromCarry（军队带回）');
});

test('宝物：StoreCarried 携带回村重复宝物 → multiset 直接再入一份（无需 pending）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 2 }); // 宝库 2 格 → 共 3 槽（有空位）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' }); // 先持有 1 份
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv-dup-room', maxCarry: 2 });
  // 期间又得一份同样的 → 军队携带 2 份回村
  const st = app.store.get<any>('treasure', 'v1');
  st.carried['mv-dup-room'].codes.push('chainsaw');
  app.store.set('treasure', 'v1', st);
  const gold0 = await goldOf(app);
  const r = await send(app, 'treasure.StoreCarried', { movementId: 'mv-dup-room', villageId: 'v1' });
  assert.equal(r.ok, true, 'StoreCarried 应成功');
  assert.deepEqual(r.payload.stored, ['chainsaw', 'chainsaw'], 'multiset 下两份均直接入栏（无 pending）');
  assert.deepEqual(r.payload.pending, [], 'multiset 下重复不再转 pending（仅满栏才转）');
  assert.equal(await goldOf(app), gold0, '金币不应变动（不静默售卖）');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw', 'chainsaw'], '栏内应有 2 个 chainsaw（原 1 份已被装上军队，回村带回 2 份直接入库）');
  assert.equal(list.pending.length, 0, 'multiset 下无重复 pending');
});

test('待领取：重复宝物收下(take) → multiset 直接再入一份（fromCarry 仅作 UI 标记）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 2 }); // 共 3 槽（有空位）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' }); // 已持有 1 份
  // 直接构造一条 fromCarry 的 deliver 报告（模拟军队带回的重复宝物）—— multiset 下无论 fromCarry 与否均再入一份
  app.store.set('treasure_pending', 'pend-fc', {
    movementId: 'pend-fc', villageId: 'v1', code: 'chainsaw',
    name: '电锯', icon: '', category: '', rarity: '', effectType: '', effectValue: 0,
    applyType: '', priceGold: 10, kind: 'deliver', createdAt: 100, expiresAt: 1_000_000, fromCarry: true,
  } as any);
  const gold0 = await goldOf(app);
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'pend-fc', decision: 'take' });
  assert.equal(claim.ok, true, `重复收下 multiset 下应成功: ${claim.reason ?? ''}`);
  assert.equal(claim.payload.stored, true, 'multiset 下重复收下应再入一份');
  assert.equal(await goldOf(app), gold0, '收下不应换金');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw', 'chainsaw'], '栏内应有 2 个 chainsaw（multiset）');
  assert.equal(list.pending.length, 0, '报告应清除');
});

test('待领取：multiset 下非 fromCarry 重复宝物收下 → 直接再入一份（不再拒 already_have）', async () => {
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 2 });
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' }); // 已持有
  // 普通 deliver 报告（非军队带回），multiset 下重复收下应再入一份
  app.store.set('treasure_pending', 'pend-plain', {
    movementId: 'pend-plain', villageId: 'v1', code: 'chainsaw',
    name: '电锯', icon: '', category: '', rarity: '', effectType: '', effectValue: 0,
    applyType: '', priceGold: 10, kind: 'deliver', createdAt: 100, expiresAt: 1_000_000, fromCarry: false,
  } as any);
  const claim = await send(app, 'treasure.ClaimPending', { movementId: 'pend-plain', decision: 'take' });
  assert.equal(claim.ok, true, `multiset 下普通重复收下应成功: ${claim.reason ?? ''}`);
  assert.equal(claim.payload.stored, true, '应再入一份');
  const list = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.deepEqual(list.codes, ['chainsaw', 'chainsaw'], '栏内应有 2 个 chainsaw');
});

test('待领取：MarkPendingArrived 重置 expiresAt 从归村时刻起算', async () => {
  const app = await freshApp();
  const createdAt = 1_000_000;
  app.store.set('treasure_pending', 'mv-arr2', {
    movementId: 'mv-arr2', villageId: 'v1', code: 'chainsaw',
    name: '电锯', icon: '', category: '', rarity: '', effectType: '', effectValue: 0,
    applyType: '', priceGold: 10, kind: 'camp', createdAt, expiresAt: createdAt + 3600_000,
  } as any);
  setClock(2_000_000); // 模拟军队在掉落 1 小时后才归村
  const r = await send(app, 'treasure.MarkPendingArrived', { movementId: 'mv-arr2' });
  assert.ok(r.ok && r.payload.marked, '应标记归村');
  const p = app.store.get<any>('treasure_pending', 'mv-arr2');
  assert.equal(p.arrivedAt, 2_000_000, 'arrivedAt 应为归村时刻');
  // expiresAt 应从「归村时刻」重新起算，而非旧的 createdAt+timeout
  assert.equal(p.expiresAt, 2_000_000 + 3600_000, 'expiresAt 应从归村时刻重新起算');
  assert.ok(p.expiresAt > createdAt + 3600_000, '归村后倒计时应比原掉落时刻更晚');
});

test('movement：返程无战利品时仍把携带宝物存回（携带宝物不依赖战利品）', async () => {
  // 复现「带出去的宝物没带回来」：军队只带回自己携带的宝物、但没抢到战利品（mv.treasures 为空）。
  const app = await freshApp();
  await send(app, 'treasure.SetSlots', { villageId: 'v1', extra: 1 }); // 宝库 1 格
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'chainsaw' });
  await send(app, 'treasure.AssignToArmy', { villageId: 'v1', codes: ['chainsaw'], movementId: 'mv-out', maxCarry: 2 });
  // 返程 movement：新 id=mv-ret，outwardId=mv-out，战利品为空（treasures: []）
  app.store.set('movement', 'mv-ret', {
    id: 'mv-ret', type: 'return', fromVillage: 'v1',
    fromXY: { q: 0, r: 0 }, toXY: { q: 0, r: 0 },
    troops: {}, treasures: [], outwardId: 'mv-out',
    departAt: 1_000_000, arriveAt: 1_000_001,
    path: [{ q: 0, r: 0 }, { q: 0, r: 0 }], stepIndex: 1, pos: { q: 0, r: 0 },
    perStepMs: 1, nextStepAt: 0, status: 'marching', stepToken: 1,
  } as any);
  await (app.movement as any).arriveReturn('mv-ret');
  const l = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.ok(l.codes.includes('chainsaw'), '无战利品时携带的 chainsaw 仍应随返程存回');
  assert.equal(Object.keys(l.carried).length, 0, '携带记录应清除');
});

test('待领取：无贸易中心时「出售」被拒(no_trade_center)，「丢弃」仍可', async () => {
  const app = await freshApp();
  // 占满栏位，drop 一个待领取；本村无贸易中心（hasTradeCenter 默认 false）
  await send(app, 'treasure.Grant', { villageId: 'v1', code: 'war_flag' });
  await send(app, 'treasure.RollDrop', { villageId: 'v1', source: 'camp', movementId: 'mv-notc', forceCode: 'chainsaw' });
  const pend = app.store.get<any>('treasure_pending', 'mv-notc');
  pend.arrivedAt = 1_000_001;
  app.store.set('treasure_pending', 'mv-notc', pend);
  // 无贸易中心 → 出售被拒
  const sell = await send(app, 'treasure.ClaimPending', { movementId: 'mv-notc', decision: 'sell' });
  assert.equal(sell.ok, false, '无贸易中心出售应被拒');
  assert.equal(sell.reason, 'no_trade_center', '应返回 no_trade_center');
  const list0 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list0.pending.length, 1, '报告应保留待玩家另作处理');
  // 丢弃（不给金币）仍可
  const gold0 = await goldOf(app);
  const discard = await send(app, 'treasure.ClaimPending', { movementId: 'mv-notc', decision: 'discard' });
  assert.equal(discard.ok, true, `丢弃应成功: ${discard.reason ?? ''}`);
  assert.equal(await goldOf(app), gold0, '丢弃不应换金');
  const list1 = (await send(app, 'treasure.List', { villageId: 'v1' })).payload as any;
  assert.equal(list1.pending.length, 0, '丢弃后报告应清除');
});
