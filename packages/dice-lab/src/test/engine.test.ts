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

test('NPC回合返回完整的逐动作骰子与选择事件', () => {
  const game = createGame('easy', 4_000);
  const rolls = [1, 1, 1, 2, 3, 4, 2, 3, 4, 6, 5, 5].map((value) => (value - 1) / 6 + 0.01);
  let index = 0;
  applyAction(game, { type: 'roll' }, () => rolls[index++] ?? 0.5);
  const result = applyAction(game, { type: 'bank', selectedDieIds: ['1-0', '1-1', '1-2'] }, () => rolls[index++] ?? 0.5);

  assert.ok(result.aiEvents.length >= 2);
  assert.equal(result.aiEvents[0].kind, 'roll');
  assert.ok(result.aiEvents.some((event) => event.kind === 'keep' && event.option && event.dice?.length));
  assert.equal(result.state.turnScore, 0);
});

test('达到目标后保留牌桌结果与最终牌面，供客户端等待再来一局清除', () => {
  const game = createGame('easy', 1_000);
  const rolls = [1, 1, 1, 2, 3, 4].map((value) => (value - 1) / 6 + 0.01);
  let index = 0;
  applyAction(game, { type: 'roll' }, () => rolls[index++] ?? 0.5);
  const result = applyAction(game, { type: 'bank', selectedDieIds: ['1-0', '1-1', '1-2'] }, () => 0.5);

  assert.equal(result.state.phase, 'finished');
  assert.equal(result.state.winner, 'player');
  assert.equal(result.state.result?.kind, '同点数组合');
  assert.equal(result.state.result?.label, '1、1、1');
  assert.deepEqual(result.state.dice.map((die) => die.value), [1, 1, 1, 2, 3, 4]);
});
