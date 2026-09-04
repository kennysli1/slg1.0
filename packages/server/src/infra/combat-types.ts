/**
 * 线上战斗的唯一单位快照口径。
 *
 * 战斗只读取攻击、防御、生命三个基础数值。兵种角色与特性只决定其在已冻结的
 * 阶段化规则中的参战资格和临时修正，绝不引入第二套攻防/生命面板。
 */

/** 仅用于兵种目录与行军显示；不参与战斗公式。 */
export type UnitForm = 'melee' | 'ranged';
/** 角色决定阶段一的参战资格；所有角色都会进入阶段三。 */
export type CombatRole = 'infantry' | 'cavalry' | 'siege' | 'scout' | 'special';
export type CombatPhase = 'charge' | 'ranged' | 'melee' | 'all';

/** 历史目录特性类型，保留读取兼容；新战斗不消费这些效果。 */
export type TraitEffect =
  | 'self_attack' | 'self_defense'
  | 'enemy_cavalry_attack' | 'enemy_cavalry_defense'
  | 'enemy_ranged_attack' | 'enemy_ranged_defense'
  | 'enemy_infantry_defense' | 'enemy_lower_hp_defense'
  | 'ally_cavalry_defense'
  | 'origin_attacker_attack' | 'origin_defender_defense'
  | 'ramp_attack' | 'ramp_defense'
  /** 仅供旧配置/测试读取；v3 引擎不会消费。 */
  | 'dmg_taken_ranged' | 'dmg_taken_melee' | 'atk_ranged' | 'atk_melee' | 'def_ranged' | 'def_melee'
  | 'enemy_cavalry_atk' | 'ally_ranged_def' | 'enemy_ranged_melee_def' | 'cavalry_charge_atk';
export const TRAIT_EFFECTS: readonly TraitEffect[] = [
  'self_attack', 'self_defense',
  'enemy_cavalry_attack', 'enemy_cavalry_defense',
  'enemy_ranged_attack', 'enemy_ranged_defense',
  'enemy_infantry_defense', 'enemy_lower_hp_defense',
  'ally_cavalry_defense', 'origin_attacker_attack', 'origin_defender_defense',
  'ramp_attack', 'ramp_defense',
  'dmg_taken_ranged', 'dmg_taken_melee', 'atk_ranged', 'atk_melee', 'def_ranged', 'def_melee',
  'enemy_cavalry_atk', 'ally_ranged_def', 'enemy_ranged_melee_def', 'cavalry_charge_atk',
];
export interface UnitTraitDef {
  id: number;
  code: string;
  name: string;
  effects: { effect: TraitEffect; value: number; phase?: CombatPhase }[];
}

export interface CombatUnit {
  count: number;
  attack?: number;
  defense?: number;
  hp?: number;
  carry: number;
  popCost?: number;
  /** 远程 form 用于阶段一弓骑预射、阶段二远程打击。 */
  form?: 'melee' | 'ranged';
  /** 在快照创建时从配置冻结；进行中战斗不能被配置热更改。 */
  role?: CombatRole;
  /** 在快照创建时冻结的特性定义。 */
  traits?: UnitTraitDef[];
  meleeAtk?: number;
  rangedAtk?: number;
  meleeDef?: number;
  rangedDef?: number;
  isCavalry?: boolean;
  ambushPriority?: boolean;
}

/** 一方阵营的参战快照：兵种 code（或 contribution#code）→ 条目。 */
export type Snapshot = Record<string, CombatUnit>;
