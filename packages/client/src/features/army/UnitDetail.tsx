/**
 * 兵种详情弹窗：完整属性一览（战斗属性 / 训练造价 / 人口/耗粮/速度/特性）。
 * openUnitDetail(key) 是跨特性接口，签名固定。
 */
import { dataVersion } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { unitInfo, mercenaryInfo, resourceKeys, unitCropPerHour } from '../../app/config.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { openModal } from '../../app/store.js';
import {
  Modal, IconPlate, Tag, StatGrid, Stat, CostRow, Divider,
} from '../../ui/index.js';
import '../../styles/army.css';

/** 打开兵种详情弹窗。签名固定（跨特性接口）。 */
export function openUnitDetail(unitKey: string): void {
  openModal((close) => <UnitDetailModal unitKey={unitKey} onClose={close} />, 'unit-detail');
}

function UnitDetailModal({ unitKey, onClose }: { unitKey: string; onClose: () => void }) {
  dataVersion.value; // 订阅数据刷新，弹窗内数值保持最新

  const army = getCache().army;
  // trainable 含最终战斗属性快照（含铁匠加成）
  const trainableEntry = (army?.trainable ?? []).find((u: any) => u.key === unitKey);
  const info = unitInfo(unitKey);
  const merc = mercenaryInfo(unitKey);

  // 优先用 trainable 的派生属性快照；雇佣兵用 mercenaryInfo 回退
  const stats = trainableEntry ?? (merc ? {
    key: unitKey,
    form: merc.form,
    meleeAtk: merc.meleeAtk,
    rangedAtk: merc.rangedAtk,
    meleeDef: merc.meleeDef,
    rangedDef: merc.rangedDef,
    speed: merc.speed,
    carry: merc.carry,
    upkeep: 0,
    cropPerHourEach: 0,
    cost: {},
    trainSec: 0,
  } : null);

  const name = trainableEntry?.name ?? info.name;
  const cropPerHour = unitCropPerHour(unitKey);
  const popCost = info.isMercenary ? 0 : info.popCost;
  const isLocked = trainableEntry?.unlocked === false;

  const r = (v: unknown) => Math.round(Number(v) || 0);

  return (
    <Modal
      title={name}
      sub={stats ? formName(stats.form) : undefined}
      icon={
        <IconPlate
          icon={info.icon ?? `unit_${unitKey}`}
          label={name}
          size="lg"
          plate={info.isMercenary ? 'gold' : 'stone'}
        />
      }
      onClose={onClose}
      wide={false}
    >
      <div class="unit-detail-body">

        {/* 阵营 + 形态标签 */}
        <div class="unit-detail-hero">
          <div class="unit-detail-hero__meta">
            <div class="unit-detail-hero__name">{name}</div>
            <div class="unit-detail-traits">
              {army?.tribe && <Tag kind="gold">{tribeName(army.tribe)}族</Tag>}
              {stats && <Tag kind={stats.form === 'ranged' ? 'steel' : 'ember'}>{formName(stats.form)}</Tag>}
              {info.isMercenary && <Tag kind="gold">雇佣兵</Tag>}
              {isLocked && <Tag kind="crimson">未解锁</Tag>}
            </div>
          </div>
        </div>

        {/* 解锁提示 */}
        {isLocked && trainableEntry?.lockReason && (
          <div class="unit-detail-lock">🔒 {trainableEntry.lockReason}</div>
        )}

        {/* 战斗属性 */}
        {stats && (
          <>
            <div>
              <div class="unit-detail-sec">战斗属性</div>
              <StatGrid>
                <Stat icon="ui_icon_atk" label="近战攻击" value={r(stats.meleeAtk)}
                  title="与近战单位交战时的攻击值" />
                <Stat icon="ui_icon_atk" label="远程攻击" value={r(stats.rangedAtk)}
                  title="远程齐射的攻击值（近战兵种为 0）" />
                <Stat icon="ui_icon_def" label="近战防御" value={r(stats.meleeDef)}
                  title="承受近战攻击时的耐久" />
                <Stat icon="ui_icon_def" label="远程防御" value={r(stats.rangedDef)}
                  title="承受远程攻击时的耐久" />
                <Stat icon="ui_icon_speed" label="移动速度" value={`${r(stats.speed)} 格/时`}
                  title="行军移动速度" />
                <Stat icon="ui_icon_carry" label="单位运力" value={r(stats.carry)}
                  title="每兵可携带的资源量" />
              </StatGrid>
            </div>

            <Divider ornate />
          </>
        )}

        {/* 征募信息（非雇佣兵） */}
        {!info.isMercenary && trainableEntry && (
          <div>
            <div class="unit-detail-sec">征募信息</div>
            <StatGrid>
              <Stat icon="ui_icon_pop" label="占用人口" value={popCost}
                title="训练每兵消耗的人口数" />
              <Stat icon="ui_icon_upkeep" label="每小时耗粮" value={cropPerHour}
                title="每兵每小时消耗的粮食（口粮 + 军晌）" />
              <Stat icon="ui_icon_time" label="训练时长" value={fmtSec(trainableEntry.trainSec)}
                title="当前建筑等级下的实际训练时间" />
            </StatGrid>
            <div style="margin-top: var(--s-3);">
              <div class="unit-detail-sec">训练造价</div>
              <CostRow
                cost={buildCostMap(trainableEntry.cost, resourceKeys(), 1)}
                timeSec={trainableEntry.trainSec}
                popCost={popCost}
              />
            </div>
          </div>
        )}

        {/* 雇佣兵：金币单价 */}
        {info.isMercenary && merc && (
          <div>
            <div class="unit-detail-sec">招募信息</div>
            <StatGrid>
              <Stat icon="res_gold" label="金币单价" value={merc.goldCost}
                title="在雇佣兵营地招募每兵所需金币" />
              <Stat icon="ui_icon_pop" label="人口占用" value="0"
                title="雇佣兵不消耗人口，不计入动员上限" />
              <Stat icon="ui_icon_upkeep" label="每小时耗粮" value="0"
                title="雇佣兵无粮食消耗" />
            </StatGrid>
          </div>
        )}

      </div>
    </Modal>
  );
}

/** 把 cost record 按给定 resourceKeys 提取，乘以倍数 */
function buildCostMap(cost: Record<string, number>, keys: string[], mult: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (cost[k]) out[k] = Math.round(cost[k] * mult);
  }
  return out;
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}秒`;
  if (s === 0) return `${m}分`;
  return `${m}分${s}秒`;
}
