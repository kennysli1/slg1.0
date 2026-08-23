import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorldPlan } from '../infra/world-generation.js';
import { hexDistanceWrapped } from '../infra/hex.js';
import { createGameApp } from '../app.js';

test('96×96 世界确定性生成 550 个公平出生槽位、5% PvE 与 55/30/15 地貌', () => {
  const anchors = [{ id: 'anchor', type: 'rats', q: -2, r: 3 }];
  const a = generateWorldPlan(96, 96, 'test-seed', anchors);
  const b = generateWorldPlan(96, 96, 'test-seed', anchors);
  assert.deepEqual(a, b);
  assert.equal(a.spawnSlots.length, 550);
  assert.equal(a.pveSpawns.length, Math.round(96 * 96 * 0.05));
  assert.ok(a.pveSpawns.some((p) => p.id === 'anchor'), '人工锚点必须保留');
  const terrainCounts = a.terrain.reduce<Record<string, number>>((out, t) => {
    out[t] = (out[t] ?? 0) + 1;
    return out;
  }, {});
  assert.equal(terrainCounts.hills, Math.round(96 * 96 * 0.15));
  assert.equal(terrainCounts.forest, Math.round(96 * 96 * 0.30));
  assert.equal(terrainCounts.plain, 96 * 96 - terrainCounts.hills! - terrainCounts.forest!);
  for (let i = 0; i < a.spawnSlots.length; i++) for (let j = i + 1; j < a.spawnSlots.length; j++) {
    assert.ok(hexDistanceWrapped(a.spawnSlots[i]!, a.spawnSlots[j]!, 96, 96) >= 4);
  }
});

test('World 原子出生分配在 550 个槽位耗尽后明确拒绝', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  for (let i = 0; i < 550; i++) {
    const allocated = await app.commands.send({
      name: 'world.AllocateSpawn', from: 'test', payload: { refId: `capacity-${i}`, name: `村庄${i}` },
    });
    assert.equal(allocated.ok, true, `第 ${i + 1} 个槽位应可分配`);
  }
  const full = await app.commands.send({
    name: 'world.AllocateSpawn', from: 'test', payload: { refId: 'capacity-full', name: '满员村庄' },
  });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'world_capacity_exhausted');
});

test('旧 world_meta 优先于 96×96 新世界配置，Meta 下发实际尺寸', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.store.set('world_meta', 'meta', { w: 41, h: 41 });
  const plan = app.world.setup(96, 96);
  assert.equal(plan.w, 41);
  assert.equal(plan.h, 41);
  const meta = await app.commands.send({ name: 'meta.GetGameConfig', from: 'test', payload: {} });
  assert.equal((meta.payload as any).constants.worldW, 41);
  assert.equal((meta.payload as any).constants.worldH, 41);
});

test('视野只向 visible/explored 格下发地貌，unexplored 不泄露', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  const registered = await app.commands.send({
    name: 'player.Register', from: 'test', payload: { name: 'terrain-user', password: 'pass1234', tribe: 'romans' },
  });
  assert.equal(registered.ok, true, registered.reason);
  const player = (registered.payload as any).player;
  const area = await app.commands.send({
    name: 'world.GetArea', from: 'test', payload: { cq: player.q, cr: player.r, r: 1, full: true, playerId: player.id },
  });
  assert.equal(area.ok, true, area.reason);
  const tiles = (area.payload as any).tiles as any[];
  assert.ok(tiles.some((t) => t.visibility === 'visible' && t.terrain));
  assert.ok(tiles.some((t) => t.visibility === 'unexplored' && t.terrain === undefined));
});
