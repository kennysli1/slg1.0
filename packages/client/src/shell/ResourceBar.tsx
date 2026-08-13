/** 常驻资源 HUD：同时呈现库存、容量与每小时变化。 */
import { tick, dataVersion } from '../app/store.js';
import { getCache, getPopState, liveResource, interpolatePop, interpolateTotalPop } from '../app/state.js';
import { resInfo, resourceKeys } from '../app/config.js';
import { fmt } from '../shared/utils/format.js';
import { Icon, Bar } from '../ui/index.js';

type ResourceSnapshot = ReturnType<typeof getCache>['res'];

export function ResourceBar() {
  tick.value;
  dataVersion.value;
  const resource = getCache().res;
  if (!resource) return <div class="resbar" aria-label="资源概览" />;
  return (
    <div class="resbar" aria-label="资源概览">
      {resourceKeys().map((type) => (
        type === 'gold'
          ? <GoldCell key={type} />
          : <ResCell key={type} type={type} res={resource} />
      ))}
      <UpkeepCell crop={resource.cropUpkeep} />
      <PopCell />
    </div>
  );
}

function ResCell({ type, res }: { type: string; res: NonNullable<ResourceSnapshot> }) {
  const info = resInfo(type);
  const have = liveResource(type);
  const capacity = res.capacity?.[type] ?? 0;
  const overflow = res.overflowCap ?? 0;
  const effCap = capacity * (1 + overflow);
  const rate = (res.netRate?.[type] ?? 0) * 3600;
  const rawRate = res.rawRate?.[type] ?? rate; // 原始产率（停产时用于显示本可产出多少）
  const paused = Boolean(res.productionPaused?.[type] || (res.overCapacity?.[type] ?? 0) > 0);
  const low = type === 'crop' && rate < 0;
  const over = have > capacity;
  const percent = effCap > 0 ? have / effCap * 100 : 0;
  const nearFull = percent >= 92;
  const state = [low ? 'res--low' : '', paused ? 'res--over' : ''].filter(Boolean).join(' ');
  const title = `${info.name}：${fmt(have)} / ${fmt(capacity)}；`
    + (paused ? `仓储已满，生产暂停（原产量 ${rawRate >= 0 ? '+' : ''}${rawRate.toFixed(0)}/时）` : `每小时 ${rate >= 0 ? '+' : ''}${rate.toFixed(0)}`)
    + (low ? '；净消耗为负，粮食正在减少' : '');
  return (
    <div class={`res ${state}`} title={title}>
      <Icon icon={info.icon} label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">{info.name}</span>
        <span class="res-num">
          {over ? <span style="color:#fbbf24">{fmt(have)}</span> : fmt(have)}<small>/{fmt(capacity)}</small>
        </span>
      </div>
      <div class="res-meta">
        <span class="res-rate">{paused ? <span style="opacity:0.55">停产（本可 {rawRate >= 0 ? '+' : ''}{rawRate.toFixed(0)}/时）</span> : `${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/时`}</span>
        <span class="res-cap">
          <Bar pct={paused ? 100 : Math.min(100, percent)} thin kind={paused || nearFull ? 'ember' : low ? 'crimson' : 'steel'} />
        </span>
      </div>
    </div>
  );
}

function GoldCell() {
  const info = resInfo('gold');
  const gold = liveResource('gold');
  const rate = getPopState()?.goldPerHour ?? 0;
  return (
    <div class="res res--gold" title={`金币：${fmt(gold)}；每小时 ${rate >= 0 ? '+' : ''}${rate.toFixed(0)}`}>
      <Icon icon={info.icon} label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">金币</span>
        <span class="res-num">{fmt(gold)}</span>
      </div>
      <div class="res-meta"><span class="res-rate">{rate >= 0 ? '+' : ''}{rate.toFixed(0)}/时</span></div>
    </div>
  );
}

function UpkeepCell({ crop }: { crop: number }) {
  return (
    <div class="res" title="全军与平民每小时口粮消耗">
      <Icon icon="ui_icon_upkeep" label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">耗粮</span>
        <span class="res-num">{fmt(crop)}</span>
      </div>
      <div class="res-meta"><span>口粮/时</span></div>
    </div>
  );
}

function PopCell() {
  const state = getPopState();
  if (!state) return null;
  const population = interpolateTotalPop();
  const atCap = !state.inFamine && state.hardCap > 0 && population / state.hardCap >= 1;
  const growth = Math.round(atCap ? (state.potentialGrowthPerHour ?? 0) : state.growthPerHour);
  const nearCap = state.hardCap > 0 && population / state.hardCap >= .95;
  const overflowPct = ((state.overflowRatio ?? 0) * 100).toFixed(0);
  const title = state.inFamine
    ? `人口：${fmt(population)}/${fmt(state.hardCap)}；饥荒中，人口正在减少；变化 ${growth}/时`
    : `人口：${fmt(population)}/${fmt(state.hardCap)}；平民 ${fmt(Math.round(interpolatePop()))}；`
      + `军队 ${fmt(state.soldierPop)}；增长 ${growth >= 0 ? '+' : ''}${growth}/时`
      + ((state.overflowRatio ?? 0) > 0 ? `\n⚠ 仓库溢出中（均溢 ${overflowPct}%）→ 人口增长仅剩 ${((1 - (state.overflowRatio ?? 0)) * 100).toFixed(0)}%` : '');
  return (
    <div class={`res res--pop${state.inFamine || (state.overflowRatio ?? 0) > 0 ? ' res--alarm' : ''}`} title={title}>
      <Icon icon="ui_icon_pop" label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">人口</span>
        <span class="res-num">{fmt(population)}<small>/{fmt(state.hardCap)}</small></span>
      </div>
      <div class="res-meta">
        <span class="res-rate" style={(state.overflowRatio ?? 0) > 0 ? { color: '#fbbf24' } : void 0}>{growth >= 0 ? '+' : ''}{growth}/时{atCap ? ' · 已满' : ''}</span>
        <span class="res-cap">
          <Bar
            pct={state.hardCap > 0 ? population / state.hardCap * 100 : 0}
            thin
            kind={state.inFamine ? 'crimson' : nearCap ? 'ember' : 'jade'}
          />
        </span>
      </div>
    </div>
  );
}
