import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, KingdomServiceDef } from '../infra/config.js';
import type { Snapshot } from '../infra/combat-types.js';
import { kingdomLandmarkAnchors } from '../infra/world-generation.js';

type Fief = 'ne' | 'se' | 'sw' | 'nw';
type KingdomTaskKind = 'tribute' | 'clear_pve' | 'attack_evil' | 'eliminate_troops';
type KingdomTaskStatus = 'active' | 'ready' | 'failed' | 'claimed';

interface KingdomTask {
  id: string;
  kind: KingdomTaskKind;
  status: KingdomTaskStatus;
  issuedAt: number;
  expiresAt: number;
  rewardReputation: number;
  resource?: string;
  amount?: number;
  targetPveId?: string;
  targetPveType?: string;
  targetQ?: number;
  targetR?: number;
  targetPlayerId?: string;
  targetPlayerName?: string;
  requiredTroops?: number;
  eliminatedTroops?: number;
  executionVillageId?: string;
}

interface KingdomOrder {
  id: string;
  serviceCode: string;
  serviceName: string;
  villageId: string;
  playerId: string;
  status: 'pending' | 'engaging' | 'completed' | 'failed';
  purchasedAt: number;
  executeAt: number;
  reputationCost: number;
  targetKind?: 'village' | 'pve';
  targetId?: string;
  failureReason?: string;
}

interface KingdomState {
  playerId: string;
  birthVillageId: string;
  birthQ: number;
  birthR: number;
  fief: Fief;
  nextIssueAt: number;
  taskSeq: number;
  orderSeq: number;
  task?: KingdomTask;
  orders: KingdomOrder[];
}

const COLLECTION = 'kingdom';
const LANDMARK_IDS = new Set(['kingdom-capital', 'kingdom-fief-ne', 'kingdom-fief-se', 'kingdom-fief-sw', 'kingdom-fief-nw']);
const RESOURCE_KEYS = ['wood', 'clay', 'iron', 'crop'] as const;
const FIEF_NAMES: Record<Fief, string> = { ne: '东北封地', se: '东南封地', sw: '西南封地', nw: '西北封地' };

/** 王国系统唯一 owner：玩家封地归属、循环王国任务与议会厅服务订单。 */
export class KingdomModule {
  static readonly NAME = 'kingdom';

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
    private rng: () => number = Math.random,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('kingdom.GetState', (c) => this.getState(c));
    this.commands.register('kingdom.SubmitTribute', (c) => this.submitTribute(c));
    this.commands.register('kingdom.ClaimTask', (c) => this.claimTask(c));
    this.commands.register('kingdom.BuyService', (c) => this.buyService(c));
    this.bus.on('player.Registered', (evt) => void this.onPlayerRegistered(evt));
    this.bus.on('combat.BattleEnded', (evt) => void this.onBattleEnded(evt));
  }

  resume(): void {
    void this.resumeAll();
  }

  wipe(): void {
    this.store.clear(COLLECTION);
  }

  deletePlayer(playerId: string): void {
    this.scheduler.cancelByOwner(`kingdom-task:${playerId}`);
    for (const order of this.store.get<KingdomState>(COLLECTION, playerId)?.orders ?? []) {
      this.scheduler.cancelByOwner(`kingdom-order:${order.id}`);
    }
    this.store.delete(COLLECTION, playerId);
  }

  private n(key: string, fallback: number): number {
    const value = this.config.constants.raw[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private randomInt(min: number, max: number): number {
    const lo = Math.floor(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  private fiefFor(q: number, r: number): Fief {
    const east = q >= this.config.constants.worldW / 2;
    const south = r >= this.config.constants.worldH / 2;
    return south ? (east ? 'se' : 'sw') : (east ? 'ne' : 'nw');
  }

  private normalize(state: KingdomState): KingdomState {
    return {
      ...state,
      taskSeq: Math.max(0, Math.floor(state.taskSeq ?? 0)),
      orderSeq: Math.max(0, Math.floor(state.orderSeq ?? 0)),
      nextIssueAt: Number.isFinite(state.nextIssueAt) ? state.nextIssueAt : 0,
      orders: Array.isArray(state.orders) ? state.orders.slice(-20) : [],
    };
  }

  private createState(playerId: string, villageId: string, q: number, r: number, arm = true): KingdomState {
    const state: KingdomState = {
      playerId, birthVillageId: villageId, birthQ: q, birthR: r, fief: this.fiefFor(q, r),
      nextIssueAt: this.now() + this.randomInt(
        this.n('kingdom_task_initial_min_sec', 300),
        this.n('kingdom_task_initial_max_sec', 600),
      ) * 1000,
      taskSeq: 0, orderSeq: 0, orders: [],
    };
    this.store.set(COLLECTION, playerId, state);
    if (arm) this.armTask(state);
    return state;
  }

  private async ensure(playerId: string): Promise<KingdomState | undefined> {
    const existing = this.store.get<KingdomState>(COLLECTION, playerId);
    if (existing) {
      const state = this.normalize(existing);
      this.store.set(COLLECTION, playerId, state);
      return state;
    }
    const result = await this.commands.send({ name: 'player.Get', from: KingdomModule.NAME, payload: { playerId } });
    if (!result.ok) return undefined;
    const player = (result.payload as any).player;
    const village = player?.villages?.find((v: any) => v.id === player.villageId) ?? player?.villages?.[0];
    if (!village) return undefined;
    return this.createState(playerId, village.id, village.q, village.r);
  }

  private async onPlayerRegistered(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { playerId?: string; villageId?: string; q?: number; r?: number };
    if (!p.playerId || !p.villageId || !Number.isFinite(p.q) || !Number.isFinite(p.r)) return;
    // 注册时只冻结出生封地，不启动长期循环计时器。玩家首次读取王国状态时再挂载
    // 任务计时器，避免一个从未打开过王国系统的账号给全局调度器留下永久任务。
    if (!this.store.get(COLLECTION, p.playerId)) this.createState(p.playerId, p.villageId, p.q!, p.r!, false);
  }

  private async resumeAll(): Promise<void> {
    const list = await this.commands.send({ name: 'player.ListAll', from: KingdomModule.NAME, payload: {} });
    for (const player of ((list.payload as any)?.players ?? [])) {
      const state = await this.ensure(String(player.id));
      if (!state) continue;
      this.armTask(state);
      for (const order of state.orders.filter((o) => o.status === 'pending')) this.armOrder(order);
    }
  }

  private armTask(state: KingdomState): void {
    this.scheduler.cancelByOwner(`kingdom-task:${state.playerId}`);
    if (state.task && (state.task.status === 'active' || state.task.status === 'ready')) {
      this.scheduler.scheduleAt(state.task.expiresAt, () => this.expireTask(state.playerId, state.task!.id), `kingdom-task:${state.playerId}`);
      return;
    }
    const at = state.nextIssueAt || this.now();
    this.scheduler.scheduleAt(at, () => this.issueTask(state.playerId), `kingdom-task:${state.playerId}`);
  }

  private scheduleNext(state: KingdomState): void {
    state.nextIssueAt = this.now() + this.randomInt(
      this.n('kingdom_task_interval_min_sec', 14400),
      this.n('kingdom_task_interval_max_sec', 28800),
    ) * 1000;
    this.store.set(COLLECTION, state.playerId, state);
    this.armTask(state);
  }

  private async eligiblePve(fief: Fief): Promise<any[]> {
    const result = await this.commands.send({ name: 'pve.ListTargets', from: KingdomModule.NAME, payload: {} });
    return ((result.payload as any)?.targets ?? []).filter((p: any) =>
      !p.cleared && !p.task && !p.noRespawn && !LANDMARK_IDS.has(String(p.id)) && this.fiefFor(Number(p.q), Number(p.r)) === fief,
    );
  }

  private async eligibleEvilPlayers(selfId: string, fief: Fief): Promise<any[]> {
    const list = await this.commands.send({ name: 'player.ListAll', from: KingdomModule.NAME, payload: {} });
    const out: any[] = [];
    for (const player of ((list.payload as any)?.players ?? [])) {
      if (!player?.id || player.id === selfId) continue;
      const capital = player.villages?.[0];
      if (!capital || this.fiefFor(Number(capital.q), Number(capital.r)) !== fief) continue;
      const rep = await this.commands.send({ name: 'reputation.Get', from: KingdomModule.NAME, payload: { playerId: player.id } });
      if (Number((rep.payload as any)?.value) < -this.n('kingdom_task_evil_target_threshold', 10)) out.push(player);
    }
    return out;
  }

  private chooseWeighted(candidates: Array<{ kind: KingdomTaskKind; weight: number }>): KingdomTaskKind {
    const total = candidates.reduce((sum, x) => sum + Math.max(0, x.weight), 0);
    let cursor = this.rng() * Math.max(1, total);
    for (const item of candidates) {
      cursor -= Math.max(0, item.weight);
      if (cursor <= 0) return item.kind;
    }
    return candidates[0]!.kind;
  }

  private async issueTask(playerId: string): Promise<void> {
    const state = await this.ensure(playerId);
    if (!state) return;
    if (state.task && (state.task.status === 'active' || state.task.status === 'ready') && state.task.expiresAt > this.now()) {
      this.armTask(state);
      return;
    }
    const pves = await this.eligiblePve(state.fief);
    const evilPlayers = await this.eligibleEvilPlayers(playerId, state.fief);
    const candidates: Array<{ kind: KingdomTaskKind; weight: number }> = [
      { kind: 'tribute', weight: this.n('kingdom_task_tribute_weight', 35) },
    ];
    if (pves.length) candidates.push({ kind: 'clear_pve', weight: this.n('kingdom_task_clear_pve_weight', 35) });
    if (evilPlayers.length) {
      candidates.push({ kind: 'attack_evil', weight: this.n('kingdom_task_attack_evil_weight', 15) });
      candidates.push({ kind: 'eliminate_troops', weight: this.n('kingdom_task_eliminate_troops_weight', 15) });
    }
    const enabledCandidates = candidates.filter((x) => x.weight > 0);
    const kind = this.chooseWeighted(enabledCandidates.length ? enabledCandidates : [{ kind: 'tribute', weight: 1 }]);
    const now = this.now();
    const task: KingdomTask = {
      id: `kt-${playerId}-${++state.taskSeq}`,
      kind, status: 'active', issuedAt: now,
      expiresAt: now + Math.max(60, this.n('kingdom_task_duration_sec', 21600)) * 1000,
      rewardReputation: this.n(`kingdom_task_${kind}_reward_reputation`, kind === 'tribute' ? 2 : kind === 'clear_pve' ? 3 : kind === 'attack_evil' ? 4 : 5),
    };
    if (kind === 'tribute') {
      task.resource = RESOURCE_KEYS[this.randomInt(0, RESOURCE_KEYS.length - 1)];
      task.amount = this.randomInt(this.n('kingdom_task_tribute_amount_min', 500), this.n('kingdom_task_tribute_amount_max', 1500));
    } else if (kind === 'clear_pve') {
      const target = pves[this.randomInt(0, pves.length - 1)]!;
      task.targetPveId = target.id; task.targetPveType = target.type; task.targetQ = target.q; task.targetR = target.r;
    } else {
      const target = evilPlayers[this.randomInt(0, evilPlayers.length - 1)]!;
      task.targetPlayerId = target.id; task.targetPlayerName = target.name ?? target.id;
      if (kind === 'eliminate_troops') {
        task.requiredTroops = this.randomInt(this.n('kingdom_task_eliminate_troops_min', 10), this.n('kingdom_task_eliminate_troops_max', 30));
        task.eliminatedTroops = 0;
      }
    }
    state.task = task;
    state.nextIssueAt = 0;
    this.store.set(COLLECTION, playerId, state);
    this.armTask(state);
    await this.emitUpdated(state, 'issued');
  }

  private async expireTask(playerId: string, taskId: string): Promise<void> {
    const state = this.store.get<KingdomState>(COLLECTION, playerId);
    if (!state?.task || state.task.id !== taskId || !['active', 'ready'].includes(state.task.status)) return;
    if (state.task.expiresAt > this.now()) { this.armTask(state); return; }
    state.task.status = 'failed';
    this.store.set(COLLECTION, playerId, state);
    this.scheduleNext(state);
    await this.emitUpdated(state, 'failed');
  }

  private async markReady(state: KingdomState, villageId: string): Promise<void> {
    if (!state.task || state.task.status !== 'active') return;
    state.task.status = 'ready';
    state.task.executionVillageId = villageId;
    this.store.set(COLLECTION, state.playerId, state);
    this.armTask(state);
    await this.emitUpdated(state, 'ready');
  }

  private async submitTribute(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId } = cmd.payload as { playerId: string; villageId: string };
    const state = await this.ensure(playerId);
    const task = state?.task;
    if (!state || !task || task.status !== 'active' || task.kind !== 'tribute' || !task.resource || !task.amount) return { ok: false, payload: {}, reason: 'kingdom_task_not_submittable' };
    if (task.expiresAt <= this.now()) { await this.expireTask(playerId, task.id); return { ok: false, payload: {}, reason: 'kingdom_task_expired' }; }
    const spent = await this.commands.send({ name: 'economy.TrySpend', from: KingdomModule.NAME, payload: { villageId, cost: { [task.resource]: task.amount } } });
    if (!spent.ok) return spent;
    await this.markReady(state, villageId);
    return { ok: true, payload: { task: state.task } };
  }

  private async claimTask(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId: string };
    const state = await this.ensure(playerId);
    const task = state?.task;
    if (!state || !task || task.status !== 'ready') return { ok: false, payload: {}, reason: 'kingdom_task_not_ready' };
    if (task.expiresAt <= this.now()) { await this.expireTask(playerId, task.id); return { ok: false, payload: {}, reason: 'kingdom_task_expired' }; }
    const reward = await this.commands.send({ name: 'reputation.Adjust', from: KingdomModule.NAME, payload: { playerId, delta: task.rewardReputation, reason: 'kingdom_task' } });
    if (!reward.ok) return reward;
    task.status = 'claimed';
    this.store.set(COLLECTION, playerId, state);
    this.scheduleNext(state);
    await this.emitUpdated(state, 'claimed');
    return { ok: true, payload: { rewardReputation: task.rewardReputation, task, nextIssueAt: state.nextIssueAt } };
  }

  private async getState(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId } = cmd.payload as { playerId: string; villageId?: string };
    const state = await this.ensure(playerId);
    if (!state) return { ok: false, payload: {}, reason: 'player_not_found' };
    if (state.nextIssueAt <= this.now() && (!state.task || ['failed', 'claimed'].includes(state.task.status))) await this.issueTask(playerId);
    else this.armTask(state);
    const fresh = this.store.get<KingdomState>(COLLECTION, playerId) ?? state;
    const levelResult = villageId
      ? await this.commands.send({ name: 'building.GetBuildingLevel', from: KingdomModule.NAME, payload: { villageId, kind: 'council' } })
      : { ok: true, payload: { level: 0 } } as CommandResult;
    const pves = await this.commands.send({ name: 'pve.ListTargets', from: KingdomModule.NAME, payload: {} });
    const landmarks = ((pves.payload as any)?.targets ?? []).filter((p: any) => LANDMARK_IDS.has(String(p.id)));
    return {
      ok: true,
      payload: {
        playerId, villageId, fief: fresh.fief, fiefName: FIEF_NAMES[fresh.fief],
        nextIssueAt: fresh.nextIssueAt, task: fresh.task ?? null, orders: fresh.orders.slice(-10).reverse(),
        councilLevel: Number((levelResult.payload as any)?.level ?? 0),
        services: Object.values(this.config.kingdomServices).sort((a, b) => a.minCouncilLevel - b.minCouncilLevel || a.id - b.id),
        landmarks,
      },
    };
  }

  private async buyService(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId, serviceCode, targetKind, targetId } = cmd.payload as {
      playerId: string; villageId: string; serviceCode: string; targetKind?: 'village' | 'pve'; targetId?: string;
    };
    const state = await this.ensure(playerId);
    const service = this.config.kingdomServices[serviceCode];
    if (!state || !service) return { ok: false, payload: {}, reason: 'kingdom_service_not_found' };
    const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: KingdomModule.NAME, payload: { villageId, kind: 'council' } });
    if (!level.ok || Number((level.payload as any)?.level ?? 0) < service.minCouncilLevel) return { ok: false, payload: {}, reason: 'council_level_too_low' };
    if (service.category === 'attack') {
      const valid = await this.validateAttackTarget(playerId, targetKind, targetId);
      if (!valid.ok) return valid;
    }
    const spent = await this.commands.send({ name: 'reputation.TrySpend', from: KingdomModule.NAME, payload: { playerId, amount: service.reputationCost, reason: `kingdom_service:${service.code}` } });
    if (!spent.ok) return spent;
    let result: CommandResult = { ok: true, payload: {} };
    if (service.category === 'supplies') {
      result = await this.commands.send({ name: 'economy.Grant', from: KingdomModule.NAME, payload: { villageId, gain: service.resources } });
    } else if (service.category === 'reinforcement') {
      result = await this.commands.send({ name: 'military.AdjustTroops', from: KingdomModule.NAME, payload: { villageId, delta: { [service.unitCode!]: service.unitCount } } });
    } else if (service.category === 'treasure') {
      result = await this.commands.send({ name: 'treasure.Grant', from: KingdomModule.NAME, payload: { villageId, code: service.treasureCode, pendingIfFull: true, rewardVillageId: villageId } });
    } else {
      const order: KingdomOrder = {
        id: `ko-${playerId}-${++state.orderSeq}`, playerId, villageId,
        serviceCode: service.code, serviceName: service.name, status: 'pending', purchasedAt: this.now(),
        executeAt: this.now() + service.delaySec * 1000, reputationCost: service.reputationCost,
        targetKind, targetId,
      };
      state.orders = [...state.orders.slice(-19), order];
      this.store.set(COLLECTION, playerId, state);
      this.armOrder(order);
      await this.emitUpdated(state, 'service_purchased');
      return { ok: true, payload: { order, reputation: spent.payload } };
    }
    if (!result.ok) {
      await this.commands.send({ name: 'reputation.Adjust', from: KingdomModule.NAME, payload: { playerId, delta: service.reputationCost, reason: 'kingdom_service_refund' } });
      return result;
    }
    await this.emitUpdated(state, 'service_completed');
    return { ok: true, payload: { service, result: result.payload, reputation: spent.payload } };
  }

  private async validateAttackTarget(playerId: string, kind?: string, id?: string): Promise<CommandResult> {
    if (!id || (kind !== 'village' && kind !== 'pve')) return { ok: false, payload: {}, reason: 'kingdom_attack_target_required' };
    if (kind === 'pve') {
      if (LANDMARK_IDS.has(id)) return { ok: false, payload: {}, reason: 'cannot_attack_kingdom_landmark' };
      const target = await this.commands.send({ name: 'pve.GetTarget', from: KingdomModule.NAME, payload: { id } });
      if (!target.ok) return target;
      const pve = target.payload as any;
      if (pve.task || pve.noRespawn || pve.cleared) return { ok: false, payload: {}, reason: 'kingdom_attack_target_unavailable' };
      return target;
    }
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: KingdomModule.NAME, payload: { villageId: id } });
    if (!owner.ok) return owner;
    if (String((owner.payload as any)?.player?.id) === playerId) return { ok: false, payload: {}, reason: 'cannot_attack_self' };
    return { ok: true, payload: {} };
  }

  private armOrder(order: KingdomOrder): void {
    this.scheduler.cancelByOwner(`kingdom-order:${order.id}`);
    this.scheduler.scheduleAt(order.executeAt, () => this.executeOrder(order.playerId, order.id), `kingdom-order:${order.id}`);
  }

  private serviceSnapshot(service: KingdomServiceDef): Snapshot {
    const unit = service.unitCode ? this.config.units[service.unitCode] : undefined;
    if (!unit || service.unitCount <= 0) return {};
    return {
      [unit.key]: {
        count: service.unitCount, form: unit.form, meleeAtk: unit.meleeAtk, rangedAtk: unit.rangedAtk,
        meleeDef: unit.meleeDef, rangedDef: unit.rangedDef, carry: 0,
        traits: unit.traits.flatMap((code) => this.config.unitTraits[code]?.effects ?? []),
      },
    };
  }

  private async executeOrder(playerId: string, orderId: string): Promise<void> {
    const state = this.store.get<KingdomState>(COLLECTION, playerId);
    const order = state?.orders.find((o) => o.id === orderId);
    const service = order ? this.config.kingdomServices[order.serviceCode] : undefined;
    if (!state || !order || !service || order.status !== 'pending' || !order.targetKind || !order.targetId) return;
    const valid = await this.validateAttackTarget(playerId, order.targetKind, order.targetId);
    if (!valid.ok) { await this.failOrder(state, order, valid.reason ?? 'target_not_found', true); return; }
    let targetXY: { q: number; r: number } | undefined;
    if (order.targetKind === 'pve') {
      const target = await this.commands.send({ name: 'pve.GetTarget', from: KingdomModule.NAME, payload: { id: order.targetId } });
      targetXY = target.ok ? { q: Number((target.payload as any).q), r: Number((target.payload as any).r) } : undefined;
    } else {
      const target = await this.commands.send({ name: 'player.GetByVillage', from: KingdomModule.NAME, payload: { villageId: order.targetId } });
      const village = (target.payload as any)?.player?.villages?.find((v: any) => v.id === order.targetId);
      targetXY = village ? { q: Number(village.q), r: Number(village.r) } : undefined;
    }
    if (!targetXY) { await this.failOrder(state, order, 'target_not_found', true); return; }
    const anchors = kingdomLandmarkAnchors(this.config.constants.worldW, this.config.constants.worldH, this.n('kingdom_fief_offset_ratio', 0.25));
    const origin = anchors.find((a) => a.id === `kingdom-fief-${state.fief}`) ?? anchors[0]!;
    const troops = { [service.unitCode!]: service.unitCount };
    const engaged = await this.commands.send({
      name: 'combat.Engage', from: KingdomModule.NAME,
      payload: {
        targetKind: order.targetKind, battleType: order.targetKind === 'village' ? 'siege' : undefined,
        targetId: order.targetId, targetXY, movementId: `kingdom-service:${order.id}`,
        fromVillage: order.villageId, fromXY: { q: origin.q, r: origin.r }, troops,
        attackerSnapshot: this.serviceSnapshot(service), treasures: [], npcService: true,
      },
    });
    if (!engaged.ok) { await this.failOrder(state, order, engaged.reason ?? 'attack_failed', true); return; }
    order.status = 'engaging';
    this.store.set(COLLECTION, playerId, state);
    await this.emitUpdated(state, 'service_engaging');
  }

  private async failOrder(state: KingdomState, order: KingdomOrder, reason: string, refund: boolean): Promise<void> {
    order.status = 'failed'; order.failureReason = reason;
    this.store.set(COLLECTION, state.playerId, state);
    if (refund) await this.commands.send({ name: 'reputation.Adjust', from: KingdomModule.NAME, payload: { playerId: state.playerId, delta: order.reputationCost, reason: 'kingdom_service_refund' } });
    await this.emitUpdated(state, 'service_failed');
  }

  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as any;
    if (p.side !== 'attacker' || !p.fromVillage) return;
    if (typeof p.movementId === 'string' && p.movementId.startsWith('kingdom-service:')) {
      const orderId = p.movementId.slice('kingdom-service:'.length);
      for (const state of this.store.all<KingdomState>(COLLECTION)) {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order || order.status !== 'engaging') continue;
        order.status = 'completed';
        this.store.set(COLLECTION, state.playerId, state);
        await this.emitUpdated(state, 'service_completed');
        break;
      }
    }
    const attackerOwner = await this.commands.send({ name: 'player.GetByVillage', from: KingdomModule.NAME, payload: { villageId: p.fromVillage } });
    const playerId = String((attackerOwner.payload as any)?.player?.id ?? '');
    const state = playerId ? this.store.get<KingdomState>(COLLECTION, playerId) : undefined;
    const task = state?.task;
    if (!state || !task || task.status !== 'active' || task.expiresAt <= this.now()) return;
    if (task.kind === 'clear_pve' && p.targetKind === 'pve' && p.targetId === task.targetPveId && p.campCleared) {
      await this.markReady(state, p.fromVillage);
      return;
    }
    if ((task.kind === 'attack_evil' || task.kind === 'eliminate_troops') && p.targetKind === 'village') {
      const targetOwner = await this.commands.send({ name: 'player.GetByVillage', from: KingdomModule.NAME, payload: { villageId: p.targetId } });
      if (String((targetOwner.payload as any)?.player?.id ?? '') !== task.targetPlayerId) return;
      if (task.kind === 'attack_evil') {
        await this.markReady(state, p.fromVillage);
      } else {
        task.eliminatedTroops = (task.eliminatedTroops ?? 0) + Object.values(p.defenderLossesAttributed ?? p.defenderLosses ?? {}).reduce((sum: number, count: any) => sum + Math.max(0, Math.floor(Number(count) || 0)), 0);
        task.executionVillageId = p.fromVillage;
        if ((task.eliminatedTroops ?? 0) >= (task.requiredTroops ?? 1)) await this.markReady(state, p.fromVillage);
        else { this.store.set(COLLECTION, playerId, state); await this.emitUpdated(state, 'progress'); }
      }
    }
  }

  private async emitUpdated(state: KingdomState, event: string): Promise<void> {
    await this.bus.emit({
      name: 'kingdom.Updated', source: KingdomModule.NAME, ts: this.now(),
      payload: { playerId: state.playerId, playerIds: [state.playerId], event, task: state.task ?? null, nextIssueAt: state.nextIssueAt },
    } as DomainEvent);
  }
}
