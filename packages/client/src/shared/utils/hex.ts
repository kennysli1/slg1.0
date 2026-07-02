/**
 * 前端 · 六边形轴坐标 ↔ 像素（pointy-top 尖顶朝上）
 *
 * 与服务端 infra/hex.ts 同一套 axial(q,r) 坐标；这里只管**渲染定位**：
 * 把 (q,r) 映射到平面像素，供 SVG 画格子/村庄/行军路径与部队位置。
 * 采用 redblobgames 的 pointy-top 标准公式。
 */

export interface Hex { q: number; r: number; }

/** 六边形"大小"（中心到顶点，像素）。列渲染时统一用它算宽高。 */
export const HEX_SIZE = 30;

const SQRT3 = Math.sqrt(3);

/** axial → 像素中心点（未含画布偏移，调用方自行加 origin）。 */
export function hexToPixel(h: { q: number; r: number }, size = HEX_SIZE): { x: number; y: number } {
  const x = size * (SQRT3 * h.q + (SQRT3 / 2) * h.r);
  const y = size * ((3 / 2) * h.r);
  return { x, y };
}

/** 一个六边形（pointy-top）六个顶点相对中心的偏移，用于 SVG polygon。 */
export function hexCorners(size = HEX_SIZE): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top：从 -30° 起
    pts.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return pts;
}

/** 两点线性插值（部队在两格间平滑移动用）。 */
export function lerpPixel(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
