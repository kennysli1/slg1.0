/**
 * 基础设施 · 六边形轴坐标几何（axial coordinates）
 *
 * 全游戏地图几何的唯一来源：距离、逐格路径、邻居。world/movement/player 都走这里，
 * 不各自手写 Math.hypot。采用 axial (q,r) 表示，内部转 cube (x,y,z) 做距离/插值/取整。
 *
 * 参考 https://www.redblobgames.com/grids/hexagons/（pointy-top，axial↔cube 标准映射）。
 *
 * 约定：
 *  - axial (q,r)：地图上唯一坐标；cube 仅内部计算用（x+y+z=0 恒成立）。
 *  - 距离 = cube 曼哈顿距离 / 2 = 六边形环数。
 *  - 逐格路径 linePath：cube 线性插值 + cubeRound，得到从 from 到 to 的连续相邻格序列
 *    （含起点与终点）。Movement 逐格推进就沿它走。
 */

export interface Hex {
  q: number;
  r: number;
}

interface Cube {
  x: number;
  y: number;
  z: number;
}

/** store 集合主键用的坐标字符串。 */
export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

function axialToCube(h: Hex): Cube {
  const x = h.q;
  const z = h.r;
  const y = -x - z;
  return { x, y, z };
}

function cubeToAxial(c: Cube): Hex {
  return { q: c.x, r: c.z };
}

/** cube 取整：先四舍五入，再修正误差最大的那一维，保证 x+y+z=0。 */
function cubeRound(c: Cube): Cube {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);
  const dx = Math.abs(rx - c.x);
  const dy = Math.abs(ry - c.y);
  const dz = Math.abs(rz - c.z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: ry, z: rz };
}

/** 六边形距离（环数）：两点间最少跨越的格数。 */
export function hexDistance(a: Hex, b: Hex): number {
  const ac = axialToCube(a);
  const bc = axialToCube(b);
  return (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y) + Math.abs(ac.z - bc.z)) / 2;
}

/** 六个方向的邻居（axial 偏移）。 */
const DIRECTIONS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighbors(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

function cubeLerp(a: Cube, b: Cube, t: number): Cube {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * 逐格直线路径：从 from 到 to 的连续相邻格序列，含首尾。
 * from===to 时返回单格 [from]。相邻两格恒为六边形邻居（Movement 逐格推进依赖此性质）。
 */
export function linePath(from: Hex, to: Hex): Hex[] {
  const n = hexDistance(from, to);
  if (n === 0) return [{ q: from.q, r: from.r }];
  const ac = axialToCube(from);
  const bc = axialToCube(to);
  const path: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const c = cubeRound(cubeLerp(ac, bc, i / n));
    path.push(cubeToAxial(c));
  }
  return path;
}

/**
 * 环面（torus）坐标归一：把任意 axial 坐标折回 [0,W)×[0,H)。
 * 世界布局为环绕平行四边形（axial torus），此函数统一作主键/邻居/距离的入口。
 */
export function wrapHex(h: Hex, W: number, H: number): Hex {
  const wq = ((h.q % W) + W) % W;
  const wr = ((h.r % H) + H) % H;
  return { q: wq, r: wr };
}

/**
 * 环面最短距离：枚举 to 的 3×3 环绕副本（dq∈{-W,0,W}, dr∈{-H,0,H}），取最小六边形距离。
 * 再远一个周期不会更短，故 9 个组合已足够。
 */
export function hexDistanceWrapped(a: Hex, b: Hex, W: number, H: number): number {
  let best = hexDistance(a, b);
  for (let dq = -W; dq <= W; dq += W) {
    for (let dr = -H; dr <= H; dr += H) {
      if (dq === 0 && dr === 0) continue;
      const d = hexDistance(a, { q: b.q + dq, r: b.r + dr });
      if (d < best) best = d;
    }
  }
  return best;
}

/** 环面六个邻居（已归一进 [0,W)×[0,H)）。 */
export function neighborsWrapped(h: Hex, W: number, H: number): Hex[] {
  return DIRECTIONS.map((d) => wrapHex({ q: h.q + d.q, r: h.r + d.r }, W, H));
}

/**
 * 环面逐格路径：取离 from 最近的 to 副本跑直线插值，结果每个格归一进 [0,W)×[0,H)，
 * 因此路径可平滑跨过世界接缝（相邻两格恒为六边形邻居）。
 */
export function linePathWrapped(from: Hex, to: Hex, W: number, H: number): Hex[] {
  let bestTo = to;
  let bestD = hexDistance(from, to);
  for (let dq = -W; dq <= W; dq += W) {
    for (let dr = -H; dr <= H; dr += H) {
      if (dq === 0 && dr === 0) continue;
      const cand = { q: to.q + dq, r: to.r + dr };
      const d = hexDistance(from, cand);
      if (d < bestD) { bestD = d; bestTo = cand; }
    }
  }
  return linePath(from, bestTo).map((p) => wrapHex(p, W, H));
}
