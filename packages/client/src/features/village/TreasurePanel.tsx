/**
 * Treasure panel — shows all treasures stored in the village, aggregate effects,
 * and lets the player navigate to the building holding a specific treasure.
 * Port of renderTreasurePanel() from village.ts.
 */
import { dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { treasureInfo, treasureCategoryName, treasureRarityName, treasureEffectText, resInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { IconPlate, Tag, Panel } from '../../ui/index.js';
import { openBuilding } from './BuildingModal.js';

/** Returns JSX chips for the aggregate treasure effect object. */
function EffectChips({ eff }: { eff: any }) {
  if (!eff) return null;
  const chips: { label: string }[] = [];

  const resMult: Record<string, number> = eff.resMult ?? {};
  for (const k of ['wood', 'clay', 'iron', 'crop']) {
    if ((resMult[k] ?? 0) !== 0) {
      chips.push({ label: `${resInfo(k).name} +${fmt(resMult[k] * 100)}%` });
    }
  }
  const goldMult: number = eff.goldMult ?? 1;
  if (goldMult !== 1) chips.push({ label: `金币 +${fmt((goldMult - 1) * 100)}%` });
  const atkMult: number = eff.atkMult ?? 1;
  if (atkMult !== 1) chips.push({ label: `全军攻击 +${fmt((atkMult - 1) * 100)}%` });
  const defMult: number = eff.defMult ?? 1;
  if (defMult !== 1) chips.push({ label: `全军防御 +${fmt((defMult - 1) * 100)}%` });
  const popMult: number = eff.popGrowthMult ?? 1;
  if (popMult !== 1) chips.push({ label: `人口增长 +${fmt((popMult - 1) * 100)}%` });

  if (!chips.length) {
    return <Tag kind="steel">暂无加成</Tag>;
  }
  return (
    <div class="trs-effects-row">
      {chips.map((c) => <Tag key={c.label} kind="jade">{c.label}</Tag>)}
    </div>
  );
}

export function TreasurePanel() {
  dataVersion.value; // subscribe

  const data = getCache().treasures as
    | { codes: string[]; slots: number; treasures: any[]; effect: any; town?: string[]; treasury?: string[] }
    | null;

  if (!data) return null;

  const totalCodes = (data.codes ?? []).length;
  const slots = data.slots ?? 1;
  const list: any[] = data.treasures ?? [];
  const eff = data.effect ?? {};

  if (!list.length) {
    return (
      <div class="trs-panel">
        <p class="trs-empty-hint">
          暂无宝物。清理野营、击败敌军或在贸易中心向 NPC 购买；
          城镇中心提供基础槽位，建造宝库可扩展。（{totalCodes}/{slots}）
        </p>
        <div>
          <span style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)', marginRight: 'var(--s-2)' }}>本村加成</span>
          <EffectChips eff={eff} />
        </div>
      </div>
    );
  }

  function handleCardClick(code: string) {
    // Navigate to the building that holds this treasure
    const t = getCache().treasures as any;
    const vil = getCache().vil;
    if (!vil) return;

    const inTown = Array.isArray(t?.town) && t.town.includes(code);
    const inTre = Array.isArray(t?.treasury) && t.treasury.includes(code);

    const placed = [
      ...(vil.zones?.inner?.placed ?? []),
      ...(vil.zones?.outer?.placed ?? []),
    ] as any[];
    const tre = placed.find((p: any) => p.kind === 'treasury');
    const tc = vil.townCenter;

    if (inTown && tc) { openBuilding(tc.slotId); return; }
    if (inTre && tre) { openBuilding(tre.slotId); return; }
    // Fallback: treasury first, then TC
    if (tre) { openBuilding(tre.slotId); return; }
    if (tc) { openBuilding(tc.slotId); return; }
  }

  return (
    <div class="trs-panel">
      <div class="trs-grid">
        {list.map((t: any, index: number) => {
          const info = treasureInfo(t.code) ?? t;
          const effectTxt = treasureEffectText(info as any);
          const cat = treasureCategoryName(t.category ?? '');
          const rar = treasureRarityName(t.rarity ?? '');

          return (
            <Panel
              key={`${t.code}-${index}`}
              variant="flat"
              class={`trs-card rarity-${t.rarity ?? 'common'}`}
              role="button"
              tabIndex={0}
              aria-label={`${t.name} — 点击前往管理`}
              onClick={() => handleCardClick(t.code)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') handleCardClick(t.code); }}
              title="点击前往储存该宝物的建筑管理（使用 / 出售 / 丢弃）"
            >
              <IconPlate icon={t.icon} label={t.name} size="md" plate="stone" />
              <div class="trs-body">
                <div class="trs-name">{t.name}</div>
                <div class="trs-meta">
                  <Tag kind="steel">{cat}</Tag>
                  <Tag kind={
                    t.rarity === 'legendary' ? 'gold'
                      : t.rarity === 'epic' ? 'steel'
                        : t.rarity === 'rare' ? 'steel' : undefined
                  }>{rar}</Tag>
                </div>
                <div class="trs-effect">{effectTxt}</div>
              </div>
            </Panel>
          );
        })}
      </div>

      <p class="trs-jump-hint">城镇中心与宝库中的每件被动宝物都会同时生效；同名宝物也会叠加。点击卡片可前往管理。</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>本村宝物加成</span>
        <EffectChips eff={eff} />
      </div>
    </div>
  );
}
