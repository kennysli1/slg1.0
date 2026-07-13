/** 村庄页：三区结构（城镇中心 + 城内 + 城外）+ 空槽点击建造 + 多队列。 */
import { art, canAfford, costPreview, progressBar } from '../../shared/ui/widgets.js';
import { buildingInfo } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';

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
  const center = renderCenter(vil.townCenter);
  const inner = renderZone('inner', '城内 · 民生研发', vil.zones.inner);
  const outer = renderZone('outer', '城外 · 生产量产', vil.zones.outer);

  return `${queueBanner}
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

/** 城镇中心卡（唯一，占整行，突出显示）。 */
function renderCenter(tc: any): string {
  if (!tc) return '';
  const max = tc.level >= tc.maxLevel;
  const afford = canAfford(tc.nextCost);
  const busy = tc.building;
  const btn = max ? '<small class="tag">已满级</small>'
    : busy ? '<small class="tag">建造中</small>'
    : `<button class="btn-sm" data-up-slot="${tc.slotId}" ${!afford ? 'disabled' : ''}>升级</button>`;
  return `<h3>城镇中心</h3>
    <div class="grid"><div class="card card-center">${art(tc.icon, tc.name, 'lg')}
      <div class="cardbody"><div class="card-title">${tc.name} <b class="lv">Lv${tc.level}</b></div>
        <div class="hint-sm">升级开放更多城内/城外槽位与队列</div>
        ${max || busy ? '' : costPreview(tc.nextCost, tc.nextTimeSec)}${btn}</div></div></div>`;
}

/** 渲染一个区：已建建筑卡 + 空槽（可点建造）。 */
function renderZone(zone: 'inner' | 'outer', title: string, z: any): string {
  if (!z) return '';
  const placed = (z.placed || []).map((p: any) => renderPlaced(p)).join('');
  // 空槽：freeSlots 个"＋"占位
  const empties = Array.from({ length: z.freeSlots || 0 }, () =>
    `<div class="card card-empty" data-build-zone="${zone}">
      <div class="slot-plus">＋</div><div class="hint-sm">空槽 · 点击建造</div></div>`).join('');
  return `<h3>${title} <small>（${z.placed?.length ?? 0}/${z.slots ?? 0}）</small></h3>
    <div class="grid">${placed}${empties}</div>`;
}

/** 单个已建建筑卡（含资源田；建造中显示进度占位）。 */
function renderPlaced(p: any): string {
  const constructing = p.level < 1;
  const busy = p.building;
  const max = p.level >= p.maxLevel;
  const afford = canAfford(p.nextCost);
  const prod = p.producing
    ? `<div class="hint-sm prod">+${p.producing.ratePerHour}/h</div>`
    : '';
  let btn: string;
  if (constructing) btn = '<small class="tag">建造中</small>';
  else if (max) btn = '<small class="tag">已满级</small>';
  else if (busy) btn = '<small class="tag">建造中</small>';
  else btn = `<button class="btn-sm" data-up-slot="${p.slotId}" ${!afford ? 'disabled' : ''}>升级</button>`;
  const lv = constructing ? '建造中' : `Lv${p.level}`;
  return `<div class="card">${art(p.icon, p.name, 'md')}
    <div class="cardbody"><div class="card-title">${p.name} <b class="lv">${lv}</b></div>
      ${prod}
      ${constructing || max || busy ? '' : costPreview(p.nextCost, p.nextTimeSec)}${btn}</div></div>`;
}

/** 侧边栏抽屉：某区可建建筑清单。 */
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
      action = `<small class="tag tag-lock">${o.lockReason ?? '未解锁'}</small>`;
    } else {
      action = `<button class="btn-sm" data-do-build="${o.kind}" ${!afford ? 'disabled' : ''}>建造</button>`;
    }
    return `<div class="opt ${o.unlocked ? '' : 'locked'}">${art(o.icon, o.name, 'md')}
      <div class="opt-body"><div class="opt-title">${o.name} ${prod}</div>
        ${costPreview(o.cost, o.timeSec)}${action}</div></div>`;
  }).join('');
  return `<div class="drawer-mask" data-close-drawer="1"></div>
    <aside class="drawer${opening ? ' drawer--opening' : ''}">
      <div class="drawer-head">${title} <small>（空槽 ${drawer.freeSlots}）</small>
        <button class="drawer-close" data-close-drawer="1">✕</button></div>
      <div class="drawer-body">${opts || '<div class="hint-sm">暂无可建建筑</div>'}</div>
    </aside>`;
}

/** 绑定村庄页交互。act 为统一的"发请求并刷新"回调。 */
export function bindVillage(act: (p: Promise<any>) => void): void {
  actFn = act;

  // 升级（城镇中心/已建建筑/资源田，统一走 slotId）
  document.querySelectorAll<HTMLButtonElement>('[data-up-slot]').forEach((b) =>
    b.onclick = () => act(req('UpgradeBuilding', { slotId: b.dataset.upSlot })));

  // 点空槽 → 拉该区可建清单 → 打开抽屉
  document.querySelectorAll<HTMLElement>('[data-build-zone]').forEach((el) =>
    el.onclick = async () => {
      const zone = el.dataset.buildZone as 'inner' | 'outer';
      const res = await req('GetBuildOptions', { zone });
      if (!res.ok) return;
      const p = res.payload as any;
      drawer = { zone, options: p.options ?? [], freeSlots: p.freeSlots ?? 0 };
      drawerJustOpened = true;
      rerenderPage();
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
