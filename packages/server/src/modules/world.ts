import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { GameConfig } from '../infra/config.js';
import { hexKey, hexDistance } from '../infra/hex.js';

/**
 * 领域模块 · World（地图 / 坐标 / 地块）
 * 对应设计文档 02_系统清单F组、1_原版拆解/04(Natars/绿洲)
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
  size: number; // 地图半径（环数）：合法坐标满足 hexDistance(原点,格) <= size
}

const COLLECTION_META = 'world_meta';
const COLLECTION_TILE = 'world_tile';

export class WorldModule {
  static readonly NAME = 'world';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'world',
    publicActions: {
      GetArea: { command: 'world.GetArea', needAuth: true },
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
    this.commands.register('world.GetTile', (c) => this.getTile(c));
    this.commands.register('world.GetTileByRef', (c) => this.getTileByRef(c));
    this.commands.register('world.GetArea', (c) => this.getArea(c));
    this.commands.register('world.Distance', (c) => this.distance(c));
    this.commands.register('world.PlaceVillage', (c) => this.placeVillage(c));
    this.commands.register('world.PlacePve', (c) => this.placePve(c));
  }

  /** 初始化地图（骨架：固定半径，PvE 点由 config 确定性散布，避免 Math.random 破坏可复现）。 */
  setup(size = 20): void {
    this.store.set<WorldState>(COLLECTION_META, 'meta', { size });
  }

  private getTile(cmd: Command): CommandResult {
    const { q, r } = cmd.payload as { q: number; r: number };
    const t = this.store.get<Tile>(COLLECTION_TILE, hexKey(q, r));
    return { ok: true, payload: { tile: t ?? { q, r, kind: 'empty' } } };
  }

  /** 按 owner id 反查地块，供行军等模块派生服务器权威坐标。 */
  private getTileByRef(cmd: Command): CommandResult {
    const { refId, kind } = cmd.payload as { refId: string; kind?: TileKind };
    const tile = this.store.all<Tile>(COLLECTION_TILE).find((t) =>
      t.refId === refId && (kind ? t.kind === kind : true));
    if (!tile) return { ok: false, payload: {}, reason: 'tile_not_found' };
    return { ok: true, payload: { tile } };
  }

  /** 返回以 (cq,cr) 为中心、六边形半径 r 内的所有非空地块。 */
  private getArea(cmd: Command): CommandResult {
    const { cq, cr, r } = cmd.payload as { cq: number; cr: number; r: number };
    const center = { q: cq, r: cr };
    const radius = Math.min(Math.max(0, r), this.config.constants.mapViewRadius + 6);
    const tiles: Tile[] = [];
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (hexDistance(center, t) <= radius) tiles.push(t);
    }
    return { ok: true, payload: { tiles } };
  }

  /** 六边形距离（格）。行军时间由 Movement 用它和速度算。 */
  private distance(cmd: Command): CommandResult {
    const { from, to } = cmd.payload as { from: { q: number; r: number }; to: { q: number; r: number } };
    const d = hexDistance(from, to);
    return { ok: true, payload: { distance: d } };
  }

  private placeVillage(cmd: Command): CommandResult {
    const { q, r, refId, name } = cmd.payload as { q: number; r: number; refId: string; name: string };
    const exist = this.store.get<Tile>(COLLECTION_TILE, hexKey(q, r));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, hexKey(q, r), { q, r, kind: 'village', refId, name });
    return { ok: true, payload: { q, r } };
  }

  private placePve(cmd: Command): CommandResult {
    const { q, r, refId, name, icon } = cmd.payload as { q: number; r: number; refId: string; name: string; icon?: string };
    const exist = this.store.get<Tile>(COLLECTION_TILE, hexKey(q, r));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, hexKey(q, r), { q, r, kind: 'pve', refId, name, icon });
    return { ok: true, payload: { q, r } };
  }
}
