import { useState } from 'preact/hooks';
import { me, req } from '../../api.js';
import { getCache } from '../../app/state.js';
import { dataVersion, kingdomState, openModal, tick } from '../../app/store.js';
import { act, reloadKingdom } from '../../app/refresh.js';
import { Btn, Tag } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { BuildingManagement } from './BuildingManagement.js';
import { resInfo, treasureInfo, unitInfo } from '../../app/config.js';
import { fmt, secLeft } from '../../shared/utils/format.js';

const KEY = 'council';

export function openCouncil(slotId?: string): void {
  void reloadKingdom();
  openModal((close) => <CouncilModal slotId={slotId} onClose={close} />, KEY);
}

function categoryName(category: string): string {
  if (category === 'reinforcement') return '增援';
  if (category === 'attack') return '代打';
  if (category === 'supplies') return '物资';
  if (category === 'escort') return '商队护卫';
  return '宝物';
}

function serviceContent(service: any): string {
  if (service.category === 'escort') return `${unitInfo(service.unitCode).name} ×${fmt(service.unitCount)} · 立即保护商队，送货结束后离开`;
  if (service.category === 'reinforcement') return `${service.unitCode} ×${fmt(service.unitCount)} · 临时增援（不并入本村军队）`;
  if (service.category === 'attack') return `${service.unitCode} ×${fmt(service.unitCount)} · ${service.delaySec > 0 ? `${service.delaySec}秒后出发` : '立即出发'}`;
  if (service.category === 'treasure') return treasureInfo(service.treasureCode)?.name ?? service.treasureCode;
  return Object.entries(service.resources ?? {}).filter(([, n]) => Number(n) > 0)
    .map(([key, n]) => `${key === 'gold' ? '金币' : resInfo(key).name} ${fmt(Number(n))}`).join(' · ');
}

function CouncilModal({ slotId, onClose }: { slotId?: string; onClose: () => void }) {
  dataVersion.value;
  tick.value;
  const state = kingdomState.value;
  const [targetKey, setTargetKey] = useState('');
  const [caravanId, setCaravanId] = useState('');
  const [buying, setBuying] = useState(false);
  const eligibleCaravans = (state?.eligibleCaravans ?? []) as Array<{ id: string; originVillageName: string; destinationVillageName: string }>;
  const escortTarget = eligibleCaravans.find((caravan) => caravan.id === caravanId);
  const own = new Set(me?.villages?.map((v) => v.id) ?? []);
  const targets = ((getCache().area?.tiles ?? []) as any[]).filter((tile) =>
    (tile.kind === 'pve' || tile.kind === 'village')
    && tile.visibility !== 'unexplored'
    && tile.refId
    && !own.has(tile.refId)
    && !String(tile.refId).startsWith('kingdom-'),
  );
  const target = targets.find((tile) => `${tile.kind}:${tile.refId}` === targetKey);

  const buy = async (service: any) => {
    if (buying) return;
    if (service.category === 'attack' && !target) return;
    if (service.category === 'escort' && !escortTarget) return;
    setBuying(true);
    try { await act(req('BuyKingdomService', {
      serviceCode: service.code,
      ...(service.category === 'attack' && target ? { targetKind: target.kind, targetId: target.refId } : {}),
      ...(service.category === 'escort' && escortTarget ? { targetMovementId: escortTarget.id } : {}),
    }), {
      okToast: service.category === 'escort' ? '商队已获得王国护卫保护，送货抵达后护卫离开' : service.category === 'attack' ? '王国军队已受命出发' : service.category === 'reinforcement' ? '王国增援已出发，抵达后临时驻防' : `${service.name}已交付`,
      onOk: () => void reloadKingdom(),
    }); } finally { setBuying(false); }
  };

  return (
    <Modal title="议会厅" sub={state ? `效忠 ${state.fiefName} · 议会厅 Lv${state.councilLevel}` : '正在读取王国档案…'} onClose={onClose} wide>
      {!state ? <p class="bld-desc">正在加载…</p> : (
        <>
          <div class="task-card-prog">
            <span class="task-prog-chip">所属封地：{state.fiefName}</span>
            {!state.task && <span class="task-prog-chip">下次指令：{secLeft(state.nextIssueAt)}</span>}
          </div>

          {state.services.some((s: any) => s.category === 'attack' && state.councilLevel >= s.minCouncilLevel) && (
            <label class="task-submit-row">
              <span class="task-submit-res">代打目标</span>
              <select class="task-submit-input" value={targetKey} onChange={(e) => setTargetKey((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">选择当前地图上可见/已探索目标</option>
                {targets.map((tile) => (
                  <option value={`${tile.kind}:${tile.refId}`} key={`${tile.kind}:${tile.refId}`}>
                    {tile.name ?? tile.refId}（X {tile.q} · Y {tile.r}）
                  </option>
                ))}
              </select>
            </label>
          )}

          {state.services.some((s: any) => s.category === 'escort' && state.councilLevel >= s.minCouncilLevel) && (
            <label class="task-submit-row">
              <span class="task-submit-res">护卫商队</span>
              <select class="task-submit-input" value={caravanId} disabled={buying} onChange={(e) => setCaravanId(e.currentTarget.value)}>
                <option value="">{eligibleCaravans.length ? '选择前往本村或从本村出发的送货商队' : '当前没有可护卫的送货商队'}</option>
                {eligibleCaravans.map((caravan, index) => <option key={caravan.id} value={caravan.id}>商队 {index + 1}：{caravan.originVillageName} → {caravan.destinationVillageName}</option>)}
              </select>
            </label>
          )}

          <div class="task-menu-body">
            {state.services.map((service: any) => {
              const locked = state.councilLevel < service.minCouncilLevel;
              const needsTarget = service.category === 'attack' && !target || service.category === 'escort' && !escortTarget;
              return (
                <div class="task-card task-card--side" key={service.code}>
                  <div class="task-card-head">
                    <span class="task-card-name">{service.name}</span>
                    <Tag kind="steel">{categoryName(service.category)}</Tag>
                    <Tag kind={locked ? 'ember' : 'jade'}>议会厅 Lv{service.minCouncilLevel}</Tag>
                  </div>
                  <div class="task-card-desc">{service.desc}</div>
                  <div class="task-card-prog">
                    <span class="task-prog-chip">{serviceContent(service)}</span>
                    <span class="task-prog-chip">花费声望 {service.reputationCost}</span>
                  </div>
                  <div class="task-card-actions">
                    <Btn size="sm" variant="primary" disabled={locked || needsTarget || buying} onClick={() => void buy(service)}>
                      {buying ? '购买中…' : locked ? `需 Lv${service.minCouncilLevel}` : needsTarget ? (service.category === 'escort' ? '先选择商队' : '先选择目标') : '购买'}
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>

          {(state.orders ?? []).length > 0 && (
            <>
              <h3>最近的王国服务</h3>
              {(state.orders ?? []).map((order: any) => (
                <div class="task-prog-hint" key={order.id}>
                  {order.serviceName} · {order.status === 'pending' ? `${secLeft(order.executeAt)}后出发` : order.status === 'engaging' ? '交战中' : order.status === 'completed' ? '已完成' : `失败（${order.failureReason ?? '目标失效'}，声望已退回）`}
                </div>
              ))}
            </>
          )}
          {slotId && <BuildingManagement slotId={slotId} name="议会厅" onClose={onClose} />}
        </>
      )}
    </Modal>
  );
}
