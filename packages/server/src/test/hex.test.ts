import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexDistance, linePath, neighbors, hexKey } from '../infra/hex.js';

/**
 * 六边形轴坐标几何单元测试：距离、逐格路径、邻居。
 * 移动系统的正确性根基——路径每步必须是相邻格，距离对称。
 */

test('hexDistance — 原点到邻居为1，对称，同点为0', () => {
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 0, r: 0 }), 0);
  for (const n of neighbors({ q: 0, r: 0 })) {
    assert.equal(hexDistance({ q: 0, r: 0 }, n), 1, `邻居 ${hexKey(n.q, n.r)} 距离应为1`);
  }
  // 对称性
  const a = { q: 3, r: -2 }, b = { q: -1, r: 4 };
  assert.equal(hexDistance(a, b), hexDistance(b, a));
});

test('hexDistance — 沿一条轴的距离等于步数', () => {
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 5, r: 0 }), 5);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 0, r: -4 }), 4);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 3, r: -3 }), 3); // 对角同轴
});

test('linePath — 含首尾，长度=距离+1，相邻两格恒为邻居', () => {
  const from = { q: -2, r: 1 }, to = { q: 4, r: -3 };
  const path = linePath(from, to);
  const d = hexDistance(from, to);
  assert.equal(path.length, d + 1, '路径长度应为 距离+1');
  assert.deepEqual(path[0], from, '首格应为起点');
  assert.deepEqual(path[path.length - 1], to, '末格应为终点');
  for (let i = 1; i < path.length; i++) {
    assert.equal(hexDistance(path[i - 1], path[i]), 1, `第${i}步应与上一格相邻`);
  }
});

test('linePath — 起终同点返回单格', () => {
  const p = linePath({ q: 2, r: 2 }, { q: 2, r: 2 });
  assert.equal(p.length, 1);
  assert.deepEqual(p[0], { q: 2, r: 2 });
});
