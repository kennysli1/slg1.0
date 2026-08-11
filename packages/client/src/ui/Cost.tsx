/**
 * 消耗预览：资源图标 + 数量，不足的标红。
 * 数量与资源条同源（liveResources 本地外插），避免"资源条够、按钮说不够"的错觉。
 */
import { tick } from '../app/store.js';
import { liveResources } from '../app/state.js';
import { resInfo } from '../app/config.js';
import { fmt, fmtDur } from '../shared/utils/format.js';
import { Icon } from './Icon.js';

export type CostMap = Record<string, number> | null | undefined;

/** 是否买得起（与消耗预览同源）。 */
export function canAfford(cost: CostMap): boolean {
  if (!cost) return false;
  const have = liveResources();
  return Object.entries(cost).every(([k, v]) => !v || (have[k] ?? 0) >= v);
}

export function CostRow({ cost, timeSec, popCost, class: cls = '' }: {
  cost: CostMap;
  /** 耗时（秒），有值则追加沙漏芯片 */
  timeSec?: number | null;
  /** 占用人口，有值则追加人口芯片 */
  popCost?: number | null;
  class?: string;
}) {
  tick.value; // 资源每秒增长 → 缺口标红要跟着变
  if (!cost) return null;
  const have = liveResources();
  const items = Object.entries(cost).filter(([, v]) => v > 0);
  return (
    <div class={`cost ${cls}`}>
      {items.map(([k, v]) => {
        const info = resInfo(k);
        const lack = (have[k] ?? 0) < v;
        return (
          <span
            key={k}
            class={`chip${lack ? ' chip--lack' : ''}`}
            title={`${info.name} ${fmt(v)}${lack ? `（还差 ${fmt(v - (have[k] ?? 0))}）` : ''}`}
          >
            <Icon icon={info.icon} label={info.name} size="xs" />
            {fmt(v)}
          </span>
        );
      })}
      {popCost != null && popCost > 0 && (
        <span class="chip" title={`占用人口 ${popCost}`}>
          <Icon icon="ui_icon_pop" label="人口" size="xs" />{popCost}
        </span>
      )}
      {timeSec != null && timeSec > 0 && (
        <span class="chip" title={`耗时 ${fmtDur(timeSec * 1000)}`}>
          <Icon icon="ui_icon_time" label="耗时" size="xs" />{fmtDur(timeSec * 1000)}
        </span>
      )}
    </div>
  );
}

/** 一枚资源芯片（战利品/收益展示用）。 */
export function ResChip({ res, amount, sign }: { res: string; amount: number; sign?: boolean }) {
  const info = resInfo(res);
  return (
    <span class="chip" title={info.name}>
      <Icon icon={info.icon} label={info.name} size="xs" />
      {sign && amount > 0 ? '+' : ''}{fmt(amount)}
    </span>
  );
}
