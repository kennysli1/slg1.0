import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Building（资源田 + 中心建筑科技树）
 * 对应设计文档 02_系统清单B组、1_原版拆解/02资源建筑
 *
 * 职责：每村资源田(18槽)与中心建筑(等级/建造队列)的 owner。
 * 数据来自 GameConfig（config/fields.csv、buildings.csv）——改 CSV 即改游戏。
 * 不直接改资源——经 Economy.TrySpend 扣费；升级完成广播 building.Upgraded。
 */

interface BuildingState {
  villageId: string;
  buildings: Record<string, number>;
  fields: { type: string; level: number }[];
  queue: { target: string; fieldIndex?: number; toLevel: number; startAt: number; finishAt: number; taskId: string } | null;
}

const COLLECTION = 'building';

export class BuildingModule {
  static readonly NAME = 'building';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'building',
    publicActions: {
      GetVillage: { command: 'building.GetState', ownVillage: true, needAuth: true },
      UpgradeBuilding: { command: 'building.UpgradeBuilding', ownVillage: true, needAuth: true },
      UpgradeField: { command: 'building.UpgradeField', ownVillage: true, needAuth: true },
    },
    eventPushMap: {
      'building.Upgraded': 'BuildingUpgraded',
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

  init(): void {
    this.commands.register('building.GetState', (c) => this.getState(c));
    this.commands.register('building.UpgradeBuilding', (c) => this.upgradeBuilding(c));
    this.commands.register('building.UpgradeField', (c) => this.upgradeField(c));
  }

  /** 重启恢复：为所有未完成的建造队列重新登记定时任务（过期则立即触发）。 */
  resume(): void {
    for (const s of this.store.all<BuildingState>(COLLECTION)) {
      if (!s.queue) continue;
      const delay = Math.max(0, s.queue.finishAt - this.now());
      const q = s.queue;
      if (q.fieldIndex !== undefined) {
        q.taskId = this.scheduler.schedule(delay, () => this.completeField(s.villageId, q.fieldIndex!, q.toLevel));
      } else {
        q.taskId = this.scheduler.schedule(delay, () => this.completeBuilding(s.villageId, q.target, q.toLevel));
      }
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  createVillage(villageId: string, tribe = 'romans'): void {
    // 开局布局来自 village_templates.csv（按部族）；缺该部族模板时回退罗马，再缺则用默认 18 田
    const tpl = this.config.villageTemplates[tribe] ?? this.config.villageTemplates['romans'];
    const layout = tpl?.fieldLayout?.length
      ? tpl.fieldLayout
      : [
          ...Array(4).fill('woodcutter'),
          ...Array(4).fill('claypit'),
          ...Array(4).fill('ironmine'),
          ...Array(6).fill('cropland'),
        ];
    const buildings = tpl?.startBuildings && Object.keys(tpl.startBuildings).length
      ? { ...tpl.startBuildings }
      : { main: 1, rallypoint: 1 };
    const s: BuildingState = {
      villageId,
      buildings,
      fields: layout.map((type) => ({ type, level: 0 })),
      queue: null,
    };
    this.store.set(COLLECTION, villageId, s);
    this.reportPopulation(s);
  }

  private load(villageId: string): BuildingState | undefined {
    return this.store.get<BuildingState>(COLLECTION, villageId);
  }

  private getState(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    return {
      ok: true,
      payload: {
        buildings: { ...s.buildings },
        fields: s.fields.map((f) => {
          const def = this.config.fields[f.type];
          const next = f.level + 1;
          return {
            ...f,
            name: def.name,
            icon: def.icon, // 图标基名（前端拼 /art/+基名+.png）
            maxLevel: def.maxLevel,
            nextCost: next <= def.maxLevel ? def.cost(next) : null,
            nextTimeSec: next <= def.maxLevel ? this.buildTime(s, def.timeSec(next)) : null,
          };
        }),
        queue: s.queue,
        defs: this.publicDefs(s),
      },
    };
  }

  private publicDefs(s: BuildingState) {
    const out: Record<string, any> = {};
    for (const [kind, def] of Object.entries(this.config.buildings)) {
      const lv = s.buildings[kind] ?? 0;
      out[kind] = {
        name: def.name,
        icon: def.icon,
        level: lv,
        maxLevel: def.maxLevel,
        nextCost: lv < def.maxLevel ? def.cost(lv + 1) : null,
        nextTimeSec: lv < def.maxLevel ? this.buildTime(s, def.timeSec(lv + 1)) : null,
        unlocked: this.meetsRequires(s, def.requires),
        requires: def.requires,
      };
    }
    return out;
  }

  private meetsRequires(s: BuildingState, requires: { kind: string; level: number }[]): boolean {
    return requires.every((r) => (s.buildings[r.kind] ?? 0) >= r.level);
  }

  private async upgradeBuilding(cmd: Command): Promise<CommandResult> {
    const { villageId, kind } = cmd.payload as { villageId: string; kind: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const def = this.config.buildings[kind];
    if (!def) return { ok: false, payload: {}, reason: `unknown_building:${kind}` };
    if (s.queue) return { ok: false, payload: {}, reason: 'queue_busy' };
    if (!this.meetsRequires(s, def.requires)) return { ok: false, payload: {}, reason: 'requires_not_met' };
    const toLevel = (s.buildings[kind] ?? 0) + 1;
    if (toLevel > def.maxLevel) return { ok: false, payload: {}, reason: 'max_level' };

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: BuildingModule.NAME,
      payload: { villageId, cost: def.cost(toLevel) },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    const durMs = this.buildTime(s, def.timeSec(toLevel)) * 1000;
    const startAt = this.now();
    const finishAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.completeBuilding(villageId, kind, toLevel));
    s.queue = { target: kind, toLevel, startAt, finishAt, taskId };
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { kind, toLevel, finishAt } };
  }

  private async upgradeField(cmd: Command): Promise<CommandResult> {
    const { villageId, fieldIndex } = cmd.payload as { villageId: string; fieldIndex: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const field = s.fields[fieldIndex];
    if (!field) return { ok: false, payload: {}, reason: 'bad_field' };
    if (s.queue) return { ok: false, payload: {}, reason: 'queue_busy' };
    const def = this.config.fields[field.type];
    const toLevel = field.level + 1;
    if (toLevel > def.maxLevel) return { ok: false, payload: {}, reason: 'max_level' };

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: BuildingModule.NAME,
      payload: { villageId, cost: def.cost(toLevel) },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    const durMs = this.buildTime(s, def.timeSec(toLevel)) * 1000;
    const startAt = this.now();
    const finishAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.completeField(villageId, fieldIndex, toLevel));
    s.queue = { target: field.type, fieldIndex, toLevel, startAt, finishAt, taskId };
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { fieldIndex, type: field.type, toLevel, finishAt } };
  }

  /** 主基地降低建造时间。 */
  private buildTime(s: BuildingState, baseSec: number): number {
    const mainLv = s.buildings.main ?? 1;
    const c = this.config.constants;
    const speedup = 1 - Math.min(c.mainBuildSpeedupCap, (mainLv - 1) * c.mainBuildSpeedupPerLevel);
    return Math.max(1, Math.round(baseSec * speedup));
  }

  private async completeBuilding(villageId: string, kind: string, toLevel: number): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    s.buildings[kind] = toLevel;
    s.queue = null;
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpgraded(villageId, kind, toLevel);
    this.reportPopulation(s);
  }

  private async completeField(villageId: string, fieldIndex: number, toLevel: number): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const field = s.fields[fieldIndex];
    field.level = toLevel;
    s.queue = null;
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpgraded(villageId, field.type, toLevel);
    this.reportPopulation(s);
    const def = this.config.fields[field.type];
    if (def) this.reportFieldRate(s, def.resource);
  }

  private async emitUpgraded(villageId: string, kind: string, level: number): Promise<void> {
    const evt: DomainEvent = {
      name: 'building.Upgraded',
      source: BuildingModule.NAME,
      ts: this.now(),
      payload: { villageId, kind, level },
    };
    await this.bus.emit(evt);
  }

  /** 计算全村人口(=crop消耗/小时)并上报 Economy。 */
  private reportPopulation(s: BuildingState): void {
    let pop = 0;
    for (const lv of Object.values(s.buildings)) pop += sumPop(lv);
    for (const f of s.fields) pop += sumPop(f.level);
    void this.commands.send({
      name: 'economy.SetUpkeep',
      from: BuildingModule.NAME,
      payload: { villageId: s.villageId, source: 'population', cropPerHour: pop },
    });
  }

  /** 计算全村某类资源的总产率(每小时)并上报 Economy。 */
  private reportFieldRate(s: BuildingState, resource: string): void {
    let ratePerHour = 0;
    for (const f of s.fields) {
      const def = this.config.fields[f.type];
      if (!def || def.resource !== resource) continue;
      ratePerHour += def.prodBase * Math.pow(def.prodGrowth, f.level);
    }
    void this.commands.send({
      name: 'economy.SetBaseRate',
      from: BuildingModule.NAME,
      payload: { villageId: s.villageId, resource, ratePerHour },
    });
  }
}

/** 累计人口：1+2+...+lv。 */
function sumPop(lv: number): number {
  return (lv * (lv + 1)) / 2;
}
