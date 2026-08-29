import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistanceWrapped } from '../infra/hex.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}
async function drain(app: GameApp, bigStepMs = 3_600_000, maxIters = 30000): Promise<void> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < maxIters) {
    await app.scheduler.advanceTo(clock + bigStepMs, setClock);
    iters++;
  }
}

async function prepFoundReady(app: GameApp, villageId: string): Promise<void> {
  // 主基地拉到门控等级
  const b = app.store.get<any>('building', villageId);
  const main = b.placed.find((p: any) => p.kind === 'main');
  assert.ok(main, '应有主基地');
  main.level = app.config.constants.foundMinMainLevel;
  app.store.set('building', villageId, b);

  // 模拟主基地升级完成 → 触发 building.Upgraded，让 population 重算硬上限缓存
  // （直接改 store 不会触发事件，population 的 hardCap 仍是建村时的 main L1 值）
  await app.bus.emit({
    name: 'building.Upgraded', source: 'test', ts: clock,
    payload: { villageId, slotId: 'center', kind: 'main', level: app.config.constants.foundMinMainLevel },
  });
  // 等待 refreshHardCap 异步完成
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const per = app.config.constants.foundResourceCostBase;
  // 抬高容量，避免「无露天仓库超额丢弃」把拓荒开城包钳到容量（测试聚焦拓荒流程，非溢出）
  await send(app, 'economy.SetCapacity', {
    villageId,
    capacity: { wood: 100000, clay: 100000, iron: 100000, crop: 100000 },
  });
  await send(app, 'economy.Grant', {
    villageId,
    gain: { wood: per, clay: per, iron: per, crop: per },
  });
  await send(app, 'military.AdjustTroops', {
    villageId,
    delta: { settler: app.config.constants.foundSettlerCount },
  });
}

async function findFoundTarget(
  app: GameApp,
  pq: number,
  pr: number,
  predicate: (terrain: string | undefined) => boolean = (terrain) => terrain === 'plain',
  excluded = new Set<string>(),
): Promise<{ q: number; r: number } | undefined> {
  const minD = app.config.constants.foundMinTileDistance;
  const plan = app.world.setup(app.config.constants.worldW, app.config.constants.worldH);
  const reserved = new Set(plan.spawnSlots.map((slot) => `${slot.q},${slot.r}`));
  for (let r = 0; r < plan.h; r++) for (let q = 0; q < plan.w; q++) {
    const key = `${q},${r}`;
    if (reserved.has(key) || excluded.has(key)) continue;
    if (hexDistanceWrapped({ q: pq, r: pr }, { q, r }, plan.w, plan.h) < minD) continue;
    const tile = await send(app, 'world.GetTile', { q, r });
    const data = (tile.payload as any)?.tile;
    if (data?.kind === 'empty' && predicate(data.terrain)) return { q, r };
  }
  return undefined;
}

test('拓荒：门控不足时拒绝', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'found1', password: 'pass1', tribe: 'romans',
  });
  const vid = (reg.payload as any).player.villageId as string;
  // 不升 main，直接尝试
  const r = await send(app, 'movement.FoundVillage', { villageId: vid, q: 9, r: -9 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'main_level_too_low');
});

test('拓荒：成功建第二村', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'found2', password: 'pass2', tribe: 'romans',
  });
  const player = (reg.payload as any).player;
  const vid = player.villageId as string;
  const pq = player.q as number;
  const pr = player.r as number;
  await prepFoundReady(app, vid);

  // 选一个距主城足够远、不是首村保留槽且地貌为平原的空地
  const target = await findFoundTarget(app, pq, pr);
  assert.ok(target, '应找到可拓荒的非保留空地');
  const { q: tq, r: tr } = target;

  const found = await send(app, 'movement.FoundVillage', { villageId: vid, q: tq, r: tr });
  assert.equal(found.ok, true, `FoundVillage: ${found.reason}`);

  await drain(app);

  const g = await send(app, 'player.Get', { playerId: player.id });
  const villages = (g.payload as any).player.villages as any[];
  assert.equal(villages.length, 2, '应有两座村');
  const branch = villages.find((v) => !v.isCapital);
  assert.ok(branch, '应有分城');
  assert.equal(branch.q, tq);
  assert.equal(branch.r, tr);

  // 成功建城后拓荒者已转移，不应回到出发城
  const army = (await send(app, 'military.GetArmy', { villageId: vid })).payload as any;
  assert.equal(army.troops?.settler ?? 0, 0);

  // 新村有经济且至少以 5 人口开局；行军期间人口可能已自然增长。
  const eco = await send(app, 'economy.GetResources', { villageId: branch.id });
  assert.equal(eco.ok, true);
  const branchPop = (await send(app, 'population.GetSnapshot', { villageId: branch.id })).payload as any;
  assert.ok(Math.round(branchPop.currentPop) >= 5, '新城初始人口应至少为5');
});

test('拓荒：距离过近拒绝', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'found3', password: 'pass3', tribe: 'romans',
  });
  const player = (reg.payload as any).player;
  const vid = player.villageId as string;
  await prepFoundReady(app, vid);

  const r = await send(app, 'movement.FoundVillage', {
    villageId: vid, q: player.q, r: player.r, // 叠在自己村上
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.reason === 'tile_occupied' || r.reason === 'too_close_to_village',
    `reason=${r.reason}`,
  );
});

test('拓荒：森林或丘陵格拒绝建村', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: 'found-terrain', password: 'pass5', tribe: 'romans' });
  const player = (reg.payload as any).player;
  await prepFoundReady(app, player.villageId);
  const target = await findFoundTarget(app, player.q, player.r, (terrain) => terrain === 'forest' || terrain === 'hills');
  assert.ok(target, '应找到足够远的非平原空地');
  const found = await send(app, 'movement.FoundVillage', { villageId: player.villageId, ...target });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'found_only_on_plain');
});

test('拓荒：同时只能 1 支在途', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'found4', password: 'pass4', tribe: 'romans',
  });
  const player = (reg.payload as any).player;
  const vid = player.villageId as string;
  await prepFoundReady(app, vid);

  const firstTarget = await findFoundTarget(app, player.q, player.r);
  assert.ok(firstTarget, '应找到第一块平原拓荒地');
  const a = await send(app, 'movement.FoundVillage', {
    villageId: vid, ...firstTarget,
  });
  assert.equal(a.ok, true, a.reason);

  // 再补拓荒者与资源发第二支
  await prepFoundReady(app, vid);
  const secondTarget = await findFoundTarget(app, player.q, player.r, undefined, new Set([`${firstTarget!.q},${firstTarget!.r}`]));
  assert.ok(secondTarget, '应找到第二块平原拓荒地');
  const b = await send(app, 'movement.FoundVillage', { villageId: vid, ...secondTarget });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'found_inflight_limit');
});
