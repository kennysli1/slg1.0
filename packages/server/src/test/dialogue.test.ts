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
  // 回复按钮属于配置中心权威内容；StartAccept 只能原样返回，不能
  // 偷塞“离开”或其它默认按钮。
  assert.deepEqual(dialogue.replies, app.config.dialogues['s3_accept:1']?.replies);
  assert.ok(dialogue.replies.some((reply: any) => reply.key === 'accept' && reply.label === '接受任务'));
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

test('dialogue：同一对象的多段文本按 segment 顺序一次返回', async () => {
  const app = createGameApp({ now: () => 2_600_000, manualScheduler: true });
  app.setupWorld();
  const first = app.config.dialogues['s4_natalies_returned:1'];
  assert.ok(first);
  app.config.dialogues['s4_natalies_returned:2'] = {
    ...first,
    segment: 2,
    npcName: '被囚禁的娜塔莉们',
    npcText: '请把我们的消息带回家。',
    replies: [],
  };
  const started = await send(app, 'dialogue.StartForTask', { taskCode: 's4', trigger: 'natalies_returned' });
  assert.equal(started.ok, true, started.reason);
  const dialogue = (started.payload as any).dialogue;
  assert.equal(dialogue.segmentCount, 2);
  assert.deepEqual(dialogue.segments.map((item: any) => item.segment), [1, 2]);
  assert.equal(dialogue.segments[1].npcText, '请把我们的消息带回家。');
});

test('dialogue：M11 交付返回完整的两段长老对话', async () => {
  const app = createGameApp({ now: () => 2_650_000, manualScheduler: true });
  app.setupWorld();
  const started = await send(app, 'dialogue.StartForTask', { taskCode: 'm11', trigger: 'deliver' });
  assert.equal(started.ok, true, started.reason);
  const dialogue = (started.payload as any).dialogue;
  assert.equal(dialogue.segmentCount, 2);
  assert.deepEqual(dialogue.segments.map((item: any) => item.segment), [1, 2]);
  assert.match(dialogue.segments[1].npcText, /议会厅/);
});

test('task.StartDeliver：只返回奖励预览和完整交付对话，不改变任务或任何奖励状态', async () => {
  const app = createGameApp({ now: () => 2_660_000, manualScheduler: true });
  app.setupWorld();
  const villageId = await village(app, 'deliver-preview');
  const state = app.store.get<any>('task', villageId)!;
  state.active.m11 = {
    code: 'm11', type: 'main', executionVillageId: villageId, spawnVillageId: villageId,
    acceptedAt: 2_660_000, submitted: {}, camps: [], campCleared: 0, progress: 200,
    readyToDeliver: true,
  };
  app.store.set('task', villageId, state);
  const before = {
    task: structuredClone(app.store.get<any>('task', villageId)),
    economy: structuredClone(app.store.get<any>('economy', villageId)),
    population: structuredClone(app.store.get<any>('population', villageId)),
    reputation: structuredClone(app.store.get<any>('reputation', villageId)),
    treasure: structuredClone(app.store.get<any>('treasure', villageId)),
    military: structuredClone(app.store.get<any>('military', villageId)),
    research: structuredClone(app.store.get<any>('research', villageId)),
  };

  const started = await send(app, 'task.StartDeliver', { villageId, code: 'm11' });
  assert.equal(started.ok, true, started.reason);
  const payload = started.payload as any;
  assert.deepEqual(payload.previewRewards.buildingUnlocks, ['alliance_hall', 'council']);
  assert.equal(payload.rewardVillageId, villageId);
  assert.equal(payload.dialogue.segmentCount, 2);
  assert.equal(payload.dialogue.segments[0].replies[0].key, 'take');
  assert.deepEqual(app.store.get<any>('task', villageId), before.task, '预览不能完成、移除或改写任务');
  for (const collection of ['economy', 'population', 'reputation', 'treasure', 'military', 'research'] as const) {
    assert.deepEqual(app.store.get<any>(collection, villageId), before[collection], `预览不能改写 ${collection}`);
  }
});

test('task.StartDeliver：空白交付配置仍返回默认收下段，关闭预览后任务保持待领取', async () => {
  const app = createGameApp({ now: () => 2_670_000, manualScheduler: true });
  app.setupWorld();
  const villageId = await village(app, 'deliver-fallback');
  const state = app.store.get<any>('task', villageId)!;
  state.active.m11 = {
    code: 'm11', type: 'main', executionVillageId: villageId, spawnVillageId: villageId,
    acceptedAt: 2_670_000, submitted: {}, camps: [], campCleared: 0, progress: 200,
    readyToDeliver: true,
  };
  app.store.set('task', villageId, state);
  for (const key of Object.keys(app.config.dialogues)) {
    if (app.config.dialogues[key].taskCode === 'm11' && app.config.dialogues[key].trigger === 'deliver') delete app.config.dialogues[key];
  }

  const first = await send(app, 'task.StartDeliver', { villageId, code: 'm11' });
  assert.equal(first.ok, true, first.reason);
  assert.equal((first.payload as any).dialogue.npcText, '任务奖励已准备好。');
  assert.deepEqual((first.payload as any).dialogue.replies, [{ key: 'take', label: '收下' }]);
  assert.equal(app.store.get<any>('task', villageId)?.active?.m11?.readyToDeliver, true);

  // 模拟玩家关闭再打开：StartDeliver 必须仍从第一段返回，任务不能因预览消失。
  const reopened = await send(app, 'task.StartDeliver', { villageId, code: 'm11' });
  assert.equal(reopened.ok, true, reopened.reason);
  assert.equal((reopened.payload as any).dialogue.segment, 1);
  assert.ok(app.store.get<any>('task', villageId)?.active?.m11);
});

test('task.StartDeliver：M9 动态奖励分支与正式结算使用相同解析结果', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const app = createGameApp({ now: () => 2_680_000, manualScheduler: true });
    app.setupWorld();
    const villageId = await village(app, outcome === 'success' ? 'm9-prev-ok' : 'm9-prev-fail');
    const state = app.store.get<any>('task', villageId)!;
    state.active.m9 = {
      code: 'm9', type: 'main', executionVillageId: villageId, spawnVillageId: villageId,
      acceptedAt: 2_680_000, submitted: {}, camps: [], campCleared: 0, progress: 1,
      readyToDeliver: true,
    };
    state.outcomes = { m8: outcome };
    app.store.set('task', villageId, state);

    const started = await send(app, 'task.StartDeliver', { villageId, code: 'm9' });
    assert.equal(started.ok, true, started.reason);
    const preview = (started.payload as any).previewRewards;
    assert.ok((started.payload as any).dialogue.segments[0].replies.some((reply: any) => reply.key === 'take'), '异常分支文本也必须可确认领取');
    const delivered = await send(app, 'task.Deliver', { villageId, code: 'm9' });
    assert.equal(delivered.ok, true, delivered.reason);
    const actual = (delivered.payload as any).rewards;
    assert.deepEqual(preview.treasures, actual.treasures, `${outcome} 分支宝物预览必须与实发一致`);
    if (outcome === 'success') assert.equal(preview.population, 5);
    else assert.equal(preview.population, undefined);
  }
});

test('task.Deliver：正式结算失败时任务保持待领取，可在当前段重试', async () => {
  const app = createGameApp({ now: () => 2_690_000, manualScheduler: true });
  app.setupWorld();
  const villageId = await village(app, 'deliver-retry');
  const state = app.store.get<any>('task', villageId)!;
  state.active.s2 = {
    code: 's2', type: 'side', executionVillageId: villageId, spawnVillageId: villageId,
    acceptedAt: 2_690_000, submitted: {}, camps: [], campCleared: 0, progress: 1,
    readyToDeliver: true, qualifiedFlagMovements: ['missing-flag-movement'],
  };
  app.store.set('task', villageId, state);

  const started = await send(app, 'task.StartDeliver', { villageId, code: 's2' });
  assert.equal(started.ok, true, started.reason);
  const delivered = await send(app, 'task.Deliver', { villageId, code: 's2' });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.reason, 'qualifying_flag_not_stored');
  const active = app.store.get<any>('task', villageId)?.active?.s2;
  assert.ok(active, '失败后任务不能消失');
  assert.equal(active.readyToDeliver, true, '失败后必须仍为待领取');
  assert.deepEqual(active.qualifiedFlagMovements, ['missing-flag-movement'], '失败不能破坏可重试依据');
});

test('dialogue：自动任务对话快照也携带完整段落组', async () => {
  const app = createGameApp({ now: () => 2_700_000, manualScheduler: true });
  app.setupWorld();
  const first = app.config.dialogues['m1_accept:1'];
  assert.ok(first);
  app.config.dialogues['m1_accept:2'] = {
    ...first,
    segment: 2,
    npcText: '愿我们一起重建家园。',
  };
  const registered = await send(app, 'player.Register', { name: 'm1-segs', password: 'pass1', tribe: 'romans' });
  assert.equal(registered.ok, true, registered.reason);
  const player = (registered.payload as any).player;
  const snapshot = await send(app, 'task.GetPlayerState', { playerId: player.id });
  const pending = ((snapshot.payload as any).pendingDialogues ?? [])
    .find((item: any) => item.taskCode === 'm1' && item.trigger === 'accept');
  assert.equal(pending.dialogue.segmentCount, 2);
  assert.equal(pending.dialogue.segments[1].npcText, '愿我们一起重建家园。');
});

test('dialogue：S3 接取后排队独立的 after_accept 对话', async () => {
  const app = createGameApp({ now: () => 3_000_000, manualScheduler: true });
  app.setupWorld();
  const registered = await send(app, 'player.Register', { name: 's3-after', password: 'pass1', tribe: 'romans' });
  assert.equal(registered.ok, true, registered.reason);
  const player = (registered.payload as any).player;
  const villageId = player.villageId as string;
  const state = app.store.get<any>('task', villageId)!;
  state.offeredSide = ['s3'];
  app.store.set('task', villageId, state);

  const started = await send(app, 'task.StartAccept', { villageId, code: 's3' });
  assert.equal(started.ok, true, started.reason);
  const dialogue = (started.payload as any).dialogue;
  assert.equal(dialogue.segmentCount, 1);
  assert.equal(dialogue.code, 's3_accept');
  assert.equal(dialogue.npcName, '幸福村的村民');

  const accepted = await send(app, 'task.Accept', { villageId, code: 's3' });
  assert.equal(accepted.ok, true, accepted.reason);
  const snapshot = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal(snapshot.ok, true, snapshot.reason);
  const pending = ((snapshot.payload as any).pendingDialogues ?? [])
    .find((item: any) => item.taskCode === 's3' && item.trigger === 'after_accept');
  assert.ok(pending, '接受成功后应排队独立 after_accept 对话');
  assert.equal(pending.dialogue.code, 's3_after_accept');
  assert.equal(pending.dialogue.segmentCount, 1);
  assert.equal(pending.dialogue.npcName, 's3-after的村庄的村民');
  assert.equal(pending.dialogue.npcText, '领主大人，据我所知隔壁幸福村妇女权益比较低，他们不应该会打着妇女儿童的旗号索求援助啊？');
  assert.deepEqual(pending.dialogue.replies, []);
  assert.ok((app.store.get<any>('task', villageId)!).active.s3);
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
  assert.equal(pending.dialogue.npcName, 'dialogue-m1的村庄的长老');
  assert.match(pending.dialogue.npcText, /欢迎领主大人接手我们的村庄/);
  assert.match(pending.dialogue.npcText, /由于年久失修我们城外的资源田都已经荒废了/);
  const consumed = await send(app, 'task.ConsumeDialogue', { playerId: player.id, dialogueId: pending.id });
  assert.equal(consumed.ok, true, consumed.reason);
  const after = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal((after.payload as any).pendingDialogues.some((item: any) => item.id === pending.id), false);
});
