/** 村庄页：资源田 + 中心建筑升级。 */
import { art, canAfford, costPreview, progressBar } from '../../shared/ui/widgets.js';
import { fieldInfo, buildingInfo } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';

export function renderVillage(): string {
  const vil = getCache().vil;
  if (!vil) return '<div class="loading">加载中…</div>';
  const q = vil.queue;
  const banner = q
    ? `<div class="banner banner-build">🔨 建造中：<b>${fieldInfo(q.target).name ?? buildingInfo(q.target).name ?? q.target}</b> → ${q.toLevel} 级
        ${progressBar(q.startAt, q.finishAt, '建造')}</div>`
    : '';

  const fields = vil.fields.map((f: any, i: number) => {
    const max = f.level >= f.maxLevel;
    const afford = canAfford(f.nextCost);
    const fi = fieldInfo(f.type);
    const fname = f.name ?? fi.name ?? f.type;
    const ficon = f.icon ?? fi.icon ?? 'field_woodcutter';
    const btn = max ? '<small class="tag">已满级</small>'
      : `<button class="btn-sm" data-field="${i}" ${q || !afford ? 'disabled' : ''}>升级</button>`;
    return `<div class="card">${art(ficon, fname, 'md')}
      <div class="cardbody"><div class="card-title">${fname} <b class="lv">Lv${f.level}</b></div>
        ${max ? '' : costPreview(f.nextCost, f.nextTimeSec)}${btn}</div></div>`;
  }).join('');

  const blds = Object.entries(vil.defs).map(([kind, d]: any) => {
    const max = d.level >= d.maxLevel;
    const afford = canAfford(d.nextCost);
    let btn: string;
    let reqHint = '';
    if (max) btn = '<small class="tag">已满级</small>';
    else if (!d.unlocked) {
      btn = '<small class="tag tag-lock">未解锁</small>';
      const reqs = (d.requires || []).map((r: any) => `${buildingInfo(r.kind).name ?? r.kind} Lv${r.level}`).join('、');
      if (reqs) reqHint = `<div class="req-hint">需先建：${reqs}</div>`;
    } else btn = `<button class="btn-sm" data-bld="${kind}" ${q || !afford ? 'disabled' : ''}>升级</button>`;
    return `<div class="card ${d.unlocked ? '' : 'locked'}">${art(d.icon ?? buildingInfo(kind).icon ?? 'bld_main', d.name, 'md')}
      <div class="cardbody"><div class="card-title">${d.name} <b class="lv">Lv${d.level}</b></div>
        ${max || !d.unlocked ? reqHint : costPreview(d.nextCost, d.nextTimeSec)}${btn}</div></div>`;
  }).join('');

  return `${banner}
    <h3>资源田 <small>（18）</small></h3><div class="grid">${fields}</div>
    <h3>中心建筑</h3><div class="grid">${blds}</div>`;
}

/** 绑定村庄页交互（升级田/建筑）。act 为统一的"发请求并刷新"回调。 */
export function bindVillage(act: (p: Promise<any>) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-field]').forEach((b) =>
    b.onclick = () => act(req('UpgradeField', { fieldIndex: Number(b.dataset.field) })));
  document.querySelectorAll<HTMLButtonElement>('[data-bld]').forEach((b) =>
    b.onclick = () => act(req('UpgradeBuilding', { kind: b.dataset.bld })));
}
