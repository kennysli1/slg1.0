/** 常驻资源 HUD：同时呈现库存、容量与每小时变化。 */
import { me } from '../api.js';
import { tick, dataVersion, sessionVersion, villageSwitching, showToast } from '../app/store.js';
import { switchVillage } from '../app/refresh.js';
import { errText } from '../shared/ui/text.js';
import { getCache, getPopState, liveResource, interpolatePop, interpolateTotalPop, type PopSnapshot } from '../app/state.js';
import { resInfo, resourceKeys } from '../app/config.js';
import { fmt } from '../shared/utils/format.js';
import { Icon, Bar } from '../ui/index.js';

type ResourceSnapshot = ReturnType<typeof getCache>['res'];

export function ResourceBar() {
  tick.value;
  dataVersion.value;
  const villagePicker = <VillagePicker />;
  const resource = getCache().res;
  if (!resource) return <div class="resbar" aria-label="资源概览">{villagePicker}</div>;
  return (
    <div class="resbar" aria-label="资源概览">
      {villagePicker}
      <ReputationCell />
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

/** 全局村庄选择器：资源栏属于应用壳，因此在任意页签都能看到当前操作村并切换。 */
function VillagePicker() {
  sessionVersion.value;
  const switching = villageSwitching.value;
  if (!me) return null;
  const villages = me.villages ?? [];
  const current = villages.find((v) => v.id === me?.villageId);
  const fallback = current ?? { id: me.villageId, q: me.q, r: me.r, name: '当前村庄', isCapital: false };

  async function onPick(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const id = select.value;
    if (!id || id === me?.villageId) return;
    const result = await switchVillage(id);
    if (!result.ok) {
      showToast(`切换村庄失败：${errText(result.error)}`, 'bad');
      select.value = me?.villageId ?? '';
      return;
    }
  }

  return (
    <label class="res res--village-picker" title={`当前操作村庄：${fallback.name}（${fallback.q},${fallback.r}）`}>
      <span class="res-village-heading">当前村庄</span>
      <select
        class="village-picker-select"
        value={me.villageId}
        onChange={onPick}
        disabled={villages.length < 2 || !!switching}
        aria-label="切换当前村庄"
      >
        {(villages.length ? villages : [fallback]).map((village) => (
          <option key={village.id} value={village.id}>
            {village.name}{village.isCapital ? '（主城）' : ''} ({village.q},{village.r})
          </option>
        ))}
      </select>
    </label>
  );
}

function ReputationCell() {
  const rep = getCache().reputation as any;
  const value = Math.trunc(Number(rep?.value) || 0);
  const alignment = value > 0 ? '正声望' : value < 0 ? '负声望' : '中立';
  const popBonus = Math.round((Number(rep?.populationGrowthBonus) || 0) * 100);
  const pveBonus = Math.round((Number(rep?.pveTreasureDropBonus) || 0) * 100);
  const popPenalty = Math.round((Number(rep?.populationGrowthPenalty) || 0) * 100);
  const armyAttackBonus = Math.round((Number(rep?.armyAttackBonus) || 0) * 100);
  const armyDefenseBonus = Math.round((Number(rep?.armyDefenseBonus) || 0) * 100);
  const taxReduction = Math.round((Number(rep?.goldTaxReduction) || 0) * 100);
  const title = rep
    ? `声望值：${value >= 0 ? '+' : ''}${value}（${alignment}）；人口增长 ${value < 0 ? '-' + popPenalty : '+' + popBonus}%；军队攻防 ${value < 0 ? '+' + armyAttackBonus + '% / +' + armyDefenseBonus + '%' : '无修正'}；金币税收 ${value > 0 ? '-' + taxReduction : '无修正'}；PvE宝物掉落 ${pveBonus >= 0 ? '+' : ''}${pveBonus}%`
    : '声望值：正在加载';
  return (
    <div class={`res res--reputation res--${value > 0 ? 'good' : value < 0 ? 'evil' : 'neutral'}`} title={title}>
      <Icon icon="ui_icon_pop" label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">声望</span>
        <span class="res-num">{value >= 0 ? '+' : ''}{value}</span>
      </div>
      <div class="res-meta"><span class="res-rate">{alignment}</span></div>
    </div>
  );
}

function ResCell({ type, res }: { type: string; res: NonNullable<ResourceSnapshot> }) {
  const info = resInfo(type);
  const have = liveResource(type);
  const capacity = res.capacity?.[type] ?? 0;
  const rate = (res.netRate?.[type] ?? 0) * 3600;
  const rawRate = res.rawRate?.[type] ?? rate; // 原始产率（停产时用于显示本可产出多少）
  const paused = Boolean(res.productionPaused?.[type] || (res.overCapacity?.[type] ?? 0) > 0);
  const low = type === 'crop' && rate < 0;
  const percent = capacity > 0 ? have / capacity * 100 : 0;
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
        <span class="res-num">{fmt(have)}<small>/{fmt(capacity)}</small></span>
      </div>
      <div class="res-meta">
        <span class="res-rate">{paused ? <span style="opacity:0.55">停产（{rawRate >= 0 ? '+' : ''}{rawRate.toFixed(0)}/时）</span> : `${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/时`}</span>
        <span class="res-cap">
          <Bar pct={percent} thin kind={paused || nearFull ? 'ember' : low ? 'crimson' : 'steel'} />
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

export function populationTooltip(
  state: Pick<PopSnapshot, 'hardCap' | 'inFamine' | 'overflowRatio' | 'soldierPop'>,
  population: number,
  civilian: number,
  growth: number,
): string {
  const overflow = Math.max(0, Math.min(1, state.overflowRatio ?? 0));
  const reasons: string[] = [];
  if (state.inFamine) reasons.push('饥荒中，人口正在减少');
  if (overflow > 0) reasons.push(`仓储溢出使人口增长降低 ${Math.round(overflow * 100)}%`);
  const alarm = reasons.length ? `；红框原因：${reasons.join('；')}` : '';
  const change = `变化 ${growth >= 0 ? '+' : ''}${growth}/时`;
  return state.inFamine
    ? `人口：${fmt(population)}/${fmt(state.hardCap)}${alarm}；${change}`
    : `人口：${fmt(population)}/${fmt(state.hardCap)}；平民 ${fmt(civilian)}；军队 ${fmt(state.soldierPop)}${alarm}；增长 ${growth >= 0 ? '+' : ''}${growth}/时`;
}

function PopCell() {
  const state = getPopState();
  if (!state) return null;
  const population = interpolateTotalPop();
  const atCap = !state.inFamine && state.hardCap > 0 && population / state.hardCap >= 1;
  const growth = Math.round(atCap ? (state.potentialGrowthPerHour ?? 0) : state.growthPerHour);
  const hasGrowthDebuff = (state.overflowRatio ?? 0) > 0;
  const title = populationTooltip(state, population, Math.round(interpolatePop()), growth);
  return (
    <div class={`res res--pop${state.inFamine || hasGrowthDebuff ? ' res--alarm' : ''}`} title={title}>
      <Icon icon="ui_icon_pop" label="" decorative size="sm" />
      <div class="res-value">
        <span class="res-label">人口</span>
        <span class="res-num">{fmt(population)}<small>/{fmt(state.hardCap)}</small></span>
      </div>
      <div class="res-meta">
        <span class="res-rate">{growth >= 0 ? '+' : ''}{growth}/时{atCap ? ' · 已满' : ''}</span>
        <span class="res-cap">
          <Bar
            pct={state.hardCap > 0 ? population / state.hardCap * 100 : 0}
            thin
            kind={state.inFamine || hasGrowthDebuff ? 'crimson' : 'jade'}
          />
        </span>
      </div>
    </div>
  );
}
