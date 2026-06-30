import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Snapshot } from './combat.js';

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
  x: number;
  y: number;
  /** 当前守军（被打会减员；重生时恢复满） */
  defender: Snapshot;
  loot: Record<string, number>;
  /** 是否已被清空（待重生） */
  cleared: boolean;
}

const COLLECTION = 'pve';

export class PveModule {
  static readonly NAME = 'pve';

  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private scheduler: import('../infra/scheduler.js').Scheduler,
    private now: () => number,
    private config: import('../infra/config.js').GameConfig,
  ) {}

  init(): void {
    this.commands.register('pve.GetTarget', (c) => this.getTarget(c));
    this.commands.register('pve.GetDefenderSnapshot', (c) => this.getDefenderSnapshot(c));
    this.commands.register('pve.ApplyResult', (c) => this.applyResult(c));
  }

  /** 重启恢复：被清空的目标直接重生（服务器停机期间视为已过重生冷却）。 */
  resume(): void {
    for (const s of this.store.all<PveState>(COLLECTION)) {
      if (s.cleared) this.respawn(s.id);
    }
  }

  /** 创建一个 PvE 目标，并登记到地图。 */
  create(id: string, type: string, x: number, y: number): void {
    const tpl = this.config.pveTemplates[type];
    const s: PveState = {
      id,
      type,
      x,
      y,
      defender: structuredClone(tpl.defender),
      loot: { ...tpl.loot },
      cleared: false,
    };
    this.store.set(COLLECTION, id, s);
    void this.commands.send({
      name: 'world.PlacePve',
      from: PveModule.NAME,
      payload: { x, y, refId: id, name: tpl.name, icon: tpl.icon },
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
      // 清空：按载货上限搬运战利品
      looted = this.takeLoot(s, looterCarry);
      s.cleared = true;
      // 登记重生
      const tpl = this.config.pveTemplates[s.type];
      this.scheduler.schedule(tpl.respawnSec * 1000, () => this.respawn(id));
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
    for (const t of types) {
      const take = Math.floor(s.loot[t] * ratio);
      looted[t] = take;
      s.loot[t] -= take;
    }
    return looted;
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
