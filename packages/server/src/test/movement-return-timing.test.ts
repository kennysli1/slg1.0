import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 5_000_000;

function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'return-timing-test', payload });

async function register(app: GameApp, name: string): Promise<any> {
  const result = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(result.ok, true, `注册 ${name} 应成功: ${result.reason ?? ''}`);
  return (result.payload as any).player;
}

test('目标消失中途掉头：返程时长等于出发后实际经过时间，路径从掉头格原路反向开始', async () => {
  const app = freshApp();
  const player = await register(app, '掉头计时');
  await send(app, 'military.AdjustTroops', { villageId: player.villageId, delta: { legionnaire: 2 } });

  const sent = await send(app, 'movement.SendRaid', {
    villageId: player.villageId, targetId: 'pve-0', troops: { legionnaire: 1 },
  });
  assert.equal(sent.ok, true, `出征应成功: ${sent.reason ?? ''}`);
  const movementId = (sent.payload as any).id as string;
  const outbound = app.store.get<any>('movement', movementId);
  assert.ok(outbound && outbound.path.length > 2, '测试需要至少两段去程路径');

  // 完成第一段，再在第二段中途移除目标，模拟客户端看到的连续移动状态。
  const firstStepAt = outbound.nextStepAt as number;
  await app.scheduler.advanceTo(firstStepAt, (t) => { clock = t; });
  const atFirstGrid = app.store.get<any>('movement', movementId);
  assert.equal(atFirstGrid.stepIndex, 1);
  const outboundPath = [...atFirstGrid.path];
  const outboundIndex = atFirstGrid.stepIndex as number;
  const departureAt = atFirstGrid.departAt as number;
  const partialMs = 500;
  clock += partialMs;

  const removed = await send(app, 'pve.Remove', { id: 'pve-0' });
  assert.equal(removed.ok, true, `移除目标应成功: ${removed.reason ?? ''}`);

  const returning = app.store.get<any>('movement', movementId);
  assert.ok(returning, '目标消失后 movement 应保留为返程记录');
  assert.equal(returning.type, 'return');
  assert.deepEqual(returning.path, outboundPath.slice(0, outboundIndex + 1).reverse(), '返程路径必须是已走去程的反向前缀');
  assert.deepEqual(returning.path[0], atFirstGrid.pos, '返程路径首格必须是实际掉头所在格');

  const expectedMs = clock - departureAt;
  assert.equal(returning.arriveAt - clock, expectedMs, '返程 arriveAt 应按出发后实际经过时间计算');
  assert.equal(returning.nextStepAt - clock, expectedMs, '单段返程的 Scheduler 时间必须与 arriveAt 一致');

  // 在 arriveAt 之前不能提前归队；到达时才清理 movement 并归还兵力。
  await app.scheduler.advanceTo(clock + expectedMs - 1, (t) => { clock = t; });
  assert.ok(app.store.get('movement', movementId), '返程计时未结束前不应提前归队');
  await app.scheduler.advanceTo(clock + 1, (t) => { clock = t; });
  assert.equal(app.store.get('movement', movementId), undefined, '返程计时结束后应归队并清理 movement');
});
