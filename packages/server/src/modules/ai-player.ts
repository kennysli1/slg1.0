import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { EventBus } from '../infra/event-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, AiPersonaCode, AiPersonaDef, AiRosterDef } from '../infra/config.js';

type LifeCycle = 'warming' | 'active' | 'recovering' | 'disabled';
type ActionKind = 'build' | 'upgrade' | 'train' | 'research' | 'pve' | 'scout' | 'trade_create' | 'trade_accept' | 'trade_cancel' | 'alliance_apply' | 'raid' | 'idle';

interface PendingIntent {
  id: string;
  kind: ActionKind;
  preparedAt: number;
  payload: Record<string, unknown>;
}

export interface AiPlayerState {
  rosterId: string;
  playerId: string;
  villageId: string;
  persona: AiPersonaCode;
  seed: number;
  randomCursor: number;
  createdAt: number;
  warmupUntil: number;
  lifecycle: LifeCycle;
  enabled: boolean;
  nextThinkAt: number;
  dayKey: string;
  actionsToday: number;
  primaryGoal: ActionKind;
  goalUntil: number;
  cooldowns: Record<string, number>;
  recentActions: Array<{ kind: ActionKind; at: number; ok: boolean; reason?: string }>;
  pendingIntent?: PendingIntent;
  recoveryUntil?: number;
  intelByVillage: Record<string, { observedAt: number; source: 'scout' | 'battle' }>;
  tradeObservations: Record<string, { firstSeenAt: number; acceptAfter: number; partnerPlayerId: string }>;
  tradePartnerCooldowns: Record<string, number>;
  lastDecision?: { at: number; candidates: Array<{ kind: ActionKind; score: number }>; selected: ActionKind; reason?: string };
}

interface AiGlobalState {
  reservations: Record<string, { aiPlayerId: string; arrivalAt: number; expiresAt: number }>;
  victimHits: Record<string, number[]>;
}

interface Snapshot {
  resources: any;
  layout: any;
  army: any;
  techs: any[];
  map: any[];
  trade: any;
  alliance: any;
  population: any;
}

interface Candidate {
  kind: ActionKind;
  score: number;
  payload: Record<string, unknown>;
}

const PLAYER_COLLECTION = 'ai_player';
const GLOBAL_COLLECTION = 'ai_global';
const GLOBAL_KEY = 'global';
const THINK_MIN_MS = 2 * 60_000;
const THINK_SPREAD_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

/**
 * AI 玩家 owner：只拥有人格、计划、记忆、幂等意图和跨 AI 受害者预约。
 * 资源、建筑、军队、地图等权威状态始终通过 Command 获取/修改。
 */
export class AiPlayerModule {
  static readonly NAME = 'ai-player';
  /** 同一托管玩家的 Scheduler/GM/事件触发思考必须互斥，避免并发感知后双写。 */
  private readonly thinking = new Set<string>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
    private schedulingEnabled = true,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('aiPlayer.Bootstrap', (c) => this.bootstrap(c));
    this.commands.register('aiPlayer.Think', (c) => this.forceThink(c));
    this.commands.register('aiPlayer.GetDebug', (c) => this.getDebug(c));
    this.commands.register('aiPlayer.ListDebug', (c) => this.listDebug(c));
    this.commands.register('aiPlayer.SetEnabled', (c) => this.setEnabled(c));
    this.bus.on('combat.BattleEnded', (event) => this.onBattleEnded(event.payload as Record<string, unknown>));
    this.bus.on('movement.ScoutReport', (event) => this.onScoutReport(event.payload as Record<string, unknown>));
  }

  private onBattleEnded(payload: Record<string, unknown>): void {
    if (payload.side !== 'attacker') return;
    const state = this.store.all<AiPlayerState>(PLAYER_COLLECTION)
      .find((entry) => entry.villageId === String(payload.villageId ?? ''));
    if (!state) return;
    if (payload.targetKind === 'village' && typeof payload.targetId === 'string') {
      state.intelByVillage ??= {};
      state.intelByVillage[payload.targetId] = { observedAt: this.now(), source: 'battle' };
    }
    const deployed = payload.deployedTroops as Record<string, number> | undefined;
    if (!deployed) { this.save(state); return; }
    const ownLosses = payload.ownLosses as Record<string, number> | undefined;
    const survivors = payload.survivors as Record<string, number> | undefined;
    const deployedCount = Object.values(deployed).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
    const lossCount = ownLosses
      ? Object.values(ownLosses).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
      : Object.entries(deployed).reduce((sum, [code, count]) => sum + Math.max(0, Number(count) - Number(survivors?.[code] ?? 0)), 0);
    if (deployedCount <= 0 || lossCount / deployedCount < 0.3) { this.save(state); return; }
    state.recoveryUntil = Math.max(state.recoveryUntil ?? 0, this.now() + 72 * 3_600_000);
    state.lifecycle = 'recovering';
    state.primaryGoal = 'train';
    state.goalUntil = state.recoveryUntil;
    this.record(state, 'idle', true, 'heavy_losses_enter_recovery');
    this.save(state);
  }

  private onScoutReport(payload: Record<string, unknown>): void {
    if (payload.side !== 'attacker' || payload.targetKind !== 'village'
      || payload.outcome !== 'attacker_survived' || typeof payload.targetVillage !== 'string') return;
    const state = this.store.all<AiPlayerState>(PLAYER_COLLECTION)
      .find((entry) => entry.villageId === String(payload.villageId ?? ''));
    if (!state) return;
    state.intelByVillage ??= {};
    state.intelByVillage[payload.targetVillage] = { observedAt: this.now(), source: 'scout' };
    this.save(state);
  }

  async resume(): Promise<void> {
    // 手动 Scheduler 是测试快进环境；自动补齐 roster 会额外创建周期村庄任务，
    // 破坏“推进直到队列为空”的既有测试。测试需要 AI 时显式调用 Bootstrap。
    if (!this.schedulingEnabled) return;
    await this.bootstrap({ name: 'aiPlayer.Bootstrap', from: 'app', payload: {} });
    for (const state of this.store.all<AiPlayerState>(PLAYER_COLLECTION)) this.schedule(state);
  }

  private global(): AiGlobalState {
    const state = this.store.get<AiGlobalState>(GLOBAL_COLLECTION, GLOBAL_KEY) ?? { reservations: {}, victimHits: {} };
    const now = this.now();
    state.reservations = Object.fromEntries(Object.entries(state.reservations).filter(([, value]) => value.expiresAt > now));
    for (const [victim, hits] of Object.entries(state.victimHits)) state.victimHits[victim] = hits.filter((at) => at > now - 72 * 3_600_000);
    return state;
  }

  private saveGlobal(state: AiGlobalState): void { this.store.set(GLOBAL_COLLECTION, GLOBAL_KEY, state); }

  private load(playerId: string): AiPlayerState | undefined {
    const state = this.store.get<AiPlayerState>(PLAYER_COLLECTION, playerId);
    if (!state) return undefined;
    state.intelByVillage ??= {};
    state.tradeObservations ??= {};
    state.tradePartnerCooldowns ??= {};
    return state;
  }
  private save(state: AiPlayerState): void { this.store.set(PLAYER_COLLECTION, state.playerId, state); }

  private random(state: AiPlayerState): number {
    let x = (state.seed + state.randomCursor++ * 0x9e3779b9) >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  }

  private dayKey(at = this.now()): string { return new Date(at).toISOString().slice(0, 10); }

  private async bootstrap(cmd: Command): Promise<CommandResult> {
    if (!['app', 'gm', 'test', AiPlayerModule.NAME].includes(cmd.from)) return { ok: false, payload: {}, reason: 'internal_only' };
    let created = 0;
    for (const row of this.config.aiRoster) {
      const existing = this.store.all<AiPlayerState>(PLAYER_COLLECTION).find((entry) => entry.rosterId === row.rosterId);
      if (existing) continue;
      const result = await this.commands.send({
        name: 'player.CreateManaged', from: AiPlayerModule.NAME,
        payload: { name: row.name, tribe: row.tribe },
      });
      if (!result.ok) return { ok: false, payload: { created }, reason: `roster:${row.rosterId}:${result.reason}` };
      const player = result.payload as { playerId: string; villageId: string; createdAt: number };
      const state = this.newState(row, player);
      this.save(state);
      this.schedule(state);
      created++;
    }
    return { ok: true, payload: { created, total: this.store.all(PLAYER_COLLECTION).length } };
  }

  private newState(row: AiRosterDef, player: { playerId: string; villageId: string; createdAt: number }): AiPlayerState {
    const jitter = (row.seed % 120) * 1000;
    return {
      rosterId: row.rosterId, playerId: player.playerId, villageId: player.villageId,
      persona: row.persona, seed: row.seed, randomCursor: 0,
      createdAt: player.createdAt, warmupUntil: player.createdAt + row.warmupHours * 3_600_000,
      lifecycle: 'warming', enabled: true, nextThinkAt: this.now() + jitter,
      dayKey: this.dayKey(), actionsToday: 0, primaryGoal: 'build', goalUntil: 0,
      cooldowns: {}, recentActions: [], intelByVillage: {}, tradeObservations: {}, tradePartnerCooldowns: {},
    };
  }

  private schedule(state: AiPlayerState): void {
    this.scheduler.cancelByOwner(`ai-player:${state.playerId}`);
    if (!this.schedulingEnabled) return;
    if (!state.enabled || state.lifecycle === 'disabled') return;
    const at = Math.max(this.now(), Number(state.nextThinkAt) || this.now());
    this.scheduler.scheduleAt(at, async () => { await this.tick(state.playerId); }, `ai-player:${state.playerId}`, `village:${state.villageId}`);
  }

  private isSleeping(state: AiPlayerState, persona: AiPersonaDef): boolean {
    const offset = state.seed % 24;
    const localHour = (new Date(this.now()).getUTCHours() + offset) % 24;
    return localHour < persona.sleepHours;
  }

  private nextDelay(state: AiPlayerState, sleeping: boolean): number {
    const base = sleeping ? 10 * 60_000 : THINK_MIN_MS;
    const spread = sleeping ? 10 * 60_000 : THINK_SPREAD_MS;
    return base + Math.floor(this.random(state) * spread);
  }

  private async forceThink(cmd: Command): Promise<CommandResult> {
    if (!['gm', 'test', AiPlayerModule.NAME].includes(cmd.from)) return { ok: false, payload: {}, reason: 'internal_only' };
    const playerId = String((cmd.payload as any).playerId ?? '');
    const result = await this.tick(playerId, true);
    return { ok: result.ok, payload: result, reason: result.reason };
  }

  private async tick(playerId: string, forced = false): Promise<{ ok: boolean; action?: ActionKind; reason?: string }> {
    if (this.thinking.has(playerId)) return { ok: false, reason: 'already_thinking' };
    this.thinking.add(playerId);
    try {
      return await this.runTick(playerId, forced);
    } finally {
      this.thinking.delete(playerId);
    }
  }

  private async runTick(playerId: string, forced = false): Promise<{ ok: boolean; action?: ActionKind; reason?: string }> {
    const state = this.load(playerId);
    if (!state || !state.enabled) return { ok: false, reason: 'ai_not_found_or_disabled' };
    const persona = this.config.aiPersonas[state.persona];
    if (!persona) return { ok: false, reason: 'persona_not_found' };
    const now = this.now();
    if (state.dayKey !== this.dayKey(now)) { state.dayKey = this.dayKey(now); state.actionsToday = 0; }
    state.lifecycle = now < state.warmupUntil ? 'warming' : (state.recoveryUntil && now < state.recoveryUntil ? 'recovering' : 'active');

    // prepared 意图可能处于“Command 已成功但进程未回写结果”的崩溃窗口；绝不重放。
    if (state.pendingIntent) {
      this.record(state, state.pendingIntent.kind, false, 'uncertain_intent_not_retried');
      state.pendingIntent = undefined;
      state.cooldowns.uncertain = now + 30 * 60_000;
    }

    const sleeping = this.isSleeping(state, persona);
    if (!forced && (sleeping || state.actionsToday >= persona.dailyActionBudget)) {
      state.nextThinkAt = now + this.nextDelay(state, sleeping);
      this.save(state); this.schedule(state);
      return { ok: true, action: 'idle', reason: sleeping ? 'sleeping' : 'budget_exhausted' };
    }

    const snapshot = await this.perceive(state);
    if (!snapshot) {
      state.nextThinkAt = now + this.nextDelay(state, false);
      this.record(state, 'idle', false, 'perception_failed'); this.save(state); this.schedule(state);
      return { ok: false, reason: 'perception_failed' };
    }
    const candidates = await this.candidates(state, persona, snapshot);
    const selected = this.select(state, candidates);
    state.lastDecision = { at: now, candidates: candidates.map(({ kind, score }) => ({ kind, score })), selected: selected?.kind ?? 'idle' };
    if (!selected || selected.score < 45) {
      state.nextThinkAt = now + this.nextDelay(state, false);
      this.record(state, 'idle', true, 'no_candidate_over_threshold'); this.save(state); this.schedule(state);
      return { ok: true, action: 'idle' };
    }
    if (state.goalUntil <= now) {
      state.primaryGoal = selected.kind;
      state.goalUntil = now + (4 + this.random(state) * 2) * 3_600_000;
    }
    const intent: PendingIntent = { id: `${state.playerId}:${now}:${state.randomCursor}`, kind: selected.kind, preparedAt: now, payload: selected.payload };
    state.pendingIntent = intent;
    this.save(state); // 写前意图必须先落盘
    const result = await this.execute(state, selected);
    state.pendingIntent = undefined;
    state.actionsToday += result.ok ? 1 : 0;
    state.cooldowns[selected.kind] = now + (result.ok ? this.cooldownMs(selected.kind) : 30 * 60_000);
    this.record(state, selected.kind, result.ok, result.reason);
    state.nextThinkAt = now + this.nextDelay(state, false);
    this.save(state); this.schedule(state);
    return { ok: result.ok, action: selected.kind, reason: result.reason };
  }

  private async perceive(state: AiPlayerState): Promise<Snapshot | null> {
    const send = (name: string, payload: Record<string, unknown>) => this.commands.send({ name, from: AiPlayerModule.NAME, payload });
    const [resources, layout, army, techs, map, trade, alliance, population] = await Promise.all([
      send('economy.GetResources', { villageId: state.villageId }),
      send('building.GetLayout', { villageId: state.villageId }),
      send('military.GetArmy', { villageId: state.villageId }),
      send('research.GetTechTree', { villageId: state.villageId }),
      send('vision.GetPlayerMapSnapshot', { playerId: state.playerId }),
      send('trade.GetCenter', { villageId: state.villageId }),
      send('alliance.Get', { playerId: state.playerId }),
      send('population.GetSnapshot', { villageId: state.villageId }),
    ]);
    if (![resources, layout, army, techs, map, population].every((entry) => entry.ok)) return null;
    return {
      resources: resources.payload, layout: layout.payload, army: army.payload,
      techs: (techs.payload as any).techs ?? [], map: (map.payload as any).tiles ?? [],
      trade: trade.ok ? trade.payload : { built: false }, alliance: alliance.ok ? alliance.payload : {},
      population: population.payload,
    };
  }

  private async candidates(state: AiPlayerState, persona: AiPersonaDef, s: Snapshot): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const now = this.now();
    const recentPenalty = (kind: ActionKind) => {
      const recent = state.recentActions.slice(-2);
      return recent.length === 2 && recent.every((entry) => entry.kind === kind) ? 25 : 0;
    };
    const add = (kind: ActionKind, base: number, payload: Record<string, unknown>) => {
      if ((state.cooldowns[kind] ?? 0) > now) return;
      const jitter = this.random(state) * 10 - 5;
      const goalBonus = state.goalUntil > now && state.primaryGoal === kind ? 10 : 0;
      out.push({ kind, score: base - recentPenalty(kind) + goalBonus + jitter, payload });
    };

    const queue = s.layout.queue?.items ?? [];
    if (queue.length < Number(s.layout.queue?.capacity ?? 0)) {
      const placed = [...(s.layout.zones?.outer?.placed ?? []), ...(s.layout.zones?.inner?.placed ?? []), s.layout.townCenter]
        .filter(Boolean).filter((b: any) => !b.building && !b.damaged && b.level < b.maxLevel);
      const upgrade = placed.sort((a: any, b: any) => a.level - b.level || String(a.slotId).localeCompare(String(b.slotId)))[0];
      if (upgrade) add('upgrade', 45 + persona.economyWeight * 30, { villageId: state.villageId, slotId: upgrade.slotId });
      for (const zone of ['inner', 'outer'] as const) {
        if ((s.layout.zones?.[zone]?.freeSlots ?? 0) <= 0) continue;
        const options = await this.commands.send({ name: 'building.GetBuildOptions', from: AiPlayerModule.NAME, payload: { villageId: state.villageId, zone } });
        const option = ((options.payload as any)?.options ?? []).find((item: any) => item.unlocked);
        if (option) add('build', 42 + persona.economyWeight * 30, { villageId: state.villageId, zone, kind: option.kind });
      }
    }

    const trainable = (s.army.trainable ?? []).find((unit: any) => unit.trainableNow);
    if (trainable) add('train', 38 + persona.militaryWeight * 35, { villageId: state.villageId, unit: trainable.key, count: 1 });
    const tech = s.techs.find((item: any) => item.status === 'available');
    if (tech) add('research', 35 + persona.economyWeight * 30, { villageId: state.villageId, techCode: tech.code });

    const troops = this.expeditionTroops(s.army.troops ?? {}, persona.reserveRatio);
    const visiblePve = s.map.find((tile: any) => tile.visibility === 'visible' && tile.kind === 'pve' && tile.refId);
    if (state.lifecycle !== 'recovering' && visiblePve && Object.keys(troops).length) add('pve', 35 + persona.militaryWeight * 40, { villageId: state.villageId, targetId: visiblePve.refId, q: visiblePve.q, r: visiblePve.r, troops });
    const visibleVillages = s.map.filter((tile: any) => tile.visibility === 'visible' && tile.kind === 'village' && tile.refId && tile.refId !== state.villageId);
    let visibleVillage: any;
    let visibleVillageControl: any;
    for (const tile of visibleVillages) {
      const control = await this.commands.send({ name: 'player.GetControlContext', from: AiPlayerModule.NAME, payload: { villageId: tile.refId } });
      if (control.ok && (control.payload as any).controller === 'human') {
        visibleVillage = tile;
        visibleVillageControl = control.payload;
        break;
      }
    }
    const scout = Object.entries(s.army.troops ?? {}).find(([code, count]) => Number(count) > 0 && this.isScoutUnit(code));
    if (visibleVillage && scout) add('scout', 30 + persona.aggression * 30, { villageId: state.villageId, targetVillage: visibleVillage.refId, troops: { [scout[0]]: 1 }, scoutType: 'scout_resources' });

    if (s.trade?.built) {
      const own = s.trade.myOrders ?? [];
      const expired = own.find((order: any) => Number(order.ttlAt) <= now + 5 * 60_000);
      if (expired) add('trade_cancel', 70, { villageId: state.villageId, orderId: expired.id });
      const visibleOrderIds = new Set<string>();
      for (const foreign of (s.trade.playerOrders ?? []).filter((order: any) => order.villageId !== state.villageId)) {
        visibleOrderIds.add(String(foreign.id));
        const control = await this.commands.send({ name: 'player.GetControlContext', from: AiPlayerModule.NAME, payload: { villageId: foreign.villageId } });
        if (control.ok && (control.payload as any).controller === 'human') {
          const partnerPlayerId = String((control.payload as any).playerId ?? '');
          let observation = state.tradeObservations[foreign.id];
          if (!observation || observation.partnerPlayerId !== partnerPlayerId) {
            const delayMinutes = 10 + Math.floor(this.random(state) * 81);
            observation = state.tradeObservations[foreign.id] = { firstSeenAt: now, acceptAfter: now + delayMinutes * 60_000, partnerPlayerId };
          }
          if (now >= observation.acceptAfter && (state.tradePartnerCooldowns[partnerPlayerId] ?? 0) <= now) {
            add('trade_accept', 30 + persona.tradeWeight * 40, { villageId: state.villageId, orderId: foreign.id, targetPlayerId: partnerPlayerId });
          }
        }
      }
      for (const orderId of Object.keys(state.tradeObservations)) if (!visibleOrderIds.has(orderId)) delete state.tradeObservations[orderId];
      if (own.length < 2) {
        const resources = s.resources.resources ?? {};
        const richest = ['wood', 'clay', 'iron', 'crop'].sort((a, b) => Number(resources[b] ?? 0) - Number(resources[a] ?? 0));
        if (Number(resources[richest[0]] ?? 0) >= 200) add('trade_create', 25 + persona.tradeWeight * 45, { villageId: state.villageId, give: { [richest[0]]: 100 }, want: { [richest[3]]: 100 } });
      }
    }

    if (!s.alliance?.alliance && state.lifecycle === 'active') {
      const listed = await this.commands.send({ name: 'alliance.List', from: AiPlayerModule.NAME, payload: {} });
      const targets = ((listed.payload as any)?.alliances ?? []);
      for (const target of targets) {
        const control = await this.commands.send({ name: 'player.GetControlContext', from: AiPlayerModule.NAME, payload: { playerId: target.leaderId } });
        if (control.ok && (control.payload as any).controller === 'human') {
          add('alliance_apply', 20 + persona.socialWeight * 55, { playerId: state.playerId, allianceId: target.id });
          break;
        }
      }
    }

    if (state.lifecycle === 'active' && visibleVillage && Object.keys(troops).length && persona.aggression >= 0.5) {
      // 地图公开的 population 是发展人口，不含驻军；自身必须用同口径快照比较。
      const ownPopulation = Number(s.population?.currentPop ?? 0);
      const targetPopulation = Number(visibleVillage.population ?? 0);
      const scaleRatio = ownPopulation > 0 ? targetPopulation / ownPopulation : 0;
      const intel = state.intelByVillage[visibleVillage.refId];
      if (this.now() - Number(visibleVillageControl?.createdAt ?? this.now()) >= 72 * 3_600_000
        && scaleRatio >= 0.7 && scaleRatio <= 1.3
        && intel && intel.observedAt > now - 12 * 3_600_000) {
        add('raid', 45 + persona.aggression * 30, { villageId: state.villageId, targetVillage: visibleVillage.refId, targetPlayerId: visibleVillageControl.playerId, q: visibleVillage.q, r: visibleVillage.r, troops });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  }

  private select(state: AiPlayerState, candidates: Candidate[]): Candidate | undefined {
    if (!candidates.length) return undefined;
    if (candidates.length > 1 && candidates[0].score - candidates[1].score <= 8) {
      const roll = this.random(state);
      if (roll >= 0.9) return undefined;
      if (roll >= 0.7) return candidates[1];
    }
    return candidates[0];
  }

  private expeditionTroops(source: Record<string, number>, reserveRatio: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [code, raw] of Object.entries(source)) {
      if (this.isScoutUnit(code)) continue;
      const count = Math.floor(Number(raw) * Math.max(0, 1 - reserveRatio));
      if (count > 0) result[code] = Math.min(count, 20);
    }
    return result;
  }

  private isScoutUnit(code: string): boolean {
    if (['equlegati', 'pathfinder', 'teuscout'].includes(code)) return true;
    const unit = this.config.units[code];
    return !!unit && /侦察|探路/.test(unit.name) && unit.attack <= 0;
  }

  private canReserveVictim(state: AiPlayerState, victimId: string, arrivalAt: number): boolean {
    const global = this.global(), now = this.now();
    const hits = global.victimHits[victimId] ?? [];
    if (global.reservations[victimId] && global.reservations[victimId].aiPlayerId !== state.playerId) return false;
    if (hits.some((at) => Math.abs(at - arrivalAt) < 12 * 3_600_000)) return false;
    if (hits.filter((at) => Math.abs(at - arrivalAt) < 72 * 3_600_000).length >= 2) return false;
    const selfHits = state.recentActions.filter((entry) => entry.kind === 'raid' && entry.ok && entry.at > now - 48 * 3_600_000);
    return selfHits.length === 0;
  }

  private reserveVictim(state: AiPlayerState, victimId: string, arrivalAt: number): boolean {
    if (!this.canReserveVictim(state, victimId, arrivalAt)) return false;
    const global = this.global();
    global.reservations[victimId] = { aiPlayerId: state.playerId, arrivalAt, expiresAt: Math.max(this.now() + 30 * 60_000, arrivalAt + 60_000) };
    this.saveGlobal(global);
    return true;
  }

  private finishVictimReservation(state: AiPlayerState, victimId: string, success: boolean, arrivalAt?: number): void {
    const global = this.global();
    if (global.reservations[victimId]?.aiPlayerId === state.playerId) delete global.reservations[victimId];
    if (success && arrivalAt) (global.victimHits[victimId] ??= []).push(arrivalAt);
    this.saveGlobal(global);
  }

  private async execute(state: AiPlayerState, candidate: Candidate): Promise<CommandResult> {
    let victimId: string | undefined;
    let arrivalAt: number | undefined;
    const tradePartnerId = candidate.kind === 'trade_accept' ? String(candidate.payload.targetPlayerId ?? '') : undefined;
    if (candidate.kind === 'raid') victimId = String(candidate.payload.targetPlayerId ?? '');
    const names: Record<ActionKind, string> = {
      build: 'building.Build', upgrade: 'building.Upgrade', train: 'military.TrainTroops', research: 'research.StartResearch',
      pve: 'movement.SendRaid', scout: 'movement.SendScout', trade_create: 'trade.CreateOrder', trade_accept: 'trade.AcceptPlayer',
      trade_cancel: 'trade.CancelOrder', alliance_apply: 'alliance.Apply', raid: 'movement.SendVillageRaid', idle: '',
    };
    const payload = { ...candidate.payload };
    delete (payload as any).targetPlayerId;
    // 行军写入前统一走现有准入与耗时预览；只读检查不计作主要动作。
    if (candidate.kind === 'pve' || candidate.kind === 'scout' || candidate.kind === 'raid') {
      const targetKind = candidate.kind === 'pve' ? 'pve' : 'village';
      const targetRef = candidate.kind === 'pve' ? payload.targetId : payload.targetVillage;
      const options = await this.commands.send({
        name: 'movement.GetMarchOptions', from: AiPlayerModule.NAME,
        payload: { villageId: state.villageId, kind: targetKind, refId: targetRef, q: payload.q, r: payload.r },
      });
      const expectedMode = candidate.kind === 'scout' ? 'scout' : 'raid';
      if (!options.ok || !((options.payload as any).modes ?? []).some((mode: any) => mode.mode === expectedMode)) {
        if (victimId) this.finishVictimReservation(state, victimId, false);
        return { ok: false, payload: {}, reason: options.reason ?? 'march_mode_unavailable' };
      }
      const preview = await this.commands.send({
        name: 'movement.PreviewMarch', from: AiPlayerModule.NAME,
        payload: { ...payload, mode: expectedMode },
      });
      if (!preview.ok) {
        if (victimId) this.finishVictimReservation(state, victimId, false);
        return preview;
      }
      if (candidate.kind === 'raid') {
        arrivalAt = this.now() + Number((preview.payload as any).travelMs ?? 0);
        if (!victimId || !this.reserveVictim(state, victimId, arrivalAt)) return { ok: false, payload: {}, reason: 'victim_reserved_or_rate_limited' };
        // 游戏运营时区固定为中国标准时间；不得依赖宿主机 TZ，否则 CI/生产会产生不同决策。
        const hour = new Date(arrivalAt + 8 * 3_600_000).getUTCHours();
        if (hour < 9 || hour >= 23) {
          if (victimId) this.finishVictimReservation(state, victimId, false, arrivalAt);
          return { ok: false, payload: {}, reason: 'raid_arrival_outside_active_hours' };
        }
        (payload as any).declareWar = true;
      }
      delete (payload as any).q; delete (payload as any).r;
    }
    const result = await this.commands.send({ name: names[candidate.kind], from: AiPlayerModule.NAME, payload });
    if (victimId) this.finishVictimReservation(state, victimId, result.ok, arrivalAt);
    if (result.ok && tradePartnerId) state.tradePartnerCooldowns[tradePartnerId] = this.now() + 6 * 3_600_000;
    return result;
  }

  private cooldownMs(kind: ActionKind): number {
    if (kind === 'raid') return 48 * 3_600_000;
    if (kind === 'alliance_apply') return 7 * DAY_MS;
    if (kind.startsWith('trade_')) return 30 * 60_000;
    if (kind === 'pve' || kind === 'scout') return 20 * 60_000;
    return 10 * 60_000;
  }

  private record(state: AiPlayerState, kind: ActionKind, ok: boolean, reason?: string): void {
    state.recentActions.push({ kind, at: this.now(), ok, reason });
    state.recentActions = state.recentActions.slice(-32);
  }

  private getDebug(cmd: Command): CommandResult {
    if (!['gm', 'test', 'app'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'internal_only' };
    const state = this.load(String((cmd.payload as any).playerId ?? ''));
    return state ? { ok: true, payload: { state: structuredClone(state), global: structuredClone(this.global()) } } : { ok: false, payload: {}, reason: 'ai_not_found' };
  }

  private listDebug(cmd: Command): CommandResult {
    if (!['gm', 'test', 'app'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'internal_only' };
    return { ok: true, payload: { players: structuredClone(this.store.all<AiPlayerState>(PLAYER_COLLECTION)) } };
  }

  private setEnabled(cmd: Command): CommandResult {
    if (!['gm', 'test'].includes(cmd.from)) return { ok: false, payload: {}, reason: 'internal_only' };
    const state = this.load(String((cmd.payload as any).playerId ?? ''));
    if (!state) return { ok: false, payload: {}, reason: 'ai_not_found' };
    state.enabled = Boolean((cmd.payload as any).enabled);
    state.lifecycle = state.enabled ? (this.now() < state.warmupUntil ? 'warming' : 'active') : 'disabled';
    state.nextThinkAt = this.now(); this.save(state); this.schedule(state);
    return { ok: true, payload: { enabled: state.enabled } };
  }
}
