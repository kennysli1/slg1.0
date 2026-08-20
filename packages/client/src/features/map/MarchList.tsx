/**
 * MarchList — 行军中列表：倒计时 ETA、方向、类型、来源/目标、进度条与操控按钮。
 * 订阅 tick（每秒刷新倒计时/进度）和 dataVersion（数据更新后重渲）。
 */
import { dataVersion, tick, garrisonContinue, selected, showToast } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { unitInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { act } from '../../app/refresh.js';
import { req } from '../../api.js';
import { Btn, Panel, confirmDanger } from '../../ui/index.js';
import { marchProgress } from './march-progress.js';
import type { Movement } from '@slg/shared';

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
  attack:    (d) => d ? '来袭' : '进攻',
  raid:      (_) => '掠夺',
  return:    (_) => '返程',
  found:     (_) => '拓荒',
  transport: (_) => '运输',
  caravan:   (d) => d ? '商队抵达' : '商队出发',
  garrison:  (_) => '野外驻扎',
  explore:   (_) => '探索返程',
};

async function doRecall(m: Movement): Promise<void> {
  if (m.recallForfeits) {
    const confirmed = await confirmDanger({
      title: '确认撤回',
      body: '撤回此军队会造成不可退还的损失（如拓荒开城包或运输物资）。确认继续？',
      confirmText: '确认撤回',
      cancelText: '再想想',
    });
    if (!confirmed) return;
  }
  await act(req('RecallMarch', { movementId: m.id }), { okToast: '撤回令已下达，部队开始返程' });
}

export function MarchList() {
  const _dv  = dataVersion.value;
  const now  = tick.value > 0 ? Date.now() : Date.now(); // subscribe tick for 1s refresh

  const moves: Movement[] = getCache().moves?.movements ?? [];
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
        const inDir     = m.dir === 'in';
        const type      = m.type ?? 'return';
        const label     = (MARCH_LABEL[type] ?? (() => type))(inDir);
        const paused    = m.status === 'paused';
        const stationed = m.status === 'stationed';
        const marching  = m.status === 'marching';

        // 目标行文本
        let destText = '';
        if (stationed) {
          destText = `驻扎于 (${m.pos?.q ?? '?'},${m.pos?.r ?? '?'})`;
        } else if (inDir) {
          const originHex = m.originalFrom ?? m.from;
          destText = `来自 (${originHex?.q ?? '?'},${originHex?.r ?? '?'})`;
          if (m.abandonedTo) destText += ` → 回撤至 (${m.abandonedTo.q},${m.abandonedTo.r})`;
        } else {
          destText = `→ (${m.to?.q ?? '?'},${m.to?.r ?? '?'})`;
          if (m.originalFrom && (m.originalFrom.q !== m.from?.q || m.originalFrom.r !== m.from?.r)) {
            destText = `出发 (${m.originalFrom.q},${m.originalFrom.r}) ${destText}`;
          }
        }

        const troops = m.troops && Object.keys(m.troops).length
          ? Object.entries(m.troops)
            .map(([u, n]) => `${unitInfo(u).name}${fmt(n)}`)
            .join(' ')
          : '';

        // 进度条（驻扎/暂停无进度）
        const prog = (!stationed && !paused && m.path?.length > 1)
          ? marchProgress(m, now)
          : null;

        // 按钮矩阵
        let actions: preact.VNode | null = null;
        if (stationed && !inDir) {
          actions = (
            <span class="march-item-actions">
              <Btn size="sm" onClick={async () => {
                await act(req('RecallGarrison', { movementId: m.id }), { okToast: '驻扎军开始返程' });
              }}>召回</Btn>
              <Btn size="sm" variant="primary" onClick={() => {
                garrisonContinue.value = { movementId: m.id };
                selected.value = null;
                showToast('请在地图上选择驻扎军的下一处目标');
              }}>行军</Btn>
            </span>
          );
        } else if (marching && m.recallable && !inDir) {
          actions = (
            <span class="march-item-actions">
              <Btn size="sm" variant="danger" onClick={() => doRecall(m)}>撤回</Btn>
            </span>
          );
        } else if (paused && !inDir) {
          actions = (
            <span class="march-item-eta march-item-eta--paused" aria-label="交战中，无法操控">
              交战中
            </span>
          );
        }

        const etaEl = (!stationed && !paused && !actions)
          ? <span class="march-item-eta">{secUntil(m.arriveAt)}</span>
          : (!stationed && !paused && actions)
            ? <span class="march-item-eta march-item-eta--sm">{secUntil(m.arriveAt)}</span>
            : null;

        return (
          <div key={`${m.id ?? type}-${i}`} class={`march-item march-item--${type}${inDir ? ' march-item--in' : ''}${paused ? ' march-item--paused' : ''}`}>
            <span class="march-item-icon" aria-hidden="true" />
            <div class="march-item-body">
              <div class="march-item-kind">{label}{paused ? ' · 交战中' : stationed ? ' · 等待命令' : ''}</div>
              <div class="march-item-dest">{destText}{troops ? ` · ${troops}` : ''}</div>
              {prog && (
                <div class="march-item-progress" role="progressbar" aria-valuenow={Math.round(prog.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div class="march-item-progress-bar" style={{ width: `${(prog.ratio * 100).toFixed(1)}%` }} />
                </div>
              )}
            </div>
            {etaEl}
            {actions}
          </div>
        );
      })}
    </Panel>
  );
}
