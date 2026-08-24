/**
 * 军队页：驻军与统一训练。
 *
 * 分区设计：
 *  § 1  驻军（Garrison）
 *       - 按 form 分组：近战（melee）/ 远程（ranged）
 *       - 雇佣兵独立区块（金色高亮，无人口耗粮）
 *       - 汇总条：总兵数 / 总攻 / 总防 / 总耗粮 / 宝物携带上限
 *  § 2  训练中心（服务端分配训练队列）
 *
 * 驻军分组选择理由：
 *  form（melee/ranged）是兵种唯一的战术分类字段。按 form 分组可以直观地
 *  看出近战与远程的兵力比例，这在攻守决策中最有实用价值。骑兵/攻城兵
 *  目前在 form 层面均归为 melee，与步兵共组，等未来有专属 category 字段
 *  时再细分。雇佣兵因无人口/耗粮消耗，单独成区并使用金色样式区分。
 */
import { useEffect, useState } from 'preact/hooks';
import { dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import {
  unitInfo, mercenaryInfo, treasureCarryCap, unitCropPerHour,
} from '../../app/config.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { fmt } from '../../shared/utils/format.js';
import { openUnitDetail } from './UnitDetail.js';
import { TrainPanel } from './TrainPanel.js';
import {
  Panel, SectionHead, Divider, Empty, Tag, IconPlate, Stat, Btn,
} from '../../ui/index.js';
import '../../styles/army.css';
import { VillageList } from '../../shared/ui/VillageList.js';
import { IncomingWarnings } from '../../shared/ui/IncomingWarnings.js';

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
      <IncomingWarnings />
      <GarrisonSection army={army} />
      <RaidDefenseSection army={army} />
      <TrainingCenterSection />
    </div>
  );
}

// ============================================================
// § 1.5  掠夺防守配置
// ============================================================

/**
 * 设置本村在玩家掠夺战中实际派出的防守兵力。
 * 这是村庄级配置：只影响「掠夺」而不影响攻城战，且兵力上限始终按当前驻军校验。
 */
function RaidDefenseSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const raidDefense = army.raidDefense ?? { enabled: true, troops: troops };
  const [enabled, setEnabled] = useState(raidDefense.enabled !== false);
  const [selected, setSelected] = useState<Record<string, number>>({ ...(raidDefense.troops ?? troops) });
  const snapshotKey = JSON.stringify({ enabled: raidDefense.enabled !== false, troops: raidDefense.troops ?? troops });

  // act() 完成刷新后同步服务端快照，避免切村/训练/战斗后仍显示旧配置。
  useEffect(() => {
    setEnabled(raidDefense.enabled !== false);
    setSelected({ ...(raidDefense.troops ?? troops) });
  }, [snapshotKey]);

  const entries = Object.entries(troops).filter(([, count]) => Number(count) > 0);

  async function save() {
    const normalized = Object.fromEntries(
      entries
        .map(([key, count]) => [key, Math.min(Math.max(0, Math.floor(Number(selected[key]) || 0)), Number(count))] as const)
        .filter(([, count]) => count > 0),
    );
    await act(req('SetRaidDefense', { enabled, troops: normalized }), {
      okToast: '掠夺防守配置已保存',
    });
  }

  return (
    <Panel pad>
      <SectionHead sub="仅用于玩家掠夺战；攻城战不受此配置影响">
        防御掠夺
      </SectionHead>
      <div class="raid-defense-panel">
        <label class="raid-defense-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>派驻军防守掠夺</span>
        </label>
        <div class="hint-sm">关闭后，本村遭遇掠夺时不派出防守兵力；开启后按下方数量出战。</div>

        {entries.length === 0 ? (
          <Empty icon="🛡️" title="暂无可配置驻军">训练或召回部队后可设置防守数量。</Empty>
        ) : entries.map(([key, count]) => {
          const info = unitInfo(key);
          const name = army.trainable?.find((unit: any) => unit.key === key)?.name ?? info.name ?? key;
          const value = Math.min(Math.max(0, Math.floor(Number(selected[key]) || 0)), Number(count));
          return (
            <div class="raid-defense-row" key={key}>
              <span>{name} <small class="hint-sm">可用 {fmt(Number(count))}</small></span>
              <input
                type="number"
                min="0"
                max={Number(count)}
                value={value}
                disabled={!enabled}
                aria-label={`${name}防守数量`}
                onInput={(event) => {
                  const next = Math.min(Math.max(0, Math.floor(Number((event.currentTarget as HTMLInputElement).value) || 0)), Number(count));
                  setSelected((current) => ({ ...current, [key]: next }));
                }}
              />
              <Btn
                size="sm"
                variant="ghost"
                disabled={!enabled}
                onClick={() => setSelected((current) => ({ ...current, [key]: Number(count) }))}
              >
                全部
              </Btn>
            </div>
          );
        })}

        <Btn variant="primary" block onClick={() => void save()}>保存防守配置</Btn>
      </div>
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
        icon={info.icon}
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

function TrainingCenterSection() {
  return (
    <Panel pad class="training-center">
      <SectionHead sub="可用队列由领地内建筑自动分配">训练</SectionHead>
      <TrainPanel />
    </Panel>
  );
}
