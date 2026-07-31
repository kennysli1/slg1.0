import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, KeyedTokenBuckets } from '../infra/rate-limit.js';

/**
 * 令牌桶限流单元测试
 */

test('TokenBucket：初始满容量，消费正常', () => {
  const bucket = new TokenBucket(5, 1);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false, '已耗尽应被拒绝');
});

test('TokenBucket：时间推进后令牌补充', () => {
  let t = 0;
  const bucket = new TokenBucket(5, 1, () => t);
  // 耗尽
  for (let i = 0; i < 5; i++) bucket.tryConsume();
  assert.equal(bucket.tryConsume(), false);
  // 推进 3 秒
  t += 3000;
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false, '补充了 3 个后第 4 个应被拒绝');
});

test('TokenBucket：令牌数不超过 capacity', () => {
  let t = 0;
  const bucket = new TokenBucket(3, 100, () => t);
  // 耗尽
  for (let i = 0; i < 3; i++) bucket.tryConsume();
  // 推进 10 秒（理论补充 1000 个，但上限 3）
  t += 10000;
  assert.equal(bucket.available, 3);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false);
});

test('TokenBucket：refillRate=0 时固定预算不补充', () => {
  const bucket = new TokenBucket(3, 0);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false, '固定预算耗尽后不补充');
});

test('KeyedTokenBuckets：不同 key 独立限流', () => {
  let t = 0;
  const kb = new KeyedTokenBuckets(2, 0, () => t);
  assert.equal(kb.tryConsume('alice'), true);
  assert.equal(kb.tryConsume('alice'), true);
  assert.equal(kb.tryConsume('alice'), false, 'alice 耗尽');
  // bob 有自己的独立桶，仍可通过
  assert.equal(kb.tryConsume('bob'), true);
  assert.equal(kb.tryConsume('bob'), true);
  assert.equal(kb.tryConsume('bob'), false, 'bob 耗尽');
});

test('KeyedTokenBuckets：GC 清理过时桶', () => {
  let t = 0;
  const kb = new KeyedTokenBuckets(1, 0, () => t, 1000); // ttl=1s
  kb.tryConsume('old');
  assert.equal(kb.size, 1);
  // 推进 2 秒，下次访问时触发 GC
  t += 2000;
  kb.tryConsume('new');
  assert.equal(kb.size, 1, '旧桶应被 GC，只剩新桶');
});

test('KeyedTokenBuckets：同 key 时钟推进后补充', () => {
  let t = 0;
  const kb = new KeyedTokenBuckets(1, 1, () => t); // 1/s 补充
  kb.tryConsume('user');
  assert.equal(kb.tryConsume('user'), false, '耗尽');
  t += 1500; // 推进 1.5 秒
  assert.equal(kb.tryConsume('user'), true, '补充后可通过');
});
