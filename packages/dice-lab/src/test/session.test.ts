import assert from 'node:assert/strict';
import test from 'node:test';
import { DiceLabSessions, SessionError } from '../server/sessions.js';

test('实验对局只在内存中创建并拒绝过期 revision', () => {
  const sessions = new DiceLabSessions(10, 60_000, () => 0);
  const first = sessions.create('normal', 2_000);
  assert.equal(first.state.playerScore, 0);
  const rolled = sessions.act(first.id, first.revision, { type: 'roll' });
  assert.equal(rolled.revision, 1);
  assert.throws(
    () => sessions.act(first.id, first.revision, { type: 'roll' }),
    (error: unknown) => error instanceof SessionError && error.code === 'stale_revision',
  );
});

test('非法动作不会推进对局版本', () => {
  const sessions = new DiceLabSessions(10, 60_000, () => 0.5);
  const first = sessions.create('easy', 4_000);
  assert.throws(
    () => sessions.act(first.id, first.revision, { type: 'bank', selectedDieIds: [] }),
    (error: unknown) => error instanceof SessionError && error.code === 'invalid_action',
  );
  assert.equal(sessions.get(first.id).revision, 0);
});
