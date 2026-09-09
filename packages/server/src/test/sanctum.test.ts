import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandResult } from '@slg/shared';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import { SanctumModule } from '../modules/sanctum.js';

function ok(payload: Record<string, unknown> = {}): CommandResult { return { ok: true, payload }; }

function fixture() {
  let now = 1_000_000;
  const store = new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => now, true);
  const advances: Array<{ villageId: string; code: string; progress: number; ready: boolean }> = [];
  let relicGrants = 0;
  let treasureListCalls = 0;
  const config = {
    constants: {
      raw: {
        sanctum_conditions_required: 1,
        sanctum_first_hold_sec: 1,
        sanctum_defense_mult: 0.5,
        sanctum_phase2_ranged_atk_mult: 0.4,
      },
    },
    sanctumEvents: {
      farstring_sanctum: {
        code: 'farstring_sanctum', name: '远弦圣地', enabled: true,
        fragmentTreasureCode: 'sanctum_fragment', sanctuaryTemplateCode: 'sanctum_sanctuary', description: '',
      },
    },
    sanctumConditions: {
      c02: {
        id: 2, code: 'c02', name: '残碑释读', category: 'low', completionMode: 'global_once', instances: 1,
        refreshSec: 0, kind: 'puzzle', params: '', puzzleCode: 'sanctum_simple_rune', minPlayers: 1,
        minPlayerPop: 1, minContributionShare: 0, personalCooldownSec: 0, pairCooldownSec: 0,
        rewardGroup: 'c02', clueGroup: 'c02', description: '破解符文',
      },
    },
    sanctumConditionRewards: {
      c02: [
        { id: 'reward-gold', conditionCode: 'c02', kind: 'grant_resources', params: 'gold:200', recipient: 'participant', order: 1 },
      ],
    },
    sanctumPuzzles: {
      sanctum_simple_rune: {
        code: 'sanctum_simple_rune', name: '三符文', conditionCode: 'c02', unitRequirement: 'scout_or_adventurer',
        minUnits: 1, allowedSymbols: ['月影', '狼牙', '潮汐'], wrongCooldownSec: 0, description: '按碑文排列',
      },
    },
    sanctumPuzzleSteps: {
      sanctum_simple_rune: [
        { id: 'step-1', puzzleCode: 'sanctum_simple_rune', step: 1, answer: '月影', clueText: '' },
        { id: 'step-2', puzzleCode: 'sanctum_simple_rune', step: 2, answer: '狼牙', clueText: '' },
        { id: 'step-3', puzzleCode: 'sanctum_simple_rune', step: 3, answer: '潮汐', clueText: '' },
      ],
    },
    sanctumClues: {
      c02: [{ id: 'clue-c02', conditionCode: 'c02', order: 1, template: '圣地在{direction}方。', precision: 'direction', weight: 1 }],
    },
  } as unknown as GameConfig;

  commands.register('task.GetState', () => ok({ active: [{ code: 's23' }] }));
  commands.register('player.GetByVillage', (cmd) => {
    const villageId = String((cmd.payload as { villageId?: string }).villageId ?? '');
    const playerId = villageId === 'v1' ? 'p1' : villageId === 'v2' ? 'p2' : '';
    return playerId ? ok({ player: { id: playerId } }) : { ok: false, payload: {}, reason: 'owner_not_found' };
  });
  commands.register('player.ListAll', () => ok({ players: [{ id: 'p1', villages: [{ id: 'v1', q: 1, r: 1 }] }, { id: 'p2', villages: [{ id: 'v2', q: 2, r: 2 }] }] }));
  commands.register('task.AdvanceExternal', (cmd) => {
    const payload = cmd.payload as { villageId: string; code: string; progress: number; ready: boolean };
    advances.push(payload);
    return ok();
  });
  commands.register('treasure.List', () => { treasureListCalls++; return ok({ codes: ['sanctum_fragment'] }); });
  commands.register('treasure.Grant', () => { relicGrants += 1; return ok({ pending: false }); });
  commands.register('economy.Grant', () => ok());
  commands.register('economy.TrySpend', () => ok());
  commands.register('reputation.Adjust', () => ok());
  commands.register('research.GrantPoints', () => ok());
  commands.register('movement.ValidateSanctumPresence', () => ok());
  commands.register('movement.ValidateSanctumRelicCarrier', () => ok());

  const sanctum = new SanctumModule(store, bus, commands, scheduler, () => now, config);
  sanctum.init();
  const send = (name: string, payload: Record<string, unknown>, from = 'test') => commands.send({ name, from, payload });
  return {
    store, scheduler, advances, get relicGrants() { return relicGrants; },
    get treasureListCalls() { return treasureListCalls; },
    now: () => now, setNow: (next: number) => { now = next; }, send,
  };
}

test('远弦圣地：未唤醒时只返回阶段壳，不查询宝物或计算公共条件', async () => {
  const f = fixture();
  const dormant = await f.send('sanctum.GetState', { playerId: 'p1', villageId: 'v1' });
  assert.equal(dormant.ok, true, dormant.reason);
  assert.equal((dormant.payload as any).event.phase, 'dormant');
  assert.deepEqual((dormant.payload as any).publicTargets, []);
  assert.equal((dormant.payload as any).sanctum, undefined);
  assert.equal(f.treasureListCalls, 0, '未唤醒的 GetState 不得跨 owner 查询宝物');
  const publicTargets = await f.send('sanctum.GetPublicTargets', { playerId: 'p1' });
  assert.deepEqual((publicTargets.payload as any).targets, [], '未唤醒时不得暴露尚未生成的公共目标');

  const joined = await f.send('sanctum.RegisterParticipant', { playerId: 'p1' }, 'task');
  assert.equal(joined.ok, true, joined.reason);
  const awaiting = await f.send('sanctum.GetState', { playerId: 'p1', villageId: 'v1' });
  assert.equal((awaiting.payload as any).event.phase, 'awaiting_activation');
  assert.equal((awaiting.payload as any).player.activationPending, true);
  assert.equal(f.treasureListCalls, 0, '等待唤醒阶段也不得实时轮询宝物');
});

test('远弦圣地：并发唤醒只产生一名先发者，且不泄露未发现的圣地', async () => {
  const f = fixture();
  const [one, two] = await Promise.all([
    f.send('sanctum.Activate', { playerId: 'p1', villageId: 'v1' }),
    f.send('sanctum.Activate', { playerId: 'p2', villageId: 'v2' }),
  ]);
  assert.equal(one.ok, true, one.reason);
  assert.equal(two.ok, true, two.reason);
  assert.equal([one, two].filter((result) => (result.payload as { activated?: boolean }).activated === true).length, 1);
  const state = f.store.get<any>('sanctum', 'current');
  assert.equal(state.phase, 'active');
  assert.ok(['p1', 'p2'].includes(state.pioneerPlayerId));
  const projected = await f.send('sanctum.GetState', { playerId: 'p1', villageId: 'v1' });
  assert.equal(projected.ok, true);
  assert.equal((projected.payload as any).sanctum, undefined, '未实际调查前不得下发圣地精确坐标');
});

test('远弦圣地：正确符文计数、守卫到期、圣物回村均只结算一次', async () => {
  const f = fixture();
  const activated = await f.send('sanctum.Activate', { playerId: 'p1', villageId: 'v1' });
  assert.equal(activated.ok, true, activated.reason);
  const targetId = 'farstring_sanctum:c02:1';
  assert.equal((await f.send('sanctum.BeginCondition', { playerId: 'p1', targetId })).ok, true);
  const solved = await f.send('sanctum.SubmitRune', { playerId: 'p1', villageId: 'v1', targetId, answer: ['月影', '狼牙', '潮汐'] });
  assert.equal(solved.ok, true, solved.reason);
  assert.equal((solved.payload as any).qualified, true);
  assert.equal((await f.send('sanctum.SetSiteLocation', { q: 9, r: 13 }, 'world')).ok, true);
  assert.equal((await f.send('sanctum.Discover', { playerId: 'p1', villageId: 'v1', movementId: 'm1' })).ok, true);
  // 只有清除门扉守卫、并交付 s26 的明确说明对话后才可占领；测试直接写入
  // 这两个已由各自 owner 认证的前置状态，专注验证守卫与唯一圣物的幂等性。
  const ready = f.store.get<any>('sanctum', 'current');
  ready.site.pveClearedAt = f.now();
  ready.players.p1.siteDialogueAt = f.now();
  f.store.set('sanctum', 'current', ready);
  assert.equal((await f.send('sanctum.Claim', { playerId: 'p1', villageId: 'v1', movementId: 'm1' })).ok, true);
  await f.scheduler.advanceTo(f.now() + 1_000, f.setNow);
  const taken = await f.send('sanctum.TakeRelic', { playerId: 'p1', villageId: 'v1', movementId: 'm1', returnVillageId: 'v1' });
  assert.equal(taken.ok, true, taken.reason);
  const firstReturn = await f.send('sanctum.OnMovementReturned', { playerId: 'p1', villageId: 'v1', movementId: 'm1' }, 'movement');
  const secondReturn = await f.send('sanctum.OnMovementReturned', { playerId: 'p1', villageId: 'v1', movementId: 'm1' }, 'movement');
  assert.equal(firstReturn.ok, true, firstReturn.reason);
  assert.equal(secondReturn.ok, true, secondReturn.reason);
  assert.equal(f.relicGrants, 1, '重复返程回调不得复制唯一圣物');
  assert.equal(f.store.get<any>('sanctum', 'current').phase, 'ended');
  assert.ok(f.advances.some((entry) => entry.code === 's24' && entry.ready));
  assert.ok(f.advances.some((entry) => entry.code === 's29' && entry.ready));
});
