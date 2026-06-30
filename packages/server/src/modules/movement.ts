import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import { resolveCombat, type Snapshot } from './combat.js';
import type { GameConfig } from '../infra/config.js';

/**
 * 领域模块 · Movement（行军）
 * 对应设计文档 02_系统清单D组、08_系统逻辑详解§6、1_原版拆解/03
 *
 * 职责：在途部队的 owner。把村庄连成博弈网络的唯一通道。
 * 流程：发兵(从源村扣兵) → 算到达时间(距离/最慢速度) → 到达结算 → 生成返程 → 返程到达入村。
 * 战斗交给 Combat 纯函数（PvE/PvP 同源）；PvE 目标守军向 PvE 模块查，玩家村守军向 Military 查。
 *
 * 支持类型：raid(掠夺PvE)、attack(攻击玩家村)、return(返程)。
 */

interface Movement {
  id: string;
  type: 'raid' | 'attack' | 'return';
  fromVillage: string;
  fromXY: { x: number; y: number };
  toXY: { x: number; y: number };
  targetId?: string; // PvE 目标 id
  targetVillage?: string; // PvP 被攻击村 id
  troops: Record<string, number>;
  loot?: Record<string, number>;
  departAt: number;
  arriveAt: number;
}

const COLLECTION = 'movement';

export class MovementModule {
  static readonly NAME = 'movement';

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  init(): void {
    this.commands.register('movement.SendRaid', (c) => this.sendRaid(c));
    this.commands.register('movement.SendAttack', (c) => this.sendAttack(c));
    this.commands.register('movement.List', (c) => this.list(c));
  }

  /** 重启恢复：为所有在途行军重新登记到达任务（过期则立即结算）。 */
  resume(): void {
    for (const mv of this.store.all<Movement>(COLLECTION)) {
      const delay = Math.max(0, mv.arriveAt - this.now());
      if (mv.type === 'raid') this.scheduler.schedule(delay, () => this.arriveRaid(mv.id));
      else if (mv.type === 'attack') this.scheduler.schedule(delay, () => this.arriveAttack(mv.id));
      else if (mv.type === 'return') this.scheduler.schedule(delay, () => this.arriveReturn(mv.id));
    }
  }

  private load(id: string): Movement | undefined {
    return this.store.get<Movement>(COLLECTION, id);
  }

  private nextId(): string {
    const n = (this.store.get<number>('movement_seq', 'n') ?? 0) + 1;
    this.store.set('movement_seq', 'n', n);
    return `mv-${n}`;
  }

  /** 列出某村相关的在途行军。 */
  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const all = this.store.all<Movement>(COLLECTION).filter((m) => m.fromVillage === villageId);
    return {
      ok: true,
      payload: {
        movements: all.map((m) => ({
          id: m.id,
          type: m.type,
          targetId: m.targetId,
          toXY: m.toXY,
          troops: m.troops,
          loot: m.loot,
          arriveAt: m.arriveAt,
        })),
      },
    };
  }

  /**
   * 发起掠夺：向 PvE 目标派兵。
   * 1. 校验兵力(从 Military 扣出) 2. 算到达 3. 登记到达事件。
   */
  private async sendRaid(cmd: Command): Promise<CommandResult> {
    const { villageId, fromXY, targetId, troops } = cmd.payload as {
      villageId: string;
      fromXY: { x: number; y: number };
      targetId: string;
      troops: Record<string, number>;
    };

    // 目标存在？拿其坐标
    const target = await this.commands.send({ name: 'pve.GetTarget', from: MovementModule.NAME, payload: { id: targetId } });
    if (!target.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    const toXY = { x: (target.payload as any).x, y: (target.payload as any).y };

    // 从源村扣出兵力（负 delta）
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(troops)) delta[u] = -n;
    const adj = await this.commands.send({
      name: 'military.AdjustTroops',
      from: MovementModule.NAME,
      payload: { villageId, delta },
    });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };

    // 距离 / 最慢速度 → 到达时间
    const dist = Math.hypot(toXY.x - fromXY.x, toXY.y - fromXY.y);
    const slowest = Math.min(...Object.keys(troops).map((u) => this.config.units[u]?.speed ?? 6));
    const travelSec = Math.max(3, Math.round((dist / slowest) * 3600)); // 速度=格/小时
    const id = this.nextId();
    const arriveAt = this.now() + travelSec * 1000;

    const mv: Movement = {
      id, type: 'raid', fromVillage: villageId, fromXY, toXY, targetId, troops,
      departAt: this.now(), arriveAt,
    };
    this.store.set(COLLECTION, id, mv);
    this.scheduler.schedule(travelSec * 1000, () => this.arriveRaid(id));

    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id, type: 'raid', villageId, targetId, arriveAt } } as DomainEvent);
    return { ok: true, payload: { id, arriveAt, travelSec } };
  }

  /**
   * 发起 PvP 攻击：向另一玩家的村庄派兵。
   * 与 sendRaid 同结构，目标是玩家村（targetVillage）而非 PvE 目标。
   */
  private async sendAttack(cmd: Command): Promise<CommandResult> {
    const { villageId, fromXY, targetVillage, toXY, troops } = cmd.payload as {
      villageId: string;
      fromXY: { x: number; y: number };
      targetVillage: string;
      toXY: { x: number; y: number };
      troops: Record<string, number>;
    };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'cannot_attack_self' };

    // 目标村必须存在（有军队状态即视为存在）
    const exists = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId: targetVillage } });
    if (!exists.ok) return { ok: false, payload: {}, reason: 'target_not_found' };

    // 从源村扣出兵力
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(troops)) delta[u] = -n;
    const adj = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };

    const dist = Math.hypot(toXY.x - fromXY.x, toXY.y - fromXY.y);
    const slowest = Math.min(...Object.keys(troops).map((u) => this.config.units[u]?.speed ?? 6));
    const travelSec = Math.max(3, Math.round((dist / slowest) * 3600));
    const id = this.nextId();
    const arriveAt = this.now() + travelSec * 1000;
    const mv: Movement = {
      id, type: 'attack', fromVillage: villageId, fromXY, toXY, targetVillage, troops,
      departAt: this.now(), arriveAt,
    };
    this.store.set(COLLECTION, id, mv);
    this.scheduler.schedule(travelSec * 1000, () => this.arriveAttack(id));

    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id, type: 'attack', villageId, targetVillage, arriveAt } } as DomainEvent);
    // 通知被攻击方：来袭警报
    void this.bus.emit({ name: 'movement.IncomingAttack', source: MovementModule.NAME, ts: this.now(), payload: { villageId: targetVillage, fromVillage: villageId, arriveAt } } as DomainEvent);
    return { ok: true, payload: { id, arriveAt, travelSec } };
  }

  /** PvP 到达：取对方驻军+城墙→战斗→扣对方兵→掠夺对方资源→双方战报→带战利品返程。 */
  private async arriveAttack(id: string): Promise<void> {
    const mv = this.load(id);
    if (!mv || !mv.targetVillage) return;
    const target = mv.targetVillage;

    const attacker = this.buildSnapshot(mv.troops);

    // 防守方驻军快照（含铁匠加成口径）
    const defRes = await this.commands.send({ name: 'military.GetCombatSnapshot', from: MovementModule.NAME, payload: { villageId: target } });
    const defender: Snapshot = (defRes.payload as any)?.snapshot ?? {};

    // 城墙等级
    const tgtBuild = await this.commands.send({ name: 'building.GetState', from: MovementModule.NAME, payload: { villageId: target } });
    const wallLevel = (tgtBuild.payload as any)?.buildings?.wall ?? 0;

    const result = resolveCombat({ attacker, defender, wallLevel });

    // 扣防守方损失（把死亡数从对方驻军里减掉）
    if (Object.keys(result.defenderLosses).length) {
      const delta: Record<string, number> = {};
      for (const [u, dead] of Object.entries(result.defenderLosses)) if (dead > 0) delta[u] = -dead;
      if (Object.keys(delta).length) {
        await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId: target, delta } });
      }
    }

    // 掠夺：仅攻方胜才抢
    let looted: Record<string, number> = {};
    if (result.attackerWins && result.survivorCarry > 0) {
      const lootRes = await this.commands.send({ name: 'economy.GetLootable', from: MovementModule.NAME, payload: { villageId: target } });
      const lootable: Record<string, number> = (lootRes.payload as any)?.lootable ?? {};
      const total = Object.values(lootable).reduce((a, b) => a + b, 0);
      const want: Record<string, number> = {};
      if (total > 0) {
        const ratio = Math.min(1, result.survivorCarry / total);
        for (const [t, v] of Object.entries(lootable)) want[t] = Math.floor(v * ratio);
      }
      const taken = await this.commands.send({ name: 'economy.TakeLoot', from: MovementModule.NAME, payload: { villageId: target, amount: want } });
      looted = (taken.payload as any)?.taken ?? {};
    }

    // 幸存兵力
    const survivors: Record<string, number> = {};
    for (const [u, n] of Object.entries(mv.troops)) {
      const s = n - (result.attackerLosses[u] ?? 0);
      if (s > 0) survivors[u] = s;
    }

    // 给攻防双方各发战报
    const reportPayload = {
      attackerVillage: mv.fromVillage,
      defenderVillage: target,
      attackerWins: result.attackerWins,
      attackPower: result.attackPower,
      defensePower: result.defensePower,
      attackerLosses: result.attackerLosses,
      defenderLosses: result.defenderLosses,
      looted,
    };
    void this.bus.emit({ name: 'movement.AttackResolved', source: MovementModule.NAME, ts: this.now(), payload: { villageId: mv.fromVillage, side: 'attacker', ...reportPayload } } as DomainEvent);
    void this.bus.emit({ name: 'movement.AttackResolved', source: MovementModule.NAME, ts: this.now(), payload: { villageId: target, side: 'defender', ...reportPayload } } as DomainEvent);

    this.store.delete(COLLECTION, id);
    if (Object.keys(survivors).length > 0) this.scheduleReturn(mv, survivors, looted);
  }

  /** 掠夺到达：取守军→战斗→应用结果→带战利品返程。 */
  private async arriveRaid(id: string): Promise<void> {
    const mv = this.load(id);
    if (!mv || !mv.targetId) return;

    // 进攻方快照：用 Military 的口径，但兵在途，所以现造快照
    const attacker = this.buildSnapshot(mv.troops);

    const defRes = await this.commands.send({ name: 'pve.GetDefenderSnapshot', from: MovementModule.NAME, payload: { id: mv.targetId } });
    const defender: Snapshot = (defRes.payload as any)?.snapshot ?? {};

    const result = resolveCombat({ attacker, defender });

    // 应用到 PvE：扣守军、拿战利品
    const apply = await this.commands.send({
      name: 'pve.ApplyResult',
      from: MovementModule.NAME,
      payload: {
        id: mv.targetId,
        defenderLosses: result.defenderLosses,
        attackerWins: result.attackerWins,
        looterCarry: result.survivorCarry,
      },
    });
    const looted = (apply.payload as any)?.looted ?? {};

    // 计算幸存兵力
    const survivors: Record<string, number> = {};
    for (const [u, n] of Object.entries(mv.troops)) {
      const s = n - (result.attackerLosses[u] ?? 0);
      if (s > 0) survivors[u] = s;
    }

    // 生成战报
    void this.bus.emit({
      name: 'movement.RaidResolved',
      source: MovementModule.NAME,
      ts: this.now(),
      payload: {
        villageId: mv.fromVillage,
        targetId: mv.targetId,
        attackerWins: result.attackerWins,
        attackPower: result.attackPower,
        defensePower: result.defensePower,
        attackerLosses: result.attackerLosses,
        defenderLosses: result.defenderLosses,
        looted,
      },
    } as DomainEvent);

    // 删除去程，若有幸存者则生成返程
    this.store.delete(COLLECTION, id);
    if (Object.keys(survivors).length > 0) {
      this.scheduleReturn(mv, survivors, looted);
    }
  }

  private scheduleReturn(orig: Movement, troops: Record<string, number>, loot: Record<string, number>): void {
    const dist = Math.hypot(orig.toXY.x - orig.fromXY.x, orig.toXY.y - orig.fromXY.y);
    const slowest = Math.min(...Object.keys(troops).map((u) => this.config.units[u]?.speed ?? 6));
    const travelSec = Math.max(3, Math.round((dist / slowest) * 3600));
    const id = this.nextId();
    const arriveAt = this.now() + travelSec * 1000;
    const mv: Movement = {
      id, type: 'return', fromVillage: orig.fromVillage, fromXY: orig.toXY, toXY: orig.fromXY,
      troops, loot, departAt: this.now(), arriveAt,
    };
    this.store.set(COLLECTION, id, mv);
    this.scheduler.schedule(travelSec * 1000, () => this.arriveReturn(id));
  }

  /** 返程到达：兵力归队 + 战利品入库。 */
  private async arriveReturn(id: string): Promise<void> {
    const mv = this.load(id);
    if (!mv) return;
    // 兵归队
    await this.commands.send({
      name: 'military.AdjustTroops',
      from: MovementModule.NAME,
      payload: { villageId: mv.fromVillage, delta: mv.troops },
    });
    // 战利品入库
    if (mv.loot && Object.keys(mv.loot).length > 0) {
      await this.commands.send({
        name: 'economy.Grant',
        from: MovementModule.NAME,
        payload: { villageId: mv.fromVillage, gain: mv.loot },
      });
    }
    this.store.delete(COLLECTION, id);
    void this.bus.emit({ name: 'movement.Returned', source: MovementModule.NAME, ts: this.now(), payload: { villageId: mv.fromVillage, troops: mv.troops, loot: mv.loot } } as DomainEvent);
  }

  /** 用兵种定义为在途兵力构造战斗快照（无铁匠加成，骨架简化）。 */
  private buildSnapshot(troops: Record<string, number>): Snapshot {
    const snap: Snapshot = {};
    for (const [u, n] of Object.entries(troops)) {
      const def = this.config.units[u];
      if (!def || n <= 0) continue;
      snap[u] = { count: n, atk: def.atk, defInf: def.defInf, defCav: def.defCav, carry: def.carry, cat: def.cat };
    }
    return snap;
  }
}
