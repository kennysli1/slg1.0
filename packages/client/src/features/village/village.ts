/** 村庄页：三区结构（城镇中心 + 城内 + 城外）+ 空槽点击建造 + 多队列 + 建筑详情抽屉。 */
import { art, canAfford, costPreview, progressBar, escapeHtml, escapeAttr, unitArt, unitArtFallback } from '../../shared/ui/widgets.js';
import { showToast } from '../../shared/ui/toast.js';
import { fmt } from '../../shared/utils/format.js';
import { errText, formName } from '../../shared/ui/text.js';
import { buildingInfo, gameConstants, storageBase, storageGrowthPerLevel, smithyBonusPerLevel, wallBonusPerLevel, popHospitalRecoveryBase, popHospitalRecoveryPerLevel, popHospitalRecoveryMax, unitInfo, resourceKeys, unitCropPerHour, popCropPerLabor, resInfo, trainTimeReducePerLevel, trainTimeReduceCap, trainCostReducePerLevel, trainCostReduceCap } from '../../app/config.js';
import { getCache, setCache, interpolatePop, getPopState } from '../../app/state.js';
import { req } from '../../api.js';
import { renderPopPanel } from './population.js';
import { openMercenaryCamp } from '../army/mercenary.js';
import { openUnitDetail } from '../army/army.js';

/** 侧边栏建造抽屉的当前状态（点空槽时打开；null=关闭）。 */
let drawer: { zone: 'inner' | 'outer'; options: any[]; freeSlots: number } | null = null;
/** 仅"刚打开"这一帧带入场动画；后续 5s 全量刷新重建 DOM 时不再重放（否则每次都会滑进来"闪一下"）。 */
let drawerJustOpened = false;
/** 建造/升级动作回调（由 bindVillage 注入的 act）。 */
let actFn: ((p: Promise<any>) => void) | null = null;

export function renderVillage(): string {
  const vil = getCache().vil;
  if (!vil || !vil.zones) return '<div class="loading">加载中…</div>';

  const queueBanner = renderQueue(vil.queue);
  const popPanel = renderPopPanel();
  const center = renderCenter(vil.townCenter);
  const inner = renderZone('inner', '城内 · 民生研发', vil.zones.inner);
  const outer = renderZone('outer', '城外 · 生产量产', vil.zones.outer);

  return `${queueBanner}
    ${popPanel ? `<h3>人口 · 文明活力</h3>${popPanel}` : ''}
    ${center}
    ${outer}
    ${inner}
    ${drawer ? renderDrawer() : ''}`;
}

/** 多条建造队列进度。 */
function renderQueue(queue: any): string {
  if (!queue?.items?.length) return '';
  const items = queue.items.map((q: any) => {
    const name = buildingInfo(q.kind).name ?? q.kind;
    const verb = q.isNew ? '建造' : '升级';
    return `<div class="banner banner-build">🔨 ${verb}：<b>${name}</b> → ${q.toLevel} 级
      ${progressBar(q.startAt, q.finishAt, verb)}</div>`;
  }).join('');
  const cap = queue.capacity ?? 0;
  return `<div class="queue-wrap"><div class="queue-head">建造队列 <small>（${queue.items.length}/${cap}）</small></div>${items}</div>`;
}

/** 城镇中心卡（唯一，占整行，突出显示）。整卡可点开详情；升级按钮点击不冒泡。 */
function renderCenter(tc: any): string {
  if (!tc) return '';
  const max = tc.level >= tc.maxLevel;
  const afford = canAfford(tc.nextCost);
  const busy = tc.building;
  const progress = busy && tc.buildingStartAt && tc.buildingFinishAt
    ? progressBar(tc.buildingStartAt, tc.buildingFinishAt, '升级中')
    : '';
  const btn = max ? '<small class="tag">已满级</small>'
    : busy ? '<small class="tag">建造中</small>'
    : `<button class="btn-sm" data-up-slot="${tc.slotId}" ${!afford ? 'disabled' : ''}>升级</button>`;
  return `<h3>城镇中心</h3>
    <div class="card card-center" data-bld-slot="${tc.slotId}" title="点击查看 ${escapeAttr(tc.name)} 详情">${art(tc.icon, tc.name, 'xl')}
      <div class="cardbody"><div class="card-title">${escapeHtml(tc.name)} <b class="lv">Lv${tc.level}</b>
        <small class="bld-detail-hint">详情 ›</small></div>
        <div class="hint-sm">升级开放更多城内/城外槽位与队列</div>
        ${progress}${max || busy ? '' : costPreview(tc.nextCost, tc.nextTimeSec)}${btn}</div></div>`;
}

/** 渲染一个区：已建建筑卡 + 空槽（可点建造）。 */
function renderZone(zone: 'inner' | 'outer', title: string, z: any): string {
  if (!z) return '';
  const placed = (z.placed || []).map((p: any) => renderPlaced(p)).join('');
  // 空槽：freeSlots 个占位卡（与已建建筑同为横向布局，保持形状/高度一致）
  const empties = Array.from({ length: z.freeSlots || 0 }, () =>
    `<div class="card card-empty" data-build-zone="${zone}">
      <div class="slot-icon">＋</div>
      <div class="cardbody"><div class="card-title">空槽</div><div class="hint-sm">点击建造</div></div>
    </div>`).join('');
  return `<h3>${title} <small>（${z.placed?.length ?? 0}/${z.slots ?? 0}）</small></h3>
    <div class="grid">${placed}${empties}</div>`;
}

/** 单个已建建筑卡（含资源田；建造中/拆除中显示进度占位）。整卡可点开详情；升级按钮点击不冒泡。 */
function renderPlaced(p: any): string {
  const constructing = p.level < 1 && !p.demolishing;
  const demolishing = !!p.demolishing;
  const busy = p.building;
  const max = p.level >= p.maxLevel;
  const afford = canAfford(p.nextCost);
  const prod = !demolishing && p.producing
    ? `<div class="hint-sm prod">+${p.producing.ratePerHour}/h</div>`
    : '';
  // 本次升级（p.level → p.level+1）获得的人口增量：取目标等级 popCap；
  // 若服务端未下发 popCapByLevel（旧版本）则回退到 popCapPerLevel（=L1 popCap）。
  const _info = buildingInfo(p.kind);
  const popCap = _info.popCapByLevel?.[p.level] ?? _info.popCapPerLevel ?? 0;
  let btn: string;
  if (demolishing) btn = '<small class="tag tag-danger">拆除中</small>';
  else if (constructing) btn = '<small class="tag">建造中</small>';
  else if (max) btn = '<small class="tag">已满级</small>';
  else if (busy) btn = '<small class="tag">建造中</small>';
  else btn = `<button class="btn-sm" data-up-slot="${p.slotId}" ${!afford ? 'disabled' : ''}>升级</button>`;
  const lv = demolishing ? '拆除中' : constructing ? '建造中' : `Lv${p.level}`;
  const progress = busy && p.buildingStartAt && p.buildingFinishAt
    ? progressBar(p.buildingStartAt, p.buildingFinishAt, demolishing ? '拆除中' : constructing ? '建造中' : '升级中')
    : '';
  // 拆除中不展示升级消耗；其余照常
  const costPart = demolishing || constructing || max || busy ? '' : costPreview(p.nextCost, p.nextTimeSec, popCap);
  return `<div class="card" data-bld-slot="${p.slotId}" title="点击查看 ${escapeAttr(p.name)} 详情">${art(p.icon, p.name, 'md')}
    <div class="cardbody"><div class="card-title">${escapeHtml(p.name)} <b class="lv">${lv}</b>
      <small class="bld-detail-hint">详情 ›</small></div>
      ${prod}
      ${progress}${costPart}${btn}</div></div>`;
}

/** 侧边栏抽屉：某区可建建筑清单。整条选项可点开详情；建造按钮点击不冒泡。 */
function renderDrawer(): string {
  if (!drawer) return '';
  const opening = drawerJustOpened; // 消费一次性动画标记：只有本次是"刚打开"才带 --opening
  drawerJustOpened = false;
  const title = drawer.zone === 'inner' ? '城内可建' : '城外可建';
  const opts = drawer.options.map((o: any) => {
    const afford = canAfford(o.cost);
    const prod = o.producing ? `<span class="hint-sm prod">+${o.producing.ratePerHour}/h</span>` : '';
    // 城外可建卡片：人口增量直接并入 cost 行（图标+数字，与资源同形），不再单独一个 pill。
    // 「建造后获得的人口」= L1 popCap（= popCapPerLevel）；user override 后随 CSV/覆盖层变化。
    const _popCap = buildingInfo(o.kind).popCapPerLevel ?? 0;
    let action: string;
    if (!o.unlocked) {
      action = `<small class="tag tag-lock">${escapeHtml(o.lockReason ?? '未解锁')}</small>`;
    } else {
      action = `<button class="btn-sm" data-do-build="${o.kind}" ${!afford ? 'disabled' : ''}>建造</button>`;
    }
    return `<div class="opt ${o.unlocked ? '' : 'locked'}" data-bld-opt="${o.kind}" title="点击查看 ${escapeAttr(o.name)} 详情">${art(o.icon, o.name, 'md')}
      <div class="opt-body"><div class="opt-title">${escapeHtml(o.name)} ${prod}<small class="bld-detail-hint">详情 ›</small></div>
        ${costPreview(o.cost, o.timeSec, _popCap)}${action}</div></div>`;
  }).join('');
  return `<div class="drawer-mask" data-close-drawer="1"></div>
    <aside class="drawer${opening ? ' drawer--opening' : ''} drawer--center">
      <div class="drawer-head">${title} <small>（空槽 ${drawer.freeSlots}）</small>
        <button class="drawer-close" data-close-drawer="1">✕</button></div>
      <div class="drawer-body">${opts || '<div class="hint-sm">暂无可建建筑</div>'}</div>
    </aside>`;
}

// ---------- 建筑详情抽屉（右侧，独立单例；与军队页兵种详情一致的形态） ----------

/** 详情抽屉上下文：已建/城镇中心从布局取；空槽可建项从 options 取（level=0）。 */
interface BldDetailCtx {
  level: number;
  maxLevel?: number;
  cost?: Record<string, number> | null; // 下一级(或建造)消耗
  timeSec?: number | null;
  producing?: { ratePerHour: number } | null;
  isBuild?: boolean; // true=尚未建造(建造消耗)；false=升级消耗
  demolishing?: boolean; // 拆除进行中：期间无加成，不可取消
  buildingStartAt?: number;
  buildingFinishAt?: number;
}

/** 从当前布局缓存按 slotId 找到已建建筑/城镇中心，组装详情上下文。 */
function ctxFromSlot(slotId: string): { kind: string; ctx: BldDetailCtx; slotId: string } | null {
  const vil = getCache().vil;
  if (!vil) return null;
  const tc = vil.townCenter;
  if (tc && tc.slotId === slotId) {
    return { kind: tc.kind, slotId, ctx: { level: tc.level, maxLevel: tc.maxLevel, cost: tc.nextCost, timeSec: tc.nextTimeSec, isBuild: false } };
  }
  for (const zone of ['inner', 'outer'] as const) {
    const p = (vil.zones?.[zone]?.placed || []).find((x: any) => x.slotId === slotId);
    if (p) {
      return {
        kind: p.kind,
        slotId,
        ctx: {
          level: p.level, maxLevel: p.maxLevel, cost: p.nextCost, timeSec: p.nextTimeSec,
          producing: p.producing, isBuild: p.level < 1,
          demolishing: !!p.demolishing, buildingStartAt: p.buildingStartAt, buildingFinishAt: p.buildingFinishAt,
        },
      };
    }
  }
  return null;
}

/** 统计全村某类已建建筑（等级≥1）的总等级，用于仓储上限聚合。 */
function sumLevelsOfKind(kind: string): number {
  const vil = getCache().vil;
  if (!vil) return 0;
  let sum = 0;
  const tally = (zone: any) => {
    for (const p of (zone?.placed || []) as any[]) {
      if (p.kind === kind && (p.level ?? 0) >= 1) sum += p.level;
    }
  };
  tally(vil.zones?.inner);
  tally(vil.zones?.outer);
  return sum;
}

/**
 * 建筑"功能 · 提供"区块：按 kind 计算并展示该建筑实际提供的量化能力。
 * 仓库/粮仓→仓储上限（base×(1+Σ等级×growth)）；铁匠/城墙→百分比加成；
 * 医院→战死回收比例；居民楼→人口上限累计。其余建筑回退到"升级效果"文案（不渲染本区块）。
 */
function renderProvidesSection(kind: string, ctx: BldDetailCtx): string {
  if (!gameConstants()) return '';
  const row = (k: string, v: string) =>
    `<div class="bld-detail-row"><span class="bld-detail-k">${k}</span><span class="bld-detail-v">${v}</span></div>`;
  const capOf = (totalLv: number) => Math.round(storageBase() * (1 + totalLv * storageGrowthPerLevel()));
  const marginal = () => Math.round(storageBase() * storageGrowthPerLevel());
  const rows: string[] = [];
  switch (kind) {
    case 'warehouse': {
      rows.push(row('木 · 泥 · 铁 上限（全村）', String(capOf(sumLevelsOfKind('warehouse')))));
      rows.push(row(ctx.level >= 1 ? '本建筑贡献' : '建成 Lv1 贡献', `+${marginal() * (ctx.level >= 1 ? ctx.level : 1)}`));
      break;
    }
    case 'granary': {
      rows.push(row('粮食 上限（全村）', String(capOf(sumLevelsOfKind('granary')))));
      rows.push(row(ctx.level >= 1 ? '本建筑贡献' : '建成 Lv1 贡献', `+${marginal() * (ctx.level >= 1 ? ctx.level : 1)}`));
      break;
    }
    case 'smithy': {
      rows.push(row('全军攻防加成', `+${(ctx.level * smithyBonusPerLevel() * 100).toFixed(0)}%`));
      break;
    }
    case 'wall': {
      rows.push(row('守城防御加成', `+${(ctx.level * wallBonusPerLevel() * 100).toFixed(0)}%`));
      break;
    }
    case 'hospital': {
      const ratio = Math.min(popHospitalRecoveryMax(), popHospitalRecoveryBase() + ctx.level * popHospitalRecoveryPerLevel()) * 100;
      rows.push(row('战死士兵回收', `${ratio.toFixed(0)}%`));
      break;
    }
    case 'residence': {
      const info = buildingInfo('residence');
      const cum = info.popCapByLevel
        ? info.popCapByLevel.slice(0, ctx.level).reduce((a, b) => a + b, 0)
        : (info.popCapPerLevel ?? 0) * ctx.level;
      rows.push(row('人口上限（本建筑累计）', `👥 +${cum}`));
      break;
    }
    default:
      return '';
  }
  if (!rows.length) return '';
  return `<div class="drawer-sec-title">功能 · 提供</div>${rows.join('')}`;
}

/** 打开建筑详情抽屉：简介 + 升级效果 + 当前等级 + 下一级(建造)消耗。注入 body，避免被 5s 刷新重建。
 *  slotId 提供时若是军事训练建筑（兵营/马厩/兵工厂/城镇中心），额外内嵌训练区。 */
function openBuildingDetail(kind: string, ctx: BldDetailCtx, slotId?: string): void {
  closeBuildingDetail(); // 单例
  const info = buildingInfo(kind);
  const max = ctx.maxLevel != null && ctx.level >= ctx.maxLevel;
  const isMain = kind === 'main';

  // 训练区仅对军事训练建筑（其详情抽屉内嵌训练 UI）展示
  const army = getCache().army;
  const isTrainer = !!(slotId && army?.slots?.some((s: any) => s.slotId === slotId));
  const trainSectionHtml = isTrainer && !ctx.demolishing
    ? `<div class="drawer-sec-title">训练 <small>（本建筑独立队列 · 升级可提速降费）</small></div><div id="bld-train-sec" class="bld-train-sec"><div class="loading">加载中…</div></div>`
    : '';

  // 等级行
  const lvStr = ctx.demolishing
    ? '拆除中'
    : ctx.isBuild
      ? '尚未建造'
      : `Lv${ctx.level}${ctx.maxLevel ? ` / ${ctx.maxLevel}` : ''}`;

  // 消耗区标题 + 内容（拆除中/建造中均不展示）
  let costSec = '';
  if (ctx.demolishing) {
    costSec = `<div class="drawer-sec-title">拆除中</div><div class="hint-sm">建筑正在拆除，期间不提供任何加成，且不可取消。完成后整栋消失、槽位释放。</div>`;
  } else if (max) {
    costSec = `<div class="drawer-sec-title">已满级</div><div class="hint-sm">该建筑已达最高等级，无需继续升级。</div>`;
  } else if (ctx.cost) {
    const label = ctx.isBuild ? '建造消耗' : `升级到 Lv${ctx.level + 1} 消耗`;
    costSec = `<div class="drawer-sec-title">${label}</div>${costPreview(ctx.cost, ctx.timeSec)}`;
  }

  const prodSec = !ctx.demolishing && ctx.producing
    ? `<div class="bld-detail-row"><span class="bld-detail-k">当前产量</span><span class="bld-detail-v">+${ctx.producing.ratePerHour}/h</span></div>`
    : '';

  const providesSec = ctx.demolishing ? '' : renderProvidesSection(kind, ctx);

  const _dinfo2 = buildingInfo(kind);
  const _pcb = _dinfo2.popCapByLevel;
  const _nextLevel = ctx.level + 1;
  // 增量 = 目标等级 popCap；累计 = Σ 1..nextLevel popCap（用 popCapByLevel 求和，对可变 popCap 正确）
  const _inc = _pcb?.[_nextLevel - 1] ?? _dinfo2.popCapPerLevel ?? 0;
  const _cum = _pcb
    ? _pcb.slice(0, _nextLevel).reduce((a, b) => a + b, 0)
    : (_dinfo2.popCapPerLevel ?? 0) * _nextLevel;
  const _hasPopCap = (_dinfo2.popCapPerLevel ?? 0) > 0 || (_pcb?.some((v) => v > 0) ?? false);
  const _lvLabel = ctx.isBuild ? `建造到 Lv${_nextLevel}` : `升至 Lv${_nextLevel}`;
  const popCapSec = !ctx.demolishing && _hasPopCap
    ? `<div class="bld-detail-row"><span class="bld-detail-k">${_lvLabel} 增量</span><span class="bld-detail-v"><span class="popcap-icon" aria-label="人口">👥</span>+${_inc}</span></div>
       <div class="bld-detail-row"><span class="bld-detail-k">${_lvLabel} 累计</span><span class="bld-detail-v"><span class="popcap-icon" aria-label="人口">👥</span>+${_cum}</span></div>`
    : '';

  // 拆除进度条（拆除中）
  const demoProgress = ctx.demolishing && ctx.buildingStartAt && ctx.buildingFinishAt
    ? `<div class="drawer-sec-title">拆除进度</div>${progressBar(ctx.buildingStartAt, ctx.buildingFinishAt, '拆除中')}`
    : '';

  // 拆除按钮区（仅已建成、非城镇中心、未在拆除中）
  const demolishArea = !ctx.demolishing && !isMain && slotId
    ? `<div class="drawer-sec-title">危险操作</div>
       <div id="bld-demolish-zone">
         <button type="button" class="btn-sm btn-danger" data-demolish="${slotId}">拆除建筑</button>
       </div>`
    : '';

  const wrap = document.createElement('div');
  wrap.id = 'building-detail-modal';
  wrap.innerHTML = `
    <div class="drawer-mask" data-close-bld="1"></div>
    <aside class="drawer drawer--opening bld-drawer drawer--center" role="dialog" aria-modal="true">
      <div class="drawer-head">
        ${art(info.icon, info.name, 'sm')}
        <span class="bld-drawer-name">${escapeHtml(info.name)}</span>
        <small class="tag">${lvStr}</small>
        <button class="drawer-close" data-close-bld="1" aria-label="关闭">✕</button>
      </div>
      <div class="drawer-body">
        <div class="drawer-sec-title">简介</div>
        <div class="bld-detail-desc">${escapeHtml(info.desc || '这栋建筑暂无简介。')}</div>
        <div class="drawer-sec-title">升级效果</div>
        <div class="bld-detail-desc">${escapeHtml(info.effect || '每级提升该建筑的相关能力。')}</div>
        ${providesSec}
        ${prodSec}
        ${popCapSec}
        ${demoProgress}
        ${costSec}
        ${demolishArea}
        ${trainSectionHtml}
      </div>
    </aside>`;
  document.body.appendChild(wrap);

  wrap.querySelectorAll<HTMLElement>('[data-close-bld]').forEach((el) =>
    el.onclick = () => closeBuildingDetail());

  // 拆除：二级确认（提示"整个建筑将完全拆除"，不可取消）
  const demoBtn = wrap.querySelector<HTMLButtonElement>('[data-demolish]');
  if (demoBtn) {
    demoBtn.onclick = () => {
      const zone = document.getElementById('bld-demolish-zone');
      if (!zone) return;
      zone.innerHTML = `<div class="confirm-warn">⚠️ 整个建筑将完全拆除，不消耗也不返还资源，且<b>不可取消</b>。拆除期间不提供任何加成。</div>
        <div class="confirm-actions">
          <button type="button" class="btn-sm btn-danger" data-demolish-confirm="${demoBtn.dataset.demolish}">确认拆除</button>
          <button type="button" class="btn-sm" data-demolish-cancel="1">取消</button>
        </div>`;
      zone.querySelector<HTMLButtonElement>('[data-demolish-confirm]')!.onclick = () => {
        if (actFn) actFn(req('DemolishBuilding', { slotId: demoBtn.dataset.demolish! }));
        closeBuildingDetail();
      };
      zone.querySelector<HTMLButtonElement>('[data-demolish-cancel]')!.onclick = () => {
        zone.innerHTML = `<button type="button" class="btn-sm btn-danger" data-demolish="${demoBtn.dataset.demolish}">拆除建筑</button>`;
        const again = wrap.querySelector<HTMLButtonElement>('[data-demolish]');
        if (again) again.onclick = demoBtn.onclick;
      };
    };
  }

  if (isTrainer && !ctx.demolishing && slotId) void renderBuildingTrainSection(slotId);
}

/** 当前打开的军事建筑训练 slotId（供全局 push 触发刷新）。 */
let currentTrainSlotId: string | null = null;

function closeBuildingDetail(): void {
  document.getElementById('building-detail-modal')?.remove();
  currentTrainSlotId = null;
}

// Esc 关闭建筑详情（装一次即可，全程有效）
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeBuildingDetail();
  });
}

/**
 * 拉取最新军队数据并渲染某军事建筑实例的训练区（兵种卡 + 本建筑独立队列）。
 * 兵种造价/耗时已由服务端按该建筑当前等级折算（升级→提速+降费）。
 */
async function renderBuildingTrainSection(slotId: string): Promise<void> {
  const sec = document.getElementById('bld-train-sec');
  if (!sec) return;
  currentTrainSlotId = slotId;

  const res = await req('GetArmy');
  if (!res.ok) { sec.innerHTML = `<div class="hint-sm">加载失败：${escapeHtml(res.error?.code ?? '未知')}</div>`; return; }
  // 合并而非整体替换：setCache 会整体覆盖 cache，若只传 {army} 会清掉 res/vil/area/moves，
  // 导致资源条/买得起判定读到 undefined → 误报「资源不足」且资源芯片标红。
  setCache({ ...getCache(), army: res.payload });
  const army: any = res.payload;
  const slot = (army.slots || []).find((s: any) => s.slotId === slotId);
  if (!slot) { sec.innerHTML = '<div class="hint-sm">该建筑暂不提供训练</div>'; return; }

  // 本建筑独立训练队列进度横幅
  let banner = '';
  if (slot.training) {
    const u = (slot.trainable || []).find((t: any) => t.key === slot.training.unit);
    banner = `<div class="banner banner-train">🎯 训练中：<b>${escapeHtml(u?.name ?? slot.training.unit)}</b> ×${slot.training.remaining}
      ${progressBar(slot.training.nextDoneAt - (u?.trainSec ?? 30) * 1000, slot.training.nextDoneAt, '下一个')}</div>`;
  }

  // 军事建筑训练提速/降费：固定为建筑等级的纯函数（与兵种无关），直接按配置因子展示固定减幅
  const timeRpl = trainTimeReducePerLevel();
  const timeCap = trainTimeReduceCap();
  const costRpl = trainCostReducePerLevel();
  const costCap = trainCostReduceCap();

  const cards = (slot.trainable || []).map((u: any) => {
    const unlocked = u.unlocked !== false;
    const popCost = unitInfo(u.key).popCost;
    const perGrain = unitCropPerHour(u.key);
    let bonus = '';
    const lvl = u.level ?? 1;
    const tPct = Math.round(Math.min(timeCap, Math.max(0, lvl - 1) * timeRpl) * 100);
    const cPct = Math.round(Math.min(costCap, Math.max(0, lvl - 1) * costRpl) * 100);
    if (tPct > 0 || cPct > 0) bonus = `<small class="tag tag-bonus">本建筑 Lv${lvl} · 训练 -${tPct}% · 资源 -${cPct}%</small>`;
    const action = unlocked
      ? `<div class="cost-slot" id="bld-cost-${u.key}">${costPreview(u.cost, u.trainSec)}</div>
        <div class="train-controls">
          <div class="pop-warn" id="bld-pop-warn-${u.key}"></div>
          <div class="train-row">
            <button type="button" class="step-btn" data-bld-step="-1" data-unit="${u.key}" aria-label="减少数量">−</button>
            <input type="number" min="1" value="1" id="bld-cnt-${u.key}" data-bld-unit="${u.key}" aria-label="训练数量" />
            <button type="button" class="step-btn" data-bld-step="1" data-unit="${u.key}" aria-label="增加数量">+</button>
          </div>
          <button type="button" class="btn-sm btn-train" data-bld-train="${u.key}">训练</button>
          <div class="train-meta">
            <span class="cost-item" title="训练此批次消耗人口">人口 <b id="bld-popcost-${u.key}">${popCost}</b></span>
            ${perGrain > 0 ? `<span class="cost-item grain-chip" title="兵种军晌">${art(resInfo('crop').icon, '耗粮', 'xs')}<b>${u.upkeep ?? 0}</b>/h·兵</span>` : ''}
          </div>
        </div>${bonus}`
      : `<div class="cost-slot">${costPreview(u.cost, u.trainSec)}</div>
        <small class="tag tag-lock">${escapeHtml(u.lockReason ?? '未解锁')}</small>`;
    return `<div class="card unit-card${unlocked ? '' : ' locked'}" data-unit-detail="${u.key}" title="点击查看 ${escapeAttr(u.name)} 详细属性">
      <div class="unit-head">
        ${art(unitArt(u.key), u.name, 'lg', unitArtFallback(u.key))}
        <div class="card-title">${escapeHtml(u.name)} <small class="tag">${formName(u.form)}</small>
          <small class="unit-detail-hint">详情 ›</small>
        </div>
      </div>
      ${action}
    </div>`;
  }).join('');

  sec.innerHTML = `${banner}<div class="grid grid-units">${cards || '<div class="hint-sm">暂无可训练兵种</div>'}</div>`;
  bindBuildingTrainSection(sec, slot);
}

/** 绑定训练区交互（兵种详情 / 训练 / 步进 / 数量重算）。 */
function bindBuildingTrainSection(sec: HTMLElement, slot: any): void {
  // 兵种详情抽屉：仅点卡片头部（图标+名称）才打开；点到训练区（消耗预览/数量/步进/训练按钮/人口提示）不触发
  sec.querySelectorAll<HTMLElement>('[data-unit-detail]').forEach((el) =>
    el.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('.train-controls')) return;
      openUnitDetail(el.dataset.unitDetail!);
    });

  // 训练按钮
  sec.querySelectorAll<HTMLButtonElement>('[data-bld-train]').forEach((b) =>
    b.onclick = () => {
      const cur = getCache().army?.slots?.find((s: any) => s.slotId === currentTrainSlotId);
      if (cur?.training) { showToast('该建筑正在训练中，请等当前批次完成'); return; }
      const u = b.dataset.bldTrain!;
      const inp = document.getElementById(`bld-cnt-${u}`) as HTMLInputElement;
      const cnt = Math.max(1, Math.floor(Number(inp?.value || 1)));
      const def = (slot.trainable || []).find((x: any) => x.key === u);
      if (!def) { showToast('该兵种暂不可训练'); return; }
      if (def.unlocked === false) { showToast(def.lockReason ? String(def.lockReason) : '前置建筑未满足'); return; }
      const total: Record<string, number> = {};
      for (const r of resourceKeys()) total[r] = (def.cost[r] ?? 0) * cnt;
      if (!canAfford(total)) { showToast('资源不足，无法训练'); return; }
      const needPop = unitInfo(u).popCost * cnt;
      const currentPop = interpolatePop();
      if (getPopState() && currentPop < needPop) {
        showToast(`可用人口不足：需 ${needPop}，当前平民 ${fmt(currentPop)}`);
        return;
      }
      // ③ 动员上限：士兵足迹（含训练中）超过本族 popRaceMobilizeMax × 总人口则拦截，给出明确提示
      const psMob = getPopState();
      if (psMob) {
        const footprint = (psMob.soldierPop ?? 0) + (psMob.trainingPop ?? 0);
        const maxSoldier = (psMob.mobilizeCap ?? 0) * (psMob.totalPop ?? 0);
        if (footprint + needPop > maxSoldier + 1e-9) {
          showToast(`超过本族动员上限（${Math.round((psMob.mobilizeCap ?? 0) * 100)}%），无法继续训练`);
          return;
        }
      }
      const r = req('TrainTroops', { slotId: currentTrainSlotId!, unit: u, count: cnt });
      if (actFn) {
        void actFn(r);
        void renderBuildingTrainSection(currentTrainSlotId!); // 重新拉取以显示新队列
      }
    });

  // 数量步进
  sec.querySelectorAll<HTMLButtonElement>('[data-bld-step]').forEach((b) => {
    b.onclick = () => {
      const unit = b.dataset.unit!;
      const inp = document.getElementById(`bld-cnt-${unit}`) as HTMLInputElement | null;
      if (!inp) return;
      const step = Number(b.dataset.bldStep) || 0;
      const cur = Math.max(1, Math.floor(Number(inp.value) || 1));
      inp.value = String(Math.max(1, cur + step));
      updateBldTrainCost(unit, sec, slot);
    };
  });
  sec.querySelectorAll<HTMLInputElement>('input[data-bld-unit]').forEach((inp) => {
    inp.oninput = () => updateBldTrainCost(inp.dataset.bldUnit!, sec, slot);
    updateBldTrainCost(inp.dataset.bldUnit!, sec, slot);
  });
}

/** 训练数量变化时，按总价重算消耗预览、人口需求。 */
function updateBldTrainCost(unit: string, sec: HTMLElement, slot: any): void {
  const u = (slot.trainable || []).find((x: any) => x.key === unit);
  if (!u) return;
  const inp = document.getElementById(`bld-cnt-${unit}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
  const total: Record<string, number> = {};
  for (const r of resourceKeys()) total[r] = (u.cost[r] ?? 0) * cnt;
  const slotEl = sec.querySelector<HTMLElement>(`#bld-cost-${unit}`);
  if (slotEl) slotEl.innerHTML = costPreview(total, u.trainSec * cnt);
  const popCostEl = sec.querySelector<HTMLElement>(`#bld-popcost-${unit}`);
  if (popCostEl) popCostEl.textContent = String(unitInfo(unit).popCost * cnt);
  const ps = getPopState();
  const warn = sec.querySelector<HTMLElement>(`#bld-pop-warn-${unit}`);
  const totalPop = unitInfo(unit).popCost * cnt;
  const currentPop = interpolatePop();
  if (warn) {
    if (ps && currentPop < totalPop) {
      warn.textContent = `可用人口不足：需 ${totalPop}，当前平民 ${fmt(currentPop)}`;
    } else if (ps) {
      // ③ 动员上限：士兵足迹（驻军+在途+训练中）+ 本次转化后，不得超过本族 popRaceMobilizeMax × 总人口
      const footprint = (ps.soldierPop ?? 0) + (ps.trainingPop ?? 0);
      const maxSoldier = (ps.mobilizeCap ?? 0) * (ps.totalPop ?? 0);
      if (footprint + totalPop > maxSoldier + 1e-9) {
        warn.textContent = `超过本族动员上限（上限 ${Math.round((ps.mobilizeCap ?? 0) * 100)}% 总人口）：士兵足迹 ${fmt(footprint + totalPop)} / 上限 ${fmt(Math.round(maxSoldier))}`;
      } else if (ps.inFamine) {
        warn.textContent = '⚠️ 当前处于饥荒，人口正在减少，谨慎训练';
      } else {
        warn.textContent = '';
      }
    } else {
      warn.textContent = '';
    }
  }
}

/** 由全局 push（TroopTrained / BuildingUpgraded）触发：训练抽屉打开时刷新内容。 */
export function refreshTrainingIfOpen(): void {
  if (currentTrainSlotId && document.getElementById('bld-train-sec')) {
    void renderBuildingTrainSection(currentTrainSlotId);
  }
}

/** 绑定村庄页交互。act 为统一的"发请求并刷新"回调。 */
export function bindVillage(act: (p: Promise<any>) => void): void {
  actFn = act;

  // 升级（城镇中心/已建建筑/资源田，统一走 slotId）
  document.querySelectorAll<HTMLButtonElement>('[data-up-slot]').forEach((b) =>
    b.onclick = () => act(req('UpgradeBuilding', { slotId: b.dataset.upSlot })));

  // 整卡可点开建筑详情（点到卡内按钮不触发）；雇佣兵营地则打开招募 UI
  document.querySelectorAll<HTMLElement>('[data-bld-slot]').forEach((el) =>
    el.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('button')) return; // 升级按钮：不展开详情
      const found = ctxFromSlot(el.dataset.bldSlot!);
      if (!found) return;
      if (found.kind === 'mercenarycamp') { openMercenaryCamp(act); return; }
      openBuildingDetail(found.kind, found.ctx, found.slotId);
    });

  // 点空槽 → 队列满则提示；否则拉该区可建清单 → 打开抽屉
  document.querySelectorAll<HTMLElement>('[data-build-zone]').forEach((el) =>
    el.onclick = async () => {
      const q = getCache().vil?.queue;
      if (q && q.items?.length >= (q.capacity ?? 0)) {
        showToast('当前队列已满，请稍后添加');
        return;
      }
      const zone = el.dataset.buildZone as 'inner' | 'outer';
      const res = await req('GetBuildOptions', { zone });
      if (!res.ok) return;
      const p = res.payload as any;
      drawer = { zone, options: p.options ?? [], freeSlots: p.freeSlots ?? 0 };
      drawerJustOpened = true;
      rerenderPage();
    });

  // 建造抽屉内：整条可建选项点开详情（点到建造按钮不触发）
  document.querySelectorAll<HTMLElement>('[data-bld-opt]').forEach((el) =>
    el.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('button')) return; // 建造按钮：不展开详情
      const o = (drawer?.options || []).find((x: any) => x.kind === el.dataset.bldOpt);
      if (o) openBuildingDetail(o.kind, { level: 0, cost: o.cost, timeSec: o.timeSec, producing: o.producing, isBuild: true });
    });

  // 抽屉内点"建造"
  document.querySelectorAll<HTMLButtonElement>('[data-do-build]').forEach((b) =>
    b.onclick = () => {
      const kind = b.dataset.doBuild!;
      const zone = drawer?.zone;
      drawer = null;
      if (actFn && zone) actFn(req('Build', { zone, kind }));
    });

  // 关闭抽屉
  document.querySelectorAll<HTMLElement>('[data-close-drawer]').forEach((el) =>
    el.onclick = () => { drawer = null; rerenderPage(); });
}

/** 抽屉开合只影响村庄页局部，重渲染 #page 即可（不触发全量 refresh）。 */
function rerenderPage(): void {
  const page = document.getElementById('page');
  if (!page) return;
  page.innerHTML = renderVillage();
  if (actFn) bindVillage(actFn);
}
