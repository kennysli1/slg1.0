/**
 * 前端展示用的名称/图标表（与服务器 defs 对应）。
 * icon 现为美术占位图路径（packages/client/public/art/ 下，见 docs/美术资源清单.md）。
 * 美术出图后按同名文件覆盖即可，无需改动此处。渲染统一走 main.ts 的 art() 助手。
 */

export const RES_INFO: Record<string, { name: string; icon: string }> = {
  wood: { name: '木材', icon: '/art/res_wood.png' },
  clay: { name: '泥土', icon: '/art/res_clay.png' },
  iron: { name: '铁矿', icon: '/art/res_iron.png' },
  crop: { name: '粮食', icon: '/art/res_crop.png' },
};

export const FIELD_INFO: Record<string, { name: string; icon: string }> = {
  woodcutter: { name: '伐木场', icon: '/art/field_woodcutter.png' },
  claypit: { name: '采泥场', icon: '/art/field_claypit.png' },
  ironmine: { name: '铁矿场', icon: '/art/field_ironmine.png' },
  cropland: { name: '农田', icon: '/art/field_cropland.png' },
};

export const BUILDING_INFO: Record<string, { name: string; icon: string }> = {
  main: { name: '主基地', icon: '/art/bld_main.png' },
  warehouse: { name: '仓库', icon: '/art/bld_warehouse.png' },
  granary: { name: '粮仓', icon: '/art/bld_granary.png' },
  barracks: { name: '兵营', icon: '/art/bld_barracks.png' },
  stable: { name: '马厩', icon: '/art/bld_stable.png' },
  workshop: { name: '兵工厂', icon: '/art/bld_workshop.png' },
  academy: { name: '学院', icon: '/art/bld_academy.png' },
  smithy: { name: '铁匠铺', icon: '/art/bld_smithy.png' },
  wall: { name: '城墙', icon: '/art/bld_wall.png' },
  rallypoint: { name: '集结点', icon: '/art/bld_rallypoint.png' },
};

export const UNIT_INFO: Record<string, { name: string; icon: string; cat: string }> = {
  legionnaire: { name: '军团兵', icon: '/art/unit_legionnaire.png', cat: '步兵' },
  praetorian: { name: '禁卫兵', icon: '/art/unit_praetorian.png', cat: '步兵' },
  imperian: { name: '帝国兵', icon: '/art/unit_imperian.png', cat: '步兵' },
  equlegati: { name: '侦察骑兵', icon: '/art/unit_equlegati.png', cat: '侦察' },
  equimperatoris: { name: '近卫骑兵', icon: '/art/unit_equimperatoris.png', cat: '骑兵' },
  equcaesaris: { name: '凯撒骑兵', icon: '/art/unit_equcaesaris.png', cat: '骑兵' },
  ram: { name: '攻城锤', icon: '/art/unit_ram.png', cat: '攻城' },
  catapult: { name: '投石机', icon: '/art/unit_catapult.png', cat: '攻城' },
  senator: { name: '元老', icon: '/art/unit_senator.png', cat: '行政' },
  settler: { name: '拓荒者', icon: '/art/unit_settler.png', cat: '拓荒' },
};

export const PVE_INFO: Record<string, { icon: string }> = {
  rats: { icon: '/art/pve_rats.png' },
  wolves: { icon: '/art/pve_wolves.png' },
  bandits: { icon: '/art/pve_bandits.png' },
};
