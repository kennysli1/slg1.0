import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Movement as MovementWire, ForeignArmy } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { KeyedSerialQueue } from '../infra/keyed-serial-queue.js';
import type { Snapshot } from '../infra/combat-types.js';
import type { GameConfig } from '../infra/config.js';
import { type Hex, hexDistance, linePath, hexDistanceWrapped, linePathWrapped, wrapHex, headingWrapped, hexKey } from '../infra/hex.js';
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
 * 支持类型：raid(打PvE)、attack(打玩家村)、scout(侦察玩家村)、return(返程)、found(拓荒建村)、transport(村间运输)、garrison(野外驻扎)、ambush(野外伏击)、explore(探索后返程)。
 */

interface MovementRecord {
  id: string;
  type: 'raid' | 'attack' | 'scout' | 'return' | 'found' | 'transport' | 'caravan' | 'garrison' | 'explore' | 'ambush';
  /** 战斗类型：玩家村 raid=掠夺、siege=攻城；ambush=伏击；PvE/旧存档为空。 */
  battleType?: 'raid' | 'siege' | 'ambush';
  fromVillage: string;
  /** 起点/终点，六边形轴坐标。字段名沿用 XY 仅为 combat 透传兼容，值是 {q,r}。 */
  fromXY: Hex;
  toXY: Hex;
  /** 首次离城的出发格；掉头/撤回/战后返程都不覆盖。 */
  originalFromXY?: Hex;
  /** 撤回或目标消失时被放弃的原目标格。 */
  abandonedToXY?: Hex;
  /** 来袭告警是否已推给被攻击方（视野门控，只推一次）。 */
  alertedTarget?: boolean;
  targetId?: string; // PvE 目标 id
  targetVillage?: string; // PvP 被攻击村 / 运输目标村 id
  /** 侦察报告类型；scout_buildings 是城内/城外建筑快照，旧名不再对外使用。 */
  scoutType?: 'scout_resources' | 'scout_buildings';
  /** 返程军队对应的「出征」军队 id（由 onBattleEnded 透传）；用于跨模块匹配携带宝物/掉落 pending（均按出征 id 索引）。 */
  outwardId?: string;
  troops: Record<string, number>;
  /** 该军队携带的宝物 code 列表（军队携带宝物机制）；在途时城镇失去加成、军队获得加成。 */
  treasures?: string[];
  loot?: Record<string, number>;
  /** 运输货物（transport） */
  cargo?: Record<string, number>;
  /** 村间运输的语义：transfer=仅部队/宝物转移；旧 transport=兼容资源运输。 */
  transportMode?: 'transfer' | 'transport' | 'reinforce';
  /** 拓荒发起玩家（found 到达建村用） */
  founderPlayerId?: string;
  departAt: number;
  /** 首次派出时刻；撤回窗口以此为准，不因内部转向/返程重置。 */
  launchedAt?: number;
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
  /** marching=正常行军；stopped=玩家原地待命；paused=相遇/战斗中暂停；stationed=野外驻扎，等待下一道指令。 */
  status: 'marching' | 'paused' | 'stationed' | 'stopped';
  /** 驻扎命令原本指定的落点；若落点后来被占据，部队会停在前一格而保留此记录供 UI 说明。 */
  requestedXY?: Hex;
  /**
   * 步进令牌：每次登记"下一格"任务时自增并记录。step 回调携带登记时的令牌，
   * 只有令牌匹配才执行——作废因相遇/暂停而遗留的过期定时任务，防止重复推进。
   */
  stepToken: number;
  /** 商队（贸易）：返程归属村与到达本村时需回收的贸易路线数（由 trade 模块写入）。 */
  homeVillage?: string;
  /** 商队（贸易）：到达本村回收的贸易路线数。 */
  routesFreed?: number;
  /** 商队（贸易）：true=正在返程（到家即回收路线）；false=去程（到目标村交付货物后启动返程）。 */
  returning?: boolean;
}

const COLLECTION = 'movement';

export class MovementModule {
  static readonly NAME = 'movement';

  /** 位置索引："q,r" → movement id 集合（内存派生，不落库）。 */
  private posIndex = new Map<string, Set<string>>();
  /** 村庄索引：villageId → movement id 集合。 */
  private villageIndex = new Map<string, Set<string>>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
    private serialQueue?: KeyedSerialQueue,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.normalizeCoords();
    this.commands.register('movement.SendRaid', (c) => this.sendRaid(c));
    this.commands.register('movement.SendAttack', (c) => this.sendAttack(c));
    this.commands.register('movement.SendScout', (c) => this.sendScout(c));
    this.commands.register('movement.SendVillageRaid', (c) => this.sendVillageRaid(c));
    this.commands.register('movement.SendReinforce', (c) => this.sendReinforce(c));
    this.commands.register('movement.GetMarchOptions', (c) => this.getMarchOptions(c));
    this.commands.register('movement.PreviewMarch', (c) => this.previewMarch(c));
    this.commands.register('movement.FoundVillage', (c) => this.foundVillage(c));
    this.commands.register('movement.SendTransport', (c) => this.sendTransport(c));
    this.commands.register('movement.SendGarrison', (c) => this.sendGarrison(c));
    this.commands.register('movement.SendAmbush', (c) => this.sendAmbush(c));
    this.commands.register('movement.SendExplore', (c) => this.sendExplore(c));
    this.commands.register('movement.StopMarch', (c) => this.stopMarch(c));
    this.commands.register('movement.ResumeMarch', (c) => this.resumeMarch(c));
    this.commands.register('movement.RecallMarch', (c) => this.recallMarch(c));
    this.commands.register('movement.RecallGarrison', (c) => this.recallGarrison(c));
    this.commands.register('movement.ContinueGarrison', (c) => this.continueGarrison(c));
    this.commands.register('movement.SendCaravan', (c) => this.sendCaravan(c));
    this.commands.register('movement.List', (c) => this.list(c));
    this.commands.register('movement.GetMovement', (c) => this.getMovement(c));
    this.commands.register('movement.ListVisionSources', (c) => this.listVisionSources(c));
    this.commands.register('movement.ListForeign', (c) => this.listForeign(c));
    // 战斗结束 → 安排幸存者带战利品返程（跨模块只走 Event）
    this.bus.on('combat.BattleEnded', (e: DomainEvent) => this.onBattleEnded(e));
    // 目标消失（PvE 营地/幸福村被移除、玩家村庄被放弃）→ 在途的进攻/运输/商队立即原路返回
    this.bus.on('pve.TargetRemoved', (e: DomainEvent) => void this.onTargetRemoved(e));
    this.bus.on('world.VillageRemoved', (e: DomainEvent) => void this.onVillageRemoved(e));
    this.rebuildIndexes();
  }

  private posKey(q: number, r: number): string {
    return hexKey(q, r);
  }

  private indexAdd(mv: MovementRecord): void {
    const pk = this.posKey(mv.pos.q, mv.pos.r);
    let ps = this.posIndex.get(pk);
    if (!ps) { ps = new Set(); this.posIndex.set(pk, ps); }
    ps.add(mv.id);
    let vs = this.villageIndex.get(mv.fromVillage);
    if (!vs) { vs = new Set(); this.villageIndex.set(mv.fromVillage, vs); }
    vs.add(mv.id);
  }

  private indexRemove(mv: MovementRecord): void {
    if (mv.pos) {
      this.posIndex.get(this.posKey(mv.pos.q, mv.pos.r))?.delete(mv.id);
    }
    this.villageIndex.get(mv.fromVillage)?.delete(mv.id);
  }

  private rebuildIndexes(): void {
    this.posIndex.clear();
    this.villageIndex.clear();
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) this.indexAdd(mv);
  }

  private save(mv: MovementRecord): void {
    const prev = this.load(mv.id);
    if (prev) this.indexRemove(prev);
    this.store.set(COLLECTION, mv.id, mv);
    this.indexAdd(mv);
  }

  private remove(id: string, reason: 'arrived' | 'returned' | 'destroyed' | 'converted' = 'destroyed'): void {
    const prev = this.load(id);
    if (prev) {
      this.indexRemove(prev);
      void this.bus.emit({
        name: 'movement.Removed', source: MovementModule.NAME, ts: this.now(),
        payload: { villageId: prev.fromVillage, id: prev.id, reason },
      } as DomainEvent);
      // 外军消失：通知视野内的玩家
      void this.commands.send({ name: 'vision.GetObservers', from: MovementModule.NAME, payload: { q: prev.pos.q, r: prev.pos.r } }).then((obsRes) => {
        const playerIds: string[] = (obsRes.payload as any)?.playerIds ?? [];
        if (playerIds.length === 0) return;
        void this.bus.emit({
          name: 'movement.ForeignRemoved', source: MovementModule.NAME, ts: this.now(),
          payload: { playerIds, id: prev.id },
        } as DomainEvent);
      });
    }
    this.store.delete(COLLECTION, id);
  }

  private recallable(m: MovementRecord, viewerVillageId: string): boolean {
    if (m.fromVillage !== viewerVillageId) return false;
    if (m.type === 'return') return false;
    if (m.status === 'paused') return false;
    if (m.status === 'stationed') return false;
    // 商队由贸易路线自动运行，玩家不能在地图面板手动停止或撤回。
    if (m.type === 'caravan') return false;
    // 军队仅在派出后的 90 秒内允许撤回；兼容旧存档时退回 departAt。
    if (this.isArmyMovement(m) && this.now() - (m.launchedAt ?? m.departAt) >= 90_000) return false;
    return m.status === 'marching' || m.status === 'stopped';
  }

  private stoppable(m: MovementRecord, viewerVillageId: string): boolean {
    // 行军系统不再提供原地停止/继续命令；保留旧 Command 仅用于兼容旧客户端，始终拒绝。
    return false;
  }

  private isArmyMovement(m: MovementRecord): boolean {
    return m.type === 'raid' || m.type === 'attack' || m.type === 'scout' || m.type === 'found' || m.type === 'explore' || m.type === 'garrison' || m.type === 'ambush';
  }

  private toWire(m: MovementRecord, viewerVillageId: string): MovementWire {
    const dir = m.targetVillage === viewerVillageId && m.fromVillage !== viewerVillageId ? 'in' : 'out';
    const canRecall = dir === 'out' && this.recallable(m, viewerVillageId);
    const canStop = dir === 'out' && this.stoppable(m, viewerVillageId);
    return {
      id: m.id,
      type: m.type,
      dir,
      targetId: m.targetId,
      targetVillage: m.targetVillage,
      scoutType: m.scoutType,
      battleType: m.battleType,
      from: m.fromXY,
      originalFrom: m.originalFromXY ?? m.fromXY,
      to: m.toXY,
      abandonedTo: m.abandonedToXY,
      path: m.path,
      pos: m.pos,
      stepIndex: m.stepIndex,
      status: m.status,
      perStepMs: m.perStepMs,
      nextStepAt: m.nextStepAt,
      troops: m.troops,
      cargo: m.cargo,
      loot: m.loot,
      treasures: m.treasures,
      arriveAt: m.arriveAt,
      requested: m.requestedXY,
      recallable: canRecall,
      stoppable: canStop,
      recallForfeits: canRecall && m.type === 'found' ? true : undefined,
    };
  }

  private toForeignArmy(mv: MovementRecord, owner: { playerId?: string; name?: string; villageName?: string }): ForeignArmy {
    const W = this.config.constants.worldW ?? 41;
    const H = this.config.constants.worldH ?? 41;
    const heading = mv.status === 'marching' && mv.stepIndex < mv.path.length - 1
      ? headingWrapped(mv.pos, mv.path[mv.stepIndex + 1], W, H)
      : null;
    return {
      id: mv.id,
      type: mv.type,
      status: mv.status,
      ownerPlayerId: owner.playerId,
      ownerPlayerName: owner.name,
      ownerVillageName: owner.villageName,
      pos: mv.pos,
      heading,
      perStepMs: mv.perStepMs,
      nextStepAt: mv.nextStepAt,
    };
  }

  /** 归一行军坐标进环面（幂等，兼容旧档）。 */
  private normalizeCoords(): void {
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const wrap = (hh: any) => (hh ? wrapHex({ q: hh.q, r: hh.r }, W, H) : hh);
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      const upd: any = { ...mv };
      if (mv.fromXY) upd.fromXY = wrap(mv.fromXY);
      if (mv.toXY) upd.toXY = wrap(mv.toXY);
      if (Array.isArray(mv.path)) upd.path = mv.path.map(wrap);
      if (mv.pos) upd.pos = wrap(mv.pos);
      this.store.set(COLLECTION, mv.id, upd);
    }
  }

  /** 重启恢复：为所有在途、仍在行军的部队重新登记下一格推进（过期则立即触发）。 */
  resume(): void {
    // 先汇总各村的在途部队 popCost 总量 + 在途兵力，恢复 population.SetEnRoutePop 与 military 粮耗。
    const enRouteByVillage = new Map<string, { popCostSum: number; marching: Record<string, number> }>();
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      const popSum = this.calcTroopsPopCost(mv.troops);
      const cur = enRouteByVillage.get(mv.fromVillage) ?? { popCostSum: 0, marching: {} };
      cur.popCostSum += popSum;
      for (const [unit, n] of Object.entries(mv.troops)) {
        cur.marching[unit] = (cur.marching[unit] ?? 0) + n;
      }
      enRouteByVillage.set(mv.fromVillage, cur);
    }
    for (const [villageId, data] of enRouteByVillage) {
      void this.commands.send({
        name: 'population.SetEnRoutePop',
        from: MovementModule.NAME,
        payload: { villageId, popCostSum: data.popCostSum },
      });
      void this.commands.send({
        name: 'military.SetMarchingTroops',
        from: MovementModule.NAME,
        payload: { villageId, troops: data.marching },
      });
    }

    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      if (mv.status !== 'marching') continue;
      // 续跑：作废旧令牌，登记新的下一格任务。
      mv.stepToken += 1;
      const token = mv.stepToken;
      this.save(mv);
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

  /** 更新某村的在途总 popCost 与在途兵力，通知 population（动员足迹）与 military（粮耗）。 */
  private updateEnRoutePop(villageId: string): void {
    let total = 0;
    const marching: Record<string, number> = {};
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      if (mv.fromVillage !== villageId) continue;
      total += this.calcTroopsPopCost(mv.troops);
      for (const [unit, n] of Object.entries(mv.troops)) {
        marching[unit] = (marching[unit] ?? 0) + n;
      }
    }
    void this.commands.send({
      name: 'population.SetEnRoutePop',
      from: MovementModule.NAME,
      payload: { villageId, popCostSum: total },
    });
    // 在途部队仍耗粮：把在途兵力快照推给 military，计入 upkeep（出征不减免口粮）。
    void this.commands.send({
      name: 'military.SetMarchingTroops',
      from: MovementModule.NAME,
      payload: { villageId, troops: marching },
    });
  }

  private load(id: string): MovementRecord | undefined {
    return this.store.get<MovementRecord>(COLLECTION, id);
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

  private async villageTile(villageId: string): Promise<{ q: number; r: number; name?: string } | null> {
    const res = await this.commands.send({
      name: 'world.GetTileByRef',
      from: MovementModule.NAME,
      payload: { refId: villageId, kind: 'village' },
    });
    const tile = (res.payload as any)?.tile;
    return res.ok && tile && Number.isFinite(Number(tile.q)) && Number.isFinite(Number(tile.r))
      ? { q: Number(tile.q), r: Number(tile.r), name: typeof tile.name === 'string' ? tile.name : undefined }
      : null;
  }

  private async villageXY(villageId: string): Promise<Hex | null> {
    const tile = await this.villageTile(villageId);
    return tile ? { q: tile.q, r: tile.r } : null;
  }

  /** 解析任意地块坐标：先试玩家村庄，再试 PvE / 任务营地（用于商队向幸福村等 NPC 村庄送货）。 */
  private async tileXY(refId: string): Promise<Hex | null> {
    const v = await this.villageXY(refId);
    if (v) return v;
    const res = await this.commands.send({
      name: 'world.GetTileByRef',
      from: MovementModule.NAME,
      payload: { refId },
    });
    const tile = (res.payload as any)?.tile;
    return res.ok && tile ? { q: tile.q, r: tile.r } : null;
  }

  /**
   * 把玩家选定的宝物装上即将出征的军队（treasure.AssignToArmy）。携带上限 = min(treasureCarryMaxSlots, floor(总兵力 / treasureCarryTroopsPerSlot))。
   * 在任何「扣兵」动作之前调用无副作用；若调用方已先扣兵、本函数失败，调用方应退还兵力。
   * 返回实际装上的宝物 code 列表（空列表表示未选/无需）。
   */
  private async assignCarry(
    villageId: string,
    treasures: string[] | undefined,
    mvId: string,
    troops: Record<string, number>,
  ): Promise<{ ok: true; codes: string[] } | { ok: false; reason: string }> {
    const list = Array.isArray(treasures) ? treasures.filter(Boolean) : [];
    if (list.length === 0) return { ok: true, codes: [] };
    const c = this.config.constants;
    const totalTroops = Object.values(troops).reduce((a, n) => a + Math.max(0, n), 0);
    const cap = Math.min(c.treasureCarryMaxSlots, Math.floor(totalTroops / Math.max(1, c.treasureCarryTroopsPerSlot)));
    const res = await this.commands.send({
      name: 'treasure.AssignToArmy', from: MovementModule.NAME,
      payload: { villageId, codes: list, movementId: mvId, maxCarry: cap },
    });
    if (!res.ok) return { ok: false, reason: res.reason ?? 'assign_failed' };
    return { ok: true, codes: ((res.payload as any)?.codes as string[]) ?? list };
  }

  /**
   * 列出某村相关的在途行军（含路径/当前位置/状态，供前端可视化）。
   * 同时返回「我发出的」(fromVillage===me) 与「来袭/送达我的」(targetVillage===me) 两类，
   * 用 dir 区分：out=我方出发，in=朝我而来（来袭商队/进攻/送达运输）。
   * 攻击类 in 会带上 troops，供地图显示来袭部队组成。
   */
  private async list(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const all = this.store.all<MovementRecord>(COLLECTION).filter(
      (m) => m.fromVillage === villageId || m.targetVillage === villageId,
    );
    const marchPoints = await this.marchPointState(villageId);
    return {
      ok: true,
      payload: {
        movements: all.map((m) => this.toWire(m, villageId)),
        marchPoints,
      },
    };
  }

  /** 查询某行军是否仍存在（供其他模块跨模块查询，避免直接读 movement 集合，违反铁律#1）。 */
  private getMovement(cmd: Command): CommandResult {
    const { movementId } = cmd.payload as { movementId: string };
    const mv = this.store.get<MovementRecord>(COLLECTION, movementId);
    return { ok: true, payload: { exists: !!mv } };
  }

  /** 为视野模块提供指定玩家在途军队的位置和视野；不暴露给客户端。 */
  private async listVisionSources(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId: string };
    const sources: Array<{ q: number; r: number; radius: number }> = [];
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      const owner = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId: mv.fromVillage } });
      if (!owner.ok || (owner.payload as any).player?.id !== playerId) continue;
      let most = 0, radius = 0;
      for (const [code, raw] of Object.entries(mv.troops ?? {})) {
        const count = Math.max(0, Number(raw) || 0);
        const sight = this.config.units[code]?.vision ?? 1;
        if (count > most || (count === most && sight > radius)) { most = count; radius = sight; }
      }
      if (most > 0) sources.push({ q: mv.pos.q, r: mv.pos.r, radius: mv.type === 'ambush' ? 1 : radius });
    }
    return { ok: true, payload: { sources } };
  }

  /**
   * 对外暴露「其他玩家」在「己方视野内」的离城军（脱敏，绝不含兵力/携带物/战利品）。
   * 用于大地图轮询：所有拥有该格子可见视野的玩家都能看到这支军队，
   * 但只能看到它属于谁（玩家名/来源城镇）与行军几何，看不到具体兵力和货物。
   * 已方军队由 movement.List 下发，此处一律排除。
   */
  private async listForeign(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'player_not_found' };

    // 1) 取己方可见格集合（城市视野 + 己方行军视野），其余格子上的军队一律不可见。
    const visRes = await this.commands.send({ name: 'vision.GetVisibleTiles', from: MovementModule.NAME, payload: { playerId } });
    if (!visRes.ok) return { ok: false, payload: {}, reason: (visRes as any).reason ?? 'vision_unavailable' };
    const visible = new Set<string>((visRes.payload as any).tiles ?? []);
    if (visible.size === 0) return { ok: true, payload: { movements: [] } };

    // 2) 遍历全量行军，按「位置可见 + 非己方」过滤，并脱敏。
    //    村→玩家归属解析按 villageId 缓存，避免每个 movement 都打 player 模块。
    const ownerCache = new Map<string, { playerId?: string; name?: string; villageName?: string } | null>();
    const resolveOwner = async (villageId: string) => {
      const cached = ownerCache.get(villageId);
      if (cached !== undefined) return cached;
      const res = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId } });
      let owner: { playerId?: string; name?: string; villageName?: string } | null = null;
      if (res.ok) {
        const p = (res.payload as any).player;
        const v = (p?.villages ?? []).find((x: any) => x.id === villageId);
        owner = { playerId: p?.id, name: p?.name, villageName: v?.name ?? villageId };
      }
      ownerCache.set(villageId, owner);
      return owner;
    };

    const out: ForeignArmy[] = [];
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      if (!mv.fromVillage || !mv.pos) continue;
      const key = `${mv.pos.q},${mv.pos.r}`;
      if (mv.type === 'ambush') {
        // 伏击军的隐蔽性不受城池视野影响：只有查看方自己的地图单位在一格内时可见。
        const nearby = await this.hasNearbyArmySource(playerId, mv.pos);
        if (!nearby) continue;
      } else if (!visible.has(key)) continue;
      const owner = await resolveOwner(mv.fromVillage);
      if (!owner || owner.playerId === playerId) continue;
      out.push(this.toForeignArmy(mv, owner));
    }
    return { ok: true, payload: { movements: out } };
  }

  /** 判断玩家是否有地图上的军队在目标一格内，用于伏击军的单位级可见性。 */
  private async hasNearbyArmySource(playerId: string, pos: Hex): Promise<boolean> {
    for (const own of this.store.all<MovementRecord>(COLLECTION)) {
      if (!this.isArmyMovement(own) || own.type === 'ambush' && own.status === 'stationed' && own.pos.q === pos.q && own.pos.r === pos.r) continue;
      if (await this.ownerOf(own.fromVillage) !== playerId) continue;
      if (hexDistanceWrapped(own.pos, pos, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41) <= 1) return true;
    }
    return false;
  }

  /** 一支离城军占用一个行军点；纯商队不占用。 */
  private marchPointUsage(villageId: string): number {
    const ids = this.villageIndex.get(villageId);
    if (!ids) return 0;
    let n = 0;
    for (const id of ids) {
      const m = this.load(id);
      if (!m || m.type === 'caravan') continue;
      if (Object.values(m.troops ?? {}).some((v) => Number(v) > 0)) n++;
    }
    return n;
  }

  /** 集结点决定同时可在地图上的军队数。默认每级 1 点，GM 可调基础值和每级增量。 */
  private async marchPointState(villageId: string): Promise<{ used: number; cap: number }> {
    const res = await this.commands.send({
      name: 'building.GetBuildingLevel', from: MovementModule.NAME,
      payload: { villageId, kind: 'rallypoint' },
    });
    const level = res.ok ? Math.max(0, Number((res.payload as any)?.level) || 0) : 0;
    const base = Math.max(0, this.config.constants.marchPointBase);
    const perLevel = Math.max(0, this.config.constants.marchPointPerRallypointLevel);
    return { used: this.marchPointUsage(villageId), cap: Math.floor(base + level * perLevel) };
  }

  /** 在新建一支离城军前校验行军点；续行/召回复用原军，不额外占点。 */
  private async ensureMarchPoint(villageId: string): Promise<CommandResult | null> {
    const state = await this.marchPointState(villageId);
    if (state.used < state.cap) return null;
    return { ok: false, payload: { ...state }, reason: 'march_points_exhausted' };
  }

  private visionRadius(troops: Record<string, number>): number {
    let most = 0, radius = 0;
    for (const [code, raw] of Object.entries(troops ?? {})) {
      const count = Math.max(0, Number(raw) || 0);
      const sight = this.config.units[code]?.vision ?? 1;
      if (count > most || (count === most && sight > radius)) { most = count; radius = sight; }
    }
    return radius;
  }

  private async targetVisibility(villageId: string, target: Hex): Promise<{ visibility: string; unexploredDepth: number } | null> {
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId } });
    const playerId = owner.ok ? (owner.payload as any)?.player?.id : undefined;
    if (!playerId) return null;
    const res = await this.commands.send({ name: 'vision.GetVisibility', from: MovementModule.NAME, payload: { playerId, q: target.q, r: target.r } });
    return res.ok ? (res.payload as any) : null;
  }

  /** 集结点等级就是可踏入的未探索深度（1级=离任一已探索格最多1格）。 */
  private async ensureExplorable(villageId: string, target: Hex): Promise<CommandResult | null> {
    const info = await this.targetVisibility(villageId, target);
    if (!info) return { ok: false, payload: {}, reason: 'vision_unavailable' };
    if (info.visibility !== 'unexplored') return { ok: false, payload: { ...info }, reason: 'target_already_explored' };
    const levelRes = await this.commands.send({ name: 'building.GetBuildingLevel', from: MovementModule.NAME, payload: { villageId, kind: 'rallypoint' } });
    const level = levelRes.ok ? Math.max(0, Number((levelRes.payload as any)?.level) || 0) : 0;
    if (info.unexploredDepth < 0 || info.unexploredDepth > level) return { ok: false, payload: { ...info, maxDepth: level }, reason: 'explore_too_deep' };
    return null;
  }

  private async ensureKnown(villageId: string, target: Hex): Promise<CommandResult | null> {
    const info = await this.targetVisibility(villageId, target);
    if (!info) return { ok: false, payload: {}, reason: 'vision_unavailable' };
    return info.visibility === 'unexplored' ? { ok: false, payload: info, reason: 'target_unexplored' } : null;
  }

  /** 行军起步与每一步都将当时视野写入探索历史；无需依赖客户端刷新地图。 */
  private async revealVision(mv: MovementRecord): Promise<void> {
    const radius = mv.type === 'ambush' ? 1 : this.visionRadius(mv.troops);
    if (radius <= 0) return;
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId: mv.fromVillage } });
    const playerId = owner.ok ? (owner.payload as any)?.player?.id : undefined;
    if (!playerId) return;
    const revealed = await this.commands.send({ name: 'vision.Reveal', from: MovementModule.NAME, payload: { playerId, q: mv.pos.q, r: mv.pos.r, radius } });
    if (revealed.ok) {
      void this.bus.emit({
        name: 'movement.VisionUpdated', source: MovementModule.NAME, ts: this.now(),
        payload: { villageId: mv.fromVillage, movementId: mv.id, q: mv.pos.q, r: mv.pos.r },
      } as DomainEvent);
    }
  }

  /** 目标终点被设施或其他军队占据时，驻扎在最后一格之前。 */
  private async garrisonLanding(mv: MovementRecord): Promise<Hex> {
    const tileRes = await this.commands.send({
      name: 'world.GetTile', from: MovementModule.NAME, payload: { q: mv.toXY.q, r: mv.toXY.r },
    });
    const tile = (tileRes.payload as any)?.tile;
    const terrainOccupied = !!(tile?.kind && tile.kind !== 'empty');
    const armyOccupied = this.store.all<MovementRecord>(COLLECTION).some((other) =>
      other.id !== mv.id
      && other.type !== 'caravan'
      && other.pos?.q === mv.toXY.q
      && other.pos?.r === mv.toXY.r,
    );
    if (!terrainOccupied && !armyOccupied) return mv.toXY;
    return mv.path[Math.max(0, mv.path.length - 2)] ?? mv.fromXY;
  }

  /** 抵达空地后改为驻扎；若目标在途中被占，安全停在进入目标的前一格。 */
  private async arriveGarrison(mv: MovementRecord): Promise<void> {
    const landing = await this.garrisonLanding(mv);
    mv.pos = landing;
    mv.stepIndex = Math.max(0, mv.path.findIndex((h) => h.q === landing.q && h.r === landing.r));
    mv.status = 'stationed';
    mv.nextStepAt = 0;
    this.save(mv);
    void this.bus.emit({
      name: 'movement.Garrisoned', source: MovementModule.NAME, ts: this.now(),
      payload: { id: mv.id, villageId: mv.fromVillage, q: landing.q, r: landing.r, diverted: landing.q !== mv.toXY.q || landing.r !== mv.toXY.r },
    } as DomainEvent);
  }

  /** 探索到达后不占地：若终点已出现障碍，落在前一格；无论哪种情况都立即返城。 */
  private async arriveExplore(mv: MovementRecord): Promise<void> {
    const landing = await this.garrisonLanding(mv);
    this.remove(mv.id);
    this.updateEnRoutePop(mv.fromVillage);
    await this.scheduleReturn(mv.fromVillage, landing, mv.fromXY, mv.troops, {}, mv.treasures, mv.id);
    void this.bus.emit({
      name: 'movement.Explored', source: MovementModule.NAME, ts: this.now(),
      payload: { id: mv.id, villageId: mv.fromVillage, q: landing.q, r: landing.r, blocked: landing.q !== mv.toXY.q || landing.r !== mv.toXY.r },
    } as DomainEvent);
  }

  /** 派兵至已知空地，抵达时在野外驻扎。未探索格必须改用 SendExplore。 */
  private async sendGarrison(cmd: Command): Promise<CommandResult> {
    const { villageId, q, r, troops, treasures } = cmd.payload as {
      villageId: string; q: number; r: number; troops: Record<string, number>; treasures?: string[];
    };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    if (Math.abs(q) > 1000 || Math.abs(r) > 1000) return { ok: false, payload: {}, reason: 'out_of_map' };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;
    const toXY = wrapHex({ q, r }, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    if (toXY.q === fromXY.q && toXY.r === fromXY.r) return { ok: false, payload: {}, reason: 'same_tile' };
    const known = await this.ensureKnown(villageId, toXY);
    if (known) return known;

    const delta = Object.fromEntries(Object.entries(valid.troops).map(([unit, n]) => [unit, -n]));
    const adjusted = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adjusted.ok) return { ok: false, payload: {}, reason: adjusted.reason ?? 'no_troops' };
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }
    const mv = await this.launch({ id, type: 'garrison', fromVillage: villageId, fromXY, toXY, troops: valid.troops, treasures: carry.codes, departAt: this.now() });
    mv.requestedXY = toXY;
    this.save(mv);
    await this.revealVision(mv);
    const state = await this.marchPointState(villageId);
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'garrison', villageId, q: toXY.q, r: toXY.r, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000), marchPoints: state } };
  }

  /** 派兵至已知空地并进入隐蔽伏击状态；抵达前仍按普通军队参与野战。 */
  private async sendAmbush(cmd: Command): Promise<CommandResult> {
    const { villageId, q, r, troops, treasures } = cmd.payload as {
      villageId: string; q: number; r: number; troops: Record<string, number>; treasures?: string[];
    };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = wrapHex({ q, r }, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    if (toXY.q === fromXY.q && toXY.r === fromXY.r) return { ok: false, payload: {}, reason: 'same_tile' };
    const known = await this.ensureKnown(villageId, toXY);
    if (known) return known;
    const tileRes = await this.commands.send({ name: 'world.GetTile', from: MovementModule.NAME, payload: toXY });
    const tile = (tileRes.payload as any)?.tile;
    if (tile && tile.kind && tile.kind !== 'empty') return { ok: false, payload: {}, reason: 'tile_occupied' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;
    const delta = Object.fromEntries(Object.entries(valid.troops).map(([unit, n]) => [unit, -n]));
    const adjusted = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adjusted.ok) return { ok: false, payload: {}, reason: adjusted.reason ?? 'no_troops' };
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }
    const mv = await this.launch({ id, type: 'ambush', fromVillage: villageId, fromXY, toXY, troops: valid.troops, treasures: carry.codes, departAt: this.now() });
    mv.requestedXY = toXY;
    this.save(mv);
    await this.revealVision(mv);
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'ambush', villageId, q: toXY.q, r: toXY.r, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000), marchPoints: await this.marchPointState(villageId) } };
  }

  /** 未探索地块只能执行探索：抵达（或遇阻前一格）即返程，不会驻扎。 */
  private async sendExplore(cmd: Command): Promise<CommandResult> {
    const { villageId, q, r, troops, treasures } = cmd.payload as { villageId: string; q: number; r: number; troops: Record<string, number>; treasures?: string[] };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = wrapHex({ q, r }, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    if (toXY.q === fromXY.q && toXY.r === fromXY.r) return { ok: false, payload: {}, reason: 'same_tile' };
    const exploration = await this.ensureExplorable(villageId, toXY);
    if (exploration) return exploration;
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;
    const delta = Object.fromEntries(Object.entries(valid.troops).map(([unit, n]) => [unit, -n]));
    const adjusted = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adjusted.ok) return { ok: false, payload: {}, reason: adjusted.reason ?? 'no_troops' };
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }
    const mv = await this.launch({ id, type: 'explore', fromVillage: villageId, fromXY, toXY, troops: valid.troops, treasures: carry.codes, departAt: this.now() });
    mv.requestedXY = toXY;
    this.save(mv);
    await this.revealVision(mv);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  /**
   * 原地停止正在出征的军队。停止只冻结行军，不改变路线、目标或携带物；
   * 后续可继续原路线，或改为撤回。stepToken 使已经登记的步进回调自然失效。
   */
  private async stopMarch(cmd: Command): Promise<CommandResult> {
    const { villageId, movementId } = cmd.payload as { villageId: string; movementId: string };
    const run = async (): Promise<CommandResult> => {
      const mv = this.load(movementId);
      if (!mv || mv.fromVillage !== villageId) return { ok: false, payload: {}, reason: 'not_found' };
      if (mv.status === 'paused') return { ok: false, payload: {}, reason: 'in_combat' };
      if (mv.status === 'stationed') return { ok: false, payload: {}, reason: 'use_garrison_commands' };
      if (mv.type === 'return') return { ok: false, payload: {}, reason: 'already_returning' };
      if (mv.type === 'caravan') return { ok: false, payload: {}, reason: 'caravan_uncontrollable' };
      if (mv.status === 'stopped') return { ok: false, payload: {}, reason: 'already_stopped' };
      if (!this.stoppable(mv, villageId)) return { ok: false, payload: {}, reason: 'not_stoppable' };
      mv.status = 'stopped';
      mv.stepToken += 1;
      mv.nextStepAt = 0;
      mv.arriveAt = 0;
      this.save(mv);
      void this.bus.emit({
        name: 'movement.Stopped', source: MovementModule.NAME, ts: this.now(),
        payload: { villageId, id: mv.id, q: mv.pos.q, r: mv.pos.r },
      } as DomainEvent);
      return { ok: true, payload: { id: mv.id, pos: mv.pos } };
    };
    if (this.serialQueue) return this.serialQueue.run(`movement:${movementId}`, run);
    return run();
  }

  /** 继续已停止的军队，沿原有路径从当前格进入下一格。 */
  private async resumeMarch(cmd: Command): Promise<CommandResult> {
    const { villageId, movementId } = cmd.payload as { villageId: string; movementId: string };
    const run = async (): Promise<CommandResult> => {
      const mv = this.load(movementId);
      if (!mv || mv.fromVillage !== villageId) return { ok: false, payload: {}, reason: 'not_found' };
      if (mv.status !== 'stopped') return { ok: false, payload: {}, reason: 'not_stopped' };
      const remainingSteps = Math.max(0, mv.path.length - 1 - mv.stepIndex);
      if (remainingSteps <= 0) return { ok: false, payload: {}, reason: 'already_arrived' };
      mv.status = 'marching';
      mv.stepToken += 1;
      mv.departAt = this.now();
      mv.nextStepAt = this.now() + mv.perStepMs;
      mv.arriveAt = this.now() + mv.perStepMs * remainingSteps;
      this.save(mv);
      this.scheduler.schedule(mv.perStepMs, () => this.step(mv.id, mv.stepToken), `movement:${mv.id}`, `movement:${mv.id}`);
      void this.bus.emit({
        name: 'movement.Resumed', source: MovementModule.NAME, ts: this.now(),
        payload: { villageId, id: mv.id, arriveAt: mv.arriveAt },
      } as DomainEvent);
      return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt } };
    };
    if (this.serialQueue) return this.serialQueue.run(`movement:${movementId}`, run);
    return run();
  }

  /** 主动撤回在途军队（掉头返程）。 */
  private async recallMarch(cmd: Command): Promise<CommandResult> {
    const { villageId, movementId } = cmd.payload as { villageId: string; movementId: string };
    const run = async (): Promise<CommandResult> => {
      const mv = this.load(movementId);
      if (!mv || mv.fromVillage !== villageId) return { ok: false, payload: {}, reason: 'not_found' };
      if (mv.status === 'paused') return { ok: false, payload: {}, reason: 'in_combat' };
      if (mv.status === 'stationed') return { ok: false, payload: {}, reason: 'use_recall_garrison' };
      if (mv.type === 'return') return { ok: false, payload: {}, reason: 'already_returning' };
      if (mv.type === 'caravan') return { ok: false, payload: {}, reason: 'caravan_uncontrollable' };
      if (!this.recallable(mv, villageId)) return { ok: false, payload: {}, reason: 'not_recallable' };
      mv.abandonedToXY = mv.toXY;
      await this.startReturn(mv);
      void this.bus.emit({
        name: 'movement.Recalled', source: MovementModule.NAME, ts: this.now(),
        payload: { villageId, id: mv.id, abandonedTo: mv.abandonedToXY, arriveAt: mv.arriveAt },
      } as DomainEvent);
      return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, abandonedTo: mv.abandonedToXY } };
    };
    if (this.serialQueue) return this.serialQueue.run(`movement:${movementId}`, run);
    return run();
  }

  /** 召回已驻扎军；兵和随军宝物沿原城池方向返还，仍复用既有行军点。 */
  private async recallGarrison(cmd: Command): Promise<CommandResult> {
    const { villageId, movementId } = cmd.payload as { villageId: string; movementId: string };
    const mv = this.load(movementId);
    if (!mv || mv.fromVillage !== villageId || (mv.type !== 'garrison' && mv.type !== 'ambush') || mv.status !== 'stationed') return { ok: false, payload: {}, reason: 'garrison_not_found' };
    this.remove(mv.id);
    const id = await this.scheduleReturn(mv.fromVillage, mv.pos, mv.fromXY, mv.troops, {}, mv.treasures, mv.id);
    void this.bus.emit({ name: 'movement.GarrisonRecalled', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, returnId: id, villageId } } as DomainEvent);
    return { ok: true, payload: { id } };
  }

  /** 让已驻扎军继续走向新坐标，可选择保持伏击、驻扎、探索、掠夺或攻城；不再扣兵也不增加行军点。 */
  private async continueGarrison(cmd: Command): Promise<CommandResult> {
    const { villageId, movementId, q, r, mode, targetId, targetVillage } = cmd.payload as {
      villageId: string; movementId: string; q: number; r: number; mode: 'garrison' | 'explore' | 'raid' | 'attack' | 'ambush'; targetId?: string; targetVillage?: string;
    };
    const mv = this.load(movementId);
    if (!mv || mv.fromVillage !== villageId || (mv.type !== 'garrison' && mv.type !== 'ambush') || mv.status !== 'stationed') return { ok: false, payload: {}, reason: 'garrison_not_found' };
    const toXY = wrapHex({ q, r }, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    if (toXY.q === mv.pos.q && toXY.r === mv.pos.r) return { ok: false, payload: {}, reason: 'same_tile' };
    if (mode === 'garrison' || mode === 'ambush' || mode === 'raid' || mode === 'attack') {
      const known = await this.ensureKnown(villageId, toXY);
      if (known) return known;
    }
    if (mode === 'explore') {
      const exploration = await this.ensureExplorable(villageId, toXY);
      if (exploration) return exploration;
    }
    if (mode === 'raid' && !targetId) return { ok: false, payload: {}, reason: 'target_not_found' };
    if (mode === 'attack' && !targetVillage) return { ok: false, payload: {}, reason: 'target_not_found' };
    const path = linePathWrapped(mv.pos, toXY, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    const steps = Math.max(1, path.length - 1);
    const perStepMs = Math.max(1, Math.round(await this.travelSec(mv.fromVillage, mv.pos, toXY, mv.troops) * 1000 / steps));
    mv.type = mode;
    mv.targetId = mode === 'raid' ? targetId : undefined;
    mv.targetVillage = mode === 'attack' ? targetVillage : undefined;
    mv.requestedXY = mode === 'garrison' || mode === 'ambush' || mode === 'explore' ? toXY : undefined;
    mv.toXY = toXY;
    mv.path = path;
    mv.stepIndex = 0;
    mv.pos = path[0];
    mv.perStepMs = perStepMs;
    mv.nextStepAt = this.now() + perStepMs;
    mv.arriveAt = this.now() + perStepMs * steps;
    mv.launchedAt = this.now();
    mv.status = 'marching';
    mv.stepToken += 1;
    this.save(mv);
    await this.revealVision(mv);
    this.scheduler.schedule(perStepMs, () => this.step(mv.id, mv.stepToken), `movement:${mv.id}`, `movement:${mv.id}`);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - this.now()) / 1000) } };
  }

  /** 全程行军秒数：六边形距离 / 最慢兵种速度（格/小时）。 */
  private async travelSec(villageId: string, from: Hex, to: Hex, troops: Record<string, number>): Promise<number> {
    const dist = hexDistanceWrapped(from, to, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    const mult = this.config.constants.marchSpeedMultiplier ?? 1;
    const speed = await this.commands.send({ name: 'military.GetMarchSpeedSnapshot', from: MovementModule.NAME, payload: { villageId, troops } });
    const slowest = (speed.ok ? Number((speed.payload as any).slowestSpeed) : Math.min(...Object.keys(troops).map((u) => this.config.units[u]?.speed ?? 6))) * mult;
    return Math.max(3, Math.round((dist / slowest) * 3600)); // 速度=格/小时
  }

  /** 组装一条行军记录（算路径 + 每格耗时），落库并登记首个推进任务。 */
  private async launch(
    base: Pick<MovementRecord, 'id' | 'type' | 'fromVillage' | 'fromXY' | 'toXY' | 'troops' | 'departAt'> &
      Partial<Pick<MovementRecord, 'targetId' | 'targetVillage' | 'battleType' | 'scoutType' | 'loot' | 'cargo' | 'transportMode' | 'founderPlayerId' | 'treasures' | 'outwardId' | 'originalFromXY'>>,
  ): Promise<MovementRecord> {
    const path = linePathWrapped(base.fromXY, base.toXY, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    const steps = Math.max(1, path.length - 1);
    const totalMs = await this.travelSec(base.fromVillage, base.fromXY, base.toXY, base.troops) * 1000;
    const perStepMs = Math.max(1, Math.round(totalMs / steps));
    const full: MovementRecord = {
      ...base,
      launchedAt: base.departAt,
      originalFromXY: base.originalFromXY ?? base.fromXY,
      path,
      stepIndex: 0,
      pos: path[0],
      perStepMs,
      nextStepAt: this.now() + perStepMs,
      arriveAt: this.now() + perStepMs * steps,
      status: 'marching',
      stepToken: 1,
    };
    this.save(full);
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
    const { villageId, targetId, troops, treasures } = cmd.payload as {
      villageId: string;
      targetId: string;
      troops: Record<string, number>;
      treasures?: string[];
    };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;

    // 目标存在？拿其坐标
    const target = await this.commands.send({ name: 'pve.GetTarget', from: MovementModule.NAME, payload: { id: targetId } });
    if (!target.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    const tp = target.payload as any;
    // 任务营地归接取村所有，但同一玩家的其它村也可以派兵清理；幸福村等私有 NPC 仍限本村。
    if (tp.ownerVillageId && tp.ownerVillageId !== villageId && !(tp.task === true && await this.samePlayerVillage(villageId, tp.ownerVillageId))) {
      return { ok: false, payload: {}, reason: 'not_task_owner' };
    }
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

    // 装宝物上军队（失败则退还兵力）
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }

    const mv = await this.launch({
      id, type: 'raid', fromVillage: villageId, fromXY, toXY, targetId, troops: valid.troops,
      treasures: carry.codes, departAt: this.now(),
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
    const { villageId, targetVillage, troops, treasures, declareWar } = cmd.payload as {
      villageId: string;
      targetVillage: string;
      troops: Record<string, number>;
      treasures?: string[]; declareWar?: boolean;
    };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'cannot_attack_self' };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = await this.villageXY(targetVillage);
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;

    // 目标村必须存在（有军队状态即视为存在）
    const exists = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId: targetVillage } });
    if (!exists.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    // 旧客户端未携带 declareWar 字段时沿用旧行为（视为确认宣战）；新客户端显式 false 才拒绝。
    const relation = await this.validatePvPRelation(villageId, targetVillage, declareWar === undefined ? true : declareWar);
    if (!relation.ok) return relation;
    // 从源村扣出兵力
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(valid.troops)) delta[u] = -n;
    const adj = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };

    // 装宝物上军队（失败则退还兵力）
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }

    const mv = await this.launch({
      id, type: 'attack', battleType: 'siege', fromVillage: villageId, fromXY, toXY, targetVillage, troops: valid.troops,
      treasures: carry.codes, departAt: this.now(),
    });

    log('出征(attack)', { id: mv.id, from: villageId, targetVillage, troops: valid.troops, arriveAt: new Date(mv.arriveAt).toISOString() });
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'attack', villageId, targetVillage, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  private async getRallyLevel(villageId: string): Promise<number> {
    const res = await this.commands.send({ name: 'building.GetBuildingLevel', from: MovementModule.NAME, payload: { villageId, kind: 'rallypoint' } });
    return res.ok ? Math.max(0, Number((res.payload as any)?.level) || 0) : 0;
  }

  /** 地图目标的唯一模式清单；客户端不再自行猜测盟军/中立/敌对。 */
  private async getMarchOptions(cmd: Command): Promise<CommandResult> {
    const { villageId, kind, refId, q, r } = cmd.payload as { villageId: string; kind: string; refId?: string; q: number; r: number };
    const modes: Array<{ mode: string; label: string; requiresDeclaration?: boolean }> = [];
    let relation: string | undefined;
    let targetPlayerId: string | undefined;
    const originTile = await this.villageTile(villageId);
    const targetTile = refId && (kind === 'village' || kind === 'own_village')
      ? await this.villageTile(refId)
      : null;
    // 客户端可能缓存了 GM 修改前的坐标/名称；己方村目标必须回传 World 的权威值。
    const targetQ = targetTile?.q ?? q;
    const targetR = targetTile?.r ?? r;
    const targetName = targetTile?.name;
    if (kind === 'empty') {
      modes.push({ mode: 'garrison', label: '驻扎' });
      modes.push({ mode: 'ambush', label: '伏击' });
    }
    else if (kind === 'pve' || kind === 'taskcamp') {
      // PvE 营地也可侦察，但 NPC 营地没有城内/城外建筑报告，只提供资源与守军情报。
      modes.push({ mode: 'scout', label: '侦察' });
      modes.push({ mode: 'raid', label: '掠夺' });
    }
    else if (kind === 'village' || kind === 'own_village') {
      const owner = refId ? await this.ownerOf(refId) : '';
      const mine = await this.ownerOf(villageId);
      // 当前操作村没有任何行军行为：不能向自己转移，也没有重复切换/增援。
      if (refId === villageId || (originTile && targetTile && originTile.q === targetTile.q && originTile.r === targetTile.r)) {
        relation = 'self';
      // 当前操作村不能向自己发送转移行军；只有其他己方村庄才显示转移。
      } else if (owner === mine) modes.push({ mode: 'transfer', label: '转移' });
      else {
        targetPlayerId = owner;
        const rel = await this.commands.send({ name: 'diplomacy.GetRelation', from: MovementModule.NAME, payload: { playerId: mine, targetPlayerId: owner } });
        relation = rel.ok ? (rel.payload as any).relation : 'neutral';
        if (relation === 'allied') modes.push({ mode: 'reinforce', label: '增援' });
        else if (relation === 'neutral') {
          modes.push({ mode: 'reinforce', label: '增援' });
          modes.push({ mode: 'scout', label: '侦察' });
          modes.push({ mode: 'raid', label: '掠夺并宣战', requiresDeclaration: true });
          modes.push({ mode: 'attack', label: '攻城并宣战', requiresDeclaration: true });
        } else {
          modes.push({ mode: 'scout', label: '侦察' });
          modes.push({ mode: 'raid', label: '掠夺' });
          modes.push({ mode: 'attack', label: '攻城' });
        }
      }
    } else if (kind === 'unexplored') modes.push({ mode: 'explore', label: '探索' });
    return {
      ok: true,
      payload: {
        q: targetQ,
        r: targetR,
        name: targetName,
        refId,
        relation: relation ?? 'neutral',
        targetPlayerId,
        modes,
        rallyPointLevel: await this.getRallyLevel(villageId),
        marchPoints: await this.marchPointState(villageId),
      },
    };
  }

  /** 最终确认页的权威预览：行军时长、可派兵快照、行军点与集结点等级。 */
  private async previewMarch(cmd: Command): Promise<CommandResult> {
    const { villageId, q, r, mode, troops, targetVillage } = cmd.payload as { villageId: string; q: number; r: number; mode: string; troops: Record<string, number>; targetVillage?: string };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const from = await this.villageXY(villageId);
    if (!from) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const target = targetVillage ? await this.villageXY(targetVillage) : wrapHex({ q, r }, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
    if (!target) return { ok: false, payload: {}, reason: 'target_not_found' };
    if (targetVillage && target.q === from.q && target.r === from.r) {
      return { ok: false, payload: {}, reason: 'same_village' };
    }
    const army = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId } });
    const availableTroops = army.ok ? ((army.payload as any).troops ?? {}) : {};
    const point = await this.marchPointState(villageId);
    let declarationRequired = false, relation = 'neutral';
    if (targetVillage && (mode === 'raid' || mode === 'attack')) {
      const mine = await this.ownerOf(villageId), other = await this.ownerOf(targetVillage);
      const rel = await this.commands.send({ name: 'diplomacy.GetRelation', from: MovementModule.NAME, payload: { playerId: mine, targetPlayerId: other } });
      relation = rel.ok ? (rel.payload as any).relation : 'neutral'; declarationRequired = relation === 'neutral';
    }
    return { ok: true, payload: { travelSec: await this.travelSec(villageId, from, target, valid.troops), availableTroops, selectedTroops: valid.troops, marchPoints: point, rallyPointLevel: await this.getRallyLevel(villageId), relation, declarationRequired } };
  }

  /** 向玩家村发起掠夺。与攻城共享战斗结算，但保留 raid 行军类型供地图/UI识别。 */
  private async sendVillageRaid(cmd: Command): Promise<CommandResult> {
    const { villageId, targetVillage, troops, treasures, declareWar } = cmd.payload as { villageId: string; targetVillage: string; troops: Record<string, number>; treasures?: string[]; declareWar?: boolean };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'cannot_attack_self' };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    const fromXY = await this.villageXY(villageId), toXY = await this.villageXY(targetVillage);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
    const exists = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId: targetVillage } });
    if (!exists.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    const relation = await this.validatePvPRelation(villageId, targetVillage, declareWar === undefined ? true : declareWar);
    if (!relation.ok) return relation;
    const point = await this.ensureMarchPoint(villageId); if (point) return point;
    const delta = Object.fromEntries(Object.entries(valid.troops).map(([u, n]) => [u, -n]));
    const adj = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adj.ok) return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) { await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } }); return { ok: false, payload: {}, reason: carry.reason }; }
    const mv = await this.launch({ id, type: 'raid', battleType: 'raid', fromVillage: villageId, fromXY, toXY, targetVillage, troops: valid.troops, treasures: carry.codes, departAt: this.now() });
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'raid', villageId, targetVillage, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  /**
   * 发起侦察：只接受三族侦察兵（equlegati/pathfinder/teuscout），不宣战、不拆建筑。
   * PvP 目标用 targetVillage；PvE 营地用 targetId。PvE 强制资源/守军报告，
   * 侦察战斗与 PvP 采用同一套「守方侦察兵反侦察」规则。
   */
  private async sendScout(cmd: Command): Promise<CommandResult> {
    const { villageId, targetVillage, targetId, troops, treasures, scoutType } = cmd.payload as {
      villageId: string; targetVillage?: string; targetId?: string; troops: Record<string, number>; treasures?: string[];
      scoutType?: 'scout_resources' | 'scout_buildings';
    };
    const isPve = !!targetId;
    if ((!targetVillage && !targetId) || (targetVillage === villageId)) return { ok: false, payload: {}, reason: 'not_enemy_village' };
    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };
    if (Object.keys(valid.troops).some((code) => !this.isScoutUnit(code))) {
      return { ok: false, payload: {}, reason: 'scout_units_only' };
    }
    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    let toXY: Hex | null | undefined;
    if (isPve) {
      const target = await this.commands.send({ name: 'pve.GetTarget', from: MovementModule.NAME, payload: { id: targetId } });
      if (!target.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
      const pve = target.payload as any;
      if (pve.ownerVillageId && pve.ownerVillageId !== villageId && !(pve.task === true && await this.samePlayerVillage(villageId, pve.ownerVillageId))) {
        return { ok: false, payload: {}, reason: 'not_task_owner' };
      }
      toXY = { q: Number(pve.q), r: Number(pve.r) };
    } else {
      toXY = await this.villageXY(targetVillage!);
      if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
      const fromOwner = await this.ownerOf(villageId), targetOwner = await this.ownerOf(targetVillage!);
      if (!fromOwner || !targetOwner || fromOwner === targetOwner) return { ok: false, payload: {}, reason: 'not_enemy_village' };
      const relation = await this.commands.send({ name: 'diplomacy.GetRelation', from: MovementModule.NAME, payload: { playerId: fromOwner, targetPlayerId: targetOwner } });
      if (relation.ok && (relation.payload as any)?.relation === 'allied') return { ok: false, payload: {}, reason: 'allied_target' };
      const exists = await this.commands.send({ name: 'military.GetArmy', from: MovementModule.NAME, payload: { villageId: targetVillage } });
      if (!exists.ok) return { ok: false, payload: {}, reason: 'target_not_found' };
    }
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;
    const delta = Object.fromEntries(Object.entries(valid.troops).map(([unit, n]) => [unit, -n]));
    const adjusted = await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta } });
    if (!adjusted.ok) return { ok: false, payload: {}, reason: adjusted.reason ?? 'no_troops' };
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      return { ok: false, payload: {}, reason: carry.reason };
    }
    const mv = await this.launch({
      id, type: 'scout', fromVillage: villageId, fromXY, toXY,
      ...(isPve ? { targetId } : { targetVillage }),
      // PvE 营地没有可侦察建筑，服务端强制降级为资源/守军报告。
      scoutType: !isPve && scoutType === 'scout_buildings' ? 'scout_buildings' : 'scout_resources',
      troops: valid.troops, treasures: carry.codes, departAt: this.now(),
    });
    this.save(mv);
    void this.bus.emit({ name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(), payload: { id: mv.id, type: 'scout', villageId, targetVillage, targetId, arriveAt: mv.arriveAt } } as DomainEvent);
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  private isScoutUnit(code: string): boolean {
    if (['equlegati', 'pathfinder', 'teuscout'].includes(code)) return true;
    const def = this.config.units[code];
    return !!def && /侦察|探路/.test(def.name) && (def.meleeAtk + def.rangedAtk) <= 0;
  }

  private async validatePvPRelation(villageId: string, targetVillage: string, declareWar: boolean): Promise<CommandResult> {
    const from = await this.ownerOf(villageId), target = await this.ownerOf(targetVillage);
    if (!from || !target || from === target) return { ok: false, payload: {}, reason: 'not_enemy_village' };
    const rel = await this.commands.send({ name: 'diplomacy.GetRelation', from: MovementModule.NAME, payload: { playerId: from, targetPlayerId: target } });
    const relation = rel.ok ? (rel.payload as any).relation : 'neutral';
    if (relation === 'allied') return { ok: false, payload: {}, reason: 'allied_target' };
    if (relation === 'neutral') {
      if (!declareWar) return { ok: false, payload: {}, reason: 'declare_war_required' };
      const war = await this.commands.send({ name: 'diplomacy.DeclareWar', from: MovementModule.NAME, payload: { playerId: from, targetPlayerId: target } });
      if (!war.ok) return { ok: false, payload: {}, reason: war.reason ?? 'declare_war_failed' };
    }
    return { ok: true, payload: { relation: relation === 'neutral' && declareWar ? 'hostile' : relation } };
  }

  /**
   * 村间运输：仅己方村；运力=Σ(carry×数量)；可见可截；到达部队留守、货物全额入库。
   */
  private async sendTransport(cmd: Command): Promise<CommandResult> {
    const { villageId, targetVillage, troops, cargo, treasures, mode } = cmd.payload as {
      villageId: string;
      targetVillage: string;
      troops: Record<string, number>;
      cargo?: Record<string, number>;
      treasures?: string[];
      mode?: 'transfer' | 'transport' | 'reinforce';
    };
    if (targetVillage === villageId) return { ok: false, payload: {}, reason: 'same_village' };

    const valid = this.validateTroops(troops);
    if (!valid.ok) return { ok: false, payload: {}, reason: valid.reason };

    const isTransfer = mode === 'transfer';
    const isReinforce = mode === 'reinforce';
    // 转移只允许己方村；增援允许盟军/中立村，不会改变关系。
    const fromOwner = await this.ownerOf(villageId);
    const toOwner = await this.ownerOf(targetVillage);
    if (!fromOwner || !toOwner || (!isReinforce && fromOwner !== toOwner)) {
      return { ok: false, payload: {}, reason: 'not_own_village' };
    }
    if (isReinforce && fromOwner !== toOwner) {
      const rel = await this.commands.send({ name: 'diplomacy.GetRelation', from: MovementModule.NAME, payload: { playerId: fromOwner, targetPlayerId: toOwner } });
      const relation = rel.ok ? (rel.payload as any).relation : 'neutral';
      if (relation === 'hostile') return { ok: false, payload: {}, reason: 'hostile_target' };
    }

    // 地图“转移”只允许携带部队和宝物；物资转运走贸易中心商队。
    if (isTransfer && Object.values(cargo ?? {}).some((v) => Number(v) > 0)) {
      return { ok: false, payload: {}, reason: 'transfer_no_cargo' };
    }
    const cleanedCargo: Record<string, number> = {};
    let cargoTotal = 0;
    for (const t of ['wood', 'clay', 'iron', 'crop'] as const) {
      const n = Math.max(0, Math.floor(cargo?.[t] ?? 0));
      if (n > 0) { cleanedCargo[t] = n; cargoTotal += n; }
    }
    if (!isReinforce && !isTransfer && cargoTotal <= 0) return { ok: false, payload: {}, reason: 'empty_cargo' };

    let capacity = 0;
    for (const [u, n] of Object.entries(valid.troops)) {
      capacity += (this.config.units[u]?.carry ?? 0) * n;
    }
    if (!isReinforce && !isTransfer && cargoTotal > capacity) return { ok: false, payload: {}, reason: 'cargo_exceeds_carry' };

    const fromXY = await this.villageXY(villageId);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;
    const toXY = await this.villageXY(targetVillage);
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
    if (toXY.q === fromXY.q && toXY.r === fromXY.r) return { ok: false, payload: {}, reason: 'same_village' };

    const spend: { ok: boolean; reason?: string } = isReinforce || isTransfer ? { ok: true } : await this.commands.send({
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
      if (!isTransfer) await this.commands.send({
        name: 'economy.Grant', from: MovementModule.NAME,
        payload: { villageId, gain: cleanedCargo },
      });
      return { ok: false, payload: {}, reason: adj.reason ?? 'no_troops' };
    }

    // 装宝物上运输军队（失败则退还兵力 + 货物）
    const id = this.nextId();
    const carry = await this.assignCarry(villageId, treasures, id, valid.troops);
    if (!carry.ok) {
      await this.commands.send({ name: 'military.AdjustTroops', from: MovementModule.NAME, payload: { villageId, delta: valid.troops } });
      if (!isTransfer) await this.commands.send({ name: 'economy.Grant', from: MovementModule.NAME, payload: { villageId, gain: cleanedCargo } });
      return { ok: false, payload: {}, reason: carry.reason };
    }

    const mv = await this.launch({
      id, type: 'transport', fromVillage: villageId, fromXY, toXY,
      targetVillage, troops: valid.troops, cargo: cleanedCargo, treasures: carry.codes, transportMode: mode ?? 'transport', departAt: this.now(),
    });

    log('出征(transport)', {
      id: mv.id, from: villageId, to: targetVillage, troops: valid.troops, cargo: cleanedCargo,
      arriveAt: new Date(mv.arriveAt).toISOString(),
    });
    void this.bus.emit({
      name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(),
      payload: {
        id: mv.id, type: 'transport', mode: mv.transportMode, villageId, targetVillage,
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

  /** 清洗商队货物：仅保留 wood/clay/iron/crop/gold 的正整数，返回清洁副本与总单位数。 */
  private cleanCargo(cargo: Record<string, number> | undefined): { clean: Record<string, number>; total: number } {
    const clean: Record<string, number> = {};
    let total = 0;
    for (const t of ['wood', 'clay', 'iron', 'crop', 'gold'] as const) {
      const n = Math.max(0, Math.floor(cargo?.[t] ?? 0));
      if (n > 0) { clean[t] = n; total += n; }
    }
    return { clean, total };
  }

  /**
   * 发起商队（贸易）：与 launch 同形，但无 troops、用独立的商人速度（tradeCaravanSpeed）。
   * homeVillage/routesFreed 透传给返程回收使用（由 trade 模块解释）。
   */
  private launchCaravan(opts: {
    id: string; fromVillage: string; fromXY: Hex; toXY: Hex; cargo: Record<string, number>;
    homeVillage: string; routesFreed: number; returning?: boolean; targetVillage?: string;
  }): MovementRecord {
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const path = linePathWrapped(opts.fromXY, opts.toXY, W, H);
    const steps = Math.max(1, path.length - 1);
    const mult = this.config.constants.tradeCaravanSpeed ?? 12;
    const dist = hexDistanceWrapped(opts.fromXY, opts.toXY, W, H);
    const totalMs = Math.max(3000, Math.round((dist / mult) * 3600)) * 1000;
    const perStepMs = Math.max(1, Math.round(totalMs / steps));
    const full: MovementRecord = {
      id: opts.id, type: 'caravan', fromVillage: opts.fromVillage, fromXY: opts.fromXY, toXY: opts.toXY,
      originalFromXY: opts.fromXY,
      targetVillage: opts.targetVillage, troops: {}, cargo: opts.cargo, departAt: this.now(),
      path, stepIndex: 0, pos: path[0], perStepMs, nextStepAt: this.now() + perStepMs,
      arriveAt: this.now() + perStepMs * steps, status: 'marching', stepToken: 1,
      homeVillage: opts.homeVillage, routesFreed: opts.routesFreed, returning: opts.returning ?? false,
    };
    this.save(full);
    this.scheduler.schedule(perStepMs, () => this.step(full.id, full.stepToken), `movement:${full.id}`, `movement:${full.id}`);
    return full;
  }

  /**
   * 发起商队（内部命令，不经网关暴露；由 trade 模块调用）。货物带走程，到达目标村交付，
   * 随后自动返程；返程到家时经 bus 发 `movement.CaravanReturned`（携带 homeVillage + routesFreed），
   * 由 trade 模块回收该村的贸易路线。
   */
  private async sendCaravan(cmd: Command): Promise<CommandResult> {
    const { fromVillage, targetVillage, cargo, homeVillage, routesFreed, returning } = cmd.payload as {
      fromVillage: string; targetVillage: string; cargo?: Record<string, number>;
      homeVillage?: string; routesFreed?: number; returning?: boolean;
    };
    if (targetVillage === fromVillage) return { ok: false, payload: {}, reason: 'same_village' };
    const cleaned = this.cleanCargo(cargo);
    if (cleaned.total <= 0) return { ok: false, payload: {}, reason: 'empty_cargo' };
    const fromXY = await this.villageXY(fromVillage);
    if (!fromXY) return { ok: false, payload: {}, reason: 'origin_not_found' };
    const toXY = await this.tileXY(targetVillage);
    if (!toXY) return { ok: false, payload: {}, reason: 'target_not_found' };
    const mv = this.launchCaravan({
      id: this.nextId(), fromVillage, fromXY, toXY, cargo: cleaned.clean,
      homeVillage: homeVillage ?? fromVillage, routesFreed: Number(routesFreed) || 0, returning: !!returning, targetVillage,
    });
    log('出征(caravan)', { id: mv.id, from: fromVillage, to: targetVillage, cargo: cleaned.clean, returning: !!returning });
    return { ok: true, payload: { id: mv.id, arriveAt: mv.arriveAt, travelSec: Math.round((mv.arriveAt - mv.departAt) / 1000) } };
  }

  private async sendReinforce(cmd: Command): Promise<CommandResult> {
    return this.sendTransport({ ...cmd, payload: { ...(cmd.payload as any), mode: 'reinforce', cargo: {} } });
  }

  /** 商队到达：去程→把货物交给目标村（目标村不存在则跳过交付）后启动返程；返程→到家回收贸易路线。 */
  private async arriveCaravan(mv: MovementRecord): Promise<void> {
    if (mv.returning) {
      // 货物随商队返回发货村（目标丢失中途折返时仍携带原货物，须完整归还，不凭空消失）
      if (mv.cargo && Object.keys(mv.cargo).length > 0) {
        const home = mv.homeVillage ?? mv.fromVillage;
        await this.commands.send({
          name: 'economy.Grant', from: MovementModule.NAME,
          payload: { villageId: home, gain: mv.cargo },
        });
      }
      if (mv.routesFreed && mv.homeVillage) {
        void this.bus.emit({
          name: 'movement.CaravanReturned', source: MovementModule.NAME, ts: this.now(),
          payload: { villageId: mv.homeVillage, routesFreed: mv.routesFreed },
        } as DomainEvent);
      }
      this.remove(mv.id);
      return;
    }
    // 去程：把货物交给目标村；目标不是玩家村庄（如幸福村这类 NPC 村庄）则发到达事件由任务模块处理
    if (mv.cargo && Object.keys(mv.cargo).length > 0) {
      const tgt = await this.commands.send({
        name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId: mv.targetVillage },
      });
      if (tgt.ok) {
        await this.commands.send({
          name: 'economy.Grant', from: MovementModule.NAME,
          payload: { villageId: mv.targetVillage, gain: mv.cargo },
        });
      } else {
        // 目标非玩家村庄：可能是 NPC 村庄（幸福村），由 tasks 模块据此推进 deliver_to_npc 目标
        const tile = await this.commands.send({
          name: 'world.GetTileByRef', from: MovementModule.NAME, payload: { refId: mv.targetVillage },
        });
        const kind = (tile.payload as any)?.tile?.kind;
        if (tile.ok && (kind === 'pve' || kind === 'taskcamp')) {
          void this.bus.emit({
            name: 'movement.CaravanArrivedNpc', source: MovementModule.NAME, ts: this.now(),
            payload: { villageId: mv.fromVillage, npcId: mv.targetVillage, cargo: mv.cargo, toXY: mv.toXY },
          } as DomainEvent);
        }
      }
    }
    const home = mv.homeVillage ?? mv.fromVillage;
    const homeXY = await this.villageXY(home);
    if (!homeXY) { this.remove(mv.id); return; }
    this.launchCaravan({
      id: this.nextId(), fromVillage: home, fromXY: mv.toXY, toXY: homeXY, cargo: {},
      homeVillage: home, routesFreed: mv.routesFreed ?? 0, returning: true, targetVillage: home,
    });
    this.remove(mv.id);
  }

  /** 运输到达：货物入库（可超额）+ 部队并入目标村。 */
  private async arriveTransport(mv: MovementRecord): Promise<void> {
    const target = mv.targetVillage;
    if (!target) {
      this.remove(mv.id);
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
    // 携带宝物抵达「另一个村庄」→ 转为该村庄玩家的待处理报告（deliver）
    if (mv.treasures && mv.treasures.length > 0) {
      const sourceTile = await this.commands.send({
        name: 'world.GetTileByRef', from: MovementModule.NAME,
        payload: { refId: mv.fromVillage, kind: 'village' },
      });
      const sourceVillageName = (sourceTile.payload as any)?.tile?.name ?? mv.fromVillage;
      await this.commands.send({
        name: 'treasure.OffloadForeign', from: MovementModule.NAME,
        payload: { villageId: target, codes: mv.treasures, fromMovementId: mv.id, fromVillageId: mv.fromVillage, fromVillageName: sourceVillageName },
      });
    }
    log('运输到达', { id: mv.id, to: target, troops: mv.troops, cargo: mv.cargo });
    this.remove(mv.id);
    this.updateEnRoutePop(mv.fromVillage);
    void this.bus.emit({
      name: 'movement.Returned', source: MovementModule.NAME, ts: this.now(),
      payload: {
        villageId: target,
        fromVillage: mv.fromVillage,
        troops: mv.troops,
        loot: mv.cargo,
        type: 'transport',
        mode: mv.transportMode,
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
    // 环面世界：任意坐标合法（归一进 [0,W)×[0,H)）；仅拦截明显越界防误传巨值。
    if (Math.abs(q) > 1000 || Math.abs(r) > 1000) {
      return { ok: false, payload: {}, reason: 'out_of_map' };
    }
    const toXY: Hex = wrapHex({ q, r }, c.worldW ?? 41, c.worldH ?? 41);

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
    for (const m of this.store.all<MovementRecord>(COLLECTION)) {
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

    // 落点预检
    const site = await this.validateFoundSite(toXY, c.foundMinTileDistance);
    if (!site.ok) return { ok: false, payload: {}, reason: site.reason };
    const point = await this.ensureMarchPoint(villageId);
    if (point) return point;

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

    const mv = await this.launch({
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
      // 拓荒者是唯一每兵占用 5 人口且代码含 settler 的单位；不再依赖永久人口标记。
      if (def.tribe === tribe && def.popCost === 5 && code.toLowerCase().includes('settler')) return code;
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

  /** 拓荒到达：合法则建村；否则拓荒者返程并按普通兵种返还人口。 */
  private async arriveFound(mv: MovementRecord): Promise<void> {
    const c = this.config.constants;
    const site = await this.validateFoundSite(mv.toXY, c.foundMinTileDistance);
    const playerId = mv.founderPlayerId;
    if (!site.ok || !playerId) {
      log('拓荒失败返程', { id: mv.id, reason: site.ok ? 'no_player' : site.reason });
      this.remove(mv.id);
      this.updateEnRoutePop(mv.fromVillage);
      await this.scheduleReturn(mv.fromVillage, mv.toXY, mv.fromXY, mv.troops, {});
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
    this.remove(mv.id);
    this.updateEnRoutePop(mv.fromVillage);

    if (!created.ok) {
      log('拓荒建村失败返程', { id: mv.id, reason: created.reason });
      await this.scheduleReturn(mv.fromVillage, mv.toXY, mv.fromXY, mv.troops, {});
      return;
    }

    const newVillageId = (created.payload as any).villageId as string;
    log('拓荒建村成功', { id: mv.id, newVillageId, at: mv.toXY });
    // 成功建村后，出发城失去随军的 5 人口；新城由 PlayerModule 以 5 人口初始化。
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
    if (mv.stepIndex < mv.path.length) mv.pos = mv.path[mv.stepIndex];
    mv.nextStepAt = this.now() + mv.perStepMs;
    this.save(mv);
    await this.revealVision(mv);
    await this.maybeAlertIncoming(mv);
    // 增量推送：己方行军步进
    void this.bus.emit({
      name: 'movement.Stepped', source: MovementModule.NAME, ts: this.now(),
      payload: {
        villageId: mv.fromVillage,
        id: mv.id, pos: mv.pos, stepIndex: mv.stepIndex,
        nextStepAt: mv.nextStepAt, perStepMs: mv.perStepMs,
        status: mv.status, arriveAt: mv.arriveAt,
      },
    } as DomainEvent);
    // 增量推送：他国军队步进（发给视野内的所有玩家）
    void this.emitForeignStep(mv);

    // 伏击检测：只有已经抵达并驻扎的伏击军，才能在一格内拦截敌方行军。
    if (mv.type !== 'return' && mv.type !== 'caravan') {
      const ambush = await this.findAmbush(mv);
      if (ambush) {
        await this.resolveAmbushEncounter(ambush, mv);
        return;
      }
    }

    // 相遇检测（仅两支出征军相遇即战；返程军/商队脱战免疫）
    if (mv.type !== 'return' && mv.type !== 'caravan') {
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

  /** 外军增量步进推送：找出能看到此格的玩家（城市视野），对每人推送 ForeignArmyStep。 */
  private async emitForeignStep(mv: MovementRecord): Promise<void> {
    const ownerRes = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId: mv.fromVillage } });
    const p = ownerRes.ok ? (ownerRes.payload as any)?.player : undefined;
    const v = (p?.villages ?? []).find((x: any) => x.id === mv.fromVillage);
    const owner = { playerId: p?.id as string | undefined, name: p?.name as string | undefined, villageName: (v?.name ?? mv.fromVillage) as string };
    const ownerPlayerId = owner.playerId;
    const obsRes = await this.commands.send({ name: 'vision.GetObservers', from: MovementModule.NAME, payload: { q: mv.pos.q, r: mv.pos.r } });
    const playerIds: string[] = (obsRes.payload as any)?.playerIds ?? [];
    const observers = playerIds.filter((pid) => pid !== ownerPlayerId);
    if (observers.length === 0) return;
    void this.bus.emit({
      name: 'movement.ForeignStepped', source: MovementModule.NAME, ts: this.now(),
      payload: {
        playerIds: observers,
        army: this.toForeignArmy(mv, owner),
      },
    } as DomainEvent);
  }

  /** 来袭告警：部队进入守方视野时推送一次 IncomingAttack。 */
  private async maybeAlertIncoming(mv: MovementRecord): Promise<void> {
    if (mv.type !== 'attack' || mv.alertedTarget || !mv.targetVillage) return;
    const owner = await this.commands.send({
      name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId: mv.targetVillage },
    });
    const defenderPlayerId = owner.ok ? (owner.payload as any)?.player?.id as string | undefined : undefined;
    if (!defenderPlayerId) return;
    const vis = await this.commands.send({
      name: 'vision.GetVisibility', from: MovementModule.NAME,
      payload: { playerId: defenderPlayerId, q: mv.pos.q, r: mv.pos.r },
    });
    if (!vis.ok || (vis.payload as any).visibility !== 'visible') return;
    mv.alertedTarget = true;
    this.save(mv);
    void this.bus.emit({
      name: 'movement.IncomingAttack', source: MovementModule.NAME, ts: this.now(),
      payload: {
        villageId: mv.targetVillage, fromVillage: mv.fromVillage, arriveAt: mv.arriveAt,
        at: { q: mv.pos.q, r: mv.pos.r },
      },
    } as DomainEvent);
  }

  /** 到达终点：按类型分派（出征→交给 Combat；返程→归队入库；拓荒→建村；运输→留守入库；商队→交付/回收）。 */
  private async arrive(mv: MovementRecord): Promise<void> {
    if (mv.type === 'caravan') { await this.arriveCaravan(mv); return; }
    if (mv.type === 'return') { await this.arriveReturn(mv.id); return; }
    if (mv.type === 'found') { await this.arriveFound(mv); return; }
    if (mv.type === 'transport') { await this.arriveTransport(mv); return; }
    if (mv.type === 'garrison' || mv.type === 'ambush') { await this.arriveGarrison(mv); return; }
    if (mv.type === 'explore') { await this.arriveExplore(mv); return; }
    if (mv.type === 'scout' && (mv.targetVillage || mv.targetId)) { await this.arriveScout(mv); return; }
    if (mv.type === 'raid' && mv.targetId) { await this.arriveEngage(mv, 'pve', mv.targetId); return; }
    if (mv.type === 'raid' && mv.targetVillage) { await this.arriveEngage(mv, 'village', mv.targetVillage); return; }
    if (mv.type === 'attack' && mv.targetVillage) {
      await this.arriveEngage(mv, 'village', mv.targetVillage);
      return;
    }
  }

  /** 出征到达：把兵力快照交给 Combat 开/并入战场，并保留为暂停的在途记录。
   *
   * 人口模块把驻军和在途士兵共同计入总人口。若这里立即删除去程，战斗尚未结束的士兵会
   * 暂时从两个池子同时消失；人口在该窗口结算时会误以为住房腾出，导致返程后总人口凭空增加。
   * 保留 paused movement 直到 BattleEnded，再替换为返程或移除，保证士兵足迹始终连续。
   */
  private async arriveEngage(mv: MovementRecord, targetKind: 'village' | 'pve', targetId: string): Promise<void> {
    // 必须转发 mv.treasures：Combat 只有拿到携带宝物清单，才能在 BattleEnded 中回传 treasures，
    // 进而 onBattleEnded 在全灭时调用 treasure.LoseCarried 把宝物转交防守方（否则携带记录被孤立→宝物凭空消失）。
    const carried = mv.treasures && mv.treasures.length > 0 ? mv.treasures : [];
    await this.commands.send({
      name: 'combat.Engage', from: MovementModule.NAME,
      payload: {
        targetKind, targetId, targetXY: mv.toXY,
        battleType: mv.battleType,
        movementId: mv.id, fromVillage: mv.fromVillage, fromXY: mv.fromXY,
        originalFromXY: mv.originalFromXY ?? mv.fromXY,
        troops: mv.troops, attackerSnapshot: await this.attackerSnapshot(mv),
        treasures: carried,
      },
    });
    mv.status = 'paused';
    mv.stepToken += 1;
    this.save(mv);
  }

  /** 侦察抵达：读取守方快照，发出一次性侦察战报，然后让幸存侦察兵原路返城。 */
  private async arriveScout(mv: MovementRecord): Promise<void> {
    const targetVillage = mv.targetVillage;
    const targetId = mv.targetId;
    const isPve = !!targetId && !targetVillage;
    const reportTarget = targetVillage ?? targetId;
    if (!reportTarget) return;
    const armyRes = isPve
      ? await this.commands.send({ name: 'pve.GetDefenderSnapshot', from: MovementModule.NAME, payload: { id: targetId } })
      : await this.commands.send({ name: 'military.GetCombatSnapshot', from: MovementModule.NAME, payload: { villageId: targetVillage, purpose: 'raid' } });
    if (!armyRes.ok) {
      // 目标可能在最后一格与移除事件竞争；沿用目标消失规则从当前位置返程。
      await this.startReturn(mv);
      return;
    }
    const defenderSnapshot = ((armyRes.payload as any)?.snapshot ?? {}) as Snapshot;
    const defenderScouts = Object.entries(defenderSnapshot)
      .filter(([code]) => this.isScoutUnit(code))
      .reduce((sum, [, unit]) => sum + Math.max(0, Number(unit.count) || 0), 0);
    const attackerTotal = Object.values(mv.troops).reduce((sum, n) => sum + Math.max(0, Math.floor(n)), 0);
    // 侦察兵互相反侦察：守方每名侦察兵消灭一名来袭侦察兵；无守方侦察兵则无人伤亡。
    const losses = Math.min(attackerTotal, defenderScouts);
    const survivors = this.allocateScoutSurvivors(mv.troops, losses);
    const scoutType = mv.scoutType ?? 'scout_resources';
    const report: Record<string, unknown> = {
      scoutType,
      ...(targetVillage ? { targetVillage } : { targetId }),
      targetKind: isPve ? 'pve' : 'village',
      defenderTroops: Object.fromEntries(Object.entries(defenderSnapshot).map(([code, unit]) => [code, unit.count])),
    };
    if (!isPve && scoutType === 'scout_buildings') {
      const layout = await this.commands.send({ name: 'building.GetLayout', from: MovementModule.NAME, payload: { villageId: targetVillage } });
      const data = (layout.payload as any) ?? {};
      const normalize = (zone: string) => ((data.zones?.[zone]?.placed ?? []) as any[]).map((b) => ({
        kind: b.kind, name: b.name ?? b.kind, level: Number(b.level) || 0,
      }));
      report.buildings = { center: data.townCenter ? [{ kind: data.townCenter.kind, name: data.townCenter.name, level: data.townCenter.level }] : [], inner: normalize('inner'), outer: normalize('outer') };
    } else {
      if (isPve) report.resources = (armyRes.payload as any)?.loot ?? {};
      else {
        const resources = await this.commands.send({ name: 'economy.GetResources', from: MovementModule.NAME, payload: { villageId: targetVillage } });
        report.resources = (resources.payload as any)?.resources ?? {};
      }
    }
    this.remove(mv.id);
    this.updateEnRoutePop(mv.fromVillage);
    const treasures = mv.treasures ?? [];
    if (Object.keys(survivors).length === 0) {
      if (treasures.length > 0) {
        await this.commands.send({ name: 'treasure.LoseCarried', from: MovementModule.NAME, payload: { movementId: mv.id, mode: isPve ? 'pve' : 'pvp', defenderVillage: targetVillage } });
      }
      // 进攻方没有幸存者，不收到报告；守方仅在确实击落侦察兵时收到一份报告。
      if (losses > 0 && targetVillage) this.emitScoutReport(targetVillage, 'defender', report, losses, attackerTotal);
      return;
    }
    // 侦察成功时向双方（守方仅在有损失时）推送同一份快照；宝物随幸存者返程。
    this.emitScoutReport(mv.fromVillage, 'attacker', report, losses, attackerTotal);
    if (losses > 0 && targetVillage) this.emitScoutReport(targetVillage, 'defender', report, losses, attackerTotal);
    const returnId = await this.scheduleReturn(mv.fromVillage, mv.toXY, mv.originalFromXY ?? mv.fromXY, survivors, {}, treasures, mv.id, mv.originalFromXY ?? mv.fromXY);
    const returnMv = returnId ? this.load(returnId) : undefined;
    if (returnMv) {
      void this.commands.send({ name: 'treasure.SetExpectedArrival', from: MovementModule.NAME, payload: { movementId: mv.id, expectedArrivalAt: returnMv.arriveAt } });
    }
  }

  private allocateScoutSurvivors(troops: Record<string, number>, losses: number): Record<string, number> {
    const out: Record<string, number> = {};
    let remaining = Math.max(0, losses);
    for (const [code, raw] of Object.entries(troops)) {
      const count = Math.max(0, Math.floor(raw));
      const dead = Math.min(count, remaining);
      const alive = count - dead;
      if (alive > 0) out[code] = alive;
      remaining -= dead;
    }
    return out;
  }

  private emitScoutReport(villageId: string, side: 'attacker' | 'defender', report: Record<string, unknown>, losses: number, deployed: number): void {
    void this.bus.emit({
      name: 'movement.ScoutReport', source: MovementModule.NAME, ts: this.now(),
      payload: { villageId, side, scoutType: report.scoutType, targetKind: report.targetKind, targetId: report.targetId, targetVillage: report.targetVillage, buildings: report.buildings, resources: report.resources, defenderTroops: report.defenderTroops, attackerLosses: side === 'attacker' ? losses : undefined, deployedTroops: deployed, detected: side === 'defender' },
    } as DomainEvent);
  }

  /**
   * 进攻方参战快照：优先向源村 Military 取"含铁匠养成加成的最终数值"（派生管线对外口径，
   * 与防守方 GetCombatSnapshot 同源 → 攻守对称）。源村不可用时回退到 CSV 原始数值。
   * 修复：此前直接用 buildSnapshot 导致铁匠加成只作用于防守、进攻无效。
   */
  private async attackerSnapshot(mv: MovementRecord): Promise<Snapshot> {
    const res = await this.commands.send({
      name: 'military.GetCombatSnapshot', from: MovementModule.NAME,
      payload: { villageId: mv.fromVillage, units: mv.troops },
    });
    const snap = (res.ok ? (res.payload as { snapshot?: Snapshot }).snapshot : undefined);
    const base = (snap && Object.keys(snap).length > 0) ? snap : this.buildSnapshot(mv.troops); // 回退：源村已消失等异常，用原始数值保证出征仍能结算
    // 叠加该军队携带宝物的效果（城镇在途时失去加成，军队获得加成）
    if (mv.treasures && mv.treasures.length > 0) {
      const effRes = await this.commands.send({
        name: 'treasure.GetCarriedEffects', from: MovementModule.NAME,
        payload: { movementId: mv.id },
      });
      const eff = (effRes.ok ? (effRes.payload as any)?.effects : undefined) as { atkMult?: number; defMult?: number } | undefined;
      if (eff && (eff.atkMult !== 1 || eff.defMult !== 1)) {
        const atk = eff.atkMult ?? 1, def = eff.defMult ?? 1;
        for (const u of Object.values(base)) {
          u.meleeAtk *= atk; u.rangedAtk *= atk;
          u.meleeDef *= def; u.rangedDef *= def;
        }
      }
    }
    return base;
  }

  /**
   * 找出与 mv 同格相遇的**敌对出征军**：另一支 marching 的 raid/attack，pos 相同，且属于不同玩家。
   * 返回对手 movement 或 undefined。
   */
  private async findEncounter(mv: MovementRecord): Promise<MovementRecord | undefined> {
    const myOwner = await this.ownerOf(mv.fromVillage);
    const ids = this.posIndex.get(this.posKey(mv.pos.q, mv.pos.r));
    if (!ids) return undefined;
    for (const oid of ids) {
      const other = this.load(oid);
      if (!other || other.id === mv.id) continue;
      if (other.type === 'return' || other.type === 'caravan' || other.status !== 'marching') continue;
      const otherOwner = await this.ownerOf(other.fromVillage);
      if (otherOwner && myOwner && otherOwner === myOwner) continue;
      return other;
    }
    return undefined;
  }

  /** 找出一格内的敌方驻扎伏击军；行军中的伏击军不参与此检测。 */
  private async findAmbush(mv: MovementRecord): Promise<MovementRecord | undefined> {
    if (mv.status !== 'marching' || mv.type === 'return' || mv.type === 'caravan' || mv.type === 'ambush') return undefined;
    const myOwner = await this.ownerOf(mv.fromVillage);
    for (const other of this.store.all<MovementRecord>(COLLECTION)) {
      if (other.id === mv.id || other.type !== 'ambush' || other.status !== 'stationed') continue;
      if (await this.ownerOf(other.fromVillage) === myOwner) continue;
      if (hexDistanceWrapped(other.pos, mv.pos, this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41) <= 1) return other;
    }
    return undefined;
  }

  /** 村庄归属玩家 id（找不到返回村庄 id 本身，保证不同村=不同归属的保守判定）。 */
  private async ownerOf(villageId: string): Promise<string> {
    const res = await this.commands.send({ name: 'player.GetByVillage', from: MovementModule.NAME, payload: { villageId } });
    return res.ok ? ((res.payload as any).player?.id ?? villageId) : villageId;
  }

  /** 两座村庄是否属于同一玩家；用于跨村攻击该玩家自己的任务营地。 */
  private async samePlayerVillage(leftVillageId: string, rightVillageId: string): Promise<boolean> {
    if (!leftVillageId || !rightVillageId) return false;
    if (leftVillageId === rightVillageId) return true;
    const [left, right] = await Promise.all([this.ownerOf(leftVillageId), this.ownerOf(rightVillageId)]);
    return left === right;
  }

  /** 途中相遇：双方暂停 → combat.Engage(field) 逐 tick 结算 → BattleEnded 后 onBattleEnded 恢复行军。 */
  private async resolveFieldEncounter(a: MovementRecord, b: MovementRecord): Promise<void> {
    // 双方就地暂停
    a.status = 'paused'; a.stepToken += 1;
    b.status = 'paused'; b.stepToken += 1;
    this.save(a);
    this.save(b);

    // 通知双方"遭遇开始"
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: a.fromVillage, at: a.pos, opponentVillage: b.fromVillage } } as DomainEvent);
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: b.fromVillage, at: b.pos, opponentVillage: a.fromVillage } } as DomainEvent);

    // a 作为 attacker, b 作为 defenderField，发起野战
    const aSnap = await this.attackerSnapshot(a);
    const bSnap = await this.attackerSnapshot(b);
    const aCarried = (a.treasures ?? []).filter((t) => t);
    const bCarried = (b.treasures ?? []).filter((t) => t);
    await this.commands.send({
      name: 'combat.Engage',
      from: MovementModule.NAME,
      payload: {
        targetKind: 'field',
        targetId: b.id,       // 防守方行军 id（用于唯一标识战场）
        targetXY: a.pos,      // 相遇格
        movementId: a.id,
        fromVillage: a.fromVillage,
        fromXY: a.fromXY,
        originalFromXY: a.originalFromXY ?? a.fromXY,
        troops: a.troops,
        attackerSnapshot: aSnap,
        treasures: aCarried,
        defenderField: {
          movementId: b.id,
          fromVillage: b.fromVillage,
          fromXY: b.fromXY,
          originalFromXY: b.originalFromXY ?? b.fromXY,
          troops: b.troops,
          attackerSnapshot: bSnap,
          treasures: bCarried,
        },
      },
    });
  }

  /** 伏击战：伏击方作为 attacker，路过军队作为 defenderField；战斗结束后双方都回到出发城。 */
  private async resolveAmbushEncounter(ambush: MovementRecord, target: MovementRecord): Promise<void> {
    ambush.status = 'paused'; ambush.stepToken += 1;
    target.status = 'paused'; target.stepToken += 1;
    this.save(ambush);
    this.save(target);
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: ambush.fromVillage, at: ambush.pos, opponentVillage: target.fromVillage, battleType: 'ambush' } } as DomainEvent);
    void this.bus.emit({ name: 'movement.Intercepted', source: MovementModule.NAME, ts: this.now(), payload: { villageId: target.fromVillage, at: target.pos, opponentVillage: ambush.fromVillage, battleType: 'ambush' } } as DomainEvent);
    const aSnap = await this.attackerSnapshot(ambush);
    const bSnap = await this.attackerSnapshot(target);
    await this.commands.send({
      name: 'combat.Engage', from: MovementModule.NAME,
      payload: {
        targetKind: 'field', battleType: 'ambush', targetId: `ambush:${ambush.id}:${target.id}`, targetXY: target.pos,
        movementId: ambush.id, fromVillage: ambush.fromVillage, fromXY: ambush.fromXY,
        originalFromXY: ambush.originalFromXY ?? ambush.fromXY, troops: ambush.troops,
        attackerSnapshot: aSnap, treasures: ambush.treasures ?? [],
        defenderField: {
          movementId: target.id, fromVillage: target.fromVillage, fromXY: target.fromXY,
          originalFromXY: target.originalFromXY ?? target.fromXY, troops: target.troops,
          attackerSnapshot: bSnap, treasures: target.treasures ?? [],
        },
      },
    });
  }

  /** 战斗结束事件：为幸存者安排带战利品返程；全歼时按 pve/pvp 处理携带宝物。field 侧：幸存者继续行军。 */
  private async onBattleEnded(e: DomainEvent): Promise<void> {
    const p = e.payload as {
      side: string; fromVillage: string; fromXY: Hex; toXY: Hex;
      survivors?: Record<string, number>; loot?: Record<string, number>;
      treasures?: string[]; targetKind?: string; targetId?: string; battleType?: string; movementId: string;
      originalFromXY?: Hex;
    };

    // 野战（field）分支：普通相遇战幸存者继续原路线；伏击战双方幸存者都原路返城。
    if (p.targetKind === 'field') {
      const mv = this.load(p.movementId);
      if (!mv) return;
      const survivors = p.survivors ?? {};
      if (Object.keys(survivors).length === 0) {
        // 全灭：宝物回收到系统池（野战视为 pve 式灭失）
        const treasures = p.treasures ?? [];
        if (treasures.length > 0) {
          void this.commands.send({
            name: 'treasure.LoseCarried', from: MovementModule.NAME,
            payload: { movementId: p.movementId, mode: 'pve' },
          });
        }
        this.remove(p.movementId);
        this.updateEnRoutePop(p.fromVillage);
        return;
      }
      if (p.battleType === 'ambush') {
        mv.troops = survivors;
        this.remove(mv.id);
        this.updateEnRoutePop(mv.fromVillage);
        await this.scheduleReturn(mv.fromVillage, p.toXY, p.originalFromXY ?? p.fromXY, survivors, {}, p.treasures, p.movementId, p.originalFromXY ?? p.fromXY);
        return;
      }
      // 幸存者：更新兵力、解除暂停、恢复行军
      mv.troops = survivors;
      mv.status = 'marching';
      mv.stepToken += 1;
      mv.nextStepAt = this.now() + mv.perStepMs;
      this.save(mv);
      this.updateEnRoutePop(mv.fromVillage);
      if (mv.stepIndex >= mv.path.length - 1) void this.arrive(mv);
      else this.scheduler.schedule(mv.perStepMs, () => this.step(mv.id, mv.stepToken), `movement:${mv.id}`, `movement:${mv.id}`);
      return;
    }

    if (p.side !== 'attacker') return;
    const treasures = p.treasures ?? [];
    const survivors = p.survivors ?? {};
    if (Object.keys(survivors).length === 0) {
      // 全歼：携带宝物按 pve(回收到系统池) / pvp(转交防守方村庄) 处理
      if (treasures.length > 0) {
        const mode = p.targetKind === 'pve' ? 'pve' : 'pvp';
        void this.commands.send({
          name: 'treasure.LoseCarried', from: MovementModule.NAME,
          payload: { movementId: p.movementId, mode, defenderVillage: p.targetId },
        });
      }
      // 战死部队至此才从在途人口池移除；此前战斗期间始终保留其足迹。
      this.remove(p.movementId);
      this.updateEnRoutePop(p.fromVillage);
      return; // 全灭无返程
    }
    // 先移除战斗中的去程，再建立返程；launch() 会基于最终 movement 集合重算在途人口，
    // 避免同一批幸存者在去程和返程中被短暂重复计数。
    this.remove(p.movementId);
    const returnId = await this.scheduleReturn(
      p.fromVillage, p.toXY, p.originalFromXY ?? p.fromXY,
      survivors, p.loot ?? {}, treasures, p.movementId, p.originalFromXY ?? p.fromXY,
    );
    // 精化 camp pending 的预计归村时间为返程 movement 的真实 arriveAt（覆盖 rollDrop 的 60s 占位），
    // 让客户端「还有多久抵达」倒计时精确。pending 按出征 id 索引，故用 p.movementId（非 returnId）。
    const returnMv = returnId ? this.load(returnId) : undefined;
    if (returnMv && typeof returnMv.arriveAt === 'number') {
      void this.commands.send({
        name: 'treasure.SetExpectedArrival', from: MovementModule.NAME,
        payload: { movementId: p.movementId, expectedArrivalAt: returnMv.arriveAt },
      });
    }
  }

  private async scheduleReturn(
    fromVillage: string,
    fromXY: Hex,
    toXY: Hex,
    troops: Record<string, number>,
    loot: Record<string, number>,
    treasures?: string[],
    outwardId?: string,
    originalFromXY?: Hex,
  ): Promise<string | undefined> {
    const id = this.nextId();
    await this.launch({
      id, type: 'return', fromVillage, fromXY, toXY,
      originalFromXY: originalFromXY ?? toXY,
      troops, loot, treasures, departAt: this.now(), outwardId,
    });
    return id;
  }

  /** PvE 目标被移除（营地/NPC 幸福村）：所有前往该目标的出征(raid)或商队(caravan→NPC)立即原路返回。 */
  private async onTargetRemoved(e: DomainEvent): Promise<void> {
    const { id } = e.payload as { id: string };
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      if (mv.status !== 'marching') continue;
      if (mv.type === 'return' || (mv.type === 'caravan' && mv.returning)) continue; // 已在返程，避免重复触发
      // 出征按 targetId 匹配；商队送 NPC 村按 targetVillage(=pve id) 匹配
      if (mv.targetId !== id && mv.targetVillage !== id) continue;
      if (mv.type !== 'raid' && mv.type !== 'attack' && mv.type !== 'scout' && mv.type !== 'caravan' && mv.type !== 'transport') continue;
      await this.startReturn(mv);
    }
  }

  /** 玩家村庄被放弃/消失：所有前往该村庄的进攻(attack)/运输(transport)/商队(caravan)立即原路返回。 */
  private async onVillageRemoved(e: DomainEvent): Promise<void> {
    const { villageId } = e.payload as { villageId: string };
    for (const mv of this.store.all<MovementRecord>(COLLECTION)) {
      if (mv.status !== 'marching') continue;
      if (mv.type === 'return' || (mv.type === 'caravan' && mv.returning)) continue; // 已在返程，避免重复触发
      if (mv.targetVillage !== villageId) continue;
      if (mv.type !== 'attack' && mv.type !== 'raid' && mv.type !== 'scout' && mv.type !== 'caravan' && mv.type !== 'transport') continue;
      await this.startReturn(mv);
    }
  }

  /**
   * 目标消失·原地转为返程：从当前所在格原路返回出发村，保留兵力/战利品/宝物/货物。
   * 原地改写同一条 movement（保留 id，确保携带宝物 pending 与 outwardId 链路不丢），仅翻转类型并重算路径。
   * 商队保留 caravan 类型并置 returning=true，以便到家时释放贸易路线；其余转为 return 类型。
   */
  private async startReturn(mv: MovementRecord): Promise<void> {
    const home = mv.originalFromXY ?? mv.fromXY;
    if (!mv.abandonedToXY) mv.abandonedToXY = mv.toXY;
    const cur = mv.pos;
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    const path = linePathWrapped(cur, home, W, H);
    const steps = Math.max(1, path.length - 1);
    let totalMs: number;
    // 行军列表中的当前位置可能仍处于当前两格之间：服务端 pos 是已抵达的格子，
    // nextStepAt/perStepMs 则保留了这一格的真实进度。撤回应从这个进度点返程，
    // 不能把整条原路线当成尚未出发。若路径被外部测试/旧档改写，则回退到坐标距离。
    const routeProgressMs = this.outboundReturnMs(mv);
    if (mv.type === 'caravan') {
      const dist = hexDistanceWrapped(cur, home, W, H);
      const mult = this.config.constants.tradeCaravanSpeed ?? 12;
      totalMs = routeProgressMs ?? (Math.max(3000, Math.round((dist / mult) * 3600)) * 1000);
    } else {
      totalMs = routeProgressMs ?? (await this.travelSec(mv.fromVillage, cur, home, mv.troops) * 1000);
    }
    const perStepMs = Math.max(1, Math.round(totalMs / steps));

    const wasCaravan = mv.type === 'caravan';
    mv.type = wasCaravan ? 'caravan' : 'return';
    mv.fromXY = cur;
    mv.toXY = home;
    mv.path = path;
    mv.stepIndex = 0;
    mv.pos = cur;
    mv.status = 'marching';
    mv.stepToken += 1; // 作废旧的逐格推进定时（step 回调校验 token 后自动忽略）
    mv.departAt = this.now();
    mv.nextStepAt = this.now() + perStepMs;
    mv.arriveAt = this.now() + perStepMs * steps;
    mv.perStepMs = perStepMs;
    mv.targetId = undefined;
    if (!wasCaravan) mv.targetVillage = undefined; // 商队保留 targetVillage 仅作展示，不影响回家逻辑
    if (wasCaravan) mv.returning = true; // 到家即回收贸易路线 + 退还货物
    this.save(mv);
    this.scheduler.schedule(perStepMs, () => this.step(mv.id, mv.stepToken), `movement:${mv.id}`, `movement:${mv.id}`);
    log('目标消失·原路返回', { id: mv.id, type: mv.type, from: mv.fromVillage });
    // ① 修复：返程改写后必须广播 movement.Sent，否则客户端 ListForeign 轮询缓存不刷新，
    // 视觉上表现为「未返程 / 运送倒计时被重置」。网关按 villageId 定向推送，客户端 refreshAll 重拉行军列表。
    void this.bus.emit({
      name: 'movement.Sent', source: MovementModule.NAME, ts: this.now(),
      payload: { id: mv.id, type: mv.type, villageId: mv.fromVillage, q: mv.toXY.q, r: mv.toXY.r, arriveAt: mv.arriveAt },
    } as DomainEvent);
  }

  /**
   * 计算从当前行军进度反向回到原点所需的毫秒数。
   * 仅适用于仍沿原始路径行进/停止的记录；路径不匹配时返回 undefined，
   * 由调用方按当前坐标重新计算，兼容旧存档和手工构造记录。
   */
  private outboundReturnMs(mv: MovementRecord): number | undefined {
    const home = mv.originalFromXY ?? mv.path[0] ?? mv.fromXY;
    const first = mv.path[0];
    if (!first || first.q !== home.q || first.r !== home.r) return undefined;
    if (!Number.isFinite(mv.perStepMs) || mv.perStepMs <= 0) return undefined;
    const index = Math.max(0, Math.min(mv.stepIndex, mv.path.length - 1));
    // stopped/非 marching 状态下位置已经固定在当前格，不应带入过期的段内进度。
    if (mv.status !== 'marching') return Math.max(0, Math.round(index * mv.perStepMs));
    const segmentStart = mv.nextStepAt - mv.perStepMs;
    const elapsed = Math.max(0, Math.min(mv.perStepMs, this.now() - segmentStart));
    return Math.max(0, Math.round(index * mv.perStepMs + elapsed));
  }

  /** 返程到达：兵力归队 + 战利品入库。 */
  private async arriveReturn(id: string): Promise<void> {
    const mv = this.load(id);
    if (!mv) return;
    log('返程到达', { id: mv.id, from: mv.fromVillage, troops: mv.troops, loot: mv.loot });
    // 出征军队 id：携带宝物与掉落 pending 均按「出征 id」索引；返程 movement 自身是新 id，
    // 故优先用 outwardId（由 onBattleEnded 透传的出征 id）回链，缺失时退化为返程 id兼容旧档。
    const outwardId = mv.outwardId ?? mv.id;
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
    // 运输货物随军返程到家（目标丢失时原路带回，不凭空消失；普通返程无 cargo，安全空操作）
    if (mv.cargo && Object.keys(mv.cargo).length > 0) {
      await this.commands.send({
        name: 'economy.Grant',
        from: MovementModule.NAME,
        payload: { villageId: mv.fromVillage, gain: mv.cargo },
      });
    }
    // 携带宝物随军返程到家 → 存回该村（优先宝库）。按出征 id 匹配，避免返程新 id 不匹配丢失宝物。
    // 注意：此处不能用「返程 movement 是否带战利品」来门控——携带宝物与战利品是两套追踪，
    // 军队只带回自己带出去的宝物、但没抢到任何战利品时（mv.treasures 为空），也必须把携带宝物存回，否则会静默丢失。
    // treasure.StoreCarried 在「该出征 id 没有携带记录」时是安全的空操作，故无条件调用。
    await this.commands.send({
      name: 'treasure.StoreCarried', from: MovementModule.NAME,
      payload: { movementId: outwardId, villageId: mv.fromVillage },
    });
    // 标记本军队对应的 camp 掉落 pending 为已到达（无论是否有携带宝物都要发——清营掉落的 pending 单独存在）
    await this.commands.send({
      name: 'treasure.MarkPendingArrived', from: MovementModule.NAME,
      payload: { movementId: outwardId },
    });
    this.remove(id, 'returned');
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
