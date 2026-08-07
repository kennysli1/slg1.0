import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { Snapshot } from '../infra/combat-types.js';
import { wrapHex } from '../infra/hex.js';

/**
 * 领域模块 · PvE（NPC 目标 / 发育地板）
 * 对应设计文档 02_系统清单E组、S0(PvE=稳定发育地板)
 *
 * 职责：PvE 目标的 owner——每个目标有守军快照 + 战利品库存。
 * 提供给 Movement：取守军快照(打)、扣战利品(抢)、击败后重生。
 * 守军快照口径与 Military.GetCombatSnapshot 一致 → Combat 同一套结算（PvE/PvP同源）。
 *
 * 目标模板来自 GameConfig（config/pve_targets.csv + pve_defenders.csv）——改 CSV 即改目标。
 */

interface PveState {
  id: string;
  type: string;
  q: number; // 六边形轴坐标
  r: number;
  /** 当前守军（被打会减员；重生时恢复满） */
  defender: Snapshot;
  loot: Record<string, number>;
  /** 是否已被清空（待重生） */
  cleared: boolean;
  /** 累计被清空次数（战利品浮动的确定性 LCG 种子，保证可复现） */
  clearCount: number;
}

const COLLECTION = 'pve';

export class PveModule {
  static readonly NAME = 'pve';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'pve',
    publicActions: {
      GetTarget: {
        command: 'pve.GetTarget', needAuth: true,
        schema: { id: { type: 'string', minLen: 1, maxLen: 64 } },
      },
    },
  };

  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private scheduler: import('../infra/scheduler.js').Scheduler,
    private now: () => number,
    private config: import('../infra/config.js').GameConfig,
  ) {}

  init(): void {
    this.normalizeCoords();
    this.commands.register('pve.GetTarget', (c) => this.getTarget(c));
    this.commands.register('pve.GetDefenderSnapshot', (c) => this.getDefenderSnapshot(c));
    this.commands.register('pve.ApplyResult', (c) => this.applyResult(c));
  }

  /** 归一 PvE 坐标进环面（幂等，兼容旧档）。 */
  private normalizeCoords(): void {
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    for (const s of this.store.all<PveState>(COLLECTION)) {
      const w = wrapHex({ q: s.q, r: s.r }, W, H);
      if (w.q !== s.q || w.r !== s.r) {
        this.store.set(COLLECTION, s.id, { ...s, q: w.q, r: w.r });
      }
    }
  }

  /** 重启恢复：被清空的目标直接重生（服务器停机期间视为已过重生冷却）。 */
  resume(): void {
    for (const s of this.store.all<PveState>(COLLECTION)) {
      if (s.cleared) this.respawn(s.id);
    }
  }

  /** 创建一个 PvE 目标，并登记到地图。坐标为六边形轴坐标 (q,r)。 */
  create(id: string, type: string, q: number, r: number): void {
    const tpl = this.config.pveTemplates[type];
    const s: PveState = {
      id,
      type,
      q,
      r,
      defender: structuredClone(tpl.defender),
      loot: { ...tpl.loot },
      cleared: false,
      clearCount: 0,
    };
    this.store.set(COLLECTION, id, s);
    void this.commands.send({
      name: 'world.PlacePve',
      from: PveModule.NAME,
      payload: { q, r, refId: id, name: tpl.name, icon: tpl.icon },
    });
  }

  private load(id: string): PveState | undefined {
    return this.store.get<PveState>(COLLECTION, id);
  }

  private getTarget(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    return { ok: true, payload: { ...s } };
  }

  /** 给 Movement/Combat：当前守军快照。 */
  private getDefenderSnapshot(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    return { ok: true, payload: { snapshot: s.cleared ? {} : s.defender, loot: { ...s.loot } } };
  }

  /**
   * 战斗后应用结果：扣守军损失、若被清空则标记重生、返回实际可被搬走的战利品。
   * looterCarry = 进攻方幸存载货量；战利品按 carry 上限搬运。
   */
  private applyResult(cmd: Command): CommandResult {
    const { id, defenderLosses, attackerWins, looterCarry } = cmd.payload as {
      id: string;
      defenderLosses: Record<string, number>;
      attackerWins: boolean;
      looterCarry: number;
    };
    const s = this.load(id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };

    // 扣守军
    for (const [unit, dead] of Object.entries(defenderLosses)) {
      if (s.defender[unit]) s.defender[unit].count = Math.max(0, s.defender[unit].count - dead);
    }
    const remain = Object.values(s.defender).reduce((a, u) => a + u.count, 0);

    let looted: Record<string, number> = {};
    if (attackerWins && remain <= 0) {
      // 清空：累计次数（战利品浮动种子）→ 按载货上限搬运（含 ±variance 浮动）
      s.clearCount = (s.clearCount ?? 0) + 1;
      looted = this.takeLoot(s, looterCarry);
      s.cleared = true;
      // 登记重生
      const tpl = this.config.pveTemplates[s.type];
      this.scheduler.schedule(tpl.respawnSec * 1000, () => this.respawn(id), `pve:${id}`, `pve:${id}`);
    }
    this.store.set(COLLECTION, id, s);
    return { ok: true, payload: { looted, cleared: s.cleared } };
  }

  private takeLoot(s: PveState, carry: number): Record<string, number> {
    const types = Object.keys(s.loot);
    const total = types.reduce((a, t) => a + s.loot[t], 0);
    const looted: Record<string, number> = {};
    if (total <= 0) return looted;
    const ratio = Math.min(1, carry / total);
    // 每种资源乘一个确定性浮动系数（±variance，均值1），消除重复攻打的无聊确定性又不破坏可复现
    let i = 0;
    for (const t of types) {
      const factor = this.lootFactor(s, i++);
      const take = Math.floor(s.loot[t] * ratio * factor);
      looted[t] = take;
      s.loot[t] = Math.max(0, s.loot[t] - take);
    }
    return looted;
  }

  /**
   * 确定性伪随机浮动系数 ∈ [1-variance, 1+variance)。
   * 用 LCG（种子=clearCount×资源槽位偏移）而非 Math.random，保证存档/测试可复现（同 world/player 口径）。
   */
  private lootFactor(s: PveState, slot: number): number {
    const v = this.config.constants.pveLootVariance;
    if (v <= 0) return 1;
    const seed = (s.clearCount * 4 + slot + 1) >>> 0;
    const x = (seed * 1103515245 + 12345) & 0x7fffffff;
    const u = (x % 1000) / 1000; // [0,1)
    return 1 - v + u * 2 * v;
  }

  private respawn(id: string): void {
    const s = this.load(id);
    if (!s) return;
    const tpl = this.config.pveTemplates[s.type];
    s.defender = structuredClone(tpl.defender);
    s.loot = { ...tpl.loot };
    s.cleared = false;
    this.store.set(COLLECTION, id, s);
  }
}
