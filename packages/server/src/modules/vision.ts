import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import { hexDistanceWrapped } from '../infra/hex.js';

type TileSnapshot = { q: number; r: number; kind: string; refId?: string; name?: string; icon?: string };
interface VisionState { playerId: string; explored: Record<string, TileSnapshot>; }
interface Source { q: number; r: number; radius: number; }
const COLLECTION = 'vision';

/** 玩家战争迷雾 owner：只保存已经探索过的地图快照，不保存实时地图内容。 */
export class VisionModule {
  static readonly NAME = 'vision';
  constructor(private store: Store, private commands: CommandBus, private config: GameConfig) {}
  setConfig(config: GameConfig): void { this.config = config; }
  init(): void {
    this.commands.register('vision.FilterArea', (c) => this.filterArea(c));
    this.commands.register('vision.GetVisibility', (c) => this.getVisibility(c));
    this.commands.register('vision.Reveal', (c) => this.reveal(c));
    this.commands.register('vision.GetVisibleTiles', (c) => this.getVisibleTiles(c));
  }

  private async sourcesFor(playerId: string): Promise<Source[] | null> {
    const playerRes = await this.commands.send({ name: 'player.Get', from: VisionModule.NAME, payload: { playerId } });
    if (!playerRes.ok) return null;
    const player = (playerRes.payload as any).player;
    const cityRadius = Math.max(0, Number(this.config.constants.raw.city_vision ?? 4));
    const sources: Source[] = (player.villages ?? []).map((v: any) => ({ q: v.q, r: v.r, radius: cityRadius }));
    const marchRes = await this.commands.send({ name: 'movement.ListVisionSources', from: VisionModule.NAME, payload: { playerId } });
    if (marchRes.ok) sources.push(...((marchRes.payload as any).sources ?? []));
    return sources;
  }

  /** 给行军模块的服务器权威可见性查询，同时返回未探索格距已知区域的最小深度。 */
  private async getVisibility(cmd: Command): Promise<CommandResult> {
    const { playerId, q, r } = cmd.payload as { playerId: string; q: number; r: number };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const visible = (x: number, y: number) => sources.some((s) => hexDistanceWrapped({ q: x, r: y }, s, W, H) <= s.radius);
    if (visible(q, r)) return { ok: true, payload: { visibility: 'visible', unexploredDepth: 0 } };
    if (state.explored[`${q},${r}`]) return { ok: true, payload: { visibility: 'explored', unexploredDepth: 0 } };
    let depth = Number.POSITIVE_INFINITY;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!state.explored[`${x},${y}`] && !visible(x, y)) continue;
      depth = Math.min(depth, hexDistanceWrapped({ q, r }, { q: x, r: y }, W, H));
    }
    return { ok: true, payload: { visibility: 'unexplored', unexploredDepth: Number.isFinite(depth) ? depth : -1 } };
  }

  /** 返回当前对 playerId 可见的所有格子 "q,r" 键集合，供其他模块（如 movement.ListForeign）做视野判定。 */
  private async getVisibleTiles(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId: string };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const tiles: string[] = [];
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        if (sources.some((s) => hexDistanceWrapped({ q, r }, s, W, H) <= s.radius)) tiles.push(`${q},${r}`);
      }
    }
    return { ok: true, payload: { tiles } };
  }

  /** 行军每到一格即把它当刻视野内的地块写为已探索，保证玩家不打开地图也不会丢探索进度。 */
  private async reveal(cmd: Command): Promise<CommandResult> {
    const { playerId, q, r, radius } = cmd.payload as { playerId: string; q: number; r: number; radius: number };
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const raw = await this.commands.send({ name: 'world.GetArea', from: VisionModule.NAME, payload: { cq: q, cr: r, full: true } });
    if (!raw.ok) return { ok: false, payload: {}, reason: raw.reason };
    const nowTiles = new Map<string, TileSnapshot>();
    for (const tile of ((raw.payload as any)?.tiles ?? [])) nowTiles.set(`${tile.q},${tile.r}`, tile);
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const sight = Math.max(0, Math.floor(Number(radius) || 0));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (hexDistanceWrapped({ q, r }, { q: x, r: y }, W, H) > sight) continue;
      state.explored[`${x},${y}`] = nowTiles.get(`${x},${y}`) ?? { q: x, r: y, kind: 'empty' };
    }
    this.store.set(COLLECTION, playerId, state);
    return { ok: true, payload: {} };
  }

  private async filterArea(cmd: Command): Promise<CommandResult> {
    const { playerId, tiles } = cmd.payload as { playerId: string; tiles: TileSnapshot[] };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };

    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const current = new Map<string, TileSnapshot>();
    for (const t of tiles) current.set(`${t.q},${t.r}`, t);
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const visible = (q: number, r: number) => sources.some((s) => hexDistanceWrapped({ q, r }, s, W, H) <= s.radius);
    const out: Array<TileSnapshot & { visibility: 'unexplored' | 'explored' | 'visible' }> = [];
    let dirty = false;
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
      const key = `${q},${r}`;
      if (visible(q, r)) {
        const now = current.get(key) ?? { q, r, kind: 'empty' };
        state.explored[key] = now; dirty = true;
        out.push({ ...now, visibility: 'visible' });
      } else if (state.explored[key]) out.push({ ...state.explored[key], visibility: 'explored' });
      else out.push({ q, r, kind: 'empty', visibility: 'unexplored' });
    }
    if (dirty) this.store.set(COLLECTION, playerId, state);
    return { ok: true, payload: { tiles: out } };
  }
}
