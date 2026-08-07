import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexDistance, linePath, neighbors, hexKey, wrapHex, hexDistanceWrapped, neighborsWrapped, linePathWrapped } from '../infra/hex.js';

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

// ── 环面（torus）几何：纬度 0<=q<W、0<=r<H 取模，坐标跨边界环游 ──

test('wrapHex — 把任意坐标取模回 [0,W)×[0,H)', () => {
  assert.deepEqual(wrapHex({ q: 0, r: 0 }, 41, 41), { q: 0, r: 0 });
  assert.deepEqual(wrapHex({ q: 41, r: 0 }, 41, 41), { q: 0, r: 0 });
  assert.deepEqual(wrapHex({ q: -1, r: 5 }, 41, 41), { q: 40, r: 5 });
  assert.deepEqual(wrapHex({ q: 40, r: 41 }, 41, 41), { q: 40, r: 0 });
  assert.deepEqual(wrapHex({ q: -41, r: -41 }, 41, 41), { q: 0, r: 0 });
});

test('hexDistanceWrapped — 取环面最短距离（可跨边界）', () => {
  const W = 10, H = 10;
  // (0,0) 与 (9,0) 在环面上只差 1（经 q=10 边界）
  assert.equal(hexDistanceWrapped({ q: 0, r: 0 }, { q: 9, r: 0 }, W, H), 1);
  // 不跨边界时与普通距离一致
  assert.equal(hexDistanceWrapped({ q: 0, r: 0 }, { q: 3, r: 0 }, W, H), 3);
  assert.equal(hexDistanceWrapped({ q: 0, r: 0 }, { q: 0, r: 0 }, W, H), 0);
});

test('neighborsWrapped — 邻居均落在 [0,W)×[0,H) 内', () => {
  const W = 5, H = 5;
  const ns = neighborsWrapped({ q: 0, r: 0 }, W, H);
  assert.equal(ns.length, 6);
  for (const n of ns) {
    assert.ok(n.q >= 0 && n.q < W && n.r >= 0 && n.r < H, `邻居 ${hexKey(n.q, n.r)} 应在界内`);
  }
  // 跨边界邻居正确归一：(-1,0) → (4,0)
  assert.ok(ns.some((v) => v.q === 4 && v.r === 0), '应含环面邻居 (4,0)');
});

test('linePathWrapped — 跨边界路径每步环面相邻且终点归一', () => {
  const W = 41, H = 41;
  const path = linePathWrapped({ q: 1, r: 0 }, { q: -1, r: 0 }, W, H);
  assert.equal(path.length, 3, '距离1应含3格');
  assert.deepEqual(path[0], { q: 1, r: 0 });
  for (const p of path) assert.ok(p.q >= 0 && p.q < W && p.r >= 0 && p.r < H);
  // 环面相邻：用 hexDistanceWrapped 校验（平铺坐标经取模后"断点"不能直接用 hexDistance）
  for (let i = 1; i < path.length; i++) {
    assert.equal(hexDistanceWrapped(path[i - 1], path[i], W, H), 1, `第${i}步应环面相邻`);
  }
});
