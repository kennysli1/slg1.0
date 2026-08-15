/**
 * MarchList — 行军中列表：倒计时 ETA、方向、类型、来源/目标。
 * 订阅 tick（每秒刷新倒计时）和 dataVersion（数据更新后重渲）。
 */
import { dataVersion, tick, garrisonContinue, selected, showToast } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { unitInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { act } from '../../app/refresh.js';
import { req } from '../../api.js';
import { Btn, Panel } from '../../ui/index.js';

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
  garrison: (_) => '野外驻扎',
  explore: (_) => '探索返程',
};

export function MarchList() {
  const _dv = dataVersion.value;
  tick.value; // 每秒刷新倒计时

  const moves: any[] = getCache().moves?.movements ?? [];
  if (!moves.length) return null;
  const points = getCache().moves?.marchPoints;

  return (
    <Panel variant="flat" class="map-march-list">
      <div style={{ padding: 'var(--s-2) var(--s-3)', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontSize: 'var(--f-xs)', fontWeight: 700, color: 'var(--c-ink-soft)', letterSpacing: '1px', textTransform: 'uppercase' }}>
          行军与驻扎 ({moves.length}){points ? ` · 行军点 ${points.used}/${points.cap}` : ''}
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
        const stationed = m.status === 'stationed';
        const troops = m.troops && Object.keys(m.troops).length
          ? Object.entries(m.troops as Record<string, number>)
            .map(([u, n]) => `${unitInfo(u).name}${fmt(n)}`)
            .join(' ')
          : '';

        return (
          <div key={`${m.id ?? type}-${i}`} class={`march-item march-item--${type}${inDir ? ' march-item--in' : ''}${paused ? ' march-item--paused' : ''}`}>
            <span class="march-item-icon" aria-hidden="true" />
            <div class="march-item-body">
              <div class="march-item-kind">{label}{paused ? ' · 交战中' : stationed ? ' · 等待命令' : ''}</div>
              <div class="march-item-dest">{stationed ? `驻扎于 (${m.pos?.q ?? '?'},${m.pos?.r ?? '?'})` : dest}{troops ? ` · ${troops}` : ''}</div>
            </div>
            {stationed && !inDir ? <span class="march-item-eta"><Btn size="sm" onClick={async () => {
              await act(req('RecallGarrison', { movementId: m.id }), { okToast: '驻扎军开始返程' });
            }}>召回</Btn><Btn size="sm" variant="primary" onClick={() => {
              garrisonContinue.value = { movementId: m.id };
              selected.value = null;
              showToast('请在地图上选择驻扎军的下一处目标');
            }}>行军</Btn></span> : <span class="march-item-eta">{secUntil(m.arriveAt)}</span>}
          </div>
        );
      })}
    </Panel>
  );
}
