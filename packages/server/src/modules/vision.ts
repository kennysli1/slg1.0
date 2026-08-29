import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import { hexDistanceWrapped, linePathWrapped } from '../infra/hex.js';

type Terrain = 'plain' | 'forest' | 'hills';
type TileSnapshot = { q: number; r: number; kind: string; refId?: string; name?: string; icon?: string; terrain?: Terrain };
interface VisionState { playerId: string; explored: Record<string, TileSnapshot>; }
interface RevealReceipt { playerId: string; revealId: string; newlyRevealed: TileSnapshot[]; }
interface Source {
  q: number;
  r: number;
  radius: number;
  /** 城市视野不受地貌影响；在途军队视野按森林方向/丘陵加成计算。 */
  terrainAware?: boolean;
  terrain?: Map<string, Terrain>;
}
const COLLECTION = 'vision';
const RECEIPT_COLLECTION = 'vision_reveal';

/** 玩家战争迷雾 owner：只保存已经探索过的地图快照，不保存实时地图内容。 */
export class VisionModule {
  static readonly NAME = 'vision';
  constructor(private store: Store, private commands: CommandBus, private config: GameConfig) {}
  setConfig(config: GameConfig): void { this.config = config; }
  init(): void {
    this.commands.register('vision.FilterArea', (c) => this.filterArea(c));
    this.commands.register('vision.GetVisibility', (c) => this.getVisibility(c));
    this.commands.register('vision.Reveal', (c) => this.reveal(c));
    this.commands.register('vision.ForgetReveal', (c) => this.forgetReveal(c));
    this.commands.register('vision.GetVisibleTiles', (c) => this.getVisibleTiles(c));
    this.commands.register('vision.GetExploredCount', (c) => this.getExploredCount(c));
    this.commands.register('vision.GetObservers', (c) => this.getObservers(c));
  }

  private async worldDimensions(): Promise<{ W: number; H: number }> {
    const meta = await this.commands.send({ name: 'world.GetMeta', from: VisionModule.NAME, payload: {} });
    const p = meta.payload as { worldW?: number; worldH?: number };
    return {
      W: Number(p.worldW) || this.config.constants.worldW || 41,
      H: Number(p.worldH) || this.config.constants.worldH || 41,
    };
  }

  private async sourcesFor(playerId: string): Promise<Source[] | null> {
    const playerRes = await this.commands.send({ name: 'player.Get', from: VisionModule.NAME, payload: { playerId } });
    if (!playerRes.ok) return null;
    const player = (playerRes.payload as any).player;
    const cityRadius = Math.max(0, Number(this.config.constants.raw.city_vision ?? 4));
    const sources: Source[] = (player.villages ?? []).map((v: any) => ({ q: v.q, r: v.r, radius: cityRadius }));
    const marchRes = await this.commands.send({ name: 'movement.ListVisionSources', from: VisionModule.NAME, payload: { playerId } });
    if (marchRes.ok) sources.push(...((marchRes.payload as any).sources ?? []));
    await Promise.all(sources.filter((source) => source.terrainAware).map(async (source) => {
      source.terrain = await this.terrainAround(source.q, source.r, this.terrainQueryRadius(source));
    }));
    return sources;
  }

  /** 读取军队视野源周围的地貌，避免把地貌状态复制到 vision owner。 */
  private async terrainAround(q: number, r: number, radius: number): Promise<Map<string, Terrain>> {
    const area = await this.commands.send({
      name: 'world.GetArea', from: VisionModule.NAME,
      payload: { cq: q, cr: r, r: Math.max(0, radius), includeEmpty: true },
    });
    const terrain = new Map<string, Terrain>();
    if (!area.ok) return terrain;
    for (const tile of ((area.payload as any)?.tiles ?? [])) {
      const value = tile?.terrain;
      if (value === 'forest' || value === 'hills' || value === 'plain') terrain.set(`${tile.q},${tile.r}`, value);
    }
    return terrain;
  }

  private sourceRadius(source: Source): number {
    const base = Math.max(0, Math.floor(Number(source.radius) || 0));
    const at = source.terrain?.get(`${source.q},${source.r}`);
    const hillsBonus = source.terrainAware && at === 'hills'
      ? Math.max(0, Math.floor(Number(this.config.constants.hillsVisionBonus) || 0))
      : 0;
    return base + hillsBonus;
  }

  private terrainQueryRadius(source: Source): number {
    return Math.max(0, Math.floor(Number(source.radius) || 0))
      + Math.max(0, Math.floor(Number(this.config.constants.hillsVisionBonus) || 0));
  }

  /** 目标方向上只要穿过森林，军队该方向的视野半径减少配置的格数。 */
  private forestObstructed(source: Source, q: number, r: number, W: number, H: number): boolean {
    if (!source.terrainAware || !source.terrain) return false;
    const path = linePathWrapped({ q: source.q, r: source.r }, { q, r }, W, H);
    return path.slice(1).some((point) => source.terrain!.get(`${point.q},${point.r}`) === 'forest');
  }

  private visibleFrom(source: Source, q: number, r: number, W: number, H: number): boolean {
    const distance = hexDistanceWrapped({ q, r }, source, W, H);
    const radius = this.sourceRadius(source);
    if (distance > radius) return false;
    if (!this.forestObstructed(source, q, r, W, H)) return true;
    const penalty = Math.max(0, Math.floor(Number(this.config.constants.forestVisionPenalty) || 0));
    return distance <= Math.max(0, radius - penalty);
  }

  /** 给行军模块的服务器权威可见性查询，同时返回未探索格距已知区域的最小深度。 */
  private async getVisibility(cmd: Command): Promise<CommandResult> {
    const { playerId, q, r } = cmd.payload as { playerId: string; q: number; r: number };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };
    const { W, H } = await this.worldDimensions();
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const visible = (x: number, y: number) => sources.some((source) => this.visibleFrom(source, x, y, W, H));
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
    const { W, H } = await this.worldDimensions();
    const tiles: string[] = [];
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        if (sources.some((source) => this.visibleFrom(source, q, r, W, H))) tiles.push(`${q},${r}`);
      }
    }
    return { ok: true, payload: { tiles } };
  }

  /** 返回玩家累计已探索格数；当前城镇/行军视野中的格子也计入，供任务进度使用。 */
  private async getExploredCount(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId: string };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };
    const { W, H } = await this.worldDimensions();
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const count = new Set(Object.keys(state.explored));
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
      if (sources.some((source) => this.visibleFrom(source, q, r, W, H))) count.add(`${q},${r}`);
    }
    return { ok: true, payload: { count: count.size } };
  }

  /** 行军每到一格即把它当刻视野内的地块写为已探索，保证玩家不打开地图也不会丢探索进度。 */
  private async reveal(cmd: Command): Promise<CommandResult> {
    const { playerId, q, r, radius, terrainAware, revealId } = cmd.payload as {
      playerId: string; q: number; r: number; radius: number; terrainAware?: boolean; revealId?: string;
    };
    const receiptKey = revealId ? `${playerId}:${revealId}` : undefined;
    if (receiptKey) {
      const receipt = this.store.get<RevealReceipt>(RECEIPT_COLLECTION, receiptKey);
      if (receipt) return { ok: true, payload: { newlyRevealed: receipt.newlyRevealed } };
    }
    const { W, H } = await this.worldDimensions();
    const source: Source = {
      q, r, radius: Math.max(0, Math.floor(Number(radius) || 0)), terrainAware: terrainAware === true,
    };
    if (source.terrainAware) source.terrain = await this.terrainAround(q, r, this.terrainQueryRadius(source));
    const raw = await this.commands.send({ name: 'world.GetArea', from: VisionModule.NAME, payload: { cq: q, cr: r, full: true, includeEmpty: true } });
    if (!raw.ok) return { ok: false, payload: {}, reason: raw.reason };
    const nowTiles = new Map<string, TileSnapshot>();
    for (const tile of ((raw.payload as any)?.tiles ?? [])) nowTiles.set(`${tile.q},${tile.r}`, tile);
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const newlyRevealed: TileSnapshot[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!this.visibleFrom(source, x, y, W, H)) continue;
      const key = `${x},${y}`;
      const tile = nowTiles.get(key) ?? { q: x, r: y, kind: 'empty' };
      if (!state.explored[key]) newlyRevealed.push(tile);
      state.explored[key] = tile;
    }
    this.store.set(COLLECTION, playerId, state);
    if (receiptKey && revealId) this.store.set<RevealReceipt>(RECEIPT_COLLECTION, receiptKey, { playerId, revealId, newlyRevealed });
    return { ok: true, payload: { newlyRevealed } };
  }

  private forgetReveal(cmd: Command): CommandResult {
    const { playerId, revealId } = cmd.payload as { playerId: string; revealId: string };
    if (playerId && revealId) this.store.delete(RECEIPT_COLLECTION, `${playerId}:${revealId}`);
    return { ok: true, payload: {} };
  }

  /**
   * 返回所有「城市视野」能看到 (q,r) 的玩家 id 列表（仅城市视野，不计行军视野，O(players×villages)）。
   * 用于增量推送外军步进：只推给能看见该格的玩家。
   */
  private async getObservers(cmd: Command): Promise<CommandResult> {
    const { q, r } = cmd.payload as { q: number; r: number };
    const allRes = await this.commands.send({ name: 'player.ListAll', from: VisionModule.NAME, payload: {} });
    if (!allRes.ok) return { ok: true, payload: { playerIds: [] } };
    const { W, H } = await this.worldDimensions();
    const cityRadius = Math.max(0, Number(this.config.constants.raw.city_vision ?? 4));
    const playerIds: string[] = [];
    for (const player of ((allRes.payload as any).players ?? [])) {
      const canSee = (player.villages ?? []).some(
        (v: any) => hexDistanceWrapped({ q, r }, { q: v.q, r: v.r }, W, H) <= cityRadius,
      );
      if (canSee) playerIds.push(player.id);
    }
    return { ok: true, payload: { playerIds } };
  }

  private async filterArea(cmd: Command): Promise<CommandResult> {
    const { playerId, tiles } = cmd.payload as { playerId: string; tiles: TileSnapshot[] };
    const sources = await this.sourcesFor(playerId);
    if (!sources) return { ok: false, payload: {}, reason: 'player_not_found' };

    const { W, H } = await this.worldDimensions();
    const current = new Map<string, TileSnapshot>();
    for (const t of tiles) current.set(`${t.q},${t.r}`, t);
    const state = this.store.get<VisionState>(COLLECTION, playerId) ?? { playerId, explored: {} };
    const visible = (q: number, r: number) => sources.some((source) => this.visibleFrom(source, q, r, W, H));
    const out: Array<TileSnapshot & { visibility: 'unexplored' | 'explored' | 'visible' }> = [];
    let dirty = false;
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
      const key = `${q},${r}`;
      if (visible(q, r)) {
        const now = current.get(key) ?? { q, r, kind: 'empty' };
        state.explored[key] = now; dirty = true;
        out.push({ ...now, visibility: 'visible' });
      } else if (current.get(key)?.kind === 'pve' && /^kingdom-(capital|fief-(ne|se|sw|nw))$/.test(String(current.get(key)?.refId ?? ''))) {
        // 王都与四封地是世界公开地标：即使尚未探索，也显示地标本身；
        // 守军、资源和其它实时内容仍只在可见时由 PvE/目标接口提供。
        out.push({ ...(current.get(key) ?? { q, r, kind: 'empty' }), visibility: 'explored' });
      } else if (state.explored[key]) {
        // 旧存档的探索快照没有 terrain；地貌由 World 按固定 seed 派生，
        // 因此只从当前权威地块补地貌，POI 仍使用当时快照，避免泄露实时变化。
        const snapshot = state.explored[key]!;
        const terrain = current.get(key)?.terrain;
        out.push({ ...snapshot, ...(terrain ? { terrain } : {}), visibility: 'explored' });
      }
      else out.push({ q, r, kind: 'empty', visibility: 'unexplored' });
    }
    if (dirty) this.store.set(COLLECTION, playerId, state);
    return { ok: true, payload: { tiles: out } };
  }
}
