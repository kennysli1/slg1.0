import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp, type GameApp } from '../app.js';
import { generateWorldPlan } from '../infra/world-generation.js';

/**
 * 刷档测试：三种粒度各自的账号/进度/位置语义。
 * 用真实 JSON 文件 store，跑「注册+建造+落盘 → 刷档 → 重开 app 从同文件载入 → 断言」。
 */

let clock = 2_000_000;

function appAt(storePath: string): GameApp {
  return createGameApp({ now: () => clock, manualScheduler: true, storePath });
}

/** 建一局：注册两个玩家、给资源并各升一块田（制造进度）。返回两人的 villageId 与坐标。 */
async function seed(app: GameApp) {
  app.setupWorld();
  const reg = async (name: string, tribe: string) => {
    const r = await app.commands.send({ name: 'player.Register', from: 't', payload: { name, password: 'pass123', tribe } });
    assert.equal(r.ok, true, `注册应成功: ${r.reason ?? ''}`);
    const p = (r.payload as any).player;
    await app.commands.send({ name: 'economy.Grant', from: 't', payload: { villageId: p.villageId, gain: { wood: 500, clay: 500, iron: 500, crop: 500 } } });
    const layout = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: p.villageId } });
    const wood = (layout.payload as any).zones.outer.placed.find((f: any) => f.kind === 'woodcutter');
    const up = await app.commands.send({ name: 'building.Upgrade', from: 't', payload: { villageId: p.villageId, slotId: wood.slotId } });
    assert.equal(up.ok, true, `升级应成功: ${up.reason ?? ''}`);
    return p as { id: string; villageId: string; q: number; r: number; name: string };
  };
  const a = await reg('阿甲', 'romans');
  const b = await reg('阿乙', 'gauls');
  return { a, b };
}

test('reset:season — 保留账号+地图位置，进度归零', async () => {
  clock = 2_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-reset-season-'));
  const file = join(dir, 'game.json');
  try {
    let app = appAt(file);
    const { a } = await seed(app);
    const seasonPlan = generateWorldPlan(
      app.config.constants.worldW, app.config.constants.worldH,
      String(app.config.constants.raw.world_seed), app.config.pveSpawns,
    );
    const collision = seasonPlan.pveSpawns.find((p) => p.id.startsWith('gen-pve-'))!;
    const owner = app.store.get<any>('player', a.id)!;
    owner.q = collision.q; owner.r = collision.r;
    owner.ownedVillages[0].q = collision.q; owner.ownedVillages[0].r = collision.r;
    app.store.set('player', a.id, owner);
    a.q = collision.q; a.r = collision.r;
    (app.store as any).flush();

    // 刷档（新赛季）
    app = appAt(file);
    const { accounts } = await app.resetWorld({ keepAccounts: true, reassignSpots: false });
    assert.equal(accounts, 2, '两个账号应保留');
    (app.store as any).flush();

    // 重开载入
    app = appAt(file);
    app.resume();

    // 账号在、密码可登录、坐标不变
    const login = await app.commands.send({ name: 'player.Login', from: 't', payload: { name: '阿甲', password: 'pass123' } });
    assert.equal(login.ok, true, '刷档后应仍能登录');
    const p = (login.payload as any).player;
    assert.equal(p.villageId, a.villageId, 'villageId 应不变');
    assert.equal(p.q, a.q, 'q 坐标应保留');
    assert.equal(p.r, a.r, 'r 坐标应保留');
    const restoredTile = await app.commands.send({ name: 'world.GetTile', from: 't', payload: { q: a.q, r: a.r } });
    assert.equal((restoredTile.payload as any).tile.refId, a.villageId, 'season 必须先恢复旧村，PvE 不得抢占碰撞坐标');

    // 进度归零：村庄按开局模板重建，资源田回到开局 1 级（升过的那块也被重置）
    const vill = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: a.villageId } });
    assert.equal(vill.ok, true);
    const fields = (vill.payload as any).zones.outer.placed.filter((f: any) => f.producing) as { level: number }[];
    assert.ok(fields.length > 0 && fields.every((f) => f.level === 1), '所有资源田应回到开局 1 级');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset:respawn — 保留凭据，重新分配地图位置', async () => {
  clock = 2_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-reset-respawn-'));
  const file = join(dir, 'game.json');
  try {
    let app = appAt(file);
    app.world.setup(41, 41);
    const { b } = await seed(app);
    (app.store as any).flush();

    app = appAt(file);
    const { accounts } = await app.resetWorld({ keepAccounts: true, reassignSpots: true });
    assert.equal(accounts, 2);
    const worldMeta = await app.commands.send({ name: 'world.GetMeta', from: 't', payload: {} });
    assert.deepEqual(worldMeta.payload, { worldW: 96, worldH: 96 }, '旧41世界 respawn 后必须采用新世界96尺寸');
    const plan = generateWorldPlan(96, 96, String(app.config.constants.raw.world_seed), app.config.pveSpawns);
    const legalSlots = new Set(plan.spawnSlots.map((slot) => `${slot.q},${slot.r}`));
    const respawned = app.store.all<any>('player').flatMap((player) => player.ownedVillages);
    assert.ok(respawned.every((village) => legalSlots.has(`${village.q},${village.r}`)), '所有账号必须通过 World 出生槽重排');
    assert.ok(respawned.some((village) => village.q >= 41 || village.r >= 41), '重排应使用96全图而非残留41尺寸');
    (app.store as any).flush();

    app = appAt(file);
    app.resume();

    // 密码仍可登录
    const login = await app.commands.send({ name: 'player.Login', from: 't', payload: { name: '阿乙', password: 'pass123' } });
    assert.equal(login.ok, true, 'respawn 后应仍能登录');
    const p = (login.payload as any).player;

    // 归属索引重建：按新 villageId 能反查回本人
    const owner = await app.commands.send({ name: 'player.GetByVillage', from: 't', payload: { villageId: p.villageId } });
    assert.equal(owner.ok, true, '新 villageId 应能反查到主人');
    assert.equal((owner.payload as any).player.name, '阿乙');

    // 该村在地图上真实存在（世界已重建 + 村庄已放置）
    const area = await app.commands.send({ name: 'world.GetArea', from: 't', payload: { cq: p.q, cr: p.r, r: 0 } });
    assert.equal(area.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wipe:all — 连账号一起清空，回到零玩家', async () => {
  clock = 2_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-wipe-'));
  const file = join(dir, 'game.json');
  try {
    let app = appAt(file);
    await seed(app);
    (app.store as any).flush();

    app = appAt(file);
    const { accounts } = await app.resetWorld({ keepAccounts: false });
    assert.equal(accounts, 2, '应报告清空了 2 个账号');
    (app.store as any).flush();

    // 重开：零玩家，旧账号无法登录
    app = appAt(file);
    assert.equal(app.store.all('player').length, 0, '账号集合应为空');
    const login = await app.commands.send({ name: 'player.Login', from: 't', payload: { name: '阿甲', password: 'pass123' } });
    assert.equal(login.ok, false, '删档后旧账号不应能登录');

    // 用户名可被重新注册（byname 索引也清了）
    app.setupWorld();
    const reg = await app.commands.send({ name: 'player.Register', from: 't', payload: { name: '阿甲', password: 'new123', tribe: 'romans' } });
    assert.equal(reg.ok, true, '删档后同名应可重新注册');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
