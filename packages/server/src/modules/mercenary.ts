import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import { makeLogger } from '../infra/logger.js';

const log = makeLogger('mercenary');

/**
 * 领域模块 · Mercenary（雇佣兵营地）
 *
 * 职责：管理每个村庄的一处雇佣兵营地（mercenarycamp 建筑）。营地周期性刷新可雇佣名单（offers），
 * 玩家用金币购买名单上的雇佣兵 → 永久写入 military.troops（popCost=0/upkeep=0 → 自动零副作用、自动参战）。
 *
 * 设计要点：
 *  - 营地等级决定：刷新间隔(refreshSec)、每次刷新数量(mercCount)、可存储刷新次数(maxStored)。
 *  - 自动刷新：到 nextRefreshAt 时刷新名单并 +1 存储次数（存满为止）。
 *  - 玩家手动刷新：消耗一次 storedRefreshes，立即重roll名单（存储机制让低等级营地也能囤刷新机会）。
 *  - 雇佣：扣金币(economy.TrySpend) → military.AddMercenaries 入 troops → 消费该 offer（同一名额不可重复雇）。
 *  - 与 economy/population 无环：金币只进不出（人口交税在 population），此处只花金币。
 */

interface MercenaryCampState {
  villageId: string;
  /** 营地等级（缓存自 building.GetBuildingLevel；升级时刷新）。 */
  level: number;
  /** 当前可雇佣名单（兵种 code 列表）。 */
  offers: string[];
  /** 已存储的刷新次数（手动刷新消耗）。 */
  storedRefreshes: number;
  /** 下次自动刷新时刻（ms）。 */
  nextRefreshAt: number;
  taskId?: string;
}

const COLLECTION = 'merc';

export class MercenaryModule {
  static readonly NAME = 'mercenary';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'mercenary',
    publicActions: {
      GetMercCamp: { command: 'mercenary.GetCamp', ownVillage: true, needAuth: true, schema: {} },
      RefreshMercCamp: { command: 'mercenary.Refresh', ownVillage: true, needAuth: true, schema: {} },
      HireMerc: {
        command: 'mercenary.Hire', ownVillage: true, needAuth: true,
        schema: { code: { type: 'string', minLen: 1, maxLen: 32 } },
      },
    },
    eventPushMap: {
      'mercenary.CampUpdated': 'MercenaryCampUpdated',
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

  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('mercenary.GetCamp', (c) => this.getCamp(c));
    this.commands.register('mercenary.Refresh', (c) => this.refresh(c));
    this.commands.register('mercenary.Hire', (c) => this.hire(c));

    // 营地建成/升级 → 确保营地状态存在并刷新参数。
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId, kind } = evt.payload as { villageId: string; kind: string };
      if (kind === 'mercenarycamp') void this.ensureCamp(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId, kind } = evt.payload as { villageId: string; kind: string };
      if (kind === 'mercenarycamp') void this.ensureCamp(villageId);
    });
  }

  resume(): void {
    for (const s of this.store.all<MercenaryCampState>(COLLECTION)) {
      const delay = Math.max(0, s.nextRefreshAt - this.now());
      s.taskId = this.scheduler.schedule(
        delay,
        () => this.refreshTick(s.villageId),
        `mercenary:${s.villageId}`,
        `village:${s.villageId}`,
      );
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  // ── 内部辅助 ─────────────────────────────────────────────────────────────

  private load(villageId: string): MercenaryCampState | undefined {
    return this.store.get<MercenaryCampState>(COLLECTION, villageId);
  }

  /** 读营地建筑等级（经 building 命令，口径唯一）。 */
  private async getCampLevel(villageId: string): Promise<number> {
    const res = await this.commands.send({
      name: 'building.GetBuildingLevel', from: MercenaryModule.NAME,
      payload: { villageId, kind: 'mercenarycamp' },
    });
    return (res.payload as any)?.level ?? 0;
  }

  /** 从全部雇佣兵中随机取 count 个不重复 code。 */
  private rollOffers(level: number): string[] {
    const all = Object.values(this.config.units).filter((u) => u.isMercenary);
    const count = this.config.mercCamp[level]?.mercCount ?? 3;
    const pool = all.map((u) => u.key);
    const picked: string[] = [];
    const tmp = [...pool];
    while (picked.length < count && tmp.length) {
      const i = Math.floor(Math.random() * tmp.length);
      picked.push(tmp.splice(i, 1)[0]);
    }
    return picked;
  }

  /** 把 offer 的 code 列表映射为前端展示所需的详情对象。 */
  private offerDetails(codes: string[]): any[] {
    return codes.map((code) => {
      const u = this.config.units[code];
      if (!u) return null;
      return {
        code: u.key, name: u.name, icon: u.icon, form: u.form,
        meleeAtk: u.meleeAtk, rangedAtk: u.rangedAtk,
        meleeDef: u.meleeDef, rangedDef: u.rangedDef,
        speed: u.speed, carry: u.carry, goldCost: u.goldCost ?? 0,
      };
    }).filter(Boolean);
  }

  /** 取消并重新登记自动刷新定时（按 owner 去重，避免重复任务）。 */
  private scheduleRefresh(villageId: string, at: number): string {
    this.scheduler.cancelByOwner(`mercenary:${villageId}`);
    const delay = Math.max(0, at - this.now());
    return this.scheduler.schedule(
      delay,
      () => this.refreshTick(villageId),
      `mercenary:${villageId}`,
      `village:${villageId}`,
    );
  }

  // ── 营地生命周期 ─────────────────────────────────────────────────────────

  /** 确保营地存在（首建/升级都走这里）。首次建 → 生成初始名单+排程；升级 → 更新等级+重置排程。 */
  private async ensureCamp(villageId: string): Promise<void> {
    const level = await this.getCampLevel(villageId);
    if (level <= 0) return; // 营地尚未建成

    const existing = this.load(villageId);
    if (!existing) {
      const offers = this.rollOffers(level);
      const nextRefreshAt = this.now() + (this.config.mercCamp[level]?.refreshSec ?? 3600) * 1000;
      const s: MercenaryCampState = { villageId, level, offers, storedRefreshes: 0, nextRefreshAt };
      s.taskId = this.scheduleRefresh(villageId, nextRefreshAt);
      this.store.set(COLLECTION, villageId, s);
      await this.emitUpdated(villageId);
      return;
    }
    // 升级：更新等级、按新间隔重排自动刷新；保留当前名单与已存储次数（不强行重roll）。
    existing.level = level;
    existing.nextRefreshAt = this.now() + (this.config.mercCamp[level]?.refreshSec ?? 3600) * 1000;
    existing.taskId = this.scheduleRefresh(villageId, existing.nextRefreshAt);
    this.store.set(COLLECTION, villageId, existing);
    await this.emitUpdated(villageId);
  }

  /** 自动刷新 tick：重roll名单 + 存储次数 +1 + 重排程。 */
  private async refreshTick(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const mc = this.config.mercCamp[s.level] ?? { refreshSec: 3600, mercCount: 3, maxStoredRefreshes: 1 };
    s.offers = this.rollOffers(s.level);
    s.storedRefreshes = Math.min(mc.maxStoredRefreshes, s.storedRefreshes + 1);
    s.nextRefreshAt = this.now() + mc.refreshSec * 1000;
    s.taskId = this.scheduleRefresh(villageId, s.nextRefreshAt);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
    log('自动刷新', { village: villageId, level: s.level, stored: s.storedRefreshes });
  }

  private async emitUpdated(villageId: string): Promise<void> {
    await this.bus.emit({
      name: 'mercenary.CampUpdated', source: MercenaryModule.NAME, ts: this.now(),
      payload: { villageId },
    } as DomainEvent);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  private async getCamp(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    const level = await this.getCampLevel(villageId);
    if (!s || level <= 0) {
      return { ok: true, payload: { built: false, offers: [], storedRefreshes: 0, maxStored: 0, refreshSec: 0, nextRefreshAt: 0, gold: 0, level: 0 } };
    }
    const mc = this.config.mercCamp[level] ?? { refreshSec: 3600, mercCount: 3, maxStoredRefreshes: 1 };
    const goldRes = await this.commands.send({ name: 'economy.GetResources', from: MercenaryModule.NAME, payload: { villageId } });
    const gold = (goldRes.payload as any)?.resources?.gold ?? 0;
    return {
      ok: true,
      payload: {
        built: true,
        level,
        offers: this.offerDetails(s.offers),
        storedRefreshes: s.storedRefreshes,
        maxStored: mc.maxStoredRefreshes,
        refreshSec: mc.refreshSec,
        nextRefreshAt: s.nextRefreshAt,
        gold,
      },
    };
  }

  private async refresh(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_camp' };
    if (s.storedRefreshes <= 0) return { ok: false, payload: {}, reason: 'no_stored_refresh' };
    s.storedRefreshes -= 1;
    s.offers = this.rollOffers(s.level);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
    const base = await this.getCamp({ name: 'mercenary.GetCamp', from: 'mercenary', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  private async hire(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_camp' };
    const def = this.config.units[code];
    if (!def || !def.isMercenary) return { ok: false, payload: {}, reason: 'bad_unit' };
    if (!s.offers.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };

    // 扣金币
    const spend = await this.commands.send({
      name: 'economy.TrySpend', from: MercenaryModule.NAME,
      payload: { villageId, cost: { gold: def.goldCost ?? 0 } },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    // 永久写入 troops（popCost=0/upkeep=0 → 自动零副作用、自动参战）
    await this.commands.send({
      name: 'military.AddMercenaries', from: MercenaryModule.NAME,
      payload: { villageId, units: { [code]: 1 } },
    });

    // 消费该 offer（同一名额不可重复雇）
    s.offers = s.offers.filter((c) => c !== code);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);

    const base = await this.getCamp({ name: 'mercenary.GetCamp', from: 'mercenary', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }
}
