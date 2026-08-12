/**
 * 村庄页：以场景为主的城市经营驾驶舱。
 * 列表视图保留为完整、可键盘访问的建筑管理入口。
 */
import { dataVersion, tick, villageView, setVillageView } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { buildingInfo } from '../../app/config.js';
import { Panel, SectionHead, TimerBar, Icon } from '../../ui/index.js';
import { VillageScene } from './VillageScene.js';
import { BuildingCard, EmptySlotCard } from './BuildingCard.js';
import { PopPanel } from './PopPanel.js';
import { TreasurePanel } from './TreasurePanel.js';
import { VillageCommandDeck } from './VillageCommandDeck.js';
import { TaskBar } from './TaskBar.js';

import '../../styles/village.css';

// ── Build queue strip ─────────────────────────────────────────────────────────

function QueueStrip({ queue }: { queue: any }) {
  tick.value; // for TimerBar

  if (!queue?.items?.length) return null;

  const items: any[] = queue.items;
  const cap: number = queue.capacity ?? 0;
  const free = Math.max(0, cap - items.length);

  return (
    <div class="vil-queue">
      <SectionHead sub={`${items.length}/${cap} · 空余 ${free}`}>建造队列</SectionHead>

      {/* Queue slot dots */}
      <div class="vil-queue-free" aria-hidden="true">
        {Array.from({ length: cap }, (_, i) => (
          <div key={i} class={`vil-queue-slot-dot${i < items.length ? ' used' : ''}`} />
        ))}
      </div>

      <div class="vil-queue-slots">
        {items.map((q: any, idx: number) => {
          const info = buildingInfo(q.kind);
          const verb = q.isNew ? '建造' : '升级';
          return (
            <Panel key={idx} variant="flat" class="vil-queue-item">
              <Icon icon={info.icon} label={info.name} size="sm" />
              <div class="vil-queue-body">
                <div class="vil-queue-name">
                  {info.name} → Lv{q.toLevel}
                </div>
                <div class="vil-queue-verb">{verb}</div>
                <TimerBar startAt={q.startAt} finishAt={q.finishAt} />
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

// ── List-view layout ──────────────────────────────────────────────────────────

function VillageListView({ vil }: { vil: any }) {
  const tc = vil.townCenter;
  const inner = vil.zones?.inner;
  const outer = vil.zones?.outer;
  const innerPlaced: any[] = inner?.placed ?? [];
  const outerPlaced: any[] = outer?.placed ?? [];
  const innerFree: number = inner?.freeSlots ?? 0;
  const outerFree: number = outer?.freeSlots ?? 0;

  return (
    <div class="vil-list">
      {/* Town centre */}
      {tc && (
        <div>
          <SectionHead>城镇中心</SectionHead>
          <div class="vil-zone-grid" style={{ gridTemplateColumns: '1fr' }}>
            <BuildingCard building={tc} isCenter />
          </div>
        </div>
      )}

      {/* Outer zone: resource fields */}
      <div>
        <SectionHead sub={`${outerPlaced.length}/${outer?.slots ?? 0}`}>
          城外 · 生产量产
        </SectionHead>
        <div class="vil-zone-grid">
          {outerPlaced.map((b: any) => <BuildingCard key={b.slotId} building={b} />)}
          {Array.from({ length: outerFree }, (_, i) => (
            <EmptySlotCard key={`outer-empty-${i}`} zone="outer" />
          ))}
        </div>
      </div>

      {/* Inner zone: civic / research */}
      <div>
        <SectionHead sub={`${innerPlaced.length}/${inner?.slots ?? 0}`}>
          城内 · 民生研发
        </SectionHead>
        <div class="vil-zone-grid">
          {innerPlaced.map((b: any) => <BuildingCard key={b.slotId} building={b} />)}
          {Array.from({ length: innerFree }, (_, i) => (
            <EmptySlotCard key={`inner-empty-${i}`} zone="inner" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── View toggle button group ──────────────────────────────────────────────────

function ViewToggle() {
  const view = villageView.value;
  return (
    <div class="vil-view-toggle" role="group" aria-label="视图切换">
      <button
        class={`vil-view-btn${view === 'scene' ? ' active' : ''}`}
        aria-pressed={view === 'scene'}
        onClick={() => setVillageView('scene')}
      >
        🗺 场景
      </button>
      <button
        class={`vil-view-btn${view === 'list' ? ' active' : ''}`}
        aria-pressed={view === 'list'}
        onClick={() => setVillageView('list')}
      >
        📋 列表
      </button>
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function VillageScreen() {
  dataVersion.value; // subscribe — re-renders when server data updates

  const vil = getCache().vil;
  if (!vil || !vil.zones) return <div class="loading">村庄数据加载中…</div>;

  const view = villageView.value;
  const hasQueue = !!(vil.queue?.items?.length);
  const hasTreasures = !!(getCache().treasures);

  return (
    <div class="vil-dashboard">
      <div class="vil-dashboard-main">
        <div class="vil-dashboard-head">
          <div>
            <span class="vil-eyebrow">VILLAGE OPERATIONS</span>
            <SectionHead actions={<ViewToggle />}>
              {view === 'scene' ? '村庄全景' : '村庄管理'}
            </SectionHead>
          </div>
        </div>

        {view === 'scene' ? <VillageScene vil={vil} /> : <VillageListView vil={vil} />}

        <div class="vil-dashboard-details">
          {hasQueue && (
            <Panel pad class="vil-queue-panel">
              <QueueStrip queue={vil.queue} />
            </Panel>
          )}

          <div class="vil-detail-grid">
            <section class="vil-detail-section">
              <SectionHead>人口 · 文明活力</SectionHead>
              <Panel pad>
                <PopPanel />
              </Panel>
            </section>

            {hasTreasures && (
              <section class="vil-detail-section">
                <SectionHead sub={`${(getCache().treasures?.codes?.length ?? 0)}/${getCache().treasures?.slots ?? 0}`}>
                  宝物栏
                </SectionHead>
                <Panel variant="flat" pad>
                  <TreasurePanel />
                </Panel>
              </section>
            )}

            <section class="vil-detail-section">
              <TaskBar />
            </section>
          </div>
        </div>
      </div>

      <VillageCommandDeck vil={vil} />
    </div>
  );
}
