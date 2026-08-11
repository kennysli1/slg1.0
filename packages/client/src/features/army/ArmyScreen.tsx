/**
 * 军队页：驻军 / 训练队列 / 铁匠锻造 / 解散。
 *
 * 分区设计：
 *  § 1  驻军（Garrison）
 *       - 按 form 分组：近战（melee）/ 远程（ranged）
 *       - 雇佣兵独立区块（金色高亮，无人口耗粮）
 *       - 汇总条：总兵数 / 总攻 / 总防 / 总耗粮 / 宝物携带上限
 *  § 2  训练队列（正在练兵的建筑，点击→openBuilding）
 *  § 3  铁匠锻造（SmithyPanel）
 *  § 4  解散部队（非雇佣兵）
 *
 * 驻军分组选择理由：
 *  form（melee/ranged）是兵种唯一的战术分类字段。按 form 分组可以直观地
 *  看出近战与远程的兵力比例，这在攻守决策中最有实用价值。骑兵/攻城兵
 *  目前在 form 层面均归为 melee，与步兵共组，等未来有专属 category 字段
 *  时再细分。雇佣兵因无人口/耗粮消耗，单独成区并使用金色样式区分。
 */
import { useState } from 'preact/hooks';
import { dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { openModal } from '../../app/store.js';
import {
  unitInfo, mercenaryInfo, treasureCarryCap, unitCropPerHour,
} from '../../app/config.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { fmt } from '../../shared/utils/format.js';
import { openBuilding } from '../village/BuildingModal.js';
import { openUnitDetail } from './UnitDetail.js';
import { SmithyPanel } from './SmithyPanel.js';
import {
  Panel, SectionHead, Divider, Empty, Btn, Tag,
  Icon, IconPlate, TimerBar, Stat, Modal,
} from '../../ui/index.js';
import '../../styles/army.css';

export function ArmyScreen() {
  dataVersion.value; // 订阅快照刷新

  const army = getCache().army;
  if (!army) {
    return (
      <div class="army-page">
        <Empty icon="⚔️" title="加载中…">正在获取军队数据</Empty>
      </div>
    );
  }

  return (
    <div class="army-page">
      <GarrisonSection army={army} />
      <TrainingQueuesSection army={army} />
      <SmithySection army={army} />
      <DisbandSection army={army} />
    </div>
  );
}

// ============================================================
// § 1  驻军
// ============================================================

function GarrisonSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const trainable: any[] = army.trainable ?? [];

  const entries = Object.entries(troops).filter(([, n]) => (n as number) > 0);
  const regEntries = entries.filter(([k]) => !unitInfo(k).isMercenary);
  const mercEntries = entries.filter(([k]) => unitInfo(k).isMercenary);

  const meleeEntries = regEntries.filter(([k]) => unitInfo(k).form === 'melee');
  const rangedEntries = regEntries.filter(([k]) => unitInfo(k).form === 'ranged');
  const otherEntries = regEntries.filter(([k]) => {
    const form = unitInfo(k).form;
    return form !== 'melee' && form !== 'ranged';
  });

  // 汇总数值
  const totalTroops = entries.reduce((s, [, n]) => s + (n as number), 0);
  const totalRegTroops = regEntries.reduce((s, [, n]) => s + (n as number), 0);

  let totalAtk = 0;
  let totalDef = 0;
  let totalCrop = 0;
  for (const [key, count] of entries) {
    const info = unitInfo(key);
    const t = trainable.find((u: any) => u.key === key);
    const merc = mercenaryInfo(key);
    if (t) {
      totalAtk += (t.form === 'ranged' ? t.rangedAtk : t.meleeAtk) * (count as number);
      totalDef += (t.form === 'ranged' ? t.rangedDef : t.meleeDef) * (count as number);
    } else if (merc) {
      totalAtk += (merc.form === 'ranged' ? merc.rangedAtk : merc.meleeAtk) * (count as number);
      totalDef += (merc.form === 'ranged' ? merc.rangedDef : merc.meleeDef) * (count as number);
    }
    if (!info.isMercenary) totalCrop += unitCropPerHour(key) * (count as number);
  }
  const carryCap = treasureCarryCap(totalRegTroops);

  return (
    <Panel pad>
      <SectionHead sub={`${tribeName(army.tribe)}族 · 点击兵种查看属性`}>
        驻军
      </SectionHead>

      {/* 汇总条 */}
      {totalTroops > 0 && (
        <div class="army-summary">
          <Stat icon="ui_icon_atk" label="总攻击" value={fmt(Math.round(totalAtk))} />
          <Stat icon="ui_icon_def" label="总防御" value={fmt(Math.round(totalDef))} />
          <Stat icon="ui_icon_pop" label="总兵数" value={fmt(totalTroops)} />
          <Stat icon="ui_icon_upkeep" label="总耗粮/时" value={fmt(Math.round(totalCrop))} />
          <Stat icon="trs_" label="宝物携带" value={`${carryCap} 格`}
            title={`携带上限 = floor(正规军兵力 / 每格兵力数)，上限 ${carryCap}`} />
        </div>
      )}

      {/* 近战区 */}
      {meleeEntries.length > 0 && (
        <>
          <div style="font-size: var(--f-xs); color: var(--c-ink-dim); padding: var(--s-2) 0 var(--s-1);">
            近战部队
          </div>
          <div class="unit-grid">
            {meleeEntries.map(([key, count]) => (
              <UnitCard key={key} unitKey={key} count={count as number} trainable={trainable} />
            ))}
          </div>
        </>
      )}

      {/* 远程区 */}
      {rangedEntries.length > 0 && (
        <>
          <div style="font-size: var(--f-xs); color: var(--c-ink-dim); padding: var(--s-2) 0 var(--s-1);">
            远程部队
          </div>
          <div class="unit-grid">
            {rangedEntries.map(([key, count]) => (
              <UnitCard key={key} unitKey={key} count={count as number} trainable={trainable} />
            ))}
          </div>
        </>
      )}

      {/* 其他（form 既不是 melee 也不是 ranged） */}
      {otherEntries.length > 0 && (
        <>
          <div style="font-size: var(--f-xs); color: var(--c-ink-dim); padding: var(--s-2) 0 var(--s-1);">
            其他部队
          </div>
          <div class="unit-grid">
            {otherEntries.map(([key, count]) => (
              <UnitCard key={key} unitKey={key} count={count as number} trainable={trainable} />
            ))}
          </div>
        </>
      )}

      {/* 无正规军 */}
      {regEntries.length === 0 && (
        <Empty icon="⚔️" title="暂无驻军">前往村庄军事建筑开始训练</Empty>
      )}

      {/* 雇佣兵区 */}
      {mercEntries.length > 0 && (
        <>
          <Divider ornate />
          <SectionHead sub="金币招募 · 永久持有 · 不耗粮不占人口">
            雇佣兵
          </SectionHead>
          <div class="unit-grid">
            {mercEntries.map(([key, count]) => (
              <UnitCard key={key} unitKey={key} count={count as number} trainable={trainable} isMerc />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function UnitCard({ unitKey, count, trainable, isMerc = false }: {
  unitKey: string;
  count: number;
  trainable: any[];
  isMerc?: boolean;
}) {
  const info = unitInfo(unitKey);
  const t = trainable.find((u: any) => u.key === unitKey);
  const merc = mercenaryInfo(unitKey);
  const name = t?.name ?? info.name;
  const cropPerHour = isMerc ? 0 : unitCropPerHour(unitKey);
  const form = t?.form ?? merc?.form ?? info.form;

  return (
    <div
      class={`unit-card${isMerc ? ' unit-card--merc' : ''}`}
      onClick={() => openUnitDetail(unitKey)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') openUnitDetail(unitKey); }}
      title={`${name} — 点击查看属性`}
      aria-label={`${name}，数量 ${count}，点击查看属性`}
    >
      <IconPlate
        icon={info.icon ?? `unit_${unitKey}`}
        label={name}
        size="lg"
        plate={isMerc ? 'gold' : 'stone'}
      />
      <div class="unit-card__count">{fmt(count)}</div>
      <div class="unit-card__name">{name}</div>
      <Tag kind={form === 'ranged' ? 'steel' : 'ember'}>{formName(form)}</Tag>
      {cropPerHour > 0 && (
        <div class="unit-card__upkeep">{cropPerHour}/时·兵</div>
      )}
    </div>
  );
}

// ============================================================
// § 2  训练队列
// ============================================================

function TrainingQueuesSection({ army }: { army: any }) {
  const slots: any[] = (army.slots ?? []).filter((s: any) => s.training);
  if (slots.length === 0) return null;

  return (
    <Panel pad>
      <SectionHead sub="正在练兵的军事建筑 · 点击查看详情">训练队列</SectionHead>
      <div class="train-q-list">
        {slots.map((s: any) => <TrainQueueCard key={s.slotId} slot={s} />)}
      </div>
    </Panel>
  );
}

function TrainQueueCard({ slot }: { slot: any }) {
  const tr = slot.training;
  const trainable: any[] = slot.trainable ?? [];
  const unitEntry = trainable.find((u: any) => u.key === tr.unit);
  const unitName = unitEntry?.name ?? tr.unit;
  const bldName = buildingName(slot.kind);

  const trainSec = (unitEntry?.trainSec ?? 30) * 1000;
  const startAt = tr.nextDoneAt - trainSec;
  const totalEtaMs = (unitEntry?.trainSec ?? 30) * 1000 * tr.remaining;

  return (
    <div
      class="train-q-card"
      onClick={() => openBuilding(slot.slotId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') openBuilding(slot.slotId); }}
      aria-label={`${bldName} Lv${slot.level}，正在训练 ${unitName}，点击查看详情`}
    >
      <IconPlate
        icon={bldIcon(slot.kind)}
        label={bldName}
        size="md"
        plate="stone"
        lvl={slot.level}
      />
      <div class="train-q-card__body">
        <div class="train-q-card__title">
          {bldName}
          <span class="lvl">Lv{slot.level}</span>
          <span style="color: var(--c-ink-dim); font-weight: 400; font-size: var(--f-xs);">详情 ›</span>
        </div>
        <div class="train-q-card__unit">
          🎯 {unitName} ×{tr.remaining}
        </div>
        <TimerBar startAt={startAt} finishAt={tr.nextDoneAt} label="下一个" kind="ember" />
        {tr.remaining > 1 && (
          <div class="train-q-hint">
            全部完成约 {fmtMsTotal(totalEtaMs)} 后
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// § 3  铁匠锻造
// ============================================================

function SmithySection({ army }: { army: any }) {
  const trainable: any[] = army.trainable ?? [];
  if (trainable.length === 0) return null;

  return (
    <Panel pad>
      <SectionHead sub="提升全军攻防 · 消耗木材 + 泥土">锻造</SectionHead>
      <SmithyPanel />
    </Panel>
  );
}

// ============================================================
// § 4  解散
// ============================================================

function DisbandSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const entries = Object.entries(troops).filter(([k, n]) =>
    (n as number) > 0 && !unitInfo(k).isMercenary,
  );
  if (entries.length === 0) return null;

  return (
    <Panel pad variant="danger">
      <SectionHead sub="解散即时返还人口，但资源不返还；出征中的部队无法解散">解散部队</SectionHead>
      <div class="disband-section">
        <div class="disband-hint">
          解散后人口立即返还（可重新用于训练），但训练耗费的木/泥/铁/粮均不退回。
          出征中的军队不可解散，请等待回村后操作。
        </div>
        {entries.map(([key, count]) => (
          <DisbandRow key={key} unitKey={key} totalCount={count as number} army={army} />
        ))}
      </div>
    </Panel>
  );
}

function DisbandRow({ unitKey, totalCount, army }: {
  unitKey: string;
  totalCount: number;
  army: any;
}) {
  const [cnt, setCnt] = useState(totalCount);
  const info = unitInfo(unitKey);
  const t = (army.trainable ?? []).find((u: any) => u.key === unitKey);
  const name = t?.name ?? info.name;
  const popCostPer = info.popCost ?? 1;
  const safeCount = Math.max(1, Math.min(totalCount, cnt));

  function confirmDisband() {
    openModal((close) => (
      <DisbandConfirmModal
        unitKey={unitKey}
        name={name}
        count={safeCount}
        popReturn={popCostPer * safeCount}
        onClose={close}
      />
    ), 'disband-confirm');
  }

  return (
    <div class="disband-row">
      <IconPlate
        icon={info.icon ?? `unit_${unitKey}`}
        label={name}
        size="sm"
        plate="stone"
      />
      <div class="disband-row__info">
        <div class="disband-row__name">{name}</div>
        <div class="disband-row__count">驻守 ×{fmt(totalCount)}</div>
      </div>
      <div class="disband-row__controls">
        <input
          class="disband-input"
          type="number"
          min={1}
          max={totalCount}
          value={cnt}
          aria-label={`解散 ${name} 数量`}
          onInput={(e) => {
            const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
            if (!isNaN(v)) setCnt(Math.max(1, Math.min(totalCount, v)));
          }}
        />
        <div class="disband-row__pop">
          返还人口 <b>+{fmt(popCostPer * safeCount)}</b>
        </div>
        <Btn
          variant="danger"
          size="sm"
          onClick={confirmDisband}
        >
          解散
        </Btn>
      </div>
    </div>
  );
}

// ---------- 解散确认弹窗（替代 window.confirm） ----------

function DisbandConfirmModal({
  unitKey, name, count, popReturn, onClose,
}: {
  unitKey: string;
  name: string;
  count: number;
  popReturn: number;
  onClose: () => void;
}) {
  const info = unitInfo(unitKey);

  async function doDisband() {
    onClose();
    await act(
      req('DisbandTroops', { units: { [unitKey]: count } }),
      { okToast: `已解散 ${count} 名 ${name}` },
    );
  }

  return (
    <Modal
      title="确认解散"
      sub={`${name} ×${count}`}
      icon={<IconPlate icon={info.icon ?? `unit_${unitKey}`} label={name} size="sm" plate="stone" />}
      onClose={onClose}
      foot={
        <>
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <Btn variant="danger" onClick={doDisband}>确认解散</Btn>
        </>
      }
    >
      <div class="disband-confirm">
        <div class="disband-confirm__warning">
          即将解散 <b>{fmt(count)} 名 {name}</b>。
        </div>
        <div class="disband-confirm__pop-return">
          <Icon icon="ui_icon_pop" label="人口" size="xs" />
          {' '}立即返还人口 <b>+{fmt(popReturn)}</b>
        </div>
        <div class="disband-confirm__note">
          ⚠️ 训练消耗的资源（木/泥/铁/粮）<b>不会返还</b>。<br />
          解散后如需重新征兵，须再次花费资源。
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// 工具函数
// ============================================================

function buildingName(kind: string): string {
  const m: Record<string, string> = {
    barracks: '兵营', stable: '马厩', workshop: '兵工厂', main: '城镇中心',
    smithy: '铁匠铺', wall: '城墙', hospital: '医院',
  };
  return m[kind] ?? kind;
}

function bldIcon(kind: string): string {
  return `bld_${kind}`;
}

function fmtMsTotal(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}秒`;
  const h = Math.floor(m / 60);
  if (h === 0) return `${m}分${s > 0 ? `${s}秒` : ''}`;
  return `${h}时${m % 60 > 0 ? `${m % 60}分` : ''}`;
}
