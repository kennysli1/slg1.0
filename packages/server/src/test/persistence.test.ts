import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp, type GameApp } from '../app.js';
import { hexDistanceWrapped } from '../infra/hex.js';

/**
 * 持久化 + 重启恢复测试。
 * 用真实 JSON 文件 store：注册→建造→刷盘→新建app从同文件载入→数据还在、登录可用、在途任务恢复。
 */

let clock = 1_000_000;
const setClock = (t: number) => (clock = t);

function appAt(storePath: string): GameApp {
  return createGameApp({ now: () => clock, manualScheduler: true, storePath });
}

test('重启后：账号/资源/建筑保留，密码仍可登录，在途建造恢复', async () => {
  clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-persist-'));
  const file = join(dir, 'game.json');

  try {
    // ---- 第一次启动：注册 + 升级一块田（在途） ----
    let app = appAt(file);
    app.setupWorld();
    const reg = await app.commands.send({ name: 'player.Register', from: 't', payload: { name: '持久', password: 'pass123', tribe: 'romans' } });
    assert.equal(reg.ok, true);
    const vid = (reg.payload as any).player.villageId;

    await app.commands.send({ name: 'economy.Grant', from: 't', payload: { villageId: vid, gain: { wood: 500, clay: 500, iron: 500, crop: 500 } } });
    const layout0 = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: vid } });
    const wood0 = (layout0.payload as any).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
    const repair = await app.commands.send({ name: 'building.Repair', from: 't', payload: { villageId: vid, slotId: wood0.slotId } });
    assert.equal(repair.ok, true, `修复应成功: ${repair.reason ?? ''}`);
    await app.scheduler.advanceTo((repair.payload as any).finishAt, setClock);
    const up = await app.commands.send({ name: 'building.Upgrade', from: 't', payload: { villageId: vid, slotId: wood0.slotId } });
    assert.equal(up.ok, true, `升级应成功: ${up.reason ?? ''}`);

    // 刷盘
    app.store.flush();

    // ---- 第二次启动：从文件载入 ----
    app = appAt(file);
    const fresh = app.store.all('player').length === 0;
    assert.equal(fresh, false, '应载入到已有玩家');
    app.resume();

    // 账号还在，密码可登录
    const login = await app.commands.send({ name: 'player.Login', from: 't', payload: { name: '持久', password: 'pass123' } });
    assert.equal(login.ok, true, '重启后应能用密码登录');
    assert.equal((login.payload as any).player.villageId, vid);

    // 资源还在
    const res = await app.commands.send({ name: 'economy.GetResources', from: 't', payload: { villageId: vid } });
    assert.ok((res.payload as any).resources.wood > 0);

    // 在途建造恢复：快进后应完成（woodcutter 升到 2 级）
    await app.scheduler.advanceTo(clock + 120_000, setClock);
    const vil = await app.commands.send({ name: 'building.GetLayout', from: 't', payload: { villageId: vid } });
    const wood1 = (vil.payload as any).zones.outer.placed.find((p: any) => p.kind === 'woodcutter');
    assert.equal(wood1.level, 2, '重启后在途建造应继续并完成');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧存档迁移：缺少自动探索字段与回执集合时可直接重启并首次自动探索', async () => {
  clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-auto-explore-migration-'));
  const file = join(dir, 'game.json');

  try {
    let app = appAt(file);
    app.setupWorld();
    const reg = await app.commands.send({ name: 'player.Register', from: 't', payload: { name: '旧档探索', password: 'pass123', tribe: 'romans' } });
    assert.equal(reg.ok, true);
    const player = (reg.payload as any).player;
    await app.commands.send({ name: 'military.AdjustTroops', from: 't', payload: { villageId: player.villageId, delta: { legionnaire: 20 } } });
    app.store.flush();

    // 模拟上线自动探索前的快照：不存在新增的回执集合，也没有 autoExplore 字段。
    const legacy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete legacy.vision_reveal;
    writeFileSync(file, `${JSON.stringify(legacy)}\n`, 'utf8');

    app = appAt(file);
    assert.equal(app.store.collections().includes('vision_reveal'), false, '旧档不应被启动过程强制重写');
    app.resume();

    const camp = app.store.all<any>('pve').find((target) => hexDistanceWrapped(
      { q: player.q, r: player.r }, { q: target.q, r: target.r }, app.config.constants.worldW, app.config.constants.worldH,
    ) > 4);
    assert.ok(camp, '测试世界应存在城池视野外的公共营地');
    const sent = await app.commands.send({
      name: 'movement.SendAutoExplore', from: 't',
      payload: { villageId: player.villageId, q: camp.q, r: camp.r, troops: { legionnaire: 10 } },
    });
    assert.equal(sent.ok, true, `旧档迁移后应能自动探索: ${sent.reason ?? ''}`);

    await app.scheduler.advanceTo(clock + 60_000, setClock);
    assert.equal(app.store.collections().includes('vision_reveal'), true, '首次揭示才应惰性创建回执集合');
    assert.ok(app.store.get('player', player.id), '迁移不能丢失旧账号');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启后：进行中的战斗恢复并跑完（combat.resume）', async () => {
  clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'slg-battle-'));
  const file = join(dir, 'game.json');

  try {
    // ---- 第一次启动：开一场 PvE 战斗，跑一个 tick 后刷盘（战斗仍进行中） ----
    let app = appAt(file);
    app.setupWorld();
    // 直接对 PvE 目标开战（不经行军，聚焦战斗恢复本身）
    await app.commands.send({
      name: 'combat.Engage', from: 't',
      payload: {
        targetKind: 'pve', targetId: 'pve-4', targetXY: { q: 0, r: 0 },
        movementId: 'mv-persist', fromVillage: 'v-ghost', fromXY: { q: 0, r: 0 },
        troops: { legionnaire: 60 },
        attackerSnapshot: { legionnaire: { count: 60, attack: 40, defense: 35, hp: 100, carry: 10 } },
      },
    });
    // 推进一个 tick，让战斗真正开始减员但尚未结束
    await app.scheduler.advanceTo(clock + 200, setClock);
    const mid = await app.commands.send({ name: 'combat.GetBattle', from: 't', payload: { targetId: 'pve-4' } });
    assert.ok((mid.payload as any).battle, '刷盘前战斗应仍在进行');
    app.store.flush();

    // ---- 第二次启动：从文件载入，combat.resume 应继续把战斗跑完 ----
    app = appAt(file);
    let ended: any = null;
    app.bus.on('combat.BattleEnded', (e) => { if ((e.payload as any).side === 'attacker') ended = e.payload; });
    app.resume();

    let it = 0;
    while (app.scheduler.pending > 0 && it < 30000) { await app.scheduler.advanceTo(clock + 3_600_000, setClock); it++; }
    assert.ok(ended, '重启后进行中的战斗应继续并结束');
    assert.equal(ended.attackerWins, true, '60 军团兵应击败强盗营地');
    // 战斗结束后 battle 记录应被清除
    const after = await app.commands.send({ name: 'combat.GetBattle', from: 't', payload: { targetId: 'pve-4' } });
    assert.equal((after.payload as any).battle, null, '战斗结束应删除 battle 记录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
