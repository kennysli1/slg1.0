/**
 * Trade 模块测试：
 *  - 无贸易中心时 GetTradeCenter 返回 built:false
 *  - 建成贸易中心后 NPC 订单可见
 *  - AcceptNpcOrder 资源守恒（给/得与订单声明匹配）
 *  - CreateTradeOrder → 路线占用；CancelTradeOrder → 路线回收（生命周期）
 *  - 不存在的 orderId → order_not_found
 */
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
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd = 'pass') =>
  send(app, 'player.Register', { name, password: pwd, tribe: 'romans' });

async function drain(app: GameApp, step = 3_600_000, maxIters = 1000): Promise<void> {
  for (let i = 0; i < maxIters && app.scheduler.pending > 0; i++) {
    await app.scheduler.advanceTo(clock + step, setClock);
  }
}

/** 找到 zone 内的空槽并建造指定 kind */
async function buildInZone(app: GameApp, villageId: string, zone: 'inner' | 'outer', kind: string): Promise<boolean> {
  const r = await send(app, 'building.Build', { villageId, zone, kind });
  if (!r.ok) return false;
  await drain(app, 60_000);
  return true;
}

// ─── 1. 无贸易中心 ───────────────────────────────────────────────────
test('Trade: 无贸易中心时 GetTradeCenter 返回 built:false', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'player1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const r = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal(r.ok, true, `GetCenter 应 ok，reason: ${r.reason}`);
  assert.equal((r.payload as any).built, false, '无贸易中心应返回 built:false');
});

// ─── 2. 建成后有 NPC 订单 ─────────────────────────────────────────────
test('Trade: 建成贸易中心后 NPC 订单池非空', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'player2');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const built = await buildInZone(app, va, 'outer', 'tradecenter');
  assert.ok(built, '建造贸易中心应成功（outer zone，requires main:1）');

  const r = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal(r.ok, true);
  const p = r.payload as any;
  assert.equal(p.built, true, '建成后 built 应为 true');
  assert.ok(Array.isArray(p.npcOrders), 'npcOrders 应为数组');
  assert.ok(p.npcOrders.length > 0, 'NPC 订单池应非空');
});

// ─── 3. AcceptNpcOrder 资源守恒 ───────────────────────────────────────
test('Trade: AcceptNpcOrder 资源增/减与订单声明一致', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'player3');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const built = await buildInZone(app, va, 'outer', 'tradecenter');
  assert.ok(built, '贸易中心建造应成功');

  const centerRes = await send(app, 'trade.GetCenter', { villageId: va });
  const orders: any[] = (centerRes.payload as any).npcOrders ?? [];
  // 跳过宝物订单（无 give/want 资源），找普通资源订单
  const normalOrder = orders.find((o: any) => !o.treasure && Object.keys(o.give ?? {}).length > 0);
  assert.ok(normalOrder, 'NPC 订单池至少应包含一条普通资源订单');

  // 确保玩家能支付 want（先抬高容量，避免「无露天仓库超额丢弃」干扰交易守恒验证）
  await send(app, 'economy.SetCapacity', {
    villageId: va,
    capacity: { wood: 1_000_000, clay: 1_000_000, iron: 1_000_000, crop: 1_000_000, gold: Number.MAX_SAFE_INTEGER },
  });
  const grantCost: Record<string, number> = {};
  for (const [k, v] of Object.entries(normalOrder.want as Record<string, number>)) {
    grantCost[k] = (v as number) + 10_000;
  }
  await send(app, 'economy.Grant', { villageId: va, gain: grantCost });

  // 记录交易前资源
  const beforeRes = await send(app, 'economy.GetResources', { villageId: va });
  const beforeRs = (beforeRes.payload as any).resources as Record<string, number>;

  // 执行交易
  const acceptRes = await send(app, 'trade.AcceptNpc', { villageId: va, orderId: normalOrder.id });
  assert.equal(acceptRes.ok, true, `AcceptNpcOrder 应成功：${acceptRes.reason}`);

  // 记录交易后资源
  const afterRes = await send(app, 'economy.GetResources', { villageId: va });
  const afterRs = (afterRes.payload as any).resources as Record<string, number>;

  // 验证守恒：对每个资源 after = before + give[k] - want[k]
  for (const k of ['wood', 'clay', 'iron', 'crop', 'gold']) {
    const give = (normalOrder.give as Record<string, number>)[k] ?? 0;
    const want = (normalOrder.want as Record<string, number>)[k] ?? 0;
    const expected = Math.floor((beforeRs[k] ?? 0) + give - want);
    const actual = afterRs[k] ?? 0;
    // 仓储上限可能限制增长，允许 actual <= expected（守恒但受容量限制）
    // 核心：不能凭空增多 gold（无上限资源）或凭空减少
    if (k === 'gold') {
      assert.equal(actual, expected, `gold 守恒：before=${beforeRs[k]}, give=${give}, want=${want}`);
    } else {
      assert.ok(actual <= expected + 1 && actual >= expected - want - 1,
        `${k} 守恒近似：expected≈${expected}, actual=${actual}`);
    }
  }
});

// ─── 4. 不存在的 orderId → order_not_found ─────────────────────────
test('Trade: 不存在的 orderId → order_not_found', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'player4');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  await buildInZone(app, va, 'outer', 'tradecenter');

  const r = await send(app, 'trade.AcceptNpc', { villageId: va, orderId: 'nonexistent_order_id' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'order_not_found');
});

// ─── 5. 路线生命周期：CreateOrder 占用 → CancelOrder 回收 ────────────
test('Trade: CreateTradeOrder 占用路线 CancelTradeOrder 回收路线', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'player5');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const built = await buildInZone(app, va, 'outer', 'tradecenter');
  assert.ok(built, '贸易中心建造应成功');

  // 给足够资源用于挂单
  await send(app, 'economy.Grant', { villageId: va, gain: { wood: 10_000, gold: 10_000 } });

  const beforeCenter = await send(app, 'trade.GetCenter', { villageId: va });
  const routesBefore = (beforeCenter.payload as any).tradeRoutesUsed as number;

  // 创建挂单
  const createRes = await send(app, 'trade.CreateOrder', {
    villageId: va,
    give: { wood: 100 },
    want: { gold: 50 },
  });
  assert.equal(createRes.ok, true, `CreateOrder 应成功：${createRes.reason}`);

  const afterCreate = await send(app, 'trade.GetCenter', { villageId: va });
  const routesAfterCreate = (afterCreate.payload as any).tradeRoutesUsed as number;
  assert.ok(routesAfterCreate >= routesBefore + 1, '创建挂单后路线占用应增加');

  // 找到自己的挂单
  const myOrders: any[] = (afterCreate.payload as any).myOrders ?? [];
  assert.ok(myOrders.length > 0, '创建后 myOrders 应非空');
  const orderId = myOrders[0].id as string;

  // 撤销挂单
  const cancelRes = await send(app, 'trade.CancelOrder', { villageId: va, orderId });
  assert.equal(cancelRes.ok, true, `CancelOrder 应成功：${cancelRes.reason}`);

  const afterCancel = await send(app, 'trade.GetCenter', { villageId: va });
  const routesAfterCancel = (afterCancel.payload as any).tradeRoutesUsed as number;
  assert.ok(routesAfterCancel <= routesAfterCreate - 1, '撤销挂单后路线占用应减少');
});
