/**
 * 回归：Gateway 请求与 Scheduler 定时任务同村严格串行
 *
 * 核心问题：架构修复前 Gateway 有自己的 villageQueue，而 Scheduler 任务
 * 直接 await task.run()，两者使用不同队列，同村写操作仍可交错。
 *
 * 修复后：
 *  - app.ts 创建唯一 KeyedSerialQueue 实例 (serialQueue)
 *  - Scheduler 接收该实例；带 serializationKey 的任务通过它执行
 *  - Gateway 使用 app.serialQueue.run("village:<id>", ...)，不再自建队列
 *  - 所有村级模块任务的 serializationKey = "village:<villageId>"
 *
 * 覆盖：
 *  1. KeyedSerialQueue 本身：同 key 任务不重叠（不依赖游戏模块）
 *  2. Scheduler + serialQueue 集成：带 serializationKey 的任务通过队列执行
 *  3. Gateway + Scheduler 端到端：模拟建造计时器与同村 WS 请求互不交错
 *  4. 不同 key 任务仍可并行（不误伤性能）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSerialQueue } from '../infra/keyed-serial-queue.js';
import { Scheduler } from '../infra/scheduler.js';
import { createGameApp } from '../app.js';

// ── 1. KeyedSerialQueue 同 key 任务不重叠 ───────────────────────────────

test('Gateway-Scheduler serial: 同 key 任务最大并发为 1', async () => {
  const queue = new KeyedSerialQueue();
  const key = 'village:v-test';

  let inFlight = 0;
  let maxConcurrent = 0;
  const order: number[] = [];

  const makeOp = (n: number) => async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    // 给微任务调度一个 await 点，制造"并发机会"
    await Promise.resolve();
    order.push(n);
    inFlight--;
  };

  await Promise.all([
    queue.run(key, makeOp(1)),
    queue.run(key, makeOp(2)),
    queue.run(key, makeOp(3)),
  ]);

  assert.equal(maxConcurrent, 1, '同 key 最多 1 个任务并发执行');
  assert.deepEqual(order, [1, 2, 3], '同 key 任务严格 FIFO');
});

// ── 2. Scheduler + serialQueue 集成：带 serializationKey 的任务过队列 ─────

test('Gateway-Scheduler serial: Scheduler 任务通过 serialQueue 执行', async () => {
  const queue = new KeyedSerialQueue();
  let clock = 1_000_000;
  const scheduler = new Scheduler(() => clock, true, queue);

  const key = 'village:v-test';
  let inFlight = 0;
  let maxConcurrent = 0;
  const executedOrder: string[] = [];

  // 直接向 serialQueue 注入一个"长 Gateway 请求"（尚未完成）
  let resolveGateway!: () => void;
  const gatewayDone = new Promise<void>((res) => { resolveGateway = res; });
  const gatewayPromise = queue.run(key, () => gatewayDone.then(() => {
    inFlight--;
    executedOrder.push('gateway');
  }));
  inFlight++; // 假设 Gateway 请求开始

  // 注册一个 Scheduler 任务（同 key），应排在 Gateway 后面
  scheduler.schedule(0, async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await Promise.resolve();
    executedOrder.push('scheduler');
    inFlight--;
  }, undefined, key);

  // 触发 Scheduler（时钟不变，任务立即到期）
  const firePromise = (scheduler as any).fireDue() as Promise<void>;

  // 此时 Gateway 请求还没完成，Scheduler 任务应排队中（不能先执行）
  assert.equal(inFlight, 1, 'Scheduler 任务应在 Gateway 完成前等待');

  // 完成 Gateway 请求，让队列继续
  resolveGateway();
  await gatewayPromise;
  await firePromise;

  assert.equal(maxConcurrent, 1, '同 key 最多 1 个任务并发');
  assert.deepEqual(executedOrder, ['gateway', 'scheduler'], 'Scheduler 任务应排在 Gateway 请求后面');
});

// ── 3. 不同 key 任务可以并行 ────────────────────────────────────────────

test('Gateway-Scheduler serial: 不同 key 任务互不阻塞', async () => {
  const queue = new KeyedSerialQueue();
  const started: string[] = [];

  let resolveA!: () => void;
  let resolveB!: () => void;

  const promiseA = queue.run('village:v1', () => new Promise<void>((res) => {
    started.push('A');
    resolveA = res;
  }));
  const promiseB = queue.run('village:v2', () => new Promise<void>((res) => {
    started.push('B');
    resolveB = res;
  }));

  // 等微任务调度
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started.sort(), ['A', 'B'], '不同 key 的任务应同时开始');

  resolveA();
  resolveB();
  await Promise.all([promiseA, promiseB]);
});

// ── 4. 端到端：村级 Scheduler 任务与 serialQueue Gateway 请求不交错 ─────────

test('Gateway-Scheduler serial: 建造计时器与同村请求不交错破坏状态', async () => {
  let clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();

  // 注册玩家
  const reg = await app.commands.send({
    name: 'player.Register', from: 'test',
    payload: { name: '串行测试', password: 'pass123', tribe: 'romans' },
  });
  assert.ok(reg.ok);
  const vid = (reg.payload as any).player.villageId;

  // 用共享 serialQueue 模拟"Gateway 写请求正在执行"（key = village:<vid>）
  let gatewayRunning = true;
  let schedulerRanWhileGatewayRunning = false;

  let resolveGateway!: () => void;
  const gatewayBlocker = new Promise<void>((res) => { resolveGateway = res; });

  // 注入假 Gateway 请求到共享队列
  const gatewayPromise = app.serialQueue.run(`village:${vid}`, async () => {
    await gatewayBlocker;
    gatewayRunning = false;
  });

  // 直接向 serialQueue 注入一个"Scheduler 村级任务"（模拟建造完成回调）
  const schedulerPromise = app.serialQueue.run(`village:${vid}`, async () => {
    if (gatewayRunning) schedulerRanWhileGatewayRunning = true;
  });

  // 先等微任务让 Gateway 请求开始
  await Promise.resolve();
  await Promise.resolve();

  // Gateway 还在跑，释放它
  resolveGateway();
  await gatewayPromise;
  await schedulerPromise;

  assert.equal(schedulerRanWhileGatewayRunning, false, 'Scheduler 村级任务不应在 Gateway 请求执行期间运行（同 key 串行）');
});

// ── 5. serialQueue 在 resetWorld 后被重置 ────────────────────────────────

test('Gateway-Scheduler serial: resetWorld 后 serialQueue 被重置', async () => {
  let clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();

  // 先等微任务，确保 serialQueue 内部 Promise 链初始化完毕
  await Promise.resolve();

  let hangResolve: (() => void) | undefined;
  // 注入一个长任务（不立即 resolve）
  void app.serialQueue.run('village:v-hang', () => new Promise<void>((res) => { hangResolve = res; }));

  // 给一个微任务让上面的 fn 开始执行（fn 在 prev.then() 里，需要一个 tick）
  await Promise.resolve();
  await Promise.resolve();

  // 入队后续任务
  let secondRan = false;
  void app.serialQueue.run('village:v-hang', async () => { secondRan = true; });

  // 确认队列 size > 0 或存在等待任务
  // (key 可能在清理前已移除，但 secondRan 一定是 false 因为 hang 还没完成)
  assert.equal(secondRan, false, 'reset 前第二个任务不应执行');

  app.resetWorld({ keepAccounts: false });

  assert.equal(app.serialQueue.size, 0, 'resetWorld 后 serialQueue.size 应为 0');

  // 解除 hang（避免进程残留）
  hangResolve?.();
  await Promise.resolve();

  // 关键：reset 后的后续任务不应再运行
  assert.equal(secondRan, false, 'reset 后的排队任务不应执行');
});
