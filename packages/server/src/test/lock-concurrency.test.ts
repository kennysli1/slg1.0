/**
 * KeyedSerialQueue 回归测试：FIFO 串行 / 错误隔离 / reset()
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSerialQueue } from '../infra/keyed-serial-queue.js';

// ── 基础串行行为 ──────────────────────────────────────────────────────────

test('KeyedSerialQueue: 同 key 任务严格串行执行', async () => {
  const q = new KeyedSerialQueue();
  const order: number[] = [];

  // run() 内部使用 prev.then(fn)，fn 是在微任务中开始的，需要等一个 tick 让 A 开始。
  let resolveA!: () => void;
  const pA = q.run('v1', () => new Promise<void>((r) => { resolveA = r; order.push(1); }));
  const pB = q.run('v1', async () => { order.push(2); });
  const pC = q.run('v1', async () => { order.push(3); });

  // 让 A 的微任务执行（prev.then(fn) 需要至少一个 await 让 fn 真正开始）
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(order, [1], 'A 已开始，B/C 等待');

  resolveA();
  await pA;
  await pB;
  await pC;

  assert.deepEqual(order, [1, 2, 3], '按 FIFO 顺序执行');
});

test('KeyedSerialQueue: 不同 key 任务互相独立并发', async () => {
  const q = new KeyedSerialQueue();
  const started: string[] = [];

  let resolveA!: () => void;
  const pA = q.run('v1', () => new Promise<void>((r) => { resolveA = r; started.push('v1'); }));
  const pB = q.run('v2', async () => { started.push('v2'); });

  await pB; // v2 立即完成，不被 v1 阻塞
  assert.ok(started.includes('v2'), 'v2 应已独立完成');

  resolveA();
  await pA;
  assert.ok(started.includes('v1'), 'v1 已开始');
});

// ── 错误隔离 ──────────────────────────────────────────────────────────────

test('KeyedSerialQueue: 前置任务抛错不阻断后续任务', async () => {
  const q = new KeyedSerialQueue();
  const results: string[] = [];

  const p1 = q.run('k', async () => { throw new Error('fail'); });
  const p2 = q.run('k', async () => { results.push('ok'); });

  // p1 应 reject
  await assert.rejects(p1, /fail/);
  // p2 应正常执行
  await p2;
  assert.deepEqual(results, ['ok'], '前驱失败后后续任务应正常执行');
});

// ── 返回值透传 ────────────────────────────────────────────────────────────

test('KeyedSerialQueue: run 正确透传 fn 的返回值', async () => {
  const q = new KeyedSerialQueue();
  const result = await q.run('k', async () => 42);
  assert.equal(result, 42);
});

// ── reset() ──────────────────────────────────────────────────────────────

test('KeyedSerialQueue reset(): reset 后 size 为 0', async () => {
  const q = new KeyedSerialQueue();

  // 直接加一个永不完成的任务到队列（不等它）
  // 然后 reset 清掉队列
  let started = false;
  q.run('k', () => new Promise<void>(() => { started = true; }));

  // 等 A 开始（微任务）
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(started, 'A 应已开始');
  assert.ok(q.size > 0, 'reset 前 size > 0');

  q.reset();
  assert.equal(q.size, 0, 'reset 后 size = 0');
});

// ── size 计数 ────────────────────────────────────────────────────────────

test('KeyedSerialQueue size: 任务完成后条目被清除', async () => {
  const q = new KeyedSerialQueue();
  assert.equal(q.size, 0, '初始 size = 0');

  const p = q.run('a', async () => {});
  await p;
  // 任务完成后清理是异步的（microtask），等待一个 tick
  await Promise.resolve();
  assert.equal(q.size, 0, '任务完成后 size 应为 0');
});

// ── 多任务队列后均完成 ────────────────────────────────────────────────────

test('KeyedSerialQueue: 多任务全部完成后 size 为 0', async () => {
  const q = new KeyedSerialQueue();
  const p1 = q.run('x', async () => 1);
  const p2 = q.run('x', async () => 2);
  const p3 = q.run('x', async () => 3);
  const results = await Promise.all([p1, p2, p3]);
  assert.deepEqual(results, [1, 2, 3]);
  // 等清理微任务
  await Promise.resolve();
  assert.equal(q.size, 0, '所有任务完成后 size = 0');
});
