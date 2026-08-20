/**
 * marchProgress — 己方行军进度计算。
 * 与 HexMap 的 marchMarkerPixel 使用同一插值公式，确保列表进度条与地图标记保持同源。
 */
import type { Movement } from '@slg/shared';

export interface MarchProgress {
  /** 总体完成比例 [0, 1]（含当前步骤内插值）。 */
  ratio: number;
  /** 已完成步骤数（整数）。 */
  stepsDone: number;
  /** 总步骤数（path.length - 1）。 */
  stepsTotal: number;
  /** 预计剩余毫秒数。 */
  etaMs: number;
}

export function marchProgress(m: Movement, now: number): MarchProgress {
  const stepsTotal = Math.max(0, m.path.length - 1);
  const stepsDone  = Math.min(m.stepIndex, stepsTotal);

  let ratio = stepsTotal > 0 ? stepsDone / stepsTotal : 1;

  // 当前步骤内插值：让进度条在每格之间平滑推进
  if (m.status === 'marching' && stepsDone < stepsTotal && m.nextStepAt && m.perStepMs > 0) {
    const t = Math.max(0, Math.min(1, 1 - (m.nextStepAt - now) / m.perStepMs));
    ratio = (stepsDone + t) / stepsTotal;
  }

  const etaMs = Math.max(0, m.arriveAt - now);
  return { ratio: Math.max(0, Math.min(1, ratio)), stepsDone, stepsTotal, etaMs };
}
