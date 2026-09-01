import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

const send = (app: GameApp, name: string, payload: any) => app.commands.send({ name, from: 'dice-quest-test', payload });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function register(app: GameApp, name: string): Promise<string> {
  const result = await send(app, 'player.Register', { name, password: 'pass1', tribe: 'romans' });
  assert.equal(result.ok, true, result.reason);
  await tick();
  return (result.payload as any).player.villageId as string;
}

async function activate(app: GameApp, villageId: string, code: 's6' | 's7'): Promise<void> {
  const state = app.store.get<any>('task', villageId)!;
  if (code === 's6') state.offeredSide = ['s6'];
  else { state.completedSide = ['s6']; state.offeredSide = ['s7']; }
  app.store.set('task', villageId, state);
  const accepted = await send(app, 'task.Accept', { villageId, code });
  assert.equal(accepted.ok, true, accepted.reason);
}

async function winOneRound(app: GameApp, villageId: string, code: 's6' | 's7'): Promise<any> {
  const started = await send(app, 'diceQuest.StartMatch', { villageId, taskCode: code });
  assert.equal(started.ok, true, started.reason);
  const sessionId = (started.payload as any).sessionId;
  const rolled = await send(app, 'diceQuest.Action', { villageId, sessionId, type: 'roll' });
  assert.equal(rolled.ok, true, rolled.reason);
  const dice = (rolled.payload as any).state.dice as Array<{ id: string }>;
  const banked = await send(app, 'diceQuest.Action', { villageId, sessionId, type: 'bank', selectedDieIds: dice.map((die) => die.id) });
  assert.equal(banked.ok, true, banked.reason);
  const exited = await send(app, 'diceQuest.ExitMatch', { villageId, sessionId });
  assert.equal(exited.ok, true, exited.reason);
  return banked.payload;
}

test('骰子王：s6 胜利后任务待领取，失败记录后可再次开始', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'dice-s6');
  await activate(app, villageId, 's6');
  const result = await winOneRound(app, villageId, 's6');
  assert.equal(result.round.outcome, 'player');
  const state = (await send(app, 'task.GetState', { villageId })).payload as any;
  const task = state.active.find((item: any) => item.code === 's6');
  assert.equal(task.ready, true);
  assert.equal(task.dicePlayerWins, 1);
});

test('骰子王：s6 败局保留任务，重新尝试时从零开始', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'dice-s6-retry');
  await activate(app, villageId, 's6');
  const started = await send(app, 'diceQuest.StartMatch', { villageId, taskCode: 's6' });
  assert.equal(started.ok, true, started.reason);
  const sessionId = (started.payload as any).sessionId;
  const lost = await send(app, 'diceQuest.Action', { villageId, sessionId, type: 'forfeit' });
  assert.equal(lost.ok, true, lost.reason);
  await send(app, 'diceQuest.ExitMatch', { villageId, sessionId });
  const retry = await send(app, 'diceQuest.StartMatch', { villageId, taskCode: 's6' });
  assert.equal(retry.ok, true, retry.reason);
  assert.deepEqual((retry.payload as any).match, { playerWins: 0, npcWins: 0, winsRequired: 1 });
  await send(app, 'diceQuest.ExitMatch', { villageId, sessionId: (retry.payload as any).sessionId });
});

test('骰子王：刷新/掉线后重新 StartMatch 会丢弃旧内存 session 并重新开桌', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'dice-s6-refresh');
  await activate(app, villageId, 's6');
  const first = await send(app, 'diceQuest.StartMatch', { villageId, taskCode: 's6' });
  assert.equal(first.ok, true, first.reason);
  const second = await send(app, 'diceQuest.StartMatch', { villageId, taskCode: 's6' });
  assert.equal(second.ok, true, second.reason);
  assert.notEqual((second.payload as any).sessionId, (first.payload as any).sessionId);
  await send(app, 'diceQuest.ExitMatch', { villageId, sessionId: (second.payload as any).sessionId });
});

test('骰子王：s7 支付入场费并累计两场胜利后可领取', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'dice-s7');
  const resourcesBefore = (await send(app, 'economy.GetResources', { villageId })).payload as any;
  await activate(app, villageId, 's7');
  const first = await winOneRound(app, villageId, 's7');
  assert.deepEqual(first.match, { playerWins: 1, npcWins: 0, winsRequired: 2 });
  const second = await winOneRound(app, villageId, 's7');
  assert.deepEqual(second.match, { playerWins: 2, npcWins: 0, winsRequired: 2 });
  const resourcesAfter = (await send(app, 'economy.GetResources', { villageId })).payload as any;
  assert.equal(Number(resourcesBefore.resources.gold) - Number(resourcesAfter.resources.gold), 100);
  const state = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.equal(state.active.find((item: any) => item.code === 's7')?.ready, true);
});

test('骰子王：入场券使用后解锁 s7，且普通骰子的一和五可与同点数组合叠加', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'dice-ticket');
  const taskState = app.store.get<any>('task', villageId)!;
  taskState.completedSide = ['s6'];
  app.store.set('task', villageId, taskState);
  const granted = await send(app, 'treasure.Grant', { villageId, code: 'dice_tournament_ticket' });
  assert.equal(granted.ok, true, granted.reason);
  const used = await send(app, 'treasure.Use', { villageId, code: 'dice_tournament_ticket', location: 'town' });
  assert.equal(used.ok, true, used.reason);
  const after = (await send(app, 'task.GetState', { villageId })).payload as any;
  assert.ok(after.offeredSide.some((item: any) => item.code === 's7'));

  const { legalOptions } = await import('../infra/dice-quest-engine.js');
  const dice = [1, 5, 2, 2, 2].map((value, index) => ({ id: String(index), value }));
  assert.ok(legalOptions(dice).some((option) => option.score === 350 && option.dieIds.length === 5));
});

test('骰子王：使用入场券按 t2/use 触发已配置对话', async () => {
  const app = createGameApp({ manualScheduler: true, rng: () => 0 });
  app.setupWorld();
  const villageId = await register(app, 'ticket-dlg');
  const dialogueDef = app.config.dialogues['dice_tournament_ticket_use:1'];
  assert.ok(dialogueDef, '入场券使用对话模板必须存在');
  assert.equal(dialogueDef.taskCode, 't2');
  assert.equal(dialogueDef.trigger, 'use');
  // 默认模板允许在配置中心留空；这里填入内容验证“有内容时”端到端返回 session。
  dialogueDef.npcName = '骰子裁判';
  dialogueDef.npcText = '入场券已生效。';

  const granted = await send(app, 'treasure.Grant', { villageId, code: 'dice_tournament_ticket' });
  assert.equal(granted.ok, true, granted.reason);
  const used = await send(app, 'treasure.Use', { villageId, code: 'dice_tournament_ticket', location: 'town' });
  assert.equal(used.ok, true, used.reason);
  const dialogue = (used.payload as any).dialogue;
  assert.equal(dialogue.code, 'dice_tournament_ticket_use');
  assert.equal(dialogue.taskCode, 't2');
  assert.equal(dialogue.trigger, 'use');
  assert.equal(dialogue.npcText, '入场券已生效。');
});
