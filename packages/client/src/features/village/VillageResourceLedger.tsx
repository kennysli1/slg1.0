/** 当前操作村的资源账本；顶部只保留战略上下文，资源只在所属村展示。 */
import { dataVersion, tick } from '../../app/store.js';
import { getCache, getPopState, liveResource } from '../../app/state.js';
import { resInfo, resourceKeys } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { Bar, Icon, Panel, SectionHead } from '../../ui/index.js';

export function VillageResourceLedger() {
  tick.value;
  dataVersion.value;
  const resource = getCache().res;
  if (!resource) return null;

  return (
    <section class="kingdom-resource-ledger" aria-label="当前村庄资源">
      <SectionHead sub="随当前操作村庄切换；建造、训练与行军均使用这些库存">当前村庄 · 资源账本</SectionHead>
      <Panel variant="flat" pad>
        <div class="kingdom-resource-grid">
          {resourceKeys().map((key) => {
            const info = resInfo(key);
            const amount = liveResource(key);
            const capacity = Number(resource.capacity?.[key] ?? 0);
            const rate = key === 'gold'
              ? Number(getPopState()?.goldPerHour ?? 0)
              : Number(resource.netRate?.[key] ?? 0) * 3600;
            const pct = capacity > 0 ? amount / capacity * 100 : 0;
            const stopped = Boolean(resource.productionPaused?.[key] || resource.overCapacity?.[key]);
            return (
              <div class={`kingdom-resource-row${stopped ? ' is-stopped' : ''}`} key={key} title={`${info.name}属于当前村庄`}>
                <Icon icon={info.icon} label="" decorative size="sm" />
                <div class="kingdom-resource-copy">
                  <span>{info.name}</span>
                  <strong>{fmt(amount)}{key === 'gold' ? '' : <small> / {fmt(capacity)}</small>}</strong>
                </div>
                <div class="kingdom-resource-rate">
                  <span>{stopped ? '停产' : `${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/时`}</span>
                  {key !== 'gold' && <Bar pct={pct} thin kind={stopped ? 'ember' : rate < 0 ? 'crimson' : 'steel'} />}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </section>
  );
}
