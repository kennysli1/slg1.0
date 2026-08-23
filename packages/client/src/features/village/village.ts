/** 村庄页：三区结构（城镇中心 + 城内 + 城外）+ 空槽点击建造 + 多队列 + 建筑详情抽屉。 */
import { art, canAfford, costPreview, progressBar, escapeHtml, escapeAttr } from '../../shared/ui/widgets.js';
import { showToast } from '../../shared/ui/toast.js';
import { buildingInfo } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';
import { renderPopPanel } from './population.js';

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
    const verb = q.repair ? '修复' : q.isNew ? '建造' : '升级';
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

/** 单个已建建筑卡（含资源田；建造中显示进度占位）。整卡可点开详情；升级按钮点击不冒泡。 */
function renderPlaced(p: any): string {
  const damaged = !!p.repairTargetLevel || !!p.damaged;
  const constructing = p.level < 1 && !damaged;
  const busy = p.building;
  const max = p.level >= p.maxLevel;
  const afford = canAfford(p.nextCost);
  const repairAfford = canAfford(p.repairCost ?? null);
  const prod = p.producing
    ? `<div class="hint-sm prod">+${p.producing.ratePerHour}/h</div>`
    : '';
  let btn: string;
  if (constructing) btn = '<small class="tag">建造中</small>';
  else if (damaged && busy) btn = '<small class="tag">修复中</small>';
  else if (damaged) btn = `<button class="btn-sm" data-repair-slot="${p.slotId}" ${!repairAfford ? 'disabled' : ''}>修复至 Lv${p.repairTargetLevel}</button>`;
  else if (max) btn = '<small class="tag">已满级</small>';
  else if (busy) btn = '<small class="tag">建造中</small>';
  else btn = `<button class="btn-sm" data-up-slot="${p.slotId}" ${!afford ? 'disabled' : ''}>升级</button>`;
  const lv = damaged ? `已破坏 · Lv${p.level}` : constructing ? '建造中' : `Lv${p.level}`;
  const progress = busy && p.buildingStartAt && p.buildingFinishAt
    ? progressBar(p.buildingStartAt, p.buildingFinishAt, damaged ? '修复中' : constructing ? '建造中' : '升级中')
    : '';
  return `<div class="card" data-bld-slot="${p.slotId}" title="点击查看 ${escapeAttr(p.name)} 详情">${art(p.icon, p.name, 'md')}
    <div class="cardbody"><div class="card-title">${escapeHtml(p.name)} <b class="lv">${lv}</b>
      <small class="bld-detail-hint">详情 ›</small></div>
      ${prod}
      ${progress}${damaged && !busy ? costPreview(p.repairCost, p.repairTimeSec) : constructing || max || busy ? '' : costPreview(p.nextCost, p.nextTimeSec)}${btn}</div></div>`;
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
    let action: string;
    if (!o.unlocked) {
      action = `<small class="tag tag-lock">${escapeHtml(o.lockReason ?? '未解锁')}</small>`;
    } else {
      action = `<button class="btn-sm" data-do-build="${o.kind}" ${!afford ? 'disabled' : ''}>建造</button>`;
    }
    return `<div class="opt ${o.unlocked ? '' : 'locked'}" data-bld-opt="${o.kind}" title="点击查看 ${escapeAttr(o.name)} 详情">${art(o.icon, o.name, 'md')}
      <div class="opt-body"><div class="opt-title">${escapeHtml(o.name)} ${prod}<small class="bld-detail-hint">详情 ›</small></div>
        ${costPreview(o.cost, o.timeSec)}${action}</div></div>`;
  }).join('');
  return `<div class="drawer-mask" data-close-drawer="1"></div>
    <aside class="drawer${opening ? ' drawer--opening' : ''}">
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
  repairCost?: Record<string, number> | null;
  repairTimeSec?: number | null;
  repairTargetLevel?: number;
  damaged?: boolean;
  producing?: { ratePerHour: number } | null;
  isBuild?: boolean; // true=尚未建造(建造消耗)；false=升级消耗
}

/** 从当前布局缓存按 slotId 找到已建建筑/城镇中心，组装详情上下文。 */
function ctxFromSlot(slotId: string): { kind: string; ctx: BldDetailCtx } | null {
  const vil = getCache().vil;
  if (!vil) return null;
  const tc = vil.townCenter;
  if (tc && tc.slotId === slotId) {
    return { kind: tc.kind, ctx: { level: tc.level, maxLevel: tc.maxLevel, cost: tc.nextCost, timeSec: tc.nextTimeSec, isBuild: false } };
  }
  for (const zone of ['inner', 'outer'] as const) {
    const p = (vil.zones?.[zone]?.placed || []).find((x: any) => x.slotId === slotId);
    if (p) {
      return {
        kind: p.kind,
        ctx: { level: p.level, maxLevel: p.maxLevel, cost: p.nextCost, timeSec: p.nextTimeSec, repairCost: p.repairCost, repairTimeSec: p.repairTimeSec, repairTargetLevel: p.repairTargetLevel, damaged: !!p.damaged || p.repairTargetLevel != null, producing: p.producing, isBuild: p.level < 1 },
      };
    }
  }
  return null;
}

/** 打开建筑详情抽屉：简介 + 升级效果 + 当前等级 + 下一级(建造)消耗。注入 body，避免被 5s 刷新重建。 */
function openBuildingDetail(kind: string, ctx: BldDetailCtx): void {
  closeBuildingDetail(); // 单例
  const info = buildingInfo(kind);
  const max = ctx.maxLevel != null && ctx.level >= ctx.maxLevel;

  // 等级行
  const lvStr = ctx.damaged
    ? `已破坏 · 可修复至 Lv${ctx.repairTargetLevel}`
    : ctx.isBuild
    ? '尚未建造'
    : `Lv${ctx.level}${ctx.maxLevel ? ` / ${ctx.maxLevel}` : ''}`;

  // 消耗区标题 + 内容
  let costSec = '';
  if (max) {
    costSec = `<div class="drawer-sec-title">已满级</div><div class="hint-sm">该建筑已达最高等级，无需继续升级。</div>`;
  } else if (ctx.damaged && ctx.repairCost) {
    costSec = `<div class="drawer-sec-title">修复至 Lv${ctx.repairTargetLevel} 消耗</div>${costPreview(ctx.repairCost, ctx.repairTimeSec)}`;
  } else if (ctx.cost) {
    const label = ctx.isBuild ? '建造消耗' : `升级到 Lv${ctx.level + 1} 消耗`;
    costSec = `<div class="drawer-sec-title">${label}</div>${costPreview(ctx.cost, ctx.timeSec)}`;
  }

  const prodSec = ctx.producing
    ? `<div class="bld-detail-row"><span class="bld-detail-k">当前产量</span><span class="bld-detail-v">+${ctx.producing.ratePerHour}/h</span></div>`
    : '';

  const wrap = document.createElement('div');
  wrap.id = 'building-detail-modal';
  wrap.innerHTML = `
    <div class="drawer-mask" data-close-bld="1"></div>
    <aside class="drawer drawer--opening bld-drawer" role="dialog" aria-modal="true">
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
        ${prodSec}
        ${costSec}
      </div>
    </aside>`;
  document.body.appendChild(wrap);

  wrap.querySelectorAll<HTMLElement>('[data-close-bld]').forEach((el) =>
    el.onclick = () => closeBuildingDetail());
}

function closeBuildingDetail(): void {
  document.getElementById('building-detail-modal')?.remove();
}

// Esc 关闭建筑详情（装一次即可，全程有效）
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeBuildingDetail();
  });
}

/** 绑定村庄页交互。act 为统一的"发请求并刷新"回调。 */
export function bindVillage(act: (p: Promise<any>) => void): void {
  actFn = act;

  // 升级（城镇中心/已建建筑/资源田，统一走 slotId）
  document.querySelectorAll<HTMLButtonElement>('[data-up-slot]').forEach((b) =>
    b.onclick = () => act(req('UpgradeBuilding', { slotId: b.dataset.upSlot })));
  document.querySelectorAll<HTMLButtonElement>('[data-repair-slot]').forEach((b) =>
    b.onclick = () => act(req('RepairBuilding', { slotId: b.dataset.repairSlot })));

  // 整卡可点开建筑详情（点到卡内按钮不触发）
  document.querySelectorAll<HTMLElement>('[data-bld-slot]').forEach((el) =>
    el.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('button')) return; // 升级按钮：不展开详情
      const found = ctxFromSlot(el.dataset.bldSlot!);
      if (found) openBuildingDetail(found.kind, found.ctx);
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
