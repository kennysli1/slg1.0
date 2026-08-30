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
  const partialMs = Math.max(1, Math.floor(Number(atFirstGrid.perStepMs) / 2));
  clock += partialMs;

  const sentEvents: any[] = [];
  app.bus.on('movement.Sent', (event: any) => {
    if (event.payload?.id === movementId) sentEvents.push(event.payload);
  });

  const removed = await send(app, 'pve.Remove', { id: 'pve-0' });
  assert.equal(removed.ok, true, `移除目标应成功: ${removed.reason ?? ''}`);

  const returning = app.store.get<any>('movement', movementId);
  assert.ok(returning, '目标消失后 movement 应保留为返程记录');
  assert.equal(returning.type, 'return');
  assert.deepEqual(returning.path, outboundPath.slice(0, outboundIndex + 1).reverse(), '返程路径必须是已走去程的反向前缀');
  assert.deepEqual(returning.path[0], atFirstGrid.pos, '返程路径首格必须是实际掉头所在格');

  // 地图仍需从当前段内的实际位置开始返程，不能随着离散 pos 回跳到首个返程格心。
  const listed = await send(app, 'movement.List', { villageId: player.villageId });
  const listedMovement = (listed.payload as any).movements.find((m: any) => m.id === movementId);
  const turningPoint = listedMovement?.turningPoint;
  assert.ok(turningPoint, '掉头时应下发连续位置过渡');
  assert.deepEqual(turningPoint.from, outboundPath[outboundIndex], '连续过渡起点应为掉头前所在格');
  assert.deepEqual(turningPoint.to, outboundPath[outboundIndex + 1], '连续过渡终点应为掉头前下一格');
  assert.equal(turningPoint.startedAt, clock, '连续过渡应从目标消失时刻开始');
  assert.equal(turningPoint.durationMs, partialMs, '连续过渡时长应等于当前段已行进时间');
  assert.ok(Math.abs(turningPoint.progress - 0.5) < 1 / Number(atFirstGrid.perStepMs), '连续过渡比例应与当前段内位置一致');
  const returnSent = sentEvents.at(-1);
  assert.ok(returnSent?.movement, '掉头推送应携带完整快照，客户端无需等待全量刷新');
  assert.ok(returnSent.movement.turningPoint, '掉头推送的完整快照应保留连续位置过渡');
  assert.deepEqual(returnSent.movement.path, returning.path, '掉头推送快照应使用返程反向路径');

  const expectedMs = clock - departureAt;
  assert.equal(returning.arriveAt - clock, expectedMs, '返程 arriveAt 应按出发后实际经过时间计算');
  assert.equal(returning.nextStepAt - clock, expectedMs, '单段返程的 Scheduler 时间必须与 arriveAt 一致');

  // 在 arriveAt 之前不能提前归队；到达时才清理 movement 并归还兵力。
  await app.scheduler.advanceTo(clock + expectedMs - 1, (t) => { clock = t; });
  assert.ok(app.store.get('movement', movementId), '返程计时未结束前不应提前归队');
  await app.scheduler.advanceTo(clock + 1, (t) => { clock = t; });
  assert.equal(app.store.get('movement', movementId), undefined, '返程计时结束后应归队并清理 movement');
});
