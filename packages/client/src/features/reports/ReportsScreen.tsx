/**
 * 报告页：战报卡片流水 + 待领取宝物 + 实时战场面板。
 *
 * 分类来自 `StoredReport.kind`（写入时由 `notificationKind(event, payload)` 按事件名算好，
 * 见 app/refresh.ts）。**不要**回头去正则匹配已渲染的中文文案 —— 宝物名里带「人口」
 * 之类就会误判。
 */
import { useState } from 'preact/hooks';
import { me } from '../../api.js';
import { reportsVersion, dataVersion, battles } from '../../app/store.js';
import { getReports, type ReportKind, type StoredReport } from '../../app/state.js';
import { Empty, Icon, Panel, SectionHead } from '../../ui/index.js';
import { BattleLive } from './BattleLive.js';
import { PendingTreasures } from './PendingTreasures.js';

// ── 过滤配置 ─────────────────────────────────────────────────

type FilterKind = 'all' | ReportKind;

const KIND_META: Record<ReportKind, { label: string; icon: string }> = {
  battle:   { label: '战斗', icon: 'ui_icon_atk' },
  build:    { label: '建造', icon: 'bld_main' },
  train:    { label: '训练', icon: 'ui_icon_pop' },
  march:    { label: '行军', icon: 'ui_icon_speed' },
  alarm:    { label: '警报', icon: 'ui_seal_crimson' },
  treasure: { label: '宝物', icon: 'trs_chest' },
  pop:      { label: '人口', icon: 'ui_icon_pop' },
  trade:    { label: '贸易', icon: 'res_gold' },
  research: { label: '科研', icon: 'bld_academy' },
  info:     { label: '动态', icon: 'ui_seal_gold' },
};

const FILTERS: Array<{ key: FilterKind; label: string; icon: string }> = [
  { key: 'all', label: '全部动态', icon: 'ui_seal_gold' },
  ...(['battle', 'build', 'march', 'treasure', 'alarm', 'pop', 'research'] as ReportKind[])
    .map((key) => ({ key, ...KIND_META[key] })),
];

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = dayKey(now.getTime());
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(ts) === today) return '今日战局';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return '昨日记录';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

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
          <Icon icon={icon} label={label} size="2xs" />
          {label}
        </button>
      ))}
    </div>
  );
}

function ReportCard({ report }: { report: StoredReport }) {
  const meta = KIND_META[report.kind] ?? KIND_META.info;
  const time = new Date(report.ts).toLocaleTimeString();

  return (
    <div class={`report-card report-card--${report.kind}`} role="listitem">
      <div class="rcard-marker" aria-hidden="true">
        <span class="rcard-marker-dot" />
      </div>
      <div class="rcard-icon">
        <Icon icon={meta.icon} label={meta.label} size="xs" />
      </div>
      <div class="rcard-body">
        <div class="rcard-head">
          <span class="rcard-kind">{meta.label}</span>
          <time class="rcard-time" dateTime={new Date(report.ts).toISOString()}>{time}</time>
        </div>
        <div class="rcard-text">{report.text}</div>
      </div>
    </div>
  );
}

function ReportTimeline({ reports }: { reports: StoredReport[] }) {
  const groups: Array<{ ts: number; reports: StoredReport[] }> = [];
  for (const report of reports) {
    const previous = groups[groups.length - 1];
    if (previous && dayKey(previous.ts) === dayKey(report.ts)) previous.reports.push(report);
    else groups.push({ ts: report.ts, reports: [report] });
  }

  return (
    <div class="report-timeline">
      {groups.map((group) => (
        <section class="report-day-group" key={dayKey(group.ts)} aria-label={dayLabel(group.ts)}>
          <div class="report-day">
            <span>{dayLabel(group.ts)}</span>
            <small>{group.reports.length} 条记录</small>
          </div>
          <div class="report-list" role="list">
            {group.reports.map((r, i) => <ReportCard key={`${r.ts}-${i}`} report={r} />)}
          </div>
        </section>
      ))}
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
          {me?.villages?.find((v) => v.id === me?.villageId)?.name ?? '当前村'} · 战报记录
        </SectionHead>

        {isEmpty ? (
          <Empty icon="📜" title="战报空空如也">
            去地图掠夺野怪营地，或向其他玩家发起进攻——<br />
            每一场战斗的经过、损失与战利品都会记录在这里。
          </Empty>
        ) : (
          <>
            <FilterChips active={filter} onChange={setFilter} />
            <Panel variant="sunken" class="report-overview">
              <Icon icon={filter === 'all' ? 'ui_seal_gold' : KIND_META[filter].icon} label="当前视图" size="sm" />
              <div>
                <strong>{filter === 'all' ? '全域动态时间线' : `${KIND_META[filter].label}分类记录`}</strong>
                <span>当前展示 {filtered.length} 条 · 最新事件置顶</span>
              </div>
            </Panel>

            {filtered.length === 0 ? (
              <Empty icon="🔍" title="暂无此类战报">
                切换其他分类，或去触发相关事件
              </Empty>
            ) : (
              <ReportTimeline reports={filtered} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
