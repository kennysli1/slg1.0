/** 前端展示用的名称/图标占位表（与服务器 defs 对应）。图标用 emoji 占位，后续统一替换为美术资源。 */

export const RES_INFO: Record<string, { name: string; icon: string }> = {
  wood: { name: '木材', icon: '🪵' },
  clay: { name: '泥土', icon: '🧱' },
  iron: { name: '铁矿', icon: '⛏️' },
  crop: { name: '粮食', icon: '🌾' },
};

export const FIELD_INFO: Record<string, { name: string; icon: string }> = {
  woodcutter: { name: '伐木场', icon: '🌲' },
  claypit: { name: '采泥场', icon: '🟤' },
  ironmine: { name: '铁矿', icon: '⛰️' },
  cropland: { name: '农田', icon: '🌾' },
};

export const BUILDING_INFO: Record<string, { name: string; icon: string }> = {
  main: { name: '主基地', icon: '🏛️' },
  warehouse: { name: '仓库', icon: '📦' },
  granary: { name: '粮仓', icon: '🏚️' },
  barracks: { name: '兵营', icon: '⚔️' },
  stable: { name: '马厩', icon: '🐎' },
  workshop: { name: '兵工厂', icon: '🛠️' },
  academy: { name: '学院', icon: '📚' },
  smithy: { name: '铁匠铺', icon: '🔨' },
  wall: { name: '城墙', icon: '🧱' },
  rallypoint: { name: '集结点', icon: '🚩' },
};

export const UNIT_INFO: Record<string, { name: string; icon: string; cat: string }> = {
  legionnaire: { name: '军团兵', icon: '🗡️', cat: '步兵' },
  praetorian: { name: '禁卫兵', icon: '🛡️', cat: '步兵' },
  imperian: { name: '帝国兵', icon: '⚔️', cat: '步兵' },
  equlegati: { name: '侦察骑兵', icon: '🐴', cat: '侦察' },
  equimperatoris: { name: '近卫骑兵', icon: '🐎', cat: '骑兵' },
  equcaesaris: { name: '凯撒骑兵', icon: '🏇', cat: '骑兵' },
  ram: { name: '攻城锤', icon: '🪵', cat: '攻城' },
  catapult: { name: '投石机', icon: '💥', cat: '攻城' },
  senator: { name: '元老', icon: '🎩', cat: '行政' },
  settler: { name: '拓荒者', icon: '🧳', cat: '拓荒' },
};

export const PVE_INFO: Record<string, { icon: string }> = {
  rats: { icon: '🐀' },
  wolves: { icon: '🐺' },
  bandits: { icon: '🏴‍☠️' },
};
