/**
 * 线上战斗的唯一单位快照口径。
 *
 * 战斗只读取攻击、防御、生命三个数值；count/carry/popCost 是编队、战利品和人口
 * 系统需要的非战斗元数据。不得在此处重新引入兵种形态、前后排、远近攻防或特性表。
 */

/** 仅用于兵种目录与行军显示；不参与战斗公式。 */
export type UnitForm = 'melee' | 'ranged';

/** 历史目录特性类型，保留读取兼容；新战斗不消费这些效果。 */
export type TraitEffect =
  | 'dmg_taken_ranged' | 'dmg_taken_melee' | 'atk_ranged' | 'atk_melee'
  | 'def_ranged' | 'def_melee' | 'enemy_cavalry_atk' | 'ally_ranged_def'
  | 'enemy_ranged_melee_def' | 'cavalry_charge_atk';
export const TRAIT_EFFECTS: readonly TraitEffect[] = [
  'dmg_taken_ranged', 'dmg_taken_melee', 'atk_ranged', 'atk_melee', 'def_ranged',
  'def_melee', 'enemy_cavalry_atk', 'ally_ranged_def', 'enemy_ranged_melee_def', 'cavalry_charge_atk',
];
export interface UnitTraitDef {
  id: number;
  code: string;
  name: string;
  effects: { effect: TraitEffect; value: number }[];
}

export interface CombatUnit {
  count: number;
  attack?: number;
  defense?: number;
  hp?: number;
  carry: number;
  popCost?: number;
  /** 仅用于读取上线前已落盘/在途快照；新快照不得写入。 */
  form?: 'melee' | 'ranged';
  meleeAtk?: number;
  rangedAtk?: number;
  meleeDef?: number;
  rangedDef?: number;
  traits?: unknown[];
  isCavalry?: boolean;
  ambushPriority?: boolean;
}

/** 一方阵营的参战快照：兵种 code（或 contribution#code）→ 条目。 */
export type Snapshot = Record<string, CombatUnit>;
