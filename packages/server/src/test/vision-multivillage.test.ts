import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { Gateway } from '../gateway/gateway.js';
import { WIRE_VERSION, type WireRequest } from '@slg/shared';
import { hexDistanceWrapped, wrapHex } from '../infra/hex.js';

let clock = 7_000_000;

function freshApp(): GameApp {
  clock = 7_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });

/**
 * 视野是玩家维度，不是当前操作村维度：
 * 切到任意一座村后，地图 GetArea 仍必须包含该玩家另一座村派出的军队视野。
 */
test('跨村地图视野：切换当前村不应丢失其他己方军队视野', async () => {
  const app = freshApp();
  const gw = new Gateway(app);
  const session = gw.addClient({ send: () => {} });
  const request = (action: string, payload: Record<string, unknown>, id: string): WireRequest => ({
    v: WIRE_VERSION, type: 'req', id, action, payload, ts: clock,
  });

  const registered = await gw.handleRequest(
    request('Register', { name: 'vision-mv', password: 'pass123', tribe: 'romans' }, 'register'),
    session,
  );
  assert.equal(registered.ok, true, registered.error?.msg);
  const player = (registered.payload as any).player;
  const capital = player.villageId as string;

  const alloc = await send(app, 'player.AllocVillageId', { playerId: player.id });
  assert.equal(alloc.ok, true, alloc.reason);
  const branch = (alloc.payload as any).villageId as string;
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;

  // 找一块远离主城且未占用的分城位置，避免测试依赖随机出生点。
  let branchXY: { q: number; r: number } | undefined;
  for (let d = 9; d < 18 && !branchXY; d++) {
    const candidate = wrapHex({ q: player.q + d, r: player.r + d }, W, H);
    const tile = await send(app, 'world.GetTile', candidate);
    if ((tile.payload as any)?.tile?.kind === 'empty') branchXY = candidate;
  }
  assert.ok(branchXY, '应找到空的分城位置');
  await app.createVillage(branch, branchXY!.q, branchXY!.r, '跨村视野分城');
  const attached = await send(app, 'player.AttachVillage', {
    playerId: player.id, villageId: branch, q: branchXY!.q, r: branchXY!.r, name: '跨村视野分城',
  });
  assert.equal(attached.ok, true, attached.reason);

  // 选在分城外 7 格、且不在两座城池视野内的空地；驻扎军抵达后该格只能靠军队视野可见。
  let target: { q: number; r: number } | undefined;
  for (let d = 7; d < 16 && !target; d++) {
    const candidate = wrapHex({ q: branchXY!.q + d, r: branchXY!.r }, W, H);
    const tile = await send(app, 'world.GetTile', candidate);
    const fromCapital = hexDistanceWrapped(candidate, { q: player.q, r: player.r }, W, H);
    const fromBranch = hexDistanceWrapped(candidate, branchXY!, W, H);
    if ((tile.payload as any)?.tile?.kind === 'empty' && fromCapital > 4 && fromBranch > 4) target = candidate;
  }
  assert.ok(target, '应找到只由跨村军队照亮的空地');

  await send(app, 'military.AdjustTroops', { villageId: branch, delta: { legionnaire: 10 } });
  await send(app, 'vision.Reveal', { playerId: player.id, ...target, radius: 0 });
  const sent = await send(app, 'movement.SendGarrison', {
    villageId: branch, ...target, troops: { legionnaire: 5 },
  });
  assert.equal(sent.ok, true, sent.reason);
  const movementId = (sent.payload as any).id as string;
  const movement = app.store.get<any>('movement', movementId);
  assert.ok(movement, '应创建跨村驻扎军');

  for (let i = 0; i < movement.path.length + 3; i++) {
    await app.scheduler.advanceTo(clock + movement.perStepMs + 1, (t) => { clock = t; });
    if (app.store.get<any>('movement', movementId)?.status === 'stationed') break;
  }
  assert.equal(app.store.get<any>('movement', movementId)?.status, 'stationed', '跨村军队应抵达并驻扎');

  const getArea = async (id: string) => gw.handleRequest(
    request('GetArea', { cq: player.q, cr: player.r, r: 0, full: true }, id), session,
  );
  const areaAtCapital = await getArea('area-capital');
  assert.equal(areaAtCapital.ok, true, areaAtCapital.error?.msg);
  const capitalView = (areaAtCapital.payload as any).tiles.find((t: any) => t.q === target!.q && t.r === target!.r);
  assert.equal(capitalView?.visibility, 'visible', '主城地图必须看到分城军队的视野');

  const switched = await gw.handleRequest(request('SelectVillage', { villageId: branch }, 'select-branch'), session);
  assert.equal(switched.ok, true, switched.error?.msg);
  const areaAtBranch = await getArea('area-branch');
  assert.equal(areaAtBranch.ok, true, areaAtBranch.error?.msg);
  const branchView = (areaAtBranch.payload as any).tiles.find((t: any) => t.q === target!.q && t.r === target!.r);
  assert.equal(branchView?.visibility, 'visible', '分城地图也必须保留全部己方军队视野');

  // 避免“只看到了当前村自身”的假阳性：目标必须确实不在任一城池默认视野内。
  assert.ok(hexDistanceWrapped(target!, { q: player.q, r: player.r }, W, H) > 4);
  assert.ok(hexDistanceWrapped(target!, branchXY!, W, H) > 4);
  assert.equal(session.villageId, branch);
  assert.equal(capital !== branch, true);
});
