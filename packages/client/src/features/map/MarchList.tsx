/**
 * MarchList — 行军中列表：倒计时 ETA、方向、类型、来源/目标。
 * 订阅 tick（每秒刷新倒计时）和 dataVersion（数据更新后重渲）。
 */
import { dataVersion, tick } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { unitInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { Panel } from '../../ui/index.js';

function secUntil(ts: number): string {
  const left = Math.max(0, ts - Date.now());
  const s = Math.ceil(left / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}时${m % 60}分`;
  if (m > 0) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

const MARCH_LABEL: Record<string, (inDir: boolean) => string> = {
  attack: (d) => d ? '来袭' : '进攻',
  raid: (_) => '掠夺',
  return: (_) => '返程',
  found: (_) => '拓荒',
  transport: (_) => '运输',
  caravan: (d) => d ? '商队抵达' : '商队出发',
};

export function MarchList() {
  const _dv = dataVersion.value;
  tick.value; // 每秒刷新倒计时

  const moves: any[] = getCache().moves?.movements ?? [];
  if (!moves.length) return null;

  return (
    <Panel variant="flat" class="map-march-list">
      <div style={{ padding: 'var(--s-2) var(--s-3)', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontSize: 'var(--f-xs)', fontWeight: 700, color: 'var(--c-ink-soft)', letterSpacing: '1px', textTransform: 'uppercase' }}>
          行军中 ({moves.length})
        </span>
      </div>
      {moves.map((m, i) => {
        const inDir = m.dir === 'in';
        const type: string = m.type ?? 'return';
        const label = (MARCH_LABEL[type] ?? (() => type))(inDir);
        const dest = inDir
          ? `来自 (${m.from?.q ?? '?'},${m.from?.r ?? '?'})`
          : `→ (${m.to?.q ?? '?'},${m.to?.r ?? '?'})`;
        const paused = m.status === 'paused';
        const troops = (type === 'attack' || type === 'raid') && m.troops && Object.keys(m.troops).length
          ? Object.entries(m.troops as Record<string, number>)
            .map(([u, n]) => `${unitInfo(u).name}${fmt(n)}`)
            .join(' ')
          : '';

        return (
          <div key={`${m.id ?? type}-${i}`} class={`march-item march-item--${type}${inDir ? ' march-item--in' : ''}${paused ? ' march-item--paused' : ''}`}>
            <span class="march-item-icon" aria-hidden="true" />
            <div class="march-item-body">
              <div class="march-item-kind">{label}{paused ? ' · 交战中' : ''}</div>
              <div class="march-item-dest">{dest}{troops ? ` · ${troops}` : ''}</div>
            </div>
            <span class="march-item-eta">{secUntil(m.arriveAt)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
