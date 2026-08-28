/**
 * Population panel — ported from population.ts to Preact + signals.
 * Subscribes to tick (local interpolation) and dataVersion (server updates).
 * Shows: total/hardCap bar, civilian/soldier/training breakdown, growth/h,
 * prosperity (繁荣度), four-axis laborMults, and famine/cap status tags.
 */
import { tick, dataVersion } from '../../app/store.js';
import { getPopState, interpolatePop, interpolateTotalPop } from '../../app/state.js';
import { fmt } from '../../shared/utils/format.js';
import { Bar, Panel, SectionHead, StatGrid, Stat, Tag } from '../../ui/index.js';

function multPct(mult: number): string {
  const extra = Math.round((mult - 1) * 100);
  return `${extra >= 0 ? '+' : ''}${extra}%`;
}

export function PopPanel() {
  tick.value;       // subscribe — updates every second for live interpolation
  dataVersion.value; // subscribe — updates when server snapshot arrives

  const ps = getPopState();
  if (!ps) return null;

  const pop = interpolateTotalPop();
  const laborPop = Math.round(interpolatePop());
  const rawRatio = ps.hardCap > 0 ? pop / ps.hardCap : 0;
  const ratio = Math.min(1, rawRatio);
  const atCap = !ps.inFamine && rawRatio >= 1.0;
  const nearCap = !ps.inFamine && rawRatio >= 0.85 && rawRatio < 1.0;

  const growthDisplay = atCap ? (ps.potentialGrowthPerHour ?? 0) : ps.growthPerHour;
  const prosperityPct = Math.round((ps.prosperityMult - 1) * 100);
  const laborRatioPct = Math.round((ps.laborRatio ?? 0) * 100);
  const fullThreshPct = Math.round((ps.popProsperityFullRatio ?? 0.7) * 100);
  const maxBonusPct = Math.round((ps.popProsperityMaxBonus ?? 0.3) * 100);

  const barKind = ps.inFamine ? 'crimson' as const
    : nearCap || atCap ? 'ember' as const
    : 'jade' as const;

  const lm = ps.laborMults;
  const AXES = [
    { label: '资源产率', val: lm.production },
    { label: '建造速度', val: lm.build },
    { label: '练兵速率', val: lm.train },
    { label: '研究速率', val: lm.research },
  ];

  return (
    <div class="pop-panel">
      {/* Big number */}
      <div class="pop-big" title={`总人口 ${fmt(pop)} / 硬上限 ${fmt(ps.hardCap)}（平民 ${fmt(laborPop)} · 军队 ${fmt(ps.soldierPop)} · 训练中 ${fmt(ps.trainingPop)}）`}>
        <span class="pop-big-num">{fmt(pop)}</span>
        <span class="pop-big-sep">/</span>
        <span class="pop-big-cap">{fmt(ps.hardCap)}</span>
        <span class="pop-big-pct">{(ratio * 100).toFixed(1)}%</span>
      </div>

      {/* Progress bar */}
      <div class="pop-bar-row">
        <Bar pct={ratio * 100} kind={barKind} tall />
      </div>

      {/* 溢出警告——大数字正下方，最显眼 */}
      {(ps.overflowRatio ?? 0) > 0 && (
        <>
          <style>{`
            .pop-overflow-alert {
              display: flex;
              align-items: flex-start;
              gap: 12px;
              margin: 12px 0;
              padding: 14px 16px;
              border-radius: 8px;
              background: rgba(255,140,0,.12);
              border: 2px solid rgba(255,140,0,.45);
              box-shadow: 0 0 18px rgba(255,140,0,.25);
              animation: pop-overflow-pulse 1.8s ease-in-out infinite;
            }
            @keyframes pop-overflow-pulse {
              0%,100% { box-shadow: 0 0 18px rgba(255,140,0,.25); }
              50% { box-shadow: 0 0 32px rgba(255,140,0,.5); }
            }
            .pop-overflow-alert-icon { font-size: 28px; flex-shrink: 0; }
            .pop-overflow-alert-title { font-weight: 700; font-size: 14px; color: #ffb347; margin-bottom: 4px; }
            .pop-overflow-alert-desc { font-size: 12px; color: #e0c486; line-height: 1.5; }
          `}</style>
          <div class="pop-overflow-alert">
            <div class="pop-overflow-alert-icon">📦</div>
            <div class="pop-overflow-alert-body">
              <div class="pop-overflow-alert-title">仓库溢出 — 人口增长受阻</div>
              <div class="pop-overflow-alert-desc">
                四种资源平均溢出 <b>{(ps.overflowRatio! * 100).toFixed(0)}%</b>，
                人口增速降至 <b>{((1 - ps.overflowRatio!) * 100).toFixed(0)}%</b>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Status alerts */}
      {ps.inFamine && (
        <div class="pop-statuses">
          <div class="pop-status pop-status--famine">
            🚨 饥荒中，人口正在减少——增加粮食产量或减少军队耗粮
          </div>
        </div>
      )}
      {nearCap && (
        <div class="pop-statuses">
          <div class="pop-status pop-status--near">
            ⚠️ 接近人口硬上限（{Math.round(rawRatio * 100)}%），宜扩建住宅或结束征战
          </div>
        </div>
      )}
      {atCap && (
        <div class="pop-statuses">
          <div class="pop-status pop-status--full">
            ✅ 已达人口硬上限（{fmt(ps.hardCap)}），增长暂停
            {(ps.potentialGrowthPerHour ?? 0) > 0 && (
              <span>（本可 +{ps.potentialGrowthPerHour}/h，被上限锁住）</span>
            )}
          </div>
        </div>
      )}

      {/* Key stats */}
      <StatGrid>
        <Stat icon="ui_icon_pop" label="平民（劳动）" value={fmt(laborPop)} title="可转化为士兵、支撑繁荣度的劳动人口" />
        <Stat icon="ui_icon_atk" label="军队足迹" value={fmt(ps.soldierPop)} title="驻军 + 在途（占人口权重）" />
        {ps.trainingPop > 0 && (
          <Stat icon="ui_icon_time" label="训练中" value={fmt(ps.trainingPop)} title="已转出劳动人口、尚未入驻" />
        )}
        <Stat
          icon="ui_icon_pop"
          label={`增长速率${(ps.overflowRatio ?? 0) > 0 ? ' ⚠️' : ''}`}
          value={`${growthDisplay >= 0 ? '+' : ''}${Math.round(growthDisplay)}/h${atCap ? ' (满)' : ''}`}
          title={
            (ps.overflowRatio ?? 0) > 0
              ? `仓库溢出导致人口增长扣减 ${(ps.overflowRatio! * 100).toFixed(0)}%（四资源均溢率）。种田消耗或提升仓储以恢复增长。`
              : atCap ? '已达上限，展示的是原始潜力增长速率' : '每小时净增长（朝上限收敛）'
          }
        />
        <Stat icon="ui_icon_pop" label="平民占比" value={`${laborRatioPct}%`} title="平民 / 总人口，驱动繁荣度" />
        <Stat icon="ui_icon_pop" label="繁荣额外加成" value={`${prosperityPct >= 0 ? '+' : ''}${prosperityPct}%`} title={`劳动人口占比达到 ${fullThreshPct}% 时满值 +${maxBonusPct}%；达到动员上限时为 0%，不降低基础速率`} />
      </StatGrid>

      {/* Five-axis prosperity multipliers */}
      <div>
        <div style={{ marginBottom: 'var(--s-2)' }}>
          <SectionHead sub={`劳动人口占比 ≥ ${fullThreshPct}% 时额外 +${maxBonusPct}%`}>繁荣度额外加成 · 四轴</SectionHead>
        </div>
        <div class="pop-mults-grid">
          {AXES.map(({ label, val }) => {
            const isDim = val < 1;
            return (
              <div key={label} class="pop-mult-cell">
                <span class="pop-mult-label">{label}</span>
                <span class={`pop-mult-val${isDim ? ' dim' : ''}`}>{multPct(val)}</span>
              </div>
            );
          })}
        </div>
        <Panel variant="sunken" pad style={{ marginTop: 'var(--s-2)' }}>
          <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)', lineHeight: 1.55, margin: 0 }}>
            繁荣度只提供额外速率：劳动人口占比达到动员上限对应的最低值时为 0%，达到阈值时为 +{maxBonusPct}%，不会把基础产值降到 100% 以下。
            训练士兵 = 劳动人口转化为军队，总人数守恒（大数字不闪烁）。
            士兵占人口并受本族动员上限 <strong style={{ color: 'var(--c-gold)' }}>{Math.round((ps.mobilizeCap ?? 0) * 100)}%</strong> 约束，
            且按 popCost×(默认口粮 + 军晌) 计耗粮。
          </p>
        </Panel>
      </div>

      {/* Mobilization cap bar */}
      {ps.totalPop > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--f-xs)', color: 'var(--c-ink-soft)', marginBottom: 'var(--s-1)' }}>
            <span>动员上限（士兵/总人口）</span>
            <span>
              <Tag kind="steel">
                {fmt(ps.soldierPop + ps.trainingPop)} / {fmt(Math.round((ps.mobilizeCap ?? 0) * ps.totalPop))}
              </Tag>
            </span>
          </div>
          <Bar
            pct={ps.totalPop > 0 ? ((ps.soldierPop + ps.trainingPop) / (Math.max(1, (ps.mobilizeCap ?? 0.7) * ps.totalPop))) * 100 : 0}
            kind="steel"
            thin
            title={`动员 ${fmt(ps.soldierPop + ps.trainingPop)} / 上限 ${fmt(Math.round((ps.mobilizeCap ?? 0) * ps.totalPop))}（本族 ${Math.round((ps.mobilizeCap ?? 0) * 100)}%）`}
          />
        </div>
      )}
    </div>
  );
}
