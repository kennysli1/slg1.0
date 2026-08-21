import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';

export type DiplomaticRelation = 'allied' | 'neutral' | 'hostile';
interface RelationRecord { a: string; b: string; relation: DiplomaticRelation; updatedAt: number; }

/** 最小外交状态：玩家对之间的对称盟军/中立/敌对关系。未写入的关系永远是中立。 */
export class DiplomacyModule {
  static readonly NAME = 'diplomacy';
  private readonly collection = 'diplomacy';
  constructor(private store: Store, private bus: EventBus, private commands: CommandBus, private now: () => number) {}
  setConfig(_config: unknown): void { /* diplomacy has no balance constants yet */ }

  init(): void {
    this.commands.register('diplomacy.GetRelation', (c) => this.getRelation(c));
    this.commands.register('diplomacy.SetRelation', (c) => this.setRelation(c));
    this.commands.register('diplomacy.DeclareWar', (c) => this.declareWar(c));
  }

  private key(a: string, b: string): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
  private read(a: string, b: string): DiplomaticRelation {
    if (!a || !b || a === b) return 'allied';
    return this.store.get<RelationRecord>(this.collection, this.key(a, b))?.relation ?? 'neutral';
  }
  private getRelation(cmd: Command): CommandResult {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    if (!playerId || !targetPlayerId) return { ok: false, payload: {}, reason: 'player_not_found' };
    return { ok: true, payload: { playerId, targetPlayerId, relation: this.read(playerId, targetPlayerId) } };
  }
  private setRelation(cmd: Command): CommandResult {
    const { playerId, targetPlayerId, relation } = cmd.payload as { playerId: string; targetPlayerId: string; relation: DiplomaticRelation };
    if (!playerId || !targetPlayerId || playerId === targetPlayerId) return { ok: false, payload: {}, reason: 'invalid_relation_target' };
    if (!['allied', 'neutral', 'hostile'].includes(relation)) return { ok: false, payload: {}, reason: 'invalid_relation' };
    const record: RelationRecord = { a: playerId < targetPlayerId ? playerId : targetPlayerId, b: playerId < targetPlayerId ? targetPlayerId : playerId, relation, updatedAt: this.now() };
    this.store.set(this.collection, this.key(playerId, targetPlayerId), record);
    void this.bus.emit({ name: 'diplomacy.Changed', source: DiplomacyModule.NAME, ts: this.now(), payload: { ...record } });
    return { ok: true, payload: { relation } };
  }
  private declareWar(cmd: Command): CommandResult {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    return this.setRelation({ ...cmd, payload: { playerId, targetPlayerId, relation: 'hostile' } });
  }
}
