import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, TreasureDef } from '../infra/config.js';

/** 炼金炉：三个同品质宝物经过定时炼化后，按更高品质宝物 dropRate 加权产出一件。 */
interface AlchemyState {
  villageId: string;
  inputs: Array<string | null>;
  result?: string;
  finishAt?: number;
  taskId?: string;
}

type TreasureLocation = 'town' | 'treasury' | 'reserve';
const COLLECTION = 'alchemy';
const RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;

export class AlchemyModule {
  static readonly NAME = 'alchemy';

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
    this.commands.register('alchemy.Get', (c) => this.get(c));
    this.commands.register('alchemy.Select', (c) => this.select(c));
    this.commands.register('alchemy.Start', (c) => this.start(c));
    this.commands.register('alchemy.Claim', (c) => this.claim(c));
  }

  createVillage(villageId: string): void {
    this.store.set(COLLECTION, villageId, { villageId, inputs: [null, null, null] } satisfies AlchemyState);
  }

  wipeSingleVillage(villageId: string): void {
    this.scheduler.cancelByOwner(`alchemy:${villageId}`);
    this.store.delete(COLLECTION, villageId);
  }

  async resume(): Promise<void> {
    for (const state of this.store.all<AlchemyState>(COLLECTION)) {
      const s = this.ensureState(state.villageId);
      if (!s.finishAt || s.result) continue;
      if (s.finishAt <= this.now()) void this.finish(s.villageId);
      else this.schedule(s);
    }
  }

  private ensureState(villageId: string): AlchemyState {
    let s = this.store.get<AlchemyState>(COLLECTION, villageId);
    if (!s) {
      s = { villageId, inputs: [null, null, null] };
      this.store.set(COLLECTION, villageId, s);
      return s;
    }
    if (!Array.isArray(s.inputs)) s.inputs = [null, null, null];
    s.inputs = [s.inputs[0] ?? null, s.inputs[1] ?? null, s.inputs[2] ?? null];
    return s;
  }

  private async buildingLevel(villageId: string): Promise<number> {
    const res = await this.commands.send({ name: 'building.GetBuildingLevel', from: AlchemyModule.NAME, payload: { villageId, kind: 'alchemy' } });
    return res.ok ? Number((res.payload as { level?: number }).level ?? 0) : 0;
  }

  private async treasureList(villageId: string): Promise<any | null> {
    const res = await this.commands.send({ name: 'treasure.List', from: AlchemyModule.NAME, payload: { villageId } });
    return res.ok ? res.payload : null;
  }

  private available(payload: any): Array<{ code: string; location: TreasureLocation; name: string; icon: string; rarity: string }> {
    const out: Array<{ code: string; location: TreasureLocation; name: string; icon: string; rarity: string }> = [];
    const add = (codes: unknown, location: TreasureLocation) => {
      if (!Array.isArray(codes)) return;
      for (const code of codes) {
        const t = this.config.treasures[String(code)];
        if (t) out.push({ code: String(code), location, name: t.name, icon: t.icon, rarity: t.rarity });
      }
    };
    add(payload?.town, 'town'); add(payload?.treasury, 'treasury'); add(payload?.treasuryReserve, 'reserve');
    return out;
  }

  private async get(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const level = await this.buildingLevel(villageId);
    const treasurePayload = await this.treasureList(villageId);
    const details = s.inputs.map((code) => code ? this.describe(code) : null);
    return {
      ok: true,
      payload: {
        villageId, built: level > 0, level,
        inputs: details, inputCodes: [...s.inputs],
        result: s.result ? this.describe(s.result) : null,
        refining: !!s.finishAt, finishAt: s.finishAt,
        refineSec: this.config.constants.alchemyRefineSec,
        available: this.available(treasurePayload),
      },
    };
  }

  private describe(code: string): { code: string; name: string; icon: string; rarity: string } | null {
    const t = this.config.treasures[code];
    return t ? { code, name: t.name, icon: t.icon, rarity: t.rarity } : null;
  }

  private async select(cmd: Command): Promise<CommandResult> {
    const { villageId, slot, code, location } = cmd.payload as { villageId: string; slot: number; code: string; location: TreasureLocation };
    const s = this.ensureState(villageId);
    if (await this.buildingLevel(villageId) <= 0) return { ok: false, payload: {}, reason: 'alchemy_not_built' };
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) return { ok: false, payload: {}, reason: 'alchemy_slot_invalid' };
    if (s.finishAt || s.result) return { ok: false, payload: {}, reason: 'alchemy_in_progress' };
    if (s.inputs[slot]) return { ok: false, payload: {}, reason: 'alchemy_slot_occupied' };
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    const list = await this.treasureList(villageId);
    const available = this.available(list);
    const held = available.find((x) => x.code === code && x.location === location);
    if (!held) return { ok: false, payload: {}, reason: 'not_held' };
    const first = s.inputs[0] ? this.config.treasures[s.inputs[0]] : undefined;
    if (slot > 0 && first && first.rarity !== t.rarity) return { ok: false, payload: {}, reason: 'alchemy_quality_mismatch' };
    const removed = await this.commands.send({ name: 'treasure.RemoveForAlchemy', from: AlchemyModule.NAME, payload: { villageId, code, location } });
    if (!removed.ok) return { ok: false, payload: {}, reason: removed.reason ?? 'not_held' };
    s.inputs[slot] = code;
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
    return { ok: true, payload: { slot, code } };
  }

  private async start(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    if (await this.buildingLevel(villageId) <= 0) return { ok: false, payload: {}, reason: 'alchemy_not_built' };
    if (s.finishAt) return { ok: false, payload: {}, reason: 'alchemy_in_progress' };
    if (s.result) return { ok: false, payload: {}, reason: 'alchemy_result_pending' };
    if (s.inputs.some((x) => !x)) return { ok: false, payload: {}, reason: 'alchemy_no_input' };
    const defs = s.inputs.map((x) => this.config.treasures[x!]).filter(Boolean) as TreasureDef[];
    if (defs.length !== 3 || defs.some((x) => x.rarity !== defs[0].rarity)) return { ok: false, payload: {}, reason: 'alchemy_quality_mismatch' };
    const target = this.nextRarity(defs[0].rarity);
    if (!target || !this.pool(target).length) return { ok: false, payload: {}, reason: 'alchemy_no_target' };
    s.finishAt = this.now() + Math.max(1, this.config.constants.alchemyRefineSec) * 1000;
    this.store.set(COLLECTION, villageId, s);
    this.schedule(s);
    await this.emitUpdated(villageId);
    return { ok: true, payload: { finishAt: s.finishAt, refineSec: this.config.constants.alchemyRefineSec } };
  }

  private schedule(s: AlchemyState): void {
    if (!s.finishAt) return;
    this.scheduler.cancelByOwner(`alchemy:${s.villageId}`);
    s.taskId = this.scheduler.scheduleAt(s.finishAt, () => this.finish(s.villageId), `alchemy:${s.villageId}`, `village:${s.villageId}`);
    this.store.set(COLLECTION, s.villageId, s);
  }

  private async finish(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    if (!s.finishAt || s.result) return;
    const defs = s.inputs.map((x) => x ? this.config.treasures[x] : undefined).filter(Boolean) as TreasureDef[];
    const target = defs.length ? this.nextRarity(defs[0].rarity) : undefined;
    const picked = target ? this.weightedPick(this.pool(target)) : undefined;
    if (!picked) return;
    s.result = picked.code;
    s.finishAt = undefined;
    s.taskId = undefined;
    s.inputs = [null, null, null];
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
  }

  private async claim(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    if (!s.result) return { ok: false, payload: {}, reason: 'alchemy_not_ready' };
    const code = s.result;
    const granted = await this.commands.send({ name: 'treasure.Grant', from: AlchemyModule.NAME, payload: { villageId, code } });
    if (!granted.ok) return { ok: false, payload: {}, reason: granted.reason === 'treasure_slots_full' ? 'treasure_slots_full' : (granted.reason ?? 'treasure_slots_full') };
    s.result = undefined;
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
    return { ok: true, payload: { code, treasure: this.describe(code) } };
  }

  private nextRarity(rarity: string): string | undefined {
    const i = RARITIES.indexOf(rarity as any);
    return i >= 0 && i < RARITIES.length - 1 ? RARITIES[i + 1] : undefined;
  }

  private pool(rarity: string): TreasureDef[] {
    return Object.values(this.config.treasures).filter((t) => t.rarity === rarity && Number(t.dropRate) > 0);
  }

  private weightedPick(pool: TreasureDef[]): TreasureDef | undefined {
    const total = pool.reduce((sum, t) => sum + Math.max(0, Number(t.dropRate) || 0), 0);
    if (total <= 0) return undefined;
    let roll = Math.min(0.999999999, Math.max(0, this.rng())) * total;
    for (const t of pool) { roll -= Math.max(0, Number(t.dropRate) || 0); if (roll < 0) return t; }
    return pool[pool.length - 1];
  }

  private async emitUpdated(villageId: string): Promise<void> {
    await this.bus.emit({ name: 'alchemy.Updated', source: AlchemyModule.NAME, ts: this.now(), payload: { villageId } } as DomainEvent);
  }
}

