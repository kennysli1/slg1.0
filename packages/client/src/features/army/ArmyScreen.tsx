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
import { dataVersion, showToast } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';
import { act, refreshAll } from '../../app/refresh.js';
import {
  unitInfo, mercenaryInfo, treasureCarryCap, unitCropPerHour,
} from '../../app/config.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { fmt } from '../../shared/utils/format.js';
import { openUnitDetail } from './UnitDetail.js';
import { TrainPanel } from './TrainPanel.js';
import {
  Panel, SectionHead, Divider, Empty, Tag, IconPlate, Stat, Btn, confirmDanger,
} from '../../ui/index.js';
import '../../styles/army.css';
import { VillageList } from '../../shared/ui/VillageList.js';
import { IncomingWarnings } from '../../shared/ui/IncomingWarnings.js';

export function ArmyScreen() {
  return (
    <div class="army-page">
      <VillageList />
      <IncomingWarnings />
      <VillageArmyManagement />
    </div>
  );
}

/**
 * 当前村庄的完整军务区。王国页复用它，保留训练、援军、防御与解散等所有旧操作。
 */
export function VillageArmyManagement() {
  dataVersion.value; // 订阅快照刷新

  const army = getCache().army;
  if (!army) {
    return (
      <section class="kingdom-army-management"><Empty icon="⚔️" title="军务数据加载中…">正在获取当前村庄军队数据</Empty></section>
    );
  }

  return (
    <section class="kingdom-army-management" aria-label="当前村庄军务">
      <div class="kingdom-section-intro">
        <span>村庄军务</span>
        <small>驻军、训练、援军与防御都归属当前村庄</small>
      </div>
      <GarrisonSection army={army} />
      <ReinforcementSection army={army} />
      <RaidDefenseSection army={army} />
      <TrainingCenterSection />
      <DisbandSection army={army} />
    </section>
  );
}

// ============================================================
// § 3  解散驻军（默认折叠）
// ============================================================

/**
 * 解散只作用于本村驻军；已经派出、驻扎在野外或作为援军的部队由行军
 * 系统分别管理。使用 details 保留旧版“页面最底部、默认折叠”的交互。
 */
function DisbandSection({ army }: { army: any }) {
  const troops: Record<string, number> = army.troops ?? {};
  const entries = Object.entries(troops).filter(([, count]) => Number(count) > 0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const snapshotKey = JSON.stringify(troops);

  useEffect(() => {
    setCounts((current) => {
      const next: Record<string, number> = {};
      for (const [unit, raw] of Object.entries(troops)) {
        const max = Math.max(0, Math.floor(Number(raw) || 0));
        if (max > 0) next[unit] = Math.min(Math.max(1, Math.floor(Number(current[unit]) || max)), max);
      }
      return next;
    });
  }, [snapshotKey]);

  async function disband(unit: string, max: number) {
    const count = Math.min(max, Math.max(1, Math.floor(Number(counts[unit]) || 1)));
    const name = unitInfo(unit).name ?? unit;
    const returned = Math.max(0, Number(unitInfo(unit).popCost ?? 0) * count);
    const confirmed = await confirmDanger({
      title: `解散${name}`,
      body: `确认解散 ${count} 名${name}？资源不会返还，将立即返还 ${returned} 人口。`,
      confirmText: '确认解散',
    });
    if (!confirmed) return;
    await act(req('DisbandTroops', { units: { [unit]: count } }), {
      okToast: `已解散 ${name} ×${count}`,
    });
  }

  return (
    <Panel pad class="army-management-panel">
      <details class="disband-details">
        <summary class="section-head section-head--toggle">
          <span>解散军队</span>
          <small>仅本村驻军 · 出征部队不能在此解散</small>
          <i aria-hidden="true">›</i>
        </summary>
        <div class="disband-section">
          {entries.length === 0
            ? <div class="disband-hint">当前没有可解散的驻军。</div>
            : entries.map(([unit, raw]) => {
              const max = Math.max(0, Math.floor(Number(raw) || 0));
              const count = Math.min(max, Math.max(1, Math.floor(Number(counts[unit]) || max)));
              const popReturn = Math.max(0, Number(unitInfo(unit).popCost ?? 0) * count);
              return (
                <div class="disband-row" key={unit}>
                  <IconPlate icon={unitInfo(unit).icon} label={unitInfo(unit).name} size="sm" plate="stone" />
                  <div class="disband-row__info">
                    <div class="disband-row__name">{unitInfo(unit).name}</div>
                    <div class="disband-row__count">驻军 ×{fmt(max)}</div>
                  </div>
                  <div class="disband-row__controls">
                    <input
                      class="disband-input"
                      type="number"
                      min="1"
                      max={max}
                      value={count}
                      aria-label={`解散${unitInfo(unit).name}数量`}
                      onInput={(event) => setCounts({ ...counts, [unit]: Number((event.currentTarget as HTMLInputElement).value) })}
                    />
                    <span class="disband-row__pop">返还 {fmt(popReturn)} 人口</span>
                    <Btn size="sm" variant="danger" onClick={() => void disband(unit, max)}>解散</Btn>
                  </div>
                </div>
              );
            })}
          <div class="disband-hint">解散会返还训练时占用的人口，但不会返还训练资源。</div>
        </div>
      </details>
    </Panel>
  );
}

// ============================================================
// § 1.2  增援部队
// ============================================================

function ReinforcementSection({ army }: { army: any }) {
  const reinforcements: any[] = army.reinforcements ?? [];
  if (reinforcements.length === 0) return null;

  return (
    <Panel pad>
      <SectionHead sub="增援兵力仍由来源村庄承担口粮、人口和伤亡">增援部队</SectionHead>
      <div class="reinforcement-list">
        {reinforcements.map((entry) => {
          const sourcePlayer = entry.fromPlayerName ?? (entry.npcService ? '王国' : '未知玩家');
          const sourceVillage = entry.fromVillageName ?? entry.fromVillage ?? '未知村庄';
          const status = entry.status === 'stationed' ? '已驻扎' : '行军中';
          const troopEntries = Object.entries(entry.troops ?? {}).filter(([, count]) => Number(count) > 0);
          return (
            <div class="reinforcement-card" key={entry.id}>
              <div class="reinforcement-card__head">
                <div>
                  <div class="reinforcement-card__source">{sourceVillage}</div>
                  <div class="reinforcement-card__owner">来自玩家：{sourcePlayer}</div>
                </div>
                <Tag kind={entry.status === 'stationed' ? 'jade' : 'steel'}>{status}</Tag>
              </div>
              <div class="reinforcement-card__troops">
                {troopEntries.length === 0
                  ? <span class="hint-sm">暂无存活兵力</span>
                  : troopEntries.map(([unit, count]) => (
                    <span class="reinforcement-card__troop" key={unit}>
                      {unitInfo(unit).name} ×{fmt(Number(count))}
                    </span>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
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
  const reinforcements: any[] = army.reinforcements ?? [];
  const [reinforcementDrafts, setReinforcementDrafts] = useState<Record<string, { enabled: boolean; troops: Record<string, number> }>>({});
  const snapshotKey = JSON.stringify({
    own: { enabled: raidDefense.enabled !== false, troops: raidDefense.troops ?? troops },
    reinforcements: reinforcements.map((entry) => ({ id: entry.id, troops: entry.troops, raidDefense: entry.raidDefense, status: entry.status })),
  });

  // act() 完成刷新后同步服务端快照，避免切村/训练/战斗后仍显示旧配置。
  useEffect(() => {
    setEnabled(raidDefense.enabled !== false);
    setSelected({ ...(raidDefense.troops ?? troops) });
    const next: Record<string, { enabled: boolean; troops: Record<string, number> }> = {};
    for (const entry of reinforcements) {
      next[entry.id] = {
        enabled: entry.raidDefense?.enabled !== false,
        troops: { ...(entry.raidDefense?.troops ?? entry.troops ?? {}) },
      };
    }
    setReinforcementDrafts(next);
  }, [snapshotKey]);

  const entries = Object.entries(troops).filter(([, count]) => Number(count) > 0);

  async function save() {
    const normalized = Object.fromEntries(
      entries
        .map(([key, count]) => [key, Math.min(Math.max(0, Math.floor(Number(selected[key]) || 0)), Number(count))] as const)
        .filter(([, count]) => count > 0),
    );
    let ok = await act(req('SetRaidDefense', { enabled, troops: normalized }), { silent: true });
    for (const entry of reinforcements) {
      const draft = reinforcementDrafts[entry.id] ?? { enabled: true, troops: entry.troops ?? {} };
      const available = entry.troops ?? {};
      const selectedReinforcement = Object.fromEntries(
        Object.entries(available)
          .map(([key, count]) => [key, Math.min(Math.max(0, Math.floor(Number(draft.troops[key]) || 0)), Number(count))] as const)
          .filter(([, count]) => count > 0),
      );
      const saved = await act(req('SetReinforcementRaidDefense', {
        movementId: entry.id,
        enabled: draft.enabled,
        troops: selectedReinforcement,
      }), { silent: true });
      ok = ok && saved;
    }
    if (ok) {
      showToast('掠夺防守配置已保存', 'ok');
      await refreshAll();
    }
  }

  const updateReinforcement = (id: string, patch: Partial<{ enabled: boolean; troops: Record<string, number> }>) => {
    setReinforcementDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { enabled: true, troops: {} }), ...patch },
    }));
  };

  const renderRows = (poolTroops: Record<string, number>, poolSelected: Record<string, number>, poolEnabled: boolean, setPoolSelected: (next: Record<string, number>) => void, prefix: string) => {
    const poolEntries = Object.entries(poolTroops).filter(([, count]) => Number(count) > 0);
    return poolEntries.map(([key, count]) => {
      const info = unitInfo(key);
      const name = army.trainable?.find((unit: any) => unit.key === key)?.name ?? info.name ?? key;
      const value = Math.min(Math.max(0, Math.floor(Number(poolSelected[key]) || 0)), Number(count));
      return (
        <div class="raid-defense-row" key={`${prefix}:${key}`}>
          <span>{name} <small class="hint-sm">可用 {fmt(Number(count))}</small></span>
          <input
            type="number"
            min="0"
            max={Number(count)}
            value={value}
            disabled={!poolEnabled}
            aria-label={`${name}防守数量`}
            onInput={(event) => {
              const next = Math.min(Math.max(0, Math.floor(Number((event.currentTarget as HTMLInputElement).value) || 0)), Number(count));
              setPoolSelected({ ...poolSelected, [key]: next });
            }}
          />
          <Btn size="sm" variant="ghost" disabled={!poolEnabled} onClick={() => setPoolSelected({ ...poolSelected, [key]: Number(count) })}>全部</Btn>
        </div>
      );
    });
  };

  return (
    <Panel pad>
      <SectionHead sub="仅用于玩家掠夺战；攻城战不受此配置影响">
        防御掠夺
      </SectionHead>
      <div class="raid-defense-panel">
        <div class="raid-defense-source-card">
          <div class="raid-defense-source-head">
            <strong>本村驻军</strong><span class="hint-sm">自己的部队</span>
          </div>
          <label class="raid-defense-toggle">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled((event.currentTarget as HTMLInputElement).checked)} />
            <span>投入掠夺防守</span>
          </label>
          <div class="hint-sm">关闭或将数量设为 0 后，本村部队不会参加掠夺防守。</div>
          {entries.length === 0 ? <div class="hint-sm">暂无可配置驻军。</div> : renderRows(troops, selected, enabled, setSelected, 'own')}
        </div>

        {reinforcements.map((entry) => {
          const draft = reinforcementDrafts[entry.id] ?? { enabled: entry.raidDefense?.enabled !== false, troops: entry.raidDefense?.troops ?? entry.troops ?? {} };
          const sourcePlayer = entry.fromPlayerName ?? (entry.npcService ? '王国' : '未知玩家');
          const sourceVillage = entry.fromVillageName ?? entry.fromVillage ?? '未知村庄';
          const status = entry.status === 'stationed' ? '已驻扎' : '行军中';
          return (
            <div class="raid-defense-source-card" key={entry.id}>
              <div class="raid-defense-source-head">
                <strong>援军 · {sourceVillage}</strong><span class="hint-sm">来自 {sourcePlayer} · {status}</span>
              </div>
              <label class="raid-defense-toggle">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => updateReinforcement(entry.id, { enabled: (event.currentTarget as HTMLInputElement).checked })} />
                <span>投入掠夺防守</span>
              </label>
              <div class="hint-sm">该来源援军独立配置，不会与本村或其他援军同兵种合并。</div>
              {renderRows(entry.troops ?? {}, draft.troops, draft.enabled, (next) => updateReinforcement(entry.id, { troops: next }), `reinforcement:${entry.id}`)}
            </div>
          );
        })}

        <Btn variant="primary" block onClick={() => void save()}>保存全部防守配置</Btn>
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
    <Panel pad>
      <SectionHead sub="左侧选择军事建筑，右侧训练该建筑可造的兵种">训练</SectionHead>
      <TrainPanel />
    </Panel>
  );
}
