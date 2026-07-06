import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { Snapshot } from '../infra/combat-types.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import { type Hex, hexDistance, linePath } from '../infra/hex.js';
import { makeLogger } from '../infra/logger.js';

const log = makeLogger('movement');

/**
 * 领域模块 · Movement（行军）
 * 对应设计文档 02_系统清单D组、docs/2_2.0设计/08_战斗系统重做设计.md§二
 *
 * 职责：在途部队的 owner。把村庄连成博弈网络的唯一通道。
 *
 * 移动模型（六边形 + 真实路径，本次重做）：
 *  - 地图为六边形网格，坐标用轴坐标 (q,r)，几何走 infra/hex.ts。
 *  - 出征时用 linePath 算出**逐格路径**，按最慢兵种速度算每格耗时，
 *    逐格登记 Scheduler 任务推进（铁律#3：时间统一走 Scheduler）。
 *  - 每推进一格即检查**同格相遇**：两支敌对"出征军"(raid/attack)走到同一格 → 就地开战。
 *    返程军(return)视为脱战，免疫相遇。相遇后双方原地暂停直到结算完毕，胜方继续原定行军。
 *  - 部队"当前所在格" pos 对外可见 → 前端画行军路径与实时位置。
 *
 * 战斗接入（另一条线，战斗重做 agent 负责）：
 *  - 到达目标格时不自己结算，而发 `combat.Engage` 交给 Combat 开/并入战场；
 *    战斗结束 Combat 发 `combat.BattleEnded`，本模块据此安排幸存者带战利品返程。
 *  - 坐标对 Combat 为不透明透传（字段名 fromXY/toXY/targetXY 沿用，值为 {q,r}）。
 *
 * 支持类型：raid(打PvE)、attack(打玩家村)、return(返程)。
 */

interface Movement {
  id: string;
  type: 'raid' | 'attack' | 'return';
  fromVillage: string;
  /** 起点/终点，六边形轴坐标。字段名沿用 XY 仅为 combat 透传兼容，值是 {q,r}。 */
  fromXY: Hex;
  toXY: Hex;
  targetId?: string; // PvE 目标 id
  targetVillage?: string; // PvP 被攻击村 id
  troops: Record<string, number>;
  loot?: Record<string, number>;
  departAt: number;
  arriveAt: number;
  // ── 逐格推进状态 ──
  /** 逐格路径（含首尾），相邻两格恒为六边形邻居。 */
  path: Hex[];
  /** 当前已走到 path 的下标（0=起点）。 */
  stepIndex: number;
  /** 当前所在格（= path[stepIndex]），对外可见。 */
  pos: Hex;
  /** 每格耗时(ms)。 */
  perStepMs: number;
  /** 下一格到达时刻(ms, epoch)；前端据此在两格间插值动画。 */
  nextStepAt: number;
  /** marching=正常行军；paused=相遇/战斗中暂停。 */
  status: 'marching' | 'paused';
  /**
   * 步进令牌：每次登记"下一格"任务时自增并记录。step 回调携带登记时的令牌，
   * 只有令牌匹配才执行——作废因相遇/暂停而遗留的过期定时任务，防止重复推进。
   */
  stepToken: number;
}

const COLLECTION = 'movement';

export class MovementModule {
  static readonly NAME = 'movement';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'movement',
    publicActions: {
      SendRaid: { command: 'movement.SendRaid', ownVillage: true, needAuth: true },
      SendAttack: { command: 'movement.SendAttack', ownVillage: true, needAuth: true },
      ListMovements: { command: 'movement.List', ownVillage: true, needAuth: true },
    },
    eventPushMap: {
      'movement.Sent': 'MarchSent',
      'movement.IncomingAttack': 'IncomingAttack',
      'movement.Returned': 'MarchReturned',
      'movement.Intercepted': 'MarchIntercepted',
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
    this.commands.register('movement.SendRaid', (c) => this.sendRaid(c));
    this.commands.register('movement.SendAttack', (c) => this.sendAttack(c));
    this.commands.register('movement.List', (c) => this.list(c));
    // 战斗结束 → 安排幸存者带战利品返程（跨模块只走 Event）
    this.bus.on('combat.BattleEnded', (e: DomainEvent) => this.onBattleEnded(e));
  }

  /** 重启恢复：为所有在途、仍在行军的部队重新登记下一格推进（过期则立即触发）。 */
  resume(): void {
    for (const mv of this.store.all<Movement>(COLLECTION)) {
      if (mv.status !== 'marching') continue;
      // 续跑：作废旧令牌，登记新的下一格任务。
      mv.stepToken += 1;
      const token = mv.stepToken;
      this.store.set(COLLECTION, mv.id, mv);
      const delay = Math.max(0, mv.nextStepAt - this.now());
      this.scheduler.schedule(delay, () => this.step(mv.id, token));
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

  private validateTroops(troops: Record<string, number> | undefined): { ok: true; troops: Record<string, number> } | { ok: false; reason: string } {
    if (!troops || typeof troops !== 'object') return { ok: false, reason: 'bad_troops' };
    const cleaned: Record<string, number> = {};
    for (const [unit, raw] of Object.entries(troops)) {
      if (!this.config.units[unit]) return { ok: false, reason: `unknown_unit:${unit}` };
      if (!Number.isInteger(raw) || raw <= 0) return { ok: false, reason: `bad_troops:${unit}` };
      cleaned[unit] = raw;
    }
    if (Object.keys(cleaned).length === 0) return { ok: false, reason: 'empty_troops' };
    return { ok: true, troops: cleaned };
  }

  private async villageXY(villageId: string): Promise<Hex | null> {
    const res = await this.commands.send({
      name: 'world.GetTileByRef',
      from: MovementModule.NAME,
      payload: { refId: villageId, kind: 'village' },
    });
    const tile = (res.payload as any)?.tile;
    return res.ok && tile ? { q: tile.q, r: tile.r } : null;
  }

  /** 列出某村相关的在途行军（含路径/当前位置/状态，供前端可视化）。 */
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
          from: m.fromXY,
          to: m.toXY,
          path: m.path,
          pos: m.pos,
          stepIndex: m.stepIndex,
          status: m.status,
          perStepMs: m.perStepMs,
          nextStepAt: m.nextStepAt,
          troops: m.troops,
          loot: m.loot,
          arriveAt: m.arriveAt,
        })),
      },
    };
  }

  /** 全程行军秒数：六边形距离 / 最慢兵种速度（格/小时）。 */
  private travelSec(from: Hex, to: Hex, troops: Record<string, number>): number {
    const dist = hexDistance(from, to);
    const mult = this.config.constants.marchSpeedMultiplier ?? 1;
    const slowest = Math.min(...Object.keys(troops).map((u) => (this.config.units[u]?.speed ?? 6) * mult));
    return Math.max(3, Math.round((dist / slowest) * 3600)); // 速度=格/小时
  }

  /** 组装一条行军记录（算路径 + 每格耗时），落库并登记首个推进任务。 */
  private launch(
    base: Pick<Movement, 'id' | 'type' | 'fromVillage' | 'fromXY' | 'toXY' | 'troops' | 'departAt'> &
      Partial<Pick<Movement, 'targetId' | 'targetVillage' | 'loot'>>,
  ): Movement {
    const path = linePath(base.fromXY, base.toXY);
    const steps = Math.max(1, path.length - 1);
    const totalMs = this.travelSec(base.fromXY, base.toXY, base.troops) * 1000;
    const perStepMs = Math.max(1, Math.round(totalMs / steps));
    const full: Movement = {
      ...base,
      path,
      stepIndex: 0,
      pos: path[0],
      perStepMs,
      nextStepAt: this.now() + perStepMs,
      arriveAt: this.now() + perStepMs * steps,
      status: 'marching',
      stepToken: 1,
    };
    this.store.set(COLLECTION, full.id, full);
    this.scheduler.schedule(perStepMs, () => this.step(full.id, full.stepToken));
    return full;
  }

  /**
   * 发起掠夺：向 PvE 目标派兵。
   * 1. 校验兵力(从 Military 扣出) 2. 算路径 3. 逐格推进。
   */
  private async sendRaid(cmd: Command): Promise<CommandResult> {
    const { villageId, targetId, troops } = cmd.payload as {
      villageId: string;
      targetId: string;
      troops: Record<string, number>;
    };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };

    // 目标存在？拿其坐标
    const target = await this.commands.send({ name: 'pve.GetTarget', from: MovementModule.NAME, payload: { id: targetId } });
    if (!target.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    const tp = target.payload as any;
    const toXY: Hex = { q: tp.q, r: tp.r };

    // 从源村扣出兵力（负 delta）
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(valid.troops)) delta[u] = -n;
    const adj = await this.commands.send({
      name: 'military.AdjustTroops',
      from: MovementModule.NAME,
      payload: { villageId, delta },
    });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };

    const mv = this.launch({
      id: this.nextId(), type: 'raid', fromVillage: villageId, fromXY, toXY, targetId, troops: valid.troops,
      departAt: this.now(),
    });

    log('出征(raid)', { id: mv.id, from: villageId, targetId, troops: valid.troops, arriveAt: new Date(mv.arriveAt).toISOString() });
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'raid', villageId, targetId, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  /**
   * 发起 PvP 攻击：向另一玩家的村庄派兵。
   * 与 sendRaid 同结构，目标是玩家村（targetVillage）而非 PvE 目标。
   */
  private async sendAttack(cmd: Command): Promise<CommandResult> {
    const { villageId, targetVillage, troops } = cmd.payload as {
      villageId: string;
      targetVillage: string;
      troops: Record<string, number>;
    };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'cannot_attack_self' };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = await this.villageXY(targetVillage);
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };

    // 目标村必须存在（有军队状态即视为存在）
    const exists = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId: targetVillage } });
    if (!exists.ok) return { ok: false, payload: {}, reason: 'target_not_found' };

    // 从源村扣出兵力
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(valid.troops)) delta[u] = -n;
    const adj = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };

    const mv = this.launch({
      id: this.nextId(), type: 'attack', fromVillage: villageId, fromXY, toXY, targetVillage, troops: valid.troops,
      departAt: this.now(),
    });

    log('出征(attack)', { id: mv.id, from: villageId, targetVillage, troops: valid.troops, arriveAt: new Date(mv.arriveAt).toISOString() });
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'attack', villageId, targetVillage, arriveAt: mv.arriveAt } } as DomainEvent);
    // 通知被攻击方：来袭警报
    void this.bus.emit({ name: 'movement.IncomingAttack', source: MovementModule.NAME, ts: this.now(), payload: { villageId: targetVillage, fromVillage: villageId, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  /**
   * 逐格推进：前进一格 → 检查同格相遇 → 到终点则触发到达；否则登记下一格。
   * token 校验：只有携带当前 stepToken 的回调才执行，作废因暂停/相遇遗留的过期任务。
   */
  private async step(id: string, token: number): Promise<void> {
    const mv = this.load(id);
    if (!mv || mv.status !== 'marching' || mv.stepToken !== token) return;

    // 前进一格
    mv.stepIndex += 1;
    mv.pos = mv.path[mv.stepIndex];
    mv.nextStepAt = this.now() + mv.perStepMs;
    this.store.set(COLLECTION, id, mv);

    // 相遇检测（仅两支出征军相遇即战；返程军脱战免疫）
    if (mv.type !== 'return') {
      const opponent = await this.findEncounter(mv);
      if (opponent) {
        await this.resolveFieldEncounter(mv, opponent);
        return; // 相遇已接管本 movement 的后续（暂停/结算），不再自动前进
      }
    }

    // 到终点？
    if (mv.stepIndex >= mv.path.length - 1) {
      await this.arrive(mv);
      return;
    }

    // 登记下一格（沿用当前令牌）
    this.scheduler.schedule(mv.perStepMs, () => this.step(id, mv.stepToken));
  }

  /** 到达终点：按类型分派（出征→交给 Combat；返程→归队入库）。 */
  private async arrive(mv: Movement): Promise<void> {
    if (mv.type === 'return') { await this.arriveReturn(mv.id); return; }
    if (mv.type === 'raid' && mv.targetId) { await this.arriveEngage(mv, 'pve', mv.targetId); return; }
    if (mv.type === 'attack' && mv.targetVillage) { await this.arriveEngage(mv, 'village', mv.targetVillage); return; }
  }

  /** 出征到达：把兵力快照交给 Combat 开/并入战场，删除去程（兵力进入战斗，由 Combat 追踪）。 */
  private async arriveEngage(mv: Movement, targetKind: 'village' | 'pve', targetId: string): Promise<void> {
    await this.commands.send({
      name: 'combat.Engage', from: MovementModule.NAME,
      payload: {
        targetKind, targetId, targetXY: mv.toXY,
        movementId: mv.id, fromVillage: mv.fromVillage, fromXY: mv.fromXY,
        troops: mv.troops, attackerSnapshot: this.buildSnapshot(mv.troops),
      },
    });
    this.store.delete(COLLECTION, mv.id);
  }

  /**
   * 找出与 mv 同格相遇的**敌对出征军**：另一支 marching 的 raid/attack，pos 相同，且属于不同玩家。
   * 返回对手 movement 或 undefined。
   */
  private async findEncounter(mv: Movement): Promise<Movement | undefined> {
    const myOwner = await this.ownerOf(mv.fromVillage);
    for (const other of this.store.all<Movement>(COLLECTION)) {
      if (other.id === mv.id) continue;
      if (other.type === 'return' || other.status !== 'marching') continue;
      if (other.pos.q !== mv.pos.q || other.pos.r !== mv.pos.r) continue;
      const otherOwner = await this.ownerOf(other.fromVillage);
      if (otherOwner && myOwner && otherOwner === myOwner) continue; // 同一玩家不相互交战
      return other;
    }
    return undefined;
  }

  /** 村庄归属玩家 id（找不到返回村庄 id 本身，保证不同村=不同归属的保守判定）。 */
  private async ownerOf(villageId: string): Promise<string> {
    const res = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId } });
    return res.ok ? ((res.payload as any).player?.id ?? villageId) : villageId;
  }

  /**
   * 途中相遇结算：双方就地暂停 → 结算 → 胜方继续原定行军，败方全灭消失。
   *
   * TODO(combat-agent 阶段二)：改为发一条"野战 combat.Engage"交给有状态战斗逐 tick 结算，
   * 战斗中双方 status=paused，BattleEnded 后由 onBattleEnded 恢复行军。
   * 当前为让相遇功能在阶段一可玩/可测，用自包含的一次性强弱结算占位（不依赖尚未就绪的野战战斗）。
   */
  private async resolveFieldEncounter(a: Movement, b: Movement): Promise<void> {
    // 双方就地暂停（作废各自遗留的下一格任务），对外可见"停在相遇格"。
    a.status = 'paused'; a.stepToken += 1;
    b.status = 'paused'; b.stepToken += 1;
    this.store.set(COLLECTION, a.id, a);
    this.store.set(COLLECTION, b.id, b);

    const powA = this.fieldPower(a.troops);
    const powB = this.fieldPower(b.troops);
    const aWins = powA >= powB;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    const wPow = aWins ? powA : powB;
    const lPow = aWins ? powB : powA;

    // 胜方按对方相对强度损失一部分兵（非线性：一边倒损失小），败方全灭。
    const lossRatio = wPow > 0 ? Math.min(1, Math.pow(lPow / wPow, 1.5)) : 0;
    const survivors: Record<string, number> = {};
    for (const [u, n] of Object.entries(winner.troops)) {
      const s = n - Math.min(n, Math.round(n * lossRatio));
      if (s > 0) survivors[u] = s;
    }

    // 战报：双方各收一份
    const report = {
      at: winner.pos,
      winnerVillage: winner.fromVillage,
      loserVillage: loser.fromVillage,
      winnerSurvivors: survivors,
    };
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: winner.fromVillage, side: 'winner', ...report } } as DomainEvent);
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: loser.fromVillage, side: 'loser', ...report } } as DomainEvent);

    // 败方消失
    this.store.delete(COLLECTION, loser.id);

    // 胜方：无幸存者则一并消失；否则更新兵力、恢复行军（新令牌）。
    if (Object.keys(survivors).length === 0) {
      this.store.delete(COLLECTION, winner.id);
      return;
    }
    winner.troops = survivors;
    winner.status = 'marching';
    winner.stepToken += 1;
    winner.nextStepAt = this.now() + winner.perStepMs;
    this.store.set(COLLECTION, winner.id, winner);
    // 若胜方已在终点格相遇，直接到达；否则继续走
    if (winner.stepIndex >= winner.path.length - 1) await this.arrive(winner);
    else this.scheduler.schedule(winner.perStepMs, () => this.step(winner.id, winner.stepToken));
  }

  /** 野战粗略战力：Σ count×(meleeAtk+rangedAtk)。仅相遇占位用，阶段二由有状态战斗取代。 */
  private fieldPower(troops: Record<string, number>): number {
    let p = 0;
    for (const [u, n] of Object.entries(troops)) {
      const def = this.config.units[u];
      if (!def || n <= 0) continue;
      p += n * (def.meleeAtk + def.rangedAtk);
    }
    return p;
  }

  /** 战斗结束事件（attacker 侧）：为幸存者安排带战利品返程。 */
  private onBattleEnded(e: DomainEvent): void {
    const p = e.payload as {
      side: string; fromVillage: string; fromXY: Hex; toXY: Hex;
      survivors?: Record<string, number>; loot?: Record<string, number>;
    };
    if (p.side !== 'attacker') return;
    const survivors = p.survivors ?? {};
    if (Object.keys(survivors).length === 0) return; // 全灭无返程
    this.scheduleReturn(p.fromVillage, p.toXY, p.fromXY, survivors, p.loot ?? {});
  }

  private scheduleReturn(
    fromVillage: string,
    fromXY: Hex,
    toXY: Hex,
    troops: Record<string, number>,
    loot: Record<string, number>,
  ): void {
    this.launch({
      id: this.nextId(), type: 'return', fromVillage, fromXY, toXY,
      troops, loot, departAt: this.now(),
    });
  }

  /** 返程到达：兵力归队 + 战利品入库。 */
  private async arriveReturn(id: string): Promise<void> {
    const mv = this.load(id);
    if (!mv) return;
    log('返程到达', { id: mv.id, from: mv.fromVillage, troops: mv.troops, loot: mv.loot });
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

  /** 用兵种定义为在途兵力构造战斗快照（含特性解析；铁匠加成骨架暂不叠加，与旧口径一致）。 */
  private buildSnapshot(troops: Record<string, number>): Snapshot {
    const snap: Snapshot = {};
    for (const [u, n] of Object.entries(troops)) {
      const def = this.config.units[u];
      if (!def || n <= 0) continue;
      snap[u] = {
        count: n, form: def.form,
        meleeAtk: def.meleeAtk, rangedAtk: def.rangedAtk,
        meleeDef: def.meleeDef, rangedDef: def.rangedDef,
        carry: def.carry,
        traits: def.traits.flatMap((tc) => {
          const t = this.config.unitTraits[tc];
          return t.effects;
        }),
      };
    }
    return snap;
  }
}
