import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import { hexKey, wrapHex, hexDistanceWrapped } from '../infra/hex.js';
import { makeLogger } from '../infra/logger.js';
import { generateWorldPlan, kingdomLandmarkAnchors, terrainAt, type GeneratedWorldPlan, type Terrain } from '../infra/world-generation.js';

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

export type TileKind = 'empty' | 'village' | 'pve' | 'taskcamp';

export interface Tile {
  q: number;
  r: number;
  kind: TileKind;
  /** 村庄/目标的 id；empty 时为空 */
  refId?: string;
  /** 展示名 */
  name?: string;
  /** 图标基名（pve/村庄阶段图标，渲染时拼 /art/+基名+.png）。 */
  icon?: string;
  /** 主导地貌；只影响展示与内容分布，当前不参与行军/战斗。 */
  terrain?: Terrain;
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
  private plan?: GeneratedWorldPlan;
  static readonly NAME = 'world';



  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private _now: () => number,
    private config: GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用），同步刷新缓存的世界尺寸。 */
  setConfig(config: GameConfig): void {
    this.config = config;
    const meta = this.store.get<WorldState>(COLLECTION_META, 'meta');
    if (!meta) {
      this.worldW = config.constants.worldW ?? 41;
      this.worldH = config.constants.worldH ?? 41;
    }
    this.rebuildPlan();
  }

  init(): void {
    const meta = this.store.get<WorldState>(COLLECTION_META, 'meta');
    if (meta && typeof meta.w === 'number') {
      this.worldW = meta.w;
      this.worldH = meta.h;
    } else {
      this.worldW = this.config.constants.worldW ?? 41;
      this.worldH = this.config.constants.worldH ?? 41;
    }
    this.rebuildPlan();
    this.normalizeTiles();
    this._bus.on('player.VillageRenamed', (evt: DomainEvent) => this.onVillageRenamed(evt));
    this._bus.on('building.Built', (evt: DomainEvent) => this.onMainBaseChanged(evt));
    this._bus.on('building.Upgraded', (evt: DomainEvent) => this.onMainBaseChanged(evt));
    this.commands.register('world.GetTile', (c) => this.getTile(c));
    this.commands.register('world.GetMeta', (c) => this.getMeta(c));
    this.commands.register('world.AllocateSpawn', (c) => this.allocateSpawn(c));
    this.commands.register('world.GetTileByRef', (c) => this.getTileByRef(c));
    this.commands.register('world.MinVillageDistance', (c) => this.minVillageDistance(c));
    this.commands.register('world.ClearVillage', (c) => this.clearVillage(c));
    this.commands.register('world.GetArea', (c) => this.getArea(c));
    this.commands.register('world.Distance', (c) => this.distance(c));
    this.commands.register('world.PlaceVillage', (c) => this.placeVillage(c));
    this.commands.register('world.RestoreVillage', (c) => this.restoreVillage(c));
    this.commands.register('world.MoveVillage', (c) => this.moveVillage(c));
    this.commands.register('world.UpdateVillageStage', (c) => this.updateVillageStage(c));
    this.commands.register('world.PlacePve', (c) => this.placePve(c));
    this.commands.register('world.RemoveTile', (c) => this.removeTile(c));
    this.commands.register('world.FindFreeTile', (c) => this.findFreeTile(c));
  }

  private onMainBaseChanged(evt: DomainEvent): void {
    const p = evt.payload as { villageId?: string; kind?: string; level?: number; name?: string; icon?: string };
    if (p.kind !== 'main' || !p.villageId || !Number.isFinite(Number(p.level))) return;
    this.updateVillageStage({ payload: p } as Command);
  }

  /** Player owns the name; World mirrors it onto its map tile through an event. */
  private onVillageRenamed(evt: DomainEvent): void {
    const { villageId, name } = evt.payload as { villageId?: string; name?: string };
    if (!villageId || typeof name !== 'string') return;
    const tile = this.store.all<Tile>(COLLECTION_TILE).find((t) => t.kind === 'village' && t.refId === villageId);
    if (!tile) return;
    this.store.set<Tile>(COLLECTION_TILE, hexKey(tile.q, tile.r), { ...tile, name });
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
  setup(w = 41, h = 41): GeneratedWorldPlan {
    const existing = this.store.get<WorldState>(COLLECTION_META, 'meta');
    this.worldW = existing?.w ?? w;
    this.worldH = existing?.h ?? h;
    if (!existing) this.store.set<WorldState>(COLLECTION_META, 'meta', { w: this.worldW, h: this.worldH });
    this.rebuildPlan();
    return this.plan!;
  }

  private rebuildPlan(): void {
    const seed = String(this.config.constants.raw.world_seed ?? 'kow-world-v1');
    const ratio = Number(this.config.constants.raw.kingdom_fief_offset_ratio ?? 0.25);
    const landmarks = kingdomLandmarkAnchors(this.worldW, this.worldH, Number.isFinite(ratio) ? ratio : 0.25);
    // 王国锚点优先占位；人工 PvE 与自动 PvE 遇到它们时走确定性替代格。
    this.plan = generateWorldPlan(this.worldW, this.worldH, seed, [...landmarks, ...this.config.pveSpawns]);
  }

  private getMeta(_cmd: Command): CommandResult {
    return { ok: true, payload: { worldW: this.worldW, worldH: this.worldH } };
  }

  private getTile(cmd: Command): CommandResult {
    const { q, r } = cmd.payload as { q: number; r: number };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const t = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
    const tile = t ?? { q: w.q, r: w.r, kind: 'empty' as const };
    return { ok: true, payload: { tile: { ...tile, terrain: terrainAt(this.plan!, w.q, w.r) } } };
  }

  /** 原子选择并占用一个预生成首村槽位；容量耗尽时明确失败，绝不退回 (0,0)。 */
  private allocateSpawn(cmd: Command): CommandResult {
    const { refId, name } = cmd.payload as { refId?: string; name?: string };
    if (!refId || !name) return { ok: false, payload: {}, reason: 'bad_spawn_request' };
    const existing = this.store.all<Tile>(COLLECTION_TILE).find((t) => t.kind === 'village' && t.refId === refId);
    if (existing) return { ok: true, payload: { q: existing.q, r: existing.r } };
    for (const slot of this.plan!.spawnSlots) {
      const key = hexKey(slot.q, slot.r);
      const tile = this.store.get<Tile>(COLLECTION_TILE, key);
      if (tile && tile.kind !== 'empty') continue;
      this.store.set<Tile>(COLLECTION_TILE, key, { ...slot, kind: 'village', refId, name, icon: 'bld_main' });
      return { ok: true, payload: { ...slot } };
    }
    return { ok: false, payload: {}, reason: 'world_capacity_exhausted' };
  }

  /**
   * 返回所有"非空"地块的坐标 key（kind !== 'empty'），含玩家村 / pve / taskcamp / 临时 PvE / 资源点等。
   * allocateSpot 复用这一份占用真相，确保与 placeVillage 的占用口径（exist && exist.kind !== 'empty'）完全一致，
   * 否则会出现"随机抽到被 PvE 占用的格子 → placeVillage 拒绝 → 注册失败"的 bug。
   */
  public getOccupiedTileKeys(): Set<string> {
    const s = new Set<string>();
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (t.kind !== 'empty') s.add(hexKey(t.q, t.r));
    }
    return s;
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
   *  full=true 时忽略半径上限，返回整张地图的全部非空地块（用于全图渲染）。
   *  注：任务营地（kind==='taskcamp'）不进入全局视野——仅任务拥有者经 taskMarkers 可见，避免泄露给其他玩家。 */
  private async getArea(cmd: Command): Promise<CommandResult> {
    const { cq, cr, r, full, playerId, includeEmpty } = cmd.payload as { cq: number; cr: number; r: number; full?: boolean; playerId?: string; includeEmpty?: boolean };
    const center = { q: cq, r: cr };
    const radius = full
      ? Number.POSITIVE_INFINITY
      : Math.min(Math.max(0, r), this.config.constants.mapViewRadius + 6);
    const tiles: Tile[] = [];
    for (const t of this.store.all<Tile>(COLLECTION_TILE)) {
      if (t.kind === 'taskcamp') continue; // 任务营地仅任务拥有者可见，不泄露给其它玩家
      if (full || hexDistanceWrapped(center, t, this.worldW, this.worldH) <= radius) {
        tiles.push({ ...t, terrain: terrainAt(this.plan!, t.q, t.r) });
      }
    }
    if (!playerId && !includeEmpty) return { ok: true, payload: { tiles } }; // 仅内部测试/服务器查询保留原始地块
    const byKey = new Map(tiles.map((t) => [hexKey(t.q, t.r), t]));
    for (let rr = 0; rr < this.worldH; rr++) for (let q = 0; q < this.worldW; q++) {
      if (!full && hexDistanceWrapped(center, { q, r: rr }, this.worldW, this.worldH) > radius) continue;
      const key = hexKey(q, rr);
      if (!byKey.has(key)) byKey.set(key, { q, r: rr, kind: 'empty', terrain: terrainAt(this.plan!, q, rr) });
    }
    const completeTiles = [...byKey.values()];
    if (!playerId) return { ok: true, payload: { tiles: completeTiles } };
    const masked = await this.commands.send({ name: 'vision.FilterArea', from: WorldModule.NAME, payload: { playerId, tiles: completeTiles } });
    return masked.ok ? masked : { ok: false, payload: {}, reason: masked.reason };
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
    if (exist && exist.kind !== 'empty') {
      if (exist.kind === 'village' && exist.refId === refId) return { ok: true, payload: { q: w.q, r: w.r } };
      return { ok: false, payload: {}, reason: 'tile_occupied' };
    }
    if (this.plan!.spawnSlots.some((slot) => slot.q === w.q && slot.r === w.r)) {
      return { ok: false, payload: {}, reason: 'spawn_slot_reserved' };
    }
    this.store.set<Tile>(COLLECTION_TILE, hexKey(w.q, w.r), { q: w.q, r: w.r, kind: 'village', refId, name, icon: 'bld_main' });
    return { ok: true, payload: { q: w.q, r: w.r } };
  }

  /** 刷档保留坐标专用：恢复已存在账号的村庄，可占回其首村保留槽。 */
  private restoreVillage(cmd: Command): CommandResult {
    const { q, r, refId, name } = cmd.payload as { q: number; r: number; refId: string; name: string };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const key = hexKey(w.q, w.r);
    const exist = this.store.get<Tile>(COLLECTION_TILE, key);
    if (exist && exist.kind !== 'empty' && exist.refId !== refId) {
      return { ok: false, payload: {}, reason: 'tile_occupied' };
    }
    this.store.set<Tile>(COLLECTION_TILE, key, { ...w, kind: 'village', refId, name, icon: 'bld_main' });
    return { ok: true, payload: { q: w.q, r: w.r } };
  }

  /**
   * 把已有村庄的地图地块移动到新的坐标。
   *
   * 玩家模块拥有村庄坐标快照，World 模块拥有地图地块；GM 直接编辑玩家档案
   * 时必须通过这个命令同步两份状态，否则行军仍会从旧 world_tile 计算路径。
   * 该命令只移动地图地块，不修改 Player 档案本身。
   */
  private moveVillage(cmd: Command): CommandResult {
    const payload = cmd.payload as { refId?: string; q?: number; r?: number; name?: string };
    const refId = typeof payload.refId === 'string' ? payload.refId.trim() : '';
    const q = Number(payload.q), r = Number(payload.r);
    if (!refId || !Number.isFinite(q) || !Number.isFinite(r)) {
      return { ok: false, payload: {}, reason: 'bad_village_coordinates' };
    }
    const target = wrapHex({ q: Math.trunc(q), r: Math.trunc(r) }, this.worldW, this.worldH);
    const source = this.store.all<Tile>(COLLECTION_TILE).find((t) => t.kind === 'village' && t.refId === refId);
    const targetKey = hexKey(target.q, target.r);
    const targetTile = this.store.get<Tile>(COLLECTION_TILE, targetKey);
    const sourceKey = source ? hexKey(source.q, source.r) : null;
    if (targetTile && targetTile.kind !== 'empty' && targetKey !== sourceKey) {
      return { ok: false, payload: {}, reason: 'tile_occupied' };
    }

    const name = typeof payload.name === 'string' && payload.name.trim()
      ? payload.name
      : source?.name ?? targetTile?.name ?? refId;
    if (sourceKey && sourceKey !== targetKey) {
      this.store.set<Tile>(COLLECTION_TILE, sourceKey, { q: source!.q, r: source!.r, kind: 'empty' });
    }
    this.store.set<Tile>(COLLECTION_TILE, targetKey, {
      q: target.q, r: target.r, kind: 'village', refId, name, icon: source?.icon ?? targetTile?.icon ?? 'bld_main',
    });
    return {
      ok: true,
      payload: {
        q: target.q,
        r: target.r,
        previous: source ? { q: source.q, r: source.r } : undefined,
      },
    };
  }

  /** 镜像主基地阶段到地图瓦片；名称仍由 Player 的村庄名拥有，这里只更新阶段图标。 */
  private updateVillageStage(cmd: Command): CommandResult {
    const p = cmd.payload as { villageId?: string; icon?: string; level?: number };
    if (!p.villageId || typeof p.icon !== 'string' || !p.icon) return { ok: false, payload: {}, reason: 'bad_village_stage' };
    const tile = this.store.all<Tile>(COLLECTION_TILE).find((t) => t.kind === 'village' && t.refId === p.villageId);
    if (!tile) return { ok: false, payload: {}, reason: 'village_tile_not_found' };
    this.store.set<Tile>(COLLECTION_TILE, hexKey(tile.q, tile.r), { ...tile, icon: p.icon });
    return { ok: true, payload: { villageId: p.villageId, q: tile.q, r: tile.r, icon: p.icon, level: p.level } };
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
        // 村庄消失：通知行军模块——所有前往该村庄的进攻/运输/商队应原路返回（见 movement.onVillageRemoved）。
        void this._bus.emit({
          name: 'world.VillageRemoved', source: WorldModule.NAME, ts: this._now(),
          payload: { villageId: refId, q: t.q, r: t.r },
        } as DomainEvent);
        return { ok: true, payload: { q: t.q, r: t.r } };
      }
    }
    return { ok: false, payload: {}, reason: 'village_tile_not_found' };
  }

  private placePve(cmd: Command): CommandResult {
    const { q, r, refId, name, icon, task } = cmd.payload as { q: number; r: number; refId: string; name: string; icon?: string; task?: boolean };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const exist = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
    // 旧版本可能把任务营地写成全局 pve；恢复时允许同 refId 原子升级为私有 taskcamp。
    if (exist && exist.kind !== 'empty') {
      if (task && exist.refId === refId && (exist.kind === 'pve' || exist.kind === 'taskcamp')) {
        this.store.set<Tile>(COLLECTION_TILE, hexKey(w.q, w.r), { ...exist, kind: 'taskcamp', name, icon });
        return { ok: true, payload: { q: w.q, r: w.r } };
      }
      return { ok: false, payload: {}, reason: 'tile_occupied' };
    }
    // 任务营地写入独立 kind='taskcamp'：与全局视野隔离（getArea 过滤），但仍占用该格避免与其它营地/建筑冲突
    this.store.set<Tile>(COLLECTION_TILE, hexKey(w.q, w.r), { q: w.q, r: w.r, kind: task ? 'taskcamp' : 'pve', refId, name, icon });
    return { ok: true, payload: { q: w.q, r: w.r } };
  }

  /** 移除指定坐标上的 PvE/任务营地地块（任务营地清除用）：仅当该格确为对应 refId 的 pve/taskcamp 时才清空，避免误清村庄/其它目标。幂等。 */
  private removeTile(cmd: Command): CommandResult {
    const { q, r, refId } = cmd.payload as { q: number; r: number; refId: string };
    const w = wrapHex({ q, r }, this.worldW, this.worldH);
    const key = hexKey(w.q, w.r);
    const t = this.store.get<Tile>(COLLECTION_TILE, key);
    if (!t) return { ok: true, payload: { q: w.q, r: w.r } }; // 已不存在，幂等
    if ((t.kind !== 'pve' && t.kind !== 'taskcamp') || t.refId !== refId) return { ok: false, payload: {}, reason: 'tile_mismatch' };
    this.store.set<Tile>(COLLECTION_TILE, key, { q: w.q, r: w.r, kind: 'empty' });
    // PvE/任务营地地块消失：通知行军模块——所有前往该目标的出征/商队应立即原路返回
    // （见 movement.onTargetRemoved）。pve.Remove 已发过同一事件，这里再兜底一次，
    // 保证无论地块由哪条路径移除（pve.Remove / 直接 world.RemoveTile），商队都不会继续冲向已消失的目标。
    void this._bus.emit({
      name: 'pve.TargetRemoved', source: WorldModule.NAME, ts: this._now(),
      payload: { id: refId, q: w.q, r: w.r },
    } as DomainEvent);
    return { ok: true, payload: { q: w.q, r: w.r } };
  }

  /** 在以 (centerQ,centerR) 为中心、radius 半径内找一块空地块，返回其坐标（用于运行时生成任务营地）。环式由内向外扫描，命中即返回。 */
  private findFreeTile(cmd: Command): CommandResult {
    const { centerQ, centerR, radius } = cmd.payload as { centerQ: number; centerR: number; radius?: number };
    const R = Math.max(1, Math.min(Math.floor(radius ?? 6), 30));
    const cq = Number(centerQ) || 0, cr = Number(centerR) || 0;
    for (let d = 1; d <= R; d++) {
      for (let dq = -R; dq <= R; dq++) {
        for (let dr = -R; dr <= R; dr++) {
          const rawQ = cq + dq, rawR = cr + dr;
          if (hexDistanceWrapped({ q: cq, r: cr }, { q: rawQ, r: rawR }, this.worldW, this.worldH) !== d) continue;
          const w = wrapHex({ q: rawQ, r: rawR }, this.worldW, this.worldH);
          const t = this.store.get<Tile>(COLLECTION_TILE, hexKey(w.q, w.r));
          if (!t || t.kind === 'empty') return { ok: true, payload: { q: w.q, r: w.r } };
        }
      }
    }
    return { ok: false, payload: {}, reason: 'no_free_tile' };
  }
}
