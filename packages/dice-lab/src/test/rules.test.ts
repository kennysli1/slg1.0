import assert from 'node:assert/strict';
import test from 'node:test';
import { legalOptions, scoreValues } from '../domain/rules.js';

test('普通骰子基础计分', () => {
  assert.equal(scoreValues([1]), 100);
  assert.equal(scoreValues([5]), 50);
  assert.equal(scoreValues([1, 1, 1]), 1000);
  assert.equal(scoreValues([2, 2, 2]), 200);
  assert.equal(scoreValues([2, 2, 2, 2]), 400);
  assert.equal(scoreValues([3, 3, 3, 3, 3]), 1200);
  assert.equal(scoreValues([6, 6, 6, 6, 6, 6]), 4800);
  assert.equal(scoreValues([1, 2, 3, 4, 5, 6]), 1500);
  assert.equal(scoreValues([1, 1, 2, 2, 3, 3]), 1500);
  assert.equal(scoreValues([2, 3]), null);
});

test('合法选择枚举不包含无法完整计分的子集', () => {
  const dice = [1, 2, 3, 4, 5, 6].map((value, index) => ({ id: String(index), value }));
  const options = legalOptions(dice);
  assert.ok(options.some((option) => option.score === 1500 && option.dieIds.length === 6));
  assert.ok(options.some((option) => option.score === 100 && option.dieIds.length === 1));
  assert.ok(options.every((option) => option.dieIds.length > 0));
});
