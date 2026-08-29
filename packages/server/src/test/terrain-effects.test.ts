import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistanceWrapped, linePathWrapped, wrapHex } from '../infra/hex.js';

let clock = 5_000_000;
function freshApp(): GameApp {
  clock = 5_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'terrain-test', payload });

function setTerrain(app: GameApp, point: { q: number; r: number }, terrain: 'plain' | 'forest' | 'hills'): void {
  const world = app.world as any;
  const plan = (world.plan ?? app.world.setup(app.config.constants.worldW, app.config.constants.worldH)) as any;
  const p = wrapHex(point, plan.w, plan.h);
  plan.terrain[p.r * plan.w + p.q] = terrain;
}

function setPathTerrain(app: GameApp, path: Array<{ q: number; r: number }>, terrain: 'plain' | 'forest' | 'hills'): void {
  for (const point of path) setTerrain(app, point, terrain);
}

async function register(app: GameApp, name: string): Promise<any> {
  const result = await send(app, 'player.Register', { name, password: 'pass123', tribe: 'romans' });
  assert.equal(result.ok, true, `注册 ${name} 应成功`);
  return (result.payload as any).player;
}

test('军队视野：丘陵位置增加一格视野', async () => {
  const app = freshApp();
  const player = await register(app, '丘陵视野');
  const W = app.config.constants.worldW, H = app.config.constants.worldH;
  const source = { q: (player.q + 10) % W, r: (player.r + 10) % H };
  const target = { q: (source.q + 6) % W, r: source.r };
  const path = linePathWrapped(source, target, W, H);
  setPathTerrain(app, path, 'plain');
  setTerrain(app, source, 'hills');
  app.store.set('movement', 'terrain-hill', {
    id: 'terrain-hill', type: 'garrison', fromVillage: player.villageId,
    fromXY: source, toXY: source, troops: { equlegati: 1 },
    departAt: clock, arriveAt: clock, path: [source], stepIndex: 0, pos: source,
    perStepMs: 1, nextStepAt: clock, status: 'stationed', stepToken: 1,
  });

  const visibility = await send(app, 'vision.GetVisibility', { playerId: player.id, ...target });
  assert.equal((visibility.payload as any).visibility, 'visible', '丘陵军队应看到基础半径外一格');
});

test('军队视野：森林方向减少两格视野', async () => {
  const app = freshApp();
  const player = await register(app, '森林视野');
  const W = app.config.constants.worldW, H = app.config.constants.worldH;
  const source = { q: (player.q + 10) % W, r: (player.r + 10) % H };
  const blockedTarget = { q: (source.q + 4) % W, r: source.r };
  const blockedPath = linePathWrapped(source, blockedTarget, W, H);
  setPathTerrain(app, blockedPath, 'plain');
  setTerrain(app, blockedPath[2]!, 'forest');
  app.store.set('movement', 'terrain-forest', {
    id: 'terrain-forest', type: 'garrison', fromVillage: player.villageId,
    fromXY: source, toXY: source, troops: { equlegati: 1 },
    departAt: clock, arriveAt: clock, path: [source], stepIndex: 0, pos: source,
    perStepMs: 1, nextStepAt: clock, status: 'stationed', stepToken: 1,
  });

  const blocked = await send(app, 'vision.GetVisibility', { playerId: player.id, ...blockedTarget });
  assert.notEqual((blocked.payload as any).visibility, 'visible', '穿过森林的第四格应被两格衰减挡住');

  const clearTarget = { q: (source.q + 3) % W, r: source.r };
  const clear = await send(app, 'vision.GetVisibility', { playerId: player.id, ...clearTarget });
  assert.equal((clear.payload as any).visibility, 'visible', '森林方向的三格内仍应可见');
});

async function findNearbyEmpty(app: GameApp, origin: { q: number; r: number }): Promise<{ q: number; r: number }> {
  const W = app.config.constants.worldW, H = app.config.constants.worldH;
  for (let r = origin.r - 4; r <= origin.r + 4; r++) for (let q = origin.q - 4; q <= origin.q + 4; q++) {
    const point = wrapHex({ q, r }, W, H);
    if (hexDistanceWrapped(origin, point, W, H) === 0 || hexDistanceWrapped(origin, point, W, H) > 4) continue;
    const tile = await send(app, 'world.GetTile', point);
    if ((tile.payload as any)?.tile?.kind === 'empty') return point;
  }
  throw new Error('应找到城市视野内的空地');
}

async function launchAdjacentGarrison(terrain: 'plain' | 'hills'): Promise<number> {
  const app = freshApp();
  const player = await register(app, `丘陵移速-${terrain}`);
  const target = await findNearbyEmpty(app, { q: player.q, r: player.r });
  setTerrain(app, { q: player.q, r: player.r }, terrain);
  setTerrain(app, target, 'plain');
  await send(app, 'military.AdjustTroops', { villageId: player.villageId, delta: { legionnaire: 1 } });
  const result = await send(app, 'movement.SendGarrison', { villageId: player.villageId, ...target, troops: { legionnaire: 1 } });
  assert.equal(result.ok, true, `驻扎军应发出: ${result.reason ?? ''}`);
  return (app.store.get<any>('movement', (result.payload as any).id) as any).perStepMs;
}

test('丘陵军队移速：离开丘陵格的路径段耗时增加三分之一', async () => {
  const plainMs = await launchAdjacentGarrison('plain');
  const hillsMs = await launchAdjacentGarrison('hills');
  assert.equal(hillsMs, Math.round(plainMs / (2 / 3)), '丘陵段应按 2/3 速度计时');
});
