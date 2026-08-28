import { useState } from 'preact/hooks';
import { unitInfo } from '../../app/config.js';
import { Icon } from '../../ui/index.js';
import type { StoredReport } from '../../app/state.js';

type Counts = Record<string, number>;

interface BattleRound {
  round: number;
  attackerLosses?: Counts;
  defenderLosses?: Counts;
  attacker?: Counts;
  defender?: Counts;
}

interface BattleDetails {
  side?: 'attacker' | 'defender';
  attackerLineup?: Counts;
  defenderLineup?: Counts;
  rounds?: BattleRound[];
  totalRounds?: number;
  battleLabel?: string;
  attackPower?: number;
  defensePower?: number;
}

function entries(counts?: Counts): Array<[string, number]> {
  return Object.entries(counts ?? {})
    .map(([code, count]) => [code, Number(count) || 0] as [string, number])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
}

function total(counts?: Counts): number {
  return entries(counts).reduce((sum, [, count]) => sum + count, 0);
}

function unitLabel(code: string): string {
  return unitInfo(code).name ?? code;
}

function CountList({ counts, empty = '无' }: { counts?: Counts; empty?: string }) {
  const units = entries(counts);
  if (!units.length) return <span class="battle-report-empty">{empty}</span>;
  return (
    <div class="battle-report-counts">
      {units.map(([code, count]) => (
        <span class="battle-report-count" key={code}>
          <Icon icon={unitInfo(code).icon} label={unitLabel(code)} size="2xs" />
          <span>{unitLabel(code)}</span>
          <strong>{count.toLocaleString()}</strong>
        </span>
      ))}
    </div>
  );
}

function LineupColumn({ label, counts, tone }: { label: string; counts?: Counts; tone: 'attacker' | 'defender' }) {
  return (
    <div class={`battle-report-lineup battle-report-lineup--${tone}`}>
      <div class="battle-report-lineup-head">
        <span>{label}</span>
        <strong>{total(counts).toLocaleString()} 人</strong>
      </div>
      <CountList counts={counts} />
    </div>
  );
}

function lossText(counts?: Counts): string {
  const units = entries(counts);
  return units.length
    ? units.map(([code, count]) => `${unitLabel(code)} ${count.toLocaleString()}`).join('、')
    : '无损失';
}

function BattleReplay({ details }: { details: BattleDetails }) {
  const attackerLabel = details.side === 'defender' ? '敌方（攻）' : '我方（攻）';
  const defenderLabel = details.side === 'defender' ? '我方（守）' : '敌方（守）';
  const rounds = Array.isArray(details.rounds) ? details.rounds : [];
  const totalRounds = Math.max(rounds.length, Number(details.totalRounds) || 0);

  return (
    <div class="battle-report-replay">
      <div class="battle-report-replay-heading">
        <span>战斗回放</span>
        <small>{rounds.length
          ? totalRounds > rounds.length
            ? `共 ${totalRounds.toLocaleString()} 轮 · 展示 ${rounds.length} 个关键轮次`
            : `共 ${rounds.length} 轮 · 按结算顺序`
          : '等待战斗结算'}</small>
      </div>

      <div class="battle-report-lineups">
        <LineupColumn label={attackerLabel} counts={details.attackerLineup} tone="attacker" />
        <div class="battle-report-versus" aria-hidden="true">VS</div>
        <LineupColumn label={defenderLabel} counts={details.defenderLineup} tone="defender" />
      </div>

      {details.attackPower != null && details.defensePower != null && (
        <div class="battle-report-power">
          <span>开战战力</span>
          <strong>{details.attackPower.toLocaleString()}</strong>
          <i>vs</i>
          <strong>{details.defensePower.toLocaleString()}</strong>
        </div>
      )}

      {rounds.length ? (
        <div class="battle-report-rounds">
          {rounds.map((round) => (
            <div class="battle-report-round" key={round.round}>
              <div class="battle-report-round-head">
                <span class="battle-report-round-number">第 {round.round} 轮</span>
                <span class="battle-report-round-total">
                  {total(round.attacker).toLocaleString()} : {total(round.defender).toLocaleString()} 存活
                </span>
              </div>
              <div class="battle-report-round-grid">
                <div>
                  <span class="battle-report-round-label">{attackerLabel}造成</span>
                  <strong>{lossText(round.defenderLosses)}</strong>
                </div>
                <div>
                  <span class="battle-report-round-label">{defenderLabel}造成</span>
                  <strong>{lossText(round.attackerLosses)}</strong>
                </div>
              </div>
              <div class="battle-report-round-survivors">
                <span>攻方剩余</span><CountList counts={round.attacker} />
                <span>守方剩余</span><CountList counts={round.defender} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p class="battle-report-replay-empty">战斗已开始，逐轮结果会在战斗结束后写入这份战报。</p>
      )}
    </div>
  );
}

export function BattleReportCard({ report }: { report: StoredReport }) {
  const [expanded, setExpanded] = useState(false);
  const details = (report.details ?? {}) as BattleDetails;

  return (
    <div class={`report-card report-card--battle${expanded ? ' is-expanded' : ''}`} role="listitem">
      <div class="rcard-marker" aria-hidden="true"><span class="rcard-marker-dot" /></div>
      <div class="battle-report-summary-row">
        <div class="rcard-icon"><Icon icon="ui_icon_atk" label="战斗" size="xs" /></div>
        <div class="rcard-body">
          <button
            class="report-card-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span class="report-card-summary">
              <span class="rcard-head">
                <span class="rcard-kind">战斗报告</span>
                <time class="rcard-time" dateTime={new Date(report.ts).toISOString()}>{new Date(report.ts).toLocaleTimeString()}</time>
              </span>
              <span class="rcard-text">{report.text}</span>
            </span>
            <span class="report-card-chevron" aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded && <BattleReplay details={details} />}
    </div>
  );
}
