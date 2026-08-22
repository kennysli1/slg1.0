/**
 * 训练面板：嵌入村庄建筑详情弹窗。签名固定（跨特性接口）。
 *
 * 设计要点：
 *  - 数量输入用 useState，dataVersion bump 触发重渲时不重置（不失去焦点）
 *  - 数量 state 是 Record<unitKey, number>，全部单位共一份，互不干扰
 *  - "最多" 按钮尊重资源 + 人口 + 动员上限三重约束
 *  - 禁用按钮同时给出明确中文原因
 */
import { useState } from 'preact/hooks';
import { dataVersion } from '../../app/store.js';
import { getCache, interpolatePop, getPopState, liveResources } from '../../app/state.js';
import {
  unitInfo, resourceKeys, unitCropPerHour,
  trainTimeReducePerLevel, trainTimeReduceCap, trainCostReducePerLevel, trainCostReduceCap,
} from '../../app/config.js';
import { formName } from '../../shared/ui/text.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import { openUnitDetail } from './UnitDetail.js';
import {
  IconPlate, Tag, Btn, CostRow, TimerBar, StatGrid, Stat, Empty,
} from '../../ui/index.js';
import '../../styles/army.css';

/** 跨特性接口：从村庄建筑弹窗内嵌入。签名不可改。 */
export function TrainPanel({ slotId, kind: _kind, level }: { slotId: string; kind: string; level: number }) {
  dataVersion.value; // 订阅数据刷新

  const army = getCache().army;
  // 找到对应建筑实例的 slot（含独立队列和可训兵种列表）
  const slot = (army?.slots ?? []).find((s: any) => s.slotId === slotId);

  // 数量 state：key = unitKey → 数量。用 lazy init 从 slot 初始化为 1
  // 关键：用 useState 不是 signal，dataVersion 触发重渲时 state 保留不重置。
  const [qtys, setQtys] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const u of (slot?.trainable ?? [])) init[u.key] = 1;
    return init;
  });

  const setQty = (unitKey: string, val: number) => {
    const clamped = Math.max(1, Math.floor(val));
    setQtys((prev) => ({ ...prev, [unitKey]: clamped }));
  };

  if (!slot) {
    return (
      <Empty title="该建筑暂不提供训练" icon="⚔️">
        当前状态下无可训练兵种
      </Empty>
    );
  }

  // 建筑等级带来的提速 / 降费百分比（cap 限定）
  const lvl = level;
  const timePct = Math.round(Math.min(trainTimeCap(), Math.max(0, lvl - 1) * trainTimeReducePerLevel()) * 100);
  const costPct = Math.round(Math.min(trainCostCap(), Math.max(0, lvl - 1) * trainCostReducePerLevel()) * 100);
  const hasBuff = timePct > 0 || costPct > 0;

  return (
    <div class="train-panel">

      {/* 当前训练队列横幅 */}
      {slot.training && <TrainQueueBanner slot={slot} />}

      {/* 提速/降费说明 */}
      {hasBuff && (
        <div style="font-size: var(--f-xs); color: var(--c-jade); padding: 0 0 var(--s-1);">
          本建筑 Lv{lvl}：训练提速 {timePct}%，造价降低 {costPct}%（已计入以下造价）
        </div>
      )}

      {/* 兵种训练列表 */}
      {slot.trainable.length === 0
        ? <Empty title="暂无可训练兵种" icon="⚔️" />
        : (
          <div class="train-unit-list">
            {slot.trainable.map((u: any) => (
              <TrainUnitRow
                key={u.key}
                u={u}
                qty={qtys[u.key] ?? 1}
                slotId={slotId}
                queueBusy={!!slot.training}
                onQtyChange={(v) => setQty(u.key, v)}
              />
            ))}
          </div>
        )
      }
    </div>
  );
}

// ---------- 队列横幅 ----------

function TrainQueueBanner({ slot }: { slot: any }) {
  const tr = slot.training;
  const unitEntry = (slot.trainable ?? []).find((t: any) => t.key === tr.unit);
  const name = unitEntry?.name ?? tr.unit;
  const trainSec = (unitEntry?.trainSec ?? 30) * 1000;
  const startAt = tr.nextDoneAt - trainSec;

  async function cancelTraining() {
    await act(
      req('CancelTraining', { slotId: slot.slotId }),
      { okToast: '训练已取消，尚未产出的兵力和资源已返还' },
    );
  }

  return (
    <div class="train-queue-banner">
      <IconPlate
        icon={unitEntry?.icon ?? `unit_${tr.unit}`}
        label={name}
        size="sm"
        plate="stone"
      />
      <div class="train-queue-banner__body">
        <div class="train-queue-banner__label">
          训练中：{name} ×{tr.remaining}
          {tr.remaining > 1 && <span style="color: var(--c-ink-dim); font-weight: 400;">（每个 {fmtSecDur(unitEntry?.trainSec ?? 30)}）</span>}
        </div>
        <TimerBar startAt={startAt} finishAt={tr.nextDoneAt} label="下一个" kind="ember" />
        {tr.remaining > 1 && (
          <div style="font-size: var(--f-2xs); color: var(--c-ink-dim); margin-top: var(--s-1);">
            全部完成约需 {fmtSecDur((unitEntry?.trainSec ?? 30) * tr.remaining)}
          </div>
        )}
        <div style="margin-top: var(--s-2);">
          <Btn size="sm" variant="danger" onClick={cancelTraining}>取消训练</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------- 兵种训练行 ----------

interface TrainUnitRowProps {
  u: any;
  qty: number;
  slotId: string;
  queueBusy: boolean;
  onQtyChange: (v: number) => void;
}

function TrainUnitRow({ u, qty, slotId, queueBusy, onQtyChange }: TrainUnitRowProps) {
  const unlocked = u.unlocked !== false;
  const info = unitInfo(u.key);
  const popCost = info.isMercenary ? 0 : info.popCost;
  const cropPerHour = unitCropPerHour(u.key);

  // 总消耗（按数量）
  const totalCost: Record<string, number> = {};
  for (const k of resourceKeys()) {
    if (u.cost[k]) totalCost[k] = Math.round(u.cost[k] * qty);
  }
  const totalPop = popCost * qty;
  const totalTrainSec = u.trainSec * qty;

  // 校验：禁用原因（多条时只显示最高优先级）
  const disabledReason = unlocked ? getDisabledReason(u, qty, totalCost, totalPop, queueBusy) : null;
  const canTrain = unlocked && !disabledReason;

  // 最多可训数量
  const maxCount = unlocked ? calcMaxAffordable(u, popCost) : 0;

  async function doTrain() {
    if (!canTrain) return;
    await act(
      req('TrainTroops', { slotId, unit: u.key, count: qty }),
      { okToast: `${u.name} ×${qty} 训练已开始` },
    );
  }

  return (
    <div class={`train-unit-row${unlocked ? '' : ' train-unit-row--locked'}`}>
      {/* 头部：图标 + 名称，点击展开详情 */}
      <div
        class="train-unit-row__head"
        onClick={() => openUnitDetail(u.key)}
        title={`查看 ${u.name} 详细属性`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') openUnitDetail(u.key); }}
        aria-label={`查看 ${u.name} 详细属性`}
      >
        <IconPlate icon={u.icon ?? `unit_${u.key}`} label={u.name} size="md" plate="stone" />
        <div class="train-unit-row__info">
          <div class="train-unit-row__name">
            {u.name}
            <Tag kind={u.form === 'ranged' ? 'steel' : 'ember'}>{formName(u.form)}</Tag>
          </div>
          {/* 简要属性行 */}
          <div style="margin-top: var(--s-1);">
            <StatGrid>
              <Stat icon="ui_icon_atk" label="攻" value={Math.round(u.form === 'ranged' ? u.rangedAtk : u.meleeAtk)} />
              <Stat icon="ui_icon_def" label="防" value={Math.round(u.form === 'ranged' ? u.rangedDef : u.meleeDef)} />
              <Stat icon="ui_icon_speed" label="速" value={Math.round(u.speed)} />
              {popCost > 0 && <Stat icon="ui_icon_pop" label="人口" value={popCost} />}
            </StatGrid>
          </div>
          {cropPerHour > 0 && (
            <div class="train-unit-row__bonus">耗粮 {cropPerHour}/时·兵</div>
          )}
        </div>
      </div>

      {/* 未解锁：只显示锁定理由 */}
      {!unlocked && (
        <div class="train-unit-row__controls">
          <div class="train-warn train-warn--danger">🔒 {u.lockReason ?? '前置建筑未满足，尚未解锁'}</div>
        </div>
      )}

      {/* 已解锁：训练控件 */}
      {unlocked && (
        <div class="train-unit-row__controls" onClick={(e) => e.stopPropagation()}>
          {/* 造价预览（总量，随数量变化） */}
          <CostRow cost={totalCost} timeSec={totalTrainSec} popCost={totalPop || null} />

          {/* 数量选择行 */}
          <div class="qty-row">
            <div class="qty-controls">
              <button
                type="button"
                aria-label="减少数量"
                onClick={() => onQtyChange(qty - 1)}
              >−</button>
              <input
                class="qty-input"
                type="number"
                min="1"
                max="9999"
                value={qty}
                aria-label="训练数量"
                onInput={(e) => {
                  const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  if (!isNaN(v)) onQtyChange(v);
                }}
              />
              <button
                type="button"
                aria-label="增加数量"
                onClick={() => onQtyChange(qty + 1)}
              >+</button>
            </div>

            {/* 快捷数量 */}
            <div class="qty-presets">
              {[1, 10, 50].map((n) => (
                <Btn key={n} size="sm" variant="ghost" onClick={() => onQtyChange(n)}>×{n}</Btn>
              ))}
              {maxCount > 0 && (
                <Btn size="sm" variant="ghost" onClick={() => onQtyChange(maxCount)}
                  title="资源/人口/动员上限综合可训最大数量">
                  最多({fmt(maxCount)})
                </Btn>
              )}
            </div>
          </div>

          {/* 警告提示 */}
          {disabledReason && (
            <div class={`train-warn${disabledReason.danger ? ' train-warn--danger' : ''}`}>
              {disabledReason.text}
            </div>
          )}

          {/* 训练按钮 */}
          <Btn
            variant="primary"
            block
            disabled={!canTrain}
            onClick={doTrain}
          >
            训练 {u.name} ×{qty}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ---------- 辅助函数 ----------

function trainTimeCap() { return trainTimeReduceCap(); }
function trainCostCap() { return trainCostReduceCap(); }

interface DisabledReason { text: string; danger?: boolean }

function getDisabledReason(
  u: any,
  qty: number,
  totalCost: Record<string, number>,
  totalPop: number,
  queueBusy: boolean,
): DisabledReason | null {
  if (queueBusy) return { text: '该建筑队列已有训练任务，请等当前批次完成' };

  const have = liveResources();
  for (const [k, v] of Object.entries(totalCost)) {
    if (v > 0 && (have[k] ?? 0) < v) {
      return { text: `资源不足（${k} 缺 ${fmt(Math.ceil(v - (have[k] ?? 0)))}）`, danger: true };
    }
  }

  const ps = getPopState();
  if (ps && totalPop > 0) {
    const civilianPop = interpolatePop();
    if (civilianPop < totalPop) {
      return { text: `人口不足：需 ${totalPop}，当前平民 ${fmt(civilianPop)}`, danger: true };
    }
    const footprint = (ps.soldierPop ?? 0) + (ps.trainingPop ?? 0);
    const maxSoldier = (ps.mobilizeCap ?? 0) * (ps.totalPop ?? 0);
    if (footprint + totalPop > maxSoldier + 1e-9) {
      return {
        text: `已达动员上限（${Math.round((ps.mobilizeCap ?? 0) * 100)}%）：`
          + `士兵足迹 ${fmt(Math.round(footprint + totalPop))} / 上限 ${fmt(Math.round(maxSoldier))}`,
        danger: true,
      };
    }
    if (ps.inFamine) {
      return { text: '⚠️ 当前处于饥荒，人口正在减少，谨慎训练' };
    }
  }
  return null;
}

/** 按资源 + 人口 + 动员上限计算可训最大数量。 */
function calcMaxAffordable(u: any, popCostPer: number): number {
  const have = liveResources();
  let max = 9999;

  for (const k of resourceKeys()) {
    if (u.cost[k] > 0) max = Math.min(max, Math.floor((have[k] ?? 0) / u.cost[k]));
  }

  const ps = getPopState();
  if (ps && popCostPer > 0) {
    const civilianPop = interpolatePop();
    max = Math.min(max, Math.floor(civilianPop / popCostPer));

    const footprint = (ps.soldierPop ?? 0) + (ps.trainingPop ?? 0);
    const maxSoldier = (ps.mobilizeCap ?? 0) * (ps.totalPop ?? 0);
    const remaining = maxSoldier - footprint;
    if (remaining > 0) max = Math.min(max, Math.floor(remaining / popCostPer));
    else max = 0;
  }

  return Math.max(0, max);
}

/** 秒 → 时长文案。统一走共享的 fmtDur（收毫秒），不在各页重复实现。 */
function fmtSecDur(sec: number): string {
  return fmtDur(sec * 1000);
}
