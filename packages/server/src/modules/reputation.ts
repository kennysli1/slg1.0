import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';

export type ReputationAlignment = 'good' | 'evil' | 'neutral';

interface ReputationState {
  playerId: string;
  value: number;
  updatedAt: number;
}

const COLLECTION = 'reputation';

/** 玩家善恶声望的唯一 owner。声望按玩家持有，城镇只接收派生人口倍率。 */
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
    this.commands.register('reputation.AdjustByVillage', (c) => this.adjustByVillage(c));
    this.commands.register('reputation.ProcessPvpAttack', (c) => this.processPvpAttack(c));
  }

  resume(): void {
    for (const raw of this.store.all<ReputationState>(COLLECTION)) {
      const state = this.normalize(raw);
      this.store.set(COLLECTION, state.playerId, state);
      void this.syncVillages(state.playerId, state.value);
    }
  }

  private normalize(raw: ReputationState): ReputationState {
    return {
      playerId: raw.playerId,
      value: Number.isFinite(raw.value) ? Math.trunc(raw.value) : 0,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : this.now(),
    };
  }

  private ensure(playerId: string): ReputationState {
    const existing = this.store.get<ReputationState>(COLLECTION, playerId);
    if (existing) return this.normalize(existing);
    const state: ReputationState = { playerId, value: 0, updatedAt: this.now() };
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
    const evilBonus = value < 0
      ? Math.min(c.reputationEvilPveDropRateCap, Math.abs(value) * c.reputationEvilPveDropRatePerPoint)
      : 0;
    return {
      populationGrowthBonus: goodBonus,
      populationGrowthMult: 1 + goodBonus,
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
    state.value = Math.trunc(before + amount);
    state.updatedAt = this.now();
    this.store.set(COLLECTION, playerId, state);
    await this.syncVillages(playerId, state.value);
    const payload = { ...this.payload(state), delta: state.value - before, reason: reason ?? 'gameplay', playerIds: [playerId] };
    await this.bus.emit({ name: 'reputation.Changed', source: ReputationModule.NAME, ts: this.now(), payload } as DomainEvent);
    return { ok: true, payload };
  }

  private async adjustByVillage(cmd: Command): Promise<CommandResult> {
    const villageId = String((cmd.payload as any)?.villageId ?? '');
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: ReputationModule.NAME, payload: { villageId } });
    if (!owner.ok) return owner;
    const playerId = String((owner.payload as any)?.player?.id ?? '');
    return this.adjust({ ...cmd, payload: { ...(cmd.payload as any), playerId } });
  }

  private async processPvpAttack(cmd: Command): Promise<CommandResult> {
    const { attackerVillageId, targetVillageId } = cmd.payload as { attackerVillageId: string; targetVillageId: string };
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
    const delta = isGoodAttack ? c.reputationGoodPvpReward : -c.reputationEvilPvpReward;
    const result = await this.adjust({ ...cmd, payload: { playerId: attackerId, delta, reason: 'pvp_alignment_attack' } });
    return { ok: result.ok, payload: { rewarded: result.ok, ...(result.payload as any) }, reason: result.reason };
  }

  private async syncVillages(playerId: string, value: number): Promise<void> {
    const p = await this.commands.send({ name: 'player.Get', from: ReputationModule.NAME, payload: { playerId } });
    if (!p.ok) return;
    const mult = this.effects(value).populationGrowthMult;
    for (const village of ((p.payload as any)?.player?.villages ?? [])) {
      await this.commands.send({ name: 'population.SetReputationGrowthMult', from: ReputationModule.NAME, payload: { villageId: village.id, mult } });
    }
  }
}
