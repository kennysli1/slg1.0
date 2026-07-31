/**
 * Scheduler 回归测试：重入保护 / ownerKey / cancelByOwner / reset()
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../infra/scheduler.js';

// ── 测试工具 ──────────────────────────────────────────────────────────────

let clock = 0;
const setClock = (t: number) => { clock = t; };
function makeScheduler() {
  clock = 0;
  return new Scheduler(() => clock, /* manual= */ true);
}

// ── 基础功能（回归原有行为） ─────────────────────────────────────────────

test('Scheduler: schedule 和 advanceTo 正常触发任务', async () => {
  const s = makeScheduler();
  const fired: number[] = [];
  s.schedule(100, () => { fired.push(1); });
  s.schedule(200, () => { fired.push(2); });
  await s.advanceTo(150, setClock);
  assert.deepEqual(fired, [1]);
  await s.advanceTo(300, setClock);
  assert.deepEqual(fired, [1, 2]);
});

test('Scheduler: cancel 按 id 取消单任务', async () => {
  const s = makeScheduler();
  let fired = false;
  const id = s.schedule(100, () => { fired = true; });
  s.cancel(id);
  await s.advanceTo(200, setClock);
  assert.equal(fired, false);
  assert.equal(s.pending, 0);
});

// ── A) ownerKey 与 cancelByOwner ─────────────────────────────────────────

test('Scheduler ownerKey: schedule 携带 ownerKey', () => {
  const s = makeScheduler();
  s.schedule(100, () => {}, 'building:v1');
  s.schedule(200, () => {}, 'building:v1');
  s.schedule(300, () => {}, 'military:v1');
  assert.equal(s.pending, 3);
});

test('Scheduler cancelByOwner: 批量取消同 key 任务', async () => {
  const s = makeScheduler();
  const fired: string[] = [];
  s.schedule(100, () => { fired.push('b1'); }, 'building:v1');
  s.schedule(200, () => { fired.push('b2'); }, 'building:v1');
  s.schedule(150, () => { fired.push('m1'); }, 'military:v1');

  const n = s.cancelByOwner('building:v1');
  assert.equal(n, 2, '应取消 2 个 building:v1 任务');
  assert.equal(s.pending, 1);

  await s.advanceTo(300, setClock);
  assert.deepEqual(fired, ['m1'], 'military:v1 任务应正常触发');
});

test('Scheduler cancelByOwner: 不存在的 key 返回 0', () => {
  const s = makeScheduler();
  s.schedule(100, () => {}, 'building:v1');
  assert.equal(s.cancelByOwner('nonexistent'), 0);
  assert.equal(s.pending, 1);
});

// ── A) reset() ────────────────────────────────────────────────────────────

test('Scheduler reset(): 清空所有待处理任务', async () => {
  const s = makeScheduler();
  const fired: number[] = [];
  s.schedule(100, () => { fired.push(1); }, 'building:v1');
  s.schedule(200, () => { fired.push(2); }, 'military:v1');
  s.schedule(300, () => { fired.push(3); });

  s.reset();
  assert.equal(s.pending, 0, 'reset 后应无待处理任务');

  await s.advanceTo(500, setClock);
  assert.deepEqual(fired, [], 'reset 后快进不应触发任何任务');
});

test('Scheduler reset() 后可继续正常注册任务', async () => {
  const s = makeScheduler();
  s.schedule(100, () => {}, 'x');
  s.reset();
  assert.equal(s.pending, 0);

  const fired: number[] = [];
  s.schedule(50, () => { fired.push(1); });
  await s.advanceTo(100, setClock);
  assert.deepEqual(fired, [1]);
});

// ── A) fireDue 重入保护（手动模式间接验证逻辑） ──────────────────────────

test('Scheduler: 任务内部重新 schedule 不导致无限递归', async () => {
  const s = makeScheduler();
  let depth = 0;
  let fired = 0;

  const registerNext = () => {
    fired++;
    depth++;
    if (depth < 3) {
      // 在任务回调里再注册一个任务（测试不应无限嵌套/重入）
      s.schedule(10, registerNext);
    }
  };

  s.schedule(10, registerNext);
  // 每次 advanceTo 触发当前到期任务，内部新注册的下次 advanceTo 再触发
  await s.advanceTo(10, setClock);
  await s.advanceTo(20, setClock);
  await s.advanceTo(30, setClock);
  assert.equal(fired, 3, '应触发 3 次而非无限递归');
});

// ── pending 计数 ─────────────────────────────────────────────────────────

test('Scheduler pending 正确反映剩余任务数', async () => {
  const s = makeScheduler();
  assert.equal(s.pending, 0);
  s.schedule(100, () => {});
  s.schedule(200, () => {});
  assert.equal(s.pending, 2);
  await s.advanceTo(150, setClock);
  assert.equal(s.pending, 1);
  await s.advanceTo(300, setClock);
  assert.equal(s.pending, 0);
});
