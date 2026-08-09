import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, Zone, BuildingDef } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Building（三区建筑系统：城镇中心 + 城内 + 城外）
 * 对应设计文档 11_建筑系统重做.md / 12_建筑系统重构架构规划.md
 *
 * 职责：每村"建筑布局"这一块状态的唯一 owner。
 *   · placed[]：所有已建实例（含 center/inner/outer；资源田也是 zone=outer 的实例）。
 *   · queue[] ：多条并行建造队列（容量派生自城镇中心等级）。
 *   · 城内/城外槽位数、队列容量 = 从城镇中心等级派生的快照（不落库，铁律#4）。
 *
 * 数据来自 GameConfig（config/buildings.csv、town_center_slots.csv）——改 CSV 即改游戏。
 * 不直接改资源——经 economy.TrySpend 扣费；派生结果经 economy.SetBaseRate/SetUpkeep/SetCapacity 上报。
 * 城墙防御经 building.GetDefenseSnapshot 对外给快照（不暴露内部状态，铁律#1/#4）。
 */

interface PlacedBuilding {
  slotId: string; // 村内唯一：'center' / 'inner-0' / 'outer-3'
  zone: Zone;
  kind: string; // 建筑 code（含资源田）
  level: number; // 0=建造中(占位)，>=1=已建成
  demolishing?: boolean; // 拆除进行中：期间不提供任何加成（level 已置 0），完成后整栋移除
}

interface QueueItem {
  slotId: string;
  kind: string;
  toLevel: number; // 新建=1，升级=当前+1
  isNew: boolean; // true=新建(完成发 Built)，false=升级(完成发 Upgraded)
  demolish?: boolean; // true=拆除（完成整栋移除，发 Demolished），完成后释放槽位
  startAt: number;
  finishAt: number;
  taskId: string;
}

interface BuildingState {
  villageId: string;
  tribe: string;
  placed: PlacedBuilding[];
  queue: QueueItem[];
}

const COLLECTION = 'building';
const CENTER_KIND = 'main';
const CENTER_SLOT = 'center';

export class BuildingModule {
  static readonly NAME = 'building';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'building',
    publicActions: {
      GetVillageLayout: { command: 'building.GetLayout', ownVillage: true, needAuth: true, schema: {} },
      GetBuildOptions: {
        command: 'building.GetBuildOptions', ownVillage: true, needAuth: true,
        schema: { zone: { type: 'enum', values: ['inner', 'outer'] } },
      },
      Build: {
        command: 'building.Build', ownVillage: true, needAuth: true,
        schema: {
          zone: { type: 'enum', values: ['inner', 'outer'] },
          kind: { type: 'string', minLen: 1, maxLen: 32 },
        },
      },
      UpgradeBuilding: {
        command: 'building.Upgrade', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32 } },
      },
      DemolishBuilding: {
        command: 'building.Demolish', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32 } },
      },
    },
    eventPushMap: {
      'building.Built': 'BuildingBuilt',
      'building.Upgraded': 'BuildingUpgraded',
      'building.Demolishing': 'BuildingDemolishing',
      'building.Demolished': 'BuildingDemolished',
    },
  };

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用）。模块运行时经 this.config 读取，替换引用即生效。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('building.GetLayout', (c) => this.getLayout(c));
    this.commands.register('building.GetBuildOptions', (c) => this.getBuildOptions(c));
    this.commands.register('building.Build', (c) => this.build(c));
    this.commands.register('building.Upgrade', (c) => this.upgrade(c));
    this.commands.register('building.Demolish', (c) => this.demolish(c));
    this.commands.register('building.GetDefenseSnapshot', (c) => this.getDefenseSnapshot(c));
    this.commands.register('building.GetBuildingLevel', (c) => this.getBuildingLevel(c));
    this.commands.register('building.GetLaborContext', (c) => this.getLaborContext(c));
    this.commands.register('building.GetPopCap', (c) => this.getPopCap(c));
  }

  /** 重启恢复：先把旧存档建筑 zone/slotId 对齐到当前 CSV（迁移），再为未完成队列登记定时任务。 */
  resume(): void {
    this.reconcileZones();
    for (const s of this.store.all<BuildingState>(COLLECTION)) {
      if (!s.queue?.length) continue;
      for (const q of s.queue) {
        const delay = Math.max(0, q.finishAt - this.now());
        q.taskId = this.scheduler.schedule(
          delay,
          () => this.complete(s.villageId, q.slotId),
          `building:${s.villageId}`,
          `village:${s.villageId}`,
        );
      }
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  /**
   * 迁移：把已存村庄的 placed 建筑 zone/slotId 对齐到当前 CSV 的 def.zone。
   * 解决「CSV 改了建筑区域（如军事建筑迁入城内），但旧存档建筑仍冻结在原 zone」导致
   * 兵营等卡在城外、且占用了错误区域槽位的问题。对所有村庄幂等：仅在实际不一致时写回。
   *
   * 实现：按当前 def.zone 把 placed 重新分组，逐区顺序重编号 slotId（center 固定 'center'），
   * 并把队列项里引用的旧 slotId 一并重映射，保证 complete() 仍能定位到正确的建筑。
   */
  private reconcileZones(): void {
    let anyChanged = false;
    for (const s of this.store.all<BuildingState>(COLLECTION)) {
      // 按当前 CSV 的 def.zone 分组（未知建筑兜底归 outer）
      const desired: Record<Zone, PlacedBuilding[]> = { center: [], inner: [], outer: [] };
      for (const p of s.placed) {
        const def = this.config.buildings[p.kind];
        const z: Zone = def?.zone ?? 'outer';
        desired[z].push(p);
      }
      // 是否真的需要修正：zone 不一致，或 slotId 前缀与 zone 不符
      const needFix = s.placed.some((p) => {
        const def = this.config.buildings[p.kind];
        const z: Zone = def?.zone ?? 'outer';
        const prefix = z === 'center' ? 'center' : `${z}-`;
        return p.zone !== z || !p.slotId.startsWith(prefix);
      });
      if (!needFix) continue;

      const reassigned: PlacedBuilding[] = [];
      const remap = new Map<string, string>();
      for (const z of ['center', 'inner', 'outer'] as Zone[]) {
        desired[z].forEach((p, i) => {
          const newSlot = z === 'center' ? CENTER_SLOT : `${z}-${i}`;
          remap.set(p.slotId, newSlot);
          p.zone = z;
          p.slotId = newSlot;
          reassigned.push(p);
        });
      }
      // 队列项引用的 slotId 一并重映射
      for (const q of s.queue) if (remap.has(q.slotId)) q.slotId = remap.get(q.slotId)!;
      s.placed = reassigned;
      this.store.set(COLLECTION, s.villageId, s);
      anyChanged = true;
    }
    if (anyChanged) console.log('[building] reconciled zone/slotId for existing villages');
  }

  createVillage(villageId: string, tribe = 'romans'): void {
    const tpl = this.config.villageTemplates[tribe] ?? this.config.villageTemplates['romans'];
    const startPlaced = tpl?.startPlaced && Object.keys(tpl.startPlaced).length
      ? tpl.startPlaced
      : { main: 1, rallypoint: 1, woodcutter: 1, claypit: 1, ironmine: 1, cropland: 1 };

    // 按 zone 分配 slotId：center 固定 'center'，其余按区顺序编号
    const placed: PlacedBuilding[] = [];
    const idx: Record<Zone, number> = { center: 0, inner: 0, outer: 0 };
    for (const [kind, level] of Object.entries(startPlaced)) {
      const def = this.config.buildings[kind];
      if (!def) continue;
      const slotId = def.zone === 'center' ? CENTER_SLOT : `${def.zone}-${idx[def.zone]++}`;
      placed.push({ slotId, zone: def.zone, kind, level });
    }
    const s: BuildingState = { villageId, tribe, placed, queue: [] };
    this.store.set(COLLECTION, villageId, s);

    // 开局即上报派生（容量/各资源田产率），让 economy 初值正确。
    // 注意：建筑不再上报 crop 维护（人口耗粮模型 v3：只有人口会耗粮，建筑只提供人口上限）。
    this.reportCapacity(s);
    for (const r of ['wood', 'clay', 'iron', 'crop']) this.reportFieldRate(s, r);
  }

  private load(villageId: string): BuildingState | undefined {
    return this.store.get<BuildingState>(COLLECTION, villageId);
  }

  private getBuildingLevel(cmd: Command): CommandResult {
    const { villageId, kind } = cmd.payload as { villageId: string; kind: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const level = Math.max(0, ...s.placed.filter((p) => p.kind === kind).map((p) => p.level));
    return { ok: true, payload: { kind, level } };
  }

  /**
   * 人口硬上限快照：供 population 模块（硬上限模型）取数，无回调，无环。
   * 返回：
   *  - hardCap：Σ 每栋已建建筑(level≥1) 的 levels[1..level].popCap 之和。
   *    逐等级 popCap 是「该级相对上一级的增量贡献」，求和即 1:1 等价于旧模型 popCapPerLevel × level
   *    （例：main L10 = 20×10 = 200）。故必须累加 1..当前等级，而非只取当前等级。
   *  - mainPopCap：仅城镇中心 1..当前等级 的 popCap 之和（开局人口；其他默认建筑不贡献）。
   *  - mainLevel：城镇中心等级（人口增长率基数）。
   */
  private getPopCap(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    let hardCap = 0;
    let mainPopCap = 0;
    for (const p of s.placed) {
      if (p.level < 1) continue;
      const def = this.config.buildings[p.kind];
      if (!def) continue;
      // 累加该建筑 1..当前等级 的逐等级人口上限（增量模型）
      for (let lv = 1; lv <= p.level; lv++) {
        const pop = def.levels[lv]?.popCap ?? 0;
        hardCap += pop;
        if (p.kind === 'main') mainPopCap += pop;
      }
    }
    return { ok: true, payload: { hardCap, mainPopCap, mainLevel: this.tcLevel(s) } };
  }

  // ---- 派生（全部在内部算，对外只给快照，铁律#4）----

  private center(s: BuildingState): PlacedBuilding | undefined {
    return s.placed.find((p) => p.slotId === CENTER_SLOT);
  }

  /** 城镇中心等级（缺失回退 1）。 */
  private tcLevel(s: BuildingState): number {
    return this.center(s)?.level ?? 1;
  }

  /** 城镇中心某等级的槽位配额（就近取：超表则用最高级）。 */
  private slotTier(tcLevel: number): { inner: number; outer: number; queue: number } {
    const tiers = this.config.townCenterSlots;
    if (tiers[tcLevel]) return tiers[tcLevel];
    // 缺级回退：找 <=tcLevel 的最大已定义级
    let best = tiers[1] ?? { inner: 0, outer: 0, queue: 1 };
    for (const [lvStr, t] of Object.entries(tiers)) {
      const lv = Number(lvStr);
      if (lv <= tcLevel) best = t;
    }
    return best;
  }

  private zoneSlots(s: BuildingState, zone: Zone): number {
    const tier = this.slotTier(this.tcLevel(s));
    return zone === 'inner' ? tier.inner : zone === 'outer' ? tier.outer : 1;
  }

  private queueCapacity(s: BuildingState): number {
    return this.slotTier(this.tcLevel(s)).queue;
  }

  private zoneUsed(s: BuildingState, zone: Zone): number {
    return s.placed.filter((p) => p.zone === zone).length;
  }

  private freeSlots(s: BuildingState, zone: Zone): number {
    return Math.max(0, this.zoneSlots(s, zone) - this.zoneUsed(s, zone));
  }

  /** 在某区分配一个未占用的 slotId（复用被拆除释放的编号）。 */
  private allocSlot(s: BuildingState, zone: Zone): string {
    const used = new Set(s.placed.filter((p) => p.zone === zone).map((p) => p.slotId));
    for (let i = 0; ; i++) {
      const id = `${zone}-${i}`;
      if (!used.has(id)) return id;
    }
  }

  private meetsRequires(s: BuildingState, requires: { kind: string; level: number }[]): boolean {
    return requires.every((r) => {
      const p = s.placed.find((x) => x.kind === r.kind && x.level >= r.level);
      return !!p;
    });
  }

  /** 前置未满足时的文案（如"需城镇中心 5 级"）。 */
  private lockReason(s: BuildingState, requires: { kind: string; level: number }[]): string | undefined {
    const missing = requires.filter((r) => !s.placed.some((x) => x.kind === r.kind && x.level >= r.level));
    if (!missing.length) return undefined;
    return '需' + missing.map((r) => `${this.config.buildings[r.kind]?.name ?? r.kind} ${r.level} 级`).join('、');
  }

  /** 城镇中心降低建造时间；再乘人口劳动力建造加速（time_mult_pop）。 */
  private async buildTime(s: BuildingState, baseSec: number): Promise<number> {
    const mainLv = this.tcLevel(s);
    const c = this.config.constants;
    const speedup = 1 - Math.min(c.mainBuildSpeedupCap, (mainLv - 1) * c.mainBuildSpeedupPerLevel);
    let timeSec = Math.max(1, Math.round(baseSec * speedup));
    // 人口建造加速：population.GetLaborMult('main') 返回 prosperityMult ∈ [popLaborFloor,1.0]，
    // 越高越快 → 建造时间除以 mult（未就绪时 mult=1.0，兜底，铁律#4）
    try {
      const res = await this.commands.send({
        name: 'population.GetLaborMult',
        from: BuildingModule.NAME,
        payload: { villageId: s.villageId, buildingKind: 'main' },
      });
      if (res.ok) {
        const mult = (res.payload as any).mult as number;
        if (mult > 0) timeSec = Math.max(1, Math.round(timeSec / mult));
      }
    } catch {
      // population 模块尚未就绪时静默忽略，用不带加速的时间
    }
    return timeSec;
  }

  /** 资源田某等级产量（level 0=未建成=0；>=1 取 building_levels.csv 该级 prod）。 */
  private fieldRate(def: BuildingDef, level: number): number {
    if (level < 1) return 0;
    return def.levels[level]?.prod ?? 0;
  }

  private hasPendingOp(s: BuildingState, slotId: string): boolean {
    return s.queue.some((q) => q.slotId === slotId);
  }

  private pendingOp(s: BuildingState, slotId: string): QueueItem | undefined {
    return s.queue.find((q) => q.slotId === slotId);
  }

  // ---- Commands ----

  private getLayout(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const centerP = this.center(s);
    const centerDef = this.config.buildings[CENTER_KIND];
    const tcLv = centerP?.level ?? 1;
    const centerNext = tcLv < (centerDef?.maxLevel ?? 20);
    const centerQueue = this.pendingOp(s, CENTER_SLOT);
    // buildTime is now async but getLayout is sync — use sync estimation (no pop mult) for layout display
    // The population mult is applied when the build command is actually submitted
    const buildTimeSyncEstimate = (baseSec: number) => {
      const mainLv = this.tcLevel(s);
      const c = this.config.constants;
      const speedup = 1 - Math.min(c.mainBuildSpeedupCap, (mainLv - 1) * c.mainBuildSpeedupPerLevel);
      return Math.max(1, Math.round(baseSec * speedup));
    };
    return {
      ok: true,
      payload: {
        townCenter: {
          slotId: CENTER_SLOT,
          kind: CENTER_KIND,
          name: centerDef?.name ?? '城镇中心',
          icon: centerDef?.icon ?? 'bld_main',
          level: tcLv,
          maxLevel: centerDef?.maxLevel ?? 20,
          nextCost: centerNext ? centerDef!.cost(tcLv + 1) : null,
          nextTimeSec: centerNext ? buildTimeSyncEstimate(centerDef!.timeSec(tcLv + 1)) : null,
          building: !!centerQueue,
          buildingStartAt: centerQueue?.startAt,
          buildingFinishAt: centerQueue?.finishAt,
        },
        zones: {
          inner: this.zoneView(s, 'inner'),
          outer: this.zoneView(s, 'outer'),
        },
        queue: {
          capacity: this.queueCapacity(s),
          items: s.queue
            .slice()
            .sort((a, b) => a.finishAt - b.finishAt)
            .map((q) => ({
              slotId: q.slotId,
              kind: q.kind,
              name: this.config.buildings[q.kind]?.name ?? q.kind,
              toLevel: q.toLevel,
              isNew: q.isNew,
              demolishing: !!q.demolish,
              startAt: q.startAt,
              finishAt: q.finishAt,
            })),
        },
      },
    };
  }

  private zoneView(s: BuildingState, zone: Zone) {
    const buildTimeSyncEstimate = (baseSec: number) => {
      const mainLv = this.tcLevel(s);
      const c = this.config.constants;
      const speedup = 1 - Math.min(c.mainBuildSpeedupCap, (mainLv - 1) * c.mainBuildSpeedupPerLevel);
      return Math.max(1, Math.round(baseSec * speedup));
    };
        const placed = s.placed
      .filter((p) => p.zone === zone)
      .map((p) => {
        const def = this.config.buildings[p.kind];
        const constructing = p.level < 1;
        const pending = this.pendingOp(s, p.slotId);
        const canUp = !constructing && !p.demolishing && p.level < (def?.maxLevel ?? 1);
        return {
          slotId: p.slotId,
          kind: p.kind,
          name: def?.name ?? p.kind,
          icon: def?.icon ?? 'bld_main',
          level: p.level,
          maxLevel: def?.maxLevel ?? 1,
          demolishing: !!p.demolishing,
          building: constructing || !!pending,
          buildingStartAt: pending?.startAt,
          buildingFinishAt: pending?.finishAt,
          nextCost: canUp ? def!.cost(p.level + 1) : null,
          nextTimeSec: canUp ? buildTimeSyncEstimate(def!.timeSec(p.level + 1)) : null,
          // 拆除期间不展示产量（已无加成）
          producing: def?.resource && !p.demolishing
            ? { resource: def.resource, ratePerHour: Math.round(this.fieldRate(def, p.level)) }
            : undefined,
        };
      });
    return { slots: this.zoneSlots(s, zone), freeSlots: this.freeSlots(s, zone), placed };
  }

  /** 侧边栏：某区当前可建建筑清单（含灰显理由）。 */
  private getBuildOptions(cmd: Command): CommandResult {
    const { villageId, zone } = cmd.payload as { villageId: string; zone: Zone };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    if (zone !== 'inner' && zone !== 'outer') return { ok: false, payload: {}, reason: 'bad_zone' };

    const buildTimeSyncEstimate = (baseSec: number) => {
      const mainLv = this.tcLevel(s);
      const c = this.config.constants;
      const speedup = 1 - Math.min(c.mainBuildSpeedupCap, (mainLv - 1) * c.mainBuildSpeedupPerLevel);
      return Math.max(1, Math.round(baseSec * speedup));
    };
    const options = Object.values(this.config.buildings)
      .filter((def) => def.zone === zone)
      .map((def) => ({
        kind: def.kind,
        name: def.name,
        icon: def.icon,
        cost: def.cost(1),
        timeSec: buildTimeSyncEstimate(def.timeSec(1)),
        unlocked: this.meetsRequires(s, def.requires),
        requires: def.requires,
        lockReason: this.lockReason(s, def.requires),
        producing: def.resource ? { resource: def.resource, ratePerHour: Math.round(this.fieldRate(def, 1)) } : undefined,
      }));
    return { ok: true, payload: { zone, freeSlots: this.freeSlots(s, zone), options } };
  }

  /** 点空槽建造新建筑。 */
  private async build(cmd: Command): Promise<CommandResult> {
    const { villageId, zone, kind } = cmd.payload as { villageId: string; zone: Zone; kind: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const def = this.config.buildings[kind];
    if (!def) return { ok: false, payload: {}, reason: `unknown_building:${kind}` };
    if (zone !== 'inner' && zone !== 'outer') return { ok: false, payload: {}, reason: 'bad_zone' };
    if (def.zone !== zone) return { ok: false, payload: {}, reason: 'zone_mismatch' };
    if (this.freeSlots(s, zone) <= 0) return { ok: false, payload: {}, reason: 'no_free_slot' };
    if (!this.meetsRequires(s, def.requires)) return { ok: false, payload: {}, reason: 'requires_not_met' };
    if (s.queue.length >= this.queueCapacity(s)) return { ok: false, payload: {}, reason: 'queue_full' };

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: BuildingModule.NAME,
      payload: { villageId, cost: def.cost(1) },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    const slotId = this.allocSlot(s, zone);
    s.placed.push({ slotId, zone, kind, level: 0 }); // level 0 = 建造中占位
    const durSec = await this.buildTime(s, def.timeSec(1));
    const durMs = durSec * 1000;
    const startAt = this.now();
    const finishAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.complete(villageId, slotId), `building:${villageId}`, `village:${villageId}`);
    s.queue.push({ slotId, kind, toLevel: 1, isNew: true, startAt, finishAt, taskId });
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { slotId, kind, finishAt } };
  }

  /** 点已建建筑升级（含资源田、城镇中心，用 slotId 定位）。 */
  private async upgrade(cmd: Command): Promise<CommandResult> {
    const { villageId, slotId } = cmd.payload as { villageId: string; slotId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const p = s.placed.find((x) => x.slotId === slotId);
    if (!p) return { ok: false, payload: {}, reason: 'slot_empty' };
    if (p.level < 1) return { ok: false, payload: {}, reason: 'still_constructing' };
    if (this.hasPendingOp(s, slotId)) return { ok: false, payload: {}, reason: 'slot_busy' };
    const def = this.config.buildings[p.kind];
    if (!def) return { ok: false, payload: {}, reason: `unknown_building:${p.kind}` };
    const toLevel = p.level + 1;
    if (toLevel > def.maxLevel) return { ok: false, payload: {}, reason: 'max_level' };
    if (s.queue.length >= this.queueCapacity(s)) return { ok: false, payload: {}, reason: 'queue_full' };

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: BuildingModule.NAME,
      payload: { villageId, cost: def.cost(toLevel) },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    const durSec = await this.buildTime(s, def.timeSec(toLevel));
    const durMs = durSec * 1000;
    const startAt = this.now();
    const finishAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.complete(villageId, slotId), `building:${villageId}`, `village:${villageId}`);
    s.queue.push({ slotId, kind: p.kind, toLevel, isNew: false, startAt, finishAt, taskId });
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { slotId, toLevel, finishAt } };
  }

  /**
   * 拆除已建建筑：耗时 = 该建筑建造到 1 级所需时间（与新建同源加速公式），不消耗也不返还资源；
   * 期间立即置 level=0 + demolishing，所有派生（人口上限/仓储/产率/繁荣/防御…因 level<1 自动跳过）即时失效；
   * 完成后整栋移除、释放槽位，不可取消；城镇中心不可拆。
   */
  private async demolish(cmd: Command): Promise<CommandResult> {
    const { villageId, slotId } = cmd.payload as { villageId: string; slotId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const p = s.placed.find((x) => x.slotId === slotId);
    if (!p) return { ok: false, payload: {}, reason: 'slot_empty' };
    if (p.kind === CENTER_KIND) return { ok: false, payload: {}, reason: 'cannot_demolish_center' };
    if (p.demolishing) return { ok: false, payload: {}, reason: 'already_demolishing' };
    if (p.level < 1) return { ok: false, payload: {}, reason: 'still_constructing' };
    if (this.hasPendingOp(s, slotId)) return { ok: false, payload: {}, reason: 'slot_busy' };
    if (s.queue.length >= this.queueCapacity(s)) return { ok: false, payload: {}, reason: 'queue_full' };
    const def = this.config.buildings[p.kind];
    if (!def) return { ok: false, payload: {}, reason: `unknown_building:${p.kind}` };

    const durSec = await this.buildTime(s, def.timeSec(1));
    const durMs = durSec * 1000;
    const startAt = this.now();
    const finishAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.complete(villageId, slotId), `building:${villageId}`, `village:${villageId}`);

    // 立即置 0 + 标记拆除中：派生因 level<1 自动跳过 → 期间零加成
    p.demolishing = true;
    p.level = 0;
    s.queue.push({ slotId, kind: p.kind, toLevel: 0, isNew: false, demolish: true, startAt, finishAt, taskId });
    this.store.set(COLLECTION, villageId, s);

    // 即时刷新下游派生（与完整落成/升级一致口径）：仓储容量 + 资源田产率
    this.reportCapacity(s);
    if (def.resource) this.reportFieldRate(s, def.resource);
    // 广播"开始拆除"：人口硬上限等缓存型派生据此从 building 重算（level 已为 0，加成即时消失）
    await this.emit('building.Demolishing', villageId, slotId, p.kind, 0);

    return { ok: true, payload: { slotId, kind: p.kind, finishAt } };
  }

  /** 队列项完成：落级、移出队列、广播、刷新派生。 */
  private async complete(villageId: string, slotId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const qi = s.queue.find((q) => q.slotId === slotId);
    if (!qi) return;
    const kind = qi.kind;
    const def = this.config.buildings[kind];
    const p = s.placed.find((x) => x.slotId === slotId);

    if (qi.demolish) {
      // 拆除完成：整栋移除，释放槽位（所有加成已因 level<1 在拆除期间失效）
      s.placed = s.placed.filter((x) => x.slotId !== slotId);
    } else if (p) {
      p.level = qi.toLevel;
    }
    s.queue = s.queue.filter((q) => q !== qi);
    this.store.set(COLLECTION, villageId, s);

    if (qi.demolish) {
      await this.emit('building.Demolished', villageId, slotId, kind, 0);
    } else {
      await this.emit(qi.isNew ? 'building.Built' : 'building.Upgraded', villageId, slotId, kind, qi.toLevel);
    }

    // 刷新派生：人口/容量始终；资源田刷该资源产率
    this.reportCapacity(s);
    if (def?.resource) this.reportFieldRate(s, def.resource);
  }

  private getDefenseSnapshot(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: true, payload: { wallLevel: 0 } };
    let wallLevel = 0;
    for (const p of s.placed) if (p.kind === 'wall' && p.level > wallLevel) wallLevel = p.level;
    return { ok: true, payload: { wallLevel } };
  }

  private async emit(name: string, villageId: string, slotId: string, kind: string, level: number): Promise<void> {
    const evt: DomainEvent = {
      name,
      source: BuildingModule.NAME,
      ts: this.now(),
      payload: { villageId, slotId, kind, level },
    };
    await this.bus.emit(evt);
  }

  // ---- 派生聚合上报（对内口径，铁律#4）----

  /** 全村某类资源的资源田总产率(每小时)上报 Economy。 */
  private reportFieldRate(s: BuildingState, resource: string): void {
    let ratePerHour = 0;
    for (const p of s.placed) {
      const def = this.config.buildings[p.kind];
      if (!def || def.resource !== resource) continue;
      ratePerHour += this.fieldRate(def, p.level);
    }
    void this.commands.send({
      name: 'economy.SetBaseRate',
      from: BuildingModule.NAME,
      payload: { villageId: s.villageId, resource, ratePerHour },
    });
  }

  /** 全村仓储容量上报 Economy（仓库→木/泥/铁，粮仓→粮；多座叠加等级）。 */
  private reportCapacity(s: BuildingState): void {
    const c = this.config.constants;
    let warehouseLv = 0;
    let granaryLv = 0;
    for (const p of s.placed) {
      if (p.kind === 'warehouse') warehouseLv += p.level;
      else if (p.kind === 'granary') granaryLv += p.level;
    }
    const cap = (totalLv: number) => c.storageBase * (1 + totalLv * c.storageGrowthPerLevel);
    const solid = cap(warehouseLv);
    void this.commands.send({
      name: 'economy.SetCapacity',
      from: BuildingModule.NAME,
      payload: {
        villageId: s.villageId,
        capacity: { wood: solid, clay: solid, iron: solid, crop: cap(granaryLv) },
      },
    });
  }

  /**
   * 热重载后，对本村重报全部资源田产率 + 仓储容量（让 CSV 改动的产率/容量即时生效，无需刷档）。
   * 遍历全部 4 种资源（即使为 0 也重报，确保旧的缓存值被覆盖）。
   */
  reReportProduction(villageId: string): void {
    const s = this.load(villageId);
    if (!s) return;
    for (const resource of ['wood', 'clay', 'iron', 'crop'] as const) this.reportFieldRate(s, resource);
    this.reportCapacity(s);
  }

  /**
   * 只读查询「劳动力上下文」（供 population 模块计算繁荣度，无回调，无环）。
   * 返回：prosperity — 全村繁荣度（Σ level×prosperityPerLevel；level<1 的占位不计）。
   * 注意：旧版的 `laborAmplified` 建筑列表已移除（v4 删除未投入使用的劳动力增幅机制）。
   */
  private getLaborContext(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    let prosperity = 0;
    for (const p of s.placed) {
      if (p.level < 1) continue;
      const def = this.config.buildings[p.kind];
      if (!def) continue;
      prosperity += p.level * def.prosperityPerLevel;
    }
    return { ok: true, payload: { prosperity } };
  }
}
