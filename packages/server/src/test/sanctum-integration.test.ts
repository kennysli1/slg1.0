import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandResult } from '@slg/shared';
import { MODULE_MANIFESTS } from '../gateway/routes.js';
import { validatePayload } from '../gateway/validate.js';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import { SanctumModule } from '../modules/sanctum.js';

function ok(payload: Record<string, unknown> = {}): CommandResult { return { ok: true, payload }; }

type ConditionInput = {
  code: string;
  completionMode: 'global_once' | 'personal_repeat';
  refreshSec?: number;
  personalCooldownSec?: number;
};

/**
 * 事件模块的黑盒夹具：只伪造相邻 owner 的 Command 合同，所有活动状态变化仍由
 * SanctumModule 自身执行。这使测试能锁住公开投影、条件移除和冷却的回归边界。
 */
function fixture(conditions: ConditionInput[]) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => now, true);
  const fragments = new Set<string>(['v1']);
  const players = {
    v1: { id: 'p1', villages: [{ id: 'v1', q: 4, r: 5 }] },
    v2: { id: 'p2', villages: [{ id: 'v2', q: 8, r: 9 }] },
  } as const;
  let pointSequence = 0;
  let movementStatus: { stillStationed: boolean; pos: { q: number; r: number } } = {
    stillStationed: true,
    pos: { q: 0, r: 0 },
  };

  const config = {
    constants: {
      worldW: 1_000,
      worldH: 1_000,
      raw: {
        sanctum_conditions_required: 99,
        sanctum_first_hold_sec: 60,
        sanctum_defense_mult: 0.5,
        sanctum_phase2_ranged_atk_mult: 0.4,
      },
    },
    sanctumEvents: {
      farstring_sanctum: {
        code: 'farstring_sanctum',
        name: '远弦圣地',
        enabled: true,
        fragmentTreasureCode: 'sanctum_fragment',
        relicCode: 'farstring_crest',
        sanctuaryTemplateCode: 'sanctum_sanctuary',
        // 有意使用不可能与测试公共目标混淆的坐标，断言投影不泄露该值。
        sanctuaryQ: 911,
        sanctuaryR: 922,
      },
    },
    sanctumConditions: Object.fromEntries(conditions.map((condition, index) => [condition.code, {
      id: index + 1,
      code: condition.code,
      name: `条件 ${condition.code}`,
      category: condition.completionMode === 'personal_repeat' ? 'repeatable' : 'low',
      completionMode: condition.completionMode,
      instances: 1,
      refreshSec: condition.refreshSec ?? 0,
      kind: 'investigate',
      params: 'holdSec:1',
      minPlayers: 1,
      minPlayerPop: 0,
      minContributionShare: 0,
      personalCooldownSec: condition.personalCooldownSec ?? 0,
      pairCooldownSec: 0,
      rewardGroup: condition.code,
      clueGroup: condition.code,
      description: `完成 ${condition.code}`,
    }])),
    sanctumConditionRewards: Object.fromEntries(conditions.map((condition) => [condition.code, [
      { id: `${condition.code}:reward`, conditionCode: condition.code, kind: 'grant_resources', params: 'gold:1', recipient: 'participant', order: 1 },
    ]])),
    sanctumClues: Object.fromEntries(conditions.map((condition) => [condition.code, [
      { id: `${condition.code}:clue`, conditionCode: condition.code, order: 1, template: '圣地位于{direction}方。', precision: 'direction', weight: 1 },
    ]])),
  } as unknown as GameConfig;

  commands.register('player.GetByVillage', (cmd) => {
    const villageId = String((cmd.payload as { villageId?: unknown }).villageId ?? '');
    const player = players[villageId as keyof typeof players];
    return player ? ok({ player }) : { ok: false, payload: {}, reason: 'owner_not_found' };
  });
  commands.register('player.ListAll', () => ok({ players: Object.values(players) }));
  commands.register('task.GetState', () => ok({ active: [{ code: 's23' }] }));
  commands.register('task.AdvanceExternal', () => ok());
  commands.register('task.RefreshExternalOffers', () => ok());
  commands.register('treasure.List', (cmd) => {
    const villageId = String((cmd.payload as { villageId?: unknown }).villageId ?? '');
    return ok({ codes: fragments.has(villageId) ? ['sanctum_fragment'] : [] });
  });
  commands.register('treasure.ConsumeEventToken', () => { fragments.clear(); return ok(); });
  commands.register('economy.Grant', () => ok());
  commands.register('economy.TrySpend', () => ok());
  commands.register('reputation.Adjust', () => ok());
  commands.register('research.GrantPoints', () => ok());
  commands.register('treasure.Grant', () => ok());
  commands.register('world.FindFreeTile', () => {
    pointSequence += 1;
    return ok({ q: pointSequence, r: pointSequence + 1 });
  });
  commands.register('world.GetTileByRef', (cmd) => {
    const villageId = String((cmd.payload as { refId?: unknown }).refId ?? '');
    const village = players[villageId as keyof typeof players]?.villages[0];
    return village ? ok({ tile: village }) : { ok: false, payload: {}, reason: 'not_found' };
  });
  commands.register('world.Distance', () => ok({ distance: 20 }));
  commands.register('vision.GetVisibility', () => ok({ visibility: 'hidden' }));
  commands.register('pve.GetTarget', () => ({ ok: false, payload: {}, reason: 'not_found' }));
  commands.register('pve.Spawn', () => ok());
  commands.register('pve.Remove', () => ok());
  commands.register('movement.GetSanctumDefenderStatus', () => ok({ ...movementStatus, pos: { ...movementStatus.pos } }));

  const sanctum = new SanctumModule(store, bus, commands, scheduler, () => now, config);
  sanctum.init();
  return {
    store,
    bus,
    scheduler,
    now: () => now,
    setNow: (next: number) => { now = next; },
    setMovementStatus: (stillStationed: boolean, pos: { q: number; r: number }) => { movementStatus = { stillStationed, pos }; },
    send: (name: string, payload: Record<string, unknown>, from = 'test') => commands.send({ name, from, payload }),
    activate: () => commands.send({ name: 'sanctum.Activate', from: 'test', payload: { playerId: 'p1', villageId: 'v1' } }),
  };
}

test('远弦圣地 Gateway manifest：仅公开安全动作，并对每个 payload 保持鉴权、注入与 schema 边界', () => {
  const manifest = MODULE_MANIFESTS.find((entry) => entry.moduleName === 'sanctum');
  assert.ok(manifest, '必须由 Gateway manifest 显式登记 sanctum，而不是放行内部 Command');
  const actions = manifest!.publicActions;
  assert.deepEqual(Object.keys(actions).sort(), [
    'sanctum.Activate', 'sanctum.BeginCondition', 'sanctum.Claim', 'sanctum.Contribute',
    'sanctum.Discover', 'sanctum.GetState', 'sanctum.SubmitRune', 'sanctum.TakeRelic',
  ]);
  assert.deepEqual(manifest!.eventPushMap, { 'sanctum.Updated': 'SanctumUpdated' });

  for (const route of Object.values(actions)) {
    assert.equal(route.needAuth, true, `${route.command} 不得允许匿名调用`);
    assert.equal(route.injectPlayerId, true, `${route.command} 必须由 Gateway 注入玩家身份`);
  }
  for (const action of ['sanctum.Activate', 'sanctum.BeginCondition', 'sanctum.SubmitRune', 'sanctum.Discover']) {
    assert.equal(actions[action]?.ownVillage, true, `${action} 必须锁定当前会话村庄`);
  }
  for (const internalOnly of ['sanctum.Join', 'sanctum.CompleteCondition', 'sanctum.SetSiteLocation', 'sanctum.OnRelicLost']) {
    assert.equal(actions[internalOnly], undefined, `${internalOnly} 绝不能暴露到公网 Gateway`);
  }

  const getState = validatePayload({ playerId: 'forged', q: 911, r: 922 }, actions['sanctum.GetState']!.schema!);
  assert.equal(getState.ok, true);
  if (getState.ok) assert.deepEqual(getState.cleaned, {}, 'GetState 不接受客户端伪造身份/坐标');

  const beginSchema = actions['sanctum.BeginCondition']!.schema!;
  assert.equal(validatePayload({ conditionId: 'c01' }, beginSchema).ok, false, '轮次是条件操作的抗旧请求边界');
  const begin = validatePayload({ roundId: 'farstring_sanctum', conditionId: 'c01', playerId: 'forged' }, beginSchema);
  assert.equal(begin.ok, true);
  if (begin.ok) assert.deepEqual(begin.cleaned, { roundId: 'farstring_sanctum', conditionId: 'c01' });

  const runeSchema = actions['sanctum.SubmitRune']!.schema!;
  assert.equal(validatePayload({ roundId: 'r', conditionId: 'c02', answer: [] }, runeSchema).ok, false);
  assert.equal(validatePayload({ roundId: 'r', conditionId: 'c02', answer: new Array(13).fill('月影') }, runeSchema).ok, false);
  assert.equal(validatePayload({ roundId: 'r', conditionId: 'c02', answer: ['月影', '狼牙', '潮汐'] }, runeSchema).ok, true);

  const contributionSchema = actions['sanctum.Contribute']!.schema!;
  assert.equal(validatePayload({
    roundId: 'r', conditionId: 'c04', sourceVillageId: 'v1', resources: { wood: 1, clay: 1, iron: 1, crop: 1, gold: 1, illicit: 1 },
  }, contributionSchema).ok, false, '贡献资源键数必须受限');
  const contribution = validatePayload({
    roundId: 'r', conditionId: 'c04', sourceVillageId: 'v1', resources: { wood: 500 }, playerId: 'forged', villageId: 'other',
  }, contributionSchema);
  assert.equal(contribution.ok, true);
  if (contribution.ok) assert.deepEqual(contribution.cleaned, {
    roundId: 'r', conditionId: 'c04', sourceVillageId: 'v1', resources: { wood: 500 },
  });
});

test('远弦圣地投影：未发现者只看到公共条件，绝不收到隐藏圣地的坐标或 PvE 引用', async () => {
  const f = fixture([{ code: 'c_once', completionMode: 'global_once' }]);
  const activated = await f.activate();
  assert.equal(activated.ok, true, activated.reason);
  // 玩家 p2 已通过 s23 加入公共事件，但尚未取得资格或实际调查圣地。
  assert.equal((await f.send('sanctum.Join', { playerId: 'p2', villageId: 'v2' })).ok, true);

  const state = await f.send('sanctum.GetState', { playerId: 'p2', villageId: 'v2' });
  assert.equal(state.ok, true, state.reason);
  const payload = state.payload as { sanctum?: unknown; publicTargets?: unknown[]; player?: { hints?: unknown[] } };
  assert.equal(payload.sanctum, undefined, '没有完成发现前不得下发 sanctum 对象');
  assert.ok(Array.isArray(payload.publicTargets) && payload.publicTargets.length === 1, '公共条件仍可作为地图目标显示');
  assert.equal(JSON.stringify(payload).includes('911'), false, '隐藏圣地 q 不得混入任何公开字段或提示');
  assert.equal(JSON.stringify(payload).includes('922'), false, '隐藏圣地 r 不得混入任何公开字段或提示');
  assert.equal(JSON.stringify(payload).includes('sanctum-site:'), false, '隐藏圣地 PvE id 不得泄露');
});

test('远弦圣地：一次性公共条件结算后从状态投影与公共目标列表移除', async () => {
  const f = fixture([{ code: 'c_once', completionMode: 'global_once' }]);
  assert.equal((await f.activate()).ok, true);
  const targetId = 'farstring_sanctum:c_once:1';
  const before = await f.send('sanctum.GetPublicTargets', { playerId: 'p1' });
  assert.equal((before.payload as { targets: Array<{ id: string }> }).targets.some((target) => target.id === targetId), true);
  assert.equal((await f.send('sanctum.BeginCondition', { playerId: 'p1', conditionId: targetId })).ok, true);
  const completed = await f.send('sanctum.CompleteCondition', { playerId: 'p1', villageId: 'v1', targetId }, 'sanctum');
  assert.equal(completed.ok, true, completed.reason);

  const publicTargets = await f.send('sanctum.GetPublicTargets', { playerId: 'p1' });
  assert.equal((publicTargets.payload as { targets: Array<{ id: string }> }).targets.some((target) => target.id === targetId), false);
  const playerState = await f.send('sanctum.GetState', { playerId: 'p1', villageId: 'v1' });
  assert.equal((playerState.payload as { publicTargets: Array<{ id: string }> }).publicTargets.some((target) => target.id === targetId), false);
  assert.equal(f.store.get<any>('sanctum', 'current').targets[targetId].status, 'removed');
});

test('远弦圣地：可重复条件须分别等待公共刷新与个人冷却，结束后可再次开始', async () => {
  const f = fixture([{ code: 'c_repeat', completionMode: 'personal_repeat', refreshSec: 3, personalCooldownSec: 7 }]);
  assert.equal((await f.activate()).ok, true);
  assert.equal((await f.send('sanctum.Join', { playerId: 'p2', villageId: 'v2' })).ok, true);
  const targetId = 'farstring_sanctum:c_repeat:1';
  const completedAt = f.now();
  assert.equal((await f.send('sanctum.BeginCondition', { playerId: 'p1', conditionId: targetId })).ok, true);
  assert.equal((await f.send('sanctum.CompleteCondition', { playerId: 'p1', villageId: 'v1', targetId }, 'sanctum')).ok, true);

  const stored = f.store.get<any>('sanctum', 'current').targets[targetId];
  assert.equal(stored.cooldownUntil, completedAt + 3_000, '公共目标冷却必须取 refreshSec');
  assert.equal(stored.completedAtBy.p1 + 7_000, completedAt + 7_000, '个人冷却必须独立记录 personalCooldownSec');
  const publicBlocked = await f.send('sanctum.BeginCondition', { playerId: 'p2', conditionId: targetId });
  assert.equal(publicBlocked.ok, false);
  assert.equal(publicBlocked.reason, 'target_refreshing');

  f.setNow(completedAt + 3_000);
  assert.equal((await f.send('sanctum.BeginCondition', { playerId: 'p2', conditionId: targetId })).ok, true, '公共刷新结束后，另一位已加入玩家可开始');
  const personalBlocked = await f.send('sanctum.BeginCondition', { playerId: 'p1', conditionId: targetId });
  assert.equal(personalBlocked.ok, false);
  assert.equal(personalBlocked.reason, 'player_condition_cooldown');

  f.setNow(completedAt + 7_000);
  const restarted = await f.send('sanctum.BeginCondition', { playerId: 'p1', conditionId: targetId });
  assert.equal(restarted.ok, true, restarted.reason);
});

test('远弦圣地调查：驻留不足 holdSec 不结算，到期须由 Movement 确认原军队仍在原格', async () => {
  const f = fixture([{ code: 'c_hold', completionMode: 'global_once' }]);
  assert.equal((await f.activate()).ok, true);
  const targetId = 'farstring_sanctum:c_hold:1';
  const target = f.store.get<any>('sanctum', 'current').targets[targetId];
  assert.deepEqual(target.point, { q: 1, r: 2 }, '夹具的 World owner 为目标给出确定坐标');
  assert.equal((await f.send('sanctum.BeginCondition', { playerId: 'p1', conditionId: targetId })).ok, true);

  await f.bus.emit({
    name: 'movement.Garrisoned', source: 'movement', ts: f.now(),
    payload: { id: 'mv-hold-1', villageId: 'v1', q: target.point.q, r: target.point.r },
  });
  const dueAt = f.store.get<any>('sanctum', 'current').targets[targetId].investigations.p1.dueAt;
  await f.scheduler.advanceTo(dueAt - 1, f.setNow);
  assert.equal(f.store.get<any>('sanctum', 'current').players.p1.conditionRecords.length, 0, '客户端显示倒计时不能提前完成调查');

  // 即使 Movement 声称军队仍驻扎，只要已经换格，也必须清掉本轮驻留，不能结算。
  f.setMovementStatus(true, { q: target.point.q + 1, r: target.point.r });
  await f.scheduler.advanceTo(dueAt, f.setNow);
  let current = f.store.get<any>('sanctum', 'current');
  assert.equal(current.players.p1.conditionRecords.length, 0, '离开原格后到期不得完成');
  assert.equal(current.targets[targetId].investigations.p1, undefined, '失效驻留计时应清除，不能在后台继续累积');

  // 再次真实抵达后才允许重新计时；这次 Movement 认证原军队仍在原目标格才结算。
  f.setMovementStatus(true, target.point);
  await f.bus.emit({
    name: 'movement.Garrisoned', source: 'movement', ts: f.now(),
    payload: { id: 'mv-hold-2', villageId: 'v1', q: target.point.q, r: target.point.r },
  });
  current = f.store.get<any>('sanctum', 'current');
  const retryDueAt = current.targets[targetId].investigations.p1.dueAt;
  await f.scheduler.advanceTo(retryDueAt, f.setNow);
  current = f.store.get<any>('sanctum', 'current');
  assert.equal(current.players.p1.conditionRecords.length, 1, `原军队原格驻留满 holdSec 后才可完成: ${JSON.stringify({ target: current.targets[targetId], player: current.players.p1 })}`);
  assert.equal(current.targets[targetId].status, 'removed');
});
