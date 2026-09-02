import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, AllianceBuildingDef, AllianceTechDef } from '../infra/config.js';

export type AllianceRole = 'logistics' | 'war' | 'tech' | 'ambassador';
type Resources = { wood: number; clay: number; iron: number; crop: number };

interface WarParticipant {
  playerId: string;
  sourceVillageId: string;
  troops: Record<string, number>;
  travelSec: number;
  status: 'joined' | 'dispatched' | 'failed';
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
  status: 'open' | 'dispatched' | 'cancelled';
  participants: Record<string, WarParticipant>;
}

interface PendingResourceDelivery {
  playerId: string;
  sourceVillageId: string;
  amount: Resources;
  sentAt: number;
  arriveAt: number;
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
}

const COLLECTION = 'alliance';
const PLAYER_INDEX = 'alliance_by_player';
const SEQ = 'alliance_seq';
const RESOURCE_KEYS = ['wood', 'clay', 'iron', 'crop'] as const;
const ROLE_LEVEL: Record<AllianceRole, number> = { logistics: 1, war: 3, tech: 5, ambassador: 7 };

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
    this.commands.register('alliance.StartBuilding', (c) => this.startBuilding(c));
    this.commands.register('alliance.StartTech', (c) => this.startTech(c));
    this.commands.register('alliance.ContributeTech', (c) => this.contributeTech(c));
    this.commands.register('alliance.CreateWarPlan', (c) => this.createWarPlan(c));
    this.commands.register('alliance.JoinWarPlan', (c) => this.joinWarPlan(c));
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
      warPlans: raw.warPlans ?? {},
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
  private roleUnlocked(a: AllianceState, role: AllianceRole): boolean { return a.level >= ROLE_LEVEL[role]; }
  private isMember(a: AllianceState, playerId: string): boolean { return a.memberIds.includes(playerId); }
  private hasRole(a: AllianceState, playerId: string, role: AllianceRole): boolean {
    return a.leaderId === playerId || (a.roles[playerId] ?? []).includes(role);
  }

  /** 成员名单使用的四个职位目录；数值从当前配置实时派生，避免前端复制一份平衡参数。 */
  private roleCatalog(a: AllianceState): Array<{ code: AllianceRole; name: string; requiredAllianceLevel: number; unlocked: boolean; effect: string; effectValue: number | string }> {
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    return [
      { code: 'logistics', name: '后勤主管', requiredAllianceLevel: ROLE_LEVEL.logistics, unlocked: this.roleUnlocked(a, 'logistics'), effect: `所有村庄资源产量 +${percent(this.config.constants.allianceLogisticsResourceMult)}`, effectValue: this.config.constants.allianceLogisticsResourceMult },
      { code: 'war', name: '战争专家', requiredAllianceLevel: ROLE_LEVEL.war, unlocked: this.roleUnlocked(a, 'war'), effect: `所有村庄军队移速 +${percent(this.config.constants.allianceWarSpeedMult)}，攻防 +${percent(this.config.constants.allianceWarCombatMult)}`, effectValue: this.config.constants.allianceWarCombatMult },
      { code: 'tech', name: '首席科技官', requiredAllianceLevel: ROLE_LEVEL.tech, unlocked: this.roleUnlocked(a, 'tech'), effect: `所有村庄科技点获得概率 +${percent(this.config.constants.allianceTechProbabilityBonus)}`, effectValue: this.config.constants.allianceTechProbabilityBonus },
      { code: 'ambassador', name: '形象大使', requiredAllianceLevel: ROLE_LEVEL.ambassador, unlocked: this.roleUnlocked(a, 'ambassador'), effect: `每次获得声望额外 +${this.config.constants.allianceAmbassadorReputationBonus}`, effectValue: this.config.constants.allianceAmbassadorReputationBonus },
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
      // 大厅失联会撤销职位加成、计划目标和未完成建设；已研发科技保留。
      a.roles = Object.fromEntries(a.memberIds.map((id) => [id, []]));
      // 保留已建建筑的目录项但将等级降为 0，便于联盟页明确显示哪些建筑
      // 已被摧毁；重连后需要重新筹资修复，而不是悄悄把它们从目录中抹掉。
      a.buildings = Object.fromEntries(Object.keys(a.buildings ?? {}).map((code) => [code, 0]));
      a.researchingBuilding = null;
      a.researchingTech = null;
      this.scheduler.cancelByOwner(`alliance-building:${a.id}`);
      this.scheduler.cancelByOwner(`alliance-tech:${a.id}`);
      for (const plan of Object.values(a.warPlans)) for (const participant of Object.values(plan.participants)) this.scheduler.cancelByOwner(`alliance-war:${plan.id}:${participant.playerId}`);
      a.warPlans = {};
    } else {
      a.disconnected = false;
      a.level = this.levelDef(hallLevel).level;
    }
    this.store.set(COLLECTION, a.id, a);
    for (const id of a.memberIds) void this.syncPlayerModifiers(id);
    await this.push(a);
  }

  private async onBuildingEvent(evt: DomainEvent, kind: 'built' | 'upgraded' | 'repaired' | 'demolished'): Promise<void> {
    const p = evt.payload as { villageId?: string; kind?: string; level?: number };
    if (p.kind !== 'alliance_hall' || !p.villageId) return;
    for (const a of this.store.all<AllianceState>(COLLECTION)) {
      if (kind === 'demolished' && a.hallVillageId === p.villageId) await this.refreshConnectivity(a);
      const owner = await this.commands.send({ name: 'player.GetByVillage', from: AllianceModule.NAME, payload: { villageId: p.villageId } });
      const playerId = owner.ok ? String((owner.payload as any)?.player?.id ?? '') : '';
      if (!playerId || a.leaderId !== playerId) continue;
      if (kind === 'built' || kind === 'upgraded' || kind === 'repaired') {
        if (!a.hallVillageId || a.disconnected || a.hallVillageId === p.villageId) {
          a.hallVillageId = p.villageId;
          a.level = this.levelDef(positiveInt(p.level) || 1).level;
          a.disconnected = false;
          this.store.set(COLLECTION, a.id, a);
          for (const id of a.memberIds) void this.syncPlayerModifiers(id);
          await this.push(a);
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

  private modifiers(a: AllianceState, playerId: string) {
    const roles = a.roles[playerId] ?? [];
    const resourceDetails: { source: string; label: string; mult: Record<string, number> }[] = [];
    const out = {
      resourceRateMult: roles.includes('logistics') ? this.config.constants.allianceLogisticsResourceMult : 0,
      warSpeedMult: roles.includes('war') ? this.config.constants.allianceWarSpeedMult : 0,
      warCombatMult: roles.includes('war') ? this.config.constants.allianceWarCombatMult : 0,
      techProbabilityBonus: roles.includes('tech') ? this.config.constants.allianceTechProbabilityBonus : 0,
      ambassadorReputationBonus: roles.includes('ambassador') ? this.config.constants.allianceAmbassadorReputationBonus : 0,
    };
    if (roles.includes('logistics') && out.resourceRateMult) {
      resourceDetails.push({ source: 'alliance:role:logistics', label: '联盟职位：后勤主管', mult: { wood: out.resourceRateMult, clay: out.resourceRateMult, iron: out.resourceRateMult, crop: out.resourceRateMult } });
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
      if (def) apply(def.effectType, def.effectValue * positiveInt(level), `联盟建筑：${def.name}`, `alliance:building:${code}`);
    }
    for (const [code, level] of Object.entries(a.technologies)) {
      const def = this.config.allianceTech[code];
      if (def) apply(def.effectType, def.effectValue * positiveInt(level), `联盟科技：${def.name}`, `alliance:tech:${code}`);
    }
    return { ...out, resourceDetails };
  }

  private async syncPlayerModifiers(playerId: string): Promise<void> {
    if (!playerId) return;
    const allianceId = this.idForPlayer(playerId);
    const a = allianceId ? this.load(allianceId) : undefined;
    const mods = a && !a.disconnected ? this.modifiers(a, playerId) : { resourceRateMult: 0, warSpeedMult: 0, warCombatMult: 0, techProbabilityBonus: 0, ambassadorReputationBonus: 0, resourceDetails: [] };
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

  private async push(a: AllianceState): Promise<void> {
    await this.bus.emit({ name: 'alliance.Updated', source: AllianceModule.NAME, ts: this.now(), payload: { allianceId: a.id, playerIds: [...a.memberIds] } } as DomainEvent);
  }

  private async list(cmd: Command): Promise<CommandResult> {
    const query = String((cmd.payload as any)?.query ?? '').trim().toLocaleLowerCase();
    const alliances = this.store.all<AllianceState>(COLLECTION).map((raw) => this.normalize(raw)).filter((a) => !query || a.name.toLocaleLowerCase().includes(query) || a.leaderName.toLocaleLowerCase().includes(query));
    return { ok: true, payload: { alliances: alliances.map((a) => ({ id: a.id, name: a.name, leaderId: a.leaderId, leaderName: a.leaderName, memberCount: a.memberIds.length, memberCap: this.cap(a), full: a.memberIds.length >= this.cap(a), level: a.level, disconnected: !!a.disconnected })) } };
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

  private async get(cmd: Command): Promise<CommandResult> {
    const playerId = String((cmd.payload as any)?.playerId ?? '');
    const id = this.idForPlayer(playerId);
    if (!id) return { ok: true, payload: { alliance: null } };
    const a = this.load(id); if (!a) return { ok: true, payload: { alliance: null } };
    await this.refreshConnectivity(a);
    const members = []; for (const memberId of a.memberIds) members.push(await this.memberView(a, memberId));
    return { ok: true, payload: { alliance: { id: a.id, name: a.name, leaderId: a.leaderId, leaderName: a.leaderName, level: a.level, memberCap: this.cap(a), disconnected: !!a.disconnected, hallVillageId: a.hallVillageId, roles: a.roles, roleCatalog: this.roleCatalog(a), members, warehouse: a.warehouse, resourceContributions: a.resourceContributions, pendingResourceDeliveries: Object.entries(a.pendingResourceDeliveries ?? {}).map(([id, delivery]) => ({ id, ...delivery })), techPointStock: a.techPointStock, technologies: a.technologies, buildings: a.buildings, buildingCatalog: Object.values(this.config.allianceBuildings), techCatalog: Object.values(this.config.allianceTech), researchingBuilding: a.researchingBuilding ?? null, researchingTech: a.researchingTech ?? null, warPlans: Object.values(a.warPlans), joinRequests: a.leaderId === playerId ? a.joinRequests : {} } } };
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
    if (a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (a.memberIds.length >= this.cap(a)) return { ok: false, payload: {}, reason: 'alliance_full' };
    a.joinRequests[playerId] = this.now(); this.store.set(COLLECTION, a.id, a); await this.push(a);
    return { ok: true, payload: { allianceId, requested: true } };
  }

  private async reviewRequest(cmd: Command): Promise<CommandResult> {
    const { playerId, applicantId, approve } = cmd.payload as { playerId: string; applicantId: string; approve: boolean };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.leaderId !== playerId) return { ok: false, payload: {}, reason: 'leader_required' };
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
    a.memberIds = a.memberIds.filter((x) => x !== playerId); delete a.roles[playerId]; this.store.delete(PLAYER_INDEX, playerId); this.store.set(COLLECTION, a.id, a); await this.syncPlayerModifiers(playerId); await this.push(a); return { ok: true, payload: { left: true } };
  }

  private async setRole(cmd: Command): Promise<CommandResult> {
    const { playerId, targetPlayerId } = cmd.payload as { playerId: string; targetPlayerId: string };
    const rawRole = (cmd.payload as any)?.role;
    const role = rawRole === undefined || rawRole === null || rawRole === '' ? null : String(rawRole) as AllianceRole;
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined;
    if (!a || a.leaderId !== playerId) return { ok: false, payload: {}, reason: 'leader_required' };
    if (!this.isMember(a, targetPlayerId)) return { ok: false, payload: {}, reason: 'member_not_found' };
    if (role !== null && !ROLE_LEVEL[role]) return { ok: false, payload: {}, reason: 'invalid_role' };
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
    a.memberIds = a.memberIds.filter((x) => x !== targetPlayerId); delete a.roles[targetPlayerId]; this.store.delete(PLAYER_INDEX, targetPlayerId); this.store.set(COLLECTION, a.id, a); await this.syncPlayerModifiers(targetPlayerId); await this.push(a); return { ok: true, payload: { removed: targetPlayerId } };
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
    const { playerId, mode, targetKind, targetVillage, targetId, q, r, deadlineAt } = cmd.payload as { playerId: string; mode: WarPlan['mode']; targetKind: WarPlan['targetKind']; targetVillage?: string; targetId?: string; q: number; r: number; deadlineAt: number };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    if (!this.hasRole(a, playerId, 'war')) return { ok: false, payload: {}, reason: 'war_or_leader_required' };
    if (!['reinforce', 'raid', 'attack'].includes(mode) || !['village', 'pve'].includes(targetKind)) return { ok: false, payload: {}, reason: 'invalid_war_plan' };
    if (mode === 'reinforce' && targetKind !== 'village') return { ok: false, payload: {}, reason: 'reinforce_village_only' };
    if ((targetKind === 'village' && !targetVillage) || (targetKind === 'pve' && !targetId)) return { ok: false, payload: {}, reason: 'war_target_required' };
    const deadline = Number(deadlineAt); if (!Number.isFinite(deadline) || deadline < this.now() + 10_000) return { ok: false, payload: {}, reason: 'deadline_too_soon' };
    let targetQ = Number.isFinite(Number(q)) ? Math.trunc(Number(q)) : 0;
    let targetR = Number.isFinite(Number(r)) ? Math.trunc(Number(r)) : 0;
    if (targetKind === 'pve' && targetId) {
      const target = await this.commands.send({ name: 'pve.GetTarget', from: AllianceModule.NAME, payload: { id: targetId } });
      if (!target.ok) return { ok: false, payload: {}, reason: 'war_target_not_found' };
      targetQ = Math.trunc(Number((target.payload as any)?.q));
      targetR = Math.trunc(Number((target.payload as any)?.r));
      if (!Number.isFinite(targetQ) || !Number.isFinite(targetR)) return { ok: false, payload: {}, reason: 'war_target_not_found' };
    }
    if (targetKind === 'village' && targetVillage) {
      const targetOwner = await this.commands.send({ name: 'player.GetByVillage', from: AllianceModule.NAME, payload: { villageId: targetVillage } });
      if (!targetOwner.ok) return { ok: false, payload: {}, reason: 'war_target_not_found' };
      if (targetOwner.ok && this.idForPlayer(String((targetOwner.payload as any)?.player?.id ?? '')) === a.id) return { ok: false, payload: {}, reason: 'allied_target' };
      const targetPlayer = (targetOwner.payload as any)?.player;
      const targetVillageView = (targetPlayer?.villages ?? []).find((v: any) => v.id === targetVillage);
      if (targetVillageView) { targetQ = Math.trunc(Number(targetVillageView.q)); targetR = Math.trunc(Number(targetVillageView.r)); }
    }
    const plan: WarPlan = { id: `${a.id}-war-${Object.keys(a.warPlans).length + 1}`, mode, targetKind, targetVillage, targetId, q: targetQ, r: targetR, deadlineAt: deadline, status: 'open', participants: {} };
    a.warPlans[plan.id] = plan; this.store.set(COLLECTION, a.id, a); await this.push(a); return { ok: true, payload: { plan } };
  }

  private async joinWarPlan(cmd: Command): Promise<CommandResult> {
    const { playerId, planId, sourceVillageId, troops } = cmd.payload as { playerId: string; planId: string; sourceVillageId: string; troops: Record<string, number> };
    const id = this.idForPlayer(playerId); const a = id ? this.load(id) : undefined; if (!a || a.disconnected) return { ok: false, payload: {}, reason: 'alliance_disconnected' };
    const plan = a.warPlans[planId]; if (!plan || plan.status !== 'open') return { ok: false, payload: {}, reason: 'war_plan_closed' };
    if (plan.participants[playerId]) return { ok: false, payload: {}, reason: 'already_joined' };
    if (!this.isMember(a, playerId) || !(await this.ownedVillage(playerId, sourceVillageId))) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const army = await this.commands.send({ name: 'military.GetArmy', from: AllianceModule.NAME, payload: { villageId: sourceVillageId } });
    const available = ((army.payload as any)?.troops ?? {}) as Record<string, number>;
    const cleanTroops: Record<string, number> = {};
    for (const [code, amount] of Object.entries(troops ?? {})) {
      const n = positiveInt(amount);
      if (!n) continue;
      if (!this.config.units[code] || n > positiveInt(available[code])) return { ok: false, payload: {}, reason: `insufficient_troops:${code}` };
      cleanTroops[code] = n;
    }
    if (!Object.keys(cleanTroops).length) return { ok: false, payload: {}, reason: 'empty_troops' };
    const preview = await this.commands.send({ name: 'movement.PreviewMarch', from: AllianceModule.NAME, payload: { villageId: sourceVillageId, q: plan.q, r: plan.r, mode: plan.mode, targetVillage: plan.targetVillage, targetId: plan.targetId, troops: cleanTroops } });
    if (!preview.ok) return { ok: false, payload: {}, reason: preview.reason ?? 'march_preview_failed' };
    const travelSec = positiveInt((preview.payload as any)?.travelSec); if (this.now() + travelSec * 1000 > plan.deadlineAt) return { ok: false, payload: { travelSec, deadlineAt: plan.deadlineAt }, reason: 'cannot_arrive_before_deadline' };
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
    const payload: any = { villageId: p.sourceVillageId, troops: p.troops };
    let action = '';
    if (plan.mode === 'reinforce') { action = 'movement.SendReinforce'; payload.targetVillage = plan.targetVillage; }
    else if (plan.targetKind === 'pve') { action = plan.mode === 'raid' ? 'movement.SendRaid' : 'movement.SendAttack'; payload.targetId = plan.targetId; }
    else { action = plan.mode === 'raid' ? 'movement.SendVillageRaid' : 'movement.SendAttack'; payload.targetVillage = plan.targetVillage; payload.declareWar = true; }
    const result = await this.commands.send({ name: action, from: AllianceModule.NAME, payload });
    p.status = result.ok ? 'dispatched' : 'failed'; this.store.set(COLLECTION, a.id, a);
    if (Object.values(plan.participants).every((x) => x.status !== 'joined')) plan.status = 'dispatched';
    await this.push(a);
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
