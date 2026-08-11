/**
 * 科研模块 (ResearchModule)
 *
 * 状态归属：research 集合（每村科技进度 + RP 余额 + 学院生产状态）。
 * 学院建筑定时产出科研点(RP) → 科技树页消耗 RP 研发科技 → 科技生效。
 *
 * 命令：
 *   research.GetState       → ResearchState
 *   research.GetTechTree    → 全部科技 + 研发状态
 *   research.StartResearch  → 扣 RP + Scheduler 计时
 *   research.CancelResearch → 按剩余比例返还 RP（向下取整）
 *
 * 内部事件订阅：
 *   building.Built / Upgraded / Demolished → 更新 academy 参数 + 重调度 RP tick
 */
import type { Store } from '../infra/store.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { GameConfig } from '../infra/config.js';

const COLLECTION = 'research';

// ── 机制注册表 ──
export type MechanismContext = {
  villageId: string;
  tech: { code: string; effectKey: string; effectValue: number };
  commands: CommandBus;
  bus: EventBus;
};

export const MechanismRegistry: Record<string, (ctx: MechanismContext) => void> = {};

export function registerMechanism(code: string, handler: (ctx: MechanismContext) => void): void {
  MechanismRegistry[code] = handler;
}

// ── 状态类型 ──
export interface ResearchState {
  villageId: string;
  rp: number;
  researching?: { code: string; startedAt: number; durationMs: number; taskId: string } | null;
  completed: string[];
  academy: AcademyState;
}

export interface AcademyState {
  failStreak: number;
  lastCheckTime: number;
  highestLevel: number;
  academyCount: number;
}

// ── 模块 ──
export class ResearchModule {
  static NAME = 'research';
  static MANIFEST: ModuleManifest = {
    moduleName: 'research',
    publicActions: {
      GetState: { command: 'research.GetState', ownVillage: true, needAuth: true, schema: {} },
      GetTechTree: { command: 'research.GetTechTree', ownVillage: true, needAuth: true, schema: {} },
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
  private playerVillages: (playerId: string) => string[];
  private playerByVillage: (villageId: string) => string | null;

  constructor(
    store: Store, bus: EventBus, commands: CommandBus, scheduler: Scheduler,
    now: () => number, config: GameConfig,
    playerVillages: (playerId: string) => string[],
    playerByVillage: (villageId: string) => string | null,
  ) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.commands = commands;
    this.scheduler = scheduler;
    this.now = now;
    this.playerVillages = playerVillages;
    this.playerByVillage = playerByVillage;
  }

  async init(): Promise<void> {
    this.commands.register('research.GetState', (c: Command) => this.getState(c));
    this.commands.register('research.GetTechTree', (c: Command) => this.getTechTree(c));
    this.commands.register('research.StartResearch', (c: Command) => this.startResearch(c));
    this.commands.register('research.CancelResearch', (c: Command) => this.cancelResearch(c));

    // 学院建造/升级/拆除 → 刷新 academy 参数并重调度 RP
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const p = evt.payload as { villageId: string; kind: string };
      if (p.kind === 'academy') void this.onAcademyChanged(p.villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const p = evt.payload as { villageId: string; kind: string };
      if (p.kind === 'academy') void this.onAcademyChanged(p.villageId);
    });
    this.bus.on('building.Demolished', (evt: DomainEvent) => {
      const p = evt.payload as { villageId: string; kind: string };
      if (p.kind === 'academy') void this.onAcademyChanged(p.villageId);
    });

    // 注册首批默认机制
    registerMechanism('imperial_pop_boost', (ctx) => {
      void ctx.commands.send({ name: 'population.SetTechGrowthMult', from: ResearchModule.NAME, payload: { villageId: ctx.villageId, mult: ctx.tech.effectValue } });
    });
  }

  async resume(): Promise<void> {
    for (const s of this.store.all<ResearchState>(COLLECTION)) {
      // 恢复学院参数（已有存档可能缺 academyCount/highestLevel）
      void this.onAcademyChanged(s.villageId);
      // 恢复在途研发计时器
      if (s.researching) {
        const now = this.now();
        const elapsed = now - s.researching.startedAt;
        const remaining = s.researching.durationMs - elapsed;
        if (remaining <= 0) {
          void this.completeResearch(s.villageId, s.researching.code);
        } else {
          const taskId = this.scheduler.schedule(remaining, () => this.completeResearch(s.villageId, s.researching!.code), `research:${s.villageId}`);
          s.researching.taskId = taskId;
          this.store.set(COLLECTION, s.villageId, s);
        }
      }
      // 惰性回溯 RP 生产（onAcademyChanged 已包含 settleRp 调用）
    }
  }

  /** 清除单村数据（放弃分城 / 删号）。 */
  wipeSingleVillage(villageId: string): void {
    const s = this.load(villageId);
    if (s?.researching?.taskId) this.scheduler.cancelByOwner(`research:${villageId}`);
    this.scheduler.cancelByOwner(`research:${villageId}`);
    this.store.delete(COLLECTION, villageId);
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

  // ── 命令 ──
  private getState(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const params = s.academy.highestLevel > 0 ? this.config.academy[s.academy.highestLevel] : null;
    const intervalSec = s.academy.academyCount > 0 && params ? Math.max(1, Math.round(params.checkIntervalSec / s.academy.academyCount)) : 0;
    return { ok: true, payload: { villageId, rp: s.rp, researching: s.researching ?? null, completed: s.completed, academy: s.academy, intervalSec } };
  }

  private getTechTree(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const completed = new Set(s.completed);
    const techs = Object.values(this.config.research).map((t) => {
      let status: string;
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
    const durationMs = tech.durationSec * 1000;
    const taskId = this.scheduler.schedule(durationMs, () => this.completeResearch(villageId, techCode), `research:${villageId}`);
    s.researching = { code: techCode, startedAt: this.now(), durationMs, taskId };
    this.store.set(COLLECTION, villageId, s);
    this.store.flush();
    void this.pushRp(villageId, s.rp);
    return { ok: true, payload: { techCode, rp: s.rp } };
  }

  private async cancelResearch(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    if (!s.researching) return { ok: false, payload: {}, reason: 'not_researching' };
    const now = this.now();
    const elapsed = now - s.researching.startedAt;
    const remaining = Math.max(0, s.researching.durationMs - elapsed);
    const ratio = remaining / Math.max(1, s.researching.durationMs);
    const tech = this.config.research[s.researching.code];
    const refund = tech ? Math.floor(tech.rpCost * ratio) : 0;
    s.rp += refund;
    if (s.researching.taskId) this.scheduler.cancelByOwner(`research:${villageId}`);
    s.researching = null;
    this.store.set(COLLECTION, villageId, s);
    this.store.flush();
    void this.pushRp(villageId, s.rp);
    return { ok: true, payload: { refund, rp: s.rp } };
  }

  // ── 科技完成 ──
  private async completeResearch(villageId: string, techCode: string): Promise<void> {
    const s = this.ensureState(villageId);
    if (!s.completed.includes(techCode)) s.completed.push(techCode);
    s.researching = null;
    const tech = this.config.research[techCode];
    if (tech) {
      // 应用到本村（所有 scope 类型）
      this.applyTech(villageId, tech);
      // scope=player: 应用到该玩家所有村庄
      if (tech.scope === 'player') {
        const player = this.playerByVillage(villageId);
        if (player) {
          for (const vid of this.playerVillages(player)) {
            if (vid !== villageId) this.applyTech(vid, tech);
          }
        }
      }
    }
    this.store.set(COLLECTION, villageId, s);
    this.store.flush();
    await this.bus.emit({
      name: 'research.TechCompleted', source: ResearchModule.NAME, ts: this.now(),
      payload: { villageId, techCode },
    });
  }

  // ── 科技效果应用 ──
  private applyTech(villageId: string, tech: { code: string; effectType: string; effectKey: string; effectValue: number; scope: string }): void {
    const v = tech.effectValue;
    const key = tech.effectKey;
    switch (tech.effectType) {
      case 'resource_rate':
        void this.commands.send({ name: 'economy.SetRateModifier', from: ResearchModule.NAME, payload: { villageId, source: `tech:${tech.code}`, mult: { [key]: v } } });
        break;
      case 'storage_cap':
        // 倍率作用于仓储容量（乘在基础之上），通过 economy.SetCapacity 的倍率注入
        void this.commands.send({ name: 'economy.SetRateModifier', from: ResearchModule.NAME, payload: { villageId, source: `tech:${tech.code}`, mult: key.split('|').reduce((acc: Record<string,number>, r: string) => { acc[r.trim()] = v; return acc; }, {} as Record<string,number>) } });
        break;
      case 'combat_atk':
        void this.commands.send({ name: 'military.SetTechCombatMult', from: ResearchModule.NAME, payload: { villageId, atkMult: v, defMult: 0 } });
        break;
      case 'combat_def':
        void this.commands.send({ name: 'military.SetTechCombatMult', from: ResearchModule.NAME, payload: { villageId, atkMult: 0, defMult: v } });
        break;
      case 'pop_growth':
        void this.commands.send({ name: 'population.SetTechGrowthMult', from: ResearchModule.NAME, payload: { villageId, mult: v } });
        break;
      case 'mechanism':
        if (MechanismRegistry[key]) {
          MechanismRegistry[key]({ villageId, tech: { code: tech.code, effectKey: key, effectValue: v }, commands: this.commands, bus: this.bus });
        }
        break;
      // unit_unlock / building_unlock / train_speed / build_speed / march_speed / carry_cap
      // 这些由各模块在查询时读取 research.completed 列表来判定（门控模式），不需要 push 注入
      default: break;
    }
  }

  // ── RP 生产 ──
  private async onAcademyChanged(villageId: string): Promise<void> {
    // 从 building 模块查询本村所有 academy（layout.zones.inner/outer 各有 placed 数组）
    const layoutRes = await this.commands.send({ name: 'building.GetLayout', from: ResearchModule.NAME, payload: { villageId } });
    if (!layoutRes.ok) return;
    const layout = layoutRes.payload as any;
    const zones = layout.zones ?? {};
    const allPlaced = [...(zones.inner?.placed ?? []), ...(zones.outer?.placed ?? [])];
    let highestLevel = 0;
    let academyCount = 0;
    for (const p of allPlaced) {
      if (p.kind === 'academy' && p.level >= 1) {
        academyCount++;
        if (p.level > highestLevel) highestLevel = p.level;
      }
    }
    const s = this.ensureState(villageId);
    s.academy.highestLevel = highestLevel;
    s.academy.academyCount = academyCount;
    this.store.set(COLLECTION, villageId, s);
    // 重调度 RP tick
    this.settleRp(villageId);
  }

  /** RP 周期结算：惰性回溯未结算的 tick，然后调度下一次。 */
  private async settleRp(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    const { highestLevel, academyCount } = s.academy;
    if (academyCount < 1 || highestLevel < 1) {
      this.scheduler.cancelByOwner(`research:${villageId}`);
      return;
    }
    const params = this.config.academy[highestLevel];
    if (!params) return;

    const popMult = await this.getPopFactor(villageId);

    // 惰性回溯：计算从上一次判定到现在的 tick 数
    const now = this.now();
    const intervalMs = Math.max(1000, Math.round((params.checkIntervalSec * 1000) / academyCount));
    let lastCheck = s.academy.lastCheckTime || now;
    if (lastCheck > now) lastCheck = now;
    let failStreak = s.academy.failStreak;

    while (lastCheck + intervalMs <= now) {
      lastCheck += intervalMs;
      const prob = Math.min(params.maxProbability, (params.baseProbability + failStreak * params.probabilityGainPerFail) * popMult);
      if (Math.random() < prob) {
        s.rp += 1;
        failStreak = 0;
      } else {
        failStreak++;
      }
    }
    s.academy.failStreak = failStreak;
    s.academy.lastCheckTime = lastCheck;
    this.store.set(COLLECTION, villageId, s);

    // 调度下一次 tick
    const nextTickMs = Math.max(1000, lastCheck + intervalMs - now);
    this.scheduler.cancelByOwner(`research:${villageId}`);
    this.scheduler.schedule(nextTickMs, () => this.tickRp(villageId), `research:${villageId}`);
  }

  /** 单次 RP tick：roll 一次判定，失败则递增 failStreak，成功则 rp+1 并重置。调度下一次。 */
  private async tickRp(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    const { highestLevel, academyCount } = s.academy;
    if (academyCount < 1 || highestLevel < 1) return;
    const params = this.config.academy[highestLevel];
    if (!params) return;

    const popMult = await this.getPopFactor(villageId);
    const prob = Math.min(params.maxProbability, (params.baseProbability + s.academy.failStreak * params.probabilityGainPerFail) * popMult);
    if (Math.random() < prob) {
      s.rp += 1;
      s.academy.failStreak = 0;
      void this.pushRp(villageId, s.rp);
    } else {
      s.academy.failStreak++;
    }
    s.academy.lastCheckTime = this.now();
    this.store.set(COLLECTION, villageId, s);

    const intervalMs = Math.max(1000, Math.round((params.checkIntervalSec * 1000) / academyCount));
    this.scheduler.schedule(intervalMs, () => this.tickRp(villageId), `research:${villageId}`);
  }

  // ── 辅助 ──

  /** 查询人口模块获取人口因子：popMult = 1 + popFactor × (currentPop / hardCap)。异常时返回 1（不影响概率）。 */
  private async getPopFactor(villageId: string): Promise<number> {
    try {
      const res = await this.commands.send({ name: 'population.GetSnapshot', from: ResearchModule.NAME, payload: { villageId } });
      if (!res.ok) return 1;
      const p = res.payload as any;
      const ratio = p.hardCap > 0 ? (p.currentPop ?? 0) / Math.max(1, p.hardCap) : 0;
      const params = this.config.academy[this.ensureState(villageId).academy.highestLevel];
      const popFactor = params?.popFactor ?? 0;
      return 1 + popFactor * ratio;
    } catch { return 1; }
  }

  private prereqsMet(villageId: string, requires: string[]): boolean {
    if (!requires.length) return true;
    const s = this.ensureState(villageId);
    const completed = new Set(s.completed);
    for (const req of requires) {
      const orParts = req.split(' OR ');
      if (!orParts.some((p) => completed.has(p.trim()))) return false;
    }
    return true;
  }

  private async pushRp(villageId: string, rp: number): Promise<void> {
    await this.commands.send({ name: 'gateway.PushEvent', from: ResearchModule.NAME, payload: { villageId, event: 'research.RpChanged', data: { rp } } });
  }
}
