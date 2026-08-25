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

test('dialogue：S4 带回被囚禁的娜塔莉们时报告入口返回无选项对话', async () => {
  const app = createGameApp({ now: () => 2_500_000, manualScheduler: true });
  app.setupWorld();
  const started = await send(app, 'dialogue.StartForTask', { taskCode: 's4', trigger: 'natalies_returned' });
  assert.equal(started.ok, true, started.reason);
  const dialogue = (started.payload as any).dialogue;
  assert.equal(dialogue.code, 's4_natalies_returned');
  assert.equal(dialogue.npcName, '被囚禁的娜塔莉们');
  assert.match(dialogue.npcText, /多谢你拯救了我们/);
  assert.match(dialogue.npcText, /请释放我们让我们回家/);
  assert.deepEqual(dialogue.replies, []);
});

test('dialogue：S3 接取后弹出当前接取村庄村民的单段后续对话', async () => {
  const app = createGameApp({ now: () => 3_000_000, manualScheduler: true });
  app.setupWorld();
  const registered = await send(app, 'player.Register', { name: 's3-after', password: 'pass1', tribe: 'romans' });
  assert.equal(registered.ok, true, registered.reason);
  const player = (registered.payload as any).player;
  const villageId = player.villageId as string;
  const state = app.store.get<any>('task', villageId)!;
  state.offeredSide = ['s3'];
  app.store.set('task', villageId, state);

  const accepted = await send(app, 'task.Accept', { villageId, code: 's3' });
  assert.equal(accepted.ok, true, accepted.reason);
  const snapshot = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal(snapshot.ok, true, snapshot.reason);
  const pending = ((snapshot.payload as any).pendingDialogues ?? [])
    .find((item: any) => item.taskCode === 's3' && item.trigger === 'after_accept');
  assert.ok(pending?.dialogue);
  assert.equal(pending.dialogue.npcName, 's3-after的村庄的村民');
  assert.equal(pending.dialogue.npcText, '领主大人，据我所知隔壁幸福村妇女权益比较低，他们不应该会打着妇女儿童的旗号索求援助啊？');
  assert.deepEqual(pending.dialogue.replies, []);

  const consumed = await send(app, 'task.ConsumeDialogue', { playerId: player.id, dialogueId: pending.id });
  assert.equal(consumed.ok, true, consumed.reason);
  const after = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal((after.payload as any).pendingDialogues.some((item: any) => item.id === pending.id), false);
});

test('dialogue：新账号自动激活 M1 并保留一次性待弹对话记录', async () => {
  const app = createGameApp({ now: () => 4_000_000, manualScheduler: true });
  app.setupWorld();
  const registered = await send(app, 'player.Register', { name: 'dialogue-m1', password: 'pass1', tribe: 'romans' });
  assert.equal(registered.ok, true, registered.reason);
  const player = (registered.payload as any).player;
  const snapshot = await send(app, 'task.GetPlayerState', { playerId: player.id });
  const pending = ((snapshot.payload as any).pendingDialogues ?? [])
    .find((item: any) => item.taskCode === 'm1' && item.trigger === 'accept');
  assert.ok(pending, 'M1 首次自动激活应有待弹对话记录');
  assert.equal(pending.dialogue.npcName, '');
  assert.equal(pending.dialogue.npcText, '');
  const consumed = await send(app, 'task.ConsumeDialogue', { playerId: player.id, dialogueId: pending.id });
  assert.equal(consumed.ok, true, consumed.reason);
  const after = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal((after.payload as any).pendingDialogues.some((item: any) => item.id === pending.id), false);
});
