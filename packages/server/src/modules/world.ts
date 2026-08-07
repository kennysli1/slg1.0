import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { GameConfig } from '../infra/config.js';
import { hexKey, wrapHex, hexDistanceWrapped } from '../infra/hex.js';
import { makeLogger } from '../infra/logger.js';

/**
 * 领域模块 · World（地图 / 坐标 / 地块）
 * 对应设计文档 02_系统清单F组、09_地图与行军系统重做
 *
 * 职责：地图所有地块的 owner——记录每个 (q,r) 上是什么（玩家村/PvE目标/空地）。
 * 提供坐标、距离查询。PvE 目标的"内容"(守军/战利品)归 PvE 模块，World 只管"哪里有个目标"。
 *
 * 坐标：**六边形轴坐标 (q,r)**（axial），几何统一走 infra/hex.ts。
 * 扩展点：地图尺寸（半径，环数）、PvE 点密度可配置。
 */

export type TileKind = 'empty' | 'village' | 'pve';

export interface Tile {
  q: number;
  r: number;
  kind: TileKind;
  /** 村庄/目标的 id；empty 时为空 */
  refId?: string;
  /** 展示名 */
  name?: string;
  /** 图标基名（pve 目标用，渲染时拼 /art/+基名+.png）；村庄不带，前端用默认主基地图 */
  icon?: string;
}

interface WorldState {
  w: number; // 环绕平行四边形宽（axial q 周期）
  h: number; // 环绕平行四边形高（axial r 周期）
}

const COLLECTION_META = 'world_meta';
const COLLECTION_TILE = 'world_tile';

export class WorldModule {
  private worldW = 41; // 环绕平行四边形宽（axial q 周期）
  private worldH = 41; // 环绕平行四边形高（axial r 周期）
  static readonly NAME = 'world';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'world',
    publicActions: {
      GetArea: {
        command: 'world.GetArea', needAuth: true,
        schema: {
          cq: { type: 'integer', min: -200, max: 200 },
          cr: { type: 'integer', min: -200, max: 200 },
          r:  { type: 'integer', min: 0, max: 50 },
          full: { type: 'boolean', optional: true },
        },
      },
    },
  };

  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private _now: () => number,
    private config: GameConfig,
  ) {}

  init(): void {
    const meta = this.store.get<WorldState>(COLLECTION_META, 'meta');
    if (meta && typeof meta.w === 'number') {
      this.worldW = meta.w;
      this.worldH = meta.h;
    } else {
      this.worldW = this.config.constants.worldW ?? 41;
      this.worldH = this.config.constants.worldH ?? 41;
    }
    this.normalizeTiles();
    this.commands.register('world.GetTile', (c) => this.getTile(c));
    this.commands.register('world.GetTileByRef', (c) => this.getTileByRef(c));
    this.commands.register('world.MinVillageDistance', (c) => this.minVillageDistance(c));
    this.commands.register('world.ClearVillage', (c) => this.clearVillage(c));
    this.commands.register('world.GetArea', (c) => this.getArea(c));
    this.commands.register('world.Distance', (c) => this.distance(c));
    this.commands.register('world.PlaceVillage', (c) => this.placeVillage(c));
    this.commands.register('world.PlacePve', (c) => this.placePve(c));
  }

  /** 归一已有 tile 坐标进环面 [0,W)×[0,H)（幂等，兼容旧六边形存档；W=H=41 时旧坐标∈[-20,20] 单射→零碰撞）。 */
  private normalizeTiles(): void {
    const W = this.worldW, H = this.worldH;
    const log = makeLogger('world:migrate');
    let migrated = 0;
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      const w = wrapHex({ q: t.q, r: t.r }, W, H);
      if (w.q !== t.q || w.r !== t.r) {
        this.store.delete(COLLECTION_TILE, hexKey(t.q, t.r));
        this.store.set(COLLECTION_TILE, hexKey(w.q, w.r), { ...t, q: w.q, r: w.r });
        migrated++;
      }
    }
    if (migrated > 0) log(`normalized ${migrated} world_tile coords into torus ${W}x${H}`);
  }

  /** 初始化地图（环绕平行四边形 W×H，坐标对 (W,H) 取模无缝）。 */
  setup(w = 41, h = 41): void {
    this.worldW = w;
    this.worldH = h;
    this.store.set<WorldState>(COLLECTION_META, 'meta', { w, h });
  }

  private getTile(cmd: Command): CommandResult {
    const { q, r } = cmd.payload as { q: number; r: number };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const t = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
    return { ok: true, payload: { tile: t ?? { q: w.q, r: w.r, kind: 'empty' } } };
  }

  /** 按 owner id 反查地块，供行军等模块派生服务器权威坐标。 */
  private getTileByRef(cmd: Command): CommandResult {
    const { refId, kind } = cmd.payload as { refId: string; kind?: TileKind };
    const tile = this.store.all<Tile>(COLLECTION_TILE).find((t) =>
      t.refId === refId && (kind ? t.kind === kind : true));
    if (!tile) return { ok: false, payload: {}, reason: 'tile_not_found' };
    return { ok: true, payload: { tile } };
  }

  /** 返回以 (cq,cr) 为中心、六边形半径 r 内的所有非空地块。
   *  full=true 时忽略半径上限，返回整张地图的全部非空地块（用于全图渲染）。 */
  private getArea(cmd: Command): CommandResult {
    const { cq, cr, r, full } = cmd.payload as { cq: number; cr: number; r: number; full?: boolean };
    const center = { q: cq, r: cr };
    const radius = full
      ? Number.POSITIVE_INFINITY
      : Math.min(Math.max(0, r), this.config.constants.mapViewRadius + 6);
    const tiles: Tile[] = [];
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (full || hexDistanceWrapped(center, t, this.worldW, this.worldH) <= radius) tiles.push(t);
    }
    return { ok: true, payload: { tiles } };
  }

  /** 六边形距离（格）。行军时间由 Movement 用它和速度算。 */
  private distance(cmd: Command): CommandResult {
    const { from, to } = cmd.payload as { from: { q: number; r: number }; to: { q: number; r: number } };
    const d = hexDistanceWrapped(from, to, this.worldW, this.worldH);
    return { ok: true, payload: { distance: d } };
  }

  private placeVillage(cmd: Command): CommandResult {
    const { q, r, refId, name } = cmd.payload as { q: number; r: number; refId: string; name: string };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const exist = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, hexKey(w.q, w.r), { q: w.q, r: w.r, kind: 'village', refId, name });
    return { ok: true, payload: { q: w.q, r: w.r } };
  }

  /** 查询 (q,r) 到最近村庄的六边形距离；无村庄时 distance=Infinity 用 -1 表示。 */
  private minVillageDistance(cmd: Command): CommandResult {
    const { q, r } = cmd.payload as { q: number; r: number };
    let min = Number.POSITIVE_INFINITY;
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (t.kind !== 'village') continue;
      const d = hexDistanceWrapped({ q, r }, { q: t.q, r: t.r }, this.worldW, this.worldH);
      if (d < min) min = d;
    }
    return {
      ok: true,
      payload: { distance: Number.isFinite(min) ? min : -1 },
    };
  }

  /** 放弃/删村：把村庄地块变回 empty。 */
  private clearVillage(cmd: Command): CommandResult {
    const { refId } = cmd.payload as { refId: string };
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (t.kind === 'village' && t.refId === refId) {
        this.store.set<Tile>(COLLECTION_TILE, hexKey(t.q, t.r), { q: t.q, r: t.r, kind: 'empty' });
        return { ok: true, payload: { q: t.q, r: t.r } };
      }
    }
    return { ok: false, payload: {}, reason: 'village_tile_not_found' };
  }

  private placePve(cmd: Command): CommandResult {
    const { q, r, refId, name, icon } = cmd.payload as { q: number; r: number; refId: string; name: string; icon?: string };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const exist = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, hexKey(w.q, w.r), { q: w.q, r: w.r, kind: 'pve', refId, name, icon });
    return { ok: true, payload: { q: w.q, r: w.r } };
  }
}
