import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 铁匠养成（UpgradeSmithy）测试。
 * 之前这条链路没有任何覆盖，而客户端刚补上锻造界面，需要 GetArmy 稳定下发
 * `pendingSmithy`（含 startAt/doneAt）才能画进度条 —— 这里把契约钉住。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '测试村');
  return app;
}
const setClock = (t: number) => (clock = t);
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}
async function rich(app: GameApp) {
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 99999, clay: 99999, iron: 99999, crop: 99999 } });
}

test('铁匠升级：扣资源 → GetArmy 下发 pendingSmithy（含起止时刻）→ 到期提升等级', async () => {
  const app = freshApp();
  await rich(app);

  const before = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const up = await send(app, 'military.UpgradeSmithy', { villageId: 'v1', unit: 'legionnaire' });
  assert.equal(up.ok, true, `铁匠升级应成功: ${up.reason ?? ''}`);

  // 造价 = smithyCostBase × 目标等级，木与泥各一份（客户端按同公式预览）
  const base = app.config.constants.smithyCostBase;
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.equal(Math.round(before.resources.wood - after.resources.wood), base, '木消耗应为 base×1');
  assert.equal(Math.round(before.resources.clay - after.resources.clay), base, '泥消耗应为 base×1');

  // GetArmy 必须暴露进行中的升级，且带 startAt/doneAt 供客户端画进度条
  const army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.ok(army.pendingSmithy, 'GetArmy 应下发 pendingSmithy');
  assert.equal(army.pendingSmithy.unit, 'legionnaire');
  assert.equal(typeof army.pendingSmithy.startAt, 'number', 'pendingSmithy 应含 startAt');
  assert.ok(army.pendingSmithy.doneAt > army.pendingSmithy.startAt, 'doneAt 应晚于 startAt');
  assert.equal((army.pendingSmithy as any).taskId, undefined, '调度器内部 taskId 不应外泄');
  assert.equal(army.smithyLevel.legionnaire ?? 0, 0, '未完成前等级不变');

  // 快进到完成
  await app.scheduler.advanceTo(clock + app.config.constants.smithyUpgradeSec * 1000 + 1000, setClock);
  const done = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.equal(done.smithyLevel.legionnaire, 1, '完成后等级应为 1');
  assert.equal(done.pendingSmithy, null, '完成后 pendingSmithy 应清空');
});

test('铁匠升级：同一时刻只允许一个（smithy_busy）', async () => {
  const app = freshApp();
  await rich(app);

  const first = await send(app, 'military.UpgradeSmithy', { villageId: 'v1', unit: 'legionnaire' });
  assert.equal(first.ok, true);
  const second = await send(app, 'military.UpgradeSmithy', { villageId: 'v1', unit: 'praetorian' });
  assert.equal(second.ok, false, '已有升级在途时应被拒');
  assert.equal(second.reason, 'smithy_busy');
});

test('铁匠升级：资源不足时拒绝，且不留下 pendingSmithy', async () => {
  const app = freshApp();
  // 不给资源：开局资源不足以支付高等级造价，这里先把等级抬高再试
  const poor = await send(app, 'military.UpgradeSmithy', { villageId: 'v1', unit: 'legionnaire' });
  if (poor.ok) {
    // 开局资源够付 Lv1，那就快进完成后再连续升，直到付不起为止
    await app.scheduler.advanceTo(clock + app.config.constants.smithyUpgradeSec * 1000 + 1000, setClock);
    let lastReason: string | undefined;
    for (let i = 0; i < 40; i++) {
      const r = await send(app, 'military.UpgradeSmithy', { villageId: 'v1', unit: 'legionnaire' });
      if (!r.ok) { lastReason = r.reason; break; }
      await app.scheduler.advanceTo(clock + app.config.constants.smithyUpgradeSec * 1000 + 1000, setClock);
    }
    assert.ok(lastReason, '连续升级最终应因资源不足被拒');
  }
  const army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.equal(army.pendingSmithy, null, '被拒的升级不应留下在途状态');
});
