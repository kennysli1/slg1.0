/**
 * 村庄驾驶舱的上下文指挥区。
 * 它只汇总既有快照，不拥有状态；建造和建筑详情仍走既有弹窗契约。
 */
import { dataVersion, tick } from '../../app/store.js';
import { getCache, getPopState, interpolateTotalPop } from '../../app/state.js';
import { buildingInfo } from '../../app/config.js';
import { Icon, Panel, TimerBar } from '../../ui/index.js';
import { openBuilding } from './BuildingModal.js';
import { openBuildModal } from './BuildModal.js';

interface VillageCommandDeckProps {
  vil: any;
}

function DeckAction({ icon, label, detail, onClick, href }: {
  icon: string;
  label: string;
  detail: string;
  onClick?: () => void;
  href?: string;
}) {
  const content = (
    <>
      <Icon icon={icon} label="" size="sm" />
      <span class="vil-deck-action-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span class="vil-deck-action-arrow" aria-hidden="true">›</span>
    </>
  );
  if (href) return <a class="vil-deck-action" href={href}>{content}</a>;
  return <button class="vil-deck-action" type="button" onClick={onClick}>{content}</button>;
}

export function VillageCommandDeck({ vil }: VillageCommandDeckProps) {
  dataVersion.value;
  tick.value;

  const queueItems: any[] = vil.queue?.items ?? [];
  const queueCap = vil.queue?.capacity ?? 0;
  const inner = vil.zones?.inner;
  const outer = vil.zones?.outer;
  const freeInner = inner?.freeSlots ?? 0;
  const freeOuter = outer?.freeSlots ?? 0;
  const totalFree = freeInner + freeOuter;
  const pop = getPopState();
  const totalPop = interpolateTotalPop();
  const treasures = getCache().treasures;
  const treasureCount = treasures?.activeCodes?.length ?? 0;
  const treasureSlots = treasures?.mainSlots ?? 0;
  const activeTask = queueItems[0];
  const activeInfo = activeTask ? buildingInfo(activeTask.kind) : null;

  const buildZone = freeInner > 0 ? 'inner' : 'outer';
  const buildSlots = buildZone === 'inner' ? freeInner : freeOuter;

  return (
    <aside class="vil-deck" aria-label="村庄指挥区">
      <Panel variant="gold" corners pad class="vil-deck-panel">
        <div class="vil-deck-kicker">当前决策</div>
        <div class="vil-deck-title-row">
          <div>
            <h2>村庄指挥台</h2>
            <p>{activeTask ? '建造序列正在推进' : totalFree > 0 ? '仍有空地可扩张' : '所有地块均已启用'}</p>
          </div>
          <span class={`vil-deck-signal${activeTask ? ' is-busy' : ''}`} aria-label={activeTask ? '建设进行中' : '村庄状态稳定'} />
        </div>

        <div class="vil-deck-summary" aria-label="村庄摘要">
          <div>
            <span>人口</span>
            <strong>{totalPop}<small> / {pop?.hardCap ?? '—'}</small></strong>
          </div>
          <div>
            <span>空地</span>
            <strong>{totalFree}<small> 块</small></strong>
          </div>
          <div>
            <span>宝物</span>
            <strong>{treasureCount}<small> / {treasureSlots}</small></strong>
          </div>
        </div>

        <div class="vil-deck-focus" aria-live="polite">
          {activeTask && activeInfo ? (
            <>
              <div class="vil-deck-focus-head">
                <Icon icon={activeInfo.icon} label={activeInfo.name} size="sm" />
                <div>
                  <span>当前工程</span>
                  <strong>{activeInfo.name} · Lv{activeTask.toLevel}</strong>
                </div>
              </div>
              <TimerBar startAt={activeTask.startAt} finishAt={activeTask.finishAt} />
              {queueItems.length > 1 && <small>后续还有 {queueItems.length - 1} 项工程待执行</small>}
            </>
          ) : (
            <>
              <div class="vil-deck-focus-head">
                <Icon icon={totalFree > 0 ? 'ui_icon_pop' : 'ui_icon_time'} label="" size="sm" />
                <div>
                  <span>城务提示</span>
                  <strong>{totalFree > 0 ? `可规划 ${totalFree} 块新地` : '可查看已建建筑的发展空间'}</strong>
                </div>
              </div>
              <small>{totalFree > 0 ? '优先补齐生产与民生设施，让村庄持续运转。' : '从建筑清单进入任意建筑，安排下一次升级。'}</small>
            </>
          )}
        </div>

        <div class="vil-deck-actions">
          {totalFree > 0 && (
            <DeckAction
              icon="ui_icon_pop"
              label="规划新建筑"
              detail={buildZone === 'inner' ? '城内民生与军务' : '城外资源生产'}
              onClick={() => openBuildModal(buildZone, buildSlots)}
            />
          )}
          {vil.townCenter && (
            <DeckAction
              icon={vil.townCenter.icon ?? buildingInfo(vil.townCenter.kind).icon}
              label={vil.townCenter.name ?? '主基地'}
              detail={`Lv${vil.townCenter.level} · 发展阶段核心`}
              onClick={() => openBuilding(vil.townCenter.slotId)}
            />
          )}
          <DeckAction
            icon="ui_icon_time"
            label="建筑清单"
            detail={`${queueItems.length}/${queueCap} 项工程 · 右侧集中管理`}
            href="#village-building-management"
          />
        </div>
      </Panel>
    </aside>
  );
}
