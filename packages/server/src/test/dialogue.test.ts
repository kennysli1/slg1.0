import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

async function village(app: GameApp, name: string): Promise<string> {
  const result = await send(app, 'player.Register', { name, password: 'pass1', tribe: 'romans' });
  assert.equal(result.ok, true, result.reason);
  return (result.payload as any).player.villageId;
}

test('dialogue：S3 接取前返回幸福村村民对话，且 StartAccept 不消耗 offer', async () => {
  const app = createGameApp({ now: () => 1_000_000, manualScheduler: true });
  app.setupWorld();
  const villageId = await village(app, 'dialogue-s3');
  const state = app.store.get<any>('task', villageId)!;
  state.offeredSide = ['s3'];
  app.store.set('task', villageId, state);

  const started = await send(app, 'task.StartAccept', { villageId, code: 's3' });
  assert.equal(started.ok, true, started.reason);
  const dialogue = (started.payload as any).dialogue;
  assert.equal(dialogue.npcName, '幸福村的村民');
  assert.match(dialogue.npcText, /感谢你清除了附近的威胁/);
  assert.deepEqual(dialogue.replies, [
    { key: 'accept', label: '接受任务' },
    { key: 'leave', label: '离开' },
  ]);
  assert.deepEqual((app.store.get<any>('task', villageId)!).offeredSide, ['s3']);

  const accepted = await send(app, 'task.Accept', { villageId, code: 's3' });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.ok((app.store.get<any>('task', villageId)!).active.s3);
});

test('dialogue：未知任务的对话请求返回空 session', async () => {
  const app = createGameApp({ now: () => 2_000_000, manualScheduler: true });
  const result = await send(app, 'dialogue.StartForTask', { taskCode: 'not-a-task', trigger: 'accept' });
  assert.equal(result.ok, true);
  assert.equal((result.payload as any).dialogue, null);
});
