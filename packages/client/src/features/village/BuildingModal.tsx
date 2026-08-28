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
import { openMercCamp } from '../army/MercCampModal.js';
import { openTradeCenter } from '../trade/TradeModal.js';
import { openAcademy } from '../research/AcademyModal.js';
import { openAlchemy } from './AlchemyModal.js';
import { openCouncil } from './CouncilModal.js';

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

/** Produces section for warehouse, granary, wall, hospital, residence. */
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
    | { codes: string[]; slots: number; mainSlots?: number; reserveSlots?: number; slotBreakdown?: { town?: number; treasury?: number; reserve?: number }; treasures: any[]; effect: any; town?: string[]; treasury?: string[]; treasuryReserve?: string[]; needsLoad?: boolean }
    | null;

  if (!data) return <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>宝物数据加载中…</p>;

  const locCodes: string[] = kind === 'treasury' ? (data.treasury ?? []) : (data.town ?? []);
  const reserveCodes: string[] = kind === 'treasury' ? (data.treasuryReserve ?? []) : [];
  const totalCodes = (data.codes ?? []).length;
  // mainSlots is the village-wide passive capacity (town centre + treasury).
  // This modal manages only the selected building, so the treasury view must
  // use its own per-building capacity rather than counting the town-centre slot.
  const slots = kind === 'treasury'
    ? (data.slotBreakdown?.treasury ?? data.reserveSlots ?? 0)
    : 1;

  const locLabel = kind === 'treasury' ? '宝库主栏' : '主基地主栏';

  // Empty slots are rendered explicitly so the player can see the capacity of
  // both bars even when no treasure is currently stored there.
  const emptySlots = (count: number, label: string) => Array.from({ length: Math.max(0, count) }, (_, index) => (
    <div key={`empty-${label}-${index}`} class="trs-empty-slot" aria-label={`${label}空槽`}>
      <span>{label}空槽</span>
    </div>
  ));

  const renderCard = (code: string, index: number, location: 'town' | 'treasury' | 'reserve') => {
    const info = treasureInfo(code) ?? (data.treasures ?? []).find((t: any) => t.code === code);
    if (!info) return null;
    const effectTxt = treasureEffectText(info as any);
    const cat = treasureCategoryName(info.category ?? '');
    const rar = treasureRarityName(info.rarity ?? '');
    const isInstant = (info.applyType ?? '') === 'instant';
    const isReserve = location === 'reserve';
    return (
      <div key={`${location}-${code}-${index}`} class={`trs-mgmt-card rarity-${info.rarity ?? 'common'}${isReserve ? ' trs-mgmt-card--reserve' : ''}`}>
        <IconPlate icon={info.icon} label={info.name} size="md" plate="stone" />
        <div class="trs-mgmt-body">
          <div style={{ fontWeight: 700, fontSize: 'var(--f-sm)' }}>{info.name}</div>
          <div style={{ display: 'flex', gap: 'var(--s-1)', margin: '3px 0', flexWrap: 'wrap' }}>
            <Tag kind="steel">{isReserve ? '备用栏 · 不生效' : locLabel}</Tag><Tag>{cat}</Tag><Tag>{rar}</Tag>
          </div>
          <div style={{ fontSize: 'var(--f-xs)', color: isReserve ? 'var(--c-ink-dim)' : 'var(--c-jade)' }}>{effectTxt}</div>
          <div class="trs-mgmt-actions">
            {isReserve ? (
              <Btn size="sm" variant="primary" onClick={async () => { await act(req('LoadTreasure', { code })); }}>装载</Btn>
            ) : (
              <Btn size="sm" onClick={async () => { await act(req('UnloadTreasure', { code, from: location })); }}>卸下</Btn>
            )}
            {isInstant && (
              <Btn size="sm" variant="primary" onClick={async () => {
                const effectType = (info as any)?.effectType ?? '';
                const useToast = effectType === 'ritualBuff'
                  ? `已使用「${info.name}」，全资源产出 +${fmt(info.effectValue ?? 0)}%（持续2小时）`
                  : `已使用「${info.name}」，获得 ${fmt(info.effectValue ?? 0)} 金币`;
                await act(req('UseTreasure', { code, location }), { okToast: useToast });
              }}>使用</Btn>
            )}
            <Btn size="sm" onClick={async () => { await act(req('SellTreasure', { code, location }), { okToast: `已出售「${info.name}」` }); }}>出售</Btn>
            <Btn size="sm" variant="danger" onClick={async () => {
              const ok = await confirmDanger({ title: `丢弃${info.name}`, body: '丢弃后宝物会永久消失，且不会获得金币。', confirmText: '确认丢弃' });
              if (ok) await act(req('DiscardTreasure', { code, location }), { okToast: `已丢弃「${info.name}」` });
            }}>丢弃</Btn>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div class="trs-mgmt-list">
      {kind === 'treasury' && data.needsLoad && <div class="trs-load-warning">备用栏有宝物且主宝物栏有空位，可点击「装载」使其生效。</div>}
      <SectionHead sub={`${locCodes.length}/${slots}`}>主宝物栏 · 被动生效</SectionHead>
      {locCodes.map((code, index) => renderCard(code, index, kind === 'treasury' ? 'treasury' : 'town'))}
      {emptySlots(slots - locCodes.length, '主栏')}
      {kind === 'treasury' && (
        <>
          <SectionHead sub={`${reserveCodes.length}/${data.reserveSlots ?? 0}`}>备用宝物栏 · 不生效</SectionHead>
          {reserveCodes.map((code, index) => renderCard(code, index, 'reserve'))}
          {emptySlots((data.reserveSlots ?? 0) - reserveCodes.length, '备用栏')}
        </>
      )}
      {!totalCodes && <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>清理野营、击败敌军或在贸易中心购买可获得宝物。</p>}
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
  let repairCost: Record<string, number> | null = null;
  let repairTimeSec: number | null = null;
  let repairTargetLevel: number | undefined;
  let damaged = false;
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
            repairCost = p.repairCost ?? null;
            repairTimeSec = p.repairTimeSec ?? null;
            repairTargetLevel = p.repairTargetLevel;
            damaged = !!p.damaged || repairTargetLevel != null;
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

  const info = buildingInfo(kind);
  const isMain = kind === 'main';
  const isMax = maxLevel > 0 && level >= maxLevel;
  const isDamaged = damaged || repairTargetLevel != null;

  // Treasure management: main or treasury
  const showTreasureMgmt = kind === 'treasury' || kind === 'main';

  // ── Level label ──
  const lvStr = demolishing
    ? '拆除中'
    : isDamaged
      ? `已破坏 · 可修复至 Lv${repairTargetLevel}`
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
  } else if (isDamaged && !building && repairTargetLevel && repairCost) {
    upgradeBtn = (
      <Btn
        variant={canAfford(repairCost) ? 'primary' : 'default'}
        size="sm"
        disabled={!canAfford(repairCost)}
        title={!canAfford(repairCost) ? '修复所需资源不足' : `修复至 Lv${repairTargetLevel}`}
        onClick={async () => {
          await act(req('RepairBuilding', { slotId }), { okToast: `开始修复 ${info.name} 至 Lv${repairTargetLevel}` });
        }}
      >
        修复至 Lv{repairTargetLevel}
      </Btn>
    );
  } else if (isMax) {
    upgradeBtn = <Tag kind="gold">已满级</Tag>;
  } else if (building) {
    upgradeBtn = <Tag kind="ember">{isDamaged ? '修复中' : isBuild ? '建造中' : '升级中'}</Tag>;
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
      wide={showTreasureMgmt}
      foot={
        (!demolishing && (!isMax || isDamaged) && !building) ? (
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
      {!demolishing && !isDamaged && !isMax && nextCost && (
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
      {!demolishing && isDamaged && repairCost && repairTargetLevel && (
        <>
          <Divider />
          <div class="bld-upgrade-block">
            <span class="bld-upgrade-label">修复至 Lv{repairTargetLevel} 消耗（时间为累计建造时间的 1/3）</span>
            <CostRow cost={repairCost} timeSec={repairTimeSec} />
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
            label={isDamaged ? '修复进度' : isBuild ? '建造进度' : '升级进度'}
          />
        </>
      )}

      {/* Treasure management */}
      {showTreasureMgmt && (
        <>
          <Divider ornate />
          <SectionHead sub={kind === 'main' ? '主宝物栏 · 1格' : '主栏 + 备用栏'}>
            宝物管理
          </SectionHead>
          <TreasureMgmtSection kind={kind as 'main' | 'treasury'} />
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

  if (!kind) {
    showToast('找不到该建筑');
    return;
  }

  // Route special buildings
  if (kind === 'mercenarycamp') { openMercCamp(slotId); return; }
  if (kind === 'tradecenter') { openTradeCenter(slotId); return; }
  if (kind === 'academy') { openAcademy(slotId); return; }
  if (kind === 'alchemy') { openAlchemy(slotId); return; }
  if (kind === 'council') { openCouncil(slotId); return; }

  // Open generic detail modal
  openModal(
    (close) => <BuildingDetailModal slotId={slotId} close={close} />,
    'building',
  );
}
