/** 当前操作村的资源账本；顶部只保留战略上下文，资源只在所属村展示。 */
import { dataVersion, tick } from '../../app/store.js';
import {
  getCache, getPopState, interpolatePop, interpolateTotalPop, liveResource,
  type PopSnapshot, type RateBreakdownEntry,
} from '../../app/state.js';
import { resInfo, resourceKeys } from '../../app/config.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import { Bar, Icon, Panel, SectionHead } from '../../ui/index.js';

interface VillageResourceLedgerProps {
  /** The kingdom dock supplies its own context heading to keep the bar compact. */
  embedded?: boolean;
}

type PopulationLedgerState = Pick<
  PopSnapshot,
  'hardCap' | 'inFamine' | 'overflowRatio' | 'soldierPop' | 'trainingPop' |
  'growthPerHour' | 'potentialGrowthPerHour' | 'cropDeficitRate'
>;

function signedRate(rate: number): string {
  const rounded = Math.round(Number.isFinite(rate) ? rate : 0);
  return `${rounded >= 0 ? '+' : ''}${rounded}/时`;
}

function signedExact(rate: number): string {
  const value = Number.isFinite(rate) ? rate : 0;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}/时`;
}

function durationLabel(expiresAt?: number): string {
  if (!expiresAt) return '永久';
  const remaining = expiresAt - Date.now();
  return remaining <= 0 ? '即将结束' : `剩余${fmtDur(remaining)}`;
}

/** 资源、人口、金币共用的悬浮明细文案。 */
export function breakdownTooltip(
  name: string,
  entries: RateBreakdownEntry[] | undefined,
  totalRatePerHour: number,
  netRatePerHour?: number,
): string {
  const lines = [`${name}增长明细`];
  if (!entries?.length) lines.push('暂无来源明细');
  else for (const entry of entries) {
    const percent = entry.percent === undefined ? '' : `（${entry.percent >= 0 ? '+' : ''}${entry.percent.toFixed(1)}%）`;
    lines.push(`${entry.label}：${signedExact(entry.ratePerHour)}${percent} · ${durationLabel(entry.expiresAt)}`);
  }
  lines.push(`理论总产出：${signedExact(totalRatePerHour)}`);
  if (netRatePerHour !== undefined && Math.abs(netRatePerHour - totalRatePerHour) > 0.001) lines.push(`当前净变化：${signedExact(netRatePerHour)}`);
  return lines.join('\n');
}

/**
 * 资源达到容量后，netRate 会被结算规则压到 0；账本仍展示服务端 rawRate，
 * 让玩家看到解除停产后的当前理论产量，而不是由客户端重算建筑加成。
 */
export function resourceLedgerRate(
  stopped: boolean,
  netRatePerSecond: number,
  rawRatePerHour: number,
): { ratePerHour: number; label: string } {
  const ratePerHour = stopped
    ? Number(rawRatePerHour) || 0
    : (Number(netRatePerSecond) || 0) * 3600;
  return {
    ratePerHour,
    label: stopped ? `停产 · ${signedRate(ratePerHour)}` : signedRate(ratePerHour),
  };
}

/** 满员时改用服务端下发的潜在增长率；实际人口外插仍受 popCeiling 限制。 */
export function populationLedgerGrowth(state: PopulationLedgerState, population: number): {
  atCap: boolean;
  growthPerHour: number;
  label: string;
} {
  const atCap = !state.inFamine && state.hardCap > 0 && population >= state.hardCap;
  const growthPerHour = atCap
    ? Number(state.potentialGrowthPerHour ?? state.growthPerHour) || 0
    : state.inFamine && state.cropDeficitRate > 0
      ? -Math.abs(Number(state.cropDeficitRate) || 0)
      : Number(state.growthPerHour) || 0;
  return {
    atCap,
    growthPerHour,
    label: atCap ? `已满 · ${signedRate(growthPerHour)}` : signedRate(growthPerHour),
  };
}

export function populationTooltip(
  state: PopulationLedgerState,
  population: number,
  civilian: number,
  growth: number,
  growthBreakdown?: RateBreakdownEntry[],
  goldBreakdown?: RateBreakdownEntry[],
): string {
  const overflow = Math.max(0, Math.min(1, state.overflowRatio ?? 0));
  const reasons: string[] = [];
  if (state.inFamine) reasons.push('饥荒中，人口正在减少');
  if (overflow > 0) reasons.push(`仓储溢出使人口增长降低 ${Math.round(overflow * 100)}%`);
  const details = [
    `总人口 ${fmt(population)}/${fmt(state.hardCap)}`,
    `劳动人口 ${fmt(civilian)}`,
    `军队人口 ${fmt(state.soldierPop)}`,
  ];
  if (state.trainingPop > 0) details.push(`训练中 ${fmt(state.trainingPop)}`);
  details.push(`${state.hardCap > 0 && population >= state.hardCap && !state.inFamine ? '潜在增长' : '人口变化'} ${signedRate(growth)}`);
  if (reasons.length) details.push(`告警：${reasons.join('；')}`);
  const growthText = breakdownTooltip('人口', growthBreakdown, growth);
  const goldRate = goldBreakdown?.reduce((sum, entry) => sum + Number(entry.ratePerHour || 0), 0);
  const goldText = breakdownTooltip('金币', goldBreakdown, goldRate ?? 0);
  return `${details.join('；')}\n${growthText}\n${goldText}`;
}

export function VillageResourceLedger({ embedded = false }: VillageResourceLedgerProps = {}) {
  tick.value;
  dataVersion.value;
  const resource = getCache().res;
  if (!resource) return null;
  const population = getPopState();
  const totalPopulation = population ? interpolateTotalPop() : 0;
  const civilianPopulation = population ? interpolatePop() : 0;
  const populationGrowth = population
    ? populationLedgerGrowth(population, totalPopulation)
    : null;

  return (
    <section class={`kingdom-resource-ledger${embedded ? ' kingdom-resource-ledger--embedded' : ''}`} aria-label="当前村庄资源">
      {!embedded && <SectionHead sub="随当前操作村庄切换；建造、训练与行军均使用这些库存">当前村庄 · 资源账本</SectionHead>}
      <Panel variant="flat" pad>
        <div class="kingdom-resource-grid">
          {resourceKeys().map((key) => {
            const info = resInfo(key);
            const amount = liveResource(key);
            const capacity = Number(resource.capacity?.[key] ?? 0);
            const pct = capacity > 0 ? amount / capacity * 100 : 0;
            const stopped = Boolean(resource.productionPaused?.[key] || resource.overCapacity?.[key]);
            const rate = key === 'gold'
              ? {
                  ratePerHour: Number(population?.goldPerHour ?? 0),
                  label: signedRate(Number(population?.goldPerHour ?? 0)),
                }
              : resourceLedgerRate(
                  stopped,
                  Number(resource.netRate?.[key] ?? 0),
                  Number(resource.rawRate?.[key] ?? 0),
                );
            const breakdown = (key === 'gold' ? population?.goldBreakdown : resource.resourceBreakdown?.[key] ?? []) as RateBreakdownEntry[];
            const netRatePerHour = key === 'gold' ? rate.ratePerHour : Number(resource.netRate?.[key] ?? 0) * 3600;
            return (
              <div
                class={`kingdom-resource-row${stopped ? ' is-stopped' : ''}`}
                key={key}
                title={breakdownTooltip(info.name, breakdown, key === 'gold' ? rate.ratePerHour : Number(resource.rawRate?.[key] ?? 0), netRatePerHour)}
              >
                <Icon icon={info.icon} label="" decorative size="sm" />
                <div class="kingdom-resource-copy">
                  <span>{info.name}</span>
                  <strong>{fmt(amount)}{key === 'gold' ? '' : <small> / {fmt(capacity)}</small>}</strong>
                </div>
                <div class="kingdom-resource-rate">
                  <span>{rate.label}</span>
                  {key !== 'gold' && <Bar pct={pct} thin kind={stopped ? 'ember' : rate.ratePerHour < 0 ? 'crimson' : 'steel'} />}
                </div>
              </div>
            );
          })}
          {population && populationGrowth && (
            <div
              class={`kingdom-resource-row kingdom-resource-row--population${populationGrowth.atCap ? ' is-capped' : ''}${population.inFamine ? ' is-famine' : ''}`}
              title={populationTooltip(population, totalPopulation, civilianPopulation, populationGrowth.growthPerHour, population.growthBreakdown, population.goldBreakdown)}
            >
              <Icon icon="ui_icon_pop" label="" decorative size="sm" />
              <div class="kingdom-resource-copy">
                <span>人口</span>
                <strong>{fmt(totalPopulation)}<small> / {fmt(population.hardCap)}</small></strong>
              </div>
              <div class="kingdom-resource-rate">
                <span>{populationGrowth.label}</span>
                <Bar
                  pct={population.hardCap > 0 ? totalPopulation / population.hardCap * 100 : 0}
                  thin
                  kind={population.inFamine ? 'crimson' : populationGrowth.atCap ? 'ember' : 'jade'}
                />
              </div>
            </div>
          )}
        </div>
      </Panel>
    </section>
  );
}
