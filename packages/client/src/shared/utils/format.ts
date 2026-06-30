/** 通用格式化助手（纯函数）。 */

export const fmt = (n: number) => Math.floor(n).toLocaleString();

/** 把"目标时刻(ms)"渲染成"剩 X分Y秒"。 */
export const secStr = (ms: number) => {
  const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
};
