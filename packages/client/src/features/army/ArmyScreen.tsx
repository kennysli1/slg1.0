/**
 * 军队页：驻军 / 训练中心 / 解散。
 *
 * 分区设计：
 *  § 1  驻军（Garrison）
 *       - 按 form 分组：近战（melee）/ 远程（ranged）
 *       - 雇佣兵独立区块（金色高亮，无人口耗粮）
 *       - 汇总条：总兵数 / 总攻 / 总防 / 总耗粮 / 宝物携带上限
 *  § 2  训练中心（选择军事建筑实例，在本页完成训练）
 *  § 3  解散部队（非雇佣兵）
 *
 * 驻军分组选择理由：
 *  form（melee/ranged）是兵种唯一的战术分类字段。按 form 分组可以直观地
 *  看出近战与远程的兵力比例，这在攻守决策中最有实用价值。骑兵/攻城兵
 *  目前在 form 层面均归为 melee，与步兵共组，等未来有专属 category 字段
 *  时再细分。雇佣兵因无人口/耗粮消耗，单独成区并使用金色样式区分。
 */
import { useEffect, useState } from 'preact/hooks';
import { dataVersion, tab } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { openModal } from '../../app/store.js';
import {
  buildingInfo, unitInfo, mercenaryInfo, treasureCarryCap, unitCropPerHour,
} from '../../app/config.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { fmt } from '../../shared/utils/format.js';
import { openUnitDetail } from './UnitDetail.js';
import { TrainPanel } from './TrainPanel.js';
import {
  Panel, SectionHead, Divider, Empty, Btn, Tag,
  Icon, IconPlate, Stat, Modal, SecondaryActions,
} from '../../ui/index.js';
import '../../styles/army.css';
import { VillageList } from '../../shared/ui/VillageList.js';

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
      <VillageList />
      <GarrisonSection army={army} />
      <RaidDefenseSection army={army} />
      <TrainingCenterSection army={army} />
      <DisbandSection army={army} />
    </div>
  );
}

/** 掠夺防守配置：攻城战仍使用全部驻军，只有掠夺战读取这里的选择。 */
function RaidDefenseSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const entries = Object.entries(troops).filter(([key, n]) => Number(n) > 0 && !unitInfo(key).isMercenary);
  const config = army.raidDefense ?? { enabled: true, troops };
  const [enabled, setEnabled] = useState(config.enabled !== false);
  const [selected, setSelected] = useState<Record<string, number>>({ ...(config.troops ?? troops) });
  const signature = JSON.stringify({ troops, config });
  useEffect(() => {
    setEnabled(config.enabled !== false);
    setSelected({ ...(config.troops ?? troops) });
    // 服务端快照变更时同步当前编辑器，避免兵力变化后沿用旧数量。
  }, [signature]);

  if (entries.length === 0) return null;
  const save = () => act(req('SetRaidDefense', { enabled, troops: selected }), { okToast: '掠夺防守配置已保存' });
  return (
    <Panel pad class="raid-defense-panel">
      <SectionHead sub="掠夺战不启用城墙、宝物和科技加成；攻城战不受此配置影响">
        掠夺防守
      </SectionHead>
      <label class="raid-defense-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled((e.currentTarget as HTMLInputElement).checked)} />
        <span>启用掠夺防守</span>
      </label>
      {enabled ? entries.map(([key, count]) => {
        const info = unitInfo(key);
        const amount = Math.max(0, Math.min(Number(count), Number(selected[key] ?? 0)));
        return (
          <div class="raid-defense-row" key={key}>
            <span>{info.name ?? key}</span>
            <input
              type="number" min={0} max={Number(count)} value={amount}
              aria-label={`${info.name ?? key}掠夺防守数量`}
              onInput={(e) => {
                const n = Math.max(0, Math.min(Number(count), Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0)));
                setSelected((prev) => ({ ...prev, [key]: n }));
              }}
            />
            <Btn size="sm" variant="ghost" onClick={() => setSelected((prev) => ({ ...prev, [key]: Number(count) }))}>全军</Btn>
          </div>
        );
      }) : <p class="muted">关闭后，敌方掠夺战不会与驻军交战；攻城仍会面对全部守军。</p>}
      <Btn size="sm" variant="primary" onClick={save}>保存掠夺防守配置</Btn>
    </Panel>
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
        <Empty icon="⚔️" title="暂无驻军">可在下方训练中心组建部队</Empty>
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
// § 2  训练中心
// ============================================================

function TrainingCenterSection({ army }: { army: any }) {
  const slots: any[] = army.slots ?? [];
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(() => slots[0]?.slotId ?? null);
  const selected = slots.find((slot: any) => slot.slotId === selectedSlotId) ?? slots[0];

  if (!slots.length) {
    return (
      <Panel pad>
        <SectionHead sub="每座军事建筑拥有独立的训练队列">训练中心</SectionHead>
        <Empty icon="⚔️" title="尚无军事建筑">
          <p>建造军事建筑后，即可在这里训练对应部队。</p>
          <Btn size="sm" variant="primary" onClick={() => { tab.value = 'village'; }}>前往村庄</Btn>
        </Empty>
      </Panel>
    );
  }

  return (
    <Panel pad class="training-center">
      <div class="training-center__selector">
        <SectionHead sub="每座建筑独立排队">训练建筑</SectionHead>
        <div class="training-center__slots" role="listbox" aria-label="选择训练建筑">
          {slots.map((slot: any) => {
            const info = buildingInfo(slot.kind);
            const selectedHere = slot.slotId === selected.slotId;
            return (
              <button
                key={slot.slotId}
                type="button"
                role="option"
                aria-selected={selectedHere}
                class={`training-center__slot${selectedHere ? ' training-center__slot--selected' : ''}`}
                onClick={() => setSelectedSlotId(slot.slotId)}
              >
                <IconPlate icon={info.icon ?? `bld_${slot.kind}`} label={info.name ?? slot.kind} size="sm" plate="stone" lvl={slot.level} />
                <span class="training-center__slot-copy">
                  <b>{info.name ?? slot.kind}</b>
                  <small>{slot.training ? '训练中' : '队列空闲'}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div class="training-center__panel">
        <SectionHead sub={`${buildingInfo(selected.kind).name ?? selected.kind} · Lv${selected.level}`}>训练</SectionHead>
        <TrainPanel slotId={selected.slotId} kind={selected.kind} level={selected.level} />
      </div>
    </Panel>
  );
}

// ============================================================
// § 3  解散
// ============================================================

function DisbandSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const entries = Object.entries(troops).filter(([k, n]) =>
    (n as number) > 0 && !unitInfo(k).isMercenary,
  );
  if (entries.length === 0) return null;

  return (
    <Panel class="army-management-panel">
      <SecondaryActions label="部队管理" hint="解散驻军">
      <div class="disband-section">
        <div class="disband-hint">
          解散后人口立即返还（可重新用于训练），但训练耗费的木/泥/铁/粮均不退回。
          出征中的军队不可解散，请等待回村后操作。
        </div>
        {entries.map(([key, count]) => (
          <DisbandRow key={key} unitKey={key} totalCount={count as number} army={army} />
        ))}
      </div>
      </SecondaryActions>
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
