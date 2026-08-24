/**
 * 统一训练面板。
 *
 * 训练建筑由服务端下发不透明句柄；客户端可选择本村哪一座建筑承接本批训练。
 */
import { useState } from 'preact/hooks';
import { dataVersion, tick } from '../../app/store.js';
import { getCache, interpolatePop, getPopState, liveResources } from '../../app/state.js';
import { buildingInfo, unitInfo, resourceKeys, unitCropPerHour } from '../../app/config.js';
import { formName } from '../../shared/ui/text.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import { openUnitDetail } from './UnitDetail.js';
import {
  IconPlate, Tag, Btn, CostRow, TimerBar, StatGrid, Stat, Empty, confirmDanger,
} from '../../ui/index.js';
import '../../styles/army.css';

export function TrainPanel() {
  dataVersion.value;
  tick.value;

  const army = getCache().army;
  const trainable: any[] = army?.trainable ?? [];
  const queues: any[] = army?.trainingQueues ?? [];
  const buildings: any[] = army?.trainingBuildings ?? [];
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | undefined>(buildings[0]?.buildingId);

  const setQty = (unitKey: string, value: number) => {
    setQtys((prev) => ({ ...prev, [unitKey]: Math.max(1, Math.floor(value)) }));
  };

  return (
    <div class="train-panel">
      <TrainingQueues queues={queues} trainable={trainable} />
      {buildings.length === 0
        ? <Empty title="暂无军事训练建筑" icon="⚔️">建设满足条件的军事建筑后可训练部队。</Empty>
        : <TrainingBuildingLayout
          buildings={buildings}
          trainable={trainable}
          qtys={qtys}
          selectedBuildingId={selectedBuildingId}
          onBuildingChange={setSelectedBuildingId}
          onQtyChange={(unitKey, value) => setQty(unitKey, value)}
        />}
    </div>
  );
}

function TrainingBuildingLayout({
  buildings,
  trainable,
  qtys,
  selectedBuildingId,
  onBuildingChange,
  onQtyChange,
}: {
  buildings: any[];
  trainable: any[];
  qtys: Record<string, number>;
  selectedBuildingId?: string;
  onBuildingChange: (buildingId: string) => void;
  onQtyChange: (unitKey: string, value: number) => void;
}) {
  const selected = buildings.find((building) => building.buildingId === selectedBuildingId) ?? buildings[0];
  const selectedUnits = trainable.filter((unit) => unit.buildingKind === selected.kind);
  const selectedQueue = selected.training;

  return (
    <div class="training-center">
      <div class="training-center__selector">
        <div class="training-center__heading">军事建筑</div>
        <div class="training-center__slots" role="listbox" aria-label="选择训练建筑">
          {buildings.map((building) => {
            const info = buildingInfo(building.kind);
            const training = building.training;
            const trainingName = training ? unitInfo(training.unit).name : '';
            const selectedHere = building.buildingId === selected.buildingId;
            return (
              <button
                key={building.buildingId}
                type="button"
                role="option"
                aria-selected={selectedHere}
                class={`training-center__slot${selectedHere ? ' training-center__slot--selected' : ''}`}
                onClick={() => onBuildingChange(building.buildingId)}
              >
                <IconPlate icon={info.icon ?? `bld_${building.kind}`} label={building.name} size="sm" plate="stone" lvl={building.level} />
                <span class="training-center__slot-copy">
                  <b>{building.name} Lv{building.level}</b>
                  <small>{building.busy ? `训练中：${trainingName} ×${fmt(Number(training?.remaining ?? 0))}` : '空闲'}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div class="training-center__panel">
        <div class="training-center__heading">
          {selected.name} Lv{selected.level}
          <small>{selectedQueue ? `正在训练：${unitInfo(selectedQueue.unit).name} ×${fmt(Number(selectedQueue.remaining ?? 0))}` : '可训练兵种'}</small>
        </div>
        {selectedUnits.length === 0
          ? <Empty title="暂无可训练兵种" icon="⚔️">该军事建筑当前没有可训练的兵种。</Empty>
          : (
            <div class="train-unit-list">
              {selectedUnits.map((unit) => (
                <TrainUnitRow
                  key={unit.key}
                  unit={unit}
                  qty={qtys[unit.key] ?? 1}
                  onQtyChange={(value) => onQtyChange(unit.key, value)}
                  buildingId={selected.buildingId}
                  buildingBusy={!!selected.busy}
                />
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

function TrainingQueues({ queues, trainable }: { queues: any[]; trainable: any[] }) {
  if (queues.length === 0) return null;
  return (
    <div class="train-queue-list">
      {queues.map((queue) => (
        <TrainQueueBanner key={queue.queueId} queue={queue} trainable={trainable} />
      ))}
    </div>
  );
}

function TrainQueueBanner({ queue, trainable }: { queue: any; trainable: any[] }) {
  const unit = trainable.find((entry) => entry.key === queue.unit);
  const info = unitInfo(queue.unit);
  const name = unit?.name ?? info.name;
  const trainSec = Number(unit?.trainSec ?? 0);
  const nextDoneAt = Number(queue.nextDoneAt);
  const startAt = Number.isFinite(nextDoneAt) && trainSec > 0 ? nextDoneAt - trainSec * 1000 : Date.now();

  async function cancelTraining() {
    const confirmed = await confirmDanger({
      title: `取消${name}训练`,
      body: '已产出的士兵会保留；尚未产出的兵力将取消，并返还对应人口和资源。',
      confirmText: '取消训练',
    });
    if (!confirmed) return;
    await act(
      req('CancelTraining', { queueId: queue.queueId }),
      { okToast: '训练已取消，尚未产出的兵力、人口和资源已返还' },
    );
  }

  return (
    <div class="train-queue-banner">
      <IconPlate icon={unit?.icon ?? info.icon} label={name} size="sm" plate="stone" />
      <div class="train-queue-banner__body">
        <div class="train-queue-banner__label">
          训练中：{name} ×{fmt(Number(queue.remaining ?? 0))}
        </div>
        {queue.buildingName && (
          <div class="train-queue-banner__building">
            建筑：{queue.buildingName}{queue.buildingLevel ? ` Lv${queue.buildingLevel}` : ''}
          </div>
        )}
        {Number.isFinite(nextDoneAt) && trainSec > 0 && (
          <TimerBar startAt={startAt} finishAt={nextDoneAt} label="下一个" kind="ember" />
        )}
        {Number(queue.remaining) > 1 && trainSec > 0 && (
          <div class="train-queue-banner__estimate">
            全部完成约需 {fmtSecDur(trainSec * Number(queue.remaining))}
          </div>
        )}
        <div class="train-queue-banner__action">
          <Btn size="sm" variant="danger" onClick={cancelTraining}>取消训练</Btn>
        </div>
      </div>
    </div>
  );
}

interface TrainUnitRowProps {
  unit: any;
  qty: number;
  onQtyChange: (value: number) => void;
  buildingId: string;
  buildingBusy: boolean;
}

function TrainUnitRow({ unit, qty, onQtyChange, buildingId, buildingBusy }: TrainUnitRowProps) {
  const unlocked = unit.unlocked !== false;
  const info = unitInfo(unit.key);
  const popCost = info.isMercenary ? 0 : info.popCost;
  const cropPerHour = unitCropPerHour(unit.key);
  const totalCost = buildTotalCost(unit.cost, qty);
  const totalPop = popCost * qty;
  const totalTrainSec = Number(unit.trainSec ?? 0) * qty;
  const disabledReason = unlocked ? getDisabledReason(unit, qty, totalCost, totalPop, buildingBusy) : null;
  const canTrain = unlocked && !disabledReason;
  const maxCount = unlocked ? calcMaxAffordable(unit, popCost) : 0;

  async function doTrain() {
    if (!canTrain) return;
    await act(
      req('TrainTroops', { unit: unit.key, count: qty, buildingId }),
      { okToast: `${unit.name} ×${qty} 训练已开始` },
    );
  }

  return (
    <div class={`train-unit-row${unlocked ? '' : ' train-unit-row--locked'}`}>
      <div
        class="train-unit-row__head"
        onClick={() => openUnitDetail(unit.key)}
        title={`查看 ${unit.name} 详细属性`}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => { if ((event as KeyboardEvent).key === 'Enter') openUnitDetail(unit.key); }}
        aria-label={`查看 ${unit.name} 详细属性`}
      >
        <IconPlate icon={unit.icon ?? info.icon} label={unit.name} size="md" plate="stone" />
        <div class="train-unit-row__info">
          <div class="train-unit-row__name">
            {unit.name}
            <Tag kind={unit.form === 'ranged' ? 'steel' : 'ember'}>{formName(unit.form)}</Tag>
          </div>
          <div class="train-unit-row__stats">
            <StatGrid>
              <Stat icon="ui_icon_atk" label="攻" value={Math.round(unit.form === 'ranged' ? unit.rangedAtk : unit.meleeAtk)} />
              <Stat icon="ui_icon_def" label="防" value={Math.round(unit.form === 'ranged' ? unit.rangedDef : unit.meleeDef)} />
              <Stat icon="ui_icon_speed" label="速" value={Math.round(unit.speed)} />
              {popCost > 0 && <Stat icon="ui_icon_pop" label="人口" value={popCost} />}
            </StatGrid>
          </div>
          {cropPerHour > 0 && <div class="train-unit-row__bonus">耗粮 {cropPerHour}/时·兵</div>}
        </div>
      </div>

      {!unlocked ? (
        <div class="train-unit-row__controls">
          <div class="train-warn train-warn--danger">🔒 {unit.lockReason ?? '尚未解锁'}</div>
        </div>
      ) : (
        <div class="train-unit-row__controls" onClick={(event) => event.stopPropagation()}>
          <CostRow cost={totalCost} timeSec={totalTrainSec} popCost={totalPop || null} />
          <div class="qty-row">
            <div class="qty-controls">
              <button type="button" aria-label="减少数量" onClick={() => onQtyChange(qty - 1)}>−</button>
              <input
                class="qty-input"
                type="number"
                min="1"
                max="9999"
                value={qty}
                aria-label="训练数量"
                onInput={(event) => {
                  const value = parseInt((event.currentTarget as HTMLInputElement).value, 10);
                  if (!Number.isNaN(value)) onQtyChange(value);
                }}
              />
              <button type="button" aria-label="增加数量" onClick={() => onQtyChange(qty + 1)}>+</button>
            </div>
            <div class="qty-presets">
              {[1, 10, 50].map((count) => (
                <Btn key={count} size="sm" variant="ghost" onClick={() => onQtyChange(count)}>×{count}</Btn>
              ))}
              {maxCount > 0 && (
                <Btn size="sm" variant="ghost" onClick={() => onQtyChange(maxCount)}>最多({fmt(maxCount)})</Btn>
              )}
            </div>
          </div>
          {disabledReason && (
            <div class={`train-warn${disabledReason.danger ? ' train-warn--danger' : ''}`}>{disabledReason.text}</div>
          )}
          <Btn variant="primary" block disabled={!canTrain} onClick={doTrain}>训练 {unit.name} ×{qty}</Btn>
        </div>
      )}
    </div>
  );
}

function buildTotalCost(cost: Record<string, number> | undefined, qty: number): Record<string, number> {
  const total: Record<string, number> = {};
  for (const key of resourceKeys()) {
    const amount = Number(cost?.[key] ?? 0);
    if (amount > 0) total[key] = Math.round(amount * qty);
  }
  return total;
}

interface DisabledReason { text: string; danger?: boolean }

function getDisabledReason(
  unit: any,
  qty: number,
  totalCost: Record<string, number>,
  totalPop: number,
  buildingBusy: boolean,
): DisabledReason | null {
  if (!unit.trainableNow) {
    return { text: unit.unavailableReason ? '当前没有空闲训练队列' : '当前无法开始训练' };
  }
  if (buildingBusy) return { text: '所选建筑正在训练，请切换到左侧空闲建筑' };

  const have = liveResources();
  if (Object.entries(totalCost).some(([key, amount]) => amount > 0 && (have[key] ?? 0) < amount)) {
    return { text: '资源不足', danger: true };
  }

  const pop = getPopState();
  if (!pop || totalPop <= 0) return null;
  const civilianPop = interpolatePop();
  if (civilianPop < totalPop) return { text: `人口不足：需 ${totalPop}，当前平民 ${fmt(civilianPop)}`, danger: true };
  const footprint = (pop.soldierPop ?? 0) + (pop.trainingPop ?? 0);
  const maxSoldier = (pop.mobilizeCap ?? 0) * (pop.totalPop ?? 0);
  if (footprint + totalPop > maxSoldier + 1e-9) {
    return { text: '已达动员上限，无法继续训练', danger: true };
  }
  if (pop.inFamine) return { text: '⚠️ 当前处于饥荒，人口正在减少，谨慎训练' };
  return null;
}

function calcMaxAffordable(unit: any, popCostPer: number): number {
  const have = liveResources();
  let max = 9999;
  for (const key of resourceKeys()) {
    const cost = Number(unit.cost?.[key] ?? 0);
    if (cost > 0) max = Math.min(max, Math.floor((have[key] ?? 0) / cost));
  }

  const pop = getPopState();
  if (pop && popCostPer > 0) {
    max = Math.min(max, Math.floor(interpolatePop() / popCostPer));
    const remaining = (pop.mobilizeCap ?? 0) * (pop.totalPop ?? 0) - (pop.soldierPop ?? 0) - (pop.trainingPop ?? 0);
    max = Math.min(max, Math.max(0, Math.floor(remaining / popCostPer)));
  }
  return Math.max(0, max);
}

function fmtSecDur(sec: number): string {
  return fmtDur(sec * 1000);
}
