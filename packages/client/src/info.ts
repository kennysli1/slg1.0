/**
 * 前端展示用的名称/图标表（与服务器 config 的 code 一一对应）。
 * icon 字段只存**基名**；渲染时统一用 main.ts 的 artPath() 拼成 `/art/<基名>.png`。
 * 美术出图后按同名文件覆盖 packages/client/public/art/ 即可，无需改动此处（见 docs/美术资源清单.md）。
 *
 * 说明：服务器在 GetVillage/GetArmy/GetArea 等响应里也会带 icon 基名+name，
 * 能用服务器数据处优先用服务器数据；本表作为名称回退与资源条（resources 不随每帧下发）使用。
 */

export const RES_INFO: Record<string, { name: string; icon: string }> = {
  wood: { name: '木材', icon: 'res_wood' },
  clay: { name: '泥土', icon: 'res_clay' },
  iron: { name: '铁矿', icon: 'res_iron' },
  crop: { name: '粮食', icon: 'res_crop' },
  gold: { name: '金币', icon: 'res_gold' },
};

export const FIELD_INFO: Record<string, { name: string; icon: string }> = {
  woodcutter: { name: '伐木场', icon: 'field_woodcutter' },
  claypit: { name: '采泥场', icon: 'field_claypit' },
  ironmine: { name: '铁矿场', icon: 'field_ironmine' },
  cropland: { name: '农田', icon: 'field_cropland' },
};

export const BUILDING_INFO: Record<string, { name: string; icon: string; zone?: string }> = {
  main: { name: '主基地', icon: 'bld_main' },
  warehouse: { name: '仓库', icon: 'bld_warehouse' },
  granary: { name: '粮仓', icon: 'bld_granary' },
  barracks: { name: '兵营', icon: 'bld_barracks' },
  stable: { name: '马厩', icon: 'bld_stable' },
  workshop: { name: '兵工厂', icon: 'bld_workshop' },
  academy: { name: '学院', icon: 'bld_academy' },
  smithy: { name: '铁匠铺', icon: 'bld_smithy' },
  wall: { name: '城墙', icon: 'bld_wall' },
  rallypoint: { name: '集结点', icon: 'bld_rallypoint' },
  mercenarycamp: { name: '雇佣兵营地', icon: 'bld_mercenarycamp', zone: 'outer' },
};

export const UNIT_INFO: Record<string, { name: string; icon: string; form: string }> = {
  legionnaire: { name: '军团兵', icon: 'unit_legionnaire', form: 'melee' },
  praetorian: { name: '禁卫兵', icon: 'unit_praetorian', form: 'melee' },
  imperian: { name: '帝国兵', icon: 'unit_imperian', form: 'melee' },
  equlegati: { name: '侦察骑兵', icon: 'unit_equlegati', form: 'melee' },
  equimperatoris: { name: '近卫骑兵', icon: 'unit_equimperatoris', form: 'melee' },
  equcaesaris: { name: '凯撒骑兵', icon: 'unit_equcaesaris', form: 'melee' },
  ram: { name: '攻城锤', icon: 'unit_ram', form: 'melee' },
  catapult: { name: '投石机', icon: 'unit_catapult', form: 'ranged' },
  senator: { name: '元老', icon: 'unit_senator', form: 'melee' },
  settler: { name: '拓荒者', icon: 'unit_settler', form: 'melee' },
  phalanx: { name: '方阵兵', icon: 'unit_phalanx', form: 'melee' },
  swordsman: { name: '剑士', icon: 'unit_swordsman', form: 'melee' },
  pathfinder: { name: '探路者', icon: 'unit_pathfinder', form: 'melee' },
  theutates: { name: '雷神骑兵', icon: 'unit_theutates', form: 'melee' },
  druidrider: { name: '德鲁伊骑兵', icon: 'unit_druidrider', form: 'melee' },
  haeduan: { name: '海杜安骑兵', icon: 'unit_haeduan', form: 'melee' },
  gaulram: { name: '攻城锤', icon: 'unit_gaulram', form: 'melee' },
  gcaultrebuchet: { name: '投石机', icon: 'unit_gcaultrebuchet', form: 'ranged' },
  gaulchief: { name: '首领', icon: 'unit_gaulchief', form: 'melee' },
  gaulsettler: { name: '拓荒者', icon: 'unit_gaulsettler', form: 'melee' },
  clubswinger: { name: '棍棒兵', icon: 'unit_clubswinger', form: 'melee' },
  spearman: { name: '长矛兵', icon: 'unit_spearman', form: 'melee' },
  axeman: { name: '斧兵', icon: 'unit_axeman', form: 'melee' },
  teuscout: { name: '侦察兵', icon: 'unit_teuscout', form: 'melee' },
  paladin: { name: '圣骑士', icon: 'unit_paladin', form: 'melee' },
  teutonknight: { name: '条顿骑士', icon: 'unit_teutonknight', form: 'melee' },
  teuram: { name: '攻城锤', icon: 'unit_teuram', form: 'melee' },
  teucatapult: { name: '投石机', icon: 'unit_teucatapult', form: 'ranged' },
  teuchief: { name: '首领', icon: 'unit_teuchief', form: 'melee' },
  teusettler: { name: '拓荒者', icon: 'unit_teusettler', form: 'melee' },
  // 雇佣兵（tribe=merc）：金币购买、永久持有、不耗粮不占人口
  merc_slinger: { name: '投石雇佣兵', icon: 'unit_merc_slinger', form: 'ranged' },
  merc_spearman: { name: '长矛雇佣兵', icon: 'unit_merc_spearman', form: 'melee' },
  merc_archer: { name: '弓箭雇佣兵', icon: 'unit_merc_archer', form: 'ranged' },
  merc_sword: { name: '剑士雇佣兵', icon: 'unit_merc_sword', form: 'melee' },
  merc_cavalry: { name: '雇佣骑兵', icon: 'unit_merc_cavalry', form: 'melee' },
  merc_axe: { name: '斧兵雇佣兵', icon: 'unit_merc_axe', form: 'melee' },
  merc_crossbow: { name: '弩手雇佣兵', icon: 'unit_merc_crossbow', form: 'ranged' },
  merc_knight: { name: '雇佣骑士', icon: 'unit_merc_knight', form: 'melee' },
  merc_berserker: { name: '狂战雇佣兵', icon: 'unit_merc_berserker', form: 'melee' },
  merc_champion: { name: '冠军雇佣兵', icon: 'unit_merc_champion', form: 'melee' },
};

export const PVE_INFO: Record<string, { icon: string }> = {
  rats: { icon: 'pve_rats' },
  wolves: { icon: 'pve_wolves' },
  bandits: { icon: 'pve_bandits' },
};
