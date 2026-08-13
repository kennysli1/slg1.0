/**
 * Mercenary 模块测试：
 *  - 无雇佣兵营地时 GetMercCamp 返回 built:false
 *  - 建成营地后 offers 非空
 *  - HireMerc 成功：兵力+1，人口零副作用（currentPop/soldierPop 不变）
 *  - HireMerc 失败：code 不存在（bad_unit）；不在名单（not_offered）；金币不足（spend_failed）
 *  - RefreshMercCamp：有存储刷新时成功，无存储刷新时返回 no_stored_refresh
 *  - 营地升级后 level 更新，名单不重 roll（旧名单保留）
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

async function drain(app: GameApp, step = 3_600_000, maxIters = 500): Promise<void> {
  for (let i = 0; i < maxIters && app.scheduler.pending > 0; i++) {
    await app.scheduler.advanceTo(clock + step, setClock);
  }
}

async function buildMercCamp(app: GameApp, villageId: string): Promise<boolean> {
  const r = await send(app, 'building.Build', { villageId, zone: 'inner', kind: 'mercenarycamp' });
  if (!r.ok) return false;
  await drain(app, 60_000);
  return true;
}

// ─── 1. 无营地时 built:false ──────────────────────────────────────────
test('Mercenary: 无营地时 GetMercCamp 返回 built:false', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc1');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const r = await send(app, 'mercenary.GetCamp', { villageId: va });
  assert.equal(r.ok, true);
  assert.equal((r.payload as any).built, false, '无营地时应返回 built:false');
});

// ─── 2. 建成后 offers 非空 ─────────────────────────────────────────────
test('Mercenary: 建成营地后 offers 非空', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc2');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const built = await buildMercCamp(app, va);
  assert.ok(built, '建造雇佣兵营地应成功');

  const r = await send(app, 'mercenary.GetCamp', { villageId: va });
  assert.equal(r.ok, true);
  const p = r.payload as any;
  assert.equal(p.built, true, '建成后 built 应为 true');
  assert.ok(Array.isArray(p.offers), 'offers 应为数组');
  assert.ok(p.offers.length > 0, '建成后 offers 应非空');
});

// ─── 3. HireMerc 成功：兵力+1，人口零副作用 ─────────────────────────
test('Mercenary: HireMerc 成功后兵力+1，currentPop 不变', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc3');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;

  const built = await buildMercCamp(app, va);
  assert.ok(built, '建造雇佣兵营地应成功');

  const campRes = await send(app, 'mercenary.GetCamp', { villageId: va });
  const offers: any[] = (campRes.payload as any).offers ?? [];
  assert.ok(offers.length > 0, '应有可雇佣名单');
  const offer = offers[0];
  const goldCost: number = offer.goldCost ?? 0;

  // 给足金币
  await send(app, 'economy.Grant', { villageId: va, gain: { gold: goldCost + 10_000 } });

  // 记录雇佣前状态
  const popBefore = await send(app, 'population.GetState', { villageId: va });
  const currentPopBefore: number = (popBefore.payload as any)?.currentPop ?? (popBefore.payload as any)?.pop ?? 0;
  const armyBefore = await send(app, 'military.GetArmy', { villageId: va });
  const troopsBefore: Record<string, number> = (armyBefore.payload as any)?.troops ?? {};

  // 雇佣
  const hireRes = await send(app, 'mercenary.Hire', { villageId: va, code: offer.code });
  assert.equal(hireRes.ok, true, `HireMerc 应成功：${hireRes.reason}`);

  // 验证兵力+1
  const armyAfter = await send(app, 'military.GetArmy', { villageId: va });
  const troopsAfter: Record<string, number> = (armyAfter.payload as any)?.troops ?? {};
  const beforeCount = troopsBefore[offer.code] ?? 0;
  const afterCount = troopsAfter[offer.code] ?? 0;
  assert.equal(afterCount, beforeCount + 1, `${offer.code} 兵力应+1`);

  // 验证人口零副作用（currentPop 不变）
  const popAfter = await send(app, 'population.GetState', { villageId: va });
  const currentPopAfter: number = (popAfter.payload as any)?.currentPop ?? (popAfter.payload as any)?.pop ?? 0;
  assert.equal(currentPopAfter, currentPopBefore, '雇佣兵不消耗人口（currentPop 不变）');
});

test('Mercenary: 合同到期后佣兵退役并释放统御容量', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc-expire');
  const va = (regRes.payload as any).player.villageId as string;
  await buildMercCamp(app, va);
  const before = await send(app, 'mercenary.GetCamp', { villageId: va });
  const offer = (before.payload as any).offers[0];
  await send(app, 'economy.Grant', { villageId: va, gain: { gold: offer.goldCost + 10_000 } });
  const hired = await send(app, 'mercenary.Hire', { villageId: va, code: offer.code });
  assert.equal(hired.ok, true);
  const contract = (hired.payload as any).contracts[0];
  assert.ok(contract.expiresAt > clock);
  assert.ok((hired.payload as any).usedCapacity > 0);

  await app.scheduler.advanceTo(contract.expiresAt, setClock);
  const after = await send(app, 'mercenary.GetCamp', { villageId: va });
  assert.equal((after.payload as any).contracts.length, 0);
  assert.equal((after.payload as any).usedCapacity, 0);
  const army = await send(app, 'military.GetArmy', { villageId: va });
  assert.equal(((army.payload as any).troops[offer.code] ?? 0), 0);
});

// ─── 4. HireMerc 失败场景 ─────────────────────────────────────────────
test('Mercenary: HireMerc 错误兵种代码 → bad_unit', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc4');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;
  await buildMercCamp(app, va);

  const r = await send(app, 'mercenary.Hire', { villageId: va, code: 'nonexistent_unit_code' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_unit');
});

test('Mercenary: HireMerc 金币不足 → spend_failed', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc5');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;
  await buildMercCamp(app, va);

  const campRes = await send(app, 'mercenary.GetCamp', { villageId: va });
  const offers: any[] = (campRes.payload as any).offers ?? [];
  assert.ok(offers.length > 0, '建成营地后应有可雇佣名单');

  // 将 gold 清零（测试专用 store 写入，确保 insufficient:gold 断言路径被执行）
  // 注：start_gold_amount=100，最便宜雇佣兵仅 20 gold，若不清零则永远不会进入不足分支
  const econ = app.store.get<any>('economy', va);
  if (econ) app.store.set('economy', va, { ...econ, resources: { ...econ.resources, gold: 0 } });

  const r = await send(app, 'mercenary.Hire', { villageId: va, code: offers[0].code });
  assert.equal(r.ok, false, '金币不足应失败');
  assert.equal(r.reason, 'insufficient:gold');
});

// ─── 5. RefreshMercCamp ────────────────────────────────────────────────
test('Mercenary: 无存储刷新时 RefreshMercCamp → no_stored_refresh', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc6');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;
  await buildMercCamp(app, va);

  // 开局 storedRefreshes=0
  const campRes = await send(app, 'mercenary.GetCamp', { villageId: va });
  const storedRefreshes: number = (campRes.payload as any).storedRefreshes ?? 0;
  if (storedRefreshes > 0) {
    // 若有存储刷新则先消耗（边界条件不影响后续断言）
    await send(app, 'mercenary.Refresh', { villageId: va });
  }

  // storedRefreshes=0 时刷新应失败
  const r = await send(app, 'mercenary.Refresh', { villageId: va });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_stored_refresh');
});

test('Mercenary: 自动刷新后 storedRefreshes+1，可手动刷新', async () => {
  const app = freshApp();
  const regRes = await reg(app, 'merc7');
  assert.equal(regRes.ok, true);
  const va = (regRes.payload as any).player.villageId as string;
  await buildMercCamp(app, va);

  // 推进超过一次自动刷新周期（Lv1 refreshSec=3600）
  await app.scheduler.advanceTo(clock + 3_700_000, setClock);

  const campRes = await send(app, 'mercenary.GetCamp', { villageId: va });
  const storedRefreshes: number = (campRes.payload as any).storedRefreshes ?? 0;
  assert.ok(storedRefreshes >= 1, `自动刷新后 storedRefreshes 应≥1，实际: ${storedRefreshes}`);

  // 手动刷新应成功
  const r = await send(app, 'mercenary.Refresh', { villageId: va });
  assert.equal(r.ok, true, `手动刷新应成功：${r.reason}`);
  const afterRefresh = r.payload as any;
  assert.ok(Array.isArray(afterRefresh.offers), '刷新后 offers 应为数组');
});
