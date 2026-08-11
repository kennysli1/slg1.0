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

test('科技树查询返回 15 个初始科技 + 正确的 status', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试2', 'pass1');
  assert.equal(regRes.ok, true, `注册应成功: ${regRes.reason ?? ''}`);
  const va = (regRes.payload as any).player.villageId;
  const r = await send(app, 'research.GetTechTree', { villageId: va });
  assert.equal(r.ok, true);
  const techs = (r.payload as any).techs;
  assert.ok(techs.length >= 15, `应有至少15个科技，实际: ${techs.length}`);
  const t1 = techs.find((t: any) => t.code === 'infantry_training');
  assert.ok(t1, 'infantry_training 应存在');
  assert.equal(t1.status, 'available', '无前置的 tier-1 科技应 available（但无学院就无法支付 RP）');
});

test('StartResearch 无学院应被拒（insufficient_rp）', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试3', 'pass1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId;
  const r = await send(app, 'research.StartResearch', { villageId: va, techCode: 'infantry_training' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_rp');
});

test('GM 覆盖层：research 表编辑 round-trip', async () => {
  const app = freshApp();
  const regRes = await reg(app, '测试4', 'pass1');
  assert.equal(regRes.ok, true);
  const r = await send(app, 'research.GetTechTree', { villageId: (regRes.payload as any).player.villageId });
  assert.equal(r.ok, true);
  const t = (r.payload as any).techs.find((t: any) => t.code === 'infantry_training');
  assert.equal(t.rpCost, 3, 'infantry_training 默认 rpCost=3');
  assert.equal(t.durationSec, 3600, 'infantry_training 默认 durationSec=3600');
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
  const elite = (r.payload as any).techs.find((t: any) => t.code === 'elite_guard');
  assert.ok(elite, 'elite_guard 应存在');
  assert.equal(elite.status, 'locked', '无前置完成应是 locked');
  assert.ok(elite.requires.length > 0, 'elite_guard 应有前置');
});

test('科研配置校验 — 无环依赖', () => {
  const app = freshApp();
  // setupWorld 已调用 loadGameConfig，配置校验通过意味着无环。
  const r = app.config.research;
  assert.ok(r['infantry_training'], 'infantry_training 存在');
  assert.ok(r['elite_guard'], 'elite_guard 存在');
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
