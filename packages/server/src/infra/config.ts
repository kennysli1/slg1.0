import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadCsv, num } from './csv.js';
import { TRAIT_EFFECTS, type TraitEffect, type UnitForm, type UnitTraitDef } from './combat-types.js';
import {
  loadBalanceOverrides,
  mergeBalanceOverrides,
  mergeOverridesIntoRows,
  saveBalanceOverrides,
  type BalanceOverrides,
  type BalanceTableMeta,
} from './balance-overrides.js';

export type { UnitTraitDef } from './combat-types.js';
export {
  loadBalanceOverrides,
  mergeBalanceOverrides,
  mergeOverridesIntoRows,
  saveBalanceOverrides,
};
export type { BalanceOverrides, BalanceTableMeta };

/**
 * 基础设施 · 配置注册表（GameConfig）
 * 启动时从 config/*.csv 加载所有游戏数据，解析成模块用的结构。
 * 模块不再硬编码 *_DEFS，而是从这里读 → 改 CSV 即改游戏，不改代码。
 *
 * 建筑成本/耗时/人口上限/产量改为「逐等级独立数值」，存于 building_levels.csv（code,level,cost*,timeSec,popCap,prod），
 * 由 GM 平衡面板逐等级编辑；buildings.csv 只保留每建筑的归属/解锁/繁荣度等静态字段。
 *
 * ── 主键与引用约定（2.0 配置规范）──────────────────────────────
 * 目录表(buildings/units/pve_targets)每行有两个标识：
 *   · id   数字主键——CSV 里**跨表引用一律用它**（requires=4:3、building=4、targetId=1）。
 *   · code 英文代码——**引擎内部与存档统一用它**（避免 kind===5 这种魔法数字、CSV 重排不破坏代码）。
 * 加载时把 CSV 里的数字引用解析回 code，所以本文件之外的代码只见 code。
 * 资源(resources)与部族(tribe)主键保持语义串(wood/romans…)，它们是 economy/wire/存档的结构属性名。
 *
 * icon 列只填**基名**（如 bld_barracks）；渲染方拼 `<美术根>/<基名>.png`（前端 artPath）。
 */

/** 建筑归属区。center=城镇中心(阀门,唯一)；inner=城内(民生研发)；outer=城外(生产量产)。 */
export type Zone = 'center' | 'inner' | 'outer';

/** 建筑某一等级的独立参数（来自 building_levels.csv，替代旧的等比公式）。 */
export interface BuildingLevelDef {
  /** 升/建到该等级的花费（4 资源）。 */
  cost: Record<string, number>;
  /** 升/建到该等级额外消耗的金币（逐等级独立，替代旧全局 goldCostPerBuild；GM 可改）。 */
  costGold: number;
  /** 升/建到该等级耗时（秒）。 */
  timeSec: number;
  /** 该等级相对上一级的「增量」人口硬上限贡献。硬上限 = Σ 每栋已建建筑 levels[1..当前等级].popCap（增量求和，1:1 等价于旧 popCapPerLevel×level）。 */
  popCap: number;
  /** 仅宝库(treasury)：该等级相对上一级的宝物栏槽位增量贡献。总槽位 = 城镇中心基础1 + Σ 1..当前等级 treasureSlots。其余建筑恒为 0。 */
  treasureSlots?: number;
  /** 仅资源田：该等级产量/小时。 */
  prod?: number;
  /** 仅仓库/粮仓(warehouse/granary)：该等级提供的仓储容量增量。总容量 = Σ 已建等级 storagePerLevel。替代旧 storageBase/growth 公式。 */
  storagePerLevel?: number;
  /** 仅城墙(wall)：该等级提供的防御加成（倍率增量）。总防御 = 1 + Σ defensePerLevel。替代旧 wallBonusPerLevel 常量。 */
  defensePerLevel?: number;
  /** 仅城镇中心(main)：该等级提供的建造加速（减少耗时比例，Lv1=0, Lv2+=每级值）。总加速 = min(cap, Σ buildSpeedupPerLevel)。替代旧 mainBuildSpeedupPerLevel 常量。 */
  buildSpeedupPerLevel?: number;
  /** 仅兵营/马厩/兵工厂(barracks/stable/workshop)：该等级提供的训练加速（减少耗时比例，Lv1=0, Lv2+=每级值）。总加速 = min(cap, Σ trainTime…)。替代旧 trainTimeReducePerLevel 常量。 */
  trainTimeReducePerLevel?: number;
  /** 仅兵营/马厩/兵工厂(barracks/stable/workshop)：该等级提供的训练降费（减少资源消耗比例，Lv1=0, Lv2+=每级值）。总降费 = min(cap, Σ trainCost…)。替代旧 trainCostReducePerLevel 常量。 */
  trainCostReducePerLevel?: number;
  /** 仅酒馆(tavern)：该等级随机任务刷新间隔(秒)，越小越频繁。 */
  taskRefreshSec?: number;
  /** 仅酒馆(tavern)：该等级酒馆同时可展示的随机任务数上限。 */
  taskMaxTasks?: number;
  /** 仅酒馆(tavern)：每个随机任务槽刷新为酒馆支线任务的概率（0..1）。 */
  taskSideQuestChance?: number;
  /** 仅保险库(vault)：该等级新增的各资源保护量；按等级累加，攻城拆除后重新计算。 */
  vaultProtectWood?: number;
  vaultProtectClay?: number;
  vaultProtectIron?: number;
  vaultProtectCrop?: number;
  vaultProtectGold?: number;
}

export interface BuildingDef {
  id: number;
  kind: string; // code
  name: string;
  icon: string; // 基名
  zone: Zone;
  /** 仅资源田：产出资源 key（wood/clay/iron/crop）；非产出建筑为 undefined。 */
  resource?: string;
  cost: (lv: number) => Record<string, number>;
  timeSec: (lv: number) => number;
  maxLevel: number;
  /** 每座村庄最多可建造数量；-1 表示不限制。 */
  maxCount: number;
  /** 建造该建筑所需的主基地最低等级；默认 1，配置中心可调。 */
  mainBaseLevel: number;
  requires: { kind: string; level: number }[]; // kind=code（由数字ID解析而来）
  /** 每级贡献的繁荣度（按建筑主题分档，见 buildings.csv）。 */
  prosperityPerLevel: number;
  /** 每级人口增长/小时（仅 main 城镇中心有意义；其他建筑留 0）。替代旧的全局 popGrowthPerHour 常数。 */
  popGrowthPerLevel: number;
  /** 逐等级参数（成本/耗时/人口上限/产量），见 building_levels.csv。 */
  levels: Record<number, BuildingLevelDef>;
  /** 前端展示用：第 1 级人口上限贡献（= levels[1]?.popCap ?? 0），卡片显示「+X/级」。 */
  popCapPerLevel: number;
  /** 前端展示用：第 1 级宝物栏槽位增量贡献（仅宝库 treasury 有值；其余建筑为 0），卡片显示「+X 宝物栏/级」。 */
  treasureSlotsPerLevel: number;
  /** 展示用简介：这栋建筑干嘛的/有什么用（点开建筑详情展示；纯文本，缺列回退空串）。 */
  desc: string;
  /** 展示用升级效果说明：每级提升什么（纯文本，缺列回退空串）。 */
  effect: string;
}

/** 宝物目录（来自 treasures.csv）。宝物属于城镇，提供持续加成或即时效果，按稀有度分档。 */
export interface TreasureDef {
  /** 数字主键（CSV id 列，跨表引用用）。 */
  id: number;
  /** 英文代码（引擎内部与存档统一用它，勿改）。 */
  code: string;
  name: string;
  icon: string; // 基名（前端拼 <美术根>/<基名>.png）
  /** 类别：economic(经济)/military(军事)/social(社会)/special(特殊)。 */
  category: string;
  /** 稀有度：common(普通)/rare(稀有)/epic(史诗)/legendary(传说)，越稀有效果越强。 */
  rarity: string;
  /**
   * 效果类型：
   *  - woodRate/clayRate/ironRate/cropRate/goldRate/allResRate：资源产出倍率加成（value=百分比，如 5=+5%）
   *  - atkMult/defMult：全军攻/防倍率加成（value=百分比）
   *  - popGrowth：人口增速倍率加成（value=百分比）
   *  - reputation：主宝物栏被动声望修正（value=整数，可为负）
   *  - instantGold：获得时立即结算一次的金币数（value=数量）
   *  - ritualBuff：使用后扣除劳动人口，全资源产量加成持续一段时间（value=百分比；时长/人口见 game_constants）
   *  - enemyCavalryDef：敌方骑兵防御倍率降低（value=百分比；绞马索使用）
   *  - honestHeart：复合效果（value=百分比，统一作用于以下四项）：全军攻击+value%、全军防御+value%、金币收入+value%、科技点判定间隔×(1-value/100)（更快）
   */
  effectType: string;
  effectValue: number;
  /** 主宝物栏被动声望修正；独立于主效果，允许为负。 */
  reputationValue?: number;
  /** NPC 售卖价（金币）。 */
  priceGold: number;
  /** 掉落/出现概率（0-1）：清理野外营地、贸易中心刷新时按此概率出现。 */
  dropRate: number;
  /** 应用方式：passive(持续加成，储存在宝物栏)/instant(获得即结算一次，如钱袋子)。 */
  applyType: string;
  equipCategory: string;
  stackGroup: string;
  effectCap: number;
  uniqueEffect: boolean;
}

/** 任务目标种类。 */
export type QuestObjectiveKind = 'submit_resources' | 'repair_buildings' | 'build_buildings' | 'population_reached' | 'resource_owned' | 'explore_tiles' | 'main_base_level' | 'clear_camp' | 'sell_discard_treasure' | 'carry_flag' | 'deliver_to_npc' | 'research_completed' | 'raid_task_village' | 'defend_task_village' | 'investigate_task_village' | 'reputation_at_most' | 'kill_units' | 'dice_match';

/** 单个任务目标。每任务恰好一个目标。 */
export interface QuestObjective {
  kind: QuestObjectiveKind;
  /** submit_resources：需上交的资源与数量（key ∈ resources.csv）。 */
  resources?: Record<string, number>;
  /** repair_buildings：必须完成修复的建筑 code 列表；每个建筑只计一次。 */
  buildingKinds?: string[];
  /** build_buildings：在指定区域新建 count 栋建筑；当前主线使用 inner（城内）。 */
  buildingZone?: 'inner' | 'outer';
  /** population_reached：人口总量达到 count。 */
  /** resource_owned：拥有指定资源 count；不扣除资源。 */
  resourceKey?: string;
  /** explore_tiles：累计已探索格数达到 count（包含城镇视野）。 */
  /** clear_camp：PvE 营地模板 code（pve_targets.csv）+ 需清理的数量。完全真实化——会在地图上生成真实营地。 */
  campTemplate?: string;
  /** sell_discard_treasure：累计出售/丢弃 count 个 minRarity 及以上品质的宝物（minRarity ∈ common/rare/epic/legendary）。 */
  minRarity?: string;
  /** 通用数量：clear_camp=清理营地数、sell_discard_treasure=宝物数量。 */
  count?: number;
  /** carry_flag：必须携带并带回的宝物代码，以及出征军队至少需要的兵力。 */
  flagCode?: string;
  minTroops?: number;
  /** deliver_to_npc：向 NPC 村庄（幸福村）运送的资源种类与数量（deliverResource∈resources.csv）。 */
  deliverResource?: string;
  deliverAmount?: number;
  /** research_completed：完成任意（或指定）科技的数量。params 为 count 或 techCode:count。 */
  researchCode?: string;
  /** raid_task_village：任务绑定的 PvE 任务村代码（运行时绑定目标实体）。 */
  taskVillageCode?: string;
  /** investigate_task_village：到达并调查任务营地（不发生战斗）。 */
  /** reputation_at_most：玩家声望值达到 threshold 或更低。 */
  threshold?: number;
  /** kill_units：累计击杀指定类别的敌方兵力（人口数）；当前支持 cavalry。 */
  unitCategory?: string;
  /** dice_match：参数为 difficulty:targetScore:winsRequired。 */
  diceDifficulty?: 'easy' | 'normal' | 'hard';
  diceTargetScore?: number;
  diceWinsRequired?: number;
}

/** 任务一个结局可获得的物品、资源和声望。 */
export interface QuestRewards {
  resources?: Record<string, number>;
  treasures?: string[];
  reputation?: number;
  /** grant_population：交付时直接加入的平民人口数量。 */
  population?: number;
  /** grant_population_growth：人口增长速率临时倍率；percent=10 表示 +10%。 */
  populationGrowth?: { percent: number; durationSec: number };
  /** grant_resource_growth：资源产量临时倍率；默认作用于四种资源，可用 resource 指定单一资源。 */
  resourceGrowth?: { percent: number; durationSec: number; resource?: string };
  /** unlock_buildings：交付时解锁指定建筑代码。 */
  buildingUnlocks?: string[];
  /** grant_research_points：交付时加入学院科研点。 */
  researchPoints?: number;
  /** 按交付时的正声望兑换无期限佣兵；兑换后声望归零。 */
  reputationMercenaryExchange?: { unitCode: string; perPoint: number };
  /** 实际结算返回的任务佣兵（不属于静态配置）。 */
  mercenaries?: Record<string, number>;
}

/** 按前置任务 m8 结局选择的奖励。key 使用 m8_success / m8_failure。 */
export interface QuestConditionalRewards {
  m8_success?: QuestRewards;
  m8_failure?: QuestRewards;
}

/** 多阶段任务的分支结局奖励（例如 S4 释放/收纳）。 */
export interface QuestChoiceReward {
  key: string;
  label: string;
  rewards: QuestRewards;
  conditionalRewards?: QuestConditionalRewards;
}

/** 任务类型：main=主线；daily=日常；side=支线。 */
export type QuestType = 'main' | 'daily' | 'side';
/** 任务归属：global=玩家全局；village=绑定某一座村庄。 */
export type QuestScope = 'global' | 'village';

/** 任务定义（来自 quests.csv）。 */
export interface QuestDef {
  id: number;
  code: string;
  /** 所属任务线 code（与 quests.csv / questGraph 保持一致）。 */
  lineCode: string;
  name: string;
  desc: string;
  type: QuestType;
  /** 主线固定为 global；日常固定为 village；支线可由 CSV 配置。 */
  scope: QuestScope;
  /** 主线前置：必须完成这些 code 才能解锁（科技树式）。随机任务为空。 */
  requires: string[];
  /** 接取任务时一次性支付的资源；为空表示免费。 */
  acceptCost?: Record<string, number>;
  /** 目标（v1 单目标）。 */
  objective: QuestObjective;
  /** 奖励：资源(含金币)与/或任务专属宝物(强制 locked，不可出售/遗弃/丢失/超时)。 */
  rewards: QuestRewards;
  /** 任务失败时保留/获得的资源、宝物和声望。 */
  failureRewards?: QuestRewards;
  /** 按前置任务结局选择的奖励（例如 m8 成功/失败影响 m9）。 */
  conditionalRewards?: QuestConditionalRewards;
  /** 多阶段任务各分支的结局奖励预览。 */
  choiceRewards?: QuestChoiceReward[];
  /** 随机任务刷新权重（越大越常出现）；主线忽略。 */
  weight: number;
  /** 触发条件（仅随机任务）：如 `building_built:treasury`=建造完成宝库后出现在酒馆；空=无触发（常驻可刷）。 */
  trigger?: string;
  repeatable: boolean;
  cooldownSec: number;
  abandonCooldownSec: number;
  dailyRewardGroup?: string;
  dailyRewardValue: number;
  campSearchRadius: number;
  campRetrySec: number;
  campMaxRadius: number;
}

/**
 * 声明式任务图。CSV 是策划事实源；QuestDef 是为旧任务运行时编译出的兼容快照。
 * 任务 owner 不保存定义，存档只保存玩家进度与已绑定的目标实体。
 */
export interface QuestLineDef {
  code: string;
  name: string;
  kind: 'main' | 'daily' | 'side';
  entryQuest: string;
  order: number;
}

export interface QuestGraphQuestDef {
  id: number;
  code: string;
  lineCode: string;
  name: string;
  desc: string;
  type: QuestType;
  scope: QuestScope;
  /** 接取任务时一次性支付的资源；来自 quests.csv 的 acceptCost 列。 */
  acceptCost?: Record<string, number>;
  weight: number;
  repeatable: boolean;
  cooldownSec: number;
  abandonCooldownSec: number;
}

export interface QuestConditionDef {
  id: string;
  questCode: string;
  phase: 'offer' | 'accept' | 'success' | 'failure';
  group: string;
  kind: string;
  value: string;
}

export interface QuestObjectiveDef {
  id: string;
  questCode: string;
  kind: QuestObjectiveKind;
  params: string;
  order: number;
}

export interface QuestEffectDef {
  id: string;
  questCode: string;
  phase: 'accept' | 'success' | 'failure' | 'deliver';
  kind: string;
  params: string;
  order: number;
}

export interface QuestEdgeDef {
  id: string;
  fromQuest: string;
  toQuest: string;
  relation: 'requires' | 'success_unlock' | 'failure_unlock';
  order: number;
}

export interface QuestGraphDef {
  lines: Record<string, QuestLineDef>;
  quests: Record<string, QuestGraphQuestDef>;
  conditions: QuestConditionDef[];
  objectives: QuestObjectiveDef[];
  effects: QuestEffectDef[];
  edges: QuestEdgeDef[];
}

/** 对话中的一个玩家回复选项（由 dialogues.csv 的 replies 列解析）。 */
export interface DialogueReplyDef {
  key: string;
  label: string;
}

/** 绑定到任务触发点的 NPC 对话 session 定义。对话本身不写入存档。 */
export interface DialogueDef {
  id: number;
  code: string;
  taskCode: string;
  trigger: string;
  /** 同一对话对象内的顺序，从 1 开始；旧配置缺列时默认为 1。 */
  segment: number;
  npcName: string;
  npcText: string;
  replies: DialogueReplyDef[];
}

/** 城镇中心某等级开放的槽位数（来自 town_center_slots.csv）。 */
export interface TownCenterSlotTier {
  inner: number;
  outer: number;
  queue: number;
}

export interface UnitDef {
  id: number;
  key: string; // code
  tribe: string;
  name: string;
  icon: string; // 基名
  /** 形态：melee(近战/前排) / ranged(远程/后排)。取代旧的 cat。 */
  form: UnitForm;
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  /** 阶段化战斗模拟器的生命值伤亡池。 */
  hp: number;
  speed: number;
  /** 地图视野半径（格）。 */
  vision: number;
  carry: number;
  upkeep: number;
  cost: Record<string, number>;
  trainSec: number;
  building: string; // 所需建筑 code（由数字ID解析而来）
  /** 特性 code 列表（由 units.csv 的数字 traits 引用解析而来；可空）。 */
  traits: string[];
  /** 阶段化战斗模拟器专用特性引用；不改变主战斗旧特性语义。 */
  simTraits?: string[];
  /** 训练时扣除的人口数量（消耗玩家的 currentPop）。 */
  popCost: number;
  /** units.csv 是否显式提供 popCost；缺列/空值时行军按1人口回退并记录警告。 */
  popCostConfigured?: boolean;
  /** 是否雇佣兵（tribe=merc）：不耗粮、不占人口、金币购买；营地购买的服役期限由 contractSec 管理，任务奖励可直接授予无期限兵力。 */
  isMercenary?: boolean;
  /** 雇佣兵单价（金币）。仅 isMercenary=true 时有意义。 */
  goldCost?: number;
  commandCost?: number;
  contractSec?: number;
  mercTier?: number;
}

export interface PveTemplate {
  id: number;
  type: string; // code
  name: string;
  icon: string; // 基名
  /** 阵营；普通 PvE 为 neutral，王国城邦为 kingdom。 */
  faction?: 'neutral' | 'kingdom';
  /** 王国城邦使用运行时随机资源、兵力与建筑生成。 */
  cityState?: boolean;
  /** 王国 PvE 生成档位：普通城邦、统一标准封地或更高标准王都。 */
  kingdomProfile?: 'city_state' | 'fief' | 'capital';
  defender: Record<string, {
    count: number;
    form: UnitForm;
    meleeAtk: number;
    rangedAtk: number;
    meleeDef: number;
    rangedDef: number;
    hp?: number;
    carry: number;
    traitCodes?: string[];
  }>;
  loot: Record<string, number>;
  respawnSec: number;
}

export interface PveSpawn {
  id: string;
  type: string; // pve 目标 code（由数字ID解析而来）
  q: number; // 六边形轴坐标
  r: number;
}

/** 开局模板：按部族定义预置建筑布局/初始资源。来自 village_templates.csv。 */
export interface VillageTemplate {
  tribe: string;
  /** 开局预置建筑：{ code -> 等级 }（zone 由 buildings.csv 自动归区；资源田用 0 级=未开发占位）。 */
  startPlaced: Record<string, number>;
  /** 初始资源覆盖（空则各资源用 constants.start_resource_amount） */
  startResources: Record<string, number> | null;
  /** 开局被破坏到 0 级、可一次性修复到目标等级的建筑。 */
  startDamaged: Record<string, number>;
}

/**
 * 全局常量集合（来自 game_constants.csv）。
 * 强类型暴露逻辑常用项，避免各模块各写各的 magic number；
 * 同时保留 raw 便于校验与调试。
 */
export interface GameConstants {
  wallBonusPerLevel: number;
  mainBuildSpeedupPerLevel: number;
  mainBuildSpeedupCap: number;
  /** 军事建筑每级训练提速比例 + 上限（与 main_build_speedup 同形态，作用于该建筑训练兵种）。 */
  trainTimeReducePerLevel: number;
  trainTimeReduceCap: number;
  /** 军事建筑每级训练降费比例 + 上限（作用于该建筑训练兵种的资源消耗）。 */
  trainCostReducePerLevel: number;
  trainCostReduceCap: number;
  storageBase: number;
  storageGrowthPerLevel: number;
  startResourceAmount: number;
  /** 金币：每个劳动人口每小时交税金币数（绑定城镇中心，与人口增速同节奏，不受繁荣度影响）。 */
  goldTaxPerCivilianPerHour: number;
  /** 金币：新村初始金币存量。 */
  startGoldAmount: number;
  baseProductionPerHour: number;
  mapSize: number;
  mapViewRadius: number;
  /** 环绕平行四边形世界尺寸（axial q 周期 worldW、r 周期 worldH）。 */
  worldW: number;
  worldH: number;
  /** 战斗每 tick 间隔(ms)：越小越平滑越费算力（08设计§4.4 的 dt）。 */
  combatTickMs: number;
  /** 战斗全局强度系数 k：越大减员越快、战斗越短（08设计§4.4 的 k）。 */
  combatStrength: number;
  /** 基础战斗价值/人口的参考点；用于映射有效战斗人口。 */
  combatInfluenceReferenceValue: number;
  /** 战斗质量指数；>1 放大高质量兵种、压低低质量兵种。 */
  combatInfluenceQualityExponent: number;
  combatInfluenceMinQuality: number;
  combatInfluenceMaxQuality: number;
  combatValueMeleeAttackWeight: number;
  combatValueRangedAttackWeight: number;
  combatValueMeleeDefenseWeight: number;
  combatValueRangedDefenseWeight: number;
  combatValueHpWeight: number;
  /** 阶段化战斗模拟器：第三阶段全军近战互殴轮数。 */
  battleSimulatorMeleeRounds: number;
  /** 阶段化战斗模拟器各步骤伤害系数。默认均为 1，便于数值测试时独立调节。 */
  battlePhaseCavalryVsCavalryCoeff: number;
  battlePhaseCavalryVsMeleeCoeff: number;
  battlePhaseCavalryVsRangedCoeff: number;
  battlePhaseRangedStrikeCoeff: number;
  battlePhaseMeleeRoundCoeff: number;
  /** 攻城最终阶段比较浮点数时的相等容差。 */
  battlePhaseCompareEpsilon: number;
  /** 攻城最终阶段胜方至少保留的单位数。 */
  battlePhaseMinSurvivorUnits: number;
  /** 伏击方攻击加成（0.5=+50%），仅在伏击战结算时生效。 */
  ambushAttackBonus: number;
  /** 行军速度全局倍率（march_speed_multiplier）：>1加速、<1减速、1=原速。 */
  marchSpeedMultiplier: number;
  /** 森林方向视野衰减格数（仅军队视野）。 */
  forestVisionPenalty: number;
  /** 丘陵军队视野额外增加格数。 */
  hillsVisionBonus: number;
  /** 丘陵军队行军速度倍率（默认 2/3，即速度减少 1/3）。 */
  hillsMarchSpeedMultiplier: number;
  /** 军队规模减速：免惩罚的人口基准。 */
  marchSizeReferencePop: number;
  /** 军队规模减速：超出基准人口后的惩罚系数。 */
  marchSizePenalty: number;
  /** 军队规模减速：速度倍率下限。 */
  marchSizeMinMultiplier: number;
  /** 骑兵兵种代码（由 cavalry_unit_codes 以 | 分隔配置），用于猎马人任务与绞马索效果。 */
  cavalryUnitCodes: string[];
  /** 行军点：基础值 + 集结点等级 × 每级增量，限制同时离城的军队数。 */
  marchPointBase: number;
  marchPointPerRallypointLevel: number;
  /** 每个村庄最多保留的通知/战报条数。 */
  notificationsPerVillage: number;
  /** PvE 战利品随机浮动幅度（0.2=±20%，均值不变；确定性 LCG 取种，可复现）。 */
  pveLootVariance: number;
  /** 王国城邦：地图额外生成数量。 */
  kingdomCityStateCount: number;
  /** 王国城邦：四类基础资源随机上下限。 */
  kingdomCityStateResourceMin: number;
  kingdomCityStateResourceMax: number;
  /** 王国城邦：金币随机上下限。 */
  kingdomCityStateGoldMin: number;
  kingdomCityStateGoldMax: number;
  /** 王国城邦：每点资源折算的守军数量，随后受最小/最大兵力限制。 */
  kingdomCityStateTroopsPerResource: number;
  kingdomCityStateTroopMin: number;
  kingdomCityStateTroopMax: number;
  /** 王国城邦：守军中用于侦察战的侦察兵比例。 */
  kingdomCityStateScoutRatio: number;
  /** 王国城邦：参与掠夺防守的守军比例随机上下限。 */
  kingdomCityStateRaidDefenseMinRatio: number;
  kingdomCityStateRaidDefenseMaxRatio: number;
  /** 王国城邦：兵力恢复随机时长与资源额外恢复时长。 */
  kingdomCityStateRecoveryMinSec: number;
  kingdomCityStateRecoveryMaxSec: number;
  kingdomCityStateRecoveryResourceExtraSec: number;
  /** 王国城邦：侦察战/掠夺/攻城触发的声望扣除绝对值。 */
  kingdomCityStateReputationPenalty: number;
  /** 王国城邦：资源田保底等级。 */
  kingdomCityStateResourceFieldLevel: number;
  /** 王国城邦：城内/城外随机建筑数量和等级范围。 */
  kingdomCityStateInnerBuildingCountMin: number;
  kingdomCityStateInnerBuildingCountMax: number;
  kingdomCityStateOuterBuildingCountMin: number;
  kingdomCityStateOuterBuildingCountMax: number;
  kingdomCityStateBuildingLevelMin: number;
  kingdomCityStateBuildingLevelMax: number;
  /** 王国城邦：以 | 分隔的随机池；空/无效项由运行时过滤。 */
  kingdomCityStateUnitPool: string[];
  kingdomCityStateInnerBuildingPool: string[];
  kingdomCityStateOuterBuildingPool: string[];
  /** 王国城邦：生成规则版本；提升后启动时重生成既有城邦。 */
  kingdomCityStateGenerationVersion: number;
  /** 王国城邦：等级 1/2/3 的随机权重。 */
  kingdomCityStateTierWeights: Record<1 | 2 | 3, number>;
  /** 王国城邦：随机种族与各族兵种池。 */
  kingdomCityStateTribePool: string[];
  kingdomCityStateUnitPools: Record<'romans' | 'gauls' | 'teutons', string[]>;
  /** 王国城邦：三级城邦每种兵的数量、四类资源和金币范围。 */
  kingdomCityStateTier1UnitCount: number;
  kingdomCityStateTier1UnitMin: number;
  kingdomCityStateTier1UnitMax: number;
  kingdomCityStateTier1ResourceMin: number;
  kingdomCityStateTier1ResourceMax: number;
  kingdomCityStateTier1GoldMin: number;
  kingdomCityStateTier1GoldMax: number;
  kingdomCityStateTier2UnitCount: number;
  kingdomCityStateTier2UnitMin: number;
  kingdomCityStateTier2UnitMax: number;
  kingdomCityStateTier2ResourceMin: number;
  kingdomCityStateTier2ResourceMax: number;
  kingdomCityStateTier2GoldMin: number;
  kingdomCityStateTier2GoldMax: number;
  kingdomCityStateTier3UnitCount: number;
  kingdomCityStateTier3UnitMin: number;
  kingdomCityStateTier3UnitMax: number;
  kingdomCityStateTier3ResourceMin: number;
  kingdomCityStateTier3ResourceMax: number;
  kingdomCityStateTier3GoldMin: number;
  kingdomCityStateTier3GoldMax: number;
  /** 王国封地/王都高等级 PvE 档位：每种兵数量、资源与金币范围。 */
  kingdomFiefUnitCount: number;
  kingdomFiefUnitMin: number;
  kingdomFiefUnitMax: number;
  kingdomFiefResourceMin: number;
  kingdomFiefResourceMax: number;
  kingdomFiefGoldMin: number;
  kingdomFiefGoldMax: number;
  kingdomCapitalUnitCount: number;
  kingdomCapitalUnitMin: number;
  kingdomCapitalUnitMax: number;
  kingdomCapitalResourceMin: number;
  kingdomCapitalResourceMax: number;
  kingdomCapitalGoldMin: number;
  kingdomCapitalGoldMax: number;
  /** 王国 PvE 声望惩罚：每累计消灭的人口数扣 1 点；每累计扣除多少点触发一次报复检查。 */
  kingdomPveKilledPopulationPerReputation: number;
  kingdomPveRetaliationChunk: number;
  kingdomPveRetaliationRaidThreshold: number;
  kingdomPveRetaliationSiegeThreshold: number;
  /** 封地派出的雇佣军占封地守军总兵力的随机比例。 */
  kingdomFiefMercenaryMinRatio: number;
  kingdomFiefMercenaryMaxRatio: number;
  /** 人口：劳动人口占总人口比例达到此值时，繁荣度额外加成达到上限（默认 0.70）。 */
  popProsperityFullRatio: number;
  /** 人口：繁荣度满值时对资源/建造/训练/研究速度的额外加成（默认 +30%=0.30）。 */
  popProsperityMaxBonus: number;
  /** 人口：超上限惩罚拐点；totalPop/hardCap 达到此比例时繁荣度额外加成归零（默认 2.0=超出一倍）。 */
  popOvercapPenaltyFullRatio: number;
  /** 人口：各部族最大动员比例（士兵占总人口的上限）；条顿0.80/高卢0.70/罗马0.75；超过则禁止继续征兵。 */
  popRaceMobilizeMax: { romans: number; gauls: number; teutons: number };
  /** 人口：劳动人口每小时消耗粮食量（平民口粮；士兵口粮见兵种 upkeep）。 */
  popCropPerLabor: number;
  /** 人口：净粮赤字→减员速率比例（值越大粮仓耗尽后减员越快；v2已拍板=0.5）。 */
  popDeathRateFactor: number;
  /** 人口：饥荒减员定时任务间隔（秒；默认 300=5 分钟）。 */
  popFamineTickSec: number;
  /** 人口：医院 1 级回收战死士兵人口的比例（即时回收，无伤兵池）。 */
  popHospitalRecoveryBase: number;
  /** 人口：医院每级额外回收比例。 */
  popHospitalRecoveryPerLevel: number;
  /** 人口：医院回收比例上限。 */
  popHospitalRecoveryMax: number;
  /** 拓荒：出发村主基地最低等级。 */
  foundMinMainLevel: number;
  /** 拓荒：所需拓荒者数量。 */
  foundSettlerCount: number;
  /** 拓荒：第2村开城包（单资源）。 */
  foundResourceCostBase: number;
  /** 拓荒：开城包递增底数（第N村 = base × growth^(N-2)）。 */
  foundResourceCostGrowth: number;
  /** 拓荒：与任意已有村庄的最小六边形距离。 */
  foundMinTileDistance: number;
  /** 拓荒：每玩家同时在途拓荒行军上限。 */
  foundMaxInflight: number;
  /** 分城新建后禁止放弃的秒数。 */
  foundAbandonLockSec: number;
  /** 贸易：每条贸易路线可运送的货物单位数（wood/clay/iron/crop/gold 各计 1 单位）。 */
  tradeRouteCapacity: number;
  /** 贸易：商人车队行进速度（格/小时），独立于行军速度倍率。 */
  tradeCaravanSpeed: number;
  /** 贸易：NPC 订单中每个资源单位的金币基准价值（买/卖统一计价）。 */
  tradeNpcGoldPerResource: number;
  /** 贸易：玩家向 NPC 出售资源换取金币时的折价（NPC 赚差价）。 */
  tradeNpcSellMargin: number;
  /** 贸易：每个村庄同时可挂出的玩家贸易订单上限。 */
  tradeOrderMaxPerVillage: number;
  /** 贸易：玩家贸易订单未被人接受时的存活时长（秒），超时自动下架。 */
  tradeOrderTtlSec: number;
  /** 宝物掉落：清理野外营地后掉落宝物的总体概率（0-1）。 */
  treasureCampDropChance: number;
  /** 宝物：贸易中心 NPC 订单池中出现「宝物出售」订单的概率（0-1）。 */
  treasureNpcOfferChance: number;
  /** 宝物：NPC 出售宝物的加价倍率（买价 = 目录价 priceGold × 此值，向上取整；卖出回收价 = priceGold）。 */
  treasureNpcBuyMarkup: number;
  /** 宝物：军队带回的待领取宝物确认超时（秒）。超时未确认则由服务端自动遗弃。 */
  treasureClaimTimeoutSec: number;
  /** 宝物：军队携带宝物的容量换算——每多少兵力 +1 携带格（与 treasureCarryMaxSlots 取 min 得实际上限）。 */
  treasureCarryTroopsPerSlot: number;
  /** 宝物：军队携带宝物格数硬上限（实际携带上限 = min(此值, floor(总兵力 / treasureCarryTroopsPerSlot))）。 */
  treasureCarryMaxSlots: number;
  /** 祭祀台（ritualBuff）buff 持续时长（秒；默认 7200=2 小时）。 */
  ritualBuffDurationSec: number;
  /** 祭祀台（ritualBuff）使用时扣除的劳动人口数（不足则扣除士兵）。 */
  ritualBuffPopCost: number;
  /** 炼金炉：三个同品质宝物炼化所需时间（秒）。 */
  alchemyRefineSec: number;
  /** 声望：S4 释放被囚禁的娜塔莉们时的声望值变化。 */
  reputationS4ReleaseDelta: number;
  /** 声望：正声望攻击负声望目标的门槛（目标声望严格小于负门槛）。 */
  reputationGoodPvpTargetThreshold: number;
  /** 声望：正声望玩家每消灭十点敌方士兵人口获得的声望值。 */
  reputationGoodPvpReward: number;
  /** 声望：负声望攻击正声望目标的门槛（目标声望严格大于门槛）。 */
  reputationEvilPvpTargetThreshold: number;
  /** 声望：负声望玩家每消灭十点敌方士兵人口增加的负声望绝对值。 */
  reputationEvilPvpReward: number;
  reputationGoodPopGrowthPerPoint: number;
  reputationGoodPopGrowthCap: number;
  reputationEvilPopGrowthPenaltyPerPoint: number;
  reputationEvilPopGrowthPenaltyCap: number;
  /** 声望：每点负声望带来的军队攻击倍率加成。 */
  reputationEvilArmyAttackPerPoint: number;
  /** 声望：负声望军队攻击倍率加成上限。 */
  reputationEvilArmyAttackCap: number;
  /** 声望：每点负声望带来的军队防御倍率加成。 */
  reputationEvilArmyDefensePerPoint: number;
  /** 声望：负声望军队防御倍率加成上限。 */
  reputationEvilArmyDefenseCap: number;
  reputationGoodGoldTaxPenaltyPerPoint: number;
  reputationGoodGoldTaxPenaltyCap: number;
  reputationEvilPveDropRatePerPoint: number;
  reputationEvilPveDropRateCap: number;
  /** PvP 掠夺/攻城：每拆除建筑一级所需的战力阈值。 */
  pvpRaidPowerPerBuildingLevel: number;
  pvpSiegePowerPerBuildingLevel: number;
  pvpSiegeWeaponPowerPerBuildingLevel: number;
  /** 攻城可从仓库/粮仓取走的存量比例。 */
  pvpSiegeStorageLootRatio: number;
  /** m8：接受任务后任务村发动攻城的延迟（秒）。 */
  m8AttackDelaySec: number;
  /** m8：任务村相对玩家主城的随机生成半径（格）。 */
  m8TaskVillageSpawnRadius: number;
  /** m8：任务村各资源初始库存。 */
  m8TaskVillageResourceAmount: number;
  /** m8：任务村初始金币。 */
  m8TaskVillageGold: number;
  /** 原始 key->value（含未被强类型收录的扩展项） */
  raw: Record<string, number | boolean | string>;
}

/** 雇佣兵营地某等级的刷新参数（来自 merc_camp.csv）。 */
export interface MercCampLevel {
  /** 自动刷新间隔（秒）。 */
  refreshSec: number;
  /** 每次刷新刷出的可雇佣名额数。 */
  mercCount: number;
  /** 可存储的刷新次数上限（玩家手动点刷新消耗，营地自动刷新累积）。 */
  maxStoredRefreshes: number;
  capacity: number;
}

/** 贸易中心某等级的参数（来自 trade_center.csv）。 */
export interface TradeCenterLevel {
  /** 本村拥有的贸易路线数（派商队消耗，商队返回回收）。 */
  tradeRoutes: number;
  /** 可看见/接受贸易对象的最大六边形距离（格），等级越高看得越远。 */
  tradeViewRadius: number;
  /** 同时可见的 NPC 订单数量。 */
  npcOrderCount: number;
  /** NPC 订单自动刷新间隔（秒）。 */
  npcRefreshSec: number;
  /** 可囤积的手动刷新次数上限。 */
  npcStoredRefreshes: number;
}

export type KingdomServiceCategory = 'reinforcement' | 'attack' | 'supplies' | 'treasure';

/** 议会厅可购买服务；所有价格、门槛、数量与延迟来自 kingdom_services.csv。 */
export interface KingdomServiceDef {
  id: number;
  code: string;
  name: string;
  category: KingdomServiceCategory;
  minCouncilLevel: number;
  reputationCost: number;
  unitCode?: string;
  unitCount: number;
  resources: Record<string, number>;
  treasureCode?: string;
  delaySec: number;
  desc: string;
}

// ── 科研系统 ──

export type TechBranch = 'military' | 'production' | 'social';
export type TechEffectType = 'resource_rate' | 'unit_unlock' | 'building_unlock' | 'pop_growth' | 'storage_cap' | 'combat_atk' | 'combat_def' | 'train_speed' | 'build_speed' | 'march_speed' | 'carry_cap' | 'mechanism';
export type TechScope = 'village' | 'player';

export interface ResearchDef {
  id: number;
  code: string;
  name: string;
  branch: TechBranch;
  tier: number;
  /** 研发该科技所需的主基地最低等级；默认 1，配置中心可调。 */
  mainBaseLevel: number;
  /** 前置科技 code 列表。支持 AND（| 分隔）和 OR（OR 分隔）。 */
  requires: string[];
  desc: string;
  effectType: TechEffectType;
  effectKey: string;
  effectValue: number;
  scope: TechScope;
  /** 研发耗时（秒）。 */
  durationSec: number;
  /** 消耗科研点数。 */
  rpCost: number;
  icon: string;
  effects: ResearchEffectDef[];
}

export interface ResearchEffectDef {
  techCode: string;
  order: number;
  effectType: TechEffectType;
  effectKey: string;
  effectValue: number;
  cap: number;
}

export interface AcademyDef {
  level: number;
  /** 判定间隔（秒），多学院时除以数量。 */
  checkIntervalSec: number;
  /** 基础产出概率（0-1）。 */
  baseProbability: number;
  /** 每次失败累加的概率。 */
  probabilityGainPerFail: number;
  /** 概率上限 (= 保底线)。 */
  maxProbability: number;
  /** 总人口对科研点判定的影响系数：概率/间隔因子 = 1 + popFactor × clamp(totalPop/hardCap,0,1)。 */
  popFactor: number;
}

export interface GameConfig {
  resources: { key: string; name: string; icon: string }[];
  buildings: Record<string, BuildingDef>;
  /** 城镇中心等级 → 槽位配额（town_center_slots.csv），索引 = tcLevel（1..maxLevel）。 */
  townCenterSlots: Record<number, TownCenterSlotTier>;
  units: Record<string, UnitDef>;
  /** 雇佣兵营地刷新参数（merc_camp.csv）：level → 参数。 */
  mercCamp: Record<number, MercCampLevel>;
  /** 贸易中心逐级参数（trade_center.csv）：level → 参数。 */
  tradeCenter: Record<number, TradeCenterLevel>;
  /** 议会厅服务目录（kingdom_services.csv）：code → 服务定义。 */
  kingdomServices: Record<string, KingdomServiceDef>;
  /** 兵种特性表（unit_traits.csv），按 code 索引。 */
  unitTraits: Record<string, UnitTraitDef>;
  pveTemplates: Record<string, PveTemplate>;
  pveSpawns: PveSpawn[];
  constants: GameConstants;
  villageTemplates: Record<string, VillageTemplate>;
  /** 宝物目录（treasures.csv）：code → TreasureDef。 */
  treasures: Record<string, TreasureDef>;
  /** 科技目录（research.csv）：code → ResearchDef。 */
  research: Record<string, ResearchDef>;
  /** 学院 RP 生产参数（academy.csv）：level → AcademyDef。 */
  academy: Record<number, AcademyDef>;
  /** 任务目录（quests.csv）：code → QuestDef。 */
  quests: Record<string, QuestDef>;
  /** 任务线/条件/目标/效果/关系边：GM 审查与后续声明式引擎的唯一设计事实源。 */
  questGraph: QuestGraphDef;
  /** 对话目录（dialogues.csv）：按任务 code + trigger 查找有序对话段落组。 */
  dialogues: Record<string, DialogueDef>;
  pvpPowerCurve: { maxRatio: number; lootMult: number }[];
}

/** 解析 game_constants.csv 的一行值（按 type 列转型）。 */
function parseConstantValue(raw: string, type: string): number | boolean | string {
  if (type === 'bool') return raw === 'true' || raw === '1';
  if (type === 'string') return raw;
  return num(raw);
}

function parseConstantList(raw: unknown, fallback: string): string[] {
  const value = typeof raw === 'string' && raw.trim() ? raw : fallback;
  return value.split('|').map((item) => item.trim()).filter(Boolean);
}

/** 解析王国城邦等级权重："1:1|2:1|3:1"。非法/非正权重由调用方按默认值补齐。 */
function parseCityStateTierWeights(raw: unknown): Record<1 | 2 | 3, number> {
  const out: Record<1 | 2 | 3, number> = { 1: 1, 2: 1, 3: 1 };
  if (typeof raw !== 'string') return out;
  for (const part of raw.split('|')) {
    const [tierText, weightText] = part.split(':');
    const tier = Number(tierText), weight = Number(weightText);
    if ((tier === 1 || tier === 2 || tier === 3) && Number.isFinite(weight) && weight >= 0) out[tier] = weight;
  }
  return out;
}

/** 解析 "main:1|rallypoint:1" → { main:1, rallypoint:1 }。 */
function parseLeveledList(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const part of s.split('|')) {
    const [code, lv] = part.split(':');
    if (code) out[code.trim()] = num(lv, 1);
  }
  return out;
}

/** 解析 "wood:750|clay:750" → { wood:750, clay:750 }；空串返回 null（表示用全局默认）。 */
function parseResourceList(s: string): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const part of s.split('|')) {
    const [code, amt] = part.split(':');
    if (code) out[code.trim()] = num(amt);
  }
  return out;
}

/**
 * 解析任务人口增长奖励参数。
 * GM/CSV 统一推荐 `percent:durationSec`（例如 `10:86400` = +10% 持续24小时），
 * 同时兼容带字段名的 `percent:10|durationSec:86400`，便于人工审查时不混淆列含义。
 */
function parsePopulationGrowthReward(s: string): { percent: number; durationSec: number } | null {
  if (!s?.trim()) return null;
  const parts = s.split('|').map((v) => v.trim()).filter(Boolean);
  let percent = 0;
  let durationSec = 0;
  if (parts.some((part) => part.includes(':') && ['percent', 'durationSec'].includes(part.slice(0, part.indexOf(':'))))) {
    for (const part of parts) {
      const separator = part.indexOf(':');
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim();
      const value = num(part.slice(separator + 1), 0);
      if (key === 'percent') percent = value;
      if (key === 'durationSec') durationSec = value;
    }
  } else {
    const [rawPercent, rawDuration] = parts[0]?.split(':') ?? [];
    percent = num(rawPercent, 0);
    durationSec = num(rawDuration, 0);
  }
  if (!Number.isFinite(percent) || !Number.isFinite(durationSec) || percent <= 0 || durationSec <= 0) return null;
  return { percent, durationSec };
}

/**
 * 解析资源产量奖励：`percent:durationSec` 作用于四种资源，
 * `resource:percent:durationSec` 只作用于指定资源（例如 `crop:25:86400`）。
 */
function parseResourceGrowthReward(s: string): { percent: number; durationSec: number; resource?: string } | null {
  if (!s?.trim()) return null;
  const parts = s.split('|').map((v) => v.trim()).filter(Boolean);
  const resourceKeys = new Set(['wood', 'clay', 'iron', 'crop']);
  let resource: string | undefined;
  let percent = 0;
  let durationSec = 0;
  const colonParts = parts[0]?.split(':').map((value) => value.trim()) ?? [];
  if (colonParts.length >= 3 && resourceKeys.has(colonParts[0])) {
    resource = colonParts[0];
    percent = num(colonParts[1], 0);
    durationSec = num(colonParts[2], 0);
  } else {
    const [rawPercent, rawDuration] = colonParts;
    percent = num(rawPercent, 0);
    durationSec = num(rawDuration, 0);
  }
  if (!Number.isFinite(percent) || !Number.isFinite(durationSec) || percent <= 0 || durationSec <= 0) return null;
  return resource ? { resource, percent, durationSec } : { percent, durationSec };
}

/** 解析 dialogues.csv 的 replies：accept:接受任务|leave:离开。 */
function parseDialogueReplies(raw: string): DialogueReplyDef[] {
  return (raw ?? '').split('|').map((part) => {
    const separator = part.indexOf(':');
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const label = part.slice(separator + 1).trim();
    return key && label ? { key, label } : null;
  }).filter((item): item is DialogueReplyDef => Boolean(item));
}

/**
 * 解析前置依赖。新格式用建筑**数字ID**："4:3" 或多个 "4:3|7:1"；空则无前置。
 * idToCode 把数字ID映射回建筑 code（引擎内部统一用 code）。
 */
function parseRequires(s: string, idToCode: Map<number, string>): { kind: string; level: number }[] {
  if (!s) return [];
  return s.split('|').map((part) => {
    const [idStr, lv] = part.split(':');
    const code = idToCode.get(num(idStr)) ?? idStr.trim();
    return { kind: code, level: num(lv, 1) };
  });
}

/**
 * 解析兵种 traits 列。竖线(|)分隔的特性**数字ID**（如 "1|3"）；traitIdToCode 映射回 code。
 * 注意：用 | 而非逗号，因为 CSV 解析器按逗号切分，值内不能含逗号（与 requires 列同理）。
 * 空则返回 []。
 */
function parseTraitRefs(s: string, traitIdToCode: Map<number, string>): string[] {
  if (!s) return [];
  return s.split('|').map((part) => {
    const idStr = part.trim();
    if (!idStr) return '';
    return traitIdToCode.get(num(idStr)) ?? idStr;
  }).filter(Boolean);
}

function assertUniqueRows(rows: Record<string, string>[], table: string, idField = 'id', codeField = 'code'): void {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const r of rows) {
    const id = r[idField]?.trim();
    const code = r[codeField]?.trim();
    if (id) {
      if (ids.has(id)) throw new Error(`${table} 存在重复 ${idField}: ${id}`);
      ids.add(id);
    }
    if (code) {
      if (codes.has(code)) throw new Error(`${table} 存在重复 ${codeField}: ${code}`);
      codes.add(code);
    }
  }
}

/** 从指定目录加载所有 CSV。configDir 默认指向仓库根的 config/。 */
export function loadGameConfig(configDir: string, overrides?: BalanceOverrides): GameConfig {
  const p = (f: string) => join(configDir, f);

  const resourceRows = loadCsv(p('resources.csv'));
  assertUniqueRows(resourceRows, 'resources.csv', 'id', 'id');
  const resources = resourceRows.map((r) => ({ key: r.id, name: r.name, icon: r.icon }));

  // 先读建筑原始行，建立 数字ID→code 映射，再解析 requires（前置也是数字ID引用）
  let buildingRows = loadCsv(p('buildings.csv'));
  assertUniqueRows(buildingRows, 'buildings.csv');
  // 应用遗留平衡覆盖（玩家在 /gm/balance 的旧版本手动修改；CSV 是当前默认事实源，JSON 仅作兼容）
  if (overrides?.buildings) {
    buildingRows = mergeOverridesIntoRows(buildingRows, { file: 'buildings.csv', key: 'id', numeric: ['maxLevel','maxCount','mainBaseLevel','prosperityPerLevel','popGrowthPerLevel'] }, overrides.buildings);
  }
  const buildingIdToCode = new Map<number, string>();
  for (const r of buildingRows) buildingIdToCode.set(num(r.id), r.code);

  // 建筑逐级参数表（building_levels.csv）：code -> level -> BuildingLevelDef
  const levelsByCode: Record<string, Record<number, BuildingLevelDef>> = {};
  let levelRows = loadCsv(p('building_levels.csv'));
  if (overrides?.building_levels) {
    levelRows = mergeOverridesIntoRows(levelRows, {
      file: 'building_levels.csv', keyComposite: ['code','level'],
      numeric: ['costWood','costClay','costIron','costCrop','costGold','timeSec','popCap','treasureSlots','prod','storagePerLevel','defensePerLevel','buildSpeedupPerLevel','trainTimeReducePerLevel','trainCostReducePerLevel','taskRefreshSec','taskMaxTasks','taskSideQuestChance','vaultProtectWood','vaultProtectClay','vaultProtectIron','vaultProtectCrop','vaultProtectGold'],
    }, overrides.building_levels);
  }
  for (const r of levelRows) {
    const code = r.code?.trim();
    if (!code) continue;
    const lv = num(r.level);
    if (lv <= 0) continue;
    (levelsByCode[code] ??= {})[lv] = {
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      costGold: num(r.costGold, 0),
      timeSec: num(r.timeSec),
      popCap: num(r.popCap),
      treasureSlots: r.treasureSlots ? num(r.treasureSlots) : 0,
      prod: r.prod ? num(r.prod) : undefined,
      storagePerLevel: r.storagePerLevel ? num(r.storagePerLevel) : undefined,
      defensePerLevel: r.defensePerLevel ? num(r.defensePerLevel) : undefined,
      buildSpeedupPerLevel: r.buildSpeedupPerLevel ? num(r.buildSpeedupPerLevel) : undefined,
      trainTimeReducePerLevel: r.trainTimeReducePerLevel ? num(r.trainTimeReducePerLevel) : undefined,
      trainCostReducePerLevel: r.trainCostReducePerLevel ? num(r.trainCostReducePerLevel) : undefined,
      taskRefreshSec: r.taskRefreshSec ? num(r.taskRefreshSec) : undefined,
      taskMaxTasks: r.taskMaxTasks ? num(r.taskMaxTasks) : undefined,
      // 0 是合法的“关闭酒馆支线刷新”配置，不能用 truthy 判断吞掉。
      taskSideQuestChance: r.taskSideQuestChance !== undefined && r.taskSideQuestChance !== '' ? num(r.taskSideQuestChance) : undefined,
      vaultProtectWood: r.vaultProtectWood ? num(r.vaultProtectWood) : undefined,
      vaultProtectClay: r.vaultProtectClay ? num(r.vaultProtectClay) : undefined,
      vaultProtectIron: r.vaultProtectIron ? num(r.vaultProtectIron) : undefined,
      vaultProtectCrop: r.vaultProtectCrop ? num(r.vaultProtectCrop) : undefined,
      vaultProtectGold: r.vaultProtectGold ? num(r.vaultProtectGold) : undefined,
    };
  }

  const buildings: Record<string, BuildingDef> = {};
  for (const r of buildingRows) {
    const isField = !!r.resource;
    const lvl = levelsByCode[r.code] ?? {};
    buildings[r.code] = {
      id: num(r.id), kind: r.code, name: r.name, icon: r.icon,
      zone: (r.zone as Zone) || 'inner',
      resource: isField ? r.resource : undefined,
      cost: (lv: number): Record<string, number> => {
        const l = lvl[lv];
        if (l) return { ...l.cost, gold: l.costGold ?? 0 };
        return { wood: 0, clay: 0, iron: 0, crop: 0, gold: 0 };
      },
      timeSec: (lv: number) => lvl[lv]?.timeSec ?? 0,
      maxLevel: num(r.maxLevel, 10),
      maxCount: num(r.maxCount, -1),
      mainBaseLevel: Math.max(1, num(r.mainBaseLevel, 1)),
      requires: parseRequires(r.requires, buildingIdToCode),
      prosperityPerLevel: num(r.prosperityPerLevel, 5),
      popGrowthPerLevel: num(r.popGrowthPerLevel, 0),
      levels: lvl,
      popCapPerLevel: lvl[1]?.popCap ?? 0,
      treasureSlotsPerLevel: lvl[1]?.treasureSlots ?? 0,
      desc: r.desc ?? '',
      effect: r.effect ?? '',
    };
  }

  // 城镇中心槽位曲线：tcLevel → {inner,outer,queue}
  const townCenterSlots: Record<number, TownCenterSlotTier> = {};
  for (const r of loadCsv(p('town_center_slots.csv'))) {
    const lv = num(r.tcLevel);
    if (lv <= 0) continue;
    townCenterSlots[lv] = {
      inner: num(r.innerSlots), outer: num(r.outerSlots), queue: num(r.queueSlots, 2),
    };
  }

  // 兵种特性表：先解析，units 的 traits 列用数字 id 引用它，解析回 code
  const traitRows = loadCsv(p('unit_traits.csv'));
  assertUniqueRows(traitRows, 'unit_traits.csv');
  const unitTraits: Record<string, UnitTraitDef> = {};
  const traitIdToCode = new Map<number, string>();
  for (const r of traitRows) {
    if (!r.code) continue;
    traitIdToCode.set(num(r.id), r.code);
    const effects: { effect: TraitEffect; value: number }[] = [];
    for (let i = 1; i <= 5; i++) {
      const ek = `effect${i}`, vk = `value${i}`;
      if (r[ek]) effects.push({ effect: r[ek] as TraitEffect, value: num(r[vk]) });
    }
    unitTraits[r.code] = { id: num(r.id), code: r.code, name: r.name, effects };
  }

  let unitRows = loadCsv(p('units.csv'));
  assertUniqueRows(unitRows, 'units.csv');
  if (overrides?.units) {
    unitRows = mergeOverridesIntoRows(unitRows, {
      // GM 平衡表按 units.csv 的数字 id 保存覆盖；这里必须使用同一主键，
      // 否则覆盖文件存在但重启/删档后会静默回退到 CSV 默认值。
      file: 'units.csv', key: 'id',
      numeric: ['meleeAtk','rangedAtk','meleeDef','rangedDef','hp','speed','vision','carry','upkeep','costWood','costClay','costIron','costCrop','trainSec','popCost'],
    }, overrides.units);
  }
  const units: Record<string, UnitDef> = {};
  for (const r of unitRows) {
    units[r.code] = {
      id: num(r.id), key: r.code, tribe: r.tribe || 'romans', name: r.name, icon: r.icon,
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef), hp: Math.max(1, num(r.hp, 100)),
      speed: num(r.speed, 6), vision: Math.max(0, num(r.vision, 1)), carry: num(r.carry), upkeep: num(r.upkeep, 1),
      cost: { wood: num(r.costWood), clay: num(r.costClay), iron: num(r.costIron), crop: num(r.costCrop) },
      trainSec: num(r.trainSec, 30),
      building: buildingIdToCode.get(num(r.building)) ?? r.building, // 数字建筑ID → code
      traits: parseTraitRefs(r.traits, traitIdToCode),
      simTraits: parseTraitRefs(r.simTraits, traitIdToCode),
      popCost: num(r.popCost, 1),
      popCostConfigured: r.popCost !== undefined && r.popCost.trim() !== '',
    };
  }

  // 雇佣兵（tribe=merc）：解析 mercenaries.csv，合并进 config.units（key=code），
  // 强制 popCost=0/upkeep=0/cost*=0/trainSec=0（不经 military.TrainTroops，直接经 mercenary.Hire 金币购买）。
  // 覆盖层：与 units 同源，key='id'，numeric 含战斗属性 + goldCost。
  let mercRows = loadCsv(p('mercenaries.csv'));
  assertUniqueRows(mercRows, 'mercenaries.csv');
  if (overrides?.mercenaries) {
    mercRows = mergeOverridesIntoRows(mercRows, {
      file: 'mercenaries.csv', key: 'id',
      numeric: ['meleeAtk','rangedAtk','meleeDef','rangedDef','hp','speed','carry','upkeep','goldCost','commandCost','contractSec','tier','costWood','costClay','costIron','costCrop','trainSec','popCost'],
    }, overrides.mercenaries);
  }
  for (const r of mercRows) {
    const code = r.code?.trim();
    if (!code) continue;
    units[code] = {
      id: num(r.id), key: code, tribe: 'merc', name: r.name, icon: r.icon,
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef), hp: Math.max(1, num(r.hp, 100)),
      speed: num(r.speed, 6), vision: Math.max(0, num(r.vision, 1)), carry: num(r.carry), upkeep: 0,
      cost: { wood: 0, clay: 0, iron: 0, crop: 0 },
      trainSec: 0,
      building: '', // 雇佣兵不经训练建筑
      traits: parseTraitRefs(r.traits, traitIdToCode),
      simTraits: parseTraitRefs(r.simTraits, traitIdToCode),
      popCost: 0,
      popCostConfigured: true,
      isMercenary: true,
      goldCost: num(r.goldCost, 0),
      commandCost: Math.max(1, num(r.commandCost, 1)),
      contractSec: Math.max(1, num(r.contractSec, 259200)),
      mercTier: Math.max(1, num(r.tier, 1)),
    };
  }

  // 雇佣兵营地刷新参数（merc_camp.csv）：level → MercCampLevel。覆盖层 key='level'。
  const mercCamp: Record<number, MercCampLevel> = {};
  let mercCampRows = loadCsv(p('merc_camp.csv'));
  if (overrides?.merc_camp) {
    mercCampRows = mergeOverridesIntoRows(mercCampRows, {
      file: 'merc_camp.csv', key: 'level',
      numeric: ['refreshSec','mercCount','maxStoredRefreshes','capacity'],
    }, overrides.merc_camp);
  }
  for (const r of mercCampRows) {
    const lv = num(r.level);
    if (lv <= 0) continue;
    mercCamp[lv] = {
      refreshSec: num(r.refreshSec, 3600),
      mercCount: num(r.mercCount, 3),
      maxStoredRefreshes: num(r.maxStoredRefreshes, 1),
      capacity: Math.max(0, num(r.capacity, lv)),
    };
  }

  // 贸易中心逐级参数（trade_center.csv）：level → TradeCenterLevel。覆盖层 key='level'。
  const tradeCenter: Record<number, TradeCenterLevel> = {};
  let tradeCenterRows = loadCsv(p('trade_center.csv'));
  if (overrides?.trade_center) {
    tradeCenterRows = mergeOverridesIntoRows(tradeCenterRows, {
      file: 'trade_center.csv', key: 'level',
      numeric: ['tradeRoutes', 'tradeViewRadius', 'npcOrderCount', 'npcRefreshSec', 'npcStoredRefreshes'],
    }, overrides.trade_center);
  }
  for (const r of tradeCenterRows) {
    const lv = num(r.level);
    if (lv <= 0) continue;
    tradeCenter[lv] = {
      tradeRoutes: num(r.tradeRoutes, 2),
      tradeViewRadius: num(r.tradeViewRadius, 5),
      npcOrderCount: num(r.npcOrderCount, 3),
      npcRefreshSec: num(r.npcRefreshSec, 3600),
      npcStoredRefreshes: num(r.npcStoredRefreshes, 1),
    };
  }

  // PvE：主表 + 守军表 + 分布点，三表用数字目标ID互相引用，解析回 code
  let pveRows = loadCsv(p('pve_targets.csv'));
  if (overrides?.pve_targets) {
    pveRows = mergeOverridesIntoRows(pveRows, {
      file: 'pve_targets.csv', key: 'id',
      numeric: ['respawnSec','lootWood','lootClay','lootIron','lootCrop'],
    }, overrides.pve_targets);
  }
  assertUniqueRows(pveRows, 'pve_targets.csv');
  const pveTemplates: Record<string, PveTemplate> = {};
  const pveIdToCode = new Map<number, string>();
  for (const r of pveRows) {
    pveIdToCode.set(num(r.id), r.code);
    pveTemplates[r.code] = {
      id: num(r.id), type: r.code, name: r.name, icon: r.icon,
      faction: r.faction === 'kingdom' || r.code === 'kingdom_city_state' ? 'kingdom' : 'neutral',
      cityState: r.cityState === 'true' || r.cityState === '1' || r.code === 'kingdom_city_state',
      kingdomProfile: r.kingdomProfile === 'fief' || r.kingdomProfile === 'capital' ? r.kingdomProfile : (r.cityState === 'true' || r.cityState === '1' || r.code === 'kingdom_city_state' ? 'city_state' : undefined),
      respawnSec: num(r.respawnSec, 120),
      defender: {},
      loot: { wood: num(r.lootWood), clay: num(r.lootClay), iron: num(r.lootIron), crop: num(r.lootCrop) },
    };
  }
  let pveDefenderRows = loadCsv(p('pve_defenders.csv'));
  if (overrides?.pve_defenders) {
    pveDefenderRows = mergeOverridesIntoRows(pveDefenderRows, {
      file: 'pve_defenders.csv', keyComposite: ['targetId','unitCode'],
      numeric: ['count','meleeAtk','rangedAtk','meleeDef','rangedDef','hp','carry'],
    }, overrides.pve_defenders);
  }
  for (const r of pveDefenderRows) {
    const code = pveIdToCode.get(num(r.targetId));
    const tpl = code ? pveTemplates[code] : undefined;
    if (!tpl) throw new Error(`pve_defenders.csv targetId=${r.targetId} 不在 pve_targets.csv`);
    tpl.defender[r.unitCode] = {
      count: num(r.count),
      form: (r.form as UnitForm) || 'melee',
      meleeAtk: num(r.meleeAtk), rangedAtk: num(r.rangedAtk),
      meleeDef: num(r.meleeDef), rangedDef: num(r.rangedDef), hp: Math.max(1, num(r.hp, 100)),
      carry: num(r.carry), traitCodes: parseTraitRefs(r.traits, traitIdToCode),
    };
  }

  const spawnRows = loadCsv(p('pve_spawns.csv'));
  assertUniqueRows(spawnRows, 'pve_spawns.csv', 'id', 'id');
  const pveSpawns: PveSpawn[] = spawnRows.map((r) => ({
    id: r.id,
    type: pveIdToCode.get(num(r.targetId)) ?? r.targetId, // 数字目标ID → code
    q: num(r.q), r: num(r.r),
  }));

  let kingdomServiceRows = loadCsv(p('kingdom_services.csv'));
  assertUniqueRows(kingdomServiceRows, 'kingdom_services.csv');
  if (overrides?.kingdom_services) {
    kingdomServiceRows = mergeOverridesIntoRows(kingdomServiceRows, {
      file: 'kingdom_services.csv', key: 'id',
      numeric: ['minCouncilLevel','reputationCost','unitCount','wood','clay','iron','crop','gold','delaySec'],
    }, overrides.kingdom_services);
  }
  const kingdomServices: Record<string, KingdomServiceDef> = {};
  for (const r of kingdomServiceRows) {
    const code = r.code?.trim();
    if (!code) continue;
    kingdomServices[code] = {
      id: num(r.id), code, name: r.name,
      category: r.category as KingdomServiceCategory,
      minCouncilLevel: Math.max(1, num(r.minCouncilLevel, 1)),
      reputationCost: Math.max(0, num(r.reputationCost)),
      unitCode: r.unitCode?.trim() || undefined,
      unitCount: Math.max(0, Math.floor(num(r.unitCount))),
      resources: { wood: num(r.wood), clay: num(r.clay), iron: num(r.iron), crop: num(r.crop), gold: num(r.gold) },
      treasureCode: r.treasureCode?.trim() || undefined,
      delaySec: Math.max(0, num(r.delaySec)),
      desc: r.desc ?? '',
    };
  }

  // 全局常量表
  const raw: Record<string, number | boolean | string> = {};
  let constRows = loadCsv(p('game_constants.csv'));
  if (overrides?.constants) {
    // game_constants 的主键是 key，value/type 都可改（GM 保存路由以表名 'constants' 写入覆盖）
    constRows = mergeOverridesIntoRows(constRows, { file: 'game_constants.csv', key: 'key' }, overrides.constants);
  }
  for (const r of constRows) {
    if (!r.key) continue;
    raw[r.key] = parseConstantValue(r.value, r.type);
  }
  const cn = (k: string, def: number) => (typeof raw[k] === 'number' ? (raw[k] as number) : def);
  const cs = (k: string, def: string) => (typeof raw[k] === 'string' ? String(raw[k]) : def);
  const constants: GameConstants = {
    wallBonusPerLevel: cn('wall_bonus_per_level', 0.03),
    mainBuildSpeedupPerLevel: cn('main_build_speedup_per_level', 0.05),
    mainBuildSpeedupCap: cn('main_build_speedup_cap', 0.6),
    trainTimeReducePerLevel: cn('train_time_reduce_per_level', 0.05),
    trainTimeReduceCap: cn('train_time_reduce_cap', 0.6),
    trainCostReducePerLevel: cn('train_cost_reduce_per_level', 0.03),
    trainCostReduceCap: cn('train_cost_reduce_cap', 0.5),
    storageBase: cn('storage_base', 800),
    storageGrowthPerLevel: cn('storage_growth_per_level', 0.5),
    startResourceAmount: cn('start_resource_amount', 750),
    goldTaxPerCivilianPerHour: cn('gold_tax_per_civilian_per_hour', 1),
    startGoldAmount: cn('start_gold_amount', 100),
    baseProductionPerHour: cn('base_production_per_hour', 10),
    mapSize: cn('map_size', 20),
    mapViewRadius: cn('map_view_radius', 6),
    worldW: cn('world_width', 41),
    worldH: cn('world_height', 41),
    combatTickMs: cn('combat_tick_ms', 200),
    combatStrength: cn('combat_strength', 1),
    combatInfluenceReferenceValue: Math.max(1, cn('combat_influence_reference_value', 200)),
    combatInfluenceQualityExponent: Math.max(1, cn('combat_influence_quality_exponent', 1.15)),
    combatInfluenceMinQuality: Math.max(0, cn('combat_influence_min_quality', 0.65)),
    combatInfluenceMaxQuality: Math.max(0.01, cn('combat_influence_max_quality', 1.55)),
    combatValueMeleeAttackWeight: Math.max(0, cn('combat_value_melee_attack_weight', 1)),
    combatValueRangedAttackWeight: Math.max(0, cn('combat_value_ranged_attack_weight', 1.1)),
    combatValueMeleeDefenseWeight: Math.max(0, cn('combat_value_melee_defense_weight', 0.85)),
    combatValueRangedDefenseWeight: Math.max(0, cn('combat_value_ranged_defense_weight', 0.75)),
    combatValueHpWeight: Math.max(0, cn('combat_value_hp_weight', 0.65)),
    battleSimulatorMeleeRounds: Math.max(1, Math.floor(cn('battle_sim_melee_rounds', 6))),
    battlePhaseCavalryVsCavalryCoeff: Math.max(0, cn('combat_phase_cavalry_vs_cavalry_coeff', 1)),
    battlePhaseCavalryVsMeleeCoeff: Math.max(0, cn('combat_phase_cavalry_vs_melee_coeff', 1)),
    battlePhaseCavalryVsRangedCoeff: Math.max(0, cn('combat_phase_cavalry_vs_ranged_coeff', 1)),
    battlePhaseRangedStrikeCoeff: Math.max(0, cn('combat_phase_ranged_strike_coeff', 1)),
    battlePhaseMeleeRoundCoeff: Math.max(0, cn('combat_phase_melee_round_coeff', 1)),
    battlePhaseCompareEpsilon: Math.max(0, cn('combat_phase_compare_epsilon', 0.0001)),
    battlePhaseMinSurvivorUnits: Math.max(1, Math.floor(cn('combat_phase_min_survivor_units', 1))),
    ambushAttackBonus: cn('ambush_attack_bonus', 0.5),
    notificationsPerVillage: cn('notifications_per_village', 60),
    marchSpeedMultiplier: cn('march_speed_multiplier', 1),
    forestVisionPenalty: cn('forest_vision_penalty', 2),
    hillsVisionBonus: cn('hills_vision_bonus', 1),
    hillsMarchSpeedMultiplier: cn('hills_march_speed_multiplier', 2 / 3),
    marchSizeReferencePop: Math.max(0, cn('march_size_reference_pop', 20)),
    marchSizePenalty: Math.max(0, cn('march_size_penalty', 0.0015)),
    marchSizeMinMultiplier: Math.max(0, Math.min(1, cn('march_size_min_multiplier', 0.45))),
    cavalryUnitCodes: parseConstantList(cs('cavalry_unit_codes', 'equlegati|equimperatoris|equcaesaris|theutates|druidrider|haeduan|paladin|teutonknight|merc_cavalry|merc_knight'), 'equlegati|equimperatoris|equcaesaris|theutates|druidrider|haeduan|paladin|teutonknight|merc_cavalry|merc_knight'),
    marchPointBase: cn('march_point_base', 0),
    marchPointPerRallypointLevel: cn('march_point_per_rallypoint_level', 1),
    pveLootVariance: cn('pve_loot_variance', 0.2),
    kingdomCityStateCount: Math.max(0, Math.floor(cn('kingdom_city_state_count', 8))),
    kingdomCityStateResourceMin: Math.max(0, cn('kingdom_city_state_resource_min', 1000)),
    kingdomCityStateResourceMax: Math.max(0, cn('kingdom_city_state_resource_max', 5000)),
    kingdomCityStateGoldMin: Math.max(0, cn('kingdom_city_state_gold_min', 0)),
    kingdomCityStateGoldMax: Math.max(0, cn('kingdom_city_state_gold_max', 1000)),
    kingdomCityStateTroopsPerResource: Math.max(0, cn('kingdom_city_state_troops_per_resource', 0.04)),
    kingdomCityStateTroopMin: Math.max(0, Math.floor(cn('kingdom_city_state_troop_min', 100))),
    kingdomCityStateTroopMax: Math.max(0, Math.floor(cn('kingdom_city_state_troop_max', 10000))),
    kingdomCityStateScoutRatio: Math.max(0, Math.min(1, cn('kingdom_city_state_scout_ratio', 0.05))),
    kingdomCityStateRaidDefenseMinRatio: Math.max(0, Math.min(1, cn('kingdom_city_state_raid_defense_min_ratio', 0.2))),
    kingdomCityStateRaidDefenseMaxRatio: Math.max(0, Math.min(1, cn('kingdom_city_state_raid_defense_max_ratio', 0.8))),
    kingdomCityStateRecoveryMinSec: Math.max(1, cn('kingdom_city_state_recovery_min_sec', 43200)),
    kingdomCityStateRecoveryMaxSec: Math.max(1, cn('kingdom_city_state_recovery_max_sec', 172800)),
    kingdomCityStateRecoveryResourceExtraSec: Math.max(0, cn('kingdom_city_state_recovery_resource_extra_sec', 21600)),
    kingdomCityStateReputationPenalty: Math.max(0, Math.floor(cn('kingdom_city_state_reputation_penalty', 2))),
    kingdomCityStateResourceFieldLevel: Math.max(1, Math.floor(cn('kingdom_city_state_resource_field_level', 3))),
    kingdomCityStateInnerBuildingCountMin: Math.max(0, Math.floor(cn('kingdom_city_state_inner_building_count_min', 3))),
    kingdomCityStateInnerBuildingCountMax: Math.max(0, Math.floor(cn('kingdom_city_state_inner_building_count_max', 8))),
    kingdomCityStateOuterBuildingCountMin: Math.max(4, Math.floor(cn('kingdom_city_state_outer_building_count_min', 4))),
    kingdomCityStateOuterBuildingCountMax: Math.max(4, Math.floor(cn('kingdom_city_state_outer_building_count_max', 8))),
    kingdomCityStateBuildingLevelMin: Math.max(1, Math.floor(cn('kingdom_city_state_building_level_min', 1))),
    kingdomCityStateBuildingLevelMax: Math.max(1, Math.floor(cn('kingdom_city_state_building_level_max', 5))),
    kingdomCityStateUnitPool: parseConstantList(cs('kingdom_city_state_unit_pool', 'legionnaire|praetorian|imperian|equimperatoris|equcaesaris|ram|catapult'), 'legionnaire'),
    kingdomCityStateInnerBuildingPool: parseConstantList(cs('kingdom_city_state_inner_building_pool', 'warehouse|granary|barracks|stable|workshop|academy|smithy|hospital|residence|treasury|tavern|vault|council'), 'warehouse|granary'),
    kingdomCityStateOuterBuildingPool: parseConstantList(cs('kingdom_city_state_outer_building_pool', 'woodcutter|claypit|ironmine|cropland|wall|mercenarycamp|tradecenter|explorers_guild'), 'woodcutter|claypit|ironmine|cropland|wall'),
    kingdomCityStateGenerationVersion: Math.max(1, Math.floor(cn('kingdom_city_state_generation_version', 3))),
    kingdomCityStateTierWeights: parseCityStateTierWeights(cs('kingdom_city_state_tier_weights', '1:1|2:1|3:1')),
    kingdomCityStateTribePool: parseConstantList(cs('kingdom_city_state_tribe_pool', 'romans|gauls|teutons'), 'romans|gauls|teutons').filter((tribe): tribe is 'romans' | 'gauls' | 'teutons' => tribe === 'romans' || tribe === 'gauls' || tribe === 'teutons'),
    kingdomCityStateUnitPools: {
      romans: parseConstantList(cs('kingdom_city_state_unit_pool_romans', 'legionnaire|praetorian|imperian|equlegati|equimperatoris|equcaesaris|ram|catapult'), 'legionnaire|praetorian|imperian|equlegati|equimperatoris|equcaesaris|ram|catapult'),
      gauls: parseConstantList(cs('kingdom_city_state_unit_pool_gauls', 'phalanx|swordsman|pathfinder|theutates|druidrider|haeduan|gaulram|gcaultrebuchet'), 'phalanx|swordsman|pathfinder|theutates|druidrider|haeduan|gaulram|gcaultrebuchet'),
      teutons: parseConstantList(cs('kingdom_city_state_unit_pool_teutons', 'clubswinger|spearman|axeman|teuscout|paladin|teutonknight|teuram|teucatapult'), 'clubswinger|spearman|axeman|teuscout|paladin|teutonknight|teuram|teucatapult'),
    },
    kingdomCityStateTier1UnitCount: Math.max(1, Math.floor(cn('kingdom_city_state_tier1_unit_count', 3))),
    kingdomCityStateTier1UnitMin: Math.max(0, Math.floor(cn('kingdom_city_state_tier1_unit_min', 0))),
    kingdomCityStateTier1UnitMax: Math.max(0, Math.floor(cn('kingdom_city_state_tier1_unit_max', 20))),
    kingdomCityStateTier1ResourceMin: Math.max(0, cn('kingdom_city_state_tier1_resource_min', 500)),
    kingdomCityStateTier1ResourceMax: Math.max(0, cn('kingdom_city_state_tier1_resource_max', 1500)),
    kingdomCityStateTier1GoldMin: Math.max(0, cn('kingdom_city_state_tier1_gold_min', 0)),
    kingdomCityStateTier1GoldMax: Math.max(0, cn('kingdom_city_state_tier1_gold_max', 300)),
    kingdomCityStateTier2UnitCount: Math.max(1, Math.floor(cn('kingdom_city_state_tier2_unit_count', 4))),
    kingdomCityStateTier2UnitMin: Math.max(0, Math.floor(cn('kingdom_city_state_tier2_unit_min', 5))),
    kingdomCityStateTier2UnitMax: Math.max(0, Math.floor(cn('kingdom_city_state_tier2_unit_max', 35))),
    kingdomCityStateTier2ResourceMin: Math.max(0, cn('kingdom_city_state_tier2_resource_min', 1500)),
    kingdomCityStateTier2ResourceMax: Math.max(0, cn('kingdom_city_state_tier2_resource_max', 5000)),
    kingdomCityStateTier2GoldMin: Math.max(0, cn('kingdom_city_state_tier2_gold_min', 300)),
    kingdomCityStateTier2GoldMax: Math.max(0, cn('kingdom_city_state_tier2_gold_max', 1200)),
    kingdomCityStateTier3UnitCount: Math.max(1, Math.floor(cn('kingdom_city_state_tier3_unit_count', 5))),
    kingdomCityStateTier3UnitMin: Math.max(0, Math.floor(cn('kingdom_city_state_tier3_unit_min', 10))),
    kingdomCityStateTier3UnitMax: Math.max(0, Math.floor(cn('kingdom_city_state_tier3_unit_max', 50))),
    kingdomCityStateTier3ResourceMin: Math.max(0, cn('kingdom_city_state_tier3_resource_min', 5000)),
    kingdomCityStateTier3ResourceMax: Math.max(0, cn('kingdom_city_state_tier3_resource_max', 15000)),
    kingdomCityStateTier3GoldMin: Math.max(0, cn('kingdom_city_state_tier3_gold_min', 1200)),
    kingdomCityStateTier3GoldMax: Math.max(0, cn('kingdom_city_state_tier3_gold_max', 5000)),
    kingdomFiefUnitCount: Math.max(1, Math.floor(cn('kingdom_fief_unit_count', 7))),
    kingdomFiefUnitMin: Math.max(0, Math.floor(cn('kingdom_fief_unit_min', 30))),
    kingdomFiefUnitMax: Math.max(0, Math.floor(cn('kingdom_fief_unit_max', 100))),
    kingdomFiefResourceMin: Math.max(0, cn('kingdom_fief_resource_min', 15000)),
    kingdomFiefResourceMax: Math.max(0, cn('kingdom_fief_resource_max', 30000)),
    kingdomFiefGoldMin: Math.max(0, cn('kingdom_fief_gold_min', 5000)),
    kingdomFiefGoldMax: Math.max(0, cn('kingdom_fief_gold_max', 10000)),
    kingdomCapitalUnitCount: Math.max(1, Math.floor(cn('kingdom_capital_unit_count', 10))),
    kingdomCapitalUnitMin: Math.max(0, Math.floor(cn('kingdom_capital_unit_min', 50))),
    kingdomCapitalUnitMax: Math.max(0, Math.floor(cn('kingdom_capital_unit_max', 150))),
    kingdomCapitalResourceMin: Math.max(0, cn('kingdom_capital_resource_min', 30000)),
    kingdomCapitalResourceMax: Math.max(0, cn('kingdom_capital_resource_max', 60000)),
    kingdomCapitalGoldMin: Math.max(0, cn('kingdom_capital_gold_min', 10000)),
    kingdomCapitalGoldMax: Math.max(0, cn('kingdom_capital_gold_max', 20000)),
    kingdomPveKilledPopulationPerReputation: Math.max(1, Math.floor(cn('kingdom_pve_killed_population_per_reputation', 25))),
    kingdomPveRetaliationChunk: Math.max(1, Math.floor(cn('kingdom_pve_retaliation_chunk', 5))),
    kingdomPveRetaliationRaidThreshold: Math.min(0, Math.floor(cn('kingdom_pve_retaliation_raid_threshold', -10))),
    kingdomPveRetaliationSiegeThreshold: Math.min(0, Math.floor(cn('kingdom_pve_retaliation_siege_threshold', -20))),
    kingdomFiefMercenaryMinRatio: Math.max(0, Math.min(1, cn('kingdom_fief_mercenary_min_ratio', 0.4))),
    kingdomFiefMercenaryMaxRatio: Math.max(0, Math.min(1, cn('kingdom_fief_mercenary_max_ratio', 0.7))),
    popProsperityFullRatio: cn('pop_prosperity_full_ratio', 0.70),
    popProsperityMaxBonus: cn('pop_prosperity_max_bonus', 0.30),
    popOvercapPenaltyFullRatio: cn('pop_overcap_penalty_full_ratio', 2.0),
    popRaceMobilizeMax: {
      romans: cn('pop_race_mobilize_max_romans', 0.75),
      gauls: cn('pop_race_mobilize_max_gauls', 0.70),
      teutons: cn('pop_race_mobilize_max_teutons', 0.80),
    },
    popCropPerLabor: cn('pop_crop_per_labor', 1.0),
    popDeathRateFactor: cn('pop_death_rate_factor', 0.5),
    popFamineTickSec: cn('pop_famine_tick_sec', 300),
    popHospitalRecoveryBase: cn('pop_hospital_recovery_base', 0.20),
    popHospitalRecoveryPerLevel: cn('pop_hospital_recovery_per_level', 0.10),
    popHospitalRecoveryMax: cn('pop_hospital_recovery_max', 0.80),
    foundMinMainLevel: cn('found_min_main_level', 4),
    foundSettlerCount: cn('found_settler_count', 1),
    foundResourceCostBase: cn('found_resource_cost_base', 3000),
    foundResourceCostGrowth: cn('found_resource_cost_growth', 2),
    foundMinTileDistance: cn('found_min_tile_distance', 3),
    foundMaxInflight: cn('found_max_inflight', 1),
    foundAbandonLockSec: cn('found_abandon_lock_sec', 86400),
    tradeRouteCapacity: cn('trade_route_capacity', 500),
    tradeCaravanSpeed: cn('trade_caravan_speed', 12),
    tradeNpcGoldPerResource: cn('trade_npc_gold_per_resource', 0.5),
    tradeNpcSellMargin: cn('trade_npc_sell_margin', 0.8),
    tradeOrderMaxPerVillage: cn('trade_order_max_per_village', 5),
    tradeOrderTtlSec: cn('trade_order_ttl_sec', 86400),
    treasureCampDropChance: cn('treasure_camp_drop_chance', 0.15),
    treasureNpcOfferChance: cn('treasure_npc_offer_chance', 0.18),
    treasureNpcBuyMarkup: cn('treasure_npc_buy_markup', 1.6),
    treasureClaimTimeoutSec: cn('treasure_claim_timeout_sec', 3600),
    treasureCarryTroopsPerSlot: cn('treasure_carry_troops_per_slot', 200),
    treasureCarryMaxSlots: cn('treasure_carry_max_slots', 10),
    ritualBuffDurationSec: cn('ritual_buff_duration_sec', 7200),
    ritualBuffPopCost: cn('ritual_buff_pop_cost', 5),
    alchemyRefineSec: cn('alchemy_refine_sec', 3600),
    reputationS4ReleaseDelta: cn('reputation_s4_release_delta', 2),
    reputationGoodPvpTargetThreshold: cn('reputation_good_pvp_target_threshold', 10),
    reputationGoodPvpReward: cn('reputation_good_pvp_reward', 1),
    reputationEvilPvpTargetThreshold: cn('reputation_evil_pvp_target_threshold', 10),
    reputationEvilPvpReward: cn('reputation_evil_pvp_reward', 1),
    reputationGoodPopGrowthPerPoint: cn('reputation_good_pop_growth_per_point', 0.005),
    reputationGoodPopGrowthCap: cn('reputation_good_pop_growth_cap', 0.5),
    reputationEvilPopGrowthPenaltyPerPoint: cn('reputation_evil_pop_growth_penalty_per_point', 0.005),
    reputationEvilPopGrowthPenaltyCap: cn('reputation_evil_pop_growth_penalty_cap', 0.5),
    reputationEvilArmyAttackPerPoint: cn('reputation_evil_army_attack_per_point', 0.005),
    reputationEvilArmyAttackCap: cn('reputation_evil_army_attack_cap', 0.5),
    reputationEvilArmyDefensePerPoint: cn('reputation_evil_army_defense_per_point', 0.005),
    reputationEvilArmyDefenseCap: cn('reputation_evil_army_defense_cap', 0.5),
    reputationGoodGoldTaxPenaltyPerPoint: cn('reputation_good_gold_tax_penalty_per_point', 0.005),
    reputationGoodGoldTaxPenaltyCap: cn('reputation_good_gold_tax_penalty_cap', 0.5),
    reputationEvilPveDropRatePerPoint: cn('reputation_evil_pve_drop_rate_per_point', 0.01),
    reputationEvilPveDropRateCap: cn('reputation_evil_pve_drop_rate_cap', 0.5),
    pvpRaidPowerPerBuildingLevel: Math.max(1, cn('pvp_raid_power_per_building_level', 100)),
    pvpSiegePowerPerBuildingLevel: Math.max(1, cn('pvp_siege_power_per_building_level', 100)),
    pvpSiegeWeaponPowerPerBuildingLevel: Math.max(1, cn('pvp_siege_weapon_power_per_building_level', 100)),
    pvpSiegeStorageLootRatio: Math.max(0, Math.min(1, cn('pvp_siege_storage_loot_ratio', 1))),
    m8AttackDelaySec: Math.max(1, cn('m8_attack_delay_sec', 28800)),
    m8TaskVillageSpawnRadius: Math.max(1, cn('m8_task_village_spawn_radius', 8)),
    m8TaskVillageResourceAmount: Math.max(0, cn('m8_task_village_resource_amount', 500)),
    m8TaskVillageGold: Math.max(0, cn('m8_task_village_gold', 500)),
    raw,
  };

  // 开局模板表（按部族）
  const templateRows = loadCsv(p('village_templates.csv'));
  assertUniqueRows(templateRows, 'village_templates.csv', 'tribe', 'tribe');
  const villageTemplates: Record<string, VillageTemplate> = {};
  for (const r of templateRows) {
    if (!r.tribe) continue;
    villageTemplates[r.tribe] = {
      tribe: r.tribe,
      startPlaced: parseLeveledList(r.start_placed),
      startResources: parseResourceList(r.start_resources),
      startDamaged: parseLeveledList(r.start_damaged),
    };
  }

  // 宝物目录（treasures.csv）：code → TreasureDef。覆盖层 key='id'，numeric=effectValue/reputationValue/priceGold/dropRate。
  let treasureRows = loadCsv(p('treasures.csv'));
  if (overrides?.treasures) {
    treasureRows = mergeOverridesIntoRows(treasureRows, {
      file: 'treasures.csv', key: 'id',
      numeric: ['effectValue', 'reputationValue', 'priceGold', 'dropRate'],
    }, overrides.treasures);
  }
  assertUniqueRows(treasureRows, 'treasures.csv');
  const treasures: Record<string, TreasureDef> = {};
  for (const r of treasureRows) {
    const code = r.code?.trim();
    if (!code) continue;
    treasures[code] = {
      id: num(r.id),
      code,
      name: r.name ?? code,
      icon: r.icon ?? 'trs_generic',
      category: r.category ?? 'economic',
      rarity: r.rarity ?? 'common',
      effectType: r.effectType ?? '',
      effectValue: num(r.effectValue, 0),
      reputationValue: num(r.reputationValue, 0),
      priceGold: num(r.priceGold, 0),
      dropRate: num(r.dropRate, 0),
      applyType: r.applyType ?? 'passive',
      equipCategory: r.equipCategory || r.category || 'special',
      stackGroup: r.stackGroup || r.effectType || code,
      effectCap: Math.max(0, num(r.effectCap, 50)),
      uniqueEffect: num(r.uniqueEffect, 1) !== 0,
    };
  }

  // 科技目录（research.csv）只放目录字段；research_effects.csv 一项科技可配置多个真实效果。
  let researchRows = loadCsv(p('research.csv'));
  if (overrides?.research) {
    researchRows = mergeOverridesIntoRows(researchRows, {
      file: 'research.csv', key: 'id',
      numeric: ['tier', 'mainBaseLevel', 'durationSec', 'rpCost'],
    }, overrides.research);
  }
  assertUniqueRows(researchRows, 'research.csv');
  const research: Record<string, ResearchDef> = {};
  for (const r of researchRows) {
    const code = r.code?.trim();
    if (!code) continue;
    research[code] = {
      id: num(r.id),
      code,
      name: r.name ?? code,
      branch: (r.branch as TechBranch) || 'production',
      tier: num(r.tier, 1),
      mainBaseLevel: Math.max(1, num(r.mainBaseLevel, 1)),
      requires: r.requires ? r.requires.split('|').map((s: string) => s.trim()).filter(Boolean) : [],
      desc: r.desc ?? '',
      effectType: 'resource_rate',
      effectKey: '',
      effectValue: 0,
      scope: (r.scope as TechScope) || 'village',
      durationSec: num(r.durationSec, 3600),
      rpCost: num(r.rpCost, 1),
      icon: r.icon ?? 'tech_generic',
      effects: [],
    };
  }
  const researchEffectRows = loadCsv(p('research_effects.csv'));
  for (const r of researchEffectRows) {
    const techCode = r.techCode?.trim();
    const tech = research[techCode];
    if (!tech) continue;
    tech.effects.push({
      techCode,
      order: Math.max(1, num(r.order, tech.effects.length + 1)),
      effectType: (r.effectType as TechEffectType) || 'resource_rate',
      effectKey: r.effectKey ?? '',
      effectValue: num(r.effectValue, 0),
      cap: Math.max(0, num(r.cap, 0.5)),
    });
  }
  for (const tech of Object.values(research)) {
    tech.effects.sort((a, b) => a.order - b.order);
    const first = tech.effects[0];
    if (first) {
      tech.effectType = first.effectType;
      tech.effectKey = first.effectKey;
      tech.effectValue = first.effectValue;
    }
  }

  // 学院参数（academy.csv）：level → AcademyDef。覆盖层 key='level'。
  let academyRows = loadCsv(p('academy.csv'));
  if (overrides?.academy) {
    academyRows = mergeOverridesIntoRows(academyRows, {
      file: 'academy.csv', key: 'level',
      numeric: ['checkIntervalSec', 'baseProbability', 'probabilityGainPerFail', 'maxProbability', 'popFactor'],
    }, overrides.academy);
  }
  const academy: Record<number, AcademyDef> = {};
  for (const r of academyRows) {
    const lv = num(r.level);
    if (lv <= 0) continue;
    academy[lv] = {
      level: lv,
      checkIntervalSec: num(r.checkIntervalSec, 3600),
      baseProbability: num(r.baseProbability, 0.1),
      probabilityGainPerFail: num(r.probabilityGainPerFail, 0.02),
      maxProbability: num(r.maxProbability, 0.3),
      popFactor: num(r.popFactor, 0),
    };
  }
  // academy 缺级回退：向下复制，保证任意等级都能取到参数。
  const maxAcLv = Object.keys(academy).map(Number).sort((a, b) => a - b);
  if (maxAcLv.length) {
    let last = academy[maxAcLv[0]];
    for (let lv = 1; lv <= maxAcLv[maxAcLv.length - 1]; lv++) {
      if (academy[lv]) last = academy[lv];
      else academy[lv] = { ...last };
    }
  }

  // mercCamp 缺级回退：从已解析的最高有效级向下复制，保证任意营地等级都能取到参数。
  const maxMercLv = Object.keys(mercCamp).map(Number).sort((a, b) => a - b);
  if (maxMercLv.length) {
    let last = mercCamp[maxMercLv[0]];
    for (let lv = 1; lv <= maxMercLv[maxMercLv.length - 1]; lv++) {
      if (mercCamp[lv]) last = mercCamp[lv];
      else mercCamp[lv] = { ...last };
    }
  }

  // tradeCenter 缺级回退：从已解析的最高有效级向下复制，保证任意贸易中心等级都能取到参数。
  const maxTcLv = Object.keys(tradeCenter).map(Number).sort((a, b) => a - b);
  if (maxTcLv.length) {
    let last = tradeCenter[maxTcLv[0]];
    for (let lv = 1; lv <= maxTcLv[maxTcLv.length - 1]; lv++) {
      if (tradeCenter[lv]) last = tradeCenter[lv];
      else tradeCenter[lv] = { ...last };
    }
  }

  // 声明式任务图：每层独立 CSV，加载时编译成当前运行时兼容的 QuestDef。
  // 这样任务线、条件、目标、效果与关系边可单独审查，旧玩家玩法不变。
  const unique = (rows: Record<string, string>[], file: string, key = 'id') => {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = (row[key] ?? '').trim();
      if (!value) throw new Error(`${file} 缺少 ${key}`);
      if (seen.has(value)) throw new Error(`${file} 的 ${key} 重复：${value}`);
      seen.add(value);
    }
  };
  const lineRows = loadCsv(p('quest_lines.csv'));
  const graphQuestRows = loadCsv(p('quests.csv'));
  const conditionRows = loadCsv(p('quest_conditions.csv'));
  const objectiveRows = loadCsv(p('quest_objectives.csv'));
  const effectRows = loadCsv(p('quest_effects.csv'));
  const edgeRows = loadCsv(p('quest_edges.csv'));
  unique(lineRows, 'quest_lines.csv', 'code');
  unique(graphQuestRows, 'quests.csv', 'code');
  unique(conditionRows, 'quest_conditions.csv');
  unique(objectiveRows, 'quest_objectives.csv');
  unique(effectRows, 'quest_effects.csv');
  unique(edgeRows, 'quest_edges.csv');

  const questGraph: QuestGraphDef = { lines: {}, quests: {}, conditions: [], objectives: [], effects: [], edges: [] };
  for (const r of lineRows) {
    const code = r.code.trim();
    questGraph.lines[code] = { code, name: r.name ?? code, kind: (r.kind as QuestType) || 'side', entryQuest: r.entryQuest?.trim() || '', order: num(r.order) };
  }
  for (const r of graphQuestRows) {
    const code = r.code.trim();
    questGraph.quests[code] = {
      id: num(r.id), code, lineCode: r.lineCode?.trim() || '', name: r.name ?? code, desc: r.desc ?? '',
      type: (r.type as QuestType) || 'side',
      scope: ((r.scope?.trim() || ((r.type as QuestType) === 'main' ? 'global' : 'village')) as QuestScope),
      acceptCost: parseResourceList(r.acceptCost) ?? undefined,
      weight: Math.max(0, num(r.weight, 0)),
      repeatable: num(r.repeatable, 0) === 1, cooldownSec: Math.max(0, num(r.cooldownSec, 0)),
      abandonCooldownSec: Math.max(0, num(r.abandonCooldownSec, 0)),
    };
  }
  for (const r of conditionRows) questGraph.conditions.push({ id: r.id.trim(), questCode: r.questCode.trim(), phase: (r.phase as QuestConditionDef['phase']) || 'offer', group: r.group?.trim() || 'all', kind: r.kind?.trim() || '', value: r.value?.trim() || '' });
  for (const r of objectiveRows) questGraph.objectives.push({ id: r.id.trim(), questCode: r.questCode.trim(), kind: r.kind as QuestObjectiveKind, params: r.params?.trim() || '', order: num(r.order) });
  for (const r of effectRows) questGraph.effects.push({ id: r.id.trim(), questCode: r.questCode.trim(), phase: (r.phase as QuestEffectDef['phase']) || 'deliver', kind: r.kind?.trim() || '', params: r.params?.trim() || '', order: num(r.order) });
  for (const r of edgeRows) questGraph.edges.push({ id: r.id.trim(), fromQuest: r.fromQuest?.trim() || '', toQuest: r.toQuest?.trim() || '', relation: (r.relation as QuestEdgeDef['relation']) || 'requires', order: num(r.order) });

  const objectiveOf = (row: QuestObjectiveDef): QuestObjective => {
    if (row.kind === 'repair_buildings') {
      return {
        kind: row.kind,
        buildingKinds: row.params.split('|').map((kind) => kind.trim()).filter(Boolean),
      };
    }
    if (row.kind === 'build_buildings') {
      const [buildingZone, count] = row.params.split(':');
      return { kind: row.kind, buildingZone: (buildingZone?.trim() || 'inner') as 'inner' | 'outer', count: Math.max(1, num(count, 1)) };
    }
    if (row.kind === 'population_reached' || row.kind === 'explore_tiles' || row.kind === 'main_base_level') {
      return { kind: row.kind, count: Math.max(1, num(row.params, 1)) };
    }
    if (row.kind === 'resource_owned') {
      const [resourceKey, count] = row.params.split(':');
      return { kind: row.kind, resourceKey: resourceKey?.trim(), count: Math.max(1, num(count, 1)) };
    }
    if (row.kind === 'clear_camp') { const [campTemplate, count] = row.params.split(':'); return { kind: row.kind, campTemplate: campTemplate?.trim(), count: Math.max(1, num(count, 1)) }; }
    if (row.kind === 'sell_discard_treasure') { const [minRarity, count] = row.params.split(':'); return { kind: row.kind, minRarity: minRarity?.trim() || 'rare', count: Math.max(1, num(count, 1)) }; }
    if (row.kind === 'carry_flag') { const [flagCode, minTroops] = row.params.split(':'); return { kind: row.kind, flagCode: flagCode?.trim(), minTroops: Math.max(1, num(minTroops, 1)) }; }
    if (row.kind === 'deliver_to_npc') { const [deliverResource, deliverAmount] = row.params.split(':'); return { kind: row.kind, deliverResource: deliverResource?.trim() || 'crop', deliverAmount: Math.max(1, num(deliverAmount, 1)) }; }
    if (row.kind === 'research_completed') {
      const [researchCode, count] = row.params.includes(':') ? row.params.split(':') : ['', row.params];
      return { kind: row.kind, researchCode: researchCode?.trim() || undefined, count: Math.max(1, num(count, 1)) };
    }
    if (row.kind === 'kill_units') {
      const [unitCategory, count] = row.params.split(':');
      return { kind: row.kind, unitCategory: unitCategory?.trim() || 'cavalry', count: Math.max(1, num(count, 1)) };
    }
    if (row.kind === 'raid_task_village') return { kind: row.kind, taskVillageCode: row.params.trim() || 'tianwang_village', count: 1 };
    if (row.kind === 'defend_task_village') return { kind: row.kind, taskVillageCode: row.params.trim() || 'tianwang_village', count: 1 };
    if (row.kind === 'investigate_task_village') return { kind: row.kind, taskVillageCode: row.params.trim() || 'secret_camp', count: 1 };
    if (row.kind === 'reputation_at_most') return { kind: row.kind, threshold: num(row.params, 0), count: 1 };
    if (row.kind === 'dice_match') {
      const [difficulty, targetScore, winsRequired] = row.params.split(':');
      const normalized = difficulty === 'normal' || difficulty === 'hard' ? difficulty : 'easy';
      return {
        kind: row.kind,
        count: Math.max(1, num(winsRequired, 1)),
        diceDifficulty: normalized,
        diceTargetScore: Math.max(1, num(targetScore, 2000)),
        diceWinsRequired: Math.max(1, num(winsRequired, 1)),
      };
    }
    return { kind: 'submit_resources', resources: parseResourceList(row.params) ?? {} };
  };
  const parseReputationMercenaryExchange = (s: string): { unitCode: string; perPoint: number } | null => {
    const [unitCode, rawPerPoint] = (s ?? '').split(':').map((value) => value.trim());
    const perPoint = num(rawPerPoint, 0);
    if (!unitCode || !Number.isFinite(perPoint) || perPoint <= 0) return null;
    return { unitCode, perPoint };
  };
  const rewardsOf = (rows: QuestEffectDef[]): QuestRewards => {
    const resourceEffects = rows.filter((x) => x.kind === 'grant_resources').flatMap((x) => Object.entries(parseResourceList(x.params) ?? {}));
    const treasures = rows.filter((x) => x.kind === 'grant_treasure').flatMap((x) => x.params.split('|').map((v) => v.trim()).filter(Boolean));
    const reputation = rows.filter((x) => x.kind === 'adjust_reputation').reduce((sum, x) => sum + num(x.params, 0), 0);
    const population = rows.filter((x) => x.kind === 'grant_population').reduce((sum, x) => sum + Math.max(0, num(x.params, 0)), 0);
    const researchPoints = rows.filter((x) => x.kind === 'grant_research_points').reduce((sum, x) => sum + Math.max(0, num(x.params, 0)), 0);
    const populationGrowth = rows
      .map((x) => x.kind === 'grant_population_growth' ? parsePopulationGrowthReward(x.params) : null)
      .find((value): value is { percent: number; durationSec: number } => !!value);
    const resourceGrowth = rows
      .map((x) => x.kind === 'grant_resource_growth' ? parseResourceGrowthReward(x.params) : null)
      .find((value): value is { percent: number; durationSec: number } => !!value);
    const buildingUnlocks = rows
      .filter((x) => x.kind === 'unlock_buildings')
      .flatMap((x) => x.params.split('|').map((v) => v.trim()).filter(Boolean));
    const reputationMercenaryExchange = rows
      .map((x) => x.kind === 'grant_mercenaries_by_positive_reputation' ? parseReputationMercenaryExchange(x.params) : null)
      .find((value): value is { unitCode: string; perPoint: number } => !!value);
    const out: QuestRewards = {};
    if (resourceEffects.length) out.resources = Object.fromEntries(resourceEffects);
    if (treasures.length) out.treasures = treasures;
    if (reputation !== 0) out.reputation = reputation;
    if (population > 0) out.population = population;
    if (researchPoints > 0) out.researchPoints = researchPoints;
    if (populationGrowth) out.populationGrowth = populationGrowth;
    if (resourceGrowth) out.resourceGrowth = resourceGrowth;
    if (buildingUnlocks.length) out.buildingUnlocks = [...new Set(buildingUnlocks)];
    if (reputationMercenaryExchange) out.reputationMercenaryExchange = reputationMercenaryExchange;
    return out;
  };
  const conditionalRewardsOf = (rows: QuestEffectDef[]): QuestConditionalRewards | undefined => {
    const out: QuestConditionalRewards = {};
    for (const row of rows) {
      if (row.kind !== 'grant_population_m8_success' && row.kind !== 'grant_treasure_m8_failure') continue;
      if (row.kind === 'grant_population_m8_success') out.m8_success = { ...(out.m8_success ?? {}), population: Math.max(0, num(row.params, 0)) };
      else out.m8_failure = { ...(out.m8_failure ?? {}), treasures: row.params.split('|').map((v) => v.trim()).filter(Boolean) };
    }
    return out.m8_success || out.m8_failure ? out : undefined;
  };
  const choiceRewardsOf = (rows: QuestEffectDef[]): QuestChoiceReward[] => {
    const choice = rows.find((x) => x.kind === 'natalie_choice');
    if (!choice) return [];
    const parts = choice.params.split('|').map((v) => v.trim()).filter(Boolean);
    const capturedCode = parts[0] || 'captured_natalies';
    const choices: QuestChoiceReward[] = [];
    for (const part of parts.slice(1)) {
      const separator = part.indexOf(':');
      if (separator <= 0) continue;
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      if (key !== 'store' && key !== 'release') continue;
      const rewards: QuestRewards = {};
      if (key === 'store') rewards.treasures = [capturedCode];
      if (key === 'release' && value) rewards.treasures = [value];
      if (key === 'release') {
        const gold = parts.find((x) => x.startsWith('gold:'));
        if (gold) rewards.resources = { gold: num(gold.slice(5), 0) };
        rewards.reputation = constants.reputationS4ReleaseDelta;
      }
      const phase = key === 'store' ? 'failure' : 'success';
      const phaseRows = rows.filter((x) => x.phase === phase && x.kind === 'adjust_reputation');
      const phaseRep = phaseRows.reduce((sum, x) => sum + num(x.params, 0), 0);
      if (phaseRep !== 0) rewards.reputation = phaseRep;
      choices.push({ key, label: key === 'store' ? '放入宝库（任务失败）' : '释放（完成任务）', rewards });
    }
    return choices;
  };
  const quests: Record<string, QuestDef> = {};
  for (const def of Object.values(questGraph.quests)) {
    if (!questGraph.lines[def.lineCode]) throw new Error(`quests.csv 任务 ${def.code} 引用了不存在的任务线：${def.lineCode}`);
    const objectives = questGraph.objectives.filter((x) => x.questCode === def.code).sort((a, b) => a.order - b.order);
    if (objectives.length !== 1) throw new Error(`任务 ${def.code} 当前兼容引擎要求恰好一个目标，实际 ${objectives.length}`);
    const allEffects = questGraph.effects.filter((x) => x.questCode === def.code).sort((a, b) => a.order - b.order);
    const effects = allEffects.filter((x) => x.phase === 'deliver' || x.phase === 'success');
    const choiceRewards = choiceRewardsOf(allEffects);
    const genericEffects = effects.filter((x) => x.kind !== 'natalie_choice');
    const rewards = rewardsOf(genericEffects);
    const failureRows = allEffects.filter((x) => x.phase === 'failure');
    const failureRewards = rewardsOf(failureRows);
    const conditionalRewards = conditionalRewardsOf(allEffects);
    const requires = questGraph.edges.filter((x) => x.toQuest === def.code && x.relation === 'requires').sort((a, b) => a.order - b.order).map((x) => x.fromQuest);
    const offer = questGraph.conditions.filter((x) => x.questCode === def.code && x.phase === 'offer');
    // 一个任务可以由多个独立 offer 条件共同触发；运行时会按声明的 group
    // 逐项评估。legacy trigger 仅保留第一条供旧客户端显示。
    const trigger = offer[0]
      ? (offer[0].kind === 'pve_camp_cleared' || offer[0].kind === 'secret_note_used' || offer[0].kind === 'tavern_refresh'
        ? offer[0].kind
        : `${offer[0].kind}:${offer[0].value}`)
      : undefined;
    quests[def.code] = {
      id: def.id, code: def.code, lineCode: def.lineCode, name: def.name, desc: def.desc, type: def.type, scope: def.scope, requires,
      acceptCost: def.acceptCost,
      objective: objectiveOf(objectives[0]), rewards, failureRewards, choiceRewards: choiceRewards.length ? choiceRewards : undefined,
      conditionalRewards,
      weight: def.weight, trigger, repeatable: def.repeatable, cooldownSec: def.cooldownSec,
      abandonCooldownSec: def.abandonCooldownSec, dailyRewardValue: 0, campSearchRadius: 4, campRetrySec: 300, campMaxRadius: 12,
    };
  }
  const dialogues: Record<string, DialogueDef> = {};
  // 旧配置目录可能尚未包含新表；空目录仍可启动，仓库配置则必须通过下方完整校验。
  const dialogueRows = existsSync(p('dialogues.csv')) ? loadCsv(p('dialogues.csv')) : [];
  const dialogueKeys = new Set<string>();
  for (const r of dialogueRows) {
    const code = r.code?.trim();
    if (!code) continue;
    const id = num(r.id);
    const rawSegment = r.segment === undefined || r.segment === '' ? 1 : Number(r.segment);
    const segment = Number.isFinite(rawSegment) ? Math.floor(rawSegment) : 0;
    const key = `${code}:${segment}`;
    if (dialogueKeys.has(key)) throw new Error(`dialogues.csv 存在重复段落：${code}#${segment}`);
    dialogueKeys.add(key);
    dialogues[key] = {
      id,
      code,
      taskCode: r.taskCode?.trim() ?? '',
      trigger: r.trigger?.trim() || 'accept',
      segment,
      npcName: r.npcName?.trim() ?? '',
      npcText: r.npcText?.trim() ?? '',
      replies: parseDialogueReplies(r.replies ?? ''),
    };
  }
  const pvpPowerCurve = loadCsv(p('pvp_power_curve.csv'))
    .map((r) => ({ maxRatio: Math.max(0, num(r.maxRatio, Number.MAX_SAFE_INTEGER)), lootMult: Math.max(0, Math.min(1, num(r.lootMult, 1))) }))
    .sort((a, b) => a.maxRatio - b.maxRatio);

  const config: GameConfig = {
    resources, buildings, townCenterSlots, units, unitTraits, pveTemplates, pveSpawns, constants, villageTemplates, mercCamp, tradeCenter, kingdomServices, treasures, research, academy, quests, questGraph, dialogues, pvpPowerCurve,
  };
  validateGameConfig(config);
  return config;
}

/**
 * 热重载入口：重新从目录加载整套配置（含 validateGameConfig 校验；失败抛出 Error）。
 * 配合 app.reloadConfig() 使用——先在此校验通过，再写回磁盘，避免半截配置。
 * `overrides` 参数仅为旧版本迁移/兼容测试保留；生产运行时只调用不带 overrides
 * 的入口，CSV 是唯一配置事实源。部署迁移器会在启动新 release 前将旧
 * data/balance_overrides.json 一次性折叠到 CSV，之后不再读取该文件。
 */
export function reloadGameConfig(configDir: string, overrides?: BalanceOverrides): GameConfig {
  return loadGameConfig(configDir, overrides);
}

/**
 * 启动期配置校验：把"运行时才暴露的错误"提前到启动失败，错误信息定位到表/字段。
 * 覆盖：跨表引用合法性、关键值范围、建筑 requires 循环依赖。
 * 任何错误抛出 Error（聚合所有问题一次性报出，便于一次改完）。
 */
export function validateGameConfig(config: GameConfig): void {
  const errors: string[] = [];
  const resourceKeys = new Set(config.resources.map((r) => r.key));
  const knownTribes = new Set(['romans', 'gauls', 'teutons']);

  for (const service of Object.values(config.kingdomServices)) {
    if (!['reinforcement', 'attack', 'supplies', 'treasure'].includes(service.category)) {
      errors.push(`kingdom_services.csv[${service.code}] category 非法：${service.category}`);
    }
    if ((service.category === 'reinforcement' || service.category === 'attack') && (!service.unitCode || !config.units[service.unitCode])) {
      errors.push(`kingdom_services.csv[${service.code}] 兵种 ${service.unitCode ?? '(空)'} 不在 units.csv`);
    }
    if (service.category === 'treasure' && (!service.treasureCode || !config.treasures[service.treasureCode])) {
      errors.push(`kingdom_services.csv[${service.code}] 宝物 ${service.treasureCode ?? '(空)'} 不在 treasures.csv`);
    }
  }

  // resources：必须含 economy 依赖的 4 种结构字段
  for (const need of ['wood', 'clay', 'iron', 'crop']) {
    if (!resourceKeys.has(need)) errors.push(`resources.csv 缺少必需资源 id=${need}（economy 结构字段）`);
  }

  // buildings：zone 合法；恰好一个 center；资源田产出字段；requires 引用存在；范围
  const buildingCodes = new Set(Object.keys(config.buildings));
  let centerCount = 0;
  let centerMaxLevel = 0;
  for (const b of Object.values(config.buildings)) {
    if (b.zone !== 'center' && b.zone !== 'inner' && b.zone !== 'outer') {
      errors.push(`buildings.csv[${b.kind}] zone=${b.zone} 必须是 center/inner/outer`);
    }
    if (b.zone === 'center') { centerCount++; centerMaxLevel = b.maxLevel; }
    if (b.resource !== undefined) {
      if (!resourceKeys.has(b.resource)) errors.push(`buildings.csv[${b.kind}] resource=${b.resource} 不在 resources.csv`);
      if (b.zone !== 'outer') errors.push(`buildings.csv[${b.kind}] 有产出(resource)必须归 outer 区`);
    }
    if (b.maxLevel <= 0) errors.push(`buildings.csv[${b.kind}] maxLevel 必须>0（当前${b.maxLevel}）`);
    if (b.maxCount !== -1 && (!Number.isInteger(b.maxCount) || b.maxCount < 1)) errors.push(`buildings.csv[${b.kind}] maxCount 必须为 -1 或正整数（当前${b.maxCount}）`);
    if (!Number.isInteger(b.mainBaseLevel) || b.mainBaseLevel < 1) errors.push(`buildings.csv[${b.kind}] mainBaseLevel 必须是≥1的整数`);
    // 逐等级参数（building_levels.csv）：必须覆盖 1..maxLevel；popCap≥0；prod 仅资源田且≥0
    for (let lv = 1; lv <= b.maxLevel; lv++) {
      const ld = b.levels[lv];
      if (!ld) {
        errors.push(`building_levels.csv[${b.kind}] 缺少 level=${lv}（需覆盖 1..${b.maxLevel}）`);
        continue;
      }
      if (ld.popCap < 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} popCap 不能为负`);
      if (ld.taskSideQuestChance !== undefined) {
        if (b.kind !== 'tavern' && ld.taskSideQuestChance !== 0) {
          errors.push(`building_levels.csv[${b.kind}] level=${lv} taskSideQuestChance 仅允许用于 tavern`);
        }
        if (ld.taskSideQuestChance < 0 || ld.taskSideQuestChance > 1) {
          errors.push(`building_levels.csv[${b.kind}] level=${lv} taskSideQuestChance 必须在 0..1`);
        }
      }
      for (const [field, value] of [
        ['vaultProtectWood', ld.vaultProtectWood], ['vaultProtectClay', ld.vaultProtectClay],
        ['vaultProtectIron', ld.vaultProtectIron], ['vaultProtectCrop', ld.vaultProtectCrop],
        ['vaultProtectGold', ld.vaultProtectGold],
      ] as const) {
        if (value !== undefined && value < 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} ${field} 不能为负`);
        if (b.kind !== 'vault' && value !== undefined && value !== 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} ${field} 仅允许用于 vault`);
      }
      if (b.resource !== undefined) {
        if (ld.prod === undefined || ld.prod < 0) errors.push(`building_levels.csv[${b.kind}] level=${lv} 资源田 prod 必须≥0`);
      } else if (ld.prod !== undefined) {
        errors.push(`building_levels.csv[${b.kind}] level=${lv} 非资源田不应有 prod`);
      }
    }
    for (const r of b.requires) {
      if (!buildingCodes.has(r.kind)) errors.push(`buildings.csv[${b.kind}] requires 引用了不存在的建筑 ${r.kind}`);
      if (r.level <= 0) errors.push(`buildings.csv[${b.kind}] requires 等级必须>0`);
    }
    if (b.prosperityPerLevel < 0) errors.push(`buildings.csv[${b.kind}] prosperityPerLevel 必须≥0（当前${b.prosperityPerLevel}）`);
    if (b.popGrowthPerLevel < 0) errors.push(`buildings.csv[${b.kind}] popGrowthPerLevel 必须≥0（当前${b.popGrowthPerLevel}）`);
    if (b.kind === 'main' && b.popGrowthPerLevel <= 0) errors.push(`buildings.csv[main] popGrowthPerLevel 必须>0（人口增长绑在城镇中心上；当前${b.popGrowthPerLevel}）`);
  }
  if (centerCount !== 1) errors.push(`buildings.csv 必须恰好有一个 zone=center 的建筑（城镇中心），当前 ${centerCount} 个`);
  for (const b of Object.values(config.buildings)) {
    if (centerMaxLevel > 0 && b.mainBaseLevel > centerMaxLevel) errors.push(`buildings.csv[${b.kind}] mainBaseLevel=${b.mainBaseLevel} 超过主基地最高等级 ${centerMaxLevel}`);
  }

  // town_center_slots：覆盖 1..城镇中心maxLevel；槽位单调不减；queue≥1
  if (centerMaxLevel > 0) {
    let prevInner = 0, prevOuter = 0;
    for (let lv = 1; lv <= centerMaxLevel; lv++) {
      const tier = config.townCenterSlots[lv];
      if (!tier) { errors.push(`town_center_slots.csv 缺少 tcLevel=${lv}（需覆盖 1..${centerMaxLevel}）`); continue; }
      if (tier.inner < prevInner) errors.push(`town_center_slots.csv tcLevel=${lv} innerSlots 比上一级小（须单调不减）`);
      if (tier.outer < prevOuter) errors.push(`town_center_slots.csv tcLevel=${lv} outerSlots 比上一级小（须单调不减）`);
      if (tier.queue < 1) errors.push(`town_center_slots.csv tcLevel=${lv} queueSlots 必须≥1`);
      prevInner = tier.inner; prevOuter = tier.outer;
    }
  }

  // 建筑 requires 循环依赖检测（DFS 找环）
  const cycle = findRequiresCycle(config.buildings);
  if (cycle) errors.push(`buildings.csv requires 存在循环依赖：${cycle.join(' → ')}`);

  // unit_traits：每个 effect 必须是已知枚举，且至少有一个效果
  const traitEffects = new Set<TraitEffect>(TRAIT_EFFECTS);
  const traitCodes = new Set(Object.keys(config.unitTraits));
  for (const t of Object.values(config.unitTraits)) {
    if (t.effects.length === 0) {
      errors.push(`unit_traits.csv[${t.code}] 没有任何效果（effect1 不能为空）`);
    }
    for (const e of t.effects) {
      if (!traitEffects.has(e.effect)) {
        errors.push(`unit_traits.csv[${t.code}] effect=${e.effect} 不是已知效果（${TRAIT_EFFECTS.join('/')}）`);
      }
    }
  }

  // units：所需建筑必须存在；form 枚举；线上/模拟器 traits 引用存在；范围
  for (const u of Object.values(config.units)) {
    if (!u.isMercenary && !knownTribes.has(u.tribe) && u.tribe !== 'all') {
      errors.push(`units.csv[${u.key}] tribe=${u.tribe} 必须是 romans/gauls/teutons/all`);
    }
    if (u.building && !buildingCodes.has(u.building)) {
      errors.push(`units.csv[${u.key}] building=${u.building} 不在 buildings.csv`);
    }
    if (u.form !== 'melee' && u.form !== 'ranged') {
      errors.push(`units.csv[${u.key}] form=${u.form} 必须是 melee 或 ranged`);
    }
    for (const tc of u.traits) {
      if (!traitCodes.has(tc)) errors.push(`units.csv[${u.key}] traits 引用了不存在的特性 ${tc}`);
    }
    for (const tc of u.simTraits ?? []) {
      if (!traitCodes.has(tc)) errors.push(`units.csv[${u.key}] simTraits 引用了不存在的特性 ${tc}`);
    }
    // 雇佣兵不走 military.TrainTroops（trainSec=0 合法），普通兵种仍要求 trainSec>0 防零除
    if (!u.isMercenary && u.trainSec <= 0) errors.push(`units.csv[${u.key}] trainSec 必须>0（防零除，当前${u.trainSec}）`);
    if (u.speed <= 0) errors.push(`units.csv[${u.key}] speed 必须>0（防零除，当前${u.speed}）`);
    if (u.popCost < 0) errors.push(`units.csv[${u.key}] popCost 必须≥0（当前${u.popCost}）`);
    if (u.hp <= 0) errors.push(`units.csv[${u.key}] hp 必须>0（当前${u.hp}）`);
  }

  // pve：每个模板必须有守军；spawn 目标必须存在且坐标在地图内
  const pveCodes = new Set(Object.keys(config.pveTemplates));
  for (const p of Object.values(config.pveTemplates)) {
    if (p.faction !== 'neutral' && p.faction !== 'kingdom') errors.push(`pve_targets.csv[${p.type}] faction 必须是 neutral 或 kingdom`);
    // happy_village（幸福村）和 kingdom_city_state（运行时随机生成）允许不在静态守军表中配置。
    if (Object.keys(p.defender).length === 0 && p.type !== 'happy_village' && !p.cityState) errors.push(`pve_targets.csv[${p.type}] 没有任何守军（pve_defenders.csv 至少应有一行）`);
    for (const [unitCode, defender] of Object.entries(p.defender)) {
      if ((defender.hp ?? 1) <= 0) errors.push(`pve_defenders.csv[${p.type}/${unitCode}] hp 必须>0（当前${defender.hp ?? 0}）`);
      for (const tc of defender.traitCodes ?? []) {
        if (!traitCodes.has(tc)) errors.push(`pve_defenders.csv[${p.type}/${unitCode}] traits 引用了不存在的特性 ${tc}`);
      }
    }
  }
  for (const s of config.pveSpawns) {
    if (!pveCodes.has(s.type)) errors.push(`pve_spawns.csv[${s.id}] targetId 指向的目标 ${s.type} 不在 pve_targets.csv`);
    if (!Number.isFinite(s.q) || !Number.isFinite(s.r)) {
      errors.push(`pve_spawns.csv[${s.id}] 坐标非数值`);
    }
    // 注：坐标可为负或超出 [0,W)×[0,H)，放置时 world.PlacePve 会按环面取模归一。
  }

  // 宝物目录：类别/稀有度/效果类型/应用方式必须在已知枚举内；数值范围合理
  const TREASURE_CATEGORIES = new Set(['economic', 'military', 'social', 'special']);
  const TREASURE_RARITIES = new Set(['common', 'rare', 'epic', 'legendary']);
  const TREASURE_EFFECTS = new Set(['woodRate', 'clayRate', 'ironRate', 'cropRate', 'goldRate', 'allResRate', 'atkMult', 'defMult', 'popGrowth', 'reputation', 'instantGold', 'ritualBuff', 'cavalryTrainSpeed', 'soldierFoodReduce', 'victoryFlag', 'reportCoords', 'honestHeart', 'dialogue', 'blackBadge', 'enemyCavalryDef']);
  const TREASURE_APPLY = new Set(['passive', 'instant']);
  for (const t of Object.values(config.treasures)) {
    if (!t.code) errors.push(`treasures.csv 存在空 code 的行`);
    if (!t.name) errors.push(`treasures.csv[${t.code}] name 不能为空`);
    if (!t.icon) errors.push(`treasures.csv[${t.code}] icon 不能为空`);
    if (!TREASURE_CATEGORIES.has(t.category)) errors.push(`treasures.csv[${t.code}] category=${t.category} 必须是 economic/military/social/special`);
    if (!TREASURE_RARITIES.has(t.rarity)) errors.push(`treasures.csv[${t.code}] rarity=${t.rarity} 必须是 common/rare/epic/legendary`);
    if (!TREASURE_EFFECTS.has(t.effectType)) errors.push(`treasures.csv[${t.code}] effectType=${t.effectType} 不是已知效果`);
    if (!TREASURE_APPLY.has(t.applyType)) errors.push(`treasures.csv[${t.code}] applyType=${t.applyType} 必须是 passive/instant`);
    if (t.effectValue < 0 && t.effectType !== 'reputation') errors.push(`treasures.csv[${t.code}] effectValue 必须≥0（当前${t.effectValue}）`);
    if (t.priceGold < 0) errors.push(`treasures.csv[${t.code}] priceGold 必须≥0（当前${t.priceGold}）`);
    if (t.dropRate < 0 || t.dropRate > 1) errors.push(`treasures.csv[${t.code}] dropRate 必须在[0,1]（当前${t.dropRate}）`);
  }

  // village_templates：预置建筑 code 必须存在；资源覆盖 key 必须存在；开局预置不超 tcLevel=1 槽位
  const tier1 = config.townCenterSlots[1];
  for (const need of knownTribes) {
    if (!config.villageTemplates[need]) errors.push(`village_templates.csv 缺少部族模板 ${need}`);
  }
  for (const t of Object.values(config.villageTemplates)) {
    if (!knownTribes.has(t.tribe)) errors.push(`village_templates.csv[${t.tribe}] tribe 必须是 romans/gauls/teutons`);
    let innerUsed = 0, outerUsed = 0, centerUsed = 0;
    for (const code of Object.keys(t.startPlaced)) {
      const def = config.buildings[code];
      if (!def) { errors.push(`village_templates.csv[${t.tribe}] start_placed 含未知建筑 ${code}`); continue; }
      if (def.zone === 'center') centerUsed++;
      else if (def.zone === 'inner') innerUsed++;
      else outerUsed++;
    }
    if (centerUsed !== 1) errors.push(`village_templates.csv[${t.tribe}] 开局必须恰好含 1 个城镇中心(center)，当前 ${centerUsed}`);
    if (tier1) {
      if (innerUsed > tier1.inner) errors.push(`village_templates.csv[${t.tribe}] 开局城内预置 ${innerUsed} 超过 tcLevel=1 上限 ${tier1.inner}`);
      if (outerUsed > tier1.outer) errors.push(`village_templates.csv[${t.tribe}] 开局城外预置 ${outerUsed} 超过 tcLevel=1 上限 ${tier1.outer}`);
    }
    if (t.startResources) {
      for (const code of Object.keys(t.startResources)) {
        if (!resourceKeys.has(code)) errors.push(`village_templates.csv[${t.tribe}] start_resources 含未知资源 ${code}`);
      }
    }
    for (const [code, target] of Object.entries(t.startDamaged ?? {})) {
      const def = config.buildings[code];
      if (!def) { errors.push(`village_templates.csv[${t.tribe}] start_damaged 含未知建筑 ${code}`); continue; }
      if (!Number.isInteger(target) || target < 1 || target > def.maxLevel) {
        errors.push(`village_templates.csv[${t.tribe}] start_damaged.${code} 修复目标等级 ${target} 超出 1..${def.maxLevel}`);
      }
      if (t.startPlaced[code] !== 0) errors.push(`village_templates.csv[${t.tribe}] start_damaged.${code} 必须在 start_placed 中以 0 级占位`);
    }
  }

  // constants：关键范围
  const c = config.constants;
  if (c.mapSize <= 0) errors.push(`game_constants.csv map_size 必须>0`);
  if (c.mapViewRadius <= 0) errors.push(`game_constants.csv map_view_radius 必须>0`);
  if (c.worldW <= 0) errors.push(`game_constants.csv world_width 必须>0`);
  if (c.worldH <= 0) errors.push(`game_constants.csv world_height 必须>0`);
  if (c.mainBuildSpeedupCap < 0 || c.mainBuildSpeedupCap >= 1) errors.push(`game_constants.csv main_build_speedup_cap 必须在[0,1)`);
  // 宝物掉落总体概率：必须在 [0,1]
  if (c.treasureCampDropChance < 0 || c.treasureCampDropChance > 1) errors.push(`game_constants.csv treasure_camp_drop_chance 必须在[0,1]（当前${c.treasureCampDropChance}）`);
  if (c.treasureClaimTimeoutSec <= 0) errors.push(`game_constants.csv treasure_claim_timeout_sec 必须>0（当前${c.treasureClaimTimeoutSec}）`);
  if (c.treasureCarryTroopsPerSlot <= 0) errors.push(`game_constants.csv treasure_carry_troops_per_slot 必须>0（当前${c.treasureCarryTroopsPerSlot}）`);
  if (c.treasureCarryMaxSlots <= 0) errors.push(`game_constants.csv treasure_carry_max_slots 必须>0（当前${c.treasureCarryMaxSlots}）`);
  if (c.alchemyRefineSec <= 0) errors.push(`game_constants.csv alchemy_refine_sec 必须>0（当前${c.alchemyRefineSec}）`);
  if (c.trainTimeReduceCap < 0 || c.trainTimeReduceCap >= 1) errors.push(`game_constants.csv train_time_reduce_cap 必须在[0,1)`);
  if (c.trainCostReduceCap < 0 || c.trainCostReduceCap >= 1) errors.push(`game_constants.csv train_cost_reduce_cap 必须在[0,1)`);
  if (c.storageBase <= 0) errors.push(`game_constants.csv storage_base 必须>0`);
  if (c.combatTickMs <= 0) errors.push(`game_constants.csv combat_tick_ms 必须>0`);
  if (c.combatStrength <= 0) errors.push(`game_constants.csv combat_strength 必须>0`);
  if (c.combatInfluenceReferenceValue <= 0) errors.push(`game_constants.csv combat_influence_reference_value 必须>0`);
  if (c.combatInfluenceQualityExponent < 1) errors.push(`game_constants.csv combat_influence_quality_exponent 必须≥1`);
  if (c.combatInfluenceMinQuality < 0) errors.push(`game_constants.csv combat_influence_min_quality 必须≥0`);
  if (c.combatInfluenceMaxQuality < c.combatInfluenceMinQuality) errors.push(`game_constants.csv combat_influence_max_quality 必须≥min_quality`);
  for (const [key, value] of [
    ['combat_value_melee_attack_weight', c.combatValueMeleeAttackWeight],
    ['combat_value_ranged_attack_weight', c.combatValueRangedAttackWeight],
    ['combat_value_melee_defense_weight', c.combatValueMeleeDefenseWeight],
    ['combat_value_ranged_defense_weight', c.combatValueRangedDefenseWeight],
    ['combat_value_hp_weight', c.combatValueHpWeight],
  ] as const) if (value < 0) errors.push(`game_constants.csv ${key} 必须≥0`);
  if (c.ambushAttackBonus < 0) errors.push(`game_constants.csv ambush_attack_bonus 必须≥0`);
  if (c.marchSpeedMultiplier <= 0) errors.push(`game_constants.csv march_speed_multiplier 必须>0`);
  if (c.forestVisionPenalty < 0) errors.push(`game_constants.csv forest_vision_penalty 必须≥0`);
  if (c.hillsVisionBonus < 0) errors.push(`game_constants.csv hills_vision_bonus 必须≥0`);
  if (c.hillsMarchSpeedMultiplier <= 0 || c.hillsMarchSpeedMultiplier > 1) {
    errors.push(`game_constants.csv hills_march_speed_multiplier 必须在(0,1]`);
  }
  if (c.marchSizeReferencePop < 0) errors.push(`game_constants.csv march_size_reference_pop 必须≥0`);
  if (c.marchSizePenalty < 0) errors.push(`game_constants.csv march_size_penalty 必须≥0`);
  if (c.marchSizeMinMultiplier <= 0 || c.marchSizeMinMultiplier > 1) {
    errors.push(`game_constants.csv march_size_min_multiplier 必须在(0,1]`);
  }
  if (c.kingdomCityStateResourceMin < 0 || c.kingdomCityStateResourceMax < c.kingdomCityStateResourceMin) errors.push(`game_constants.csv kingdom_city_state_resource_min/max 范围非法`);
  if (c.kingdomCityStateCount < 0 || !Number.isInteger(c.kingdomCityStateCount)) errors.push(`game_constants.csv kingdom_city_state_count 必须为非负整数`);
  if (c.kingdomCityStateGoldMin < 0 || c.kingdomCityStateGoldMax < c.kingdomCityStateGoldMin) errors.push(`game_constants.csv kingdom_city_state_gold_min/max 范围非法`);
  if (c.kingdomCityStateTroopsPerResource < 0) errors.push(`game_constants.csv kingdom_city_state_troops_per_resource 必须≥0`);
  if (c.kingdomCityStateTroopMin < 0 || c.kingdomCityStateTroopMax < c.kingdomCityStateTroopMin) errors.push(`game_constants.csv kingdom_city_state_troop_min/max 范围非法`);
  if (c.kingdomCityStateScoutRatio < 0 || c.kingdomCityStateScoutRatio > 1) errors.push(`game_constants.csv kingdom_city_state_scout_ratio 必须在[0,1]`);
  if (c.kingdomCityStateRaidDefenseMinRatio < 0 || c.kingdomCityStateRaidDefenseMaxRatio > 1 || c.kingdomCityStateRaidDefenseMaxRatio < c.kingdomCityStateRaidDefenseMinRatio) errors.push(`game_constants.csv kingdom_city_state_raid_defense_min/max_ratio 范围非法`);
  if (c.kingdomCityStateRecoveryMinSec <= 0 || c.kingdomCityStateRecoveryMaxSec < c.kingdomCityStateRecoveryMinSec) errors.push(`game_constants.csv kingdom_city_state_recovery_min/max_sec 范围非法`);
  if (c.kingdomCityStateRecoveryResourceExtraSec < 0) errors.push(`game_constants.csv kingdom_city_state_recovery_resource_extra_sec 必须≥0`);
  if (c.kingdomCityStateReputationPenalty < 0) errors.push(`game_constants.csv kingdom_city_state_reputation_penalty 必须≥0`);
  if (c.kingdomFiefUnitMin < 0 || c.kingdomFiefUnitMax < c.kingdomFiefUnitMin || c.kingdomCapitalUnitMin < 0 || c.kingdomCapitalUnitMax < c.kingdomCapitalUnitMin) errors.push(`game_constants.csv 王国封地/王都兵力范围非法`);
  if (c.kingdomFiefResourceMin < 0 || c.kingdomFiefResourceMax < c.kingdomFiefResourceMin || c.kingdomCapitalResourceMin < 0 || c.kingdomCapitalResourceMax < c.kingdomCapitalResourceMin) errors.push(`game_constants.csv 王国封地/王都资源范围非法`);
  if (c.kingdomFiefGoldMin < 0 || c.kingdomFiefGoldMax < c.kingdomFiefGoldMin || c.kingdomCapitalGoldMin < 0 || c.kingdomCapitalGoldMax < c.kingdomCapitalGoldMin) errors.push(`game_constants.csv 王国封地/王都金币范围非法`);
  if (c.kingdomPveKilledPopulationPerReputation <= 0 || c.kingdomPveRetaliationChunk <= 0) errors.push(`game_constants.csv 王国 PvE 声望累计参数必须>0`);
  if (c.kingdomPveRetaliationSiegeThreshold > c.kingdomPveRetaliationRaidThreshold) errors.push(`game_constants.csv 王国 PvE 报复阈值顺序非法`);
  if (c.kingdomFiefMercenaryMinRatio < 0 || c.kingdomFiefMercenaryMaxRatio > 1 || c.kingdomFiefMercenaryMaxRatio < c.kingdomFiefMercenaryMinRatio) errors.push(`game_constants.csv 王国封地雇佣军比例范围非法`);
  if (c.kingdomCityStateOuterBuildingCountMin < 4 || c.kingdomCityStateOuterBuildingCountMax < c.kingdomCityStateOuterBuildingCountMin) errors.push(`game_constants.csv kingdom_city_state_outer_building_count_min/max 范围非法`);
  if (c.kingdomCityStateInnerBuildingCountMin < 0 || c.kingdomCityStateInnerBuildingCountMax < c.kingdomCityStateInnerBuildingCountMin) errors.push(`game_constants.csv kingdom_city_state_inner_building_count_min/max 范围非法`);
  if (c.kingdomCityStateBuildingLevelMin <= 0 || c.kingdomCityStateBuildingLevelMax < c.kingdomCityStateBuildingLevelMin) errors.push(`game_constants.csv kingdom_city_state_building_level_min/max 范围非法`);
  if (c.kingdomCityStateGenerationVersion < 1 || !Number.isInteger(c.kingdomCityStateGenerationVersion)) errors.push(`game_constants.csv kingdom_city_state_generation_version 必须为正整数`);
  if (c.kingdomCityStateTribePool.length === 0) errors.push(`game_constants.csv kingdom_city_state_tribe_pool 不能为空`);
  if (Object.values(c.kingdomCityStateTierWeights).every((weight) => weight <= 0)) errors.push(`game_constants.csv kingdom_city_state_tier_weights 至少需要一个正权重`);
  const cityTiers = [
    [1, c.kingdomCityStateTier1UnitCount, c.kingdomCityStateTier1UnitMin, c.kingdomCityStateTier1UnitMax, c.kingdomCityStateTier1ResourceMin, c.kingdomCityStateTier1ResourceMax, c.kingdomCityStateTier1GoldMin, c.kingdomCityStateTier1GoldMax],
    [2, c.kingdomCityStateTier2UnitCount, c.kingdomCityStateTier2UnitMin, c.kingdomCityStateTier2UnitMax, c.kingdomCityStateTier2ResourceMin, c.kingdomCityStateTier2ResourceMax, c.kingdomCityStateTier2GoldMin, c.kingdomCityStateTier2GoldMax],
    [3, c.kingdomCityStateTier3UnitCount, c.kingdomCityStateTier3UnitMin, c.kingdomCityStateTier3UnitMax, c.kingdomCityStateTier3ResourceMin, c.kingdomCityStateTier3ResourceMax, c.kingdomCityStateTier3GoldMin, c.kingdomCityStateTier3GoldMax],
  ] as const;
  for (const [tier, unitCount, unitMin, unitMax, resourceMin, resourceMax, goldMin, goldMax] of cityTiers) {
    if (!Number.isInteger(unitCount) || unitCount < 1) errors.push(`game_constants.csv kingdom_city_state_tier${tier}_unit_count 必须为正整数`);
    if (!Number.isInteger(unitMin) || unitMin < 0 || !Number.isInteger(unitMax) || unitMax < unitMin) errors.push(`game_constants.csv kingdom_city_state_tier${tier}_unit_min/max 范围非法`);
    if (resourceMin < 0 || resourceMax < resourceMin) errors.push(`game_constants.csv kingdom_city_state_tier${tier}_resource_min/max 范围非法`);
    if (goldMin < 0 || goldMax < goldMin) errors.push(`game_constants.csv kingdom_city_state_tier${tier}_gold_min/max 范围非法`);
  }
  if (c.notificationsPerVillage <= 0) errors.push(`game_constants.csv notifications_per_village 必须>0`);
  // 人口常量范围校验（硬上限模型）
  if (c.popProsperityFullRatio <= 0 || c.popProsperityFullRatio > 1) errors.push(`game_constants.csv pop_prosperity_full_ratio 必须在(0,1]`);
  if (c.popProsperityMaxBonus < 0) errors.push(`game_constants.csv pop_prosperity_max_bonus 必须≥0`);
  if (c.popOvercapPenaltyFullRatio <= 1) errors.push(`game_constants.csv pop_overcap_penalty_full_ratio 必须>1（当前${c.popOvercapPenaltyFullRatio}）`);
  for (const [tribe, v] of Object.entries(c.popRaceMobilizeMax)) {
    if (v <= 0 || v > 1) {
      errors.push(`game_constants.csv pop_race_mobilize_max_${tribe} 必须在(0,1]（当前${v}）`);
    }
  }
  if (c.popCropPerLabor <= 0) errors.push(`game_constants.csv pop_crop_per_labor 必须>0（平民每小时口粮）`);
  if (c.popDeathRateFactor <= 0) errors.push(`game_constants.csv pop_death_rate_factor 必须>0`);
  if (c.popFamineTickSec <= 0) errors.push(`game_constants.csv pop_famine_tick_sec 必须>0`);
  if (c.popHospitalRecoveryBase < 0 || c.popHospitalRecoveryBase > 1) errors.push(`game_constants.csv pop_hospital_recovery_base 必须在[0,1]`);
  if (c.popHospitalRecoveryPerLevel < 0) errors.push(`game_constants.csv pop_hospital_recovery_per_level 必须≥0`);
  if (c.popHospitalRecoveryMax <= 0 || c.popHospitalRecoveryMax > 1) errors.push(`game_constants.csv pop_hospital_recovery_max 必须在(0,1]`);

  // 人口启动配置守卫：训练一个兵时，净粮食消耗不应下降（防止免费兵种）。
  // 推导：转化 1 名平民(popCost)为 1 个兵 → 释放平民口粮 popCost×popCropPerLabor，
  // 增加士兵口粮 popCost×(popCropPerLabor + upkeep)（默认口粮 + 军晌）；
  // 净变化 = popCost×upkeep ≥ 0（始终不降，除非 upkeep 为负）。
  // 故仅需守卫 upkeep ≥ 0（零资源零人口的特殊单位跳过）。
  for (const [key, u] of Object.entries(config.units)) {
    if (u.popCost <= 0 && u.upkeep <= 0) continue; // 特殊单位跳过
    if (u.upkeep < 0) {
      errors.push(
        `units.csv[${key}] 兵种 upkeep(${u.upkeep}) 不能为负`
      );
    }
  }

  // 科研系统校验
  const RESEARCH_BRANCHES = new Set(['military', 'production', 'social']);
  const RESEARCH_EFFECTS = new Set(['resource_rate', 'unit_unlock', 'building_unlock', 'pop_growth', 'storage_cap', 'combat_atk', 'combat_def', 'train_speed', 'build_speed', 'march_speed', 'carry_cap', 'mechanism']);
  const RESEARCH_SCOPES = new Set(['village', 'player']);
  const researchCodes = new Set(Object.keys(config.research));
  for (const t of Object.values(config.research)) {
    if (!t.code) errors.push('research.csv 存在空 code');
    if (!RESEARCH_BRANCHES.has(t.branch)) errors.push(`research.csv[${t.code}] branch=${t.branch} 必须是 military/production/social`);
    if (!t.effects.length) errors.push(`research_effects.csv 缺少 techCode=${t.code} 的效果`);
    for (const e of t.effects) {
      if (!RESEARCH_EFFECTS.has(e.effectType)) errors.push(`research_effects.csv[${t.code}] effectType=${e.effectType} 未知效果类型`);
      if (e.cap < 0) errors.push(`research_effects.csv[${t.code}] cap 不能为负`);
    }
    if (!RESEARCH_SCOPES.has(t.scope)) errors.push(`research.csv[${t.code}] scope=${t.scope} 必须是 village/player`);
    if (t.tier < 1) errors.push(`research.csv[${t.code}] tier=${t.tier} 必须≥1`);
    if (!Number.isInteger(t.mainBaseLevel) || t.mainBaseLevel < 1) errors.push(`research.csv[${t.code}] mainBaseLevel 必须是≥1的整数`);
    if (centerMaxLevel > 0 && t.mainBaseLevel > centerMaxLevel) errors.push(`research.csv[${t.code}] mainBaseLevel=${t.mainBaseLevel} 超过主基地最高等级 ${centerMaxLevel}`);
    if (t.durationSec < 1) errors.push(`research.csv[${t.code}] durationSec=${t.durationSec} 必须>0`);
    if (t.rpCost < 1) errors.push(`research.csv[${t.code}] rpCost=${t.rpCost} 必须>0`);
    for (const req of t.requires) {
      const orParts = req.split(' OR ');
      let anyValid = false;
      for (const part of orParts) {
        if (researchCodes.has(part.trim())) { anyValid = true; break; }
      }
      if (!anyValid) errors.push(`research.csv[${t.code}] requires 引用不存在的科技: ${req}`);
    }
  }
  // 科技依赖无环检测
  const researchCycle = findResearchCycle(config.research);
  if (researchCycle) errors.push(`research.csv 存在依赖环: ${researchCycle.join(' → ')}`);

  // academy 参数校验
  for (const a of Object.values(config.academy)) {
    if (a.checkIntervalSec < 1) errors.push(`academy.csv[Lv${a.level}] checkIntervalSec=${a.checkIntervalSec} 必须>0`);
    if (a.baseProbability < 0 || a.baseProbability > 1) errors.push(`academy.csv[Lv${a.level}] baseProbability 必须在[0,1]`);
    if (a.maxProbability < a.baseProbability) errors.push(`academy.csv[Lv${a.level}] maxProbability 必须≥baseProbability`);
  }

  // 科技效果类型白名单校验：新增 effectType 必须先在源码中接线，否则启动报错
  const KNOWN_TECH_EFFECT_TYPES = new Set([
    'resource_rate', 'unit_unlock', 'building_unlock', 'combat_atk', 'combat_def',
    'pop_growth', 'storage_cap', 'train_speed', 'build_speed', 'march_speed',
    'carry_cap', 'mechanism',
  ]);
  for (const t of Object.values(config.research)) {
    for (const e of t.effects) if (!KNOWN_TECH_EFFECT_TYPES.has(e.effectType)) {
      errors.push(`research_effects.csv[${t.code}] effectType=${e.effectType} 不在白名单中——请先在 research.ts 接线`);
    }
  }

  // 任务系统校验
  const QUEST_OBJECTIVE_KINDS = new Set(['submit_resources', 'repair_buildings', 'build_buildings', 'population_reached', 'resource_owned', 'explore_tiles', 'main_base_level', 'clear_camp', 'sell_discard_treasure', 'carry_flag', 'deliver_to_npc', 'research_completed', 'raid_task_village', 'defend_task_village', 'investigate_task_village', 'reputation_at_most', 'kill_units', 'dice_match']);
  const TREASURE_RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
  const questCodes = new Set(Object.keys(config.quests));
  for (const q of Object.values(config.quests)) {
    if (!q.code) errors.push('quests.csv 存在空 code');
    if (q.type !== 'main' && q.type !== 'daily' && q.type !== 'side') errors.push(`quests.csv[${q.code}] type 必须是 main/daily/side`);
    if (q.scope !== 'global' && q.scope !== 'village') errors.push(`quests.csv[${q.code}] scope 必须是 global/village`);
    if (q.type === 'main' && q.scope !== 'global') errors.push(`quests.csv[${q.code}] 主线任务必须是 global`);
    if (q.type === 'daily' && q.scope !== 'village') errors.push(`quests.csv[${q.code}] 日常任务必须是 village`);
    for (const [resource, amount] of Object.entries(q.acceptCost ?? {})) {
      if (!resourceKeys.has(resource)) errors.push(`quests.csv[${q.code}] 接取费用资源 ${resource} 不在 resources.csv`);
      if (!Number.isFinite(amount) || amount < 0) errors.push(`quests.csv[${q.code}] 接取费用 ${resource} 必须≥0`);
    }
    if (!QUEST_OBJECTIVE_KINDS.has(q.objective.kind)) {
      errors.push(`quests.csv[${q.code}] 未知目标类型 ${q.objective.kind}`);
    } else if (q.objective.kind === 'submit_resources') {
      if (!q.objective.resources || Object.keys(q.objective.resources).length === 0) {
        errors.push(`quests.csv[${q.code}] submit_resources 必须指定资源(objParam)`);
      }
    } else if (q.objective.kind === 'repair_buildings') {
      const kinds = q.objective.buildingKinds ?? [];
      if (!kinds.length) errors.push(`quests.csv[${q.code}] repair_buildings 必须指定建筑列表(objParam)`);
      for (const kind of kinds) if (!config.buildings[kind]) errors.push(`quests.csv[${q.code}] repair_buildings 建筑 ${kind} 不在 buildings.csv`);
    } else if (q.objective.kind === 'build_buildings') {
      if (q.objective.buildingZone !== 'inner' && q.objective.buildingZone !== 'outer') errors.push(`quests.csv[${q.code}] build_buildings 区域必须是 inner/outer`);
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] build_buildings 数量必须≥1`);
    } else if (q.objective.kind === 'population_reached' || q.objective.kind === 'explore_tiles' || q.objective.kind === 'main_base_level') {
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] ${q.objective.kind} 数量必须≥1`);
    } else if (q.objective.kind === 'resource_owned') {
      if (!q.objective.resourceKey || !resourceKeys.has(q.objective.resourceKey)) errors.push(`quests.csv[${q.code}] resource_owned 资源 ${q.objective.resourceKey} 不在 resources.csv`);
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] resource_owned 数量必须≥1`);
    } else if (q.objective.kind === 'clear_camp') {
      const tmpl = q.objective.campTemplate;
      if (!tmpl || !config.pveTemplates[tmpl]) errors.push(`quests.csv[${q.code}] clear_camp 模板 ${tmpl} 不在 pve_targets.csv`);
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] clear_camp 数量必须≥1`);
    } else if (q.objective.kind === 'sell_discard_treasure') {
      if (!q.objective.minRarity || !TREASURE_RARITY_ORDER.includes(q.objective.minRarity)) {
        errors.push(`quests.csv[${q.code}] sell_discard_treasure 的 minRarity 必须是 common/rare/epic/legendary`);
      }
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] sell_discard_treasure 数量必须≥1`);
    } else if (q.objective.kind === 'carry_flag') {
      if (!q.objective.flagCode || !config.treasures[q.objective.flagCode]) errors.push(`quests.csv[${q.code}] carry_flag 指定的军旗不在 treasures.csv`);
      if (!q.objective.minTroops || q.objective.minTroops < 1) errors.push(`quests.csv[${q.code}] carry_flag 兵力必须≥1`);
    } else if (q.objective.kind === 'deliver_to_npc') {
      if (!q.objective.deliverResource || !resourceKeys.has(q.objective.deliverResource)) errors.push(`quests.csv[${q.code}] deliver_to_npc 资源 ${q.objective.deliverResource} 不在 resources.csv`);
      if (!q.objective.deliverAmount || q.objective.deliverAmount < 1) errors.push(`quests.csv[${q.code}] deliver_to_npc 数量必须≥1`);
    } else if (q.objective.kind === 'research_completed') {
      if (q.objective.researchCode && !config.research[q.objective.researchCode]) errors.push(`quests.csv[${q.code}] research_completed 科技 ${q.objective.researchCode} 不在 research.csv`);
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] research_completed 数量必须≥1`);
    } else if (q.objective.kind === 'kill_units') {
      if (!q.objective.unitCategory) errors.push(`quests.csv[${q.code}] kill_units 必须指定兵种类别`);
      if (!q.objective.count || q.objective.count < 1) errors.push(`quests.csv[${q.code}] kill_units 数量必须≥1`);
    } else if (q.objective.kind === 'raid_task_village') {
      if (!q.objective.taskVillageCode) errors.push(`quests.csv[${q.code}] raid_task_village 必须指定任务村代码`);
    } else if (q.objective.kind === 'defend_task_village') {
      if (!q.objective.taskVillageCode) errors.push(`quests.csv[${q.code}] defend_task_village 必须指定任务村代码`);
    } else if (q.objective.kind === 'investigate_task_village') {
      if (!q.objective.taskVillageCode) errors.push(`quests.csv[${q.code}] investigate_task_village 必须指定任务村代码`);
    } else if (q.objective.kind === 'reputation_at_most') {
      if (!Number.isFinite(q.objective.threshold)) errors.push(`quests.csv[${q.code}] reputation_at_most 必须指定数值阈值`);
    } else if (q.objective.kind === 'dice_match') {
      if (!q.objective.diceTargetScore || q.objective.diceTargetScore < 1) errors.push(`quests.csv[${q.code}] dice_match 目标分数必须≥1`);
      if (!q.objective.diceWinsRequired || q.objective.diceWinsRequired < 1) errors.push(`quests.csv[${q.code}] dice_match 胜场数必须≥1`);
      if (!q.objective.diceDifficulty || !['easy', 'normal', 'hard'].includes(q.objective.diceDifficulty)) errors.push(`quests.csv[${q.code}] dice_match 难度无效`);
    }
    // 触发条件校验：随机支线和主线门槛可带 trigger；格式 = kind:arg
    if (q.trigger) {
      if (q.type !== 'side' && !(q.type === 'main' && (q.trigger.startsWith('main_base_level:') || q.trigger.startsWith('building_level:') || q.trigger.startsWith('treasure_used:')))) errors.push(`quests.csv[${q.code}] 仅支线或主基地/建筑/宝物使用门槛主线可设触发条件 trigger`);
      const [tk] = q.trigger.split(':');
      if (tk !== 'building_built' && tk !== 'troops_reached' && tk !== 'pve_camp_cleared' && tk !== 'secret_note_used' && tk !== 'tavern_refresh' && tk !== 'main_base_level' && tk !== 'building_level' && tk !== 'treasure_used') errors.push(`quests.csv[${q.code}] 未知触发条件 ${q.trigger}`);
    }
    if (q.rewards.treasures) {
      for (const t of q.rewards.treasures) if (!config.treasures[t]) errors.push(`quests.csv[${q.code}] 奖励宝物 ${t} 不在 treasures.csv`);
    }
   if (q.rewards.resources) {
     for (const k of Object.keys(q.rewards.resources)) if (!resourceKeys.has(k)) errors.push(`quests.csv[${q.code}] 奖励资源 ${k} 不在 resources.csv`);
   }
    for (const rewards of [q.conditionalRewards?.m8_success, q.conditionalRewards?.m8_failure]) {
      for (const t of rewards?.treasures ?? []) if (!config.treasures[t]) errors.push(`quests.csv[${q.code}] 条件奖励宝物 ${t} 不在 treasures.csv`);
    }
   for (const req of q.requires) if (!questCodes.has(req)) errors.push(`quests.csv[${q.code}] requires 引用不存在的任务: ${req}`);
  }
  const questCycle = findQuestCycle(config.quests);
  if (questCycle) errors.push(`quests.csv 主线前置存在循环依赖: ${questCycle.join(' → ')}`);

  // 声明式任务图校验：每个部件独立可审查，但所有引用必须闭合。
  for (const line of Object.values(config.questGraph.lines)) {
    if (!config.questGraph.quests[line.entryQuest]) errors.push(`quest_lines.csv[${line.code}] 入口任务不存在：${line.entryQuest}`);
  }
  for (const q of Object.values(config.questGraph.quests)) {
    if (!config.questGraph.lines[q.lineCode]) errors.push(`quests.csv[${q.code}] 任务线不存在：${q.lineCode}`);
  }
  const graphQuestCodes = new Set(Object.keys(config.questGraph.quests));
  for (const row of config.questGraph.conditions) {
    if (!graphQuestCodes.has(row.questCode)) errors.push(`quest_conditions.csv[${row.id}] 任务不存在：${row.questCode}`);
    if (!row.kind) errors.push(`quest_conditions.csv[${row.id}] 缺少 kind`);
    if (!['offer', 'accept', 'success', 'failure'].includes(row.phase)) errors.push(`quest_conditions.csv[${row.id}] phase 无效：${row.phase}`);
    if (row.phase === 'success' && row.kind === 'no_damaged_resource_level' && !row.value) {
      errors.push(`quest_conditions.csv[${row.id}] no_damaged_resource_level 必须指定资源田代码列表`);
    }
  }
  for (const row of config.questGraph.objectives) {
    if (!graphQuestCodes.has(row.questCode)) errors.push(`quest_objectives.csv[${row.id}] 任务不存在：${row.questCode}`);
    if (!QUEST_OBJECTIVE_KINDS.has(row.kind)) errors.push(`quest_objectives.csv[${row.id}] 未知目标类型：${row.kind}`);
  }
  for (const row of config.questGraph.effects) {
    if (!graphQuestCodes.has(row.questCode)) errors.push(`quest_effects.csv[${row.id}] 任务不存在：${row.questCode}`);
    if (!row.kind) errors.push(`quest_effects.csv[${row.id}] 缺少 kind`);
    if (row.kind === 'grant_population' && num(row.params, 0) <= 0) {
      errors.push(`quest_effects.csv[${row.id}] grant_population 参数必须是正数`);
    }
    if (row.kind === 'grant_population_growth' && !parsePopulationGrowthReward(row.params)) {
      errors.push(`quest_effects.csv[${row.id}] grant_population_growth 参数必须是 percent:durationSec（如 10:86400）`);
    }
    if (row.kind === 'grant_resource_growth' && !parseResourceGrowthReward(row.params)) {
      errors.push(`quest_effects.csv[${row.id}] grant_resource_growth 参数必须是 percent:durationSec（如 25:43200）`);
    }
    if (row.kind === 'grant_mercenaries_by_positive_reputation') {
      const [unitCode, rawPerPoint] = row.params.split(':').map((value) => value.trim());
      const perPoint = num(rawPerPoint, 0);
      const unit = config.units[unitCode];
      if (!unit || !unit.isMercenary) errors.push(`quest_effects.csv[${row.id}] 兑换兵种 ${unitCode} 必须是 merc 雇佣兵`);
      if (!Number.isFinite(perPoint) || perPoint <= 0) errors.push(`quest_effects.csv[${row.id}] grant_mercenaries_by_positive_reputation 的每点数量必须>0`);
    }
    if (row.kind === 'unlock_buildings') {
      for (const kind of row.params.split('|').map((value) => value.trim()).filter(Boolean)) {
        if (!config.buildings[kind]) errors.push(`quest_effects.csv[${row.id}] 解锁建筑 ${kind} 不在 buildings.csv`);
      }
    }
  }
  for (const row of config.questGraph.edges) {
    if (!graphQuestCodes.has(row.fromQuest)) errors.push(`quest_edges.csv[${row.id}] 起点任务不存在：${row.fromQuest}`);
    if (!graphQuestCodes.has(row.toQuest)) errors.push(`quest_edges.csv[${row.id}] 终点任务不存在：${row.toQuest}`);
  }

  // 对话目录校验：对话必须绑定现有任务，回复键不可重复。
  // GM 可先建立空白模板（npcName/npcText/replies 均为空），填完后热重载即可生效；
  // 空白的支线接取模板不会阻塞直接接取，主线模板会保留为待弹对话。
  const dialogueCodes = new Set<string>();
  const dialogueTriggers = new Set<string>();
  const dialogueGroups = new Map<string, DialogueDef[]>();
  for (const d of Object.values(config.dialogues ?? {})) {
    dialogueCodes.add(d.code);
    if (!Number.isInteger(d.id) || d.id < 1) errors.push(`dialogues.csv[${d.code}] id 必须为正整数`);
    if (!Number.isInteger(d.segment) || d.segment < 1) errors.push(`dialogues.csv[${d.code}] segment 必须为正整数`);
    // 宝物使用对话沿用 t1…tN 的排序 taskCode，但并不绑定任务。
    if (!questCodes.has(d.taskCode) && !(d.trigger === 'use' && /^t\d+$/.test(d.taskCode) && /_use$/.test(d.code))) errors.push(`dialogues.csv[${d.code}] taskCode=${d.taskCode} 不在 quests.csv`);
    if (!d.trigger) errors.push(`dialogues.csv[${d.code}] trigger 不能为空`);
    dialogueTriggers.add(`${d.taskCode}:${d.trigger}`);
    const group = dialogueGroups.get(d.code) ?? [];
    group.push(d);
    dialogueGroups.set(d.code, group);
    const replyKeys = new Set<string>();
    for (const reply of d.replies) {
      if (replyKeys.has(reply.key)) errors.push(`dialogues.csv[${d.code}] 回复键重复：${reply.key}`);
      replyKeys.add(reply.key);
    }
  }
  for (const [code, group] of dialogueGroups) {
    group.sort((a, b) => a.segment - b.segment);
    const first = group[0];
    for (let i = 0; i < group.length; i++) {
      const d = group[i];
      if (d.id !== first.id || d.taskCode !== first.taskCode || d.trigger !== first.trigger) {
        errors.push(`dialogues.csv[${code}] 同一对话对象的 id/taskCode/trigger 必须一致`);
      }
      if (d.segment !== i + 1) errors.push(`dialogues.csv[${code}] 段落必须从 1 连续编号`);
    }
  }
  // 每个主线和支线都必须预置可由 GM 填写的接取/交付模板；空白文本是合法的，
  // 但缺行会让任务无法在两处挂接对话，因此在配置阶段直接阻止发布。
  for (const q of Object.values(config.quests)) {
    if (q.type !== 'main' && q.type !== 'side') continue;
    const kind = q.type === 'main' ? '主线' : '支线';
    for (const trigger of ['accept', 'deliver']) {
      if (!dialogueTriggers.has(`${q.code}:${trigger}`)) {
        errors.push(`${kind}任务 ${q.code} 缺少 dialogues.csv ${trigger} 对话模板`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`配置校验失败（共${errors.length}项）：\n  - ${errors.join('\n  - ')}`);
  }
}

/** DFS 检测建筑 requires 图中的环；返回环路径（含重复首节点）或 null。 */
function findRequiresCycle(buildings: Record<string, BuildingDef>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (node: string): void => {
    if (found) return;
    color[node] = GRAY;
    stack.push(node);
    for (const r of buildings[node]?.requires ?? []) {
      if (!buildings[r.kind]) continue; // 不存在的引用已在别处报错
      if (color[r.kind] === GRAY) {
        const i = stack.indexOf(r.kind);
        found = stack.slice(i).concat(r.kind);
        return;
      }
      if ((color[r.kind] ?? WHITE) === WHITE) visit(r.kind);
      if (found) return;
    }
    stack.pop();
    color[node] = BLACK;
  };

  for (const node of Object.keys(buildings)) {
    if ((color[node] ?? WHITE) === WHITE) visit(node);
    if (found) return found;
  }
  return null;
}

/** DFS 检测任务前置环（主线 requires 为普通依赖，成环即报错）。 */
function findQuestCycle(quests: Record<string, QuestDef>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (node: string): void => {
    if (found) return;
    if (!quests[node]) return;
    color[node] = GRAY;
    stack.push(node);
    for (const req of quests[node].requires) {
      if (!quests[req]) continue;
      if (color[req] === GRAY) {
        const i = stack.indexOf(req);
        found = stack.slice(i).concat(req);
        return;
      }
      if ((color[req] ?? WHITE) === WHITE) visit(req);
      if (found) return;
    }
    stack.pop();
    color[node] = BLACK;
  };
  for (const node of Object.keys(quests)) {
    if ((color[node] ?? WHITE) === WHITE) visit(node);
    if (found) return found;
  }
  return null;
}

/** DFS 检测科研依赖环。科技 requires 支持 OR 语法（OR 分隔），任一条路径成环即报错。 */
function findResearchCycle(research: Record<string, ResearchDef>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (node: string): void => {
    if (found) return;
    if (!research[node]) return;
    color[node] = GRAY;
    stack.push(node);
    for (const req of research[node].requires) {
      // requires 中可能包含 OR，拆开检查每个备选
      const orParts = req.split(' OR ');
      for (const part of orParts) {
        const dep = part.trim();
        if (!research[dep]) continue;
        if (color[dep] === GRAY) {
          const i = stack.indexOf(dep);
          found = stack.slice(i).concat(dep);
          return;
        }
        if ((color[dep] ?? WHITE) === WHITE) visit(dep);
        if (found) return;
      }
    }
    stack.pop();
    color[node] = BLACK;
  };

  for (const node of Object.keys(research)) {
    if ((color[node] ?? WHITE) === WHITE) visit(node);
    if (found) return found;
  }
  return null;
}
