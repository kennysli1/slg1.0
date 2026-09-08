/**
 * 远弦圣地公共事件 owner。
 *
 * 本模块只维护活动轮次和事件专属状态；它绝不直写 task / pve / movement /
 * treasure 等其它集合。需要改变其它领域时只发送 Command，供对应 owner 处理。
 *
 * 当前阶段故意不在这里注册 Gateway 路由或配置加载：这样状态契约、并发边界与
 * 服务端指令可以先独立落地，后续接入层和配置中心可各自并行接入。
 */

import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
// eslint-disable-next-line no-restricted-imports -- sanctum/state 是同一 sanctum owner 的内部持久化边界。
import {
  SANCTUM_COLLECTION,
  SANCTUM_STATE_KEY,
  emptySanctumState,
  normalizeSanctumState,
  type SanctumClueRecord,
  type SanctumConditionContribution,
  type SanctumConditionRecord,
  type SanctumInvestigation,
  type SanctumPlayerState,
  type SanctumPoint,
  type SanctumRuleSnapshot,
  type SanctumState,
  type SanctumTarget,
} from './sanctum/state.js';

type Row = Record<string, unknown>;

interface SanctumConfigView {
  sanctumEvent?: unknown;
  sanctumEvents?: unknown;
  sanctumConditions?: unknown;
  sanctumConditionRewards?: unknown;
  sanctumPuzzles?: unknown;
  sanctumPuzzleSteps?: unknown;
  sanctumClues?: unknown;
  constants?: { raw?: Record<string, unknown> };
}

interface ConditionDef {
  code: string;
  name: string;
  kind: string;
  description: string;
  difficulty: string;
  completionMode: string;
  repeatable: boolean;
  instances: number;
  refreshMs: number;
  cooldownMs: number;
  puzzleCode?: string;
  pveTemplateCode?: string;
  params: Record<string, string>;
  minPlayers: number;
  minPlayerPop: number;
  minContributionShare: number;
  rewards: Row[];
  raw: Row;
}

interface RewardPlan {
  resources: Record<string, number>;
  reputation: number;
  researchPoints: number;
  treasureCodes: string[];
  deferredEffects: Array<{ kind: string; params: string }>;
}

const RESOURCE_KEYS = ['wood', 'clay', 'iron', 'crop', 'gold'] as const;
const SANCTUM_TASKS = new Set(['s23', 's24', 's25', 's26', 's27', 's28', 's29']);

function asRow(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function rows(value: unknown): Row[] {
  if (Array.isArray(value)) return value.flatMap((item) => rows(item));
  const record = asRow(value);
  if (!record) return [];
  // GameConfig 中目录表是 Record<code, Def>，而奖励/线索/步骤表是
  // Record<code, Def[]>。只有实际行对象才在这里停下；其余容器继续展开。
  if (['code', 'id', 'conditionCode', 'condition_code', 'puzzleCode', 'puzzle_code'].some((key) => key in record)) return [record];
  return Object.values(record).flatMap((item) => rows(item));
}

function text(row: Row | undefined, ...keys: string[]): string {
  if (!row) return '';
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function finite(row: Row | undefined, fallback: number, ...keys: string[]): number {
  if (!row) return fallback;
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function bool(row: Row | undefined, fallback: boolean, ...keys: string[]): boolean {
  if (!row) return fallback;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'y', '是'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'n', '否'].includes(normalized)) return false;
    }
  }
  return fallback;
}

function resourceMap(row: Row | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!row) return result;
  for (const key of RESOURCE_KEYS) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) result[key] = Math.floor(value);
  }
  return result;
}

function clonePoint(point: SanctumPoint | undefined): SanctumPoint | undefined {
  return point ? { q: point.q, r: point.r } : undefined;
}

/** CSV 参数使用 `key:value|key:value`，保持所有条件可配置而无需给每种玩法加列。 */
function parseParams(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const token of raw.split('|')) {
    const [key, ...rest] = token.split(':');
    const value = rest.join(':').trim();
    if (key?.trim() && value) result[key.trim()] = value;
  }
  return result;
}

function numericParam(params: Record<string, string>, key: string, fallback = 0): number {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** 不依赖 Math.random 的稳定坐标散列；同一轮重启后会选择同一片候选区域。 */
function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 公共圣地活动的唯一 owner。
 *
 * 重复请求的关键状态转换（开启、条件首胜、取圣物、回村结算）均先同步落盘后
 * 再 await 外部 owner；Node 的同一事件循环下，随后恢复的并发请求会看到新状态，
 * 不会重复给先发者、条件奖励或唯一圣物。
 */
export class SanctumModule {
  static readonly NAME = 'sanctum';

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('sanctum.GetState', (cmd) => this.getState(cmd));
    this.commands.register('sanctum.GetPublicTargets', (cmd) => this.getPublicTargets(cmd));
    /** Combat 只消费冻结的事件判定，不读取 sanctum collection。 */
    this.commands.register('sanctum.GetCombatModifiers', (cmd) => this.getCombatModifiers(cmd));
    this.commands.register('sanctum.GetDefenseSnapshot', (cmd) => this.getDefenseSnapshot(cmd));
    this.commands.register('sanctum.GetMovementModifiers', (cmd) => this.getMovementModifiers(cmd));
    this.commands.register('sanctum.CanGarrisonAt', (cmd) => this.canGarrisonAt(cmd));
    this.commands.register('sanctum.AssignTargetLocation', (cmd) => this.assignTargetLocation(cmd));
    this.commands.register('sanctum.SetSiteLocation', (cmd) => this.setSiteLocation(cmd));
    this.commands.register('sanctum.SetRewardRecipient', (cmd) => this.setRewardRecipient(cmd));
    this.commands.register('sanctum.RegisterParticipant', (cmd) => this.registerParticipant(cmd));
    this.commands.register('sanctum.Activate', (cmd) => this.activate(cmd));
    this.commands.register('sanctum.Join', (cmd) => this.join(cmd));
    this.commands.register('sanctum.BeginCondition', (cmd) => this.beginCondition(cmd));
    this.commands.register('sanctum.SubmitRune', (cmd) => this.submitRune(cmd));
    this.commands.register('sanctum.Contribute', (cmd) => this.contribute(cmd));
    this.commands.register('sanctum.CompleteCondition', (cmd) => this.completeConditionCommand(cmd));
    this.commands.register('sanctum.Discover', (cmd) => this.discover(cmd));
    this.commands.register('sanctum.Claim', (cmd) => this.claim(cmd));
    this.commands.register('sanctum.PauseGuard', (cmd) => this.pauseGuard(cmd));
    this.commands.register('sanctum.ResumeGuard', (cmd) => this.resumeGuard(cmd));
    this.commands.register('sanctum.ReleaseClaim', (cmd) => this.releaseClaim(cmd));
    this.commands.register('sanctum.TakeRelic', (cmd) => this.takeRelic(cmd));
    this.commands.register('sanctum.OnMovementReturned', (cmd) => this.onMovementReturnedCommand(cmd));
    this.commands.register('sanctum.OnRelicLost', (cmd) => this.onRelicLost(cmd));
    this.commands.register('sanctum.CanOffer', (cmd) => this.tryIssueSeal(cmd));
    this.commands.register('sanctum.TryIssueSeal', (cmd) => this.tryIssueSeal(cmd));

    // 这些事件都是“镜像通知”：实际跨 owner 写入仍走上面的受控 Command。
    this.bus.on('movement.Returned', (evt) => this.onMovementReturnedEvent(evt));
    this.bus.on('combat.BattleEnded', (evt) => this.onBattleEnded(evt));
    this.bus.on('task.Accepted', (evt) => this.onTaskAccepted(evt));
    this.bus.on('task.Delivered', (evt) => this.onTaskDelivered(evt));
    this.bus.on('movement.Garrisoned', (evt) => this.onMovementGarrisoned(evt));
    this.bus.on('movement.Explored', (evt) => this.onMovementExplored(evt));
    // 残印真正入库、进入待领取报告或被玩家确认收下时才刷新 s23；不会因为
    // 客户端猜测掉落而把任务错误开放给没有残印的玩家。
    this.bus.on('treasure.Granted', (evt) => this.onFragmentChanged(evt));
    this.bus.on('treasure.PendingDropped', (evt) => this.onFragmentChanged(evt));
    this.bus.on('treasure.PendingClaimed', (evt) => this.onFragmentChanged(evt));
  }

  resume(): void {
    const state = this.load();
    if (state.phase === 'active' && state.site.occupantPlayerId && state.site.guardDueAt && !state.site.guardPausedAt) {
      this.armGuard(state);
    }
    // 驻留调查的时间点也必须在重启后恢复；状态只存 dueAt，真正完成时仍会
    // 再向 Movement 查询该军是否还在同一格，绝不因为服务器重启白送进度。
    for (const target of Object.values(state.targets)) {
      for (const investigation of Object.values(target.investigations ?? {})) {
        this.armInvestigation(state, target, investigation);
      }
    }
    // `settling` 说明崩溃发生在宝物交付 command 的前后。没有可证明的完成回执时，
    // 保守地把它恢复为在途，避免凭空复制圣物；movement 返程事件会再次尝试结算。
    if (state.relic.status === 'settling') {
      state.relic.status = state.relic.carrierMovementId ? 'carried' : 'at_sanctum';
      delete state.relic.settlingAt;
      this.save(state);
    }
    void this.flushPendingRewards(state);
    void this.ensureActivityWorld(state);
  }

  wipe(): void {
    const state = this.store.get<SanctumState>(SANCTUM_COLLECTION, SANCTUM_STATE_KEY);
    if (state?.roundId) this.scheduler.cancelByOwner(this.guardOwner(state.roundId));
    this.store.clear(SANCTUM_COLLECTION);
  }

  private view(): SanctumConfigView { return this.config as unknown as SanctumConfigView; }

  private rawConstant(key: string, fallback: number): number {
    const value = Number(this.view().constants?.raw?.[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  private eventRow(): Row {
    const singular = this.view().sanctumEvent;
    const all = rows(singular ?? this.view().sanctumEvents);
    return all[0] ?? {};
  }

  private currentRoundId(): string {
    const event = this.eventRow();
    return text(event, 'roundId', 'round_id', 'id', 'code') || 'sanctum-round-1';
  }

  private relicCode(): string {
    const event = this.eventRow();
    return text(event, 'relicCode', 'relic_code', 'finalTreasureCode', 'final_treasure_code') || 'farstring_crest';
  }

  private load(): SanctumState {
    const state = normalizeSanctumState(
      this.store.get<SanctumState>(SANCTUM_COLLECTION, SANCTUM_STATE_KEY),
      this.currentRoundId(),
      this.relicCode(),
    );
    this.store.set(SANCTUM_COLLECTION, SANCTUM_STATE_KEY, state);
    return state;
  }

  private save(state: SanctumState): void {
    state.revision = Math.max(0, state.revision) + 1;
    this.store.set(SANCTUM_COLLECTION, SANCTUM_STATE_KEY, state);
  }

  private rules(): SanctumRuleSnapshot {
    const c = this.config.constants;
    // 运行时 GameConfig 已把常量解析成强类型字段；测试夹具与极旧热重载快照可能
    // 只带 raw，因此在冻结本轮规则时回退 raw，绝不能冻结出 NaN。
    const required = Number(c.sanctumConditionsRequired ?? this.rawConstant('sanctum_conditions_required', 6));
    const holdSec = Number(c.sanctumFirstHoldSec ?? this.rawConstant('sanctum_first_hold_sec', 1800));
    const oldOccupierRatio = Number(c.sanctumFormerHolderMinCommanderPopShare ?? this.rawConstant('sanctum_former_holder_min_commander_pop_share', 0.5));
    const defenseBonus = Number(c.sanctumDefenseMult ?? this.rawConstant('sanctum_defense_mult', 0.5));
    const rangedBonus = Number(c.sanctumPhase2RangedAtkMult ?? this.rawConstant('sanctum_phase2_ranged_atk_mult', 0.4));
    return {
      roundId: this.currentRoundId(),
      requiredConditions: Math.max(1, Math.floor(Number.isFinite(required) ? required : 6)),
      guardDurationMs: Math.max(1_000, Math.round((Number.isFinite(holdSec) ? holdSec : 1800) * 1000)),
      oldOccupierContributionRatio: Math.min(1, Math.max(0, Number.isFinite(oldOccupierRatio) ? oldOccupierRatio : 0.5)),
      defenderDefenseMultiplier: Math.max(0, 1 + (Number.isFinite(defenseBonus) ? defenseBonus : 0.5)),
      defenderRangedPhaseMultiplier: Math.max(0, 1 + (Number.isFinite(rangedBonus) ? rangedBonus : 0.4)),
      relicCode: this.relicCode(),
      activatedAt: this.now(),
    };
  }

  private sitePoint(): SanctumPoint | undefined {
    const event = this.eventRow();
    const q = finite(event, Number.NaN, 'sanctuaryQ', 'sanctuary_q', 'q');
    const r = finite(event, Number.NaN, 'sanctuaryR', 'sanctuary_r', 'r');
    return Number.isFinite(q) && Number.isFinite(r) ? { q: Math.floor(q), r: Math.floor(r) } : undefined;
  }

  private conditionDefs(): ConditionDef[] {
    const rewardRows = rows(this.view().sanctumConditionRewards);
    const defs: ConditionDef[] = [];
    for (const row of rows(this.view().sanctumConditions)) {
      const code = text(row, 'code', 'id');
      if (!code) continue;
      const matchingRewards = rewardRows.filter((reward) => text(reward, 'conditionCode', 'condition_code', 'code') === code);
      const completionMode = text(row, 'completionMode', 'completion_mode') || 'global_once';
      const params = parseParams(text(row, 'params'));
      defs.push({
        code,
        name: text(row, 'name') || code,
        kind: text(row, 'kind', 'type') || 'investigate',
        description: text(row, 'description', 'desc'),
        difficulty: text(row, 'difficulty', 'category') || 'normal',
        completionMode,
        repeatable: bool(row, completionMode === 'personal_repeat', 'repeatable'),
        instances: Math.max(1, Math.floor(finite(row, 1, 'instances', 'count', 'quantity'))),
        refreshMs: Math.max(0, finite(row, 0, 'refreshSec', 'refresh_sec') * 1000),
        cooldownMs: Math.max(0, finite(row, this.rawConstant('sanctum_repeat_personal_cooldown_sec', 1800), 'personalCooldownSec', 'personal_cooldown_sec', 'cooldownSec', 'cooldown_sec') * 1000),
        puzzleCode: text(row, 'puzzleCode', 'puzzle_code') || undefined,
        pveTemplateCode: text(row, 'pveTemplateCode', 'pve_template_code') || undefined,
        params,
        minPlayers: Math.max(1, Math.floor(finite(row, 1, 'minPlayers', 'min_players'))),
        minPlayerPop: Math.max(0, Math.floor(finite(row, 0, 'minPlayerPop', 'min_player_pop'))),
        minContributionShare: Math.min(1, Math.max(0, finite(row, 0, 'minContributionShare', 'min_contribution_share'))),
        rewards: matchingRewards,
        raw: row,
      });
    }
    return defs;
  }

  private targetDef(target: SanctumTarget): ConditionDef | undefined {
    return this.conditionDefs().find((def) => def.code === target.code);
  }

  private buildTargets(rules: SanctumRuleSnapshot): Record<string, SanctumTarget> {
    const result: Record<string, SanctumTarget> = {};
    const now = this.now();
    for (const def of this.conditionDefs()) {
      for (let index = 1; index <= def.instances; index++) {
        const id = `${rules.roundId}:${def.code}:${index}`;
        result[id] = {
          id,
          code: def.code,
          name: def.name,
          type: def.kind,
          status: 'open',
          repeatable: def.repeatable,
          completionLimit: def.completionMode === 'personal_repeat' ? 0 : 1,
          completionCount: 0,
          createdAt: now,
          updatedAt: now,
          startedBy: {},
          completedAtBy: {},
          contributions: {},
          investigations: {},
          puzzleCode: def.puzzleCode,
        };
      }
    }
    return result;
  }

  private ensurePlayer(state: SanctumState, playerId: string): SanctumPlayerState {
    let player = state.players[playerId];
    if (!player) {
      player = { playerId, conditionRecords: [], clues: [] };
      state.players[playerId] = player;
    }
    player.conditionRecords ??= [];
    player.clues ??= [];
    return player;
  }

  private playerRequiredConditions(state: SanctumState): number {
    return state.rules?.requiredConditions ?? this.rules().requiredConditions;
  }

  private isQualified(state: SanctumState, player: SanctumPlayerState): boolean {
    return player.qualifiedAt !== undefined || player.conditionRecords.length >= this.playerRequiredConditions(state);
  }

  private sanitizeTarget(state: SanctumState, target: SanctumTarget, player?: SanctumPlayerState): Record<string, unknown> {
    const def = this.targetDef(target);
    const started = player ? target.startedBy[player.playerId] !== undefined : false;
    const investigationDueAt = player ? target.investigations?.[player.playerId]?.dueAt : undefined;
    const cooldownUntil = player ? target.completedAtBy[player.playerId] : undefined;
    const playerCooldown = cooldownUntil && def ? cooldownUntil + def.cooldownMs : undefined;
    const canStart = !!player && state.phase === 'active' && !!player.joinedAt && target.status !== 'removed'
      && (target.completionLimit === 0 || target.completionCount < target.completionLimit)
      && (!playerCooldown || playerCooldown <= this.now());
    return {
      id: target.id,
      code: target.code,
      name: target.name,
      kind: target.type,
      description: def?.description ?? '',
      q: target.point?.q,
      r: target.point?.r,
      point: clonePoint(target.point),
      pveId: target.pveId,
      difficulty: def?.difficulty ?? 'normal',
      repeatable: target.repeatable,
      status: target.status,
      completionCount: target.completionCount,
      completionLimit: target.completionLimit,
      cooldownUntil: target.cooldownUntil,
      playerCooldownUntil: playerCooldown,
      investigationDueAt,
      rewards: this.publicRewards(def),
      requirements: {
        minPlayers: def?.minPlayers ?? 1,
        minPlayerPop: def?.minPlayerPop ?? 0,
        minContributionShare: def?.minContributionShare ?? 0,
        params: def?.params ?? {},
      },
      actions: {
        begin: canStart && !started,
        submitRune: canStart && started && !!target.puzzleCode,
        contribute: canStart && ['resource_delivery', 'synchronous_ritual'].includes(target.type),
      },
    };
  }

  private publicRewards(def: ConditionDef | undefined): Record<string, unknown> {
    const plan = this.rewardPlan(def, false);
    return {
      resources: plan.resources,
      reputation: plan.reputation,
      researchPoints: plan.researchPoints,
      treasureCodes: plan.treasureCodes,
      deferredEffects: plan.deferredEffects,
    };
  }

  private async hasSeal(villageId: string | undefined): Promise<boolean> {
    if (!villageId) return false;
    const code = text(this.eventRow(), 'fragmentTreasureCode', 'fragment_treasure_code', 'sealCode', 'seal_code', 'triggerTreasureCode', 'trigger_treasure_code') || 'sanctum_fragment';
    const treasures = await this.commands.send({ name: 'treasure.List', from: SanctumModule.NAME, payload: { villageId } });
    if (!treasures.ok) return false;
    const payload = treasures.payload as { codes?: unknown[]; pending?: Array<{ code?: unknown }>; carried?: Record<string, unknown[]> };
    const stored = Array.isArray(payload.codes) && payload.codes.some((item) => item === code);
    const pending = Array.isArray(payload.pending) && payload.pending.some((item) => item?.code === code);
    const carried = Object.values(payload.carried ?? {}).some((codes) => Array.isArray(codes) && codes.some((item) => item === code));
    return stored || pending || carried;
  }

  private projectedPhase(state: SanctumState, player: SanctumPlayerState | undefined, hasSeal: boolean): string {
    if (state.phase === 'ended') return 'completed';
    if (state.phase === 'dormant') return player?.joinedAt ? 'awaiting_activation' : (hasSeal ? 'seal_race' : 'dormant');
    if (state.relic.status === 'carried' || state.relic.status === 'settling') return 'relic_in_transit';
    if (state.site.occupantPlayerId) return 'sanctum_active';
    if (player?.qualifiedAt && !player.discoveredAt) return 'sanctum_hidden';
    return 'active';
  }

  private async getState(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId } = cmd.payload as { playerId?: string; villageId?: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'player_id_required' };
    const state = this.load();
    const player = state.players[playerId];
    const ownsSeal = await this.hasSeal(villageId);
    const joined = !!player?.joinedAt;
    const qualified = !!player && this.isQualified(state, player);
    const revealSite = !!player?.discoveredAt || state.site.occupantPlayerId === playerId || state.relic.carrierPlayerId === playerId;
    const canTakeRelic = state.phase === 'active' && state.site.occupantPlayerId === playerId
      && state.relic.status === 'at_sanctum' && (!!player?.guardRewardedAt || !!player?.oldOccupierAt);
    return {
      ok: true,
      payload: {
        event: {
          roundId: state.roundId,
          id: text(this.eventRow(), 'code') || 'farstring_sanctum',
          name: text(this.eventRow(), 'name') || '远弦圣地',
          phase: this.projectedPhase(state, player, ownsSeal),
          revision: state.revision,
          pioneerPlayerId: state.pioneerPlayerId,
          startedAt: state.rules?.activatedAt,
          endedAt: state.endedAt,
        },
        player: {
          hasSeal: ownsSeal,
          canActivate: state.phase === 'dormant' && joined && ownsSeal,
          isPioneer: state.pioneerPlayerId === playerId,
          conditionsCompleted: player?.conditionRecords.length ?? 0,
          conditionsRequired: this.playerRequiredConditions(state),
          qualified,
          hints: (player?.clues ?? []).map((hint) => ({ id: hint.id, targetId: hint.targetId, code: hint.code, text: hint.text, createdAt: hint.createdAt })),
          completedConditionRecords: (player?.conditionRecords ?? []).map((record) => ({ ...record })),
          actions: {
            join: state.phase === 'active' && !joined,
            beginCondition: state.phase === 'active' && joined,
            discover: state.phase === 'active' && qualified && !player?.discoveredAt,
            claim: state.phase === 'active' && qualified && !!player?.discoveredAt && !!player?.siteDialogueAt && !state.site.occupantPlayerId,
            takeRelic: canTakeRelic,
          },
        },
        publicTargets: Object.values(state.targets)
          .filter((target) => target.status !== 'removed')
          .map((target) => this.sanitizeTarget(state, target, player)),
        sanctum: revealSite ? {
          id: `sanctum-site:${state.roundId}`,
          name: text(this.eventRow(), 'name') || '远弦圣地',
          q: state.site.point?.q,
          r: state.site.point?.r,
          point: clonePoint(state.site.point),
          pveId: state.site.pveId,
          pveClearedAt: state.site.pveClearedAt,
          occupantPlayerId: state.site.occupantPlayerId,
          guardDueAt: state.site.guardDueAt,
          guardPausedAt: state.site.guardPausedAt,
          guardElapsedMs: state.site.guardElapsedMs,
          defenseMultiplier: state.rules?.defenderDefenseMultiplier,
          rangedPhaseMultiplier: state.rules?.defenderRangedPhaseMultiplier,
          actions: {
            discover: state.phase === 'active' && qualified && !player?.discoveredAt,
            claim: state.phase === 'active' && qualified && !!player?.discoveredAt && !!player?.siteDialogueAt && !state.site.occupantPlayerId,
            takeRelic: canTakeRelic,
          },
        } : undefined,
        relic: state.relic.status === 'awarded' ? { status: 'awarded', awardedPlayerId: state.relic.awardedPlayerId }
          : state.relic.status === 'carried' || state.relic.status === 'settling'
            ? { status: state.relic.status, carriedByYou: state.relic.carrierPlayerId === playerId }
            : { status: state.relic.status },
      },
    };
  }

  private getPublicTargets(cmd: Command): CommandResult {
    const playerId = String((cmd.payload as { playerId?: string }).playerId ?? '');
    const state = this.load();
    const player = playerId ? state.players[playerId] : undefined;
    return {
      ok: true,
      payload: {
        roundId: state.roundId,
        phase: state.phase,
        targets: Object.values(state.targets).filter((target) => target.status !== 'removed').map((target) => this.sanitizeTarget(state, target, player)),
      },
    };
  }

  /**
   * 供 Combat 的只读事件上下文。Combat 传入自己的已冻结参战快照；Sanctum 只回答
   * 「这里是不是圣地、谁是占领者、旧占领者是否以主指挥身份满足 50% 门槛」，
   * 从不反向读取或修改 battle collection。
   */
  private getCombatModifiers(cmd: Command): CommandResult {
    const payload = cmd.payload as {
      targetId?: string; targetXY?: { q?: unknown; r?: unknown }; q?: unknown; r?: unknown;
      attackerContributions?: Array<{ playerId?: unknown; effectivePop?: unknown; isMainCommander?: unknown }>;
      attackerPlayerId?: unknown; attackerEffectivePop?: unknown; totalAttackerEffectivePop?: unknown;
    };
    const state = this.load();
    const site = state.site.point;
    const q = Number(payload.targetXY?.q ?? payload.q);
    const r = Number(payload.targetXY?.r ?? payload.r);
    const atSite = state.phase === 'active' && !!site && (
      (Number.isFinite(q) && Number.isFinite(r) && site.q === Math.floor(q) && site.r === Math.floor(r))
      || (!!state.site.pveId && payload.targetId === state.site.pveId)
    );
    const eventTarget = Object.values(state.targets).some((target) => target.pveId && target.pveId === payload.targetId);
    if (!atSite) return { ok: true, payload: { eventTarget, sanctuary: false, defenderDefenseMult: 1, defenderRangedAtkMult: 1, defenderRangedDefMult: 1, disableSanctuaryBonuses: false } };
    const contributions = Array.isArray(payload.attackerContributions) ? payload.attackerContributions : [];
    const normalized = contributions.map((item, index) => ({
      playerId: String(item?.playerId ?? (index === 0 ? payload.attackerPlayerId ?? '' : '')),
      effectivePop: Math.max(0, Number(item?.effectivePop ?? (index === 0 ? payload.attackerEffectivePop ?? 0 : 0)) || 0),
      isMainCommander: item?.isMainCommander === true || (index === 0 && contributions.length === 0),
    }));
    if (normalized.length === 0 && payload.attackerPlayerId) normalized.push({
      playerId: String(payload.attackerPlayerId),
      effectivePop: Math.max(0, Number(payload.attackerEffectivePop) || 0),
      isMainCommander: true,
    });
    const total = Math.max(0, Number(payload.totalAttackerEffectivePop) || normalized.reduce((sum, item) => sum + item.effectivePop, 0));
    const main = normalized.find((item) => item.isMainCommander) ?? normalized[0];
    const mainState = main?.playerId ? state.players[main.playerId] : undefined;
    const threshold = state.rules?.oldOccupierContributionRatio ?? this.rules().oldOccupierContributionRatio;
    const disableSanctuaryBonuses = !!mainState?.oldOccupierAt && !!main && total > 0 && main.effectivePop / total >= threshold;
    return {
      ok: true,
      payload: {
        eventTarget: true,
        sanctuary: true,
        occupantPlayerId: state.site.occupantPlayerId,
        defenderDefenseMult: disableSanctuaryBonuses ? 1 : (state.rules?.defenderDefenseMultiplier ?? 1),
        defenderRangedAtkMult: disableSanctuaryBonuses ? 1 : (state.rules?.defenderRangedPhaseMultiplier ?? 1),
        // 具体携带“守望棱镜”的守卫加成由 combat 在其部队快照里叠加；这里先
        // 明确提供中性字段，避免 caller 用不存在的事件上下文猜测。
        defenderRangedDefMult: 1,
        disableSanctuaryBonuses,
        formerHolderRequiredShare: threshold,
      },
    };
  }

  /**
   * 圣地门扉清除后，防守方是真实驻扎军而不是一个空 PvE 壳。Combat 只向
   * Sanctum 问“此目标是否应改用占领驻军”，Sanctum 再向 Movement 请求其自有
   * 快照，任何一方都不跨读对方集合。
   */
  private async getDefenseSnapshot(cmd: Command): Promise<CommandResult> {
    if (cmd.from !== 'combat') return { ok: false, payload: {}, reason: 'combat_owner_required' };
    const payload = cmd.payload as { targetId?: string; targetXY?: { q?: unknown; r?: unknown }; q?: unknown; r?: unknown };
    const state = this.load();
    const point = state.site.point;
    const q = Number(payload.targetXY?.q ?? payload.q), r = Number(payload.targetXY?.r ?? payload.r);
    const atSite = state.phase === 'active' && !!point && (
      payload.targetId === state.site.pveId
      || (Number.isFinite(q) && Number.isFinite(r) && point.q === Math.floor(q) && point.r === Math.floor(r))
    );
    if (!atSite || !state.site.pveClearedAt || !state.site.occupantMovementId) {
      return { ok: true, payload: { useOccupant: false } };
    }
    const troop = await this.commands.send({
      name: 'movement.GetSanctumDefenderSnapshot', from: SanctumModule.NAME,
      payload: { movementId: state.site.occupantMovementId },
    });
    if (!troop.ok) return { ok: true, payload: { useOccupant: false } };
    return {
      ok: true,
      payload: {
        useOccupant: true,
        occupantPlayerId: state.site.occupantPlayerId,
        occupantVillageId: state.site.occupantVillageId,
        occupantMovementId: state.site.occupantMovementId,
        ...(troop.payload as Record<string, unknown>),
      },
    };
  }

  /** Movement/Trade 的只读事件上下文；宝物本身仍由 Treasure owner 聚合。 */
  private getMovementModifiers(cmd: Command): CommandResult {
    const payload = cmd.payload as { q?: unknown; r?: unknown; point?: { q?: unknown; r?: unknown }; targetId?: string };
    const state = this.load();
    const q = Number(payload.point?.q ?? payload.q), r = Number(payload.point?.r ?? payload.r);
    const atSite = state.phase === 'active' && !!state.site.point && (
      (Number.isFinite(q) && Number.isFinite(r) && state.site.point.q === Math.floor(q) && state.site.point.r === Math.floor(r))
      || payload.targetId === state.site.pveId
    );
    const eventTarget = atSite || Object.values(state.targets).some((target) => target.pveId && target.pveId === payload.targetId);
    return { ok: true, payload: { eventTarget, sanctuary: atSite } };
  }

  /**
   * 普通 PvE 格一律不能驻扎。只有圣地门扉已被攻破后，Movement 才能让军队
   * 落在该格；这一查询不暴露坐标，也不改变事件状态。
   */
  private canGarrisonAt(cmd: Command): CommandResult {
    if (cmd.from !== 'movement') return { ok: false, payload: {}, reason: 'movement_owner_required' };
    const payload = cmd.payload as { q?: unknown; r?: unknown };
    const q = Number(payload.q), r = Number(payload.r);
    const state = this.load();
    const point = state.site.point;
    const passable = state.phase === 'active' && !!point && !!state.site.pveClearedAt
      && Number.isFinite(q) && Number.isFinite(r)
      && point.q === Math.floor(q) && point.r === Math.floor(r);
    return { ok: true, payload: { passable } };
  }

  /**
   * World / PvE 负责选择和占用真实空地；Sanctum 只保存被确认的活动目标坐标。
   * 这样不会让活动模块直接读取 world_tile，也不会让地图 owner 反向拥有活动状态。
   */
  private assignTargetLocation(cmd: Command): CommandResult {
    if (!['world', 'pve', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'map_owner_required' };
    const { targetId, q, r } = cmd.payload as { targetId?: string; q?: number; r?: number };
    if (!targetId || !Number.isFinite(q) || !Number.isFinite(r)) return { ok: false, payload: {}, reason: 'target_coordinate_required' };
    const state = this.load();
    const target = state.targets[targetId];
    if (!target || state.phase !== 'active') return { ok: false, payload: {}, reason: 'target_not_available' };
    target.point = { q: Math.floor(q!), r: Math.floor(r!) };
    target.updatedAt = this.now();
    this.save(state);
    return { ok: true, payload: { targetId, q: target.point.q, r: target.point.r } };
  }

  /** 圣地精确坐标只由 World/PvE 分配；GetState 仍按个人发现权限隐藏它。 */
  private setSiteLocation(cmd: Command): CommandResult {
    if (!['world', 'pve', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'map_owner_required' };
    const { q, r } = cmd.payload as { q?: number; r?: number };
    if (!Number.isFinite(q) || !Number.isFinite(r)) return { ok: false, payload: {}, reason: 'sanctum_coordinate_required' };
    const state = this.load();
    if (state.phase !== 'active') return { ok: false, payload: {}, reason: 'sanctum_not_active' };
    state.site.point = { q: Math.floor(q!), r: Math.floor(r!) };
    this.save(state);
    return { ok: true, payload: { q: state.site.point.q, r: state.site.point.r } };
  }

  /** 所有能扣资源/占领/带走圣物的公开动作都再次验证来源村归属。 */
  private async ownsVillage(playerId: string, villageId: string): Promise<boolean> {
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: SanctumModule.NAME, payload: { villageId } });
    return owner.ok && String((owner.payload as { player?: { id?: unknown }; id?: unknown }).player?.id ?? (owner.payload as { id?: unknown }).id ?? '') === playerId;
  }

  private async allPlayers(): Promise<Array<{ id: string; name?: string; villages: Array<{ id: string; q: number; r: number; name?: string }> }>> {
    const result = await this.commands.send({ name: 'player.ListAll', from: SanctumModule.NAME, payload: {} });
    if (!result.ok) return [];
    const values = (result.payload as { players?: unknown }).players;
    if (!Array.isArray(values)) return [];
    return values.flatMap((raw) => {
      const row = asRow(raw);
      const id = text(row, 'id');
      const villages = Array.isArray(row?.villages)
        ? row!.villages.flatMap((v) => {
          const village = asRow(v);
          const villageId = text(village, 'id');
          const q = finite(village, Number.NaN, 'q');
          const r = finite(village, Number.NaN, 'r');
          return villageId && Number.isFinite(q) && Number.isFinite(r)
            ? [{ id: villageId, q: Math.floor(q), r: Math.floor(r), name: text(village, 'name') || undefined }]
            : [];
        })
        : [];
      return id ? [{ id, name: text(row, 'name') || undefined, villages }] : [];
    });
  }

  private locationSeed(state: SanctumState, key: string): { q: number; r: number } {
    const w = Math.max(3, Math.floor(this.config.constants.worldW));
    const h = Math.max(3, Math.floor(this.config.constants.worldH));
    return { q: hash32(`${state.roundId}:${key}:q`) % w, r: hash32(`${state.roundId}:${key}:r`) % h };
  }

  /** 由 World owner 给出空地；事件 owner 只保存它确认后的坐标。 */
  private async findEventPoint(state: SanctumState, key: string): Promise<SanctumPoint | undefined> {
    const center = this.locationSeed(state, key);
    const first = await this.commands.send({
      name: 'world.FindFreeTile', from: SanctumModule.NAME,
      payload: { centerQ: center.q, centerR: center.r, radius: 12, salt: `sanctum:${state.roundId}:${key}` },
    });
    const result = first.ok ? first : await this.commands.send({
      name: 'world.FindFreeTile', from: SanctumModule.NAME,
      payload: { centerQ: center.q, centerR: center.r, radius: 30, salt: `sanctum:${state.roundId}:${key}:wide` },
    });
    const q = Number((result.payload as { q?: unknown })?.q);
    const r = Number((result.payload as { r?: unknown })?.r);
    return result.ok && Number.isFinite(q) && Number.isFinite(r) ? { q: Math.floor(q), r: Math.floor(r) } : undefined;
  }

  private async spawnTargetPve(target: SanctumTarget, def: ConditionDef): Promise<boolean> {
    if (!target.point || !def.pveTemplateCode) return false;
    const id = target.pveId ?? `sanctum-target:${target.id}`;
    const existing = await this.commands.send({ name: 'pve.GetTarget', from: SanctumModule.NAME, payload: { id } });
    if (!existing.ok) {
      const spawned = await this.commands.send({
        name: 'pve.Spawn', from: SanctumModule.NAME,
        payload: { id, type: def.pveTemplateCode, q: target.point.q, r: target.point.r, task: false, noRespawn: true },
      });
      if (!spawned.ok && spawned.reason !== 'already_exists') return false;
    }
    target.pveId = id;
    return true;
  }

  /**
   * 公开条件的地图点在首发者唤醒时生成；圣地坐标也同时冻结，但只在玩家达到
   * 资格后创建真实地图实体，因此线索可用而精确位置不会被无关玩家的地图快照泄露。
   */
  private async ensureActivityWorld(state: SanctumState): Promise<void> {
    if (state.phase !== 'active') return;
    let changed = false;
    for (const target of Object.values(state.targets)) {
      if (target.status === 'removed' || target.status === 'completed') continue;
      if (!target.point) {
        const point = await this.findEventPoint(state, target.id);
        if (point) { target.point = point; target.updatedAt = this.now(); changed = true; }
      }
      const def = this.targetDef(target);
      if (def?.pveTemplateCode && target.point && !target.pveId) {
        if (await this.spawnTargetPve(target, def)) changed = true;
      }
    }
    if (!state.site.point) {
      const point = await this.findEventPoint(state, 'sanctuary');
      if (point) { state.site.point = point; changed = true; }
    }
    // 圣地本体直到有人完成六项条件才出现在世界上。只要已经出现就保留，不会
    // 因玩家离线/配置热更新重建守军。
    if (state.site.point && !state.site.pveId && Object.values(state.players).some((player) => this.isQualified(state, player))) {
      const event = this.eventRow();
      const template = text(event, 'sanctuaryTemplateCode', 'sanctuary_template_code');
      const id = `sanctum-site:${state.roundId}`;
      const existing = await this.commands.send({ name: 'pve.GetTarget', from: SanctumModule.NAME, payload: { id } });
      if (!existing.ok && template) {
        const spawned = await this.commands.send({
          name: 'pve.Spawn', from: SanctumModule.NAME,
          payload: { id, type: template, q: state.site.point.q, r: state.site.point.r, task: false, noRespawn: true },
        });
        if (spawned.ok || spawned.reason === 'already_exists') { state.site.pveId = id; changed = true; }
      } else if (existing.ok) { state.site.pveId = id; changed = true; }
    }
    if (changed) this.save(state);
  }

  /** 首发者仅得到一条「当前视野外、最近的条件」提示，不能借此直接完成任何目标。 */
  private async grantPioneerLead(state: SanctumState, playerId: string, villageId: string): Promise<void> {
    const player = this.ensurePlayer(state, playerId);
    if (player.clues.some((clue) => clue.code === 'pioneer_lead')) return;
    const origin = await this.playerPoint(villageId);
    if (!origin) return;
    const candidates: Array<{ target: SanctumTarget; distance: number; visible: boolean }> = [];
    for (const target of Object.values(state.targets)) {
      if (!target.point || target.status === 'removed') continue;
      const [distance, visibility] = await Promise.all([
        this.commands.send({ name: 'world.Distance', from: SanctumModule.NAME, payload: { from: origin, to: target.point } }),
        this.commands.send({ name: 'vision.GetVisibility', from: SanctumModule.NAME, payload: { playerId, q: target.point.q, r: target.point.r } }),
      ]);
      candidates.push({
        target,
        distance: Math.max(0, Number((distance.payload as { distance?: unknown })?.distance) || 0),
        visible: String((visibility.payload as { visibility?: unknown })?.visibility ?? '') === 'visible',
      });
    }
    const selected = candidates.filter((item) => !item.visible).sort((a, b) => a.distance - b.distance || a.target.id.localeCompare(b.target.id))[0]
      ?? candidates.sort((a, b) => a.distance - b.distance || a.target.id.localeCompare(b.target.id))[0];
    if (!selected) return;
    player.clues.push({
      id: `${state.roundId}:pioneer:${playerId}`,
      targetId: selected.target.id,
      code: 'pioneer_lead',
      text: `先发者的残印震动了一次：离你最近、尚在视野外的条件是「${selected.target.name}」，大约在${this.directionFrom(origin, selected.target.point)}方。`,
      createdAt: this.now(),
    });
    this.save(state);
  }

  /** 合作队伍在结算前锁定唯一宝物接收者，避免 C18/C21 等奖励被重复发放。 */
  private setRewardRecipient(cmd: Command): CommandResult {
    if (!['movement', 'pve', 'combat', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const { targetId, playerId } = cmd.payload as { targetId?: string; playerId?: string };
    if (!targetId || !playerId) return { ok: false, payload: {}, reason: 'target_and_player_required' };
    const state = this.load();
    const target = this.validTarget(state, targetId);
    if (!target) return { ok: false, payload: {}, reason: 'target_not_available' };
    if (target.rewardRecipientPlayerId && target.rewardRecipientPlayerId !== playerId) return { ok: false, payload: {}, reason: 'reward_recipient_locked' };
    target.rewardRecipientPlayerId = playerId;
    target.updatedAt = this.now();
    this.save(state);
    return { ok: true, payload: { targetId, rewardRecipientPlayerId: playerId } };
  }

  /** Task.Accepted 的 s23 回调，或 task owner 受控调用，登记玩家处于手动确认阶段。 */
  private async registerParticipant(cmd: Command): Promise<CommandResult> {
    if (cmd.from !== 'task' && cmd.from !== SanctumModule.NAME) return { ok: false, payload: {}, reason: 'task_owner_required' };
    const { playerId } = cmd.payload as { playerId?: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'player_id_required' };
    const state = this.load();
    if (state.phase === 'ended') return { ok: false, payload: {}, reason: 'sanctum_ended' };
    const player = this.ensurePlayer(state, playerId);
    if (!player.joinedAt) player.joinedAt = this.now();
    this.save(state);
    await this.emitPlayerUpdated(state, playerId, 'participant_registered');
    return { ok: true, payload: { roundId: state.roundId, phase: state.phase, joinedAt: player.joinedAt } };
  }

  private async taskAllows(villageId: string, code: string): Promise<CommandResult> {
    const task = await this.commands.send({ name: 'task.GetState', from: SanctumModule.NAME, payload: { villageId } });
    if (!task.ok) return task;
    const active = (task.payload as { active?: Array<{ code?: unknown }> }).active;
    if (!Array.isArray(active) || !active.some((entry) => entry?.code === code)) {
      return { ok: false, payload: {}, reason: `task_${code}_not_active` };
    }
    return { ok: true, payload: {} };
  }

  /** s23 的“唤醒残印”：先验证任务，后同步落盘事件开启，因此并发只会产生一个先发者。 */
  private async activate(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId } = cmd.payload as { playerId?: string; villageId?: string };
    if (!playerId || !villageId) return { ok: false, payload: {}, reason: 'player_and_village_required' };
    if (!bool(this.eventRow(), true, 'enabled')) return { ok: false, payload: {}, reason: 'sanctum_disabled' };
    if (!(await this.ownsVillage(playerId, villageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const allowed = await this.taskAllows(villageId, 's23');
    if (!allowed.ok) return allowed;

    let state = this.load();
    if (state.phase === 'ended') return { ok: false, payload: {}, reason: 'sanctum_ended' };
    if (state.phase === 'active') {
      return this.joinAlreadyActiveActivation(state, playerId, villageId);
    }
    // 开启前必须确实持有残印；不能仅靠已接取 s23 的旧对话或伪造请求抢先发。
    if (!(await this.hasSeal(villageId))) return { ok: false, payload: {}, reason: 'sanctum_fragment_required' };
    // `hasSeal` 是跨 owner 异步读取。两人并发确认时，第一人可能已在 await
    // 期间落盘 active；必须重新读取，而不能继续用 pre-await 的克隆状态。
    state = this.load();
    if (state.phase === 'ended') return { ok: false, payload: {}, reason: 'sanctum_ended' };
    if (state.phase === 'active') return this.joinAlreadyActiveActivation(state, playerId, villageId);

    const rules = this.rules();
    const player = this.ensurePlayer(state, playerId);
    state.phase = 'active';
    state.roundId = rules.roundId;
    state.rules = rules;
    state.pioneerPlayerId = playerId;
    state.pioneerVillageId = villageId;
    state.targets = this.buildTargets(rules);
    state.site = { point: this.sitePoint(), guardElapsedMs: 0 };
    state.relic = { code: rules.relicCode, status: 'at_sanctum' };
    player.joinedAt ??= this.now();
    player.activatedAt = this.now();
    // 先持久化，再通知其它 owner；之后的并发 Activate 一定会看到 active。
    this.save(state);

    // 先冻结所有公共目标和隐藏圣地坐标，再生成首发者唯一的一条「视野外最近条件」
    // 提示。它是便利信息而非免费完成，也不会含精确坐标。
    await this.ensureActivityWorld(state);
    await this.grantPioneerLead(state, playerId, villageId);
    // 残印在启用后不应继续成为多份长期道具。Treasure owner 负责精确消费库存/待领取/携带中的 token。
    await this.commands.send({ name: 'treasure.ConsumeEventToken', from: SanctumModule.NAME, payload: { code: text(this.eventRow(), 'fragmentTreasureCode', 'fragment_treasure_code') || 'sanctum_fragment' } });

    await this.advanceTask(villageId, 's23', 1, true);
    await this.bus.emit({
      name: 'sanctum.Activated', source: SanctumModule.NAME, ts: this.now(),
      payload: { roundId: state.roundId, pioneerPlayerId: playerId, pioneerVillageId: villageId, targetIds: Object.keys(state.targets) },
    } as DomainEvent);
    // 活动开启后所有玩家都可手动接取 s23；任务 owner 负责逐村创建 offer，
    // Sanctum 只触发其既有刷新通道。
    await this.commands.send({ name: 'task.RefreshExternalOffers', from: SanctumModule.NAME, payload: { allPlayers: true } });
    await this.emitAllUpdated(state, 'activated');
    return { ok: true, payload: { activated: true, roundId: state.roundId, pioneer: true, targetCount: Object.keys(state.targets).length } };
  }

  private async joinAlreadyActiveActivation(state: SanctumState, playerId: string, villageId: string): Promise<CommandResult> {
    const player = this.ensurePlayer(state, playerId);
    if (!player.joinedAt) player.joinedAt = this.now();
    this.save(state);
    await this.advanceTask(villageId, 's23', 1, true);
    await this.commands.send({ name: 'task.RefreshExternalOffers', from: SanctumModule.NAME, payload: { villageId, playerId } });
    await this.emitPlayerUpdated(state, playerId, 'already_active_joined');
    return { ok: true, payload: { activated: false, alreadyActive: true, pioneerPlayerId: state.pioneerPlayerId } };
  }

  /** 已开启后，普通玩家在 s23 确认“开始寻迹”时加入。 */
  private async join(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId } = cmd.payload as { playerId?: string; villageId?: string };
    if (!playerId || !villageId) return { ok: false, payload: {}, reason: 'player_and_village_required' };
    const allowed = await this.taskAllows(villageId, 's23');
    if (!allowed.ok) return allowed;
    const state = this.load();
    if (state.phase !== 'active') return { ok: false, payload: {}, reason: state.phase === 'ended' ? 'sanctum_ended' : 'sanctum_not_active' };
    const player = this.ensurePlayer(state, playerId);
    player.joinedAt ??= this.now();
    player.activatedAt ??= this.now();
    this.save(state);
    await this.advanceTask(villageId, 's23', 1, true);
    await this.commands.send({ name: 'task.RefreshExternalOffers', from: SanctumModule.NAME, payload: { villageId, playerId } });
    await this.bus.emit({ name: 'sanctum.PlayerJoined', source: SanctumModule.NAME, ts: this.now(), payload: { playerId, villageId, roundId: state.roundId } } as DomainEvent);
    await this.emitPlayerUpdated(state, playerId, 'joined');
    return { ok: true, payload: { roundId: state.roundId, joined: true } };
  }

  private validTarget(state: SanctumState, targetId: string): SanctumTarget | undefined {
    const target = state.targets[targetId];
    if (!target || target.status === 'removed') return undefined;
    if (target.completionLimit > 0 && target.completionCount >= target.completionLimit) return undefined;
    return target;
  }

  private requestedTargetId(payload: Record<string, unknown>): string {
    return String(payload.targetId ?? payload.conditionId ?? '');
  }

  private validRound(state: SanctumState, payload: Record<string, unknown>): boolean {
    const supplied = String(payload.roundId ?? '');
    return !supplied || supplied === state.roundId;
  }

  private canUseTarget(state: SanctumState, player: SanctumPlayerState, target: SanctumTarget): string | undefined {
    if (state.phase !== 'active') return 'sanctum_not_active';
    if (!player.joinedAt) return 'sanctum_not_joined';
    if (target.status === 'removed') return 'target_removed';
    if (target.completionLimit > 0 && target.completionCount >= target.completionLimit) return 'target_completed';
    // 可重复条件在任意一位玩家成功后按 CSV 的 refreshSec 冷却；这是目标的
    // 公共重整时间，不能只靠前端隐藏按钮，否则并发请求会绕过它。
    if (target.cooldownUntil && target.cooldownUntil > this.now()) return 'target_refreshing';
    const def = this.targetDef(target);
    const previous = target.completedAtBy[player.playerId];
    if (previous && def && previous + def.cooldownMs > this.now()) return 'player_condition_cooldown';
    return undefined;
  }

  private async beginCondition(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as Record<string, unknown>;
    const playerId = typeof payload.playerId === 'string' ? payload.playerId : undefined;
    const targetId = this.requestedTargetId(payload);
    if (!playerId || !targetId) return { ok: false, payload: {}, reason: 'player_and_target_required' };
    const state = this.load();
    if (!this.validRound(state, payload)) return { ok: false, payload: {}, reason: 'sanctum_round_mismatch' };
    const player = this.ensurePlayer(state, playerId);
    const target = this.validTarget(state, targetId);
    if (!target) return { ok: false, payload: {}, reason: 'target_not_available' };
    const reason = this.canUseTarget(state, player, target);
    if (reason) return { ok: false, payload: {}, reason };
    target.startedBy[playerId] ??= this.now();
    if (target.status === 'open') target.status = 'in_progress';
    target.updatedAt = this.now();
    this.save(state);
    await this.emitPlayerUpdated(state, playerId, 'condition_started');
    return { ok: true, payload: { target: this.sanitizeTarget(state, target, player), puzzle: this.publicPuzzle(target) } };
  }

  private publicPuzzle(target: SanctumTarget): Record<string, unknown> | undefined {
    if (!target.puzzleCode) return undefined;
    const puzzle = rows(this.view().sanctumPuzzles).find((row) => text(row, 'code', 'id') === target.puzzleCode);
    if (!puzzle) return { code: target.puzzleCode };
    // 只挑题干和可选符号；sequence/answer/solution 等字段绝不可下发。
    const rawSymbols = puzzle.symbols ?? puzzle.options ?? puzzle.allowedSymbols;
    const symbols = Array.isArray(rawSymbols) ? rawSymbols.map(String) : text(puzzle, 'symbols', 'options', 'allowedSymbols').split('|').filter(Boolean);
    return {
      code: target.puzzleCode,
      title: text(puzzle, 'title', 'name'),
      prompt: text(puzzle, 'prompt', 'question', 'description'),
      symbols,
      steps: Math.max(0, Math.floor(finite(puzzle, 0, 'steps', 'stepCount', 'step_count'))),
    };
  }

  private expectedRune(target: SanctumTarget): string[] | undefined {
    if (!target.puzzleCode) return undefined;
    const puzzle = rows(this.view().sanctumPuzzles).find((row) => text(row, 'code', 'id') === target.puzzleCode);
    const packed = text(puzzle, 'answer', 'sequence', 'solution');
    if (packed) return packed.split(/[>,|，,\s]+/).map((part) => part.trim()).filter(Boolean);
    const steps = rows(this.view().sanctumPuzzleSteps)
      .filter((row) => text(row, 'puzzleCode', 'puzzle_code', 'code') === target.puzzleCode)
      .sort((a, b) => finite(a, 0, 'step', 'order', 'id') - finite(b, 0, 'step', 'order', 'id'))
      .map((row) => text(row, 'answer', 'symbol', 'solution'))
      .filter(Boolean);
    return steps.length ? steps : undefined;
  }

  private async submitRune(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as Record<string, unknown>;
    const playerId = typeof payload.playerId === 'string' ? payload.playerId : undefined;
    const villageId = typeof payload.villageId === 'string' ? payload.villageId : typeof payload.sourceVillageId === 'string' ? payload.sourceVillageId : undefined;
    const targetId = this.requestedTargetId(payload);
    const sequence = payload.sequence;
    const answer = payload.answer;
    const submitted = Array.isArray(sequence) ? sequence : answer;
    if (!playerId || !targetId || !Array.isArray(submitted)) return { ok: false, payload: {}, reason: 'player_target_and_sequence_required' };
    const state = this.load();
    if (!this.validRound(state, payload)) return { ok: false, payload: {}, reason: 'sanctum_round_mismatch' };
    const player = this.ensurePlayer(state, playerId);
    const target = this.validTarget(state, targetId);
    if (!target || !target.puzzleCode) return { ok: false, payload: {}, reason: 'rune_target_not_available' };
    const reason = this.canUseTarget(state, player, target);
    if (reason) return { ok: false, payload: {}, reason };
    if (!target.startedBy[playerId]) return { ok: false, payload: {}, reason: 'condition_not_started' };
    const expected = this.expectedRune(target);
    if (!expected) return { ok: false, payload: {}, reason: 'rune_not_configured' };
    const actual = submitted.map((item) => String(item).trim()).filter(Boolean);
    const correct = actual.length === expected.length && actual.every((item, index) => item === expected[index]);
    if (!correct) {
      await this.emitPlayerUpdated(state, playerId, 'rune_failed');
      return { ok: true, payload: { correct: false } };
    }
    return this.completeTarget(state, player, target, villageId, 'rune');
  }

  /** 供 PvE、商队、护送与合作 owner 在其真实结算后调用；不面向 Gateway。 */
  private async completeConditionCommand(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId, targetId, source } = cmd.payload as { playerId?: string; villageId?: string; targetId?: string; source?: string };
    if (!playerId || !targetId) return { ok: false, payload: {}, reason: 'player_and_target_required' };
    // 只允许明确的领域 owner 写入真实完成，避免今后不小心把该命令暴露成客户端刷进度口。
    if (!['movement', 'pve', 'combat', 'trade', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const state = this.load();
    const player = this.ensurePlayer(state, playerId);
    const target = this.validTarget(state, targetId);
    if (!target) return { ok: false, payload: {}, reason: 'target_not_available' };
    const reason = this.canUseTarget(state, player, target);
    if (reason) return { ok: false, payload: {}, reason };
    return this.completeTarget(state, player, target, villageId, source || cmd.from);
  }

  private async completeTarget(state: SanctumState, player: SanctumPlayerState, target: SanctumTarget, villageId: string | undefined, source: string): Promise<CommandResult> {
    const now = this.now();
    const investigation = target.investigations?.[player.playerId];
    if (investigation) {
      this.scheduler.cancelByOwner(this.investigationOwner(state.roundId, target.id, player.playerId));
      delete target.investigations[player.playerId];
    }
    // 同一玩家同一次实例的重复回调不再产生第二个条件记录。
    const existing = player.conditionRecords.find((record) => record.targetId === target.id && record.completedAt === now);
    if (existing) return { ok: true, payload: { duplicate: true, record: { ...existing } } };
    target.completionCount += 1;
    target.completedBy = Array.from(new Set([...(target.completedBy ?? []), player.playerId]));
    target.completedAtBy[player.playerId] = now;
    target.updatedAt = now;
    const exhausted = target.completionLimit > 0 && target.completionCount >= target.completionLimit;
    if (exhausted) {
      // 低/高难度一次性条件完成后从公共地图消失；玩家的个人条件记录和线索
      // 仍持久保留，不能因清理地图而丢失已取得资格。
      target.status = 'removed';
    } else {
      target.status = 'open';
      const def = this.targetDef(target);
      // `refreshSec` 是这一处公共目标的重整时间；`personalCooldownSec`
      // 只限制刚完成的玩家。两者不能复用，否则改短个人冷却会意外让整张
      // 地图的公共目标提前重生。
      if (def && def.refreshMs > 0) target.cooldownUntil = now + def.refreshMs;
      else delete target.cooldownUntil;
      // `startedBy` 是本轮尝试的门票而非永久资格。可重复目标完成后必须清掉，
      // 否则个人冷却结束时 UI 仍会把玩家当作“正在进行”，再也不能开始下一轮。
      delete target.startedBy[player.playerId];
    }
    const record: SanctumConditionRecord = {
      id: `${target.id}:${player.playerId}:${now}`,
      targetId: target.id,
      code: target.code,
      completedAt: now,
      rewardStatus: 'pending',
    };
    const clue = await this.makeClue(state, target, player, villageId);
    if (clue) {
      player.clues.push(clue);
      record.clueId = clue.id;
    }
    player.conditionRecords.push(record);
    const justQualified = !player.qualifiedAt && player.conditionRecords.length >= this.playerRequiredConditions(state);
    if (justQualified) player.qualifiedAt = now;
    this.save(state);

    if (exhausted && target.pveId) {
      await this.commands.send({ name: 'pve.Remove', from: SanctumModule.NAME, payload: { id: target.pveId } });
    }

    if (justQualified) await this.ensureActivityWorld(state);

    if (villageId) await this.advanceTask(villageId, 's24', player.conditionRecords.length, !!player.qualifiedAt);
    await this.bus.emit({
      name: 'sanctum.ConditionCompleted', source: SanctumModule.NAME, ts: now,
      payload: { roundId: state.roundId, playerId: player.playerId, villageId, targetId: target.id, code: target.code, source, progress: player.conditionRecords.length, qualified: !!player.qualifiedAt },
    } as DomainEvent);
    if (justQualified) {
      await this.bus.emit({ name: 'sanctum.Qualified', source: SanctumModule.NAME, ts: now, payload: { playerId: player.playerId, villageId, roundId: state.roundId } } as DomainEvent);
    }
    await this.grantConditionReward(state, player, target, record, villageId);
    await this.emitPlayerUpdated(state, player.playerId, 'condition_completed');
    return { ok: true, payload: { completed: true, record: { ...record }, progress: player.conditionRecords.length, qualified: !!player.qualifiedAt } };
  }

  private async playerPoint(villageId: string | undefined): Promise<SanctumPoint | undefined> {
    if (!villageId) return undefined;
    const tile = await this.commands.send({ name: 'world.GetTileByRef', from: SanctumModule.NAME, payload: { refId: villageId, kind: 'village' } });
    const raw = (tile.payload as { tile?: { q?: unknown; r?: unknown } })?.tile;
    const q = Number(raw?.q), r = Number(raw?.r);
    return tile.ok && Number.isFinite(q) && Number.isFinite(r) ? { q: Math.floor(q), r: Math.floor(r) } : undefined;
  }

  private directionFrom(from: SanctumPoint | undefined, to: SanctumPoint | undefined): string {
    if (!from || !to) return '远方';
    const dq = to.q - from.q, dr = to.r - from.r;
    if (Math.abs(dq) >= Math.abs(dr)) return dq >= 0 ? '东' : '西';
    return dr >= 0 ? '南' : '北';
  }

  private async distanceFrom(from: SanctumPoint | undefined, to: SanctumPoint | undefined): Promise<string> {
    if (!from || !to) return '很远';
    const distance = await this.commands.send({ name: 'world.Distance', from: SanctumModule.NAME, payload: { from, to } });
    const value = Math.max(0, Math.floor(Number((distance.payload as { distance?: unknown })?.distance) || 0));
    return value <= 3 ? '不远' : value <= 8 ? '约数格' : value <= 15 ? '十余格' : '遥远的数十格';
  }

  private async makeClue(state: SanctumState, target: SanctumTarget, player: SanctumPlayerState, villageId?: string): Promise<SanctumClueRecord | undefined> {
    const clueRows = rows(this.view().sanctumClues).filter((row) => {
      const code = text(row, 'conditionCode', 'condition_code', 'code');
      return !code || code === target.code;
    });
    const index = player.clues.length % Math.max(1, clueRows.length);
    const configured = clueRows[index];
    const template = text(configured, 'text', 'template', 'hint', 'description') || `你从${target.name}得到了一段关于远弦圣地的线索。`;
    const from = await this.playerPoint(villageId);
    const to = state.site.point;
    const direction = this.directionFrom(from, to);
    const distance = await this.distanceFrom(from, to);
    // 区域是刻意模糊的地图分区提示；绝不在文本里插入 q/r。
    const region = to ? `${to.q < this.config.constants.worldW / 3 ? '西境' : to.q > this.config.constants.worldW * 2 / 3 ? '东境' : '中部'}${to.r < this.config.constants.worldH / 3 ? '北缘' : to.r > this.config.constants.worldH * 2 / 3 ? '南缘' : '腹地'}` : '未知区域';
    const rendered = template.replaceAll('{direction}', direction).replaceAll('{distance}', distance).replaceAll('{region}', region);
    return { id: `${target.id}:clue:${player.playerId}:${this.now()}`, targetId: target.id, code: target.code, text: rendered, createdAt: this.now() };
  }

  private rewardPlan(def: ConditionDef | undefined, materializeRandom = true): RewardPlan {
    const plan: RewardPlan = { resources: {}, reputation: 0, researchPoints: 0, treasureCodes: [], deferredEffects: [] };
    for (const reward of def?.rewards ?? []) {
      const kind = text(reward, 'kind');
      const params = text(reward, 'params');
      if (kind === 'grant_resources') {
        for (const segment of params.split('|')) {
          const [key, raw] = segment.split(':', 2);
          const amount = Math.max(0, Math.floor(Number(raw) || 0));
          if ((RESOURCE_KEYS as readonly string[]).includes(key) && amount > 0) plan.resources[key] = (plan.resources[key] ?? 0) + amount;
        }
      } else if (kind === 'grant_random_resource') {
        const amount = Math.max(0, Math.floor(Number(params) || 0));
        // 随机资源由结算时选出；这里只保留公开的“随机资源”描述，不能在面板
        // 预先锁死结果。首版用 Math.random，后续可由 app 注入可复现实验 RNG。
        if (amount > 0 && materializeRandom) {
          const key = RESOURCE_KEYS[Math.floor(Math.random() * RESOURCE_KEYS.length)] ?? 'wood';
          plan.resources[key] = (plan.resources[key] ?? 0) + amount;
        } else if (amount > 0) {
          plan.deferredEffects.push({ kind, params });
        }
      } else if (kind === 'adjust_reputation') {
        plan.reputation += Math.floor(Number(params) || 0);
      } else if (kind === 'grant_research_points') {
        plan.researchPoints += Math.max(0, Math.floor(Number(params) || 0));
      } else if (kind === 'grant_treasure') {
        if (params) plan.treasureCodes.push(params);
      } else if (kind) {
        // 可配置但尚未接入通用 owner 的效果（例如临时军队视野）不能被悄悄吞掉；
        // 记录在事件投影里，接入 owner 后可按相同配置兑现。
        plan.deferredEffects.push({ kind, params });
      }
    }
    return plan;
  }

  /** 奖励不足/满栏由各 owner 处理；失败保留 pending，resume 或下一次读取可重试。 */
  private async grantConditionReward(state: SanctumState, player: SanctumPlayerState, target: SanctumTarget, record: SanctumConditionRecord, villageId: string | undefined): Promise<void> {
    if (!villageId) return;
    const plan = this.rewardPlan(this.targetDef(target));
    if (Object.keys(plan.resources).length) {
      const resource = await this.commands.send({ name: 'economy.Grant', from: SanctumModule.NAME, payload: { villageId, gain: plan.resources } });
      if (!resource.ok) return;
    }
    if (plan.reputation) {
      const reputation = await this.commands.send({ name: 'reputation.Adjust', from: SanctumModule.NAME, payload: { playerId: player.playerId, delta: plan.reputation, reason: `sanctum:${target.code}` } });
      if (!reputation.ok) return;
    }
    if (plan.researchPoints) {
      const research = await this.commands.send({ name: 'research.GrantPoints', from: SanctumModule.NAME, payload: { villageId, amount: plan.researchPoints, reason: `sanctum:${target.code}` } });
      if (!research.ok) return;
    }
    for (const code of plan.treasureCodes) {
      // 指定接收人的唯一宝物由合作结算接入层预先锁定 recipient；还未锁定时不把
      // 奖励错误发给任意参与者，保留 pending 交给该接入完成后再结算。
      const def = this.targetDef(target);
      const configured = def?.rewards.find((item) => text(item, 'kind') === 'grant_treasure' && text(item, 'params') === code);
      if (text(configured, 'recipient') === 'designated_recipient' && target.rewardRecipientPlayerId !== player.playerId) return;
      const treasure = await this.commands.send({ name: 'treasure.Grant', from: SanctumModule.NAME, payload: { villageId, code, pendingIfFull: true, rewardVillageId: villageId } });
      if (!treasure.ok) return;
    }
    const current = this.load();
    const currentPlayer = current.players[player.playerId];
    const currentRecord = currentPlayer?.conditionRecords.find((item) => item.id === record.id);
    if (currentRecord && currentRecord.rewardStatus !== 'granted') {
      currentRecord.rewardStatus = 'granted';
      this.save(current);
    }
  }

  private async flushPendingRewards(state: SanctumState): Promise<void> {
    if (state.phase === 'dormant') return;
    for (const player of Object.values(state.players)) {
      for (const record of player.conditionRecords.filter((item) => item.rewardStatus === 'pending')) {
        const target = state.targets[record.targetId];
        if (!target) continue;
        // 缺少稳定的执行村不能猜测发到哪座村；等待下一次真实事件结算或 task 回调。
        const villageId = state.pioneerPlayerId === player.playerId ? state.pioneerVillageId : undefined;
        if (villageId) await this.grantConditionReward(state, player, target, record, villageId);
      }
    }
  }

  /** 资源/兵力贡献：资源先由 Economy 原子扣除，随后才更新事件累计。 */
  private async contribute(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as Record<string, unknown>;
    const playerId = typeof payload.playerId === 'string' ? payload.playerId : undefined;
    const villageId = typeof payload.villageId === 'string' ? payload.villageId : typeof payload.sourceVillageId === 'string' ? payload.sourceVillageId : undefined;
    const targetId = this.requestedTargetId(payload);
    const resources = payload.resources;
    const troops = payload.troops;
    if (!playerId || !villageId || !targetId) return { ok: false, payload: {}, reason: 'player_village_and_target_required' };
    if (!(await this.ownsVillage(playerId, villageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const state = this.load();
    if (!this.validRound(state, payload)) return { ok: false, payload: {}, reason: 'sanctum_round_mismatch' };
    const player = this.ensurePlayer(state, playerId);
    const target = this.validTarget(state, targetId);
    if (!target) return { ok: false, payload: {}, reason: 'target_not_available' };
    const reason = this.canUseTarget(state, player, target);
    if (reason) return { ok: false, payload: {}, reason };
    const requested = resourceMap(asRow(resources));
    if (Object.keys(requested).length) {
      const paid = await this.commands.send({ name: 'economy.TrySpend', from: SanctumModule.NAME, payload: { villageId, cost: requested } });
      if (!paid.ok) return paid;
    }
    const troopMap: Record<string, number> = {};
    for (const [code, amount] of Object.entries(asRow(troops) ?? {})) {
      const count = Math.max(0, Math.floor(Number(amount) || 0));
      if (count) troopMap[code] = count;
    }
    const contribution: SanctumConditionContribution = target.contributions[playerId] ?? { playerId, villageId, resources: {}, troops: {}, updatedAt: this.now() };
    contribution.villageId = villageId;
    for (const [key, amount] of Object.entries(requested)) contribution.resources[key] = (contribution.resources[key] ?? 0) + amount;
    for (const [key, amount] of Object.entries(troopMap)) contribution.troops[key] = (contribution.troops[key] ?? 0) + amount;
    contribution.preparedAt ??= this.now();
    contribution.updatedAt = this.now();
    target.contributions[playerId] = contribution;
    target.status = 'in_progress';
    target.updatedAt = this.now();
    this.save(state);
    await this.bus.emit({ name: 'sanctum.Contributed', source: SanctumModule.NAME, ts: this.now(), payload: { playerId, villageId, targetId, resources: requested, troops: troopMap } } as DomainEvent);
    const completed = await this.tryCompleteContributionTarget(state, player, target, villageId);
    if (completed) return completed;
    await this.emitPlayerUpdated(state, playerId, 'contributed');
    return { ok: true, payload: { contribution: structuredClone(contribution) } };
  }

  /**
   * 资源型条件的门槛永远从已落盘的实际贡献累计计算。C04/C11 可按总基础资源
   * 完成；同步仪式还要求达到配置中的参与人数与每人资源门槛。运输 owner 接入后
   * 只需在商队抵达时调用同一贡献命令，结算规则无需复制。
   */
  private async tryCompleteContributionTarget(state: SanctumState, player: SanctumPlayerState, target: SanctumTarget, villageId: string): Promise<CommandResult | undefined> {
    const def = this.targetDef(target);
    if (!def || !['resource_delivery', 'synchronous_ritual'].includes(target.type)) return undefined;
    const all = Object.values(target.contributions);
    const basic = (row: SanctumConditionContribution): number => ['wood', 'clay', 'iron', 'crop']
      .reduce((sum, key) => sum + Math.max(0, Number(row.resources[key]) || 0), 0);
    const totalNeed = numericParam(def.params, 'totalBasicResources');
    const eachNeed = numericParam(def.params, 'resourceEach');
    const own = target.contributions[player.playerId];
    if (!own) return undefined;
    const enoughTotal = totalNeed <= 0 || all.reduce((sum, row) => sum + basic(row), 0) >= totalNeed;
    const eligible = all.filter((row) => eachNeed <= 0 || basic(row) >= eachNeed);
    const enoughPeople = eligible.length >= def.minPlayers;
    if (!enoughTotal || !enoughPeople || (eachNeed > 0 && basic(own) < eachNeed)) return undefined;
    return this.completeTarget(state, player, target, villageId, 'resource_contribution');
  }

  /** s25：移动 owner 已确认实地调查后才可记录个人圣地坐标。 */
  private async discover(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as { playerId?: string; villageId?: string; sourceVillageId?: string; movementId?: string };
    const playerId = payload.playerId;
    const villageId = payload.villageId ?? payload.sourceVillageId;
    const movementId = payload.movementId;
    if (!playerId || !villageId) return { ok: false, payload: {}, reason: 'player_and_village_required' };
    if (!(await this.ownsVillage(playerId, villageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const state = this.load();
    const player = this.ensurePlayer(state, playerId);
    if (state.phase !== 'active' || !this.isQualified(state, player)) return { ok: false, payload: {}, reason: 'sanctum_not_qualified' };
    const site = state.site.point;
    if (!site) return { ok: false, payload: {}, reason: 'sanctum_coordinate_not_configured' };
    const presence = await this.commands.send({ name: 'movement.ValidateSanctumPresence', from: SanctumModule.NAME, payload: { playerId, villageId, movementId, q: site.q, r: site.r, purpose: 'discover' } });
    if (!presence.ok) return presence;
    player.discoveredAt ??= this.now();
    this.save(state);
    await this.advanceTask(villageId, 's25', 1, true);
    await this.bus.emit({ name: 'sanctum.Discovered', source: SanctumModule.NAME, ts: this.now(), payload: { playerId, villageId, roundId: state.roundId } } as DomainEvent);
    await this.emitPlayerUpdated(state, playerId, 'discovered');
    return { ok: true, payload: { discovered: true, q: site.q, r: site.r } };
  }

  /** s27：确认实际圣地交战/驻军结束后的主指挥占领。 */
  private async claim(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as { playerId?: string; villageId?: string; sourceVillageId?: string; movementId?: string };
    const playerId = payload.playerId;
    const villageId = payload.villageId ?? payload.sourceVillageId;
    const movementId = payload.movementId;
    if (!playerId || !villageId) return { ok: false, payload: {}, reason: 'player_and_village_required' };
    if (!(await this.ownsVillage(playerId, villageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const state = this.load();
    const player = this.ensurePlayer(state, playerId);
    if (state.phase !== 'active' || !this.isQualified(state, player) || !player.discoveredAt || !player.siteDialogueAt) return { ok: false, payload: {}, reason: 'sanctum_not_qualified' };
    if (!state.site.pveClearedAt) return { ok: false, payload: {}, reason: 'sanctum_guard_not_cleared' };
    if (state.site.occupantPlayerId && state.site.occupantPlayerId !== playerId) return { ok: false, payload: {}, reason: 'sanctum_occupied' };
    const site = state.site.point;
    if (!site) return { ok: false, payload: {}, reason: 'sanctum_coordinate_not_configured' };
    const presence = await this.commands.send({ name: 'movement.ValidateSanctumPresence', from: SanctumModule.NAME, payload: { playerId, villageId, movementId, q: site.q, r: site.r, purpose: 'claim' } });
    if (!presence.ok) return presence;
    const now = this.now();
    const newOccupant = state.site.occupantPlayerId !== playerId;
    state.site.occupantPlayerId = playerId;
    state.site.occupantVillageId = villageId;
    state.site.occupantMovementId = movementId;
    state.site.guardPausedAt = undefined;
    if (newOccupant) {
      state.site.guardElapsedMs = 0;
      state.site.guardStartedAt = now;
      state.site.guardDueAt = now + (state.rules?.guardDurationMs ?? this.rules().guardDurationMs);
      player.claimedAt ??= now;
    }
    this.save(state);
    this.armGuard(state);
    await this.advanceTask(villageId, 's27', 1, true);
    await this.bus.emit({ name: 'sanctum.Claimed', source: SanctumModule.NAME, ts: now, payload: { playerId, villageId, movementId, roundId: state.roundId } } as DomainEvent);
    await this.emitPlayerUpdated(state, playerId, 'claimed');
    return { ok: true, payload: { claimed: true, guardDueAt: state.site.guardDueAt } };
  }

  private guardOwner(roundId: string): string { return `sanctum-guard:${roundId}`; }

  private investigationOwner(roundId: string, targetId: string, playerId: string): string {
    return `sanctum-investigate:${roundId}:${targetId}:${playerId}`;
  }

  /** 调查倒计时只由 Scheduler 驱动；客户端的显示倒计时没有写入权限。 */
  private armInvestigation(state: SanctumState, target: SanctumTarget, investigation: SanctumInvestigation): void {
    const owner = this.investigationOwner(state.roundId, target.id, investigation.playerId);
    this.scheduler.cancelByOwner(owner);
    this.scheduler.scheduleAt(
      Math.max(this.now(), investigation.dueAt),
      () => this.finishInvestigation(state.roundId, target.id, investigation.playerId, investigation.movementId, investigation.dueAt),
      owner,
      `sanctum:${state.roundId}`,
    );
  }

  /**
   * 仅驻留中的原军队可完成 `holdSec` 条件。若中途撤离、战败或换到其它格，
   * 本轮调查失效，玩家必须重新抵达后再开始，而不会把旧倒计时带走。
   */
  private async finishInvestigation(roundId: string, targetId: string, playerId: string, movementId: string, dueAt: number): Promise<void> {
    let state = this.load();
    if (state.roundId !== roundId || state.phase !== 'active') return;
    let target = this.validTarget(state, targetId);
    let investigation = target?.investigations?.[playerId];
    if (!target || !investigation || !state.players[playerId] || investigation.movementId !== movementId || investigation.dueAt !== dueAt) return;
    if (dueAt > this.now()) { this.armInvestigation(state, target, investigation); return; }
    const status = await this.commands.send({
      name: 'movement.GetSanctumDefenderStatus', from: SanctumModule.NAME, payload: { movementId },
    });
    const payload = status.payload as { stillStationed?: unknown; pos?: { q?: unknown; r?: unknown } };
    const stillThere = status.ok && payload.stillStationed === true
      && Number(payload.pos?.q) === investigation.point.q && Number(payload.pos?.r) === investigation.point.r;
    // The movement status query is asynchronous. A movement event (or another
    // scheduler callback) may have changed the round while it was in flight.
    // Reload and revalidate before mutating anything so a stale callback cannot
    // overwrite a newer investigation/condition record snapshot.
    state = this.load();
    if (state.roundId !== roundId || state.phase !== 'active') return;
    target = this.validTarget(state, targetId);
    investigation = target?.investigations?.[playerId];
    const player = state.players[playerId];
    if (!target || !investigation || !player || investigation.movementId !== movementId || investigation.dueAt !== dueAt) return;
    if (!stillThere) {
      delete target.investigations[playerId];
      this.save(state);
      await this.emitPlayerUpdated(state, playerId, 'investigation_interrupted');
      return;
    }
    delete target.investigations[playerId];
    await this.completeTarget(state, player, target, investigation.villageId, 'investigation_hold');
  }

  private armGuard(state: SanctumState): void {
    this.scheduler.cancelByOwner(this.guardOwner(state.roundId));
    if (state.phase !== 'active' || !state.site.occupantPlayerId || state.site.guardPausedAt || !state.site.guardDueAt) return;
    this.scheduler.scheduleAt(state.site.guardDueAt, () => this.finishGuard(state.roundId), this.guardOwner(state.roundId), `sanctum:${state.roundId}`);
  }

  private async finishGuard(roundId: string): Promise<void> {
    const state = this.load();
    if (state.roundId !== roundId || state.phase !== 'active' || !state.site.occupantPlayerId || state.site.guardPausedAt) return;
    if (!state.site.guardDueAt || state.site.guardDueAt > this.now()) { this.armGuard(state); return; }
    const player = this.ensurePlayer(state, state.site.occupantPlayerId);
    if (player.guardRewardedAt) return;
    const now = this.now();
    player.guardRewardedAt = now;
    state.site.guardElapsedMs = state.rules?.guardDurationMs ?? this.rules().guardDurationMs;
    this.save(state);
    if (state.site.occupantVillageId) await this.advanceTask(state.site.occupantVillageId, 's28', 1, true);
    await this.bus.emit({ name: 'sanctum.GuardCompleted', source: SanctumModule.NAME, ts: now, payload: { playerId: player.playerId, villageId: state.site.occupantVillageId, roundId } } as DomainEvent);
    await this.emitPlayerUpdated(state, player.playerId, 'guard_completed');
  }

  private pauseGuard(cmd: Command): CommandResult {
    if (!['combat', 'movement', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const { playerId } = cmd.payload as { playerId?: string };
    const state = this.load();
    if (!playerId || state.site.occupantPlayerId !== playerId || !state.site.guardDueAt || state.site.guardPausedAt) return { ok: false, payload: {}, reason: 'guard_not_running' };
    const elapsed = Math.max(0, (state.rules?.guardDurationMs ?? this.rules().guardDurationMs) - Math.max(0, state.site.guardDueAt - this.now()));
    state.site.guardElapsedMs = Math.max(state.site.guardElapsedMs, elapsed);
    state.site.guardPausedAt = this.now();
    this.scheduler.cancelByOwner(this.guardOwner(state.roundId));
    this.save(state);
    return { ok: true, payload: { pausedAt: state.site.guardPausedAt, guardElapsedMs: state.site.guardElapsedMs } };
  }

  private resumeGuard(cmd: Command): CommandResult {
    if (!['combat', 'movement', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const { playerId } = cmd.payload as { playerId?: string };
    const state = this.load();
    if (!playerId || state.site.occupantPlayerId !== playerId || !state.site.guardPausedAt) return { ok: false, payload: {}, reason: 'guard_not_paused' };
    const duration = state.rules?.guardDurationMs ?? this.rules().guardDurationMs;
    state.site.guardPausedAt = undefined;
    state.site.guardStartedAt = this.now() - state.site.guardElapsedMs;
    state.site.guardDueAt = this.now() + Math.max(0, duration - state.site.guardElapsedMs);
    this.save(state);
    this.armGuard(state);
    return { ok: true, payload: { guardDueAt: state.site.guardDueAt, guardElapsedMs: state.site.guardElapsedMs } };
  }

  /** 失守、全撤或主动放弃：只由移动/战斗 owner 调用，且会清零本次守卫。 */
  private releaseClaim(cmd: Command): CommandResult {
    if (!['combat', 'movement', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const { playerId } = cmd.payload as { playerId?: string };
    const state = this.load();
    if (!playerId || state.site.occupantPlayerId !== playerId) return { ok: true, payload: { released: false } };
    state.site.occupantPlayerId = undefined;
    state.site.occupantVillageId = undefined;
    state.site.occupantMovementId = undefined;
    state.site.guardStartedAt = undefined;
    state.site.guardDueAt = undefined;
    state.site.guardPausedAt = undefined;
    state.site.guardElapsedMs = 0;
    this.scheduler.cancelByOwner(this.guardOwner(state.roundId));
    this.save(state);
    return { ok: true, payload: { released: true } };
  }

  /** s29 前的取宝：圣物仅绑定 movementId，不进入普通 treasure.carried，因此途中不生效也不会战败转给胜者。 */
  private async takeRelic(cmd: Command): Promise<CommandResult> {
    const payload = cmd.payload as { playerId?: string; villageId?: string; sourceVillageId?: string; movementId?: string; returnVillageId?: string };
    const playerId = payload.playerId;
    const villageId = payload.villageId ?? payload.sourceVillageId ?? payload.returnVillageId;
    const movementId = payload.movementId;
    const returnVillageId = payload.returnVillageId ?? villageId;
    if (!playerId || !villageId || !returnVillageId) return { ok: false, payload: {}, reason: 'relic_carrier_required' };
    if (!(await this.ownsVillage(playerId, villageId)) || !(await this.ownsVillage(playerId, returnVillageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const state = this.load();
    const player = this.ensurePlayer(state, playerId);
    if (state.phase !== 'active' || state.site.occupantPlayerId !== playerId || state.relic.status !== 'at_sanctum') return { ok: false, payload: {}, reason: 'relic_not_available' };
    if (!player.guardRewardedAt && !player.oldOccupierAt) return { ok: false, payload: {}, reason: 'guard_not_complete' };
    const site = state.site.point;
    if (!site) return { ok: false, payload: {}, reason: 'sanctum_coordinate_not_configured' };
    const carrier = await this.commands.send({ name: 'movement.ValidateSanctumRelicCarrier', from: SanctumModule.NAME, payload: { playerId, villageId, movementId, returnVillageId, q: site.q, r: site.r } });
    if (!carrier.ok) return carrier;
    const now = this.now();
    state.relic = { code: state.rules?.relicCode ?? state.relic.code, status: 'carried', carrierPlayerId: playerId, carrierVillageId: villageId, carrierMovementId: movementId, returnVillageId, takenAt: now };
    player.oldOccupierAt ??= now;
    this.save(state);
    await this.bus.emit({ name: 'sanctum.RelicTaken', source: SanctumModule.NAME, ts: now, payload: { playerId, villageId, movementId, returnVillageId, roundId: state.roundId } } as DomainEvent);
    await this.emitPlayerUpdated(state, playerId, 'relic_taken');
    return { ok: true, payload: { taken: true, relicCode: state.relic.code } };
  }

  private async onMovementReturnedCommand(cmd: Command): Promise<CommandResult> {
    if (cmd.from !== 'movement' && cmd.from !== SanctumModule.NAME) return { ok: false, payload: {}, reason: 'movement_owner_required' };
    const { movementId, villageId, playerId } = cmd.payload as { movementId?: string; villageId?: string; playerId?: string };
    if (!movementId || !villageId || !playerId) return { ok: false, payload: {}, reason: 'movement_village_player_required' };
    return this.settleRelicReturn(movementId, villageId, playerId);
  }

  private async onMovementReturnedEvent(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as { movementId?: string; villageId?: string; playerId?: string; sanctumRelic?: boolean };
    if (!payload.movementId || !payload.villageId || !payload.playerId) return;
    const state = this.load();
    if (state.relic.carrierMovementId !== payload.movementId) return;
    await this.settleRelicReturn(payload.movementId, payload.villageId, payload.playerId);
  }

  private async settleRelicReturn(movementId: string, villageId: string, playerId: string): Promise<CommandResult> {
    const state = this.load();
    if (state.relic.status === 'awarded') return { ok: true, payload: { alreadySettled: true } };
    if (state.relic.status !== 'carried' || state.relic.carrierMovementId !== movementId || state.relic.carrierPlayerId !== playerId || state.relic.returnVillageId !== villageId) {
      return { ok: false, payload: {}, reason: 'relic_movement_mismatch' };
    }
    // 先进入 settling 防重；Grant 失败后恢复 carried，客户端可安全重试/等恢复。
    state.relic.status = 'settling';
    state.relic.settlingAt = this.now();
    this.save(state);
    const grant = await this.commands.send({ name: 'treasure.Grant', from: SanctumModule.NAME, payload: { villageId, code: state.relic.code, pendingIfFull: true, rewardVillageId: villageId } });
    const current = this.load();
    if (!grant.ok) {
      if (current.relic.status === 'settling' && current.relic.carrierMovementId === movementId) {
        current.relic.status = 'carried';
        delete current.relic.settlingAt;
        this.save(current);
      }
      return grant;
    }
    current.relic.status = 'awarded';
    current.relic.awardedPlayerId = playerId;
    current.relic.awardedVillageId = villageId;
    current.relic.awardedAt = this.now();
    current.winnerPlayerId = playerId;
    current.winnerVillageId = villageId;
    current.endedAt = this.now();
    current.phase = 'ended';
    this.scheduler.cancelByOwner(this.guardOwner(current.roundId));
    this.save(current);
    await this.advanceTask(villageId, 's29', 1, true);
    await this.bus.emit({ name: 'sanctum.RelicReturned', source: SanctumModule.NAME, ts: this.now(), payload: { roundId: current.roundId, playerId, villageId, movementId, relicCode: current.relic.code } } as DomainEvent);
    await this.bus.emit({ name: 'sanctum.Ended', source: SanctumModule.NAME, ts: this.now(), payload: { roundId: current.roundId, winnerPlayerId: playerId, winnerVillageId: villageId } } as DomainEvent);
    await this.emitPlayerUpdated(current, playerId, 'relic_returned');
    return { ok: true, payload: { settled: true, pending: Boolean((grant.payload as { pending?: unknown }).pending) } };
  }

  /** 战败、全灭或明确放弃时回归圣地；拦截胜者绝不会获得圣物。 */
  private async onRelicLost(cmd: Command): Promise<CommandResult> {
    if (!['combat', 'movement', 'sanctum'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    const { movementId } = cmd.payload as { movementId?: string };
    if (!movementId) return { ok: false, payload: {}, reason: 'movement_id_required' };
    const state = this.load();
    if (!['carried', 'settling'].includes(state.relic.status) || state.relic.carrierMovementId !== movementId) return { ok: true, payload: { returned: false } };
    const owner = state.relic.carrierPlayerId;
    state.relic = { code: state.rules?.relicCode ?? state.relic.code, status: 'at_sanctum' };
    this.save(state);
    if (owner) await this.emitPlayerUpdated(state, owner, 'relic_lost');
    await this.bus.emit({ name: 'sanctum.RelicReturnedToSite', source: SanctumModule.NAME, ts: this.now(), payload: { roundId: state.roundId, movementId, playerId: owner } } as DomainEvent);
    return { ok: true, payload: { returned: true } };
  }

  /**
   * PvE/贸易/宝物请求的是“本轮还能不能发残印”；任务 owner 请求的是“这名
   * 玩家现在能不能看到对应 s23–s29”。两种语义集中在这里，避免 task 复制活动状态。
   */
  private async tryIssueSeal(cmd: Command): Promise<CommandResult> {
    if (!['pve', 'trade', 'treasure', 'sanctum', 'task'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'event_owner_required' };
    if (!bool(this.eventRow(), true, 'enabled')) return { ok: true, payload: { allowed: false } };
    const payload = cmd.payload as { villageId?: string; code?: string; mode?: string };
    const state = this.load();
    const sealCode = text(this.eventRow(), 'fragmentTreasureCode', 'fragment_treasure_code', 'sealCode', 'seal_code', 'triggerTreasureCode', 'trigger_treasure_code') || 'sanctum_fragment';
    // 掉落 owner 不传 mode；活动一旦被唤醒就永久停止残印掉落。
    if (!payload.mode) return state.phase === 'dormant'
      ? { ok: true, payload: { allowed: true, sealCode, roundId: state.roundId } }
      : { ok: false, payload: {}, reason: 'sanctum_seal_closed' };

    const owner = payload.villageId
      ? await this.commands.send({ name: 'player.GetByVillage', from: SanctumModule.NAME, payload: { villageId: payload.villageId } })
      : undefined;
    const playerId = owner?.ok ? String((owner.payload as { player?: { id?: unknown } }).player?.id ?? '') : '';
    const player = playerId ? state.players[playerId] : undefined;
    const mode = payload.mode;
    let allowed = false;
    if (mode === 'fragment') {
      // 开启前仅真实持有残印者能接 s23；开启后所有玩家都能手动接取 s23，
      // 通过 NPC 对话得知已经发生了什么并加入这一轮。
      allowed = state.phase === 'active' || (state.phase === 'dormant' && await this.hasSeal(payload.villageId));
    } else if (mode === 'active') {
      allowed = state.phase === 'active' && !!player?.joinedAt;
    } else if (mode === 'qualified') {
      allowed = state.phase === 'active' && !!player && this.isQualified(state, player);
    } else if (mode === 'discovered') {
      allowed = state.phase === 'active' && !!player?.discoveredAt;
    } else if (mode === 'briefed') {
      allowed = state.phase === 'active' && !!player?.siteDialogueAt;
    } else if (mode === 'occupied') {
      allowed = state.phase === 'active' && state.site.occupantPlayerId === playerId;
    } else if (mode === 'artifact') {
      allowed = state.phase === 'ended' && state.winnerPlayerId === playerId;
    }
    return { ok: true, payload: { allowed, sealCode, roundId: state.roundId } };
  }

  /** PvE 实际清空才记为对应条件；普通战报、半血守军、前端点击都不能刷进度。 */
  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as {
      movementId?: string; attackerWins?: boolean; side?: string; targetId?: string; targetKind?: string;
      campCleared?: boolean; villageId?: string;
    };
    const state = this.load();
    const now = this.now();

    if (payload.side === 'attacker' && payload.attackerWins && payload.campCleared && payload.targetId) {
      if (state.site.pveId === payload.targetId && !state.site.pveClearedAt) {
        state.site.pveClearedAt = now;
        this.save(state);
        await this.bus.emit({ name: 'sanctum.SiteGuardCleared', source: SanctumModule.NAME, ts: now, payload: { roundId: state.roundId, villageId: payload.villageId } } as DomainEvent);
        await this.emitAllUpdated(state, 'site_guard_cleared');
      }
      const target = Object.values(state.targets).find((candidate) => candidate.pveId === payload.targetId);
      if (target && payload.villageId) {
        const owner = await this.commands.send({ name: 'player.GetByVillage', from: SanctumModule.NAME, payload: { villageId: payload.villageId } });
        const playerId = owner.ok ? String((owner.payload as { player?: { id?: unknown } }).player?.id ?? '') : '';
        const player = playerId ? this.ensurePlayer(state, playerId) : undefined;
        // 条件必须先由玩家显式开始，防止别人顺路清场替未参与者完成任务。
        if (player && target.startedBy[playerId] && !this.canUseTarget(state, player, target)) {
          await this.completeTarget(state, player, target, payload.villageId, 'pve_clear');
        }
      }
    }

    // 携物军队败北或作为防守侧参战时，圣物回到圣地，不转给拦截者。
    if (payload.movementId && state.relic.carrierMovementId === payload.movementId && (payload.attackerWins === false || payload.side === 'defender')) {
      await this.onRelicLost({ name: 'sanctum.OnRelicLost', from: SanctumModule.NAME, payload: { movementId: payload.movementId } });
    }
  }

  private async onTaskAccepted(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as { playerId?: string; villageId?: string; code?: string };
    if (payload.code !== 's23' || !payload.playerId) return;
    await this.registerParticipant({ name: 'sanctum.RegisterParticipant', from: 'task', payload: { playerId: payload.playerId, villageId: payload.villageId } });
  }

  /** s26 的明确对话交付才授予占领资格；关闭对话不会越过这一门槛。 */
  private async onTaskDelivered(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as { code?: string; villageId?: string; rewardVillageId?: string; playerId?: string };
    if (!payload.code || !SANCTUM_TASKS.has(payload.code)) return;
    const villageId = payload.rewardVillageId ?? payload.villageId;
    if (!villageId) return;
    let playerId = payload.playerId;
    if (!playerId) {
      const owner = await this.commands.send({ name: 'player.GetByVillage', from: SanctumModule.NAME, payload: { villageId } });
      playerId = owner.ok ? String((owner.payload as { player?: { id?: unknown } }).player?.id ?? '') : undefined;
    }
    const state = this.load();
    if (payload.code === 's26' && playerId) {
      const player = this.ensurePlayer(state, playerId);
      player.siteDialogueAt ??= this.now();
      this.save(state);
      await this.emitPlayerUpdated(state, playerId, 'site_briefed');
    }
    // Deliver 会先走 task owner 的通用下游解锁；这里再刷新一次，确保刚刚写入的
    // discovered/siteDialogue/occupant 状态已被下一张任务卡读取。
    await this.commands.send({ name: 'task.RefreshExternalOffers', from: SanctumModule.NAME, payload: { villageId, ...(playerId ? { playerId } : {}) } });
  }

  private async onMovementGarrisoned(evt: DomainEvent): Promise<void> {
    await this.onMovementAtPoint(evt, 'garrison');
  }

  private async onMovementExplored(evt: DomainEvent): Promise<void> {
    await this.onMovementAtPoint(evt, 'explore');
  }

  /** 到达由 Movement 认证的实地坐标后再结算调查或圣地发现。 */
  private async onMovementAtPoint(evt: DomainEvent, source: 'garrison' | 'explore'): Promise<void> {
    const payload = evt.payload as { id?: string; villageId?: string; q?: unknown; r?: unknown };
    const villageId = payload.villageId;
    const q = Number(payload.q), r = Number(payload.r);
    if (!villageId || !Number.isFinite(q) || !Number.isFinite(r)) return;
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: SanctumModule.NAME, payload: { villageId } });
    const playerId = owner.ok ? String((owner.payload as { player?: { id?: unknown } }).player?.id ?? '') : '';
    if (!playerId) return;
    const state = this.load();
    if (state.phase !== 'active') return;
    const player = this.ensurePlayer(state, playerId);
    const target = Object.values(state.targets).find((candidate) => candidate.point?.q === Math.floor(q) && candidate.point?.r === Math.floor(r));
    if (target && target.type === 'investigate' && target.startedBy[playerId] && !this.canUseTarget(state, player, target)) {
      const def = this.targetDef(target);
      const holdMs = Math.max(0, numericParam(def?.params ?? {}, 'holdSec') * 1000);
      const movementId = typeof payload.id === 'string' ? payload.id : '';
      if (holdMs > 0) {
        // C01 等驻留调查不接受“探索路过”：必须成为真实驻军，且到期时还在原格。
        if (source !== 'garrison' || !movementId) return;
        const previous = target.investigations[playerId];
        const dueAt = this.now() + holdMs;
        if (!previous || previous.movementId !== movementId || previous.point.q !== Math.floor(q) || previous.point.r !== Math.floor(r)) {
          target.investigations[playerId] = { playerId, villageId, movementId, point: { q: Math.floor(q), r: Math.floor(r) }, dueAt };
          target.updatedAt = this.now();
          this.save(state);
          this.armInvestigation(state, target, target.investigations[playerId]!);
          await this.emitPlayerUpdated(state, playerId, 'investigation_started');
        }
      } else {
        await this.completeTarget(state, player, target, villageId, source);
      }
    }
    const site = state.site.point;
    if (site && site.q === Math.floor(q) && site.r === Math.floor(r) && this.isQualified(state, player) && !player.discoveredAt) {
      player.discoveredAt = this.now();
      this.save(state);
      await this.advanceTask(villageId, 's25', 1, true);
      await this.bus.emit({ name: 'sanctum.Discovered', source: SanctumModule.NAME, ts: this.now(), payload: { playerId, villageId, roundId: state.roundId } } as DomainEvent);
      await this.emitPlayerUpdated(state, playerId, 'discovered_by_march');
    }
  }

  /** 残印实际改变归属后，任务 owner 重新计算对应村的 s23 offer。 */
  private async onFragmentChanged(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as { villageId?: string; code?: string };
    const code = text(this.eventRow(), 'fragmentTreasureCode', 'fragment_treasure_code') || 'sanctum_fragment';
    if (!payload.villageId || payload.code !== code || this.load().phase !== 'dormant') return;
    await this.commands.send({ name: 'task.RefreshExternalOffers', from: SanctumModule.NAME, payload: { villageId: payload.villageId } });
  }

  private async advanceTask(villageId: string, code: string, progress: number, ready: boolean): Promise<void> {
    if (!SANCTUM_TASKS.has(code)) return;
    // 任务尚未接取是正常情况（例如 s25 前置尚未交付）；事件 owner 不能替 task owner
    // 创造实例，忽略 not_active 并让后续任务线按正常流程继续。
    await this.commands.send({ name: 'task.AdvanceExternal', from: SanctumModule.NAME, payload: { villageId, code, progress, ready } });
  }

  private async emitPlayerUpdated(state: SanctumState, playerId: string, reason: string): Promise<void> {
    await this.bus.emit({ name: 'sanctum.Updated', source: SanctumModule.NAME, ts: this.now(), payload: { playerIds: [playerId], roundId: state.roundId, revision: state.revision, reason } } as DomainEvent);
  }

  /** 全服可见的阶段变动定向推给所有已存在玩家，坐标仍由 GetState 的个人投影过滤。 */
  private async emitAllUpdated(state: SanctumState, reason: string): Promise<void> {
    const ids = new Set<string>(Object.keys(state.players));
    for (const player of await this.allPlayers()) ids.add(player.id);
    await this.bus.emit({ name: 'sanctum.Updated', source: SanctumModule.NAME, ts: this.now(), payload: { playerIds: [...ids], roundId: state.roundId, revision: state.revision, reason } } as DomainEvent);
  }
}
