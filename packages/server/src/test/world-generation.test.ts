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
  for (const slot of a.spawnSlots) {
    const rats = a.pveSpawns.filter((p) => p.type === 'rats' && hexDistanceWrapped(slot, p, 96, 96) <= 4);
    const wolves = a.pveSpawns.filter((p) => p.type === 'wolves' && hexDistanceWrapped(slot, p, 96, 96) <= 6);
    assert.ok(rats.length >= 2, `出生槽 ${slot.q},${slot.r} 半径4内应至少有2个rats`);
    assert.ok(wolves.length >= 1, `出生槽 ${slot.q},${slot.r} 半径6内应至少有1个wolves`);
  }
  const terrainFor = (type: string, terrain: string) => a.pveSpawns.filter(
    (p) => p.type === type && a.terrain[p.r * 96 + p.q] === terrain,
  ).length;
  const wolvesTotal = a.pveSpawns.filter((p) => p.type === 'wolves').length;
  assert.ok(terrainFor('wolves', 'forest') / wolvesTotal > 0.30, 'wolves 应显著偏向森林（高于地图森林基线）');
  for (const type of ['fortress', 'dark_legion', 'bone_king']) {
    const total = a.pveSpawns.filter((p) => p.type === type).length;
    assert.ok(terrainFor(type, 'hills') / total > 0.15, `${type} 应偏向丘陵（高于地图丘陵基线）`);
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

test('普通 PlaceVillage 不可占用未使用的首村保留槽', async () => {
  const app = createGameApp({ manualScheduler: true });
  const plan = app.world.setup(96, 96);
  const slot = plan.spawnSlots[0]!;
  const direct = await app.commands.send({
    name: 'world.PlaceVillage', from: 'test', payload: { ...slot, refId: 'found-village', name: '拓荒村' },
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'spawn_slot_reserved');
  const allocated = await app.commands.send({
    name: 'world.AllocateSpawn', from: 'test', payload: { refId: 'spawn-village', name: '首村' },
  });
  assert.equal(allocated.ok, true);
  const idempotent = await app.commands.send({
    name: 'world.PlaceVillage', from: 'test', payload: { ...(allocated.payload as any), refId: 'spawn-village', name: '首村' },
  });
  assert.equal(idempotent.ok, true, 'AllocateSpawn 已原子占用后，装配阶段 PlaceVillage 应幂等成功');
});

test('旧世界补生成 PvE 遇到村庄占位时使用后备点，不产生 orphan', async () => {
  const app = createGameApp({ manualScheduler: true });
  const plan = app.world.setup(41, 41);
  const firstGenerated = plan.pveSpawns.find((p) => p.id.startsWith('gen-pve-'))!;
  const village = await app.commands.send({
    name: 'world.PlaceVillage', from: 'test',
    payload: { q: firstGenerated.q, r: firstGenerated.r, refId: 'legacy-village', name: '旧村庄' },
  });
  assert.equal(village.ok, true);
  app.resume();
  const staticPve = app.store.all<any>('pve').filter((p) => !p.task);
  assert.equal(staticPve.length, Math.round(41 * 41 * 0.05));
  for (const pve of staticPve) {
    const tile = await app.commands.send({ name: 'world.GetTile', from: 'test', payload: { q: pve.q, r: pve.r } });
    assert.equal((tile.payload as any).tile.refId, pve.id, `PvE ${pve.id} 必须存在对应 World 地块`);
  }
  const generated = app.store.get<any>('pve', firstGenerated.id);
  assert.notDeepEqual({ q: generated.q, r: generated.r }, { q: firstGenerated.q, r: firstGenerated.r });
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
  const legacyQ = (player.q + 10) % 96;
  const legacyR = player.r;
  app.store.set('vision', player.id, {
    playerId: player.id,
    explored: { [`${legacyQ},${legacyR}`]: { q: legacyQ, r: legacyR, kind: 'empty' } },
  });
  const area = await app.commands.send({
    name: 'world.GetArea', from: 'test', payload: { cq: player.q, cr: player.r, r: 1, full: true, playerId: player.id },
  });
  assert.equal(area.ok, true, area.reason);
  const tiles = (area.payload as any).tiles as any[];
  assert.ok(tiles.some((t) => t.visibility === 'visible' && t.terrain));
  assert.ok(tiles.some((t) => t.q === legacyQ && t.r === legacyR && t.visibility === 'explored' && t.terrain),
    '旧探索快照缺 terrain 时必须从 World 确定性地貌补齐');
  assert.ok(tiles.some((t) => t.visibility === 'unexplored' && t.terrain === undefined));
});
