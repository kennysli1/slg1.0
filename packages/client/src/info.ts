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
};

export const FIELD_INFO: Record<string, { name: string; icon: string }> = {
  woodcutter: { name: '伐木场', icon: 'field_woodcutter' },
  claypit: { name: '采泥场', icon: 'field_claypit' },
  ironmine: { name: '铁矿场', icon: 'field_ironmine' },
  cropland: { name: '农田', icon: 'field_cropland' },
};

export const BUILDING_INFO: Record<string, { name: string; icon: string }> = {
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
};

export const UNIT_INFO: Record<string, { name: string; icon: string; cat: string }> = {
  legionnaire: { name: '军团兵', icon: 'unit_legionnaire', cat: '步兵' },
  praetorian: { name: '禁卫兵', icon: 'unit_praetorian', cat: '步兵' },
  imperian: { name: '帝国兵', icon: 'unit_imperian', cat: '步兵' },
  equlegati: { name: '侦察骑兵', icon: 'unit_equlegati', cat: '侦察' },
  equimperatoris: { name: '近卫骑兵', icon: 'unit_equimperatoris', cat: '骑兵' },
  equcaesaris: { name: '凯撒骑兵', icon: 'unit_equcaesaris', cat: '骑兵' },
  ram: { name: '攻城锤', icon: 'unit_ram', cat: '攻城' },
  catapult: { name: '投石机', icon: 'unit_catapult', cat: '攻城' },
  senator: { name: '元老', icon: 'unit_senator', cat: '行政' },
  settler: { name: '拓荒者', icon: 'unit_settler', cat: '拓荒' },
};

export const PVE_INFO: Record<string, { icon: string }> = {
  rats: { icon: 'pve_rats' },
  wolves: { icon: 'pve_wolves' },
  bandits: { icon: 'pve_bandits' },
};
