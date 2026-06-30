import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · World（地图 / 坐标 / 地块）
 * 对应设计文档 02_系统清单F组、1_原版拆解/04(Natars/绿洲)
 *
 * 职责：地图所有地块的 owner——记录每个 (x,y) 上是什么（玩家村/PvE目标/空地）。
 * 提供坐标、距离查询。PvE 目标的"内容"(守军/战利品)归 PvE 模块，World 只管"哪里有个目标"。
 *
 * 扩展点：地图尺寸、PvE 点密度可配置。
 */

export type TileKind = 'empty' | 'village' | 'pve';

export interface Tile {
  x: number;
  y: number;
  kind: TileKind;
  /** 村庄/目标的 id；empty 时为空 */
  refId?: string;
  /** 展示名 */
  name?: string;
  /** 图标基名（pve 目标用，渲染时拼 /art/+基名+.png）；村庄不带，前端用默认主基地图 */
  icon?: string;
}

interface WorldState {
  size: number; // 地图 [-size, size] 方形
}

const COLLECTION_META = 'world_meta';
const COLLECTION_TILE = 'world_tile';

function key(x: number, y: number) {
  return `${x},${y}`;
}

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
  ) {}

  init(): void {
    this.commands.register('world.GetTile', (c) => this.getTile(c));
    this.commands.register('world.GetArea', (c) => this.getArea(c));
    this.commands.register('world.Distance', (c) => this.distance(c));
    this.commands.register('world.PlaceVillage', (c) => this.placeVillage(c));
    this.commands.register('world.PlacePve', (c) => this.placePve(c));
  }

  /** 初始化地图（骨架：固定尺寸，确定性散布 PvE 点，避免 Math.random 破坏可复现）。 */
  setup(size = 20): void {
    this.store.set<WorldState>(COLLECTION_META, 'meta', { size });
  }

  private getTile(cmd: Command): CommandResult {
    const { x, y } = cmd.payload as { x: number; y: number };
    const t = this.store.get<Tile>(COLLECTION_TILE, key(x, y));
    return { ok: true, payload: { tile: t ?? { x, y, kind: 'empty' } } };
  }

  /** 返回以 (cx,cy) 为中心、半径 r 的所有非空地块。 */
  private getArea(cmd: Command): CommandResult {
    const { cx, cy, r } = cmd.payload as { cx: number; cy: number; r: number };
    const tiles: Tile[] = [];
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (Math.abs(t.x - cx) <= r && Math.abs(t.y - cy) <= r) tiles.push(t);
    }
    return { ok: true, payload: { tiles } };
  }

  /** 欧氏距离（格）。行军时间由 Movement 用它和速度算。 */
  private distance(cmd: Command): CommandResult {
    const { from, to } = cmd.payload as { from: { x: number; y: number }; to: { x: number; y: number } };
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    return { ok: true, payload: { distance: d } };
  }

  private placeVillage(cmd: Command): CommandResult {
    const { x, y, refId, name } = cmd.payload as { x: number; y: number; refId: string; name: string };
    const exist = this.store.get<Tile>(COLLECTION_TILE, key(x, y));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, key(x, y), { x, y, kind: 'village', refId, name });
    return { ok: true, payload: { x, y } };
  }

  private placePve(cmd: Command): CommandResult {
    const { x, y, refId, name, icon } = cmd.payload as { x: number; y: number; refId: string; name: string; icon?: string };
    const exist = this.store.get<Tile>(COLLECTION_TILE, key(x, y));
    if (exist && exist.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    this.store.set<Tile>(COLLECTION_TILE, key(x, y), { x, y, kind: 'pve', refId, name, icon });
    return { ok: true, payload: { x, y } };
  }
}
