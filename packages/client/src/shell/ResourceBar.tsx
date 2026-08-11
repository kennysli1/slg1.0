/**
 * 资源条：五资源 + 耗粮 + 人口，常驻顶栏。
 * 数字每秒本地外插（订阅 tick），不发请求；容量条给"快满了"的直觉。
 */
import { tick, dataVersion } from '../app/store.js';
import { getCache, getPopState, liveResource, interpolatePop, interpolateTotalPop } from '../app/state.js';
import { resInfo, resourceKeys } from '../app/config.js';
import { fmt } from '../shared/utils/format.js';
import { Icon, Bar } from '../ui/index.js';

export function ResourceBar() {
  tick.value; dataVersion.value;
  const r = getCache().res;
  if (!r) return <div class="resbar" />;

  return (
    <div class="resbar">
      {resourceKeys().map((t) => t === 'gold' ? <GoldCell key={t} /> : <ResCell key={t} type={t} res={r} />)}
      <UpkeepCell crop={r.cropUpkeep} />
      <PopCell />
    </div>
  );
}

function ResCell({ type, res }: { type: string; res: any }) {
  const info = resInfo(type);
  const have = liveResource(type);
  const cap = res.capacity?.[type] ?? 0;
  const rate = (res.netRate?.[type] ?? 0) * 3600;
  const paused = !!(res.productionPaused?.[type] || (res.overCapacity?.[type] > 0));
  const low = type === 'crop' && rate < 0;
  const pct = cap > 0 ? (have / cap) * 100 : 0;
  const nearFull = pct >= 92;

  const cls = ['res', low ? 'res--low' : '', paused ? 'res--over' : ''].filter(Boolean).join(' ');
  const title = `${info.name} ${fmt(have)} / ${fmt(cap)}`
    + (paused ? ' · 仓储已满，生产暂停' : ` · ${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/时`)
    + (low ? ' · 净消耗为负，粮食在减少' : '');

  return (
    <div class={cls} title={title}>
      <Icon icon={info.icon} label={info.name} size="sm" />
      <div class="res-num">
        {fmt(have)}<small>/{fmt(cap)}</small>
      </div>
      <div class="res-meta">
        <span class="res-rate">{paused ? '停产' : `${rate >= 0 ? '+' : ''}${rate.toFixed(0)}`}</span>
        <span class="res-cap">
          <Bar pct={pct} thin kind={paused || nearFull ? 'ember' : low ? 'crimson' : 'gold'} />
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
    <div class="res res--gold" title={`${info.name} ${fmt(gold)}（无上限 · 由平民交税获得 · 用于雇佣兵与建造）`}>
      <Icon icon={info.icon} label={info.name} size="sm" />
      <div class="res-num">{fmt(gold)}</div>
      <div class="res-meta"><span class="res-rate">{rate >= 0 ? '+' : ''}{rate.toFixed(0)}/时</span></div>
    </div>
  );
}

function UpkeepCell({ crop }: { crop: number }) {
  return (
    <div class="res" title="全军 + 平民每小时口粮消耗">
      <Icon icon="ui_icon_upkeep" label="耗粮" size="sm" />
      <div class="res-num">{fmt(crop)}</div>
      <div class="res-meta"><span>口粮/时</span></div>
    </div>
  );
}

function PopCell() {
  const ps = getPopState();
  if (!ps) return null;
  const pop = interpolateTotalPop();
  const atCap = !ps.inFamine && ps.hardCap > 0 && pop / ps.hardCap >= 1;
  const growth = Math.round(atCap ? (ps.potentialGrowthPerHour ?? 0) : ps.growthPerHour);
  const nearCap = ps.hardCap > 0 && pop / ps.hardCap >= 0.95;
  const training = (ps.trainingPop ?? 0) > 0 ? ` · 训练中 ${fmt(ps.trainingPop)}` : '';
  const title = ps.inFamine
    ? `人口 ${fmt(pop)}/${fmt(ps.hardCap)} · 饥荒中，人口正在减少 · 增长 ${growth}/时`
    : `人口 ${fmt(pop)}/${fmt(ps.hardCap)} · 平民 ${fmt(Math.round(interpolatePop()))} · 军队 ${fmt(ps.soldierPop)}${training}`
      + ` · 增长 ${growth >= 0 ? '+' : ''}${growth}/时${atCap ? '（已达上限）' : ''}`;

  return (
    <div class={`res res--pop${ps.inFamine || nearCap ? ' res--alarm' : ''}`} title={title}>
      <Icon icon="ui_icon_pop" label="人口" size="sm" />
      <div class="res-num">{fmt(pop)}<small>/{fmt(ps.hardCap)}</small></div>
      <div class="res-meta">
        <span class="res-rate">{growth >= 0 ? '+' : ''}{growth}/时{atCap ? ' 满' : ''}</span>
        <span class="res-cap">
          <Bar pct={ps.hardCap > 0 ? (pop / ps.hardCap) * 100 : 0} thin kind={ps.inFamine ? 'crimson' : nearCap ? 'ember' : 'jade'} />
        </span>
      </div>
    </div>
  );
}
