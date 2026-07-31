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
 * 支持类型：raid(打PvE)、attack(打玩家村)、return(返程)、found(拓荒建村)、transport(村间运输)。
 */

interface Movement {
  id: string;
  type: 'raid' | 'attack' | 'return' | 'found' | 'transport';
  fromVillage: string;
  /** 起点/终点，六边形轴坐标。字段名沿用 XY 仅为 combat 透传兼容，值是 {q,r}。 */
  fromXY: Hex;
  toXY: Hex;
  targetId?: string; // PvE 目标 id
  targetVillage?: string; // PvP 被攻击村 / 运输目标村 id
  troops: Record<string, number>;
  loot?: Record<string, number>;
  /** 运输货物（transport） */
  cargo?: Record<string, number>;
  /** 拓荒发起玩家（found 到达建村用） */
  founderPlayerId?: string;
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
      SendRaid: {
        command: 'movement.SendRaid', ownVillage: true, needAuth: true,
        schema: {
          targetId: { type: 'string', minLen: 1, maxLen: 64 },
          troops:   { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
        },
      },
      SendAttack: {
        command: 'movement.SendAttack', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops:        { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
        },
      },
      FoundVillage: {
        command: 'movement.FoundVillage', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
        },
      },
      SendTransport: {
        command: 'movement.SendTransport', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops:        { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          cargo: { type: 'record_int', maxKeys: 4, minVal: 0, maxVal: 10_000_000 },
        },
      },
      ListMovements: { command: 'movement.List', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {
      'movement.Sent': 'MarchSent',
      'movement.IncomingAttack': 'IncomingAttack',
      'movement.Returned': 'MarchReturned',
      'movement.Intercepted': 'MarchIntercepted',
      'movement.VillageFounded': 'VillageFounded',
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
    this.commands.register('movement.FoundVillage', (c) => this.foundVillage(c));
    this.commands.register('movement.SendTransport', (c) => this.sendTransport(c));
    this.commands.register('movement.List', (c) => this.list(c));
    // 战斗结束 → 安排幸存者带战利品返程（跨模块只走 Event）
    this.bus.on('combat.BattleEnded', (e: DomainEvent) => this.onBattleEnded(e));
  }

  /** 重启恢复：为所有在途、仍在行军的部队重新登记下一格推进（过期则立即触发）。 */
  resume(): void {
    // 先汇总各村的在途部队 popCost 总量，恢复 population.SetEnRoutePop
    const enRouteByVillage = new Map<string, number>();
    for (const mv of this.store.all<Movement>(COLLECTION)) {
      const popSum = this.calcTroopsPopCost(mv.troops);
      const cur = enRouteByVillage.get(mv.fromVillage) ?? 0;
      enRouteByVillage.set(mv.fromVillage, cur + popSum);
    }
    for (const [villageId, popCostSum] of enRouteByVillage) {
      void this.commands.send({
        name: 'population.SetEnRoutePop',
        from: MovementModule.NAME,
        payload: { villageId, popCostSum },
      });
    }

    for (const mv of this.store.all<Movement>(COLLECTION)) {
      if (mv.status !== 'marching') continue;
      // 续跑：作废旧令牌，登记新的下一格任务。
      mv.stepToken += 1;
      const token = mv.stepToken;
      this.store.set(COLLECTION, mv.id, mv);
      const delay = Math.max(0, mv.nextStepAt - this.now());
      this.scheduler.schedule(delay, () => this.step(mv.id, token), `movement:${mv.id}`, `movement:${mv.id}`);
    }
  }

  /** 计算一支部队的人口权重总量（用于三池口粮·士兵池，v2）。 */
  private calcTroopsPopCost(troops: Record<string, number>): number {
    let sum = 0;
    for (const [unit, n] of Object.entries(troops)) {
      sum += (this.config.units[unit]?.popCost ?? 0) * n;
    }
    return sum;
  }

  /** 更新某村的在途总 popCost 并通知 population（汇总所有 fromVillage=villageId 的活跃行军）。 */
  private updateEnRoutePop(villageId: string): void {
    let total = 0;
    for (const mv of this.store.all<Movement>(COLLECTION)) {
      if (mv.fromVillage !== villageId) continue;
      total += this.calcTroopsPopCost(mv.troops);
    }
    void this.commands.send({
      name: 'population.SetEnRoutePop',
      from: MovementModule.NAME,
      payload: { villageId, popCostSum: total },
    });
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
          targetVillage: m.targetVillage,
          from: m.fromXY,
          to: m.toXY,
          path: m.path,
          pos: m.pos,
          stepIndex: m.stepIndex,
          status: m.status,
          perStepMs: m.perStepMs,
          nextStepAt: m.nextStepAt,
          troops: m.troops,
          cargo: m.cargo,
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
      Partial<Pick<Movement, 'targetId' | 'targetVillage' | 'loot' | 'cargo' | 'founderPlayerId'>>,
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
    this.scheduler.schedule(perStepMs, () => this.step(full.id, full.stepToken), `movement:${full.id}`, `movement:${full.id}`);
    // v2：通知 population 在途兵力增加（三池口粮·士兵池）
    this.updateEnRoutePop(full.fromVillage);
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
   * 村间运输：仅己方村；运力=Σ(carry×数量)；可见可截；到达部队留守、货物全额入库。
   */
  private async sendTransport(cmd: Command): Promise<CommandResult> {
    const { villageId, targetVillage, troops, cargo } = cmd.payload as {
      villageId: string;
      targetVillage: string;
      troops: Record<string, number>;
      cargo?: Record<string, number>;
    };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'same_village' };

    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };

    // 两端须属同一玩家
    const fromOwner = await this.ownerOf(villageId);
    const toOwner = await this.ownerOf(targetVillage);
    if (!fromOwner || !toOwner || fromOwner !== toOwner) {
      return { ok: false, payload: {}, reason: 'not_own_village' };
    }

    const cleanedCargo: Record<string, number> = {};
    let cargoTotal = 0;
    for (const t of ['wood', 'clay', 'iron', 'crop'] as const) {
      const n = Math.max(0, Math.floor(cargo?.[t] ?? 0));
      if (n > 0) { cleanedCargo[t] = n; cargoTotal += n; }
    }
    if (cargoTotal <= 0) return { ok: false, payload: {}, reason: 'empty_cargo' };

    let capacity = 0;
    for (const [u, n] of Object.entries(valid.troops)) {
      capacity += (this.config.units[u]?.carry ?? 0) * n;
    }
    if (cargoTotal > capacity) return { ok: false, payload: {}, reason: 'cargo_exceeds_carry' };

    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = await this.villageXY(targetVillage);
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };

    const spend = await this.commands.send({
      name: 'economy.TrySpend', from: MovementModule.NAME,
      payload: { villageId, cost: cleanedCargo },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'insufficient_resources' };

    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(valid.troops)) delta[u] = -n;
    const adj = await this.commands.send({
      name: 'military.AdjustTroops', from: MovementModule.NAME,
      payload: { villageId, delta },
    });
    if (!adj.ok) {
      await this.commands.send({
        name: 'economy.Grant', from: MovementModule.NAME,
        payload: { villageId, gain: cleanedCargo },
      });
      return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };
    }

    const mv = this.launch({
      id: this.nextId(), type: 'transport', fromVillage: villageId, fromXY, toXY,
      targetVillage, troops: valid.troops, cargo: cleanedCargo, departAt: this.now(),
    });

    log('出征(transport)', {
      id: mv.id, from: villageId, to: targetVillage, troops: valid.troops, cargo: cleanedCargo,
      arriveAt: new Date(mv.arriveAt).toISOString(),
    });
    void this.bus.emit({
      name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(),
      payload: {
        id: mv.id, type: 'transport', villageId, targetVillage,
        arriveAt: mv.arriveAt, cargo: cleanedCargo,
      },
    } as DomainEvent);
    return {
      ok: true,
      payload: {
        id: mv.id,
        arriveAt: mv.arriveAt,
        travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000),
        carryCapacity: capacity,
      },
    };
  }

  /** 运输到达：货物入库（可超额）+ 部队并入目标村。 */
  private async arriveTransport(mv: Movement): Promise<void> {
    const target = mv.targetVillage;
    if (!target) {
      this.store.delete(COLLECTION, mv.id);
      this.updateEnRoutePop(mv.fromVillage);
      return;
    }
    if (mv.cargo && Object.keys(mv.cargo).length > 0) {
      await this.commands.send({
        name: 'economy.Grant', from: MovementModule.NAME,
        payload: { villageId: target, gain: mv.cargo },
      });
    }
    await this.commands.send({
      name: 'military.AdjustTroops', from: MovementModule.NAME,
      payload: { villageId: target, delta: mv.troops },
    });
    log('运输到达', { id: mv.id, to: target, troops: mv.troops, cargo: mv.cargo });
    this.store.delete(COLLECTION, mv.id);
    this.updateEnRoutePop(mv.fromVillage);
    void this.bus.emit({
      name: 'movement.Returned', source: MovementModule.NAME, ts: this.now(),
      payload: {
        villageId: target,
        fromVillage: mv.fromVillage,
        troops: mv.troops,
        loot: mv.cargo,
        type: 'transport',
      },
    } as DomainEvent);
  }

  /**
   * 拓荒建村：门控 → 扣开城包 → 扣 3 拓荒者 → found 行军。
   * 到达时若地块仍合法则建村；否则拓荒者返程（开城包不退）。
   */
  private async foundVillage(cmd: Command): Promise<CommandResult> {
    const { villageId, q, r } = cmd.payload as { villageId: string; q: number; r: number };
    const c = this.config.constants;
    const toXY: Hex = { q, r };

    // 地图范围
    if (hexDistance({ q: 0, r: 0 }, toXY) > c.mapSize) {
      return { ok: false, payload: {}, reason: 'out_of_map' };
    }

    // 归属玩家
    const ownerRes = await this.commands.send({
      name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId },
    });
    if (!ownerRes.ok) return { ok: false, payload: {}, reason: 'owner_not_found' };
    const player = (ownerRes.payload as any).player;
    const playerId = player.id as string;
    const tribe = player.tribe as string;
    const villageCount = (player.villages as { id: string }[] | undefined)?.length ?? 1;

    // 同时在途拓荒上限（按玩家）
    let inflight = 0;
    for (const m of this.store.all<Movement>(COLLECTION)) {
      if (m.type !== 'found') continue;
      if (m.founderPlayerId === playerId) inflight += 1;
    }
    if (inflight >= c.foundMaxInflight) {
      return { ok: false, payload: {}, reason: 'found_inflight_limit' };
    }

    // 门控：主基地等级
    const lvRes = await this.commands.send({
      name: 'building.GetBuildingLevel', from: MovementModule.NAME,
      payload: { villageId, kind: 'main' },
    });
    const mainLv = lvRes.ok ? ((lvRes.payload as any).level as number) : 0;
    if (mainLv < c.foundMinMainLevel) {
      return { ok: false, payload: {}, reason: 'main_level_too_low' };
    }

    // 门控：人口软上限
    const popRes = await this.commands.send({
      name: 'population.GetSnapshot', from: MovementModule.NAME,
      payload: { villageId },
    });
    if (!popRes.ok) return { ok: false, payload: {}, reason: 'population_unavailable' };
    const softLimit = (popRes.payload as any).softLimit as number;
    if (softLimit < c.foundMinSoftLimit) {
      return { ok: false, payload: {}, reason: 'soft_limit_too_low' };
    }

    // 落点预检
    const site = await this.validateFoundSite(toXY, c.foundMinTileDistance);
    if (!site.ok) return { ok: false, payload: {}, reason: site.reason };

    const settler = this.settlerUnitCode(tribe);
    if (!settler) return { ok: false, payload: {}, reason: 'no_settler_unit' };
    const need = c.foundSettlerCount;
    const troops = { [settler]: need };

    // 开城包：第 2 村 = base；第 N 村 = base * growth^(N-2)，N = villageCount+1
    const n = villageCount + 1;
    const per = Math.round(c.foundResourceCostBase * Math.pow(c.foundResourceCostGrowth, Math.max(0, n - 2)));
    const cost = { wood: per, clay: per, iron: per, crop: per };
    const spend = await this.commands.send({
      name: 'economy.TrySpend', from: MovementModule.NAME,
      payload: { villageId, cost },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'insufficient_resources' };

    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };

    const delta: Record<string, number> = { [settler]: -need };
    const adj = await this.commands.send({
      name: 'military.AdjustTroops', from: MovementModule.NAME,
      payload: { villageId, delta },
    });
    if (!adj.ok) {
      // 兵力不足：退回开城包
      await this.commands.send({
        name: 'economy.Grant', from: MovementModule.NAME,
        payload: { villageId, gain: cost },
      });
      return { ok: false, payload: {}, reason: adj.reason ?? 'no_settlers' };
    }

    const mv = this.launch({
      id: this.nextId(), type: 'found', fromVillage: villageId, fromXY, toXY,
      troops, departAt: this.now(), founderPlayerId: playerId,
    });

    log('出征(found)', { id: mv.id, from: villageId, to: toXY, troops, cost: per, arriveAt: new Date(mv.arriveAt).toISOString() });
    void this.bus.emit({
      name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(),
      payload: { id: mv.id, type: 'found', villageId, q, r, arriveAt: mv.arriveAt },
    } as DomainEvent);
    return {
      ok: true,
      payload: {
        id: mv.id,
        arriveAt: mv.arriveAt,
        travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000),
        foundingCost: cost,
      },
    };
  }

  private settlerUnitCode(tribe: string): string | undefined {
    for (const [code, def] of Object.entries(this.config.units)) {
      if (def.tribe === tribe && def.popPermanent) return code;
    }
    return undefined;
  }

  private async validateFoundSite(
    toXY: Hex,
    minDist: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const tileRes = await this.commands.send({
      name: 'world.GetTile', from: MovementModule.NAME,
      payload: { q: toXY.q, r: toXY.r },
    });
    const tile = (tileRes.payload as any)?.tile;
    if (tile && tile.kind && tile.kind !== 'empty') {
      return { ok: false, reason: 'tile_occupied' };
    }
    const distRes = await this.commands.send({
      name: 'world.MinVillageDistance', from: MovementModule.NAME,
      payload: { q: toXY.q, r: toXY.r },
    });
    const d = (distRes.payload as any)?.distance as number;
    if (typeof d === 'number' && d >= 0 && d < minDist) {
      return { ok: false, reason: 'too_close_to_village' };
    }
    return { ok: true };
  }

  /** 拓荒到达：合法则建村；否则拓荒者返程（开城包已扣不退）。 */
  private async arriveFound(mv: Movement): Promise<void> {
    const c = this.config.constants;
    const site = await this.validateFoundSite(mv.toXY, c.foundMinTileDistance);
    const playerId = mv.founderPlayerId;
    if (!site.ok || !playerId) {
      log('拓荒失败返程', { id: mv.id, reason: site.ok ? 'no_player' : site.reason });
      this.store.delete(COLLECTION, mv.id);
      this.updateEnRoutePop(mv.fromVillage);
      this.scheduleReturn(mv.fromVillage, mv.toXY, mv.fromXY, mv.troops, {});
      return;
    }

    const created = await this.commands.send({
      name: 'player.CreateOwnedVillage', from: MovementModule.NAME,
      payload: {
        playerId,
        q: mv.toXY.q,
        r: mv.toXY.r,
      },
    });
    this.store.delete(COLLECTION, mv.id);
    this.updateEnRoutePop(mv.fromVillage);

    if (!created.ok) {
      log('拓荒建村失败返程', { id: mv.id, reason: created.reason });
      this.scheduleReturn(mv.fromVillage, mv.toXY, mv.fromXY, mv.troops, {});
      return;
    }

    const newVillageId = (created.payload as any).villageId as string;
    log('拓荒建村成功', { id: mv.id, newVillageId, at: mv.toXY });
    // 拓荒者消耗在建村（popPermanent，不归队）
    void this.bus.emit({
      name: 'movement.VillageFounded', source: MovementModule.NAME, ts: this.now(),
      payload: {
        villageId: mv.fromVillage,
        newVillageId,
        q: mv.toXY.q,
        r: mv.toXY.r,
        playerId,
      },
    } as DomainEvent);
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
    this.scheduler.schedule(mv.perStepMs, () => this.step(id, mv.stepToken), `movement:${id}`, `movement:${id}`);
  }

  /** 到达终点：按类型分派（出征→交给 Combat；返程→归队入库；拓荒→建村；运输→留守入库）。 */
  private async arrive(mv: Movement): Promise<void> {
    if (mv.type === 'return') { await this.arriveReturn(mv.id); return; }
    if (mv.type === 'found') { await this.arriveFound(mv); return; }
    if (mv.type === 'transport') { await this.arriveTransport(mv); return; }
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
        troops: mv.troops, attackerSnapshot: await this.attackerSnapshot(mv),
      },
    });
    this.store.delete(COLLECTION, mv.id);
    // v2：通知 population 在途兵力减少（部队进入战场，不再算在途）
    this.updateEnRoutePop(mv.fromVillage);
  }

  /**
   * 进攻方参战快照：优先向源村 Military 取"含铁匠养成加成的最终数值"（派生管线对外口径，
   * 与防守方 GetCombatSnapshot 同源 → 攻守对称）。源村不可用时回退到 CSV 原始数值。
   * 修复：此前直接用 buildSnapshot 导致铁匠加成只作用于防守、进攻无效。
   */
  private async attackerSnapshot(mv: Movement): Promise<Snapshot> {
    const res = await this.commands.send({
      name: 'military.GetCombatSnapshot', from: MovementModule.NAME,
      payload: { villageId: mv.fromVillage, units: mv.troops },
    });
    const snap = (res.ok ? (res.payload as { snapshot?: Snapshot }).snapshot : undefined);
    if (snap && Object.keys(snap).length > 0) return snap;
    return this.buildSnapshot(mv.troops); // 回退：源村已消失等异常，用原始数值保证出征仍能结算
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
    this.updateEnRoutePop(loser.fromVillage);

    // 胜方：无幸存者则一并消失；否则更新兵力、恢复行军（新令牌）。
    if (Object.keys(survivors).length === 0) {
      this.store.delete(COLLECTION, winner.id);
      this.updateEnRoutePop(winner.fromVillage);
      return;
    }
    winner.troops = survivors;
    winner.status = 'marching';
    winner.stepToken += 1;
    winner.nextStepAt = this.now() + winner.perStepMs;
    this.store.set(COLLECTION, winner.id, winner);
    // 若胜方已在终点格相遇，直接到达；否则继续走
    if (winner.stepIndex >= winner.path.length - 1) await this.arrive(winner);
    else this.scheduler.schedule(winner.perStepMs, () => this.step(winner.id, winner.stepToken), `movement:${winner.id}`, `movement:${winner.id}`);
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
    // v2：通知 population 在途兵力减少（返程到家）
    this.updateEnRoutePop(mv.fromVillage);
    void this.bus.emit({ name: 'movement.Returned', source: MovementModule.NAME, ts: this.now(), payload: { villageId: mv.fromVillage, troops: mv.troops, loot: mv.loot } } as DomainEvent);
  }

  /**
   * 回退用兵力快照：用兵种定义构造（含特性解析，但**不含铁匠加成**）。
   * 正常路径走 attackerSnapshot → military.GetCombatSnapshot（含加成）；此函数仅在源村不可用时兜底。
   */
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
