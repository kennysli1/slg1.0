/**
 * 村庄页：以任务和建筑列表为主的村庄经营指挥台。
 * 村庄场景保留为独立组件，但不再占用村庄页首屏空间。
 */
import { useState } from 'preact/hooks';
import { dataVersion, playerTaskState, tab, taskStates, tick } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { me } from '../../api.js';
import { buildingInfo, unitInfo } from '../../app/config.js';
import { Panel, SectionHead, Tag, TimerBar, Icon } from '../../ui/index.js';
import { fmt } from '../../shared/utils/format.js';
import { BuildingCard, EmptySlotCard } from './BuildingCard.js';
import { PopPanel } from './PopPanel.js';
import { TreasurePanel } from './TreasurePanel.js';
import { VillageCommandDeck } from './VillageCommandDeck.js';
import { IncomingWarnings } from '../../shared/ui/IncomingWarnings.js';
import { VillageTaskSummary } from './VillageTaskSummary.js';
import { VillageCommandDock } from './VillageCommandDock.js';
import { VillageArmyManagement } from '../army/ArmyScreen.js';
import {
  readVillageWorkbenchPreferences,
  writeVillageWorkbenchPreferences,
  villageWorkbenchLayoutClass,
  toggleVillageWorkbench,
  type VillageWorkbenchPreferences,
} from './workbench-preferences.js';

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
        <SectionHead>{tc.name ?? '主基地'}</SectionHead>
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

function taskKindTag(type: string) {
  if (type === 'main') return <Tag kind="gold">主线</Tag>;
  if (type === 'side') return <Tag kind="ember">支线</Tag>;
  return <Tag kind="jade">日常</Tag>;
}

function taskStatus(task: any, source: 'active' | 'offer'): string {
  if (task?.failureReady) return '确认失败';
  if (task?.ready) return '待领取';
  if (task?.status === 'failed') return '已失败';
  if (source === 'offer' || task?.status === 'offered') return '可接取';
  return '进行中';
}

function taskProgress(task: any): string | null {
  const objective = task?.objective;
  if (objective?.kind === 'clear_camp' && Number.isFinite(Number(task?.campTotal))) {
    return `${Number(task.campCleared ?? 0)}/${Number(task.campTotal ?? 0)}`;
  }
  if (objective?.count != null && Number.isFinite(Number(task?.progress))) {
    return `${Math.min(Number(task.progress ?? 0), Number(objective.count))}/${Number(objective.count)}`;
  }
  return null;
}

function currentVillageTasks(villageId: string): Array<{ task: any; source: 'active' | 'offer' }> {
  const direct = taskStates.value[villageId];
  const aggregate = playerTaskState.value?.villages?.find((v: any) => v.villageId === villageId);
  const states = [direct, aggregate].filter(Boolean);
  const entries: Array<{ task: any; source: 'active' | 'offer' }> = [];
  const seen = new Set<string>();
  for (const state of states) {
    for (const task of state.active ?? []) {
      if (!task || task.scope === 'global' || (task.villageId && task.villageId !== villageId)) continue;
      const key = `${task.code ?? task.name}:${task.villageId ?? villageId}`;
      if (!seen.has(key)) { seen.add(key); entries.push({ task, source: 'active' }); }
    }
    for (const list of [state.offeredMain, state.offeredSide, state.offered]) {
      for (const task of list ?? []) {
        if (!task || task.scope === 'global' || (task.villageId && task.villageId !== villageId)) continue;
        const key = `${task.code ?? task.name}:${task.villageId ?? villageId}`;
        if (!seen.has(key)) { seen.add(key); entries.push({ task, source: 'offer' }); }
      }
    }
  }
  return entries.sort((a, b) => {
    const statusRank = (entry: { task: any; source: 'active' | 'offer' }) => entry.task.ready || entry.task.failureReady ? 0 : entry.source === 'active' ? 1 : 2;
    return statusRank(a) - statusRank(b) || (a.task.type ?? '').localeCompare(b.task.type ?? '');
  });
}

function VillageTaskShowcase({ villageId }: { villageId: string }) {
  dataVersion.value;
  playerTaskState.value;
  taskStates.value;
  const tasks = currentVillageTasks(villageId);

  return (
    <section class="empire-village-task-showcase" aria-label="当前村庄任务">
      <div class="empire-village-task-head">
        <div>
          <span>当前村事务</span>
          <strong>任务展示</strong>
        </div>
        <button type="button" onClick={() => { tab.value = 'tasks'; }}>任务簿 <span aria-hidden="true">↗</span></button>
      </div>
      {tasks.length > 0 ? (
        <div class="empire-village-task-list">
          {tasks.map(({ task, source }) => (
            <button
              type="button"
              class="empire-village-task-row"
              key={`${task.code ?? task.name}:${task.villageId ?? villageId}`}
              onClick={() => { tab.value = 'tasks'; }}
            >
              <span class="empire-village-task-row__name">
                {taskKindTag(task.type)}
                <strong>{task.name ?? task.code ?? '未命名任务'}</strong>
              </span>
              <span class="empire-village-task-row__meta">
                {taskProgress(task) && <small>{taskProgress(task)}</small>}
                <small>{taskStatus(task, source)}</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p class="empire-village-task-empty">当前村暂无任务，可在任务簿查看王国事务。</p>
      )}
    </section>
  );
}

/** 首屏仅保留进行中摘要，完整建造与训练在下方工作区。 */
function ActiveOperationsSummary({ vil }: { vil: any }) {
  dataVersion.value;
  const army = getCache().army;
  const trainingQueues: any[] = army?.trainingQueues ?? [];
  const buildItems: any[] = vil.queue?.items ?? [];
  const activeBuild = buildItems[0];
  const activeBuildInfo = activeBuild ? buildingInfo(activeBuild.kind) : null;
  const activeTraining = trainingQueues[0];
  const trainingName = activeTraining ? unitInfo(activeTraining.unit).name : '';

  return (
    <section class="empire-operations-summary" aria-label="当前村进行中事项">
      <SectionHead sub="建造、训练和预警会随当前操作村庄切换">进行中</SectionHead>
      <Panel variant="flat" pad>
        <div class="empire-operations-grid">
          <div class="empire-operation-item">
            <Icon icon={activeBuildInfo?.icon ?? 'ui_icon_time'} label="" decorative size="sm" />
            <div>
              <span>建造</span>
              <strong>{activeBuildInfo ? `${activeBuildInfo.name} · Lv${activeBuild.toLevel}` : '暂无建设工程'}</strong>
              <small>{activeBuildInfo ? `队列 ${buildItems.length}/${vil.queue?.capacity ?? 0}，完整队列在建筑与城务中查看` : '展开建筑与城务安排下一项工程'}</small>
            </div>
          </div>
          <div class="empire-operation-item">
            <Icon icon="ui_icon_def" label="" decorative size="sm" />
            <div>
              <span>训练</span>
              <strong>{activeTraining ? `${trainingName} · ${fmt(Number(activeTraining.count ?? 0))}` : '暂无训练队列'}</strong>
              <small>{activeTraining ? `共 ${trainingQueues.length} 项训练进行中，取消与兵种详情在军务工作区` : '展开军务工作区开始训练或调整驻军'}</small>
            </div>
          </div>
          <VillageTaskShowcase villageId={String(vil.id ?? me?.villageId ?? '')} />
        </div>
      </Panel>
    </section>
  );
}

function WorkspaceEntry({ id, eyebrow, title, summary, open, onToggle, utility }: {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  utility?: any;
}) {
  const contentId = `${id}-content`;
  return (
    <section id={id} class={`empire-workspace-entry${open ? ' is-open' : ''}`} aria-labelledby={`${id}-title`}>
      <Panel pad class="empire-workspace-panel">
        <div class="empire-workspace-topline">
          <div class="empire-workspace-copy">
            <span class="vil-eyebrow">{eyebrow}</span>
            <h2 id={`${id}-title`}>{title}</h2>
            <p>{summary}</p>
          </div>
          <div class="empire-workspace-actions">
            {utility}
            <button type="button" class="empire-workspace-toggle" aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
              <span>{open ? `收起${title}` : `展开${title}`}</span>
              <small>{open ? '回到首屏摘要' : '查看完整操作与详情'}</small>
              <i aria-hidden="true">⌄</i>
            </button>
          </div>
        </div>
      </Panel>
    </section>
  );
}

function WorkspaceContents({ id, labelledBy, children }: { id: string; labelledBy: string; children: any }) {
  return (
    <section id={id} class="empire-workspace-expanded" aria-labelledby={labelledBy}>
      <Panel pad class="empire-workspace-expanded-panel">
        <div class="empire-workspace-content">{children}</div>
      </Panel>
    </section>
  );
}

function VillageWorkbench({ vil, playerId, villageId }: { vil: any; playerId: string; villageId: string }) {
  const [preferences, setPreferences] = useState<VillageWorkbenchPreferences>(() => readVillageWorkbenchPreferences(playerId, villageId));
  const hasTreasures = !!getCache().treasures;
  // 主基地是发展阶段核心，不占用城内/城外建造格；总数口径只统计
  // 玩家可以规划的两类建筑格，避免把固定的主基地重复算进“已启用地块”。
  const innerUsed = vil.zones?.inner?.placed?.length ?? 0;
  const innerSlots = vil.zones?.inner?.slots ?? 0;
  const outerUsed = vil.zones?.outer?.placed?.length ?? 0;
  const outerSlots = vil.zones?.outer?.slots ?? 0;
  const placedCount = innerUsed + outerUsed;
  const slotCount = innerSlots + outerSlots;
  const toggleWorkspace = (field: keyof VillageWorkbenchPreferences) => {
    setPreferences((previous) => {
      const next = toggleVillageWorkbench(previous, field);
      writeVillageWorkbenchPreferences(playerId, villageId, next);
      return next;
    });
  };
  return (
    <div class="vil-dashboard empire-command-desk">
      <VillageCommandDock />
      <div class="vil-dashboard-task-wrap empire-task-banner"><IncomingWarnings /><VillageTaskSummary /></div>
      <ActiveOperationsSummary vil={vil} />
      <div class={`empire-workspace-layout empire-workspace-grid ${villageWorkbenchLayoutClass(preferences)}`}>
        <div class="empire-workspace-group">
          <WorkspaceEntry
            id="village-building-management"
            eyebrow="发展工作区"
            title="建筑与城务"
            summary={`城内 ${innerUsed}/${innerSlots}、城外 ${outerUsed}/${outerSlots}（合计 ${placedCount}/${slotCount}）已启用；主基地为固定核心不占格，建造、升级、修复、人口与宝物在这里统一管理。`}
            open={preferences.developmentOpen}
            onToggle={() => toggleWorkspace('developmentOpen')}
          />
          {preferences.developmentOpen && (
            <WorkspaceContents id="village-building-management-content" labelledBy="village-building-management-title">
              <div class="village-management-overview">
                <VillageCommandDeck vil={vil} />
                <section class="vil-detail-section village-management-population"><SectionHead>人口 · 文明活力</SectionHead><Panel pad><PopPanel /></Panel></section>
              </div>
              {vil.queue?.items?.length > 0 && <Panel pad class="vil-queue-panel empire-active-panel"><QueueStrip queue={vil.queue} /></Panel>}
              <VillageListView vil={vil} />
              {hasTreasures && <section class="vil-detail-section"><SectionHead sub={`${(getCache().treasures?.activeCodes?.length ?? 0)}/${getCache().treasures?.mainSlots ?? 0}`}>宝物栏</SectionHead><Panel variant="flat" pad><TreasurePanel /></Panel></section>}
            </WorkspaceContents>
          )}
        </div>
        <div class="empire-workspace-group">
          <WorkspaceEntry
            id="village-military-workbench"
            eyebrow="军务工作区"
            title="军务工作区"
            summary="训练、驻军、援军、防御与解散均归属当前村庄；展开后可直接执行完整操作。"
            open={preferences.militaryOpen}
            onToggle={() => toggleWorkspace('militaryOpen')}
          />
          {preferences.militaryOpen && (
            <WorkspaceContents id="village-military-workbench-content" labelledBy="village-military-workbench-title">
              <VillageArmyManagement />
            </WorkspaceContents>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function VillageScreen() {
  dataVersion.value; // subscribe — re-renders when server data updates

  const vil = getCache().vil;
  if (!vil || !vil.zones) return <div class="loading">村庄数据加载中…</div>;

  const playerId = String(me?.id ?? 'guest');
  const villageId = String(me?.villageId ?? vil.id ?? 'unknown');
  return <VillageWorkbench key={`${playerId}:${villageId}`} vil={vil} playerId={playerId} villageId={villageId} />;
}
