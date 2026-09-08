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

type OfferMode = 'fragment' | 'active' | 'qualified' | 'discovered' | 'briefed' | 'occupied' | 'artifact';

/**
 * 只搭建 Sanctum 的公共资格边界：任务 owner 仍经 CanOffer 查询，测试不读取
 * 私有方法或替 Sanctum 改状态逻辑。其余领域命令均是无副作用 stub。
 */
function fixture() {
  let now = 5_000_000;
  const store = new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(() => now, true);
  const fragments = new Set<string>(['v2']);
  const players = {
    v1: { id: 'p1', villages: [{ id: 'v1', q: 1, r: 1 }] },
    v2: { id: 'p2', villages: [{ id: 'v2', q: 8, r: 8 }] },
  } as const;
  const config = {
    constants: {
      worldW: 32,
      worldH: 32,
      raw: {
        sanctum_conditions_required: 2,
        sanctum_first_hold_sec: 60,
        sanctum_defense_mult: 0.5,
        sanctum_phase2_ranged_atk_mult: 0.4,
      },
    },
    sanctumEvents: {
      farstring_sanctum: {
        code: 'farstring_sanctum', enabled: true,
        fragmentTreasureCode: 'sanctum_fragment', relicCode: 'farstring_crest',
        // 固定坐标让激活时无需依赖 world owner 的选址实现。
        sanctuaryQ: 21, sanctuaryR: 13,
      },
    },
  } as unknown as GameConfig;

  commands.register('player.GetByVillage', (cmd) => {
    const villageId = String((cmd.payload as { villageId?: unknown }).villageId ?? '');
    const player = players[villageId as keyof typeof players];
    return player ? ok({ player }) : { ok: false, payload: {}, reason: 'owner_not_found' };
  });
  commands.register('player.ListAll', () => ok({ players: Object.values(players) }));
  // Activate 的前置 s23 已由 task owner 接取；本夹具只检查 Sanctum 的公开资格。
  commands.register('task.GetState', () => ok({ active: [{ code: 's23' }] }));
  commands.register('task.AdvanceExternal', () => ok());
  commands.register('task.RefreshExternalOffers', () => ok());
  commands.register('treasure.List', (cmd) => {
    const villageId = String((cmd.payload as { villageId?: unknown }).villageId ?? '');
    return ok({ codes: fragments.has(villageId) ? ['sanctum_fragment'] : [] });
  });
  commands.register('treasure.ConsumeEventToken', () => { fragments.clear(); return ok(); });
  commands.register('world.GetTileByRef', (cmd) => {
    const refId = String((cmd.payload as { refId?: unknown }).refId ?? '');
    const player = players[refId as keyof typeof players];
    const village = player?.villages[0];
    return village ? ok({ tile: { q: village.q, r: village.r } }) : { ok: false, payload: {}, reason: 'not_found' };
  });

  const sanctum = new SanctumModule(store, bus, commands, scheduler, () => now, config);
  sanctum.init();
  return {
    store,
    async send(name: string, payload: Record<string, unknown>, from = 'test') {
      return commands.send({ name, from, payload });
    },
    async allowed(villageId: 'v1' | 'v2', code: string, mode: OfferMode): Promise<boolean> {
      const result = await commands.send({
        name: 'sanctum.CanOffer', from: 'task', payload: { villageId, code, mode },
      });
      assert.equal(result.ok, true, result.reason);
      return (result.payload as { allowed?: unknown }).allowed === true;
    },
    setNow(next: number) { now = next; },
  };
}

test('远弦圣地 offer：休眠期仅真实残印持有者可接 s23，唤醒后其他玩家也可手动接取', async () => {
  const f = fixture();
  assert.equal(await f.allowed('v1', 's23', 'fragment'), false, '不能用没有真实残印的旧任务/前端状态伪造 s23');
  assert.equal(await f.allowed('v2', 's23', 'fragment'), true, '真实存入宝库的残印才开放休眠期 s23');

  const activated = await f.send('sanctum.Activate', { playerId: 'p2', villageId: 'v2' });
  assert.equal(activated.ok, true, activated.reason);
  assert.equal(f.store.get<any>('sanctum', 'current')?.phase, 'active');
  // Activate 消耗了唯一残印；活动已开后 s23 仍必须向其他玩家开放，使其能通过
  // NPC 对话了解事件并加入，不会被“已无残印”错误挡住。
  assert.equal(await f.allowed('v1', 's23', 'fragment'), true);
});

test('远弦圣地 offer：s24–s29 逐阶段只向满足对应个人状态的玩家开放', async () => {
  const f = fixture();
  assert.equal((await f.send('sanctum.Activate', { playerId: 'p2', villageId: 'v2' })).ok, true);
  const state = f.store.get<any>('sanctum', 'current')!;
  // p1 已有 s23 的接取记录，但还没点击“唤醒/加入”前不能开始公共条件。
  state.players.p1 = { playerId: 'p1', conditionRecords: [], clues: [] };
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's24', 'active'), false);

  state.players.p1.joinedAt = 5_000_001;
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's24', 'active'), true);
  assert.equal(await f.allowed('v1', 's25', 'qualified'), false);

  state.players.p1.qualifiedAt = 5_000_002;
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's25', 'qualified'), true);
  assert.equal(await f.allowed('v1', 's26', 'discovered'), false);

  state.players.p1.discoveredAt = 5_000_003;
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's26', 'discovered'), true);
  assert.equal(await f.allowed('v1', 's27', 'briefed'), false);

  state.players.p1.siteDialogueAt = 5_000_004;
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's27', 'briefed'), true);
  assert.equal(await f.allowed('v1', 's28', 'occupied'), false);

  state.site.occupantPlayerId = 'p2';
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's28', 'occupied'), false, '别人占领圣地不能给我开放守卫任务');
  state.site.occupantPlayerId = 'p1';
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's28', 'occupied'), true);

  state.phase = 'ended';
  state.winnerPlayerId = 'p2';
  f.store.set('sanctum', 'current', state);
  assert.equal(await f.allowed('v1', 's29', 'artifact'), false);
  assert.equal(await f.allowed('v2', 's29', 'artifact'), true, '只有实际携物返乡并结算的赢家能领取最终任务卡');
});
