/**
 * 科研模块 (ResearchModule)
 *
 * 状态归属：research 集合（每村科技进度 + RP 余额 + 学院生产状态）。
 * 学院建筑定时产出科研点(RP) → 科技树页消耗 RP 研发科技 → 科技生效（数值注入/机制钩子）。
 *
 * 命令：
 *   research.GetState       → 返回 ResearchState（学院详情页）
 *   research.GetTechTree    → 返回全部科技 + 每科技研发状态
 *   research.StartResearch  → 扣 RP，开始计时
 *   research.CancelResearch → 按剩余进度比例返还 RP（向下取整）
 *
 * 事件：
 *   research.TechCompleted  → 科技完成
 *   research.RpChanged      → RP 变化（推送 UI）
 */
import type { Store } from '../infra/store.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { GameConfig } from '../infra/config.js';

const COLLECTION = 'research';

export interface ResearchState {
  villageId: string;
  rp: number;
  researching?: {
    code: string;
    startedAt: number;
    durationMs: number;
  };
  completed: string[];
  academy: AcademyState;
}

export interface AcademyState {
  failStreak: number;
  lastCheckTime: number;
  highestLevel: number;
  academyCount: number;
}

export class ResearchModule {
  static NAME = 'research';
  static MANIFEST: ModuleManifest = {
    moduleName: 'research',
    publicActions: {
      GetState: { command: 'research.GetState', ownVillage: true, needAuth: true },
      GetTechTree: { command: 'research.GetTechTree', ownVillage: true, needAuth: true },
      StartResearch: { command: 'research.StartResearch', ownVillage: true, needAuth: true, schema: { techCode: { type: 'string', minLen: 1, maxLen: 32 } } },
      CancelResearch: { command: 'research.CancelResearch', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {
      TechCompleted: 'research.TechCompleted',
      RpChanged: 'research.RpChanged',
    },
  };

  private config: GameConfig;
  private store: Store;
  private commands: CommandBus;
  private bus: EventBus;
  private scheduler: Scheduler;
  private now: () => number;
  /** 玩家 → 村庄列表（注入，跨村科技用）。 */
  private playerVillages: (playerId: string) => string[];

  constructor(
    store: Store, bus: EventBus, commands: CommandBus, scheduler: Scheduler,
    now: () => number, config: GameConfig,
    playerVillages: (playerId: string) => string[],
  ) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.commands = commands;
    this.scheduler = scheduler;
    this.now = now;
    this.playerVillages = playerVillages;
  }

  async init(): Promise<void> {
    this.commands.register('research.GetState', (c: Command) => this.getState(c));
    this.commands.register('research.GetTechTree', (c: Command) => this.getTechTree(c));
    this.commands.register('research.StartResearch', (c: Command) => this.startResearch(c));
    this.commands.register('research.CancelResearch', (c: Command) => this.cancelResearch(c));
  }

  /** 启动时恢复所有村庄的 RP 生产调度 + 完成在途研发（惰性回溯）。 */
  async resume(): Promise<void> {
    for (const s of this.store.all<ResearchState>(COLLECTION)) {
      this.settleRp(s.villageId);
    }
  }

  // ── 状态读写 ──
  private ensureState(villageId: string): ResearchState {
    let s = this.store.get<ResearchState>(COLLECTION, villageId);
    if (!s) {
      s = { villageId, rp: 0, completed: [], academy: { failStreak: 0, lastCheckTime: this.now(), highestLevel: 0, academyCount: 0 } };
      this.store.set(COLLECTION, villageId, s);
    }
    return s;
  }

  private load(villageId: string): ResearchState | undefined {
    return this.store.get<ResearchState>(COLLECTION, villageId);
  }

  // ── 命令实现（空壳，Phase B/C 实现）──

  private getState(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    return { ok: true, payload: { villageId, rp: s.rp, researching: s.researching ?? null, completed: s.completed, academy: s.academy } };
  }

  private getTechTree(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const completed = new Set(s.completed);
    const techs = Object.values(this.config.research).map((t) => {
      let status: 'locked' | 'available' | 'researching' | 'completed';
      if (completed.has(t.code)) status = 'completed';
      else if (s.researching?.code === t.code) status = 'researching';
      else if (this.prereqsMet(villageId, t.requires)) status = 'available';
      else status = 'locked';
      return { code: t.code, name: t.name, branch: t.branch, tier: t.tier, requires: t.requires, desc: t.desc, effectType: t.effectType, effectKey: t.effectKey, effectValue: t.effectValue, scope: t.scope, durationSec: t.durationSec, rpCost: t.rpCost, icon: t.icon, status };
    });
    return { ok: true, payload: { techs, rp: s.rp, researching: s.researching?.code ?? null } };
  }

  private async startResearch(cmd: Command): Promise<CommandResult> {
    const { villageId, techCode } = cmd.payload as { villageId: string; techCode: string };
    const s = this.ensureState(villageId);
    const tech = this.config.research[techCode];
    if (!tech) return { ok: false, payload: {}, reason: 'unknown_tech' };
    if (s.researching) return { ok: false, payload: {}, reason: 'already_researching' };
    if (s.completed.includes(techCode)) return { ok: false, payload: {}, reason: 'already_completed' };
    if (!this.prereqsMet(villageId, tech.requires)) return { ok: false, payload: {}, reason: 'prerequisites_not_met' };
    if (s.rp < tech.rpCost) return { ok: false, payload: {}, reason: 'insufficient_rp' };
    s.rp -= tech.rpCost;
    s.researching = { code: techCode, startedAt: this.now(), durationMs: tech.durationSec * 1000 };
    this.store.set(COLLECTION, villageId, s);
    this.store.flush();
    // Phase C: schedule completion via Scheduler
    void this.commands.send({ name: 'gateway.PushEvent', from: ResearchModule.NAME, payload: { villageId, event: 'research.RpChanged', data: { rp: s.rp } } });
    return { ok: true, payload: { techCode, rp: s.rp } };
  }

  private async cancelResearch(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    if (!s.researching) return { ok: false, payload: {}, reason: 'not_researching' };
    const now = this.now();
    const elapsed = now - s.researching.startedAt;
    const remaining = s.researching.durationMs - Math.max(0, elapsed);
    const ratio = remaining / s.researching.durationMs;
    const tech = this.config.research[s.researching.code];
    const refund = tech ? Math.floor(tech.rpCost * ratio) : 0;
    s.rp += refund;
    s.researching = undefined;
    // Phase C: cancel scheduler
    this.store.set(COLLECTION, villageId, s);
    this.store.flush();
    void this.commands.send({ name: 'gateway.PushEvent', from: ResearchModule.NAME, payload: { villageId, event: 'research.RpChanged', data: { rp: s.rp } } });
    return { ok: true, payload: { refund, rp: s.rp } };
  }

  // ── 辅助 ──

  /** 判断前置科技是否全部满足（支持 OR 语法）。 */
  private prereqsMet(villageId: string, requires: string[]): boolean {
    if (!requires.length) return true;
    const s = this.ensureState(villageId);
    const completed = new Set(s.completed);
    for (const req of requires) {
      const orParts = req.split(' OR ');
      const anyMet = orParts.some((p) => completed.has(p.trim()));
      if (!anyMet) return false;
    }
    return true;
  }

  /** RP 周期结算（Phase B 实现）。 */
  private settleRp(villageId: string): void {
    // Phase B: 惰性回溯 + 调度下一次 tick
  }
}
