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
  init(): void { this.commands.register('vision.FilterArea', (c) => this.filterArea(c)); }

  private async filterArea(cmd: Command): Promise<CommandResult> {
    const { playerId, tiles } = cmd.payload as { playerId: string; tiles: TileSnapshot[] };
    const playerRes = await this.commands.send({ name: 'player.Get', from: VisionModule.NAME, payload: { playerId } });
    if (!playerRes.ok) return { ok: false, payload: {}, reason: playerRes.reason };
    const player = (playerRes.payload as any).player;
    const cityRadius = Math.max(0, Number(this.config.constants.raw.city_vision ?? 4));
    const sources: Source[] = (player.villages ?? []).map((v: any) => ({ q: v.q, r: v.r, radius: cityRadius }));
    const marchRes = await this.commands.send({ name: 'movement.ListVisionSources', from: VisionModule.NAME, payload: { playerId } });
    if (marchRes.ok) sources.push(...((marchRes.payload as any).sources ?? []));

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
