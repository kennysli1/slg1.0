/** 军队页：驻军 + 训练 + 解散。 */
import { art, unitArt, canAfford, costPreview, progressBar } from '../../shared/ui/widgets.js';
import { formName, tribeName } from '../../shared/ui/text.js';
import { unitInfo, resourceKeys } from '../../app/config.js';
import { getCache, interpolatePop, getPopState } from '../../app/state.js';
import { req } from '../../api.js';
import { fmt } from '../../shared/utils/format.js';

export function unitName(key: string): string {
  const t = (getCache().army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? unitInfo(key).name ?? key;
}
export function unitTrainSec(key: string): number {
  return (getCache().army?.trainable || []).find((u: any) => u.key === key)?.trainSec ?? 30;
}

/** 紧凑属性行：攻 / 防(近·远) / 速 / 载 / 粮 / 人口。数值为服务端算好的最终值快照。
 *  仅在「点击兵种弹出的详情弹窗」内展示，训练卡默认只显示造价（见需求：部队仅显示建造资源）。 */
function renderUnitStats(u: any): string {
  const r = (v: any) => Math.round(Number(v) || 0);
  const isRanged = u.form === 'ranged';
  const atk = r(isRanged ? u.rangedAtk : u.meleeAtk);
  const atkTitle = isRanged ? '远程攻击力' : '近战攻击力';
  const popCost = unitInfo(u.key ?? u.code ?? '').popCost;
  const stat = (label: string, value: string | number, title: string, cls = '') =>
    `<span class="ustat ${cls}" title="${title}"><i>${label}</i><b>${value}</b></span>`;
  return `<div class="unit-stats">
    ${stat('攻', atk, atkTitle, 'us-atk')}
    ${stat('防', `${r(u.meleeDef)}·${r(u.rangedDef)}`, '防御（近战·远程）', 'us-def')}
    ${stat('速', r(u.speed), '移动速度')}
    ${stat('载', r(u.carry), '掠夺负重')}
    ${stat('粮', r(u.upkeep), '每小时耗粮')}
    ${stat('人口', popCost, `训练消耗人口（每兵 ${popCost}）`, 'us-pop')}
  </div>`;
}

/** 计算训练该兵种 cnt 个所需总人口。 */
function calcPopCost(unitKey: string, cnt: number): number {
  return unitInfo(unitKey).popCost * cnt;
}

export function renderArmy(): string {
  const army = getCache().army;
  if (!army) return '<div class="loading">加载中…</div>';

  // 驻军展示（点击兵种 → 弹出属性详情）
  const troops = Object.entries(army.troops || {});
  const troopList = troops.length
    ? troops.map(([u, n]: any) => `<span class="troop" data-unit-detail="${u}" title="点击查看 ${unitName(u)} 属性">${art(unitArt(u), unitName(u), 'sm')}<span class="troop-name">${unitName(u)}</span><b class="troop-count">×${n}</b></span>`).join('')
    : '<small class="muted">暂无驻军</small>';

  // 训练进度横幅
  const tr = army.training;
  const training = tr
    ? `<div class="banner banner-train">🎯 训练中：<b>${unitName(tr.unit)}</b> ×${tr.remaining}
        ${progressBar(tr.nextDoneAt - unitTrainSec(tr.unit) * 1000, tr.nextDoneAt, '下一个')}</div>` : '';

  // 训练卡片：默认只显示「建造所需资源」+ 训练操作；攻防等详细数据点击「属性」按钮弹出
  const trainCards = (army.trainable || []).map((u: any) => {
    const popCost = unitInfo(u.key).popCost;
    return `<div class="card unit-card">
      <button class="unit-icon-btn" data-unit-detail="${u.key}" title="查看 ${u.name} 属性">${art(unitArt(u.key), u.name, 'md')}</button>
      <div class="cardbody">
        <div class="card-title">${u.name} <small class="tag">${formName(u.form)}</small>
          <button class="unit-detail-link" data-unit-detail="${u.key}" title="查看攻防等详细属性">属性 ⓘ</button>
        </div>
        <div class="cost-slot" id="cost-${u.key}">${costPreview(u.cost, u.trainSec)}</div>
        <div class="pop-warn" id="pop-warn-${u.key}" style="display:none"></div>
        <div class="train-row">
          <input type="number" min="1" value="1" id="cnt-${u.key}" data-unit="${u.key}" />
          <small class="hint-sm" title="训练此批次消耗人口">人口 <b id="popcost-${u.key}">${popCost}</b></small>
          <button class="btn-sm" id="btn-${u.key}" data-train="${u.key}" ${army.training ? 'disabled' : ''}>训练</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // 解散部队区（仅有驻军时显示）
  const disbandSection = renderDisbandSection(army);

  return `<h3>驻军 <small>（${tribeName(army.tribe)}族 · 点击兵种看属性）</small></h3>
    <div class="troopbar">${troopList}</div>
    ${training}
    ${disbandSection}
    <h3>训练</h3>
    <div class="grid">${trainCards}</div>`;
}

/** 解散部队区：每个驻守兵种一行（含数量输入和解散按钮）。 */
function renderDisbandSection(army: any): string {
  const troops = Object.entries(army.troops || {});
  if (!troops.length) return '';

  const rows = troops.map(([key, count]: any) => {
    const info = unitInfo(key);
    const popReturn = info.popCost * count;
    return `<div class="disband-row">
      ${art(unitArt(key), info.name, 'sm')}
      <span class="disband-name">${unitName(key)}</span>
      <span class="disband-count">×${fmt(count)}</span>
      <input type="number" min="1" max="${count}" value="${count}" id="dis-cnt-${key}" class="disband-input" />
      <span class="disband-pop-return" id="dis-pop-${key}" title="解散后返还的人口">+${fmt(popReturn)} 人口</span>
      <button class="btn-disband" data-disband="${key}">解散</button>
    </div>`;
  }).join('');

  return `<div class="disband-section">
    <div class="disband-header">
      <span>解散部队</span>
      <small class="hint-sm">解散即时返还人口，但不返还资源；出征中的部队无法解散</small>
    </div>
    ${rows}
  </div>`;
}

/** 训练数量变化时，按总价重算消耗预览、人口需求与按钮可用性。 */
export function updateTrainCost(unitKey: string) {
  const u = (getCache().army?.trainable || []).find((x: any) => x.key === unitKey);
  if (!u) return;
  const inp = document.getElementById(`cnt-${unitKey}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));

  // 资源消耗预览
  const total: Record<string, number> = {};
  for (const r of resourceKeys()) total[r] = (u.cost[r] ?? 0) * cnt;
  const slot = document.getElementById(`cost-${unitKey}`);
  if (slot) slot.innerHTML = costPreview(total, u.trainSec * cnt);

  // 人口消耗显示
  const totalPop = calcPopCost(unitKey, cnt);
  const popCostEl = document.getElementById(`popcost-${unitKey}`);
  if (popCostEl) popCostEl.textContent = String(totalPop);

  // 人口是否充足
  const currentPop = interpolatePop();
  const popWarn = document.getElementById(`pop-warn-${unitKey}`);
  const btn = document.getElementById(`btn-${unitKey}`) as HTMLButtonElement;
  const hasEnoughPop = currentPop >= totalPop;

  if (popWarn) {
    if (!hasEnoughPop && getPopState()) {
      popWarn.style.display = '';
      popWarn.textContent = `人口不足：需 ${totalPop}，当前约 ${currentPop}`;
    } else {
      popWarn.style.display = 'none';
      popWarn.textContent = '';
    }
  }

  // 按钮可用性：资源 + 人口均满足才可训练
  if (btn && !getCache().army?.training) {
    btn.disabled = !canAfford(total) || !hasEnoughPop;
  }
}

/** 解散数量变化时，实时更新返还人口预估。 */
function updateDisbandPopReturn(unitKey: string) {
  const inp = document.getElementById(`dis-cnt-${unitKey}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
  const popReturn = unitInfo(unitKey).popCost * cnt;
  const el = document.getElementById(`dis-pop-${unitKey}`);
  if (el) el.textContent = `+${fmt(popReturn)} 人口`;
}

/** 兵种详情弹窗：展示攻防/速/载/粮/人口 + 造价。直接注入 body（不进 #page，
 *  避免 5s 全量刷新把弹窗一起重建/关掉）。点遮罩、✕ 或 Esc 关闭。 */
function openUnitDetail(unitKey: string): void {
  closeUnitDetail(); // 单例：先关旧的
  const u = (getCache().army?.trainable || []).find((x: any) => x.key === unitKey);
  const info = unitInfo(unitKey);
  const name = u?.name ?? info.name;

  const wrap = document.createElement('div');
  wrap.id = 'unit-detail-modal';
  const stats = u ? renderUnitStats(u) : '<div class="hint-sm">该兵种暂无详细数据</div>';
  const costHtml = u ? costPreview(u.cost, u.trainSec) : '';
  wrap.innerHTML = `
    <div class="drawer-mask" data-close-detail="1"></div>
    <div class="unit-modal" role="dialog" aria-modal="true">
      <div class="unit-modal-head">
        ${art(unitArt(unitKey), name, 'lg')}
        <div class="unit-modal-title"><b>${name}</b>${u ? `<small class="tag">${formName(u.form)}</small>` : ''}</div>
        <button class="drawer-close" data-close-detail="1" aria-label="关闭">✕</button>
      </div>
      <div class="unit-modal-body">
        <div class="unit-modal-sec-title">战斗属性</div>
        ${stats}
        ${costHtml ? `<div class="unit-modal-sec-title">训练造价</div>${costHtml}` : ''}
      </div>
    </div>`;
  document.body.appendChild(wrap);

  wrap.querySelectorAll<HTMLElement>('[data-close-detail]').forEach((el) =>
    el.onclick = () => closeUnitDetail());
}

function closeUnitDetail(): void {
  document.getElementById('unit-detail-modal')?.remove();
}

// Esc 关闭（装一次即可，全程有效）
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeUnitDetail();
  });
}

/** 绑定军队页交互（训练 + 解散 + 数量框实时重算 + 兵种详情弹窗）。 */
export function bindArmy(act: (p: Promise<any>) => void): void {
  // 兵种详情弹窗（驻军 chip / 训练卡图标 / 属性按钮）
  document.querySelectorAll<HTMLElement>('[data-unit-detail]').forEach((el) =>
    el.onclick = (e) => { e.stopPropagation(); openUnitDetail(el.dataset.unitDetail!); });

  // 训练
  document.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) =>
    b.onclick = () => {
      const u = b.dataset.train!;
      const cnt = Number((document.getElementById(`cnt-${u}`) as HTMLInputElement)?.value || 1);
      act(req('TrainTroops', { unit: u, count: cnt }));
    });

  // 训练数量变化
  document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => {
    inp.oninput = () => updateTrainCost(inp.dataset.unit!);
    updateTrainCost(inp.dataset.unit!);
  });

  // 解散按钮
  document.querySelectorAll<HTMLButtonElement>('[data-disband]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.disband!;
      const inp = document.getElementById(`dis-cnt-${key}`) as HTMLInputElement;
      const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
      const popCost = unitInfo(key).popCost;
      const totalPopReturn = popCost * cnt;
      const name = unitName(key);

      const confirmed = window.confirm(
        `确认解散 ${cnt} 名 ${name}？\n\n` +
        `• 立即返还人口：${totalPopReturn} 人\n` +
        `• 训练消耗的资源【不返还】\n` +
        `• 解散后如需重新征兵，须再次花费资源`
      );
      if (!confirmed) return;
      act(req('DisbandTroops', { units: { [key]: cnt } }));
    };
  });

  // 解散数量变化
  document.querySelectorAll<HTMLInputElement>('.disband-input').forEach((inp) => {
    const match = inp.id.match(/^dis-cnt-(.+)$/);
    if (!match) return;
    inp.oninput = () => updateDisbandPopReturn(match[1]);
  });
}
