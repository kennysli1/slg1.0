/**
 * Building card — list-view representation of a single placed building or empty slot.
 * Shows art, name, level badge, production rate, next-level CostRow, status tags, and upgrade button.
 */
import { tick, dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { buildingInfo } from '../../app/config.js';
import {
  Panel, IconPlate, Btn, Tag, CostRow, canAfford, TimerBar, confirmDanger,
} from '../../ui/index.js';
import { fmt } from '../../shared/utils/format.js';
import { openBuilding } from './BuildingModal.js';
import { openBuildModal } from './BuildModal.js';

export interface PlacedBuilding {
  slotId: string;
  kind: string;
  name: string;
  icon: string;
  level: number;
  maxLevel: number;
  nextCost: Record<string, number> | null;
  nextTimeSec: number | null;
  repairCost?: Record<string, number> | null;
  repairTimeSec?: number | null;
  repairTargetLevel?: number;
  damaged?: boolean;
  producing?: { ratePerHour: number } | null;
  popCapByLevel?: number[];
  building?: boolean;
  buildingStartAt?: number;
  buildingFinishAt?: number;
  demolishing?: boolean;
}

interface BuildingCardProps {
  building: PlacedBuilding;
  /** true for the town centre card */
  isCenter?: boolean;
}

export function BuildingCard({ building: b, isCenter }: BuildingCardProps) {
  tick.value; // for TimerBar updates
  dataVersion.value; // treasure reserve warning updates with TreasureChanged

  const info = buildingInfo(b.kind);
  const isConstructing = (b.level < 1) && !b.demolishing;
  const isDamaged = !!b.damaged || (!!b.repairTargetLevel && !b.demolishing);
  const isDemolishing = !!b.demolishing;
  const isBusy = !!b.building; // upgrading or constructing in progress
  const isMax = b.maxLevel > 0 && b.level >= b.maxLevel;
  const afford = canAfford(b.nextCost);

  const lvLabel = isDemolishing ? '拆除中'
    : isDamaged ? `已破坏 · 可修复至 Lv${b.repairTargetLevel}`
    : isConstructing ? '建造中'
    : `Lv${b.level}`;

  const repairAfford = canAfford(b.repairCost ?? null);
  const hasRepairRow = isDamaged && !isDemolishing && !isBusy && b.repairCost && b.repairTargetLevel;
  const hasCostRow = !isDemolishing && !isDamaged && !isConstructing && !isMax && !isBusy && b.nextCost;
  // 所有已落成/受损的非城镇中心建筑都在卡片上提供统一拆除入口。
  // 特殊建筑弹窗也保留各自管理内容；这里的入口避免玩家因弹窗路由而找不到拆除键。
  const canDemolish = !isCenter && !isDemolishing && !isBusy && !isConstructing
    && (b.level >= 1 || !!b.repairTargetLevel);
  const treasures = getCache().treasures as any;
  const reserveCount = (treasures?.treasuryReserve ?? []).length;
  const mainFree = isCenter
    ? Math.max(0, 1 - (treasures?.town?.length ?? 0))
    : b.kind === 'treasury'
      ? Math.max(0, (treasures?.treasury?.length ?? 0) < (treasures?.reserveSlots ?? treasures?.slotBreakdown?.treasury ?? 0) ? 1 : 0)
      : 0;
  const needsLoad = reserveCount > 0 && mainFree > 0 && (isCenter || b.kind === 'treasury');

  // Pop cap increment for next level (shown in cost row context)
  const bInfo = buildingInfo(b.kind);
  const nextPopCap = bInfo.popCapByLevel
    ? (bInfo.popCapByLevel[b.level] ?? 0)
    : (bInfo.popCapPerLevel ?? 0);
  const vaultProtection = b.kind === 'vault' && b.level > 0
    ? bInfo.vaultProtectionByLevel?.[b.level - 1]
    : undefined;

  return (
    <Panel
      variant={isCenter ? 'gold' : 'flat'}
      class={`vil-card${isCenter ? ' vil-card--center' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${b.name} ${lvLabel} — 点击查看详情`}
      onClick={() => openBuilding(b.slotId)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') openBuilding(b.slotId); }}
    >
      {/* Header: icon + name + level */}
      <div class="vil-card-head">
        <IconPlate
          icon={b.icon ?? info.icon}
          label={b.name}
          size={isCenter ? 'lg' : 'md'}
          plate={isCenter ? 'gold' : 'stone'}
          lvl={b.level > 0 ? b.level : undefined}
          maxed={isMax}
        />
        <div class="vil-card-info">
          <div class="vil-card-title">
            {b.name}
            {isMax && <Tag kind="gold">满级</Tag>}
            {needsLoad && <Tag kind="jade">备用宝物可装载</Tag>}
            {isDemolishing && <Tag kind="crimson">拆除中</Tag>}
            {isDamaged && <Tag kind="crimson">建筑受损</Tag>}
            {isConstructing && !isDamaged && <Tag kind="ember">建造中</Tag>}
            {isBusy && !isConstructing && !isDamaged && !isDemolishing && <Tag kind="ember">升级中</Tag>}
          </div>
          <div class="vil-card-meta">{lvLabel}{b.maxLevel ? ` / Lv${b.maxLevel}` : ''}</div>
          {b.producing && !isDemolishing && (
            <div class="vil-card-prod">+{b.producing.ratePerHour}/h</div>
          )}
          {vaultProtection && !isDemolishing && (
            <div class="vil-card-vault" aria-label="当前等级保险库保护量">
              保护：木材 {fmt(vaultProtection.wood)} · 泥土 {fmt(vaultProtection.clay)} · 钢铁 {fmt(vaultProtection.iron)} · 粮食 {fmt(vaultProtection.crop)} · 金币 {fmt(vaultProtection.gold)}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar if in-progress */}
      {isBusy && b.buildingStartAt && b.buildingFinishAt && (
        <div class="vil-card-progress" onClick={(e) => e.stopPropagation()}>
          <TimerBar
            startAt={b.buildingStartAt}
            finishAt={b.buildingFinishAt}
            label={isDemolishing ? '拆除' : isDamaged ? '修复' : isConstructing ? '建造' : '升级'}
            kind={isDemolishing ? 'crimson' : 'ember'}
          />
        </div>
      )}

      {/* Cost row */}
      {hasCostRow && (
        <div class="vil-card-foot" onClick={(e) => e.stopPropagation()}>
          <CostRow cost={b.nextCost} timeSec={b.nextTimeSec} popCost={nextPopCap > 0 ? nextPopCap : undefined} />
          <Btn
            size="sm"
            variant={afford ? 'primary' : 'default'}
            disabled={!afford}
            title={!afford ? '资源不足' : `升级至 Lv${b.level + 1}`}
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              await act(req('UpgradeBuilding', { slotId: b.slotId }), {
                okToast: `${b.name} 开始升级`,
              });
            }}
          >
            升级
          </Btn>
        </div>
      )}
      {hasRepairRow && (
        <div class="vil-card-foot" onClick={(e) => e.stopPropagation()}>
          <CostRow cost={b.repairCost!} timeSec={b.repairTimeSec ?? null} />
          <Btn
            size="sm"
            variant={repairAfford ? 'primary' : 'default'}
            disabled={!repairAfford}
            title={!repairAfford ? '修复所需资源不足' : `修复至 Lv${b.repairTargetLevel}`}
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              await act(req('RepairBuilding', { slotId: b.slotId }), {
                okToast: `${b.name} 开始修复至 Lv${b.repairTargetLevel}`,
              });
            }}
          >
            修复至 Lv{b.repairTargetLevel}
          </Btn>
        </div>
      )}
      {canDemolish && (
        <div class="vil-card-foot" onClick={(e) => e.stopPropagation()}>
          <Btn
            size="sm"
            variant="danger"
            title={`拆除${b.name}`}
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              const ok = await confirmDanger({
                title: `拆除${b.name}`,
                body: '整栋建筑会被完全拆除，不消耗也不返还资源；拆除开始后不可取消。',
                confirmText: '确认拆除',
              });
              if (!ok) return;
              await act(req('DemolishBuilding', { slotId: b.slotId }), { okToast: '拆除已开始' });
            }}
          >
            拆除建筑
          </Btn>
        </div>
      )}
    </Panel>
  );
}

/** Empty slot card — click to open build picker. */
export function EmptySlotCard({ zone }: { zone: 'inner' | 'outer' }) {
  return (
    <Panel
      variant="flat"
      class="vil-card vil-card-empty"
      role="button"
      tabIndex={0}
      aria-label="空槽 — 点击建造"
      onClick={() => openBuildModal(zone, 1)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') openBuildModal(zone, 1); }}
    >
      <div class="vil-card-empty-icon">＋</div>
      <div class="vil-card-empty-label">空槽 · 点击建造</div>
    </Panel>
  );
}
