/**
 * 村庄可视化场景：手绘俯视底图 + 建筑按坐标坐在垫台上。
 *
 * 坐标模型在 `scene-layout.ts`（椭圆环 + 远近缩放），换底图只改那一份。
 * 交互：点建筑开详情弹窗、点空垫台开建造选择；键盘可 Tab 聚焦并回车触发。
 * 场景内只呈现即时城务反馈，完整可访问的建筑入口由列表视图保留。
 */
import { tick } from '../../app/store.js';
import { buildingInfo } from '../../app/config.js';
import { Icon } from '../../ui/index.js';
import { openBuilding } from './BuildingModal.js';
import { openBuildModal } from './BuildModal.js';
import type { PlacedBuilding } from './BuildingCard.js';
import { padPos, TOWN_CENTER_POS, type PadPos } from './scene-layout.js';

/** 已建成建筑的垫台。 */
function OccupiedPad({ building: b, pos, isCenter }: {
  building: PlacedBuilding;
  pos: PadPos;
  isCenter?: boolean;
}) {
  tick.value; // 建造中的状态环随心跳更新

  const info = buildingInfo(b.kind);
  const isDemolishing = !!b.demolishing;
  const isDamaged = !!b.damaged || (!!b.repairTargetLevel && !b.demolishing);
  const isBusy = !!b.building;
  const isMax = b.maxLevel > 0 && b.level >= b.maxLevel;
  const isNew = b.level < 1 && !isDemolishing && !isDamaged;

  return (
    <div
      class={`vil-pad${isCenter ? ' vil-pad--center' : ''}`}
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: `translate(-50%, -72%) scale(${pos.scale})`,
        zIndex: pos.z,
      }}
      role="button"
      tabIndex={0}
      aria-label={`${b.name} Lv${b.level} — 点击查看详情`}
      onClick={() => openBuilding(b.slotId)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') openBuilding(b.slotId); }}
    >
      <div class="vil-pad-inner">
        {isBusy && <div class={`vil-status-ring${isDemolishing ? ' vil-status-ring--demo' : ''}`} />}

        <span class={`vil-pad-art${isCenter ? ' vil-pad-art--center' : ''}`}>
          <Icon
            icon={b.icon ?? info.icon}
            label={b.name}
            size={isCenter ? '2xl' : 'xl'}
            class="vil-pad-icon"
          />

          {isNew ? <span class="vil-lvl">建造中</span>
            : isDemolishing ? <span class="vil-lvl vil-lvl--demo">拆除中</span>
              : isDamaged ? <span class="vil-lvl vil-lvl--demo">受损 Lv{b.level}</span>
              : <span class={`vil-lvl${isMax ? ' max' : ''}`}>Lv{b.level}</span>}
        </span>

        <div class="vil-tooltip">
          <b>{b.name}</b>
          {' · '}
          {isDemolishing ? '拆除中' : isDamaged ? `受损 · 可修复至 Lv${b.repairTargetLevel}` : isNew ? '建造中' : `Lv${b.level}${isMax ? '（满级）' : ` / ${b.maxLevel}`}`}
          {b.producing && !isDemolishing && <><br /><small>产出 +{b.producing.ratePerHour}/时</small></>}
          {isBusy && !isDemolishing && <><br /><small>{isDamaged ? '修复进行中' : '升级进行中'}</small></>}
        </div>
      </div>
    </div>
  );
}

/** 空垫台：轻微呼吸提示可建造。 */
function EmptyPad({ zone, pos, freeSlots, label }: {
  zone: 'inner' | 'outer';
  pos: PadPos;
  freeSlots: number;
  label: string;
}) {
  return (
    <div
      class="vil-pad vil-pad--empty"
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: `translate(-50%, -60%) scale(${pos.scale})`,
        zIndex: pos.z,
      }}
      role="button"
      tabIndex={0}
      aria-label={`${label}空地 — 点击建造`}
      onClick={() => openBuildModal(zone, freeSlots)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') openBuildModal(zone, freeSlots); }}
    >
      <div class="vil-pad-empty">＋</div>
      <div class="vil-tooltip"><b>空地</b> · {label}<br /><small>点击选择要建的建筑</small></div>
    </div>
  );
}

interface VillageSceneProps {
  vil: {
    townCenter: PlacedBuilding | null;
    zones: {
      inner: { slots: number; freeSlots: number; placed: PlacedBuilding[] };
      outer: { slots: number; freeSlots: number; placed: PlacedBuilding[] };
    };
  };
}

export function VillageScene({ vil }: VillageSceneProps) {
  const zones = [
    { key: 'outer' as const, label: '城外', z: vil.zones.outer },
    { key: 'inner' as const, label: '城内', z: vil.zones.inner },
  ];
  const queueItems: any[] = (vil as any).queue?.items ?? [];
  const totalFree = zones.reduce((sum, zone) => sum + (zone.z?.freeSlots ?? 0), 0);

  return (
    <div class="vil-scene-shell">
      <div class="vil-scene-caption">
        <span>城务态势</span>
        <strong>{queueItems.length ? `${queueItems.length} 项工程推进中` : totalFree ? `${totalFree} 块空地待规划` : '城建布局已满'}</strong>
      </div>
      <div class="vil-scene-wrap" aria-label="村庄全景">
        <div class="vil-scene-bg" aria-hidden="true" />
        <div class="vil-scene-vignette" aria-hidden="true" />
        <div class="vil-scene-status" aria-hidden="true">
          <span><b>{vil.zones.outer?.placed?.length ?? 0}</b> 生产设施</span>
          <span><b>{vil.zones.inner?.placed?.length ?? 0}</b> 城内设施</span>
          {queueItems.length > 0 && <span class="is-active"><b>{queueItems.length}</b> 建设中</span>}
        </div>

        {zones.map(({ key, label, z }) => {
          const placed = z?.placed ?? [];
          const free = z?.freeSlots ?? 0;
          const total = Math.max(z?.slots ?? 0, placed.length + free);
          return (
            <>
              {placed.map((b, i) => (
                <OccupiedPad key={b.slotId} building={b} pos={padPos(key, i, total)} />
              ))}
              {Array.from({ length: free }, (_, i) => (
                <EmptyPad
                  key={`${key}-empty-${i}`}
                  zone={key}
                  pos={padPos(key, placed.length + i, total)}
                  freeSlots={free}
                  label={label}
                />
              ))}
            </>
          );
        })}

        {/* 城镇中心画在最后：它在广场正中，要压在所有垫台之上 */}
        {vil.townCenter && (
          <OccupiedPad building={vil.townCenter} pos={TOWN_CENTER_POS} isCenter />
        )}
      </div>
    </div>
  );
}
