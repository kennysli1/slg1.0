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
