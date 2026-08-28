/** 常驻资源 HUD：同时呈现库存、容量与每小时变化。 */
import { me } from '../api.js';
import { tick, dataVersion, sessionVersion, villageSwitching, showToast } from '../app/store.js';
import { switchVillage } from '../app/refresh.js';
import { errText } from '../shared/ui/text.js';
import { getCache, type PopSnapshot } from '../app/state.js';
import { Icon } from '../ui/index.js';

export function ResourceBar() {
  tick.value;
  dataVersion.value;
  const villagePicker = <VillagePicker />;
  return (
    <div class="resbar" aria-label="当前战略上下文">
      {villagePicker}
      <ReputationCell />
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

/** 人口告警文案由人口面板与单测复用；不再属于顶栏资源显示。 */
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
    ? `人口：${population}/${state.hardCap}${alarm}；${change}`
    : `人口：${population}/${state.hardCap}；平民 ${civilian}；军队 ${state.soldierPop}${alarm}；增长 ${growth >= 0 ? '+' : ''}${growth}/时`;
}
