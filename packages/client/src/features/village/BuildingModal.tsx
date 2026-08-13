/**
 * Building detail modal.
 *
 * FIXED PUBLIC SIGNATURE (cross-feature contract, do not change):
 *   export function openBuilding(slotId: string): void
 *
 * Routes:
 *  - mercenarycamp → openMercCamp()
 *  - tradecenter   → openTradeCenter()
 *  - any other     → BuildingDetailModal
 *
 * Ports all behaviour from village.ts openBuildingDetail():
 *  - description, effect text, provides section, production, popCap info
 *  - upgrade cost + button with disabled reasons
 *  - demolish with in-modal 2-step confirmation (NO window.confirm)
 *  - TrainPanel embed for military buildings (detected via army.slots)
 *  - Treasure management section for 'main' and 'treasury'
 */
import { dataVersion, openModal, showToast, taskStates } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { req, me } from '../../api.js';
import { act } from '../../app/refresh.js';
import { TaskOffers } from './TaskBar.js';
import {
  buildingInfo,
  gameConstants,
  storageBase,
  storageGrowthPerLevel,
  smithyBonusPerLevel,
  wallBonusPerLevel,
  popHospitalRecoveryBase,
  popHospitalRecoveryPerLevel,
  popHospitalRecoveryMax,
  treasureInfo,
  treasureCategoryName,
  treasureRarityName,
  treasureEffectText,
} from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import {
  Modal, IconPlate, Btn, Tag, CostRow, canAfford,
  TimerBar, SectionHead, Divider, StatGrid, Stat, SecondaryActions, confirmDanger,
} from '../../ui/index.js';
import { TrainPanel } from '../army/TrainPanel.js';
import { openMercCamp } from '../army/MercCampModal.js';
import { openTradeCenter } from '../trade/TradeModal.js';
import { openAcademy } from '../research/AcademyModal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Total levels of a given building kind across all zones. */
function sumLevelsOfKind(kind: string): number {
  const vil = getCache().vil;
  if (!vil) return 0;
  let sum = 0;
  for (const zone of ['inner', 'outer'] as const) {
    for (const p of (vil.zones?.[zone]?.placed ?? []) as any[]) {
      if (p.kind === kind && (p.level ?? 0) >= 1) sum += p.level;
    }
  }
  return sum;
}

/** Produces section for warehouse, granary, smithy, wall, hospital, residence. */
function ProvidesSection({ kind, level }: { kind: string; level: number }) {
  if (!gameConstants()) return null;

  const capOf = (totalLv: number) => Math.round(storageBase() * (1 + totalLv * storageGrowthPerLevel()));
  const marginal = () => Math.round(storageBase() * storageGrowthPerLevel());

  let rows: Array<[string, string]> = [];

  switch (kind) {
    case 'warehouse': {
      const total = capOf(sumLevelsOfKind('warehouse'));
      const contrib = marginal() * (level >= 1 ? level : 1);
      rows = [
        ['木 · 泥 · 铁 上限（全村）', fmt(total)],
        [level >= 1 ? '本建筑贡献' : '建成 Lv1 贡献', `+${fmt(contrib)}`],
      ];
      break;
    }
    case 'granary': {
      const total = capOf(sumLevelsOfKind('granary'));
      const contrib = marginal() * (level >= 1 ? level : 1);
      rows = [
        ['粮食 上限（全村）', fmt(total)],
        [level >= 1 ? '本建筑贡献' : '建成 Lv1 贡献', `+${fmt(contrib)}`],
      ];
      break;
    }
    case 'smithy': {
      rows = [['全军攻防加成', `+${(level * smithyBonusPerLevel() * 100).toFixed(0)}%`]];
      break;
    }
    case 'wall': {
      rows = [['守城防御加成', `+${(level * wallBonusPerLevel() * 100).toFixed(0)}%`]];
      break;
    }
    case 'hospital': {
      const ratio = Math.min(popHospitalRecoveryMax(),
        popHospitalRecoveryBase() + level * popHospitalRecoveryPerLevel()) * 100;
      rows = [['战死士兵回收', `${ratio.toFixed(0)}%`]];
      break;
    }
    case 'residence': {
      const info = buildingInfo('residence');
      const cum = info.popCapByLevel
        ? info.popCapByLevel.slice(0, level).reduce((a, b) => a + b, 0)
        : (info.popCapPerLevel ?? 0) * level;
      rows = [['人口上限（本建筑累计）', `+${cum}`]];
      break;
    }
    default:
      return null;
  }

  if (!rows.length) return null;

  return (
    <>
      <SectionHead>功能 · 提供</SectionHead>
      <div class="bld-provides">
        {rows.map(([k, v]) => (
          <div key={k} class="bld-provides-row">
            <span class="bld-provides-k">{k}</span>
            <span class="bld-provides-v">{v}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Pop-cap info block for buildings that provide popCap. */
function PopCapSection({ kind, level }: { kind: string; level: number }) {
  const info = buildingInfo(kind);
  const pcb = info.popCapByLevel;
  const hasPopCap = (info.popCapPerLevel ?? 0) > 0 || (pcb?.some((v) => v > 0) ?? false);
  if (!hasPopCap) return null;

  const nextLevel = level + 1;
  const inc = pcb?.[nextLevel - 1] ?? info.popCapPerLevel ?? 0;
  const cum = pcb
    ? pcb.slice(0, nextLevel).reduce((a, b) => a + b, 0)
    : (info.popCapPerLevel ?? 0) * nextLevel;

  return (
    <StatGrid>
      <Stat icon="ui_icon_pop" label={`升至 Lv${nextLevel} 增量`} value={`+${inc}`} />
      <Stat icon="ui_icon_pop" label={`升至 Lv${nextLevel} 累计`} value={`+${cum}`} />
    </StatGrid>
  );
}

// ── Treasure management section (for 'main' and 'treasury' buildings) ────────

function TreasureMgmtSection({ kind }: { kind: 'main' | 'treasury' }) {
  dataVersion.value; // subscribe so it refreshes when treasures change

  const data = getCache().treasures as
    | { codes: string[]; slots: number; treasures: any[]; effect: any; town?: string[]; treasury?: string[] }
    | null;

  if (!data) return <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>宝物数据加载中…</p>;

  const locCodes: string[] = kind === 'treasury' ? (data.treasury ?? []) : (data.town ?? []);
  const seen = new Set<string>();
  const allTreasures: any[] = (data.treasures ?? []).filter((t: any) => {
    if (seen.has(t.code)) return false;
    seen.add(t.code);
    return true;
  });
  const list = allTreasures.filter((t: any) => locCodes.includes(t.code));
  const totalCodes = (data.codes ?? []).length;
  const slots = data.slots ?? 1;

  const locLabel = kind === 'treasury' ? '宝库' : '城镇中心';

  if (!list.length) {
    return (
      <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>
        {locLabel}为空（{totalCodes}/{slots}）。清理野营、击败敌军或在贸易中心购买可获得宝物。
      </p>
    );
  }

  return (
    <div class="trs-mgmt-list">
      {list.map((t: any) => {
        const info = treasureInfo(t.code) ?? t;
        const effectTxt = treasureEffectText(info as any);
        const cat = treasureCategoryName(t.category ?? '');
        const rar = treasureRarityName(t.rarity ?? '');
        const isInstant = (t.applyType ?? '') === 'instant';

        return (
          <div key={t.code} class={`trs-mgmt-card rarity-${t.rarity ?? 'common'}`}>
            <IconPlate icon={t.icon} label={t.name} size="md" plate="stone" />
            <div class="trs-mgmt-body">
              <div style={{ fontWeight: 700, fontSize: 'var(--f-sm)' }}>{t.name}</div>
              <div style={{ display: 'flex', gap: 'var(--s-1)', margin: '3px 0', flexWrap: 'wrap' }}>
                <Tag kind="steel">{cat}</Tag><Tag>{rar}</Tag>
              </div>
              <div style={{ fontSize: 'var(--f-xs)', color: 'var(--c-jade)' }}>{effectTxt}</div>
              <div class="trs-mgmt-actions">
                {isInstant && (
                  <Btn size="sm" variant="primary" onClick={async () => {
                    const effectType = (info as any)?.effectType ?? '';
                    if (effectType === 'cavalryTrainSpeed') {
                      // 伯乐：翻倍骑兵，toast 展示实际增加/消耗
                      const res = await req('UseTreasure', { code: t.code });
                      if (!res.ok) { showToast('使用失败', 'bad'); return; }
                      const p = res.payload as any;
                      const count = p.count ?? 0;
                      const ratio = p.ratio ?? 1;
                      const spent = p.spent ?? {};
                      const popCost = p.popCost ?? 0;
                      const added = p.added ?? {};
                      const parts: string[] = [`已使用「${t.name}」`];
                      if (count > 0) {
                        const unitStrs = Object.entries(added).map(([c, n]) => `${c} +${n}`);
                        if (unitStrs.length) parts.push(unitStrs.join('、'));
                        parts.push(`共 ${count} 骑兵`);
                      }
                      if (ratio < 1) parts.push(`(仅 ${(ratio * 100).toFixed(0)}% 翻倍)`);
                      const resStrs = Object.entries(spent).filter(([, v]) => (v as number) > 0).map(([r, v]) => `${r}=${v}`);
                      if (resStrs.length) parts.push(`消耗资源: ${resStrs.join('、')}`);
                      if (popCost > 0) parts.push(`劳动人口 -${popCost}`);
                      showToast(parts.join(' · '), 'ok');
                      return;
                    }
                    const useToast = effectType === 'ritualBuff'
                      ? `已使用「${t.name}」，全资源产出 +${fmt(info?.effectValue ?? 0)}%（持续2小时）`
                      : `已使用「${t.name}」，获得 ${fmt(info?.effectValue ?? 0)} 金币`;
                    const ok = await act(req('UseTreasure', { code: t.code }), { okToast: useToast });
                    if (!ok) return;
                  }}>
                    使用
                  </Btn>
                )}
                <Btn size="sm" onClick={async () => {
                  await act(req('SellTreasure', { code: t.code }), {
                    okToast: `已出售「${t.name}」`,
                  });
                }}>
                  出售
                </Btn>
                <Btn size="sm" variant="danger" onClick={async () => {
                  const ok = await confirmDanger({
                    title: `丢弃${t.name}`,
                    body: '丢弃后宝物会永久消失，且不会获得金币。',
                    confirmText: '确认丢弃',
                  });
                  if (!ok) return;
                  await act(req('DiscardTreasure', { code: t.code }), {
                    okToast: `已丢弃「${t.name}」`,
                  });
                }}>
                  丢弃
                </Btn>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main modal component ──────────────────────────────────────────────────────

interface BuildingDetailModalProps {
  slotId: string;
  close: () => void;
}

function BuildingDetailModal({ slotId, close }: BuildingDetailModalProps) {
  dataVersion.value; // subscribe — refreshes automatically when server data updates

  // ── Find building data from cache ──
  const vil = getCache().vil;
  let kind = '';
  let level = 0;
  let maxLevel = 0;
  let nextCost: Record<string, number> | null = null;
  let nextTimeSec: number | null = null;
  let producing: { ratePerHour: number } | null = null;
  let isBuild = false;
  let demolishing = false;
  let building = false;
  let buildingStartAt: number | undefined;
  let buildingFinishAt: number | undefined;

  if (vil) {
    const tc = vil.townCenter;
    if (tc && tc.slotId === slotId) {
      kind = tc.kind;
      level = tc.level ?? 0;
      maxLevel = tc.maxLevel ?? 0;
      nextCost = tc.nextCost ?? null;
      nextTimeSec = tc.nextTimeSec ?? null;
      isBuild = false;
      building = !!tc.building;
      buildingStartAt = tc.buildingStartAt;
      buildingFinishAt = tc.buildingFinishAt;
    } else {
      outer: for (const zone of ['inner', 'outer'] as const) {
        for (const p of (vil.zones?.[zone]?.placed ?? []) as any[]) {
          if (p.slotId === slotId) {
            kind = p.kind;
            level = p.level ?? 0;
            maxLevel = p.maxLevel ?? 0;
            nextCost = p.nextCost ?? null;
            nextTimeSec = p.nextTimeSec ?? null;
            producing = p.producing ?? null;
            isBuild = (p.level ?? 0) < 1;
            demolishing = !!p.demolishing;
            building = !!p.building;
            buildingStartAt = p.buildingStartAt;
            buildingFinishAt = p.buildingFinishAt;
            break outer;
          }
        }
      }
    }
  }

  // Fallback: army.slots (e.g. when vil not yet loaded, from army screen)
  if (!kind) {
    const slot = getCache().army?.slots?.find((s: any) => s.slotId === slotId);
    if (slot) {
      kind = slot.kind ?? '';
      level = slot.level ?? 0;
      isBuild = level < 1;
    }
  }

  const info = buildingInfo(kind);
  const isMain = kind === 'main';
  const isMax = maxLevel > 0 && level >= maxLevel;

  // Is this a military building (has an army slot)?
  const isTrainer = !!(getCache().army?.slots?.some((s: any) => s.slotId === slotId));

  // Treasure management: main or treasury
  const showTreasureMgmt = kind === 'treasury' || kind === 'main';

  // ── Level label ──
  const lvStr = demolishing
    ? '拆除中'
    : isBuild
      ? '未建造'
      : `Lv${level}${maxLevel ? ` / ${maxLevel}` : ''}`;

  const afford = canAfford(nextCost);

  // 酒馆专属：展示可接取的随机任务委托
  const tavernOffered = kind === 'tavern' ? (taskStates.value[me?.villageId ?? '']?.offered ?? []) : [];

  // ── Upgrade button state ──
  let upgradeBtn: preact.JSX.Element | null = null;
  if (demolishing) {
    upgradeBtn = <Tag kind="crimson">拆除中</Tag>;
  } else if (isMax) {
    upgradeBtn = <Tag kind="gold">已满级</Tag>;
  } else if (building) {
    upgradeBtn = <Tag kind="ember">{isBuild ? '建造中' : '升级中'}</Tag>;
  } else {
    const label = isBuild ? '建造' : `升级至 Lv${level + 1}`;
    upgradeBtn = (
      <Btn
        variant={afford ? 'primary' : 'default'}
        size="sm"
        disabled={!afford}
        title={!afford ? '资源不足' : label}
        onClick={async () => {
          await act(req('UpgradeBuilding', { slotId }), {
            okToast: isBuild ? `开始建造 ${info.name}` : `开始升级 ${info.name}`,
          });
        }}
      >
        {label}
      </Btn>
    );
  }

  return (
    <Modal
      title={info.name}
      sub={lvStr}
      icon={<IconPlate icon={info.icon} label={info.name} size="lg" plate={isMain ? 'gold' : 'stone'} lvl={level > 0 ? level : undefined} maxed={isMax} />}
      onClose={close}
      wide={isTrainer || showTreasureMgmt}
      foot={
        (!demolishing && !isMax && !building) ? (
          <div style={{ display: 'flex', gap: 'var(--s-2)', flex: 1 }}>
            {upgradeBtn}
          </div>
        ) : upgradeBtn
      }
    >
      {/* Description */}
      <SectionHead>简介</SectionHead>
      <p class="bld-desc">{info.desc ?? '这栋建筑暂无简介。'}</p>

      {/* Effect text */}
      <Divider />
      <SectionHead>升级效果</SectionHead>
      <p class="bld-desc">{info.effect ?? '每级提升该建筑的相关能力。'}</p>

      {/* Provides section */}
      {!demolishing && (
        <>
          <Divider />
          <ProvidesSection kind={kind} level={level} />
        </>
      )}

      {/* Production rate */}
      {!demolishing && producing && (
        <>
          <Divider />
          <StatGrid>
            <Stat icon="ui_icon_pop" label="当前产量" value={`+${producing.ratePerHour}/h`} />
          </StatGrid>
        </>
      )}

      {/* Pop cap info */}
      {!demolishing && !isBuild && (
        <>
          <Divider />
          <PopCapSection kind={kind} level={level} />
        </>
      )}

      {/* Upgrade cost block */}
      {!demolishing && !isMax && nextCost && (
        <>
          <Divider />
          <div class="bld-upgrade-block">
            <span class="bld-upgrade-label">
              {isBuild ? '建造消耗' : `升级到 Lv${level + 1} 消耗`}
            </span>
            <CostRow cost={nextCost} timeSec={nextTimeSec} />
          </div>
        </>
      )}
      {demolishing && buildingStartAt && buildingFinishAt && (
        <>
          <Divider />
          <SectionHead>拆除进度</SectionHead>
          <TimerBar startAt={buildingStartAt} finishAt={buildingFinishAt} label="拆除中" kind="crimson" />
          <p class="bld-desc" style={{ color: 'var(--c-ink-dim)' }}>
            建筑正在拆除，期间不提供任何加成，且不可取消。完成后整栋消失、槽位释放。
          </p>
        </>
      )}
      {building && !demolishing && buildingStartAt && buildingFinishAt && (
        <>
          <Divider />
          <TimerBar
            startAt={buildingStartAt}
            finishAt={buildingFinishAt}
            label={isBuild ? '建造进度' : '升级进度'}
          />
        </>
      )}

      {/* Treasure management */}
      {showTreasureMgmt && (
        <>
          <Divider ornate />
          <SectionHead sub={kind === 'main' ? '城镇中心基础栏' : '宝库存储'}>
            宝物管理
          </SectionHead>
          <TreasureMgmtSection kind={kind as 'main' | 'treasury'} />
        </>
      )}

      {/* Training section */}
      {isTrainer && !demolishing && (
        <>
          <Divider ornate />
          <SectionHead sub="本建筑独立队列 · 升级可提速降费">训练</SectionHead>
          <TrainPanel slotId={slotId} kind={kind} level={level} />
        </>
      )}

      {/* Demolish */}
      {kind === 'tavern' && tavernOffered.length > 0 && (
        <>
          <Divider />
          <TaskOffers offered={tavernOffered} />
        </>
      )}

      {!demolishing && !isMain && (
        <>
          <Divider />
          <SecondaryActions label="建筑管理" hint="拆除与移除">
            <p class="secondary-actions__hint">仅在确定不再需要这栋建筑时操作；拆除期间建筑不会提供加成。</p>
            <Btn
              variant="danger"
              size="sm"
              onClick={async () => {
                const ok = await confirmDanger({
                  title: `拆除${info.name}`,
                  body: '整栋建筑会被完全拆除，不消耗也不返还资源；拆除开始后不可取消，期间不提供任何加成。',
                  confirmText: '确认拆除',
                });
                if (!ok) return;
                await act(req('DemolishBuilding', { slotId }), { okToast: '拆除已开始' });
                close();
              }}
            >
              拆除建筑
            </Btn>
          </SecondaryActions>
        </>
      )}
    </Modal>
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open the building detail modal for a given slot.
 * FIXED SIGNATURE — imported by army screen and other features.
 */
export function openBuilding(slotId: string): void {
  // Determine the building kind from cache
  let kind: string | null = null;

  const vil = getCache().vil;
  if (vil) {
    const tc = vil.townCenter;
    if (tc && tc.slotId === slotId) {
      kind = tc.kind;
    } else {
      outer: for (const zone of ['inner', 'outer'] as const) {
        for (const p of (vil.zones?.[zone]?.placed ?? []) as any[]) {
          if (p.slotId === slotId) { kind = p.kind; break outer; }
        }
      }
    }
  }

  // Fallback to army slots
  if (!kind) {
    const slot = getCache().army?.slots?.find((s: any) => s.slotId === slotId);
    if (slot) kind = slot.kind ?? null;
  }

  if (!kind) {
    showToast('找不到该建筑');
    return;
  }

  // Route special buildings
  if (kind === 'mercenarycamp') { openMercCamp(); return; }
  if (kind === 'tradecenter') { openTradeCenter(); return; }
  if (kind === 'academy') { openAcademy(slotId); return; }

  // Open generic detail modal
  openModal(
    (close) => <BuildingDetailModal slotId={slotId} close={close} />,
    'building',
  );
}
