import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

let clock = Date.UTC(2026, 8, 17, 4, 0, 0);
const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any, from = 'test') =>
  app.commands.send({ name, from, payload });

async function boot() {
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  const result = await send(app, 'aiPlayer.Bootstrap', {}, 'test');
  assert.equal(result.ok, true, result.reason);
  return app;
}

async function activateNearHuman(app: ReturnType<typeof createGameApp>, persona: 'raider' | 'merchant' = 'raider') {
  const state = app.store.all<any>('ai_player').find((entry) => entry.persona === persona)!;
  state.warmupUntil = clock - 1;
  state.lifecycle = 'active';
  state.cooldowns = {};
  app.store.set('ai_player', state.playerId, state);
  const aiPlayer = app.store.get<any>('player', state.playerId)!;
  const humanResult = await send(app, 'player.Register', { name: persona === 'raider' ? '真人甲' : '真人乙', password: 'pass1', tribe: 'romans' });
  assert.equal(humanResult.ok, true, humanResult.reason);
  const human = (humanResult.payload as any).player;
  const free = await send(app, 'world.FindFreeTile', { centerQ: aiPlayer.q, centerR: aiPlayer.r, radius: 1, salt: `ai-test-${persona}` });
  assert.equal(free.ok, true, free.reason);
  const { q, r } = free.payload as any;
  const moved = await send(app, 'world.MoveVillage', { refId: human.villageId, q, r });
  assert.equal(moved.ok, true, moved.reason);
  const rawHuman = app.store.get<any>('player', human.id)!;
  rawHuman.q = q; rawHuman.r = r; rawHuman.createdAt = clock;
  rawHuman.ownedVillages = rawHuman.ownedVillages.map((v: any) => v.id === human.villageId ? { ...v, q, r } : v);
  app.store.set('player', human.id, rawHuman);
  return { state, human: rawHuman, q, r };
}

async function thinkCandidates(app: ReturnType<typeof createGameApp>, playerId: string) {
  await send(app, 'aiPlayer.Think', { playerId }, 'test');
  const debug = await send(app, 'aiPlayer.GetDebug', { playerId }, 'test');
  assert.equal(debug.ok, true);
  return (debug.payload as any).state.lastDecision.candidates as Array<{ kind: string; score: number }>;
}

async function buildTradeCenter(app: ReturnType<typeof createGameApp>, villageId: string) {
  const built = await send(app, 'building.Build', { villageId, zone: 'outer', kind: 'tradecenter' });
  assert.equal(built.ok, true, built.reason);
  await app.scheduler.advanceTo(Number((built.payload as any).finishAt), (value) => { clock = value; });
}

test('AI roster：固定创建16个不可登录托管账号，公开玩家快照不泄漏控制字段', async () => {
  const app = await boot();
  const states = app.store.all<any>('ai_player');
  assert.equal(states.length, 16);
  assert.deepEqual(new Set(states.map((state) => state.persona)), new Set(['pioneer', 'merchant', 'raider', 'cooperator']));
  for (const state of states) {
    assert.ok(state.warmupUntil - state.createdAt >= 48 * 3_600_000);
    assert.ok(state.warmupUntil - state.createdAt <= 72 * 3_600_000);
    const player = (await send(app, 'player.Get', { playerId: state.playerId })).payload as any;
    assert.equal('controller' in player.player, false);
    assert.equal('managedBy' in player.player, false);
  }
  const login = await send(app, 'player.Login', { name: app.config.aiRoster[0].name, password: 'anything' });
  assert.equal(login.ok, false);
  assert.equal(login.reason, 'managed_account');
});

test('reset语义：season保留托管账号并重建AI状态，wipe全清且重启按固定roster补齐', async () => {
  const app = await boot();
  const managedIds = app.store.all<any>('ai_player').map((state) => state.playerId).sort();

  await app.resetWorld({ keepAccounts: true, reassignSpots: false });
  assert.deepEqual(app.store.all<any>('ai_player').map((state) => state.playerId).sort(), managedIds);
  assert.equal(app.store.all<any>('player').filter((player) => player.controller === 'ai').length, 16);

  await app.resetWorld({ keepAccounts: false });
  assert.equal(app.store.all<any>('ai_player').length, 0);
  assert.equal(app.store.all<any>('ai_global').length, 0);
  assert.equal(app.store.all<any>('player').length, 0);

  const restarted = await send(app, 'aiPlayer.Bootstrap', {}, 'app');
  assert.equal(restarted.ok, true, restarted.reason);
  assert.equal(app.store.all<any>('ai_player').length, 16, '生产重启会按固定 roster 补回托管账号');
  assert.equal(app.store.all<any>('player').filter((player) => player.controller === 'ai').length, 16);
});

test('AI合法感知：控制器只走安全地图聚合，不调用全量玩家/PvE/世界目录', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player')[0];
  const called: string[] = [];
  const original = app.commands.send.bind(app.commands);
  (app.commands as any).send = async (command: any) => {
    if (command.from === 'ai-player') called.push(command.name);
    return original(command);
  };
  const result = await send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  assert.equal(result.ok, true, result.reason);
  assert.ok(called.includes('vision.GetPlayerMapSnapshot'));
  for (const forbidden of ['player.ListAll', 'pve.ListTargets', 'world.GetArea', 'world.GetTile', 'world.GetTileByRef']) {
    assert.equal(called.includes(forbidden), false, `AI 不得调用 ${forbidden}`);
  }
});

test('行为树：单次 tick 最多提交一个主要写动作，候选与路径落盘供 GM 调试', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player')[0];
  const writes = new Set([
    'building.Build', 'building.Upgrade', 'military.TrainTroops', 'research.StartResearch',
    'movement.SendRaid', 'movement.SendScout', 'movement.SendVillageRaid',
    'trade.CreateOrder', 'trade.AcceptPlayer', 'trade.CancelOrder', 'alliance.Apply',
  ]);
  let count = 0;
  const original = app.commands.send.bind(app.commands);
  (app.commands as any).send = async (command: any) => {
    if (command.from === 'ai-player' && writes.has(command.name)) count++;
    return original(command);
  };
  await send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  assert.ok(count <= 1, `单 tick 主要写动作=${count}`);
  const debug = await send(app, 'aiPlayer.GetDebug', { playerId: state.playerId }, 'test');
  assert.equal(debug.ok, true);
  assert.ok((debug.payload as any).state.lastDecision);
  assert.ok(Array.isArray((debug.payload as any).state.recentActions));
});

test('并发思考：同一AI严格互斥，延迟写Command期间第二次Think不得重复提交', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player').find((entry) => entry.persona === 'pioneer')!;
  state.warmupUntil = clock - 1;
  state.lifecycle = 'active';
  state.primaryGoal = 'build';
  state.goalUntil = clock + 3_600_000;
  state.recentActions = [];
  app.store.set('ai_player', state.playerId, state);
  const before = (await send(app, 'building.GetLayout', { villageId: state.villageId })).payload as any;

  const writes = new Set(['building.Build', 'building.Upgrade', 'military.TrainTroops', 'research.StartResearch']);
  let writeCount = 0;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const original = app.commands.send.bind(app.commands);
  (app.commands as any).send = async (command: any) => {
    if (command.from === 'ai-player' && writes.has(command.name)) {
      writeCount++;
      enteredResolve();
      await release;
    }
    return original(command);
  };

  const first = send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  await entered;
  const second = send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  releaseResolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true, firstResult.reason);
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.reason, 'already_thinking');
  assert.equal(writeCount, 1);

  const after = (await send(app, 'building.GetLayout', { villageId: state.villageId })).payload as any;
  assert.equal(after.queue.items.length, before.queue.items.length + 1);
  const persisted = app.store.get<any>('ai_player', state.playerId)!;
  assert.equal(persisted.actionsToday, 1);
  assert.equal(persisted.recentActions.length, 1);
  assert.equal(persisted.recentActions[0].ok, true);
});

test('效用选择：首次tick的空近期行为不得触发连续同类惩罚', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player').find((entry) => entry.persona === 'pioneer')!;
  state.recentActions = [];
  state.primaryGoal = 'idle';
  state.goalUntil = 0;
  app.store.set('ai_player', state.playerId, state);
  const candidates = await thinkCandidates(app, state.playerId);
  const development = candidates.filter((candidate) => candidate.kind === 'build' || candidate.kind === 'upgrade');
  assert.ok(development.length > 0);
  assert.ok(Math.max(...development.map((candidate) => candidate.score)) > 50, '首次发展候选不应被空数组 every() 误扣25分');
});

test('E2E经济行为：Think 通过现有 owner 真正提交一次发展动作', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player').find((entry) => entry.persona === 'pioneer')!;
  state.warmupUntil = clock - 1;
  state.lifecycle = 'active';
  state.primaryGoal = 'build';
  state.goalUntil = clock + 3_600_000;
  app.store.set('ai_player', state.playerId, state);
  const before = (await send(app, 'building.GetLayout', { villageId: state.villageId })).payload as any;
  const beforeQueue = before.queue.items.length;
  const result = await send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  assert.equal(result.ok, true, result.reason);
  assert.ok(['build', 'upgrade', 'train', 'research'].includes((result.payload as any).action), `实际动作=${(result.payload as any).action}`);
  const after = (await send(app, 'building.GetLayout', { villageId: state.villageId })).payload as any;
  assert.ok(after.queue.items.length > beforeQueue || app.store.all<any>('military').some((army) => army.villageId === state.villageId && army.training), '权威 owner 应留下真实写入');
});

test('E2E PvE/侦察准入：只从真实可见地图产生候选', async () => {
  const app = await boot();
  const { state, q, r } = await activateNearHuman(app, 'raider');
  await send(app, 'military.AdjustTroops', { villageId: state.villageId, delta: { legionnaire: 10, equlegati: 1 } });
  const aiPlayer = app.store.get<any>('player', state.playerId)!;
  const free = await send(app, 'world.FindFreeTile', { centerQ: aiPlayer.q, centerR: aiPlayer.r, radius: 1, salt: `ai-pve-${q}-${r}` });
  assert.equal(free.ok, true, free.reason);
  const pve = await send(app, 'pve.Spawn', { id: `ai-pve-${clock}`, type: 'rats', ...(free.payload as any), noRespawn: true });
  assert.equal(pve.ok, true, pve.reason);
  const candidates = await thinkCandidates(app, state.playerId);
  assert.ok(candidates.some((candidate) => candidate.kind === 'pve'), '可见 PvE 应进入候选');
  assert.ok(candidates.some((candidate) => candidate.kind === 'scout'), '可见真人村庄与侦察兵应进入候选');
});

test('E2E raid 三道门槛：账号年龄、公开规模与12小时合法情报缺一不可', async () => {
  const app = await boot();
  const { state, human } = await activateNearHuman(app, 'raider');
  state.cooldowns.pve = clock + 24 * 3_600_000;
  app.store.set('ai_player', state.playerId, state);
  await send(app, 'military.AdjustTroops', { villageId: state.villageId, delta: { legionnaire: 12 } });

  let candidates = await thinkCandidates(app, state.playerId);
  assert.equal(candidates.some((candidate) => candidate.kind === 'raid'), false, '无情报不得 raid');

  await app.bus.emit({ name: 'movement.ScoutReport', source: 'movement', ts: clock, payload: {
    villageId: state.villageId, side: 'attacker', context: 'village_scout', targetKind: 'village',
    targetVillage: human.villageId, outcome: 'attacker_survived',
  } });
  candidates = await thinkCandidates(app, state.playerId);
  assert.equal(candidates.some((candidate) => candidate.kind === 'raid'), false, '未满72小时真人不得 raid');

  const rawHuman = app.store.get<any>('player', human.id)!;
  rawHuman.createdAt = clock - 73 * 3_600_000;
  app.store.set('player', human.id, rawHuman);
  candidates = await thinkCandidates(app, state.playerId);
  assert.ok(candidates.some((candidate) => candidate.kind === 'raid'), '三道门槛全部满足后应进入 raid 候选');
  assert.ok(app.store.all<any>('movement').some((movement) => movement.fromVillage === state.villageId && movement.targetVillage === human.villageId), '通过准入后应由真实 Movement owner 创建 raid 行军');
});

test('E2E raid：过期情报与公开人口规模比越界均不得进入候选', async () => {
  const app = await boot();
  const { state, human } = await activateNearHuman(app, 'raider');
  state.cooldowns.pve = clock + 24 * 3_600_000;
  app.store.set('ai_player', state.playerId, state);
  await send(app, 'military.AdjustTroops', { villageId: state.villageId, delta: { legionnaire: 12 } });
  const rawHuman = app.store.get<any>('player', human.id)!;
  rawHuman.createdAt = clock - 73 * 3_600_000;
  app.store.set('player', human.id, rawHuman);
  state.intelByVillage[human.villageId] = { observedAt: clock - 12 * 3_600_000 - 1, source: 'scout' };
  app.store.set('ai_player', state.playerId, state);
  let candidates = await thinkCandidates(app, state.playerId);
  assert.equal(candidates.some((candidate) => candidate.kind === 'raid'), false, '过期情报不得 raid');

  state.intelByVillage[human.villageId] = { observedAt: clock, source: 'scout' };
  app.store.set('ai_player', state.playerId, state);
  candidates = await thinkCandidates(app, state.playerId);
  assert.ok(candidates.some((candidate) => candidate.kind === 'raid'), '新鲜合法情报且规模匹配时应进入 raid 候选');
  const refreshedState = app.store.get<any>('ai_player', state.playerId)!;
  refreshedState.cooldowns.raid = 0;
  app.store.set('ai_player', state.playerId, refreshedState);
  await send(app, 'military.AdjustTroops', { villageId: state.villageId, delta: { legionnaire: 12 } });
  const population = app.store.get<any>('population', human.villageId)!;
  population.currentPop = Math.max(1, Number(population.currentPop)) * 3;
  app.store.set('population', human.villageId, population);
  candidates = await thinkCandidates(app, state.playerId);
  assert.equal(candidates.some((candidate) => candidate.kind === 'raid'), false, '公开规模比超出0.7~1.3不得 raid');
});

test('E2E贸易：首次观察后确定性等待10~90分钟，成交后同真人冷却6小时', async () => {
  const app = await boot();
  const { state, human } = await activateNearHuman(app, 'merchant');
  await buildTradeCenter(app, state.villageId);
  await buildTradeCenter(app, human.villageId);
  const created = await send(app, 'trade.CreateOrder', { villageId: human.villageId, give: { wood: 100 }, want: { clay: 100 } });
  assert.equal(created.ok, true, created.reason);

  let candidates = await thinkCandidates(app, state.playerId);
  assert.equal(candidates.some((candidate) => candidate.kind === 'trade_accept'), false, '首次观察不得立即接受');
  let after = app.store.get<any>('ai_player', state.playerId)!;
  const observation = Object.values(after.tradeObservations)[0] as any;
  assert.ok(observation.acceptAfter - observation.firstSeenAt >= 10 * 60_000);
  assert.ok(observation.acceptAfter - observation.firstSeenAt <= 90 * 60_000);
  clock = observation.acceptAfter + 1;
  after.primaryGoal = 'trade_accept'; after.goalUntil = clock + 60_000; after.cooldowns.trade_accept = 0;
  app.store.set('ai_player', state.playerId, after);
  candidates = await thinkCandidates(app, state.playerId);
  assert.ok(candidates.some((candidate) => candidate.kind === 'trade_accept'), '延迟到期后应允许接受');
  after = app.store.get<any>('ai_player', state.playerId)!;
  assert.ok(after.tradePartnerCooldowns[human.id] >= clock + 6 * 3_600_000, '真实成交后写入6小时伙伴冷却');
});

test('崩溃恢复：prepared pendingIntent 不重放，nextThinkAt 可重新登记', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player')[0];
  state.pendingIntent = { id: 'old-intent', kind: 'train', preparedAt: clock - 1000, payload: { villageId: state.villageId, unit: 'legionnaire', count: 9 } };
  state.nextThinkAt = clock;
  app.store.set('ai_player', state.playerId, state);
  const result = await send(app, 'aiPlayer.Think', { playerId: state.playerId }, 'test');
  assert.equal(result.ok, true, result.reason);
  const after = app.store.get<any>('ai_player', state.playerId)!;
  assert.equal(after.pendingIntent, undefined);
  assert.ok(after.recentActions.some((entry: any) => entry.reason === 'uncertain_intent_not_retried'));
  assert.ok(after.nextThinkAt > clock);
});

test('战损恢复：进攻损失达到30%后进入至少72小时恢复期', async () => {
  const app = await boot();
  const state = app.store.all<any>('ai_player')[0];
  (app.aiPlayer as any).onBattleEnded({
    villageId: state.villageId, side: 'attacker',
    deployedTroops: { infantry: 10 }, survivors: { infantry: 6 },
  });
  const after = app.store.get<any>('ai_player', state.playerId)!;
  assert.equal(after.lifecycle, 'recovering');
  assert.equal(after.recoveryUntil, clock + 72 * 3_600_000);
  assert.equal(after.primaryGoal, 'train');
});

test('联盟职位：AI可作为普通成员但服务端拒绝任何职位', async () => {
  const app = await boot();
  const human = (await send(app, 'player.Register', { name: '真人盟主', password: 'pass1', tribe: 'romans' })).payload as any;
  const ai = app.store.all<any>('ai_player')[0];
  app.store.set('alliance', 'ai-role-test', {
    id: 'ai-role-test', name: '真人联盟', leaderId: human.player.id, leaderName: human.player.name,
    memberIds: [human.player.id, ai.playerId], roles: { [human.player.id]: [], [ai.playerId]: [] },
    hallVillageId: human.player.villageId, level: 1, disconnected: false, joinRequests: {},
    warehouse: { wood: 0, clay: 0, iron: 0, crop: 0 }, resourceContributions: {}, techPointStock: 0,
    techContributions: {}, buildings: {}, technologies: {}, warPlans: {},
  });
  app.store.set('alliance_by_player', human.player.id, 'ai-role-test');
  app.store.set('alliance_by_player', ai.playerId, 'ai-role-test');
  const assigned = await send(app, 'alliance.SetRole', { playerId: human.player.id, targetPlayerId: ai.playerId, role: 'logistics' });
  assert.equal(assigned.ok, false);
  assert.equal(assigned.reason, 'managed_player_cannot_hold_role');
});

test('恢复调度：生产模式按持久 nextThinkAt 为每个AI登记唯一任务', async () => {
  const app = createGameApp({ now: () => clock });
  app.setupWorld();
  await app.aiPlayer.resume();
  assert.equal(app.store.all('ai_player').length, 16);
  assert.ok(app.scheduler.pending >= 16);
  for (const state of app.store.all<any>('ai_player')) {
    await send(app, 'aiPlayer.SetEnabled', { playerId: state.playerId, enabled: false }, 'test');
  }
});

test('PvP频控：同一真人12小时仅一次、72小时最多两次，预约阻止并发AI', async () => {
  const app = await boot();
  const [a, b] = app.store.all<any>('ai_player');
  const owner = app.aiPlayer as any;
  const arrival1 = clock + 2 * 3_600_000;
  assert.equal(owner.canReserveVictim(a, 'human-1', arrival1), true);
  assert.equal(owner.reserveVictim(a, 'human-1', arrival1), true);
  assert.equal(owner.canReserveVictim(b, 'human-1', arrival1 + 20 * 3_600_000), false, '并发预约应互斥');
  owner.finishVictimReservation(a, 'human-1', false, arrival1);
  assert.equal(owner.canReserveVictim(b, 'human-1', arrival1 + 60_000), true, '失败应释放且不记命中');
  assert.equal(owner.reserveVictim(b, 'human-1', arrival1), true);
  owner.finishVictimReservation(b, 'human-1', true, arrival1);
  assert.equal(owner.canReserveVictim(a, 'human-1', arrival1 + 11 * 3_600_000), false, '按未来预计到达时间计算12小时窗口');
  const arrival2 = arrival1 + 13 * 3_600_000;
  assert.equal(owner.canReserveVictim(a, 'human-1', arrival2), true);
  assert.equal(owner.reserveVictim(a, 'human-1', arrival2), true);
  owner.finishVictimReservation(a, 'human-1', true, arrival2);
  assert.equal(owner.canReserveVictim(b, 'human-1', arrival2 + 13 * 3_600_000), false, '预计到达点附近72小时已有两次命中应拒绝');
  const global = app.store.get<any>('ai_global', 'global');
  assert.deepEqual(global.victimHits['human-1'], [arrival1, arrival2], '命中必须记录预计抵达而非派出时刻');
});
