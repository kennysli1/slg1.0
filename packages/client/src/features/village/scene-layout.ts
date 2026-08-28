/**
 * 村庄底图的槽位坐标模型。
 *
 * 底图 `scene_village_ground.webp` 是一张 3/4 俯视的空村庄：中央一圈石板广场，
 * 外面围着木栅栏，广场与栅栏之间是一整圈**裸土垫台**，建筑就摆在垫台上。
 * 垫台在图上呈椭圆环分布，所以坐标不手写表，而是按椭圆参数算：
 *
 *   x = CX + RX · rf · sin(θ)
 *   y = CY − RY · rf · cos(θ)
 *
 * 槽位数是会长的（主基地满级时城内 16 + 城外 18 = 34 个），一圈摆不下，
 * 所以每个区按需要分成若干**同心环**：环数 = ceil(槽位数 / 每环上限)，
 * 每环内把 360° 均分 —— 这样 4 个槽也能均匀铺开，34 个槽也塞得下，
 * 且相邻环错开半格，不会连成一条放射直线。
 *
 * CX/CY/RX/RY 与两个区的半径区间是用 `python tools/scene_pads.py` 量底图、
 * 再逐点采样「是否落在裸土上」校对出来的。**换底图必须重校这几个数。**
 */

/** 广场中心（归一化 0~1）。城镇中心摆这里。 */
export const CX = 0.50;
export const CY = 0.49;
/** 垫台环的椭圆半轴。俯视透视把纵轴压扁了，所以 RY < RX。 */
export const RX = 0.37;
export const RY = 0.25;

/** 每个区的半径系数区间（从最外圈往里排）。 */
const ZONE_RINGS = {
  // 城外（生产）：贴着栅栏往里三圈，够放满级的 18 个
  outer: { from: 0.92, step: 0.12 },
  // 城内（民生）：紧挨广场两圈，够放满级的 16 个
  inner: { from: 0.56, step: 0.14 },
} as const;

/**
 * 每环有 8 个可用角位（45° 一格，偏移半格 22.5°）。
 * 底图的裸土垫台正好是 8 块扇形（正北与正南被村口大路占掉），
 * 角位写死成这 8 个，建筑才会**正落在扇形垫台中央**。
 *
 * 槽位少于 8 个时不能只用前 n 个角位（那会全挤在右半边），
 * 而是把要用的角位在这 8 格里**均匀挑选**：第 k 个槽用第 round(k·8/n) 格。
 * 这样既对齐底图扇形，又绕村庄铺得均匀。
 */
const PER_RING = 8;
const ANGLE_STEP = 360 / PER_RING;
const ANGLE_OFFSET = ANGLE_STEP / 2;

export interface PadPos {
  /** 左定位百分比 0~100 */
  x: number;
  /** 顶定位百分比 0~100 */
  y: number;
  /** 远近缩放：越靠下（越近）越大 */
  scale: number;
  /** 层叠顺序：越靠下越在前，形成前后遮挡 */
  z: number;
}

/** 远近缩放：靠上的垫台更远，画小一点才不假。 */
function depthScale(yPct: number): number {
  return Math.round((0.72 + 0.46 * (yPct / 100)) * 100) / 100;
}

/**
 * 算出某个槽位在底图上的位置。
 * @param zone  inner=城内环组，outer=城外环组
 * @param index 该区里的第几个槽（0 起，服务端顺序）
 * @param total 该区槽位总数（用来把角位均匀摊开）
 */
export function padPos(zone: 'inner' | 'outer', index: number, total: number): PadPos {
  const cfg = ZONE_RINGS[zone];
  const n = Math.max(1, total);
  const ring = Math.floor(index / PER_RING);
  const slotInRing = index % PER_RING;
  // 本环实际有几个槽（最后一环可能不满）
  const inThisRing = Math.max(1, Math.min(PER_RING, n - ring * PER_RING));

  // 在 8 个角位里均匀挑 inThisRing 个；相邻环再错开半格，避免连成放射直线
  const angleIdx = Math.round((slotInRing * PER_RING) / inThisRing) % PER_RING;
  const deg = ANGLE_OFFSET + ANGLE_STEP * angleIdx + (ring % 2 ? ANGLE_STEP / 2 : 0);
  const t = (deg * Math.PI) / 180;
  const rf = cfg.from - cfg.step * ring;

  const x = (CX + RX * rf * Math.sin(t)) * 100;
  const y = (CY - RY * rf * Math.cos(t)) * 100;
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    scale: depthScale(y),
    z: Math.round(y * 10),
  };
}

/** 城镇中心：广场正中，略放大当视觉焦点。 */
export const TOWN_CENTER_POS: PadPos = {
  x: CX * 100,
  y: CY * 100,
  scale: 1.15,
  z: Math.round(CY * 100 * 10) + 5,
};
