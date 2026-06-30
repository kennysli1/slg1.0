import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp, type GameApp } from '../app.js';

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
    const up = await app.commands.send({ name: 'building.UpgradeField', from: 't', payload: { villageId: vid, fieldIndex: 0 } });
    assert.equal(up.ok, true, `升级应成功: ${up.reason ?? ''}`);

    // 刷盘
    (app.store as any).flush();

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

    // 在途建造恢复：快进后应完成（等级变1）
    await app.scheduler.advanceTo(clock + 120_000, setClock);
    const vil = await app.commands.send({ name: 'building.GetState', from: 't', payload: { villageId: vid } });
    assert.equal((vil.payload as any).fields[0].level, 1, '重启后在途建造应继续并完成');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
