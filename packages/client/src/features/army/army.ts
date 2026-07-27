/** 军队页：驻军 + 训练。 */
import { art, unitArt, canAfford, costPreview, progressBar } from '../../shared/ui/widgets.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { unitInfo, resourceKeys } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';

export function unitName(key: string): string {
  const t = (getCache().army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? unitInfo(key).name ?? key;
}
export function unitTrainSec(key: string): number {
  return (getCache().army?.trainable || []).find((u: any) => u.key === key)?.trainSec ?? 30;
}

/** 紧凑属性行：攻 / 防(近·远) / 速 / 载 / 粮。数值为服务端算好的最终值快照。 */
function renderUnitStats(u: any): string {
  const r = (v: any) => Math.round(Number(v) || 0);
  const isRanged = u.form === 'ranged';
  const atk = r(isRanged ? u.rangedAtk : u.meleeAtk);
  const atkTitle = isRanged ? '远程攻击力' : '近战攻击力';
  const stat = (label: string, value: string | number, title: string, cls = '') =>
    `<span class="ustat ${cls}" title="${title}"><i>${label}</i><b>${value}</b></span>`;
  return `<div class="unit-stats">
    ${stat('攻', atk, atkTitle, 'us-atk')}
    ${stat('防', `${r(u.meleeDef)}·${r(u.rangedDef)}`, '防御（近战·远程）', 'us-def')}
    ${stat('速', r(u.speed), '移动速度')}
    ${stat('载', r(u.carry), '掠夺负重')}
    ${stat('粮', r(u.upkeep), '每小时耗粮')}
  </div>`;
}

export function renderArmy(): string {
  const army = getCache().army;
  if (!army) return '<div class="loading">加载中…</div>';
  const troops = Object.entries(army.troops || {});
  const troopList = troops.length
    ? troops.map(([u, n]: any) => `<span class="troop">${art(unitArt(u), unitName(u), 'sm')}<span class="troop-name">${unitName(u)}</span><b class="troop-count">×${n}</b></span>`).join('')
    : '<small class="muted">暂无驻军</small>';
  const tr = army.training;
  const training = tr
    ? `<div class="banner banner-train">🎯 训练中：<b>${unitName(tr.unit)}</b> ×${tr.remaining}
        ${progressBar(tr.nextDoneAt - unitTrainSec(tr.unit) * 1000, tr.nextDoneAt, '下一个')}</div>` : '';
  const trainCards = (army.trainable || []).map((u: any) => {
    return `<div class="card">${art(unitArt(u.key), u.name, 'md')}
      <div class="cardbody"><div class="card-title">${u.name} <small class="tag">${formName(u.form)}</small></div>
        ${renderUnitStats(u)}
        <div class="cost-slot" id="cost-${u.key}">${costPreview(u.cost, u.trainSec)}</div>
        <div class="train-row"><input type="number" min="1" value="1" id="cnt-${u.key}" data-unit="${u.key}" />
          <button class="btn-sm" id="btn-${u.key}" data-train="${u.key}" ${army.training ? 'disabled' : ''}>训练</button></div></div></div>`;
  }).join('');
  return `<h3>驻军 <small>（${tribeName(army.tribe)}族）</small></h3><div class="troopbar">${troopList}</div>${training}
    <h3>训练</h3><div class="grid">${trainCards}</div>`;
}

/** 训练数量变化时，按总价重算某兵种卡片的消耗预览与按钮可用性。 */
export function updateTrainCost(unitKey: string) {
  const u = (getCache().army?.trainable || []).find((x: any) => x.key === unitKey);
  if (!u) return;
  const inp = document.getElementById(`cnt-${unitKey}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
  const total: Record<string, number> = {};
  for (const r of resourceKeys()) total[r] = (u.cost[r] ?? 0) * cnt;
  const slot = document.getElementById(`cost-${unitKey}`);
  if (slot) slot.innerHTML = costPreview(total, u.trainSec * cnt);
  const btn = document.getElementById(`btn-${unitKey}`) as HTMLButtonElement;
  if (btn && !getCache().army?.training) btn.disabled = !canAfford(total);
}

/** 绑定军队页交互（训练 + 数量框实时重算）。 */
export function bindArmy(act: (p: Promise<any>) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) =>
    b.onclick = () => {
      const u = b.dataset.train!;
      const cnt = Number((document.getElementById(`cnt-${u}`) as HTMLInputElement)?.value || 1);
      act(req('TrainTroops', { unit: u, count: cnt }));
    });
  document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => {
    inp.oninput = () => updateTrainCost(inp.dataset.unit!);
    updateTrainCost(inp.dataset.unit!);
  });
}
