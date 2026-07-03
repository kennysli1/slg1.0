/**
 * 基础设施 · 战斗数据类型（共享口径）
 * 对应设计文档 docs/2_2.0设计/08_战斗系统重做设计.md 第三/四节
 *
 * 为什么放 infra 而不是 combat 模块：
 * combat 已升级为"有状态模块"（owns battle 集合），按铁律#2 模块之间不能互相 import。
 * 但 military/pve 需要造"参战快照"、movement 需要传兵力给 combat，三方都要认识同一套
 * 兵种战斗字段。把纯类型下沉到 infra（各模块合法 import 基础设施），避免跨模块 import。
 *
 * 这里只有**类型 + 纯常量**，没有状态、没有逻辑，符合基础设施层定位。
 */

/** 兵种形态：近战(前排) / 远程(后排)。取代旧的 cat 概念。 */
export type UnitForm = 'melee' | 'ranged';

/** 特性效果类型（unit_traits.csv 的 effect 列枚举）。加新特性先在此登记。 */
export type TraitEffect =
  | 'dmg_taken_ranged' // 受远程伤害倍率修正（如 -0.30 = 受远程伤害 -30%，持盾）
  | 'dmg_taken_melee' //  受近战伤害倍率修正
  | 'atk_ranged' //        自身远程攻击力加成倍率
  | 'atk_melee' //         自身近战攻击力加成倍率
  | 'def_ranged' //        自身远程防御加成倍率
  | 'def_melee'; //        自身近战防御加成倍率

export const TRAIT_EFFECTS: readonly TraitEffect[] = [
  'dmg_taken_ranged',
  'dmg_taken_melee',
  'atk_ranged',
  'atk_melee',
  'def_ranged',
  'def_melee',
];

/** 特性定义（来自 unit_traits.csv，解析在 config.ts）。一条特性可携带多个 effect。 */
export interface UnitTraitDef {
  id: number;
  code: string; // 程序内部用
  name: string; // 显示名
  /** 该特性的所有效果，至少一个。CSV 的 effect1/value1…effect3/value3 列解析而来。 */
  effects: { effect: TraitEffect; value: number }[];
}

/**
 * 单兵种参战条目：战斗只认这套字段（近/远攻 + 近/远防 + 形态 + 特性 + 负重）。
 * military/pve 造快照时把"最终数值"填进来（铁匠加成等已在源头叠好，对外只给结果）。
 */
export interface CombatUnit {
  count: number;
  form: UnitForm;
  meleeAtk: number;
  rangedAtk: number;
  meleeDef: number;
  rangedDef: number;
  carry: number;
  /** 该兵种携带的特性效果（已从 traits id 解析成效果列表，combat 直接用）。 */
  traits?: { effect: TraitEffect; value: number }[];
}

/** 一方阵营的参战快照：兵种 code -> 条目。 */
export type Snapshot = Record<string, CombatUnit>;
