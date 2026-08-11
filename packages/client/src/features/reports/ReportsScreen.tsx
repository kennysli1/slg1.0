/**
 * 报告页：战报卡片流水 + 待领取宝物 + 实时战场面板。
 *
 * 分类来自 `StoredReport.kind`（写入时由 `notificationKind(event, payload)` 按事件名算好，
 * 见 app/refresh.ts）。**不要**回头去正则匹配已渲染的中文文案 —— 宝物名里带「人口」
 * 之类就会误判。
 */
import { useState } from 'preact/hooks';
import { reportsVersion, dataVersion, battles } from '../../app/store.js';
import { getReports, type ReportKind, type StoredReport } from '../../app/state.js';
import { Empty, SectionHead } from '../../ui/index.js';
import { BattleLive } from './BattleLive.js';
import { PendingTreasures } from './PendingTreasures.js';

// ── 过滤配置 ─────────────────────────────────────────────────

type FilterKind = 'all' | ReportKind;

const FILTERS: Array<{ key: FilterKind; label: string; icon: string }> = [
  { key: 'all',      label: '全部',   icon: '📋' },
  { key: 'battle',   label: '战斗',   icon: '⚔' },
  { key: 'build',    label: '建造',   icon: '🏗' },
  { key: 'march',    label: '行军',   icon: '🏃' },
  { key: 'treasure', label: '宝物',   icon: '💎' },
  { key: 'alarm',    label: '警报',   icon: '🚨' },
  { key: 'pop',      label: '人口',   icon: '👥' },
];

const KIND_ICON: Record<ReportKind, string> = {
  battle:   '⚔',
  build:    '🏗',
  train:    '🎯',
  march:    '🏃',
  alarm:    '🚨',
  treasure: '💎',
  pop:      '👥',
  trade:    '🏪',
  info:     '📌',
};

// ── 子组件 ────────────────────────────────────────────────────

function FilterChips({
  active,
  onChange,
}: {
  active: FilterKind;
  onChange: (k: FilterKind) => void;
}) {
  return (
    <div class="report-filters" role="toolbar" aria-label="战报分类筛选">
      {FILTERS.map(({ key, label, icon }) => (
        <button
          key={key}
          class={`rfilter-chip${active === key ? ' active' : ''}`}
          onClick={() => onChange(key)}
          aria-pressed={active === key}
        >
          <span aria-hidden="true">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}

function ReportCard({ report }: { report: StoredReport }) {
  const icon = KIND_ICON[report.kind] ?? '📌';
  const time = new Date(report.ts).toLocaleTimeString();

  return (
    <div class={`report-card report-card--${report.kind}`} role="listitem">
      <span class="rcard-icon" aria-hidden="true">{icon}</span>
      <div class="rcard-body">
        <div class="rcard-text">{report.text}</div>
        <div class="rcard-time">{time}</div>
      </div>
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────

export function ReportsScreen() {
  // Subscribe to both data and reports signals
  reportsVersion.value;
  dataVersion.value;
  // Also subscribe to battles so BattleLive re-renders reactively
  const hasBattles = Object.keys(battles.value).length > 0;

  const [filter, setFilter] = useState<FilterKind>('all');

  const allReports = getReports();

  const filtered = filter === 'all'
    ? allReports
    : allReports.filter((r) => r.kind === filter);

  const isEmpty = allReports.length === 0 && !hasBattles;

  return (
    <div aria-label="战报">
      {/* ① 实时战场（置顶） */}
      <BattleLive />

      {/* ② 待领取宝物 */}
      <PendingTreasures />

      {/* ③ 战报流水 */}
      <section>
        <SectionHead sub={allReports.length ? `共 ${allReports.length} 条` : undefined}>
          战报记录
        </SectionHead>

        {isEmpty ? (
          <Empty icon="📜" title="战报空空如也">
            去地图掠夺野怪营地，或向其他玩家发起进攻——<br />
            每一场战斗的经过、损失与战利品都会记录在这里。
          </Empty>
        ) : (
          <>
            <FilterChips active={filter} onChange={setFilter} />

            {filtered.length === 0 ? (
              <Empty icon="🔍" title="暂无此类战报">
                切换其他分类，或去触发相关事件
              </Empty>
            ) : (
              <div class="report-list" role="list">
                {filtered.map((r, i) => (
                  <ReportCard key={`${r.ts}-${i}`} report={r} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
