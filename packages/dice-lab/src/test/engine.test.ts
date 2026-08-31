import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createGame } from '../domain/engine.js';

test('爆骰事件保留导致爆骰的点数，便于客户端展示结果', () => {
  const game = createGame('easy', 4_000);
  const rolls = [2, 2, 3, 3, 4, 6].map((value) => (value - 1) / 6 + 0.01);
  let index = 0;
  const result = applyAction(game, { type: 'roll' }, () => rolls[index++] ?? 0.5);
  const bust = result.state.events.find((event) => event.kind === 'bust' && event.side === 'player');
  assert.ok(bust);
  assert.deepEqual(bust.dice?.map((die) => die.value), [2, 2, 3, 3, 4, 6]);
  assert.equal(result.state.turnScore, 0);
});

test('本轮明细记录前面阶段保留的骰子与分值，并在收下后清空', () => {
  const game = createGame('easy', 4_000);
  const rolls = [1, 1, 1, 2, 3, 4, 5, 5, 5].map((value) => (value - 1) / 6 + 0.01);
  let index = 0;
  applyAction(game, { type: 'roll' }, () => rolls[index++] ?? 0.5);
  const kept = applyAction(game, { type: 'roll', selectedDieIds: ['1-0', '1-1', '1-2'] }, () => rolls[index++] ?? 0.5);

  assert.deepEqual(kept.state.turnBreakdown, [{ label: '1、1、1', score: 1_000 }]);
  assert.equal(kept.state.turnScore, 1_000);

  const banked = applyAction(game, { type: 'bank', selectedDieIds: ['2-0', '2-1', '2-2'] }, () => 0.5);
  assert.deepEqual(banked.state.turnBreakdown, []);
  assert.equal(banked.state.playerScore, 1_500);
});
