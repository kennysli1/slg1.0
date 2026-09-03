import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, AllianceBuildingDef, AllianceTechDef, AllianceServiceDef } from '../infra/config.js';
import { kingdomLandmarkAnchors } from '../infra/world-generation.js';

export type AllianceRole = 'logistics' | 'war' | 'tech' | 'ambassador';
type Resources = { wood: number; clay: number; iron: number; crop: number };

interface WarParticipant {
  playerId: string;
  sourceVillageId: string;
  troops: Record<string, number>;
  travelSec: number;
  status: 'joined' | 'dispatched' | 'failed' | 'recalled';
  /** 实际创建的行军 id；联盟撤回复用 Movement 的通用撤回命令。 */
  movementId?: string;
  dispatchedAt?: number;
  recalledAt?: number;
}

interface WarPlan {
  id: string;
  mode: 'reinforce' | 'raid' | 'attack';
  targetKind: 'village' | 'pve';
  targetVillage?: string;
  targetId?: string;
  q: number;
  r: number;
  deadlineAt: number;
  /** 创建时的倒计时秒数；deadlineAt 保留为服务端权威截止时刻。 */
  countdownSec?: number;
  /** 从创建时起允许成员报名的时长。 */
  participationCountdownSec?: number;
  /** 报名截止的服务端绝对时间。 */
  joinDeadlineAt?: number;
  createdAt?: number;
  status: 'open' | 'dispatched' | 'cancelled';
  allDispatchedAt?: number;
  cancelledAt?: number;
  participants: Record<string, WarParticipant>;
}

type WarParticipantPreview = {
  cleanTroops: Record<string, number>;
  travelMs: number;
  travelSec: number;
  maxTravelMs: number;
  withinLimit: boolean;
  arriveAtIfDepartNow: number;
};

type WarParticipantPreparation =
  | { ok: true; preview: WarParticipantPreview }
  | { ok: false; reason: string; payload?: Record<string, unknown> };

interface PendingResourceDelivery {
  playerId: string;
  sourceVillageId: string;
  amount: Resources;
  sentAt: number;
  arriveAt: number;
  serviceOrderId?: string;
}

interface AllianceServiceOrder {
  id: string;
  serviceCode: string;
  serviceName: string;
  category: 'supplies' | 'reinforcement';
  reputationCost: number;
  purchasedBy: string;
  purchasedAt: number;
  status: 'pending' | 'completed' | 'failed';
  movementId?: string;
  failureReason?: string;
}

type AllianceBuildPlan = {
  code: string;
  targetLevel: number;
  required: Resources;
  /** planned 等待筹资；in_progress 已扣款并进入计时建造。 */
  state?: 'planned' | 'in_progress';
  startedAt?: number;
  completeAt?: number;
};

type AllianceTechPlan = {
  code: string;
  targetLevel: number;
  required: number;
  /** planned 等待科技点；in_progress 已扣点并进入计时研发。 */
  state?: 'planned' | 'in_progress';
  startedAt?: number;
  completeAt?: number;
};

interface AllianceState {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
  memberIds: string[];
  /** 每个成员可以同时担任多个已解锁职位；leader 作为系统职位始终存在。 */
  roles: Record<string, AllianceRole[]>;
  hallVillageId?: string;
  level: number;
  disconnected?: boolean;
  joinRequests: Record<string, number>;
  warehouse: Resources;
  resourceContributions: Record<string, Resources>;
  /** 已扣除来源村资源、正在运往联盟大厅的贡献商队。以商队 movement id 去重。 */
  pendingResourceDeliveries?: Record<string, PendingResourceDelivery>;
  techPointStock: number;
  techContributions: Record<string, number>;
  buildings: Record<string, number>;
  researchingBuilding?: AllianceBuildPlan | null;
  technologies: Record<string, number>;
  researchingTech?: AllianceTechPlan | null;
  warPlans: Record<string, WarPlan>;
  serviceSeq?: number;
  serviceOrders?: AllianceServiceOrder[];
}

const COLLECTION = 'alliance';
const PLAYER_INDEX = 'alliance_by_player';
const SEQ = 'alliance_seq';
const RESOURCE_KEYS = ['wood', 'clay', 'iron', 'crop'] as const;
const ROLE_LEVEL_FALLBACK: Record<AllianceRole, number> = { logistics: 1, war: 2, tech: 3, ambassador: 4 };

function zeroResources(): Resources { return { wood: 0, clay: 0, iron: 0, crop: 0 }; }
function positiveInt(v: unknown): number { return Math.max(0, Math.floor(Number(v) || 0)); }
function cloneResources(v?: Partial<Resources>): Resources {
  return { wood: positiveInt(v?.wood), clay: positiveInt(v?.clay), iron: positiveInt(v?.iron), crop: positiveInt(v?.crop) };
}
function addResources(a: Resources, b: Partial<Resources>): Resources {
  return { wood: a.wood + positiveInt(b.wood), clay: a.clay + positiveInt(b.clay), iron: a.iron + positiveInt(b.iron), crop: a.crop + positiveInt(b.crop) };
}
function enough(have: Resources, need: Resources): boolean { return RESOURCE_KEYS.every((k) => have[k] >= need[k]); }
function subtract(a: Resources, b: Resources): Resources {
  return { wood: a.wood - b.wood, clay: a.clay - b.clay, iron: a.iron - b.iron, crop: a.crop - b.crop };
}

/** 联盟领域 owner：联盟成员、仓库、职位、建筑/科技计划及联盟军事集结。 */
export class AllianceModule {
  static readonly NAME = 'alliance';
  private servicePurchaseInFlight = new Set<string>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  /** 配置中心热重载后，立即把新的职位/联盟建筑/联盟科技加成同步到成员村庄。 */
  async refreshModifiers(): Promise<void> {
    for (const raw of this.store.all<AllianceState>(COLLECTION)) {
      const a = this.normalize(raw);
      this.store.set(COLLECTION, a.id, a);
      await this.syncAllModifiers(a);
    }
  }

  init(): void {
    this.commands.register('alliance.List', (c) => this.list(c));
    this.commands.register('alliance.Get', (c) => this.get(c));
    this.commands.register('alliance.Create', (c) => this.create(c));
    this.commands.register('alliance.Apply', (c) => this.apply(c));
    this.commands.register('alliance.ReviewRequest', (c) => this.reviewRequest(c));
    this.commands.register('alliance.Leave', (c) => this.leave(c));
    this.commands.register('alliance.SetRole', (c) => this.setRole(c));
    this.commands.register('alliance.RemoveMember', (c) => this.removeMember(c));
    this.commands.register('alliance.DepositResources', (c) => this.depositResources(c));
    // 商队抵达联盟大厅后的内部结算；由 movement owner 调用，贡献不会在发车时瞬间入库。
    this.commands.register('alliance.ReceiveResourceCaravan', (c) => this.receiveResourceCaravan(c));
    this.commands.register('alliance.ReceiveServiceResources', (c) => this.receiveServiceResources(c));
    this.commands.register('alliance.BuyService', (c) => this.buyService(c));
    this.commands.register('alliance.StartBuilding', (c) => this.startBuilding(c));
    this.commands.register('alliance.StartTech', (c) => this.startTech(c));
    this.commands.register('alliance.ContributeTech', (c) => this.contributeTech(c));
    this.commands.register('alliance.CreateWarPlan', (c) => this.createWarPlan(c));
    this.commands.register('alliance.PreviewWarParticipation', (c) => this.previewWarParticipation(c));
    this.commands.register('alliance.JoinWarPlan', (c) => this.joinWarPlan(c));
    this.commands.register('alliance.CancelWarParticipation', (c) => this.cancelWarParticipation(c));
    this.commands.register('alliance.CancelWarPlan', (c) => this.cancelWarPlan(c));
    this.commands.register('alliance.RecallWarPlan', (c) => this.recallWarPlan(c));
    this.commands.register('alliance.GetTroopReservations', (c) => this.getTroopReservations(c));
    this.commands.register('alliance.GetRelation', (c) => this.getRelation(c));
    // Movement/Building 等 owner 通过命令查询，不直接依赖联盟存储。
    this.commands.register('alliance.CanBuildHall', (c) => this.canBuildHall(c));

    this.bus.on('building.Built', (evt) => void this.onBuildingEvent(evt, 'built'));
    this.bus.on('building.Upgraded', (evt) => void this.onBuildingEvent(evt, 'upgraded'));
    // 战斗损坏的联盟大厅保留 0 级空壳，修复完成时 Building 领域发出
    // Repaired 而不是 Built；必须把这个事件纳入重连路径，否则盟主修复大厅后
    // 联盟会永久停留在“失联”状态。
    this.bus.on('building.Repaired', (evt) => void this.onBuildingEvent(evt, 'repaired'));
    this.bus.on('building.Demolished', (evt) => void this.onBuildingEvent(evt, 'demolished'));
    this.bus.on('building.BattleDamaged', (evt) => void this.onBuildingDamage(evt));
    // 放弃/删除村庄时 Building 记录会随村庄一起清理，不一定再有 Demolished
    // 事件；监听 World 的移除事件，保证大厅失联立即传播给联盟成员。
    this.bus.on('world.VillageRemoved', (evt) => void this.onVillageRemoved(evt));
    this.bus.on('player.VillageAttached', (evt) => void this.syncPlayerModifiers(String((evt.payload as any)?.playerId ?? '')));
    // 成员从地图主动撤回时，同步联盟战事参与状态，避免盟主看到过期的“已派出”。
    this.bus.on('movement.Recalled', (evt) => void this.onWarMovementRecalled(evt));
    this.bus.on('movement.GarrisonRecalled', (evt) => void this.onWarMovementRecalled(evt));
    this.bus.on('movement.ReinforcementArrived', (evt) => void this.onServiceReinforcementArrived(evt));
    this.bus.on('reputation.Changed', (evt) => {
      const playerId = String((evt.payload as any)?.playerId ?? '');
      if (playerId) void this.syncAllianceByMember(playerId);
    });
  }

  async resume(): Promise<void> {
    for (const raw of this.store.all<AllianceState>(COLLECTION)) {
      const a = this.normalize(raw);
      this.store.set(COLLECTION, a.id, a);
      for (const memberId of a.memberIds) this.store.set(PLAYER_INDEX, memberId, a.id);
      // Connectivity refresh may clear plans when the alliance hall is gone.
      // Await it before restoring project timers so a stale in-progress plan
      // cannot be scheduled after a disconnected alliance has been normalized.
      await this.refreshConnectivity(a);
      const current = this.load(a.id) ?? a;
      for (const playerId of current.memberIds) void this.syncPlayerModifiers(playerId);
      for (const plan of Object.values(current.warPlans)) this.schedulePlan(current, plan);
      if (current.researchingBuilding?.state === 'in_progress') this.scheduleBuilding(current);
      else if (current.researchingBuilding) void this.maybeStartBuilding(current);
      if (current.researchingTech?.state === 'in_progress') this.scheduleTech(current);
      else if (current.researchingTech) void this.maybeStartTech(current);
    }
  }

  /** 玩家删号时由 app 调用，联盟本身不会因成员离线/删号而被删除。 */
  deletePlayer(playerId: string): void {
    const allianceId = this.store.get<string>(PLAYER_INDEX, playerId);
    if (!allianceId) return;
    const a = this.load(allianceId);
    if (!a) { this.store.delete(PLAYER_INDEX, playerId); return; }
    if (a.leaderId === playerId) return;
    a.memberIds = a.memberIds.filter((id) => id !== playerId);
    delete a.roles[playerId]; delete a.joinRequests[playerId];
    this.store.set(COLLECTION, a.id, a);
    this.store.delete(PLAYER_INDEX, playerId);
    void this.push(a);
  }

  private normalize(raw: AllianceState): AllianceState {
    const level = Math.max(1, Math.floor(Number(raw.level) || 1));
    const normalizeBuildPlan = (plan?: AllianceBuildPlan | null): AllianceBuildPlan | null => {
      if (!plan || !plan.code) return null;
      const completeAt = Number(plan.completeAt);
      const startedAt = Number(plan.startedAt);
      const state = plan.state === 'in_progress' || (Number.isFinite(completeAt) && completeAt > 0) ? 'in_progress' : 'planned';
      return {
        code: String(plan.code), targetLevel: Math.max(1, Math.floor(Number(plan.targetLevel) || 1)),
        required: cloneResources(plan.required), state,
        ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
        ...(state === 'in_progress' && Number.isFinite(completeAt) && completeAt > 0 ? { completeAt } : {}),
      };
    };
    const normalizeTechPlan = (plan?: AllianceTechPlan | null): AllianceTechPlan | null => {
      if (!plan || !plan.code) return null;
      const completeAt = Number(plan.completeAt);
      const startedAt = Number(plan.startedAt);
      const state = plan.state === 'in_progress' || (Number.isFinite(completeAt) && completeAt > 0) ? 'in_progress' : 'planned';
      return {
        code: String(plan.code), targetLevel: Math.max(1, Math.floor(Number(plan.targetLevel) || 1)),
        required: positiveInt(plan.required), state,
        ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
        ...(state === 'in_progress' && Number.isFinite(completeAt) && completeAt > 0 ? { completeAt } : {}),
      };
    };
    return {
      ...raw,
      memberIds: [...new Set([raw.leaderId, ...(Array.isArray(raw.memberIds) ? raw.memberIds : [])].filter(Boolean))],
      roles: raw.roles ?? { [raw.leaderId]: [] },
      joinRequests: raw.joinRequests ?? {},
      warehouse: cloneResources(raw.warehouse),
      resourceContributions: raw.resourceContributions ?? {},
      pendingResourceDeliveries: raw.pendingResourceDeliveries ?? {},
      techPointStock: positiveInt(raw.techPointStock),
      techContributions: raw.techContributions ?? {},
      buildings: raw.buildings ?? {},
      researchingBuilding: normalizeBuildPlan(raw.researchingBuilding),
      technologies: raw.technologies ?? {},
      researchingTech: normalizeTechPlan(raw.researchingTech),
      warPlans: Object.fromEntries(Object.entries(raw.warPlans ?? {}).map(([id, rawPlan]) => {
        const plan = rawPlan as WarPlan;
        const createdAt = Number(plan.createdAt) > 0 ? Number(plan.createdAt) : this.now();
        const deadlineAt = Number(plan.deadlineAt);
        const totalSec = Number(plan.countdownSec) > 0 ? Math.floor(Number(plan.countdownSec)) : Math.max(1, Math.ceil((deadlineAt - createdAt) / 1000));
        const participationSec = Number(plan.participationCountdownSec) > 0
          ? Math.floor(Number(plan.participationCountdownSec))
          : totalSec;
        const joinDeadlineAt = Number(plan.joinDeadlineAt) > 0 ? Number(plan.joinDeadlineAt) : (participationSec >= totalSec ? deadlineAt : createdAt + participationSec * 1000);
        return [id, { ...plan, createdAt, countdownSec: totalSec, participationCountdownSec: participationSec, joinDeadlineAt, deadlineAt, participants: plan.participants ?? {} }];
      })),
      serviceSeq: positiveInt(raw.serviceSeq),
      serviceOrders: Array.isArray(raw.serviceOrders) ? raw.serviceOrders.map((order) => ({ ...order, id: String(order.id ?? ''), serviceCode: String(order.serviceCode ?? ''), status: order.status === 'completed' || order.status === 'failed' ? order.status : 'pending' })) : [],
      level,
      disconnected: raw.disconnected === true,
    };
  }

  private load(id: string): AllianceState | undefined { return this.store.get<AllianceState>(COLLECTION, id); }
  private idForPlayer(playerId: string): string | undefined { return this.store.get<string>(PLAYER_INDEX, playerId); }
  private nextId(): string {
    const n = (this.store.get<number>(SEQ, 'n') ?? 0) + 1;
    this.store.set(SEQ, 'n', n);
    return `alliance-${n}`;
  }
  private levelDef(level: number) {
    const entries = Object.values(this.config.allianceLevels).sort((a, b) => a.level - b.level);
    return entries.filter((x) => x.level <= level).at(-1) ?? entries[0] ?? { level: 1, hallLevel: 1, memberCap: 10, description: '' };
  }
  private cap(a: AllianceState): number { return this.levelDef(a.level).memberCap; }
  private roleLevel(role: AllianceRole): number {
    const c = this.config.constants;
    const configured = role === 'logistics' ? c.allianceLogisticsRoleLevel
      : role === 'war' ? c.allianceWarRoleLevel
        : role === 'tech' ? c.allianceTechRoleLevel : c.allianceAmbassadorRoleLevel;
    return Math.max(1, Math.floor(Number(configured) || ROLE_LEVEL_FALLBACK[role]));
  }
  private roleUnlocked(a: AllianceState, role: AllianceRole): boolean { return a.level >= this.roleLevel(role); }
  private isMember(a: AllianceState, playerId: string): boolean { return a.memberIds.includes(playerId); }
  private hasRole(a: AllianceState, playerId: string, role: AllianceRole): boolean {
    return a.leaderId === playerId || (a.roles[playerId] ?? []).includes(role);
  }

  private roleHolder(a: AllianceState, role: AllianceRole): string | undefined {
    if (!this.roleUnlocked(a, role)) return undefined;
    return a.memberIds.find((id) => (a.roles[id] ?? []).includes(role));
  }

  private async allianceReputation(a: AllianceState): Promise<number> {
    if (a.disconnected) return 0;
    const holder = this.roleHolder(a, 'ambassador');
    if (!holder) return 0;
    const result = await this.commands.send({ name: 'reputation.Get', from: AllianceModule.NAME, payload: { playerId: holder } });
    const value = Number((result.payload as any)?.value);
    return Number.isFinite(value) ? value : 0;
  }

  private allianceModifierMultiplier(reputation: number): number {
    const perPoint = Math.max(0, Number(this.config.constants.allianceReputationBonusPerPoint) || 0);
    const cap = Math.max(1, Number(this.config.constants.allianceReputationBonusMaxMultiplier) || 1);
    return Math.min(cap, 1 + Math.max(0, reputation) * perPoint);
  }

  private enforceRoleLocks(a: AllianceState): boolean {
    let changed = false;
    for (const memberId of a.memberIds) {
      const roles = a.roles[memberId] ?? [];
      const kept = roles.filter((role) => this.roleUnlocked(a, role));
      if (kept.length !== roles.length) { a.roles[memberId] = kept; changed = true; }
    }
    return changed;
  }

  /** 成员名单使用的四个职位目录；数值从当前配置实时派生，避免前端复制一份平衡参数。 */
  private roleCatalog(a: AllianceState, allianceReputation = 0): Array<{ code: AllianceRole; name: string; requiredAllianceLevel: number; unlocked: boolean; effect: string; effectValue: number | string }> {
    const scale = this.allianceModifierMultiplier(allianceReputation);
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    return [
      { code: 'logistics', name: '后勤主管', requiredAllianceLevel: this.roleLevel('logistics'), unlocked: this.roleUnlocked(a, 'logistics'), effect: `所有村庄资源产量 +${percent(this.config.constants.allianceLogisticsResourceMult * scale)}`, effectValue: this.config.constants.allianceLogisticsResourceMult * scale },
      { code: 'war', name: '战争专家', requiredAllianceLevel: this.roleLevel('war'), unlocked: this.roleUnlocked(a, 'war'), effect: `所有村庄军队移速 +${percent(this.config.constants.allianceWarSpeedMult * scale)}，攻防 +${percent(this.config.constants.allianceWarCombatMult * scale)}`, effectValue: this.config.constants.allianceWarCombatMult * scale },
      { code: 'tech', name: '首席科技官', requiredAllianceLevel: this.roleLevel('tech'), unlocked: this.roleUnlocked(a, 'tech'), effect: `所有村庄科技点获得概率 +${percent(this.config.constants.allianceTechProbabilityBonus * scale)}`, effectValue: this.config.constants.allianceTechProbabilityBonus * scale },
      { code: 'ambassador', name: '形象大使', requiredAllianceLevel: this.roleLevel('ambassador'), unlocked: this.roleUnlocked(a, 'ambassador'), effect: `每次获得声望额外 +${this.config.constants.allianceAmbassadorReputationBonus * scale}`, effectValue: this.config.constants.allianceAmbassadorReputationBonus * scale },
    ];
  }

  private async ownedVillage(playerId: string, villageId: string): Promise<boolean> {
    const res = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId } });
    return !!res.ok && ((res.payload as any)?.player?.villages ?? []).some((v: any) => v.id === villageId);
  }

  private async refreshConnectivity(a: AllianceState): Promise<void> {
    if (!a.hallVillageId) return;
    const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: AllianceModule.NAME, payload: { villageId: a.hallVillageId, kind: 'alliance_hall' } });
    const hallLevel = level.ok ? positiveInt((level.payload as any)?.level) : 0;
    const connected = hallLevel > 0;
    if (connected && !a.disconnected && a.level === this.levelDef(hallLevel).level) return;
    if (!connected && a.disconnected) return;
    if (!connected) {
      a.disconnected = true;
      // 大厅失联会撤销职位加成，并清空联盟大厅内尚未完成的项目。
      a.roles = Object.fromEntries(a.memberIds.map((id) => [id, []]));
      // 历史贡献、已建成联盟建筑和已研发科技属于联盟永久记录，不能因
      // 大厅失联而归零；只有大厅现场堆积的仓库资源、未投入的科技点和
      // 正在进行的项目会丢失。重建后沿用既有等级与累计贡献。
      a.warehouse = zeroResources();
      a.pendingResourceDeliveries = {};
      a.techPointStock = 0;
      a.researchingBuilding = null;
      a.researchingTech = null;
      this.scheduler.cancelByOwner(`alliance-building:${a.id}`);
      this.scheduler.cancelByOwner(`alliance-tech:${a.id}`);
      for (const plan of Object.values(a.warPlans)) for (const participant of Object.values(plan.participants)) this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${participant.playerId}`);
      // 已经出发的军事行动继续；尚未出发的行动取消。行军回收由
      // movement.ReturnAllianceDeliveries 处理，不在这里直接改 Movement owner。
      for (const plan of Object.values(a.warPlans)) {
        const dispatched = Object.values(plan.participants).some((p) => p.status === 'dispatched' && p.movementId);
        for (const participant of Object.values(plan.participants)) if (participant.status === 'joined') {
          await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, troops: participant.troops } });
          participant.status = 'failed';
        }
        if (!dispatched) {
          plan.status = 'cancelled';
          plan.cancelledAt = this.now();
        }
        this.scheduler.cancelByOwner(`alliance-war:${plan.id}`);
      }
      a.serviceOrders = (a.serviceOrders ?? []).map((order) => order.status === 'pending' ? { ...order, status: 'failed', failureReason: 'alliance_disconnected' } : order);
      await this.commands.send({ name: 'movement.ReturnAllianceDeliveries', from: AllianceModule.NAME, payload: { allianceId: a.id, hallVillageId: a.hallVillageId } });
    } else {
      a.disconnected = false;
      a.level = this.levelDef(hallLevel).level;
      this.enforceRoleLocks(a);
    }
    this.store.set(COLLECTION, a.id, a);
    for (const id of a.memberIds) void this.syncPlayerModifiers(id);
    await this.push(a);
  }

  private async onBuildingEvent(evt: DomainEvent, kind: 'built' | 'upgraded' | 'repaired' | 'demolished'): Promise<void> {
    const p = evt.payload as { villageId?: string; kind?: string; level?: number };
    if (p.kind !== 'alliance_hall' || !p.villageId) return;
    for (const a of this.store.all<AllianceState>(COLLECTION)) {
      if (a.hallVillageId === p.villageId && (kind === 'demolished' || kind === 'upgraded' || kind === 'repaired')) await this.refreshConnectivity(a);
      const owner = await this.commands.send({ name: 'player.GetByVillage', from: AllianceModule.NAME, payload: { villageId: p.villageId } });
      const playerId = owner.ok ? String((owner.payload as any)?.player?.id ?? '') : '';
      if (!playerId || a.leaderId !== playerId) continue;
      if (kind === 'built' || kind === 'upgraded' || kind === 'repaired') {
        if (!a.hallVillageId || a.disconnected || a.hallVillageId === p.villageId) {
          a.hallVillageId = p.villageId;
          a.level = this.levelDef(positiveInt(p.level) || 1).level;
          a.disconnected = false;
          this.store.set(COLLECTION, a.id, a);
          await this.refreshConnectivity(a);
        }
      }
    }
  }

  private async onBuildingDamage(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; destroyed?: Array<{ kind?: string; toLevel?: number }> };
    if (!p.villageId || !p.destroyed?.some((x) => x.kind === 'alliance_hall')) return;
    for (const a of this.store.all<AllianceState>(COLLECTION)) if (a.hallVillageId === p.villageId) await this.refreshConnectivity(a);
  }

  private async onVillageRemoved(evt: DomainEvent): Promise<void> {
    const villageId = String((evt.payload as any)?.villageId ?? '');
    if (!villageId) return;
    for (const a of this.store.all<AllianceState>(COLLECTION)) {
      if (a.hallVillageId === villageId) await this.refreshConnectivity(a);
    }
  }

  private modifiers(a: AllianceState, playerId: string, allianceReputation = 0) {
    const roles = a.roles[playerId] ?? [];
    const scale = this.allianceModifierMultiplier(allianceReputation);
    const resourceDetails: { source: string; label: string; mult: Record<string, number> }[] = [];
    const out = {
      resourceRateMult: roles.includes('logistics') ? this.config.constants.allianceLogisticsResourceMult * scale : 0,
      warSpeedMult: roles.includes('war') ? this.config.constants.allianceWarSpeedMult * scale : 0,
      warCombatMult: roles.includes('war') ? this.config.constants.allianceWarCombatMult * scale : 0,
      techProbabilityBonus: roles.includes('tech') ? this.config.constants.allianceTechProbabilityBonus * scale : 0,
      ambassadorReputationBonus: roles.includes('ambassador') ? this.config.constants.allianceAmbassadorReputationBonus * scale : 0,
    };
    if (roles.includes('logistics') && out.resourceRateMult) {
        resourceDetails.push({ source: 'alliance:role:logistics', label: `联盟职位：后勤主管（声望倍率 ${scale.toFixed(2)}）`, mult: { wood: out.resourceRateMult, clay: out.resourceRateMult, iron: out.resourceRateMult, crop: out.resourceRateMult } });
    }
    // 联盟建筑/科技按已完成等级叠加；所有成员共享，不把未完成计划提前计入。
    const apply = (effectType: string, value: number, label: string, source: string): void => {
      const v = Number.isFinite(value) ? value : 0;
      if (effectType === 'resource_rate') {
        out.resourceRateMult += v;
        resourceDetails.push({ source, label, mult: { wood: v, clay: v, iron: v, crop: v } });
      }
      else if (effectType === 'combat_def' || effectType === 'combat_atk') out.warCombatMult += v;
      else if (effectType === 'march_speed') out.warSpeedMult += v;
      else if (effectType === 'tech_probability') out.techProbabilityBonus += v;
      else if (effectType === 'reputation') out.ambassadorReputationBonus += v;
    };
    for (const [code, level] of Object.entries(a.buildings)) {
      const def = this.config.allianceBuildings[code];
      if (def) apply(def.effectType, def.effectValue * positiveInt(level) * scale, `联盟建筑：${def.name}`, `alliance:building:${code}`);
    }
    for (const [code, level] of Object.entries(a.technologies)) {
      const def = this.config.allianceTech[code];
      if (def) apply(def.effectType, def.effectValue * positiveInt(level) * scale, `联盟科技：${def.name}`, `alliance:tech:${code}`);
    }
    return { ...out, resourceDetails };
  }

  private async syncPlayerModifiers(playerId: string): Promise<void> {
    if (!playerId) return;
    const allianceId = this.idForPlayer(playerId);
    const a = allianceId ? this.load(allianceId) : undefined;
    const allianceReputation = a && !a.disconnected ? await this.allianceReputation(a) : 0;
    const mods = a && !a.disconnected ? this.modifiers(a, playerId, allianceReputation) : { resourceRateMult: 0, warSpeedMult: 0, warCombatMult: 0, techProbabilityBonus: 0, ambassadorReputationBonus: 0, resourceDetails: [] };
    const p = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId } });
    if (!p.ok) return;
    for (const v of ((p.payload as any)?.player?.villages ?? [])) {
      const villageId = String(v.id);
      await this.commands.send({ name: 'economy.SetRateModifier', from: AllianceModule.NAME, payload: { villageId, source: 'alliance', mult: { wood: mods.resourceRateMult, clay: mods.resourceRateMult, iron: mods.resourceRateMult, crop: mods.resourceRateMult }, details: mods.resourceDetails } });
      await this.commands.send({ name: 'military.SetAllianceModifiers', from: AllianceModule.NAME, payload: { villageId, speedMult: mods.warSpeedMult, atkMult: mods.warCombatMult, defMult: mods.warCombatMult } });
      await this.commands.send({ name: 'research.SetAllianceTechBonus', from: AllianceModule.NAME, payload: { villageId, bonus: mods.techProbabilityBonus } });
      await this.commands.send({ name: 'reputation.SetAllianceBonus', from: AllianceModule.NAME, payload: { playerId, bonus: mods.ambassadorReputationBonus } });
    }
  }

  private async syncAllModifiers(a: AllianceState): Promise<void> {
    await Promise.all(a.memberIds.map((id) => this.syncPlayerModifiers(id)));
  }

  private async syncAllianceByMember(playerId: string): Promise<void> {
    const id = this.idForPlayer(playerId);
    const a = id ? this.load(id) : undefined;
    if (!a) return;
    await this.syncAllModifiers(a);
    await this.push(a);
  }

  private async push(a: AllianceState): Promise<void> {
    await this.bus.emit({ name: 'alliance.Updated', source: AllianceModule.NAME, ts: this.now(), payload: { allianceId: a.id, playerIds: [...a.memberIds] } } as DomainEvent);
  }

  private async list(cmd: Command): Promise<CommandResult> {
    const query = String((cmd.payload as any)?.query ?? '').trim().toLocaleLowerCase();
    // 失联联盟不会进入公开目录；联盟本身和申请记录仍保留在存档中，
    // 盟主恢复大厅后可在联盟控制页统一处理此前收到的申请。
    const alliances = this.store.all<AllianceState>(COLLECTION).map((raw) => this.normalize(raw)).filter((a) => !a.disconnected && (!query || a.name.toLocaleLowerCase().includes(query) || a.leaderName.toLocaleLowerCase().includes(query)));
    const rows = await Promise.all(alliances.map(async (a) => ({ id: a.id, name: a.name, leaderId: a.leaderId, leaderName: a.leaderName, memberCount: a.memberIds.length, memberCap: this.cap(a), full: a.memberIds.length >= this.cap(a), level: a.level, reputation: await this.allianceReputation(a), disconnected: !!a.disconnected })));
    return { ok: true, payload: { alliances: rows } };
  }

  private async memberView(a: AllianceState, playerId: string): Promise<any> {
    const p = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId } });
    const player = (p.payload as any)?.player;
    let population = 0;
    if (player) for (const v of player.villages ?? []) {
      const pop = await this.commands.send({ name: 'population.GetSnapshot', from: AllianceModule.NAME, payload: { villageId: v.id } });
      population += positiveInt((pop.payload as any)?.totalPop ?? (pop.payload as any)?.currentPop);
    }
    const rep = await this.commands.send({ name: 'reputation.Get', from: AllianceModule.NAME, payload: { playerId } });
    const contribution = a.resourceContributions[playerId] ?? zeroResources();
    let militaryPop = 0;
    for (const plan of Object.values(a.warPlans)) {
      const part = plan.participants[playerId];
      if (!part) continue;
      for (const [code, count] of Object.entries(part.troops)) militaryPop += positiveInt(count) * Math.max(1, this.config.units[code]?.popCost ?? 1);
    }
    return {
      id: playerId, name: player?.name ?? playerId, villages: (player?.villages ?? []).length, population,
      reputation: Number((rep.payload as any)?.value ?? 0), resourceContribution: contribution,
      techContribution: positiveInt(a.techContributions[playerId]), militaryPopulation: militaryPop,
      roles: a.leaderId === playerId ? ['leader', ...(a.roles[playerId] ?? [])] : (a.roles[playerId] ?? []),
    };
  }

  /** 仅给当前请求玩家下发其各村驻村可用兵力，供联盟战事表单逐兵种选择。 */
  private async availableTroopsByVillage(playerId: string): Promise<Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, number>> = {};
    const p = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId } });
    const villages = (p.payload as any)?.player?.villages ?? [];
    for (const village of villages) {
      const army = await this.commands.send({ name: 'military.GetArmy', from: AllianceModule.NAME, payload: { villageId: village.id } });
      if (!army.ok) continue;
      result[String(village.id)] = Object.fromEntries(Object.entries((army.payload as any)?.availableTroops ?? (army.payload as any)?.troops ?? {}).map(([code, count]) => [code, positiveInt(count)]));
    }
    return result;
  }

  private async get(cmd: Command): Promise<CommandResult> {
    const playerId = String((cmd.payload as any)?.playerId ?? '');
    const id = this.idForPlayer(playerId);
    if (!id) return { ok: true, payload: { alliance: null } };
    const a = this.load(id); if (!a) return { ok: true, payload: { alliance: null } };
    await this.refreshConnectivity(a);
    const allianceReputation = await this.allianceReputation(a);
    const members = []; for (const memberId of a.memberIds) members.push(await this.memberView(a, memberId));
    const availableTroopsByVillage = await this.availableTroopsByVillage(playerId);
    const unitCatalog = Object.values(this.config.units).map((u) => ({ code: u.key, name: u.name, form: u.form, icon: u.icon }));
    return { ok: true, payload: { alliance: { id: a.id, name: a.name, leaderId: a.leaderId, leaderName: a.leaderName, level: a.level, memberCap: this.cap(a), allianceReputation, allianceModifierMultiplier: this.allianceModifierMultiplier(allianceReputation), disconnected: !!a.disconnected, hallVillageId: a.hallVillageId, roles: a.roles, roleCatalog: this.roleCatalog(a, allianceReputation), members, warehouse: a.warehouse, resourceContributions: a.resourceContributions, pendingResourceDeliveries: Object.entries(a.pendingResourceDeliveries ?? {}).map(([id, delivery]) => ({ id, ...delivery })), techPointStock: a.techPointStock, technologies: a.technologies, buildings: a.buildings, buildingCatalog: Object.values(this.config.allianceBuildings), techCatalog: Object.values(this.config.allianceTech), allianceServices: Object.values(this.config.allianceServices).sort((x, y) => x.id - y.id), serviceOrders: a.serviceOrders ?? [], researchingBuilding: a.researchingBuilding ?? null, researchingTech: a.researchingTech ?? null, warPlans: Object.values(a.warPlans), availableTroopsByVillage, unitCatalog, joinRequests: a.leaderId === playerId ? a.joinRequests : {} } } };
  }

  private async create(cmd: Command): Promise<CommandResult> {
    const { playerId, sourceVillageId, name } = cmd.payload as { playerId: string; sourceVillageId: string; name: string };
    if (!playerId || this.idForPlayer(playerId)) return { ok: false, payload: {}, reason: 'already_in_alliance' };
    const clean = String(name ?? '').trim();
    if (clean.length < 2 || clean.length > 24) return { ok: false, payload: {}, reason: 'invalid_alliance_name' };
    if (!sourceVillageId || !(await this.ownedVillage(playerId, sourceVillageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const hall = await this.commands.send({ name: 'building.GetBuildingLevel', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, kind: 'alliance_hall' } });
    const hallLevel = hall.ok ? positiveInt((hall.payload as any)?.level) : 0;
    if (hallLevel <= 0) return { ok: false, payload: {}, reason: 'alliance_hall_required' };
    const duplicate = this.store.all<AllianceState>(COLLECTION).some((a) => a.name.toLocaleLowerCase() === clean.toLocaleLowerCase());
    if (duplicate) return { ok: false, payload: {}, reason: 'alliance_name_taken' };
    const spend = await this.commands.send({ name: 'economy.TrySpend', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, cost: { wood: this.config.constants.allianceCreateWood, clay: this.config.constants.allianceCreateClay, iron: this.config.constants.allianceCreateIron, crop: this.config.constants.allianceCreateCrop, gold: this.config.constants.allianceCreateGold } } });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'insufficient_resources' };
    const player = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId } });
    const leaderName = String((player.payload as any)?.player?.name ?? playerId);
    const id = this.nextId();
    const a: AllianceState = { id, name: clean, leaderId: playerId, leaderName, memberIds: [playerId], roles: { [playerId]: [] }, hallVillageId: sourceVillageId, level: this.levelDef(hallLevel).level, disconnected: false, joinRequests: {}, warehouse: zeroResources(), resourceContributions: {}, pendingResourceDeliveries: {}, techPointStock: 0, techContributions: {}, buildings: {}, technologies: {}, warPlans: {} };
    this.store.set(COLLECTION, id, a); this.store.set(PLAYER_INDEX, playerId, id);
    await this.syncPlayerModifiers(playerId); await this.push(a);
    return { ok: true, payload: { allianceId: id, alliance: a } };
  }

  private async apply(cmd: Command): Promise<CommandResult> {
    const { playerId, allianceId } = cmd.payload as { playerId: string; allianceId: string };
    if (this.idForPlayer(playerId)) return { ok: false, payload: {}, reason: 'already_in_alliance' };
    const a = this.load(allianceId); if (!a) return { ok: false, payload: {}, reason: 'alliance_not_found' };
    // 失联期间仍允许已持有链接/旧目录的申请写入 joinRequests；公开目录会
    // 隐藏该联盟，申请不会自动加入，必须等大厅恢复后由盟主统一审核。
    if (a.memberIds.length >= this.cap(a)) return { ok: false, payload: {}, reason: 'alliance_full' };
    a.joinRequests[playerId] = this.now(); this.store.set(COLLECTION, a.id, a); await this.push(a);
    return { ok: true, payload: { allianceId, requested: true } };
  }

  private async reviewRequest(cmd: Command): Promise<CommandResult> {
    const { playerId, applicantId, approve } = cmd.payload as { playerId: string; applicantId: string; approve: boolean };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.leaderId !== playerId) return { ok: false, payload: {}, reason: 'leader_required' };
    if (a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!(applicantId in a.joinRequests)) return { ok: false, payload: {}, reason: 'request_not_found' };
    if (approve) {
      if (this.idForPlayer(applicantId)) return { ok: false, payload: {}, reason: 'applicant_in_alliance' };
      if (a.memberIds.length >= this.cap(a)) return { ok: false, payload: {}, reason: 'alliance_full' };
      a.memberIds.push(applicantId); a.roles[applicantId] = []; this.store.set(PLAYER_INDEX, applicantId, a.id); void this.syncPlayerModifiers(applicantId);
    }
    delete a.joinRequests[applicantId];
    this.store.set(COLLECTION, a.id, a); await this.push(a); return { ok: true, payload: { approved: !!approve, allianceId: a.id } };
  }

  private async leave(cmd: Command): Promise<CommandResult> {
    const playerId = String((cmd.payload as any)?.playerId ?? ''); const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a) return { ok: false, payload: {}, reason: 'not_in_alliance' };
    if (a.leaderId === playerId) return { ok: false, payload: {}, reason: 'leader_must_transfer_first' };
    await this.releaseJoinedWarReservations(a, playerId);
    a.memberIds = a.memberIds.filter((x) => x !== playerId); delete a.roles[playerId]; this.store.delete(PLAYER_INDEX, playerId); this.store.set(COLLECTION, a.id, a); await this.syncPlayerModifiers(playerId); await this.push(a); return { ok: true, payload: { left: true } };
  }

  private async setRole(cmd: Command): Promise<CommandResult> {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    const rawRole = (cmd.payload as any)?.role;
    const role = rawRole === undefined || rawRole === null || rawRole === '' ? null : String(rawRole) as AllianceRole;
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.leaderId !== playerId) return { ok: false, payload: {}, reason: 'leader_required' };
    if (!this.isMember(a, targetPlayerId)) return { ok: false, payload: {}, reason: 'member_not_found' };
    if (role !== null && !Object.prototype.hasOwnProperty.call(ROLE_LEVEL_FALLBACK, role)) return { ok: false, payload: {}, reason: 'invalid_role' };
    if (role && !this.roleUnlocked(a, role)) return { ok: false, payload: {}, reason: 'role_locked' };
    if (role) for (const memberId of a.memberIds) a.roles[memberId] = (a.roles[memberId] ?? []).filter((x) => x !== role);
    a.roles[targetPlayerId] = role ? [...new Set([...(a.roles[targetPlayerId] ?? []), role])] : [];
    this.store.set(COLLECTION, a.id, a); for (const memberId of a.memberIds) void this.syncPlayerModifiers(memberId); await this.push(a); return { ok: true, payload: { targetPlayerId, role } };
  }

  private async removeMember(cmd: Command): Promise<CommandResult> {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.leaderId !== playerId) return { ok: false, payload: {}, reason: 'leader_required' };
    if (targetPlayerId === a.leaderId || !this.isMember(a, targetPlayerId)) return { ok: false, payload: {}, reason: 'member_not_found' };
    await this.releaseJoinedWarReservations(a, targetPlayerId);
    a.memberIds = a.memberIds.filter((x) => x !== targetPlayerId); delete a.roles[targetPlayerId]; this.store.delete(PLAYER_INDEX, targetPlayerId); this.store.set(COLLECTION, a.id, a); await this.syncPlayerModifiers(targetPlayerId); await this.push(a); return { ok: true, payload: { removed: targetPlayerId } };
  }

  /** 离盟或被移除时，取消尚未出发的联盟战事报名，避免预备队锁永久占用兵力。 */
  private async releaseJoinedWarReservations(a: AllianceState, playerId: string): Promise<void> {
    for (const plan of Object.values(a.warPlans)) {
      const participant = plan.participants?.[playerId];
      if (!participant || participant.status !== 'joined') continue;
      this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${playerId}`);
      await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, troops: participant.troops } });
      delete plan.participants[playerId];
    }
  }

  private buildingCost(def: AllianceBuildingDef, level: number): Resources { return { wood: Math.ceil(def.baseCost.wood * level), clay: Math.ceil(def.baseCost.clay * level), iron: Math.ceil(def.baseCost.iron * level), crop: Math.ceil(def.baseCost.crop * level) }; }

  private projectDurationMs(): number {
    return Math.max(1, Math.floor(this.config.constants.allianceProjectDurationSec)) * 1000;
  }

  private buildingInProgress(plan?: AllianceBuildPlan | null): boolean {
    return plan?.state === 'in_progress';
  }

  private techInProgress(plan?: AllianceTechPlan | null): boolean {
    return plan?.state === 'in_progress';
  }

  private async depositResources(cmd: Command): Promise<CommandResult> {
    const { playerId, sourceVillageId, amount } = cmd.payload as { playerId: string; sourceVillageId: string; amount: Partial<Resources> };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (this.buildingInProgress(a.researchingBuilding)) return { ok: false, payload: {}, reason: 'building_in_progress' };
    if (!this.isMember(a, playerId) || !(await this.ownedVillage(playerId, sourceVillageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const clean = cloneResources(amount); if (!RESOURCE_KEYS.some((k) => clean[k] > 0)) return { ok: false, payload: {}, reason: 'empty_deposit' };
    if (!a.hallVillageId) return { ok: false, payload: {}, reason: 'alliance_hall_required' };
    const sent = await this.commands.send({
      name: 'trade.SendAllianceResources', from: AllianceModule.NAME,
      payload: { playerId, allianceId: a.id, sourceVillageId, targetVillageId: a.hallVillageId, amount: clean },
    });
    if (!sent.ok) return { ok: false, payload: sent.payload ?? {}, reason: sent.reason ?? 'caravan_failed' };
    const deliveryId = String((sent.payload as any)?.id ?? '');
    if (!deliveryId) return { ok: false, payload: {}, reason: 'caravan_failed' };
    a.pendingResourceDeliveries ??= {};
    a.pendingResourceDeliveries[deliveryId] = {
      playerId, sourceVillageId, amount: clean,
      sentAt: this.now(), arriveAt: Number((sent.payload as any)?.arriveAt) || this.now(),
    };
    this.store.set(COLLECTION, a.id, a);
    await this.push(a);
    return { ok: true, payload: { warehouse: a.warehouse, deliveryId, arriveAt: (sent.payload as any)?.arriveAt, travelSec: (sent.payload as any)?.travelSec, routesNeeded: (sent.payload as any)?.routesNeeded } };
  }

  /** 商队抵达大厅后的最终入库；重复到达按 movement id 幂等处理。 */
  private async receiveResourceCaravan(cmd: Command): Promise<CommandResult> {
    const { allianceId, movementId, targetVillageId, cargo } = cmd.payload as { allianceId: string; movementId: string; targetVillageId?: string; cargo?: Partial<Resources> };
    const a = this.load(String(allianceId ?? ''));
    if (!a) return { ok: false, payload: {}, reason: 'alliance_not_found' };
    const pending = a.pendingResourceDeliveries?.[String(movementId ?? '')];
    if (!pending) return { ok: false, payload: {}, reason: 'alliance_delivery_not_found' };
    if (a.disconnected || !a.hallVillageId || (targetVillageId && targetVillageId !== a.hallVillageId)) {
      // 大厅失联时由 movement 带原货物返程；移除悬挂记录，避免旧商队日后重复入库。
      delete a.pendingResourceDeliveries![String(movementId)];
      this.store.set(COLLECTION, a.id, a);
      await this.push(a);
      return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    }
    const received = cloneResources(cargo);
    if (RESOURCE_KEYS.some((k) => received[k] !== pending.amount[k])) {
      delete a.pendingResourceDeliveries![String(movementId)];
      this.store.set(COLLECTION, a.id, a);
      await this.push(a);
      return { ok: false, payload: {}, reason: 'alliance_delivery_mismatch' };
    }
    a.warehouse = addResources(a.warehouse, pending.amount);
    a.resourceContributions[pending.playerId] = addResources(a.resourceContributions[pending.playerId] ?? zeroResources(), pending.amount);
    delete a.pendingResourceDeliveries![String(movementId)];
    this.store.set(COLLECTION, a.id, a);
    await this.maybeStartBuilding(a);
    await this.syncAllModifiers(a);
    await this.push(a);
    return { ok: true, payload: { warehouse: a.warehouse, delivered: pending.amount } };
  }

  /**
   * 返回指定村庄被联盟战事预定的兵力明细。预定只包含尚未派出的参与者，
   * 由 Alliance 作为计划状态的唯一所有者派生，Military 只保存数量锁。
   */
  private async getTroopReservations(cmd: Command): Promise<CommandResult> {
    const villageId = String((cmd.payload as any)?.villageId ?? '');
    if (!villageId) return { ok: true, payload: { reserved: {}, reservations: [] } };
    const reservations: any[] = [];
    for (const raw of this.store.all<AllianceState>(COLLECTION)) {
      const a = this.normalize(raw);
      if (a.disconnected) continue;
      for (const plan of Object.values(a.warPlans)) {
        for (const participant of Object.values(plan.participants ?? {})) {
          if (participant.sourceVillageId !== villageId || participant.status !== 'joined') continue;
          const member = await this.commands.send({ name: 'player.Get', from: AllianceModule.NAME, payload: { playerId: participant.playerId } });
          const player = (member.payload as any)?.player;
          reservations.push({
            allianceId: a.id, allianceName: a.name, planId: plan.id, playerId: participant.playerId,
            playerName: player?.name ?? participant.playerId, mode: plan.mode, targetKind: plan.targetKind,
            targetVillage: plan.targetVillage, targetId: plan.targetId, status: participant.status,
            troops: { ...participant.troops }, travelSec: participant.travelSec,
            joinDeadlineAt: plan.joinDeadlineAt, deadlineAt: plan.deadlineAt,
          });
        }
      }
    }
    const reserved: Record<string, number> = {};
    for (const row of reservations) for (const [code, count] of Object.entries(row.troops ?? {})) reserved[code] = (reserved[code] ?? 0) + positiveInt(count);
    return { ok: true, payload: { reserved, reservations } };
  }

  /** 王国服务资源商队抵达后的结算；不计入成员贡献，服务订单只结算一次。 */
  private async receiveServiceResources(cmd: Command): Promise<CommandResult> {
    const { allianceId, serviceOrderId, cargo } = cmd.payload as { allianceId: string; serviceOrderId: string; cargo?: Partial<Resources> };
    const a = this.load(String(allianceId ?? ''));
    const order = a?.serviceOrders?.find((item) => item.id === serviceOrderId);
    if (!a || !order) return { ok: false, payload: {}, reason: 'alliance_service_order_not_found' };
    if (order.status === 'completed') return { ok: true, payload: { alreadyCompleted: true, warehouse: a.warehouse } };
    if (order.status !== 'pending' || order.category !== 'supplies') return { ok: false, payload: {}, reason: 'alliance_service_order_invalid' };
    if (a.disconnected) {
      order.status = 'failed'; order.failureReason = 'alliance_disconnected';
      this.store.set(COLLECTION, a.id, a); await this.push(a);
      return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    }
    const received = cloneResources(cargo);
    const service = this.config.allianceServices[order.serviceCode];
    if (!service || RESOURCE_KEYS.some((key) => received[key] !== service.resources[key])) {
      order.status = 'failed'; order.failureReason = 'alliance_service_payload_mismatch';
      this.store.set(COLLECTION, a.id, a); await this.push(a);
      return { ok: false, payload: {}, reason: 'alliance_service_payload_mismatch' };
    }
    a.warehouse = addResources(a.warehouse, received);
    order.status = 'completed';
    this.store.set(COLLECTION, a.id, a);
    await this.maybeStartBuilding(a);
    await this.push(a);
    return { ok: true, payload: { warehouse: a.warehouse, delivered: received } };
  }

  private async onServiceReinforcementArrived(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { id?: string; allianceId?: string; serviceOrderId?: string };
    const allianceId = String(p.allianceId ?? '');
    const serviceOrderId = String(p.serviceOrderId ?? '');
    if (!allianceId || !serviceOrderId) return;
    const a = this.load(allianceId);
    const order = a?.serviceOrders?.find((item) => item.id === serviceOrderId);
    if (!a || !order || order.status !== 'pending') return;
    order.status = 'completed'; order.movementId = p.id ?? order.movementId;
    this.store.set(COLLECTION, a.id, a);
    await this.push(a);
  }

  /** 形象大使专属：消耗其当前声望购买王国资源或临时增援。 */
  private async buyService(cmd: Command): Promise<CommandResult> {
    const { playerId, serviceCode } = cmd.payload as { playerId: string; serviceCode: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!this.isMember(a, playerId) || !(a.roles[playerId] ?? []).includes('ambassador')) return { ok: false, payload: {}, reason: 'ambassador_required' };
    const service: AllianceServiceDef | undefined = this.config.allianceServices[serviceCode];
    if (!service) return { ok: false, payload: {}, reason: 'alliance_service_not_found' };
    if (!a.hallVillageId) return { ok: false, payload: {}, reason: 'alliance_hall_required' };
    if (this.servicePurchaseInFlight.has(a.id)) return { ok: false, payload: {}, reason: 'alliance_service_busy' };
    this.servicePurchaseInFlight.add(a.id);
    try {
      const reputation = await this.allianceReputation(a);
      if (reputation < service.reputationCost) return { ok: false, payload: {}, reason: 'insufficient_reputation' };
      const spent = await this.commands.send({ name: 'reputation.TrySpend', from: AllianceModule.NAME, payload: { playerId, amount: service.reputationCost, reason: `alliance_service:${service.code}` } });
      if (!spent.ok) return spent;
      const sequence = (a.serviceSeq ?? 0) + 1;
      a.serviceSeq = sequence;
      const order: AllianceServiceOrder = {
        id: `as-${a.id}-${sequence}`, serviceCode: service.code, serviceName: service.name,
        category: service.category, reputationCost: service.reputationCost, purchasedBy: playerId,
        purchasedAt: this.now(), status: 'pending',
      };
      a.serviceOrders = [...(a.serviceOrders ?? []).slice(-19), order];
      this.store.set(COLLECTION, a.id, a);
      const anchors = kingdomLandmarkAnchors(this.config.constants.worldW ?? 41, this.config.constants.worldH ?? 41);
      const origin = anchors.find((anchor) => anchor.id === 'kingdom-capital') ?? anchors[0]!;
      const movement = service.category === 'supplies'
        ? await this.commands.send({ name: 'movement.SendAllianceServiceResources', from: AllianceModule.NAME, payload: { allianceId: a.id, serviceOrderId: order.id, targetVillage: a.hallVillageId, fromXY: { q: origin.q, r: origin.r }, cargo: service.resources } })
        : await this.commands.send({ name: 'movement.SendAllianceReinforcement', from: AllianceModule.NAME, payload: { allianceId: a.id, serviceOrderId: order.id, targetVillage: a.hallVillageId, fromXY: { q: origin.q, r: origin.r }, troops: { [service.unitCode!]: service.unitCount }, durationSec: Number(this.config.constants.raw.kingdom_reinforcement_duration_sec) || 3600 } });
      if (!movement.ok) {
        a.serviceOrders = a.serviceOrders.filter((item) => item.id !== order.id);
        this.store.set(COLLECTION, a.id, a);
        await this.commands.send({ name: 'reputation.Adjust', from: AllianceModule.NAME, payload: { playerId, delta: service.reputationCost, reason: 'alliance_service_refund' } });
        await this.push(a);
        return { ok: false, payload: {}, reason: movement.reason ?? 'alliance_service_failed' };
      }
      order.movementId = String((movement.payload as any)?.id ?? '');
      this.store.set(COLLECTION, a.id, a);
      await this.push(a);
      return { ok: true, payload: { order, service, reputation: spent.payload, movement: movement.payload } };
    } finally {
      this.servicePurchaseInFlight.delete(a.id);
    }
  }

  private async startBuilding(cmd: Command): Promise<CommandResult> {
    const { playerId, code } = cmd.payload as { playerId: string; code: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!a || !this.hasRole(a, playerId, 'logistics')) return { ok: false, payload: {}, reason: 'logistics_or_leader_required' };
    if (this.buildingInProgress(a.researchingBuilding)) return { ok: false, payload: {}, reason: 'building_in_progress' };
    const def = this.config.allianceBuildings[code]; if (!def) return { ok: false, payload: {}, reason: 'unknown_alliance_building' };
    if (a.level < def.requiredAllianceLevel) return { ok: false, payload: {}, reason: 'alliance_level_too_low' };
    const targetLevel = (a.buildings[code] ?? 0) + 1; if (targetLevel > def.maxLevel) return { ok: false, payload: {}, reason: 'building_max_level' };
    // 尚未开工的规划可以随时改选；如果仓库已经满足新规划，则立即扣款并进入计时建造。
    a.researchingBuilding = { code, targetLevel, required: this.buildingCost(def, targetLevel), state: 'planned' };
    this.store.set(COLLECTION, a.id, a);
    await this.maybeStartBuilding(a);
    await this.syncAllModifiers(a); await this.push(a);
    return { ok: true, payload: { plan: a.researchingBuilding, warehouse: a.warehouse } };
  }

  private scheduleBuilding(a: AllianceState): void {
    const plan = a.researchingBuilding;
    if (!plan || !this.buildingInProgress(plan)) return;
    const completeAt = Number(plan.completeAt);
    const at = Number.isFinite(completeAt) && completeAt > 0 ? completeAt : this.now() + this.projectDurationMs();
    if (!plan.startedAt || !plan.completeAt) {
      plan.startedAt = this.now(); plan.completeAt = at;
      this.store.set(COLLECTION, a.id, a);
    }
    this.scheduler.cancelByOwner(`alliance-building:${a.id}`);
    this.scheduler.scheduleAt(at, () => void this.completeBuilding(a.id), `alliance-building:${a.id}`);
  }

  private async maybeStartBuilding(a: AllianceState): Promise<void> {
    const plan = a.researchingBuilding;
    if (!plan || this.buildingInProgress(plan) || !enough(a.warehouse, plan.required)) return;
    a.warehouse = subtract(a.warehouse, plan.required);
    plan.state = 'in_progress'; plan.startedAt = this.now(); plan.completeAt = this.now() + this.projectDurationMs();
    this.store.set(COLLECTION, a.id, a);
    this.scheduleBuilding(a);
  }

  private async completeBuilding(allianceId: string): Promise<void> {
    const a = this.load(allianceId); const plan = a?.researchingBuilding;
    if (!a || a.disconnected || !plan || !this.buildingInProgress(plan)) return;
    if (Number(plan.completeAt) > this.now()) { this.scheduleBuilding(a); return; }
    a.buildings[plan.code] = plan.targetLevel;
    a.researchingBuilding = null;
    this.store.set(COLLECTION, a.id, a);
    await this.syncAllModifiers(a); await this.push(a);
  }

  private async startTech(cmd: Command): Promise<CommandResult> {
    const { playerId, code } = cmd.payload as { playerId: string; code: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!a || !this.hasRole(a, playerId, 'tech')) return { ok: false, payload: {}, reason: 'tech_or_leader_required' };
    if (this.techInProgress(a.researchingTech)) return { ok: false, payload: {}, reason: 'tech_in_progress' };
    const def: AllianceTechDef | undefined = this.config.allianceTech[code]; if (!def) return { ok: false, payload: {}, reason: 'unknown_alliance_tech' };
    if (a.level < def.requiredAllianceLevel) return { ok: false, payload: {}, reason: 'alliance_level_too_low' };
    const targetLevel = (a.technologies[code] ?? 0) + 1; if (targetLevel > def.maxLevel) return { ok: false, payload: {}, reason: 'tech_max_level' };
    a.researchingTech = { code, targetLevel, required: def.techPointCost * targetLevel, state: 'planned' };
    this.store.set(COLLECTION, a.id, a);
    await this.maybeStartTech(a);
    await this.syncAllModifiers(a); await this.push(a);
    return { ok: true, payload: { plan: a.researchingTech, techPointStock: a.techPointStock } };
  }

  private scheduleTech(a: AllianceState): void {
    const plan = a.researchingTech;
    if (!plan || !this.techInProgress(plan)) return;
    const completeAt = Number(plan.completeAt);
    const at = Number.isFinite(completeAt) && completeAt > 0 ? completeAt : this.now() + this.projectDurationMs();
    if (!plan.startedAt || !plan.completeAt) {
      plan.startedAt = this.now(); plan.completeAt = at;
      this.store.set(COLLECTION, a.id, a);
    }
    this.scheduler.cancelByOwner(`alliance-tech:${a.id}`);
    this.scheduler.scheduleAt(at, () => void this.completeTech(a.id), `alliance-tech:${a.id}`);
  }

  private async maybeStartTech(a: AllianceState): Promise<void> {
    const plan = a.researchingTech;
    if (!plan || this.techInProgress(plan) || a.techPointStock < plan.required) return;
    a.techPointStock -= plan.required;
    plan.state = 'in_progress'; plan.startedAt = this.now(); plan.completeAt = this.now() + this.projectDurationMs();
    this.store.set(COLLECTION, a.id, a);
    this.scheduleTech(a);
  }

  private async completeTech(allianceId: string): Promise<void> {
    const a = this.load(allianceId); const plan = a?.researchingTech;
    if (!a || a.disconnected || !plan || !this.techInProgress(plan)) return;
    if (Number(plan.completeAt) > this.now()) { this.scheduleTech(a); return; }
    a.technologies[plan.code] = plan.targetLevel;
    a.researchingTech = null;
    this.store.set(COLLECTION, a.id, a);
    await this.syncAllModifiers(a); await this.push(a);
  }

  private async contributeTech(cmd: Command): Promise<CommandResult> {
    const { playerId, sourceVillageId, amount } = cmd.payload as { playerId: string; sourceVillageId: string; amount: number };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; const n = positiveInt(amount);
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (this.techInProgress(a.researchingTech)) return { ok: false, payload: {}, reason: 'tech_in_progress' };
    if (!this.isMember(a, playerId) || !n || !(await this.ownedVillage(playerId, sourceVillageId))) return { ok: false, payload: {}, reason: 'invalid_contribution' };
    const spend = await this.commands.send({ name: 'research.SpendPoints', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, amount: n } });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'insufficient_tech_points' };
    a.techPointStock += n; a.techContributions[playerId] = positiveInt(a.techContributions[playerId]) + n; this.store.set(COLLECTION, a.id, a); await this.maybeStartTech(a); await this.syncAllModifiers(a); await this.push(a); return { ok: true, payload: { techPointStock: a.techPointStock } };
  }

  private async createWarPlan(cmd: Command): Promise<CommandResult> {
    const { playerId, mode, targetKind, targetVillage, targetId, q, r, countdownSec, participationCountdownSec, deadlineAt: legacyDeadlineAt } = cmd.payload as { playerId: string; mode: WarPlan['mode']; targetKind: WarPlan['targetKind']; targetVillage?: string; targetId?: string; q: number; r: number; countdownSec?: number; participationCountdownSec?: number; deadlineAt?: number };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!this.hasRole(a, playerId, 'war')) return { ok: false, payload: {}, reason: 'war_or_leader_required' };
    if (!['reinforce', 'raid', 'attack'].includes(mode) || !['village', 'pve'].includes(targetKind)) return { ok: false, payload: {}, reason: 'invalid_war_plan' };
    if (mode === 'reinforce' && targetKind !== 'village') return { ok: false, payload: {}, reason: 'reinforce_village_only' };
    if ((targetKind === 'village' && !targetVillage) || (targetKind === 'pve' && !targetId)) return { ok: false, payload: {}, reason: 'war_target_required' };
    // 新客户端提交倒计时秒数；兼容旧客户端的绝对 deadlineAt，最终统一落为服务端时间点。
    const rawCountdown = Number(countdownSec);
    const legacyDeadline = Number(legacyDeadlineAt);
    const deadline = Number.isInteger(rawCountdown) && rawCountdown > 0
      ? this.now() + rawCountdown * 1000
      : legacyDeadline;
    if (!Number.isFinite(deadline) || deadline < this.now() + 10_000) return { ok: false, payload: {}, reason: 'deadline_too_soon' };
    const normalizedCountdownSec = Math.max(1, Math.ceil((deadline - this.now()) / 1000));
    const participationSec = Number(participationCountdownSec);
    const hasParticipationWindow = Number.isInteger(participationSec);
    if (hasParticipationWindow && (participationSec <= 0 || participationSec >= normalizedCountdownSec)) {
      return { ok: false, payload: {}, reason: 'participation_window_invalid' };
    }
    const effectiveParticipationSec = hasParticipationWindow ? participationSec : normalizedCountdownSec;
    const createdAt = this.now();
    let targetQ = Number.isFinite(Number(q)) ? Math.trunc(Number(q)) : 0;
    let targetR = Number.isFinite(Number(r)) ? Math.trunc(Number(r)) : 0;
    if (targetKind === 'pve' && targetId) {
      const target = await this.commands.send({ name: 'pve.GetTarget', from: AllianceModule.NAME, payload: { id: targetId } });
      if (!target.ok) return { ok: false, payload: {}, reason: 'war_target_not_found' };
      const targetData = (target.payload as any) ?? {};
      // 只有绑定到个人村庄的任务营地不能作为公共联盟战事目标。主线任务
      // 的任务村（例如天王老子村/秘密营地）虽然带有 task 标记，但任务
      // scope=global，会同步给所有玩家，仍应允许作为公共 PvE 目标。
      // 普通 PvE 营地也没有城墙/城邦身份，攻城必须在模式选择阶段被排除，
      // 服务端再次校验，避免伪造 targetKind 绕过地图选项。
      const publicTaskTypes = new Set(Object.values(this.config.quests)
        .filter((quest) => quest.scope === 'global')
        .map((quest) => quest.objective?.taskVillageCode)
        .filter((type): type is string => typeof type === 'string' && type.length > 0));
      const privateTaskTarget = targetData.task === true
        ? !publicTaskTypes.has(String(targetData.type ?? ''))
        : Boolean(targetData.ownerVillageId);
      if (privateTaskTarget) return { ok: false, payload: {}, reason: 'war_private_task_target' };
      if (mode === 'attack' && targetData.cityState !== true) return { ok: false, payload: {}, reason: 'war_siege_target_invalid' };
      targetQ = Math.trunc(Number((target.payload as any)?.q));
      targetR = Math.trunc(Number((target.payload as any)?.r));
      if (!Number.isFinite(targetQ) || !Number.isFinite(targetR)) return { ok: false, payload: {}, reason: 'war_target_not_found' };
    }
    if (targetKind === 'village' && targetVillage) {
      const targetOwner = await this.commands.send({ name: 'player.GetByVillage', from: AllianceModule.NAME, payload: { villageId: targetVillage } });
      if (!targetOwner.ok) return { ok: false, payload: {}, reason: 'war_target_not_found' };
      if (targetOwner.ok && (mode === 'raid' || mode === 'attack') && this.idForPlayer(String((targetOwner.payload as any)?.player?.id ?? '')) === a.id) return { ok: false, payload: {}, reason: 'allied_target' };
      const targetPlayer = (targetOwner.payload as any)?.player;
      const targetVillageView = (targetPlayer?.villages ?? []).find((v: any) => v.id === targetVillage);
      if (targetVillageView) { targetQ = Math.trunc(Number(targetVillageView.q)); targetR = Math.trunc(Number(targetVillageView.r)); }
      const ownerId = String((targetOwner.payload as any)?.player?.id ?? '');
      const allianceRelation = await this.commands.send({ name: 'alliance.GetRelation', from: AllianceModule.NAME, payload: { playerId, targetPlayerId: ownerId } });
      const relationResult = allianceRelation.ok && (allianceRelation.payload as any)?.relation === 'allied'
        ? allianceRelation
        : await this.commands.send({ name: 'diplomacy.GetRelation', from: AllianceModule.NAME, payload: { playerId, targetPlayerId: ownerId } });
      const relation = relationResult.ok ? String((relationResult.payload as any)?.relation ?? 'neutral') : 'neutral';
      if ((mode === 'raid' || mode === 'attack') && relation === 'allied') return { ok: false, payload: {}, reason: 'allied_target' };
      if (mode === 'reinforce' && relation === 'hostile') return { ok: false, payload: {}, reason: 'hostile_target' };
    }
    const plan: WarPlan = { id: `${a.id}-war-${Object.keys(a.warPlans).length + 1}`, mode, targetKind, targetVillage, targetId, q: targetQ, r: targetR, deadlineAt: deadline, countdownSec: normalizedCountdownSec, participationCountdownSec: effectiveParticipationSec, joinDeadlineAt: hasParticipationWindow ? createdAt + effectiveParticipationSec * 1000 : deadline, createdAt, status: 'open', participants: {} };
    a.warPlans[plan.id] = plan; this.store.set(COLLECTION, a.id, a); await this.push(a); return { ok: true, payload: { plan } };
  }

  /**
   * 计算联盟报名的权威行军预览。这里和正式报名共用同一套校验与
   * movement.PreviewMarch，避免客户端自行估算导致“界面显示可行、提交却失败”。
   * 该方法只读，不预定兵力，也不创建行军。
   */
  private async prepareWarParticipant(
    a: AllianceState,
    plan: WarPlan,
    playerId: string,
    sourceVillageId: string,
    troops: Record<string, number>,
  ): Promise<WarParticipantPreparation> {
    if (!this.isMember(a, playerId) || !(await this.ownedVillage(playerId, sourceVillageId))) {
      return { ok: false, reason: 'village_not_owned' };
    }
    const army = await this.commands.send({ name: 'military.GetArmy', from: AllianceModule.NAME, payload: { villageId: sourceVillageId } });
    const available = ((army.payload as any)?.availableTroops ?? (army.payload as any)?.troops ?? {}) as Record<string, number>;
    const cleanTroops: Record<string, number> = {};
    for (const [code, amount] of Object.entries(troops ?? {})) {
      const n = positiveInt(amount);
      if (!n) continue;
      if (!this.config.units[code] || n > positiveInt(available[code])) return { ok: false, reason: `insufficient_troops:${code}` };
      cleanTroops[code] = n;
    }
    if (!Object.keys(cleanTroops).length) return { ok: false, reason: 'empty_troops' };
    const preview = await this.commands.send({ name: 'movement.PreviewMarch', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, q: plan.q, r: plan.r, mode: plan.mode, targetVillage: plan.targetVillage, targetId: plan.targetId, troops: cleanTroops } });
    if (!preview.ok) return { ok: false, reason: preview.reason ?? 'march_preview_failed' };
    const travelMsRaw = Number((preview.payload as any)?.travelMs);
    const travelMs = Number.isFinite(travelMsRaw) && travelMsRaw > 0 ? travelMsRaw : positiveInt((preview.payload as any)?.travelSec) * 1000;
    const travelSec = Math.max(3, Math.ceil(travelMs / 1000));
    const now = this.now();
    const joinDeadlineAt = Number(plan.joinDeadlineAt ?? (plan.createdAt ?? now) + Number(plan.participationCountdownSec ?? 0) * 1000);
    const legacyWindow = Number(plan.participationCountdownSec ?? 0) >= Number(plan.countdownSec ?? 0);
    const maxTravelMs = legacyWindow ? Math.max(0, plan.deadlineAt - now) : Math.max(0, plan.deadlineAt - joinDeadlineAt);
    // 现代“两段倒计时”规则与正式报名保持严格一致：必须小于最大时长。
    const withinLimit = legacyWindow ? now + travelMs <= plan.deadlineAt : travelMs < maxTravelMs;
    return {
      ok: true,
      preview: {
        cleanTroops,
        travelMs,
        travelSec,
        maxTravelMs,
        withinLimit,
        arriveAtIfDepartNow: now + travelMs,
      },
    };
  }

  private async previewWarParticipation(cmd: Command): Promise<CommandResult> {
    const { playerId, planId, sourceVillageId, troops } = cmd.payload as { playerId: string; planId: string; sourceVillageId: string; troops: Record<string, number> };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    const plan = a.warPlans[planId]; if (!plan || plan.status !== 'open') return { ok: false, payload: {}, reason: 'war_plan_closed' };
    const joinDeadlineAt = Number(plan.joinDeadlineAt ?? (plan.createdAt ?? this.now()) + Number(plan.participationCountdownSec ?? 0) * 1000);
    if (this.now() >= joinDeadlineAt) return { ok: false, payload: {}, reason: 'war_join_deadline_passed' };
    if (plan.participants[playerId]) return { ok: false, payload: {}, reason: 'already_joined' };
    const prepared = await this.prepareWarParticipant(a, plan, playerId, sourceVillageId, troops);
    if (!prepared.ok) return { ok: false, payload: prepared.payload ?? {}, reason: prepared.reason };
    const { cleanTroops, travelMs, travelSec, maxTravelMs, withinLimit, arriveAtIfDepartNow } = prepared.preview;
    return {
      ok: true,
      payload: {
        planId,
        selectedTroops: cleanTroops,
        travelMs,
        travelSec,
        maxTravelMs,
        maxTravelSec: maxTravelMs / 1000,
        withinLimit,
        arriveAtIfDepartNow,
        coordinatedArrivalAt: plan.deadlineAt,
        joinDeadlineAt,
        deadlineAt: plan.deadlineAt,
      },
    };
  }

  private async joinWarPlan(cmd: Command): Promise<CommandResult> {
    const { playerId, planId, sourceVillageId, troops } = cmd.payload as { playerId: string; planId: string; sourceVillageId: string; troops: Record<string, number> };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    const plan = a.warPlans[planId]; if (!plan || plan.status !== 'open') return { ok: false, payload: {}, reason: 'war_plan_closed' };
    const joinDeadlineAt = Number(plan.joinDeadlineAt ?? (plan.createdAt ?? this.now()) + Number(plan.participationCountdownSec ?? 0) * 1000);
    if (this.now() >= joinDeadlineAt) return { ok: false, payload: {}, reason: 'war_join_deadline_passed' };
    if (plan.participants[playerId]) return { ok: false, payload: {}, reason: 'already_joined' };
    const prepared = await this.prepareWarParticipant(a, plan, playerId, sourceVillageId, troops);
    if (!prepared.ok) return { ok: false, payload: {}, reason: prepared.reason };
    const { cleanTroops, travelMs, travelSec, withinLimit } = prepared.preview;
    if (!withinLimit) return { ok: false, payload: { travelSec, travelMs, deadlineAt: plan.deadlineAt, joinDeadlineAt }, reason: 'war_travel_too_long' };
    const reserved = await this.commands.send({ name: 'military.ReserveTroops', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, troops: cleanTroops } });
    if (!reserved.ok) return { ok: false, payload: {}, reason: reserved.reason ?? 'insufficient_troops' };
    plan.participants[playerId] = { playerId, sourceVillageId, troops: cleanTroops, travelSec, status: 'joined' }; this.store.set(COLLECTION, a.id, a); this.scheduleParticipant(a, plan, plan.participants[playerId]!); await this.push(a); return { ok: true, payload: { plan, travelSec } };
  }

  private schedulePlan(a: AllianceState, plan: WarPlan): void { for (const p of Object.values(plan.participants)) if (p.status === 'joined') this.scheduleParticipant(a, plan, p); }
  private scheduleParticipant(a: AllianceState, plan: WarPlan, p: WarParticipant): void {
    this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${p.playerId}`);
    const triggerAt = Math.max(this.now(), plan.deadlineAt - p.travelSec * 1000);
    this.scheduler.scheduleAt(triggerAt, () => void this.dispatchParticipant(a.id, plan.id, p.playerId), `alliance-war:${plan.id}:${p.playerId}`);
  }
  private async dispatchParticipant(allianceId: string, planId: string, playerId: string): Promise<void> {
    const a = this.load(allianceId); const plan = a?.warPlans[planId]; const p = plan?.participants[playerId];
    if (!a || !plan || !p || plan.status !== 'open' || a.disconnected) return;
    const payload: any = { villageId: p.sourceVillageId, troops: p.troops, allianceReservation: { allianceId, planId, playerId } };
    let action = '';
    if (plan.mode === 'reinforce') { action = 'movement.SendReinforce'; payload.targetVillage = plan.targetVillage; }
    else if (plan.targetKind === 'pve') { action = plan.mode === 'raid' ? 'movement.SendRaid' : 'movement.SendAttack'; payload.targetId = plan.targetId; }
    else { action = plan.mode === 'raid' ? 'movement.SendVillageRaid' : 'movement.SendAttack'; payload.targetVillage = plan.targetVillage; payload.declareWar = true; }
    const result = await this.commands.send({ name: action, from: AllianceModule.NAME, payload });
    const movementId = result.ok ? String((result.payload as any)?.id ?? '') : '';
    // CancelWarPlan may have won the race while the movement command was in
    // flight. Do not resurrect a cancelled plan; best-effort recall the
    // movement that was created before cancellation became visible.
    if (plan.status !== 'open' || plan.participants[playerId] !== p) {
      if (movementId) {
        p.movementId = movementId; p.status = 'dispatched'; p.dispatchedAt = this.now();
        await this.recallParticipant(plan, p);
        if (plan.participants[playerId] === p) this.store.set(COLLECTION, a.id, a);
      } else if (plan.participants[playerId] === p && p.status === 'joined') {
        await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: p.sourceVillageId, troops: p.troops } });
        p.status = 'recalled'; p.recalledAt = this.now(); this.store.set(COLLECTION, a.id, a);
      }
      return;
    }
    p.status = result.ok && movementId ? 'dispatched' : 'failed';
    if (p.status === 'failed') {
      await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: p.sourceVillageId, troops: p.troops } });
    }
    if (p.status === 'dispatched') { p.movementId = movementId; p.dispatchedAt = this.now(); }
    this.store.set(COLLECTION, a.id, a);
    if (Object.values(plan.participants).every((x) => x.status !== 'joined')) {
      plan.status = 'dispatched';
      if (Object.values(plan.participants).some((x) => x.status === 'dispatched')) plan.allDispatchedAt = this.now();
    }
    await this.push(a);
  }

  /** 成员在报名截止前取消自己的参战报名，并立即释放服务端预备队锁。 */
  private async cancelWarParticipation(cmd: Command): Promise<CommandResult> {
    const { playerId, planId } = cmd.payload as { playerId: string; planId: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    const plan = a.warPlans[planId]; if (!plan) return { ok: false, payload: {}, reason: 'war_plan_not_found' };
    const participant = plan.participants[playerId];
    if (!participant) return { ok: false, payload: {}, reason: 'war_participation_not_found' };
    if (participant.status !== 'joined') return { ok: false, payload: {}, reason: 'war_participation_dispatched' };
    this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${playerId}`);
    await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, troops: participant.troops } });
    delete plan.participants[playerId];
    this.store.set(COLLECTION, a.id, a); await this.push(a);
    return { ok: true, payload: { plan } };
  }

  /** 盟主/战争专家在倒计时结束前取消尚未完成的集结；已发出的部队尽量复用通用撤回命令。 */
  private async cancelWarPlan(cmd: Command): Promise<CommandResult> {
    const { playerId, planId } = cmd.payload as { playerId: string; planId: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!this.hasRole(a, playerId, 'war')) return { ok: false, payload: {}, reason: 'war_or_leader_required' };
    const plan = a.warPlans[planId]; if (!plan) return { ok: false, payload: {}, reason: 'war_plan_not_found' };
    if (plan.status !== 'open' && plan.status !== 'dispatched') return { ok: false, payload: {}, reason: 'war_plan_closed' };
    const joinDeadlineAt = Number(plan.joinDeadlineAt ?? plan.deadlineAt);
    const legacyWindow = Number(plan.participationCountdownSec ?? 0) >= Number(plan.countdownSec ?? 0);
    if (legacyWindow ? this.now() >= Number(plan.deadlineAt) : (this.now() < joinDeadlineAt || this.now() - joinDeadlineAt >= 90_000)) return { ok: false, payload: {}, reason: legacyWindow ? 'war_deadline_passed' : 'war_cancel_window_expired' };
    plan.status = 'cancelled'; plan.cancelledAt = this.now();
    for (const participant of Object.values(plan.participants)) {
      if (participant.status === 'joined') {
        this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${participant.playerId}`);
        await this.commands.send({ name: 'military.ReleaseReservedTroops', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, troops: participant.troops } });
        participant.status = 'recalled'; participant.recalledAt = this.now();
      }
    }
    this.store.set(COLLECTION, a.id, a);
    const recalls = [];
    for (const participant of Object.values(plan.participants)) {
      if (participant.status !== 'dispatched' || !participant.movementId) continue;
      recalls.push(await this.recallParticipant(plan, participant));
    }
    this.store.set(COLLECTION, a.id, a); await this.push(a);
    return { ok: true, payload: { plan, recalls } };
  }

  /** 所有参与者已派出后 90 秒内，一键替成员撤回各自的军队。 */
  private async recallWarPlan(cmd: Command): Promise<CommandResult> {
    const { playerId, planId } = cmd.payload as { playerId: string; planId: string };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!this.hasRole(a, playerId, 'war')) return { ok: false, payload: {}, reason: 'war_or_leader_required' };
    const plan = a.warPlans[planId]; if (!plan) return { ok: false, payload: {}, reason: 'war_plan_not_found' };
    if (plan.status !== 'dispatched') return { ok: false, payload: {}, reason: 'war_not_dispatched' };
    const dispatchedAt = Number(plan.allDispatchedAt);
    const joinDeadlineAt = Number(plan.joinDeadlineAt ?? dispatchedAt);
    const legacyWindow = Number(plan.participationCountdownSec ?? 0) >= Number(plan.countdownSec ?? 0);
    if (!Number.isFinite(dispatchedAt) || (legacyWindow ? this.now() - dispatchedAt >= 90_000 : this.now() < joinDeadlineAt || this.now() - joinDeadlineAt >= 90_000)) return { ok: false, payload: {}, reason: 'war_recall_window_expired' };
    const recalls = [];
    for (const participant of Object.values(plan.participants)) {
      if (participant.status !== 'dispatched' || !participant.movementId) continue;
      recalls.push(await this.recallParticipant(plan, participant));
    }
    plan.status = 'cancelled'; plan.cancelledAt = this.now();
    this.store.set(COLLECTION, a.id, a); await this.push(a);
    return { ok: true, payload: { plan, recalls } };
  }

  private async recallParticipant(plan: WarPlan, participant: WarParticipant): Promise<{ playerId: string; movementId?: string; ok: boolean; reason?: string }> {
    if (!participant.movementId) return { playerId: participant.playerId, ok: false, reason: 'movement_not_found' };
    let result = await this.commands.send({ name: 'movement.RecallMarch', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, movementId: participant.movementId } });
    // 增援抵达后已驻扎，必须使用驻军专用召回命令；两者都由 Movement owner 校验 90 秒/状态。
    if (!result.ok && plan.mode === 'reinforce' && result.reason === 'use_recall_garrison') {
      result = await this.commands.send({ name: 'movement.RecallGarrison', from: AllianceModule.NAME, payload: { villageId: participant.sourceVillageId, movementId: participant.movementId } });
    }
    if (result.ok) { participant.status = 'recalled'; participant.recalledAt = this.now(); }
    return { playerId: participant.playerId, movementId: participant.movementId, ok: result.ok, ...(result.ok ? {} : { reason: result.reason ?? 'recall_failed' }) };
  }

  private async onWarMovementRecalled(evt: DomainEvent): Promise<void> {
    const movementId = String((evt.payload as any)?.id ?? ''); if (!movementId) return;
    for (const a of this.store.all<AllianceState>(COLLECTION)) {
      let changed = false;
      for (const plan of Object.values(a.warPlans)) for (const participant of Object.values(plan.participants)) {
        if (participant.movementId !== movementId || participant.status !== 'dispatched') continue;
        participant.status = 'recalled'; participant.recalledAt = this.now(); changed = true;
      }
      if (changed) { this.store.set(COLLECTION, a.id, a); await this.push(a); }
    }
  }

  private getRelation(cmd: Command): CommandResult {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    const left = this.idForPlayer(playerId), right = this.idForPlayer(targetPlayerId);
    return { ok: true, payload: { relation: left && left === right ? 'allied' : 'neutral', allianceId: left && left === right ? left : undefined } };
  }

  private async canBuildHall(cmd: Command): Promise<CommandResult> {
    let { playerId, villageId } = cmd.payload as { playerId?: string; villageId?: string };
    if (!playerId && villageId) {
      const owner = await this.commands.send({ name: 'player.GetByVillage', from: AllianceModule.NAME, payload: { villageId } });
      playerId = owner.ok ? String((owner.payload as any)?.player?.id ?? '') : '';
    }
    if (!playerId) return { ok: false, payload: { allowed: false }, reason: 'village_owner_not_found' };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a) return { ok: true, payload: { allowed: true } };
    return { ok: true, payload: { allowed: a.leaderId === playerId && !!a.disconnected } };
  }
}
