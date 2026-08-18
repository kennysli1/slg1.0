import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}

/** 收集世界中"非空格子"的坐标 key（与 world.PlaceVillage 的占用口径一致：kind !== 'empty'）。 */
function nonEmptyTileKeys(app: GameApp): Set<string> {
  const s = new Set<string>();
  for (const t of app.store.all<any>('world_tile')) {
    if (t.kind !== 'empty') s.add(`${t.q},${t.r}`);
  }
  return s;
}

function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

/** 连续注册 n 个账号，断言全部成功、且出生点既不落在世界占用格也不互相重叠。 */
async function registerMany(app: GameApp, n: number): Promise<string[]> {
  const spots: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const occupiedBefore = nonEmptyTileKeys(app); // 注册前的占用集合（PvE/taskcamp + 已注册玩家的村）
    // 账号名须 ≤16 字符（注册 schema 限制），用短名 + 序号保证唯一且不超限
    const name = `rs${i.toString().padStart(2, '0')}x`;
    const reg = await send(app, 'player.Register', {
      name, password: 'pass1234', tribe: 'romans',
    });
    assert.equal(reg.ok, true, `第 ${i} 个账号注册应成功，却失败：${reg.reason}`);
    const player = (reg.payload as any).player;
    const key = hexKey(player.q, player.r);
    // 出生坐标绝不能落在"注册前"的任何世界占用格子上（PvE/taskcamp/资源点/他人村）
    assert.ok(!occupiedBefore.has(key), `新玩家 ${name} 被分配到世界占用格子 ${key}`);
    assert.ok(!seen.has(key), `新玩家 ${name} 的出生点 ${key} 与他人重叠`);
    seen.add(key);
    spots.push(key);
  }
  return spots;
}

test('注册建村：默认世界下也能落在完全空格子（避开 PvE / taskcamp）', async () => {
  const app = freshApp();
  const occupiedBefore = nonEmptyTileKeys(app);
  assert.ok(occupiedBefore.size > 0, '测试世界应存在非空格子（PvE 等）以复现 bug');
  await registerMany(app, 12);
});

test('注册建村：地图半数被 PvE 占用时仍必须分配成功（绝不报错放弃）', async () => {
  const app = freshApp();
  const W = app.config.constants.worldW ?? 41;
  const H = app.config.constants.worldH ?? 41;
  // 用棋盘式 PvE 铺满约一半地图：旧代码随机抽到 PvE 格 → PlaceVillage 拒绝 → 注册失败；
  // 修复后 allocateSpot 复用 world.getOccupiedTileKeys()，只在真正空格子上落点。
  let planted = 0;
  for (let q = 0; q < W; q++) {
    for (let r = 0; r < H; r++) {
      if ((q + r) % 2 === 0) {
        app.store.set('world_tile', hexKey(q, r), { q, r, kind: 'pve', icon: 'dummy' });
        planted++;
      }
    }
  }
  assert.ok(planted > W * H * 0.4, `应铺满约半数地图，实际 ${planted}`);
  // 即便半数被占，也应能为多个新玩家找到空位
  const spots = await registerMany(app, 10);
  assert.equal(spots.length, 10);
});
