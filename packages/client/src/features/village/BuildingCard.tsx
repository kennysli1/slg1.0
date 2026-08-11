/**
 * Building card — list-view representation of a single placed building or empty slot.
 * Shows art, name, level badge, production rate, next-level CostRow, status tags, and upgrade button.
 */
import { tick } from '../../app/store.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { buildingInfo } from '../../app/config.js';
import {
  Panel, IconPlate, Btn, Tag, CostRow, canAfford, TimerBar,
} from '../../ui/index.js';
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

  const info = buildingInfo(b.kind);
  const isConstructing = (b.level < 1) && !b.demolishing;
  const isDemolishing = !!b.demolishing;
  const isBusy = !!b.building; // upgrading or constructing in progress
  const isMax = b.maxLevel > 0 && b.level >= b.maxLevel;
  const afford = canAfford(b.nextCost);

  const lvLabel = isDemolishing ? '拆除中'
    : isConstructing ? '建造中'
    : `Lv${b.level}`;

  const hasCostRow = !isDemolishing && !isConstructing && !isMax && !isBusy && b.nextCost;

  // Pop cap increment for next level (shown in cost row context)
  const bInfo = buildingInfo(b.kind);
  const nextPopCap = bInfo.popCapByLevel
    ? (bInfo.popCapByLevel[b.level] ?? 0)
    : (bInfo.popCapPerLevel ?? 0);

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
            {isDemolishing && <Tag kind="crimson">拆除中</Tag>}
            {isConstructing && <Tag kind="ember">建造中</Tag>}
            {isBusy && !isConstructing && !isDemolishing && <Tag kind="ember">升级中</Tag>}
          </div>
          <div class="vil-card-meta">{lvLabel}{b.maxLevel ? ` / Lv${b.maxLevel}` : ''}</div>
          {b.producing && !isDemolishing && (
            <div class="vil-card-prod">+{b.producing.ratePerHour}/h</div>
          )}
        </div>
      </div>

      {/* Progress bar if in-progress */}
      {isBusy && b.buildingStartAt && b.buildingFinishAt && (
        <div class="vil-card-progress" onClick={(e) => e.stopPropagation()}>
          <TimerBar
            startAt={b.buildingStartAt}
            finishAt={b.buildingFinishAt}
            label={isDemolishing ? '拆除' : isConstructing ? '建造' : '升级'}
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
