/**
 * 铁匠面板（SmithyPanel）：NEW 功能，服务端已有 UpgradeSmithy 但之前无 UI。
 *
 * 功能：
 *  - 展示每个本族兵种当前铁匠等级及对应全军攻防加成
 *  - 精确的升级消耗（木/泥各 smithyCostBase×目标等级，与服务端同公式）与基础时长
 *  - 进行中的铁匠升级：真实起止时刻的 TimerBar（GetArmy 下发 pendingSmithy）
 *  - 升级按钮：调用 UpgradeSmithy { unit }；smithy_busy 由 act() 自动 toast
 */
import { dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { smithyBonusPerLevel, smithyUpgradeCost, smithyUpgradeSec } from '../../app/config.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import {
  IconPlate, Tag, Btn, TimerBar, Empty, CostRow, canAfford,
} from '../../ui/index.js';
import '../../styles/army.css';

/** 服务端下发的进行中铁匠升级。startAt 在老存档里可能缺失。 */
interface PendingSmithy { unit: string; startAt: number | null; doneAt: number }

/** 铁匠面板，可单独嵌入铁匠建筑弹窗，也可展示在军队页"锻造"区块。 */
export function SmithyPanel() {
  dataVersion.value; // 订阅数据刷新

  const army = getCache().army;
  if (!army) return <div class="smithy-panel"><div style="color: var(--c-ink-dim); font-size: var(--f-sm);">加载中…</div></div>;

  const smithyLevel: Record<string, number> = army.smithyLevel ?? {};
  const bonusPerLevel = smithyBonusPerLevel();

  // 本族所有可训兵种（用于显示铁匠等级）
  const trainable: any[] = army.trainable ?? [];

  const pending: PendingSmithy | null = army.pendingSmithy ?? null;

  if (trainable.length === 0) {
    return (
      <div class="smithy-panel">
        <Empty title="暂无可强化兵种" icon="⚒️">
          需先建造对应军事建筑并解锁兵种
        </Empty>
      </div>
    );
  }

  return (
    <div class="smithy-panel">

      {/* 进行中的升级 */}
      {pending && (
        <SmithyBusyBanner pending={pending} trainable={trainable} />
      )}

      {/* 说明 */}
      <div style="font-size: var(--f-xs); color: var(--c-ink-dim); line-height: 1.4;">
        每级铁匠强化提升该兵种<b style="color: var(--c-gold);">全军攻击与防御 +{(bonusPerLevel * 100).toFixed(0)}%</b>（叠加计算）。
        基础耗时 {smithyUpgradeSec()} 秒，受繁荣度加速；同一时刻只能强化一个兵种。
      </div>

      {/* 兵种强化列表 */}
      <div class="smithy-unit-list">
        {trainable.map((u: any) => {
          const curLv = smithyLevel[u.key] ?? 0;
          const nextLv = curLv + 1;
          const curBonus = Math.round(curLv * bonusPerLevel * 100);
          const nextBonus = Math.round(nextLv * bonusPerLevel * 100);
          const isBusy = !!pending; // 同时只允许一个铁匠升级
          const isThisBusy = pending?.unit === u.key;

          return (
            <SmithyUnitRow
              key={u.key}
              u={u}
              curLv={curLv}
              nextLv={nextLv}
              curBonus={curBonus}
              nextBonus={nextBonus}
              isBusy={isBusy}
              isThisBusy={isThisBusy}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------- 升级进行中横幅 ----------

function SmithyBusyBanner({ pending, trainable }: { pending: PendingSmithy; trainable: any[] }) {
  const u = trainable.find((t: any) => t.key === pending.unit);
  const name = u?.name ?? pending.unit;
  // 服务端给真实起点；老存档里没有 startAt 时用基础时长倒推一个近似值
  const startAt = pending.startAt ?? (pending.doneAt - smithyUpgradeSec() * 1000);

  return (
    <div class="smithy-busy-banner">
      <IconPlate
        icon={u?.icon ?? `unit_${pending.unit}`}
        label={name}
        size="sm"
        plate="gold"
      />
      <div class="smithy-busy-banner__body">
        <div class="smithy-busy-banner__label">⚒️ 正在强化：{name}</div>
        <TimerBar startAt={startAt} finishAt={pending.doneAt} label="升级中" kind="gold" />
      </div>
    </div>
  );
}

// ---------- 单行：兵种铁匠等级 ----------

interface SmithyUnitRowProps {
  u: any;
  curLv: number;
  nextLv: number;
  curBonus: number;
  nextBonus: number;
  isBusy: boolean;
  isThisBusy: boolean;
}

function SmithyUnitRow({ u, curLv, nextLv, curBonus, nextBonus, isBusy, isThisBusy }: SmithyUnitRowProps) {
  const cost = smithyUpgradeCost(nextLv);
  const affordable = canAfford(cost);

  async function doUpgrade() {
    // smithy_busy 错误由 act() 自动 toast（errText 已翻译）
    await act(
      req('UpgradeSmithy', { unit: u.key }),
      { okToast: `${u.name} 铁匠强化已开始` },
    );
  }

  return (
    <div class="smithy-unit-row">
      <IconPlate
        icon={u.icon ?? `unit_${u.key}`}
        label={u.name}
        size="sm"
        plate={curLv > 0 ? 'gold' : 'stone'}
        lvl={curLv > 0 ? curLv : null}
      />

      <div class="smithy-unit-row__info">
        <div class="smithy-unit-row__name">{u.name}</div>

        {curLv > 0 ? (
          <div class="smithy-unit-row__bonus">
            当前：攻防 +{curBonus}%
            {' → '}
            <span style="color: var(--c-gold);">Lv{nextLv}：+{nextBonus}%</span>
          </div>
        ) : (
          <div class="smithy-unit-row__bonus" style="color: var(--c-ink-dim);">
            未强化 → Lv1：攻防 +{nextBonus}%
          </div>
        )}

        <CostRow cost={cost} timeSec={smithyUpgradeSec()} class="smithy-unit-row__cost" />
      </div>

      {isThisBusy ? (
        <Tag kind="ember">升级中…</Tag>
      ) : (
        <Btn
          size="sm"
          variant={curLv === 0 ? 'primary' : 'default'}
          disabled={isBusy || !affordable}
          onClick={doUpgrade}
          title={
            isBusy ? '铁匠铺正在升级中，请等当前完成'
              : !affordable ? '资源不足'
                : `将 ${u.name} 铁匠强化到 Lv${nextLv}`
          }
        >
          {isBusy ? '升级中' : !affordable ? '资源不足' : `强化 Lv${nextLv}`}
        </Btn>
      )}
    </div>
  );
}
