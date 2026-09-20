import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoundedSerialExecutor, sendWithBackpressure, type BufferedSocket } from '../gateway/ws-backpressure.js';

test('WebSocket 发送缓冲超限时断开慢客户端', () => {
  const sent: string[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket: BufferedSocket = {
    readyState: 1,
    bufferedAmount: 90,
    send: (data) => { sent.push(data); },
    close: (code, reason) => { closes.push([code, reason]); },
  };

  assert.equal(sendWithBackpressure(socket, '12345', 100), true);
  assert.deepEqual(sent, ['12345']);
  assert.equal(sendWithBackpressure(socket, '12345678901', 100), false);
  assert.deepEqual(closes, [[1013, 'client too slow']]);
});

test('WebSocket 消息串行处理且积压有硬上限', async () => {
  const executor = new BoundedSerialExecutor(2);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  assert.equal(executor.enqueue(async () => { order.push('first-start'); await firstBlocked; order.push('first-end'); }), true);
  assert.equal(executor.enqueue(async () => { order.push('second'); }), true);
  assert.equal(executor.enqueue(async () => { order.push('overflow'); }), false);
  assert.equal(executor.pending, 2);
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(executor.pending, 0);
});
