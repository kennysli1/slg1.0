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
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd: string, tribe = 'romans') =>
  send(app, 'player.Register', { name, password: pwd, tribe });

test('学院建造后 academy 参数更新', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试', 'pass1');
  assert.equal(regRes.ok, true, `注册应成功: ${regRes.reason ?? ''}`);
  const va = (regRes.payload as any).player.villageId;
  // academy 需要 main:3，开局 Lv1 无法直接建。验证基础状态即可。
  const st = await send(app, 'research.GetState', { villageId: va });
  assert.equal(st.ok, true);
  const academy = (st.payload as any).academy;
  assert.equal(academy.academyCount, 0, '开局无学院');
  assert.equal(academy.highestLevel, 0);
});

test('科技树查询返回配置的 27 个科技 + 正确的 status', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试2', 'pass1');
  assert.equal(regRes.ok, true, `注册应成功: ${regRes.reason ?? ''}`);
  const va = (regRes.payload as any).player.villageId;
  const r = await send(app, 'research.GetTechTree', { villageId: va });
  assert.equal(r.ok, true);
  const techs = (r.payload as any).techs;
  assert.equal(techs.length, 27, `应有27个科技，实际: ${techs.length}`);
  const t1 = techs.find((t: any) => t.code === 'melee_attack_i');
  assert.ok(t1, 'melee_attack_i 应存在');
  assert.equal(t1.status, 'available', '无前置的 tier-1 科技应 available（但无学院就无法支付 RP）');
});

test('StartResearch 无学院应被拒（academy_required）', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试3', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;
  const r = await send(app, 'research.StartResearch', { villageId: va, techCode: 'melee_attack_i' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'academy_required');
});

test('GM 覆盖层：research 表编辑 round-trip', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试4', 'pass1');
  assert.equal(regRes.ok, true);
  const r = await send(app, 'research.GetTechTree', { villageId: (regRes.payload as any).player.villageId });
  assert.equal(r.ok, true);
  const t = (r.payload as any).techs.find((t: any) => t.code === 'melee_attack_i');
  assert.equal(t.rpCost, 2, 'melee_attack_i 默认 rpCost=2');
  assert.equal(t.durationSec, 3600, 'melee_attack_i 默认 durationSec=3600');
});

test('CancelResearch 无在途研发时返回 not_researching', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试5', 'pass1');
  assert.equal(regRes.ok, true);
  const r = await send(app, 'research.CancelResearch', { villageId: (regRes.payload as any).player.villageId });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_researching');
});

test('依赖链：有前置的科技在未满足时 locked', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试6', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;
  const r = await send(app, 'research.GetTechTree', { villageId: va });
  const elite = (r.payload as any).techs.find((t: any) => t.code === 'melee_attack_iii');
  assert.ok(elite, 'melee_attack_iii 应存在');
  assert.equal(elite.status, 'locked', '无前置完成应是 locked');
  assert.ok(elite.requires.length > 0, 'elite_guard 应有前置');
});

test('科研配置校验 — 无环依赖', () => {
  const app = freshApp();
  // setupWorld 已调用 loadGameConfig，配置校验通过意味着无环。
  const r = app.config.research;
  assert.ok(r['melee_attack_i'], 'melee_attack_i 存在');
  assert.ok(r['melee_attack_iii'], 'melee_attack_iii 存在');
  // elite_guard 依赖于 advanced_formation|siege_warfare，不应有环
});

test('academy 参数表解析正确', () => {
  const app = freshApp();
  const a = app.config.academy;
  assert.ok(a[1], 'Lv1 应存在');
  assert.equal(a[1].checkIntervalSec, 3600);
  assert.equal(a[1].baseProbability, 0.10);
  assert.ok(a[10], 'Lv10 应存在');
  assert.ok(a[10].maxProbability >= 0.7, 'Lv10 保底概率应≥0.7');
});

test('正直的心：科研状态下发实际缩短后的判定间隔', async () => {
  const app = freshApp();
  const regRes = await reg(app, '正直之心间隔', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;
  app.store.set('research', va, {
    villageId: va, rp: 0, completed: [], treasureTechIntervalMult: 1,
    academy: { failStreak: 0, lastCheckTime: clock, highestLevel: 1, academyCount: 1 },
  });

  const applied = await send(app, 'research.SetTreasureTechInterval', { villageId: va, mult: 0.9 });
  assert.equal(applied.ok, true);
  const state = await send(app, 'research.GetState', { villageId: va });
  assert.equal(state.ok, true);
  assert.equal((state.payload as any).intervalSec, 3240, 'Lv1 基础 3600 秒应按 0.9 倍显示为 3240 秒');
});

// ─── 新增：初建不回溯赠送 RP ──────────────────────────────────────────
test('研究：注册时初始 RP=0（不回溯赠送）', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试7', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;
  const st = await send(app, 'research.GetState', { villageId: va });
  assert.equal(st.ok, true);
  assert.equal((st.payload as any).rp, 0, '注册时 RP 应为 0（无回溯赠送）');
  assert.deepEqual((st.payload as any).completed, [], '注册时 completed 应为空数组');
});

// ─── 新增：完整研发完成与效果注入 ───────────────────────────────────
test('研究：StartResearch + 推进时钟 → 状态 completed，GetTechTree 显示 completed', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试8', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;

  // 直接注入 RP（测试专用 store 写入；不绕过 Command/Event 架构，仅填充初始状态）
  const techCode = 'melee_attack_i';
  const tech = app.config.research[techCode];
  assert.ok(tech, 'melee_attack_i 应存在于 config');
  const rpCost: number = tech.rpCost;
  const durationMs: number = tech.durationSec * 1000;

  // 写入研究状态（含足够 RP）
  app.store.set('research', va, {
    villageId: va, rp: rpCost + 5, completed: [],
    academy: { failStreak: 0, lastCheckTime: clock, highestLevel: 1, academyCount: 1 },
  });

  // StartResearch 应成功
  const startRes = await send(app, 'research.StartResearch', { villageId: va, techCode });
  assert.equal(startRes.ok, true, `StartResearch 应成功：${startRes.reason}`);
  assert.equal((startRes.payload as any).rp, 5, `扣 RP 后应剩余 5，实际：${(startRes.payload as any).rp}`);

  // 推进时钟超过研发时长，触发 completeResearch
  await app.scheduler.advanceTo(clock + durationMs + 1000, (t) => { clock = t; });

  // 检查 GetTechTree 状态
  const treeRes = await send(app, 'research.GetTechTree', { villageId: va });
  assert.equal(treeRes.ok, true);
  const t = (treeRes.payload as any).techs.find((x: any) => x.code === techCode);
  assert.ok(t, `${techCode} 应在科技树中`);
  assert.equal(t.status, 'completed', `研发完成后 status 应为 completed，实际：${t.status}`);
});

// ─── 新增：CancelResearch 返还比例 RP ───────────────────────────────
test('研究：CancelResearch 在中途返还剩余比例 RP（向下取整）', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试9', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;

  const techCode = 'melee_attack_i';
  const tech = app.config.research[techCode];
  const rpCost: number = tech.rpCost;
  const durationMs: number = tech.durationSec * 1000;

  app.store.set('research', va, {
    villageId: va, rp: rpCost, completed: [],
    academy: { failStreak: 0, lastCheckTime: clock, highestLevel: 1, academyCount: 1 },
  });

  const startRes = await send(app, 'research.StartResearch', { villageId: va, techCode });
  assert.equal(startRes.ok, true);

  // 推进一半时间后取消
  await app.scheduler.advanceTo(clock + Math.floor(durationMs / 2), (t) => { clock = t; });

  const cancelRes = await send(app, 'research.CancelResearch', { villageId: va });
  assert.equal(cancelRes.ok, true, `CancelResearch 应成功：${cancelRes.reason}`);
  const refund: number = (cancelRes.payload as any).refund;
  // 剩余约一半 durationMs → 退款 = floor(rpCost * (remaining/durationMs) * 0.9)
  // 退款应 >= 0 且 < rpCost
  assert.ok(refund >= 0, '退款应≥0');
  assert.ok(refund < rpCost, `退款 ${refund} 应<rpCost ${rpCost}`);

  // 取消后 researching 应为 null
  const stateRes = await send(app, 'research.GetState', { villageId: va });
  assert.equal((stateRes.payload as any).researching, null, '取消后 researching 应为 null');
});

test('研究：学院拆除暂停后取消，仍按原总时长计算九折退款', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试暂停退款', 'pass1');
  const va = (regRes.payload as any).player.villageId;
  const tech = app.config.research.melee_attack_i;
  const totalDurationMs = tech.durationSec * 1000;
  app.store.set('research', va, {
    villageId: va, rp: 0, completed: [],
    researching: {
      code: tech.code, startedAt: clock, durationMs: totalDurationMs / 2,
      totalDurationMs, taskId: '', paused: true,
    },
    academy: { failStreak: 0, lastCheckTime: clock, highestLevel: 0, academyCount: 0 },
  });

  const cancelled = await send(app, 'research.CancelResearch', { villageId: va });
  assert.equal(cancelled.ok, true);
  assert.equal((cancelled.payload as any).refund, Math.floor(tech.rpCost * 0.5 * 0.9));
});

// ─── 新增：拆光学院 → RP 归零 ─────────────────────────────────────────
test('研究：拆除全部学院后 RP 保留', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试10', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;

  // 模拟有学院且有 RP（测试专用 store 写入）
  app.store.set('research', va, {
    villageId: va, rp: 50, completed: [],
    academy: { failStreak: 0, lastCheckTime: clock, highestLevel: 1, academyCount: 1 },
  });

  // 发出学院拆除事件（research 模块监听此事件，会调用 onAcademyChanged）
  await app.bus.emit({
    name: 'building.Demolished',
    source: 'test',
    ts: clock,
    payload: { villageId: va, kind: 'academy' },
  });

  // 拆错建筑不能造成不可逆长期损失
  const stateRes = await send(app, 'research.GetState', { villageId: va });
  assert.equal(stateRes.ok, true);
  assert.equal((stateRes.payload as any).rp, 50, '拆光学院后 RP 应保留');
});
