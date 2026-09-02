import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';

export type ReputationAlignment = 'good' | 'evil' | 'neutral';

interface ReputationState {
  playerId: string;
  /** 玩家行为产生的基础声望；宝物被动效果单独记录，避免卸下宝物后无法还原。 */
  baseValue?: number;
  /** 当前主宝物栏被动效果提供的声望修正。 */
  treasureDelta?: number;
  value: number;
  updatedAt: number;
  goodPvpKillRemainder?: number;
  evilPvpKillRemainder?: number;
  /** 王国 PvE 击杀人口累计；不足一声望点的部分跨战斗保留。 */
  kingdomPveKillRemainder?: number;
  /** 已由王国 PvE 击杀累计触发的 -5 声望批次，用于每批只触发一次报复检查。 */
  kingdomPvePenaltyChunks?: number;
  kingdomPvePenaltyRemainder?: number;
  /** 联盟形象大使带来的每次正声望获得额外点数。 */
  allianceBonus?: number;
}

const COLLECTION = 'reputation';

/** 玩家声望的唯一 owner。声望按玩家持有，城镇只接收派生最终倍率。 */
export class ReputationModule {
  static readonly NAME = 'reputation';

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    private config: GameConfig,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('reputation.Get', (c) => this.get(c));
    this.commands.register('reputation.GetByVillage', (c) => this.getByVillage(c));
    this.commands.register('reputation.Adjust', (c) => this.adjust(c));
    this.commands.register('reputation.TrySpend', (c) => this.trySpend(c));
    this.commands.register('reputation.AdjustByVillage', (c) => this.adjustByVillage(c));
    this.commands.register('reputation.SetTreasureDelta', (c) => this.setTreasureDelta(c));
    this.commands.register('reputation.ProcessPvpBattle', (c) => this.processPvpBattle(c));
    this.commands.register('reputation.SetAllianceBonus', (c) => this.setAllianceBonus(c));
    // BattleEnded 的声望结算属于战斗完成的同步后置步骤；等待处理器，
    // 让战斗命令返回时跨战斗累计与报复阈值检查已经落库。
    this.bus.on('combat.BattleEnded', (evt: DomainEvent) => this.onBattleEnded(evt));
  }

  resume(): void {
    for (const raw of this.store.all<ReputationState>(COLLECTION)) {
      const state = this.normalize(raw);
      this.store.set(COLLECTION, state.playerId, state);
      void this.syncVillages(state.playerId, state.value);
    }
  }

  private normalize(raw: ReputationState): ReputationState {
    const rawValue = Number.isFinite(raw.value) ? Math.trunc(raw.value) : 0;
    const treasureDelta = Number.isFinite(raw.treasureDelta) ? Math.trunc(raw.treasureDelta!) : 0;
    const baseValue = Number.isFinite(raw.baseValue) ? Math.trunc(raw.baseValue!) : rawValue - treasureDelta;
    return {
      playerId: raw.playerId,
      baseValue,
      treasureDelta,
      value: baseValue + treasureDelta,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : this.now(),
      goodPvpKillRemainder: Math.max(0, Math.trunc(raw.goodPvpKillRemainder ?? 0)) % 10,
      evilPvpKillRemainder: Math.max(0, Math.trunc(raw.evilPvpKillRemainder ?? 0)) % 10,
      kingdomPveKillRemainder: Math.max(0, Math.trunc(raw.kingdomPveKillRemainder ?? 0)) % Math.max(1, this.config.constants.kingdomPveKilledPopulationPerReputation),
      kingdomPvePenaltyChunks: Math.max(0, Math.trunc(raw.kingdomPvePenaltyChunks ?? 0)),
      kingdomPvePenaltyRemainder: Math.max(0, Math.trunc(raw.kingdomPvePenaltyRemainder ?? 0)) % Math.max(1, this.config.constants.kingdomPveRetaliationChunk),
      allianceBonus: Math.max(0, Math.trunc(raw.allianceBonus ?? 0)),
    };
  }

  private ensure(playerId: string): ReputationState {
    const existing = this.store.get<ReputationState>(COLLECTION, playerId);
    if (existing) return this.normalize(existing);
    const state: ReputationState = { playerId, baseValue: 0, treasureDelta: 0, value: 0, updatedAt: this.now(), goodPvpKillRemainder: 0, evilPvpKillRemainder: 0, kingdomPveKillRemainder: 0, kingdomPvePenaltyChunks: 0, kingdomPvePenaltyRemainder: 0 };
    this.store.set(COLLECTION, playerId, state);
    return state;
  }

  private alignment(value: number): ReputationAlignment {
    return value > 0 ? 'good' : value < 0 ? 'evil' : 'neutral';
  }

  private effects(value: number): Record<string, number> {
    const c = this.config.constants;
    const goodBonus = value > 0
      ? Math.min(c.reputationGoodPopGrowthCap, value * c.reputationGoodPopGrowthPerPoint)
      : 0;
    const evilPenalty = value < 0
      ? Math.min(c.reputationEvilPopGrowthPenaltyCap, Math.abs(value) * c.reputationEvilPopGrowthPenaltyPerPoint)
      : 0;
    const evilArmyAttackBonus = value < 0
      ? Math.min(c.reputationEvilArmyAttackCap, Math.abs(value) * c.reputationEvilArmyAttackPerPoint)
      : 0;
    const evilArmyDefenseBonus = value < 0
      ? Math.min(c.reputationEvilArmyDefenseCap, Math.abs(value) * c.reputationEvilArmyDefensePerPoint)
      : 0;
    const goodTaxPenalty = value > 0
      ? Math.min(c.reputationGoodGoldTaxPenaltyCap, value * c.reputationGoodGoldTaxPenaltyPerPoint)
      : 0;
    const evilBonus = value < 0
      ? Math.min(c.reputationEvilPveDropRateCap, Math.abs(value) * c.reputationEvilPveDropRatePerPoint)
      : 0;
    return {
      populationGrowthBonus: goodBonus,
      populationGrowthPenalty: evilPenalty,
      populationGrowthMult: value < 0 ? Math.max(0, 1 - evilPenalty) : 1 + goodBonus,
      armyAttackBonus: evilArmyAttackBonus,
      armyDefenseBonus: evilArmyDefenseBonus,
      armyAttackMult: 1 + evilArmyAttackBonus,
      armyDefenseMult: 1 + evilArmyDefenseBonus,
      goldTaxReduction: goodTaxPenalty,
      goldTaxMult: Math.max(0, 1 - goodTaxPenalty),
      pveTreasureDropBonus: evilBonus,
      pveTreasureDropMult: 1 + evilBonus,
    };
  }

  private payload(state: ReputationState): Record<string, unknown> {
    const value = Math.trunc(state.value);
    return { playerId: state.playerId, value, alignment: this.alignment(value), ...this.effects(value), updatedAt: state.updatedAt };
  }

  private get(cmd: Command): CommandResult {
    const playerId = String((cmd.payload as any)?.playerId ?? '');
    if (!playerId) return { ok: false, payload: {}, reason: 'player_not_found' };
    return { ok: true, payload: this.payload(this.ensure(playerId)) };
  }

  private async getByVillage(cmd: Command): Promise<CommandResult> {
    const villageId = String((cmd.payload as any)?.villageId ?? '');
    if (!villageId) return { ok: false, payload: {}, reason: 'village_not_found' };
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId } });
    if (!owner.ok) return owner;
    const playerId = String((owner.payload as any)?.player?.id ?? '');
    if (!playerId) return { ok: false, payload: {}, reason: 'owner_not_found' };
    return { ok: true, payload: { villageId, ...this.payload(this.ensure(playerId)) } };
  }

  private async adjust(cmd: Command): Promise<CommandResult> {
    const { playerId, delta, reason } = cmd.payload as { playerId: string; delta: number; reason?: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'player_not_found' };
    const amount = Number(delta);
    if (!Number.isFinite(amount) || amount === 0) return { ok: false, payload: {}, reason: 'invalid_delta' };
    const state = this.ensure(playerId);
    const before = state.value;
    const effectiveAmount = amount > 0 ? amount + (state.allianceBonus ?? 0) : amount;
    state.baseValue = Math.trunc((state.baseValue ?? before - (state.treasureDelta ?? 0)) + effectiveAmount);
    state.value = state.baseValue + (state.treasureDelta ?? 0);
    state.updatedAt = this.now();
    this.store.set(COLLECTION, playerId, state);
    await this.syncVillages(playerId, state.value);
    const kingdomPvePenaltyChunks = Math.max(0, Math.floor(Number((cmd.payload as any)?.kingdomPvePenaltyChunks ?? 0)));
    const payload = { ...this.payload(state), delta: state.value - before, reason: reason ?? 'gameplay', playerIds: [playerId], ...(kingdomPvePenaltyChunks > 0 ? { kingdomPvePenaltyChunks } : {}) };
    await this.bus.emit({ name: 'reputation.Changed', source: ReputationModule.NAME, ts: this.now(), payload } as DomainEvent);
    return { ok: true, payload };
  }

  private setAllianceBonus(cmd: Command): CommandResult {
    const playerId = String((cmd.payload as any)?.playerId ?? '');
    if (!playerId) return { ok: false, payload: {}, reason: 'player_not_found' };
    const state = this.ensure(playerId);
    state.allianceBonus = Math.max(0, Math.trunc(Number((cmd.payload as any)?.bonus) || 0));
    this.store.set(COLLECTION, playerId, state);
    return { ok: true, payload: { bonus: state.allianceBonus } };
  }

  /** 议会厅消费等用途的原子扣除：声望是道德值，购买不能把正声望透支成负声望。 */
  private async trySpend(cmd: Command): Promise<CommandResult> {
    const { playerId, amount, reason } = cmd.payload as { playerId: string; amount: number; reason?: string };
    const cost = Math.max(0, Math.floor(Number(amount)));
    if (!playerId || !Number.isFinite(cost)) return { ok: false, payload: {}, reason: 'invalid_reputation_cost' };
    const state = this.ensure(playerId);
    if (cost === 0) return { ok: true, payload: { ...this.payload(state), delta: 0, reason: reason ?? 'kingdom_service' } };
    if (state.value < cost) return { ok: false, payload: this.payload(state), reason: 'insufficient_reputation' };
    return this.adjust({ ...cmd, payload: { playerId, delta: -cost, reason: reason ?? 'kingdom_service' } });
  }

  private async adjustByVillage(cmd: Command): Promise<CommandResult> {
    const villageId = String((cmd.payload as any)?.villageId ?? '');
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId } });
    if (!owner.ok) return owner;
    const playerId = String((owner.payload as any)?.player?.id ?? '');
    return this.adjust({ ...cmd, payload: { ...(cmd.payload as any), playerId } });
  }

  private async setTreasureDelta(cmd: Command): Promise<CommandResult> {
    const playerId = String((cmd.payload as any)?.playerId ?? '');
    const delta = Number((cmd.payload as any)?.delta ?? 0);
    if (!playerId || !Number.isFinite(delta)) return { ok: false, payload: {}, reason: 'invalid_reputation' };
    const state = this.ensure(playerId);
    const before = state.value;
    state.treasureDelta = Math.trunc(delta);
    state.value = (state.baseValue ?? before - (state.treasureDelta ?? 0)) + state.treasureDelta;
    state.updatedAt = this.now();
    this.store.set(COLLECTION, playerId, state);
    if (state.value !== before) await this.syncVillages(playerId, state.value);
    const payload = { ...this.payload(state), delta: state.value - before, reason: 'treasure_passive', playerIds: [playerId] };
    if (state.value !== before) await this.bus.emit({ name: 'reputation.Changed', source: ReputationModule.NAME, ts: this.now(), payload } as DomainEvent);
    return { ok: true, payload };
  }

  private async processPvpBattle(cmd: Command): Promise<CommandResult> {
    const { attackerVillageId, targetVillageId, defenderLosses } = cmd.payload as { attackerVillageId: string; targetVillageId: string; defenderLosses?: Record<string, number> };
    const attacker = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId: attackerVillageId } });
    const target = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId: targetVillageId } });
    if (!attacker.ok || !target.ok) return { ok: true, payload: { rewarded: false } };
    const attackerId = String((attacker.payload as any)?.player?.id ?? '');
    const targetId = String((target.payload as any)?.player?.id ?? '');
    if (!attackerId || !targetId || attackerId === targetId) return { ok: true, payload: { rewarded: false } };
    const a = this.ensure(attackerId);
    const t = this.ensure(targetId);
    const c = this.config.constants;
    const isGoodAttack = a.value > 0 && t.value < -c.reputationGoodPvpTargetThreshold;
    const isEvilAttack = a.value < 0 && t.value > c.reputationEvilPvpTargetThreshold;
    if (!isGoodAttack && !isEvilAttack) return { ok: true, payload: { rewarded: false } };
    let killedPop = 0;
    for (const [code, count] of Object.entries(defenderLosses ?? {})) {
      if (!Number.isFinite(count) || count <= 0) continue;
      killedPop += Math.floor(count) * (this.config.units[code]?.popCost ?? 0);
    }
    if (killedPop <= 0) return { ok: true, payload: { rewarded: false, killedPop: 0 } };
    const remainderKey = isGoodAttack ? 'goodPvpKillRemainder' : 'evilPvpKillRemainder';
    const total = (a[remainderKey] ?? 0) + killedPop;
    const rewardUnits = Math.floor(total / 10);
    a[remainderKey] = total % 10;
    this.store.set(COLLECTION, attackerId, a);
    if (rewardUnits <= 0) return { ok: true, payload: { rewarded: false, killedPop, remainder: a[remainderKey] } };
    const delta = (isGoodAttack ? c.reputationGoodPvpReward : -c.reputationEvilPvpReward) * rewardUnits;
    const result = await this.adjust({ ...cmd, payload: { playerId: attackerId, delta, reason: 'pvp_alignment_kills' } });
    return { ok: result.ok, payload: { rewarded: result.ok, killedPop, rewardUnits, ...(result.payload as any) }, reason: result.reason };
  }

  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { side?: string; targetKind?: string; targetId?: string; fromVillage?: string; defenderLossesAttributed?: Record<string, number>; defenderLosses?: Record<string, number> };
    if (p.side !== 'attacker' || !p.fromVillage || !p.targetId) return;
    const losses = p.defenderLossesAttributed ?? p.defenderLosses;
    if (p.targetKind === 'village') {
      await this.processPvpBattle({
        name: 'reputation.ProcessPvpBattle', from: ReputationModule.NAME,
        payload: { attackerVillageId: p.fromVillage, targetVillageId: p.targetId, defenderLosses: losses },
      });
      return;
    }
    if (p.targetKind !== 'pve') return;
    const target = await this.commands.send({ name: 'pve.GetTarget', from: ReputationModule.NAME, payload: { id: p.targetId } });
    if (!target.ok || (target.payload as any)?.faction !== 'kingdom' || (target.payload as any)?.cityState !== true) return;
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId: p.fromVillage } });
    const playerId = String((owner.payload as any)?.player?.id ?? '');
    if (!owner.ok || !playerId) return;
    await this.processKingdomPveBattle(playerId, losses ?? {});
  }

  /** 王国 PvE 战斗击杀人口累计：每满配置人口扣 1 点声望，跨战斗保留余数。 */
  private async processKingdomPveBattle(playerId: string, defenderLosses: Record<string, number>): Promise<void> {
    const state = this.ensure(playerId);
    let killedPopulation = 0;
    for (const [code, raw] of Object.entries(defenderLosses)) {
      const count = Math.max(0, Math.floor(Number(raw) || 0));
      if (count <= 0) continue;
      killedPopulation += count * Math.max(1, this.config.units[code]?.popCost ?? 1);
    }
    if (killedPopulation <= 0) return;
    const perPoint = Math.max(1, this.config.constants.kingdomPveKilledPopulationPerReputation);
    const total = (state.kingdomPveKillRemainder ?? 0) + killedPopulation;
    const reputationPoints = Math.floor(total / perPoint);
    state.kingdomPveKillRemainder = total % perPoint;
    if (reputationPoints <= 0) {
      this.store.set(COLLECTION, playerId, state);
      return;
    }
    const chunkSize = Math.max(1, this.config.constants.kingdomPveRetaliationChunk);
    const beforeChunks = state.kingdomPvePenaltyChunks ?? 0;
    const accumulatedPoints = (state.kingdomPvePenaltyRemainder ?? 0) + reputationPoints;
    const triggeredChunks = Math.floor(accumulatedPoints / chunkSize);
    const afterChunks = beforeChunks + triggeredChunks;
    state.kingdomPvePenaltyRemainder = accumulatedPoints % chunkSize;
    state.kingdomPvePenaltyChunks = afterChunks;
    this.store.set(COLLECTION, playerId, state);
    await this.adjust({ name: 'reputation.Adjust', from: ReputationModule.NAME, payload: { playerId, delta: -reputationPoints, reason: 'kingdom_pve_population_kills', kingdomPvePenaltyChunks: triggeredChunks } });
  }

  private async syncVillages(playerId: string, value: number): Promise<void> {
    const p = await this.commands.send({ name: 'player.Get', from: ReputationModule.NAME, payload: { playerId } });
    if (!p.ok) return;
    const mult = this.effects(value).populationGrowthMult;
    for (const village of ((p.payload as any)?.player?.villages ?? [])) {
      await this.commands.send({ name: 'population.SetReputationGrowthMult', from: ReputationModule.NAME, payload: { villageId: village.id, mult } });
      await this.commands.send({ name: 'population.SetReputationGoldTaxMult', from: ReputationModule.NAME, payload: { villageId: village.id, mult: this.effects(value).goldTaxMult } });
    }
  }
}
