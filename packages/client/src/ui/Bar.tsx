/** 进度条与倒计时：所有「随时间推进」的显示都走这里，统一订阅 1 秒心跳。 */
import type { ComponentChildren } from 'preact';
import { tick } from '../app/store.js';
import { fmtDur } from '../shared/utils/format.js';

type BarKind = 'gold' | 'jade' | 'ember' | 'crimson' | 'steel';

export function Bar({ pct, kind = 'gold', thin, tall, busy, title }: {
  pct: number;
  kind?: BarKind;
  thin?: boolean;
  tall?: boolean;
  /** 建造/训练中：叠加流动斜纹，暗示"正在推进" */
  busy?: boolean;
  title?: string;
}) {
  const w = Math.max(0, Math.min(100, pct));
  const cls = ['bar', kind !== 'gold' ? `bar--${kind}` : '', thin ? 'bar--thin' : '', tall ? 'bar--tall' : '', busy ? 'bar--busy' : '']
    .filter(Boolean).join(' ');
  return (
    <div class={cls} title={title} role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${w}%` }} />
    </div>
  );
}

/**
 * 时间进度条：从 startAt 到 finishAt，每秒自动推进（订阅 tick）。
 * 完成后 pct=100 并显示"完成"，由上层的数据刷新负责移除。
 */
export function TimerBar({ startAt, finishAt, label, kind = 'ember' }: {
  startAt: number;
  finishAt: number;
  label?: ComponentChildren;
  kind?: BarKind;
}) {
  tick.value; // 订阅心跳
  const now = Date.now();
  const total = Math.max(1, finishAt - startAt);
  const done = Math.max(0, Math.min(total, now - startAt));
  const left = Math.max(0, finishAt - now);
  return (
    <div class="progress">
      <div class="progress-head">
        {label != null && <span>{label}</span>}
        <span class="spacer" />
        <span class="num">{left > 0 ? fmtDur(left) : '完成'}</span>
      </div>
      <Bar pct={(done / total) * 100} kind={kind} busy={left > 0} />
    </div>
  );
}

/** 纯文字倒计时（每秒刷新）。 */
export function Countdown({ until, prefix, done = '已完成' }: { until: number; prefix?: string; done?: string }) {
  tick.value;
  const left = until - Date.now();
  return <span class="num">{prefix}{left > 0 ? fmtDur(left) : done}</span>;
}
