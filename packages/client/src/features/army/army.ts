/** 军队页：驻军 + 训练 + 解散。 */
import { art, unitArt, unitArtFallback, canAfford, costPreview, progressBar, escapeHtml, escapeAttr } from '../../shared/ui/widgets.js';
import { showToast } from '../../shared/ui/toast.js';
import { errText, formName, tribeName } from '../../shared/ui/text.js';
import { unitInfo, mercenaryInfo, resourceKeys, unitCropPerHour, popCropPerLabor, resInfo, buildingInfo } from '../../app/config.js';
import { getCache, interpolatePop, getPopState } from '../../app/state.js';
import { req } from '../../api.js';
import { openBuilding } from '../village/village.js';
import { fmt } from '../../shared/utils/format.js';

export function unitName(key: string): string {
  const t = (getCache().army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? unitInfo(key).name ?? key;
}
export function unitTrainSec(key: string): number {
  return (getCache().army?.trainable || []).find((u: any) => u.key === key)?.trainSec ?? 30;
}

/** 详情抽屉里的属性清单：一行一项、带清晰中文标签（不再用「攻XX 防XX-XX」压缩写法）。
 *  数值为服务端算好的最终值快照（铁律#4）。 */
function renderUnitDetailRows(u: any): string {
  const r = (v: any) => Math.round(Number(v) || 0);
  const popCost = unitInfo(u.key ?? u.code ?? '').popCost;
  const row = (label: string, value: string | number, hint = '') =>
    `<div class="ustat-row"><span class="ustat-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="ustat-val">${value}</span></div>`;
  return `<div class="ustat-list">
    ${row('形态', formName(u.form), u.form === 'ranged' ? '后排远程' : '前排近战')}
    ${row('近战攻击', r(u.meleeAtk))}
    ${row('远程攻击', r(u.rangedAtk))}
    ${row('近战防御', r(u.meleeDef), '挨近战时耐久')}
    ${row('远程防御', r(u.rangedDef), '挨远程时耐久')}
    ${row('移动速度', r(u.speed), '格/小时')}
    ${row('每小时耗粮', r(unitCropPerHour(u.key ?? u.code ?? '')))}
    ${row('训练消耗人口', popCost, '每兵')}
  </div>`;
}

/** 计算训练该兵种 cnt 个所需总人口。 */
function calcPopCost(unitKey: string, cnt: number): number {
  return unitInfo(unitKey).popCost * cnt;
}

export function renderArmy(): string {
  const army = getCache().army;
  if (!army) return '<div class="loading">加载中…</div>';

  // 驻军展示（点击兵种 → 弹出属性详情）。雇佣兵（tribe=merc）单独成区，与普通兵种区分。
  const troops = Object.entries(army.troops || {});
  const regTroops = troops.filter(([u]) => !unitInfo(u).isMercenary);
  const mercTroops = troops.filter(([u]) => unitInfo(u).isMercenary);
  const troopList = regTroops.length
    ? regTroops.map(([u, n]: any) => `<span class="troop" data-unit-detail="${u}" title="点击查看 ${escapeAttr(unitName(u))} 属性">${art(unitArt(u), unitName(u), 'sm', unitArtFallback(u))}<span class="troop-name">${escapeHtml(unitName(u))}</span><b class="troop-count">×${n}</b></span>`).join('')
    : '<small class="muted">暂无驻军</small>';
  const mercList = mercTroops.length
    ? `<h3>雇佣兵 <small>（金币招募 · 永久持有 · 不耗粮不占人口）</small></h3>
       <div class="troopbar">${mercTroops.map(([u, n]: any) => `<span class="troop troop-merc" data-unit-detail="${u}" title="点击查看 ${escapeAttr(unitName(u))} 属性">${art(unitArt(u), unitName(u), 'sm', unitArtFallback(u))}<span class="troop-name">${escapeHtml(unitName(u))}</span><b class="troop-count">×${n}</b></span>`).join('')}</div>`
    : '';

  // 训练功能已迁入各军事建筑详情抽屉（兵营/马厩/兵工厂/城镇中心），军队页只展示驻军与解散。
  // 解散部队区（仅有驻军时显示）
  const disbandSection = renderDisbandSection(army);
  // 训练队列区：哪些军事建筑正在练兵（点击打开该建筑详情抽屉查看/操作）
  const trainQueue = renderTrainingQueue(army);

  return `<h3>驻军 <small>（${tribeName(army.tribe)}族 · 点击兵种看属性）</small></h3>
    <div class="troopbar">${troopList}</div>
    ${trainQueue}
    ${disbandSection}
    ${mercList}`;
}

/** 训练队列区：列出当前正在练兵的军事建筑（建筑名/兵种/剩余数量/进度），点击打开该建筑详情抽屉查看与操作。 */
function renderTrainingQueue(army: any): string {
  const slots = (army.slots || []).filter((s: any) => s.training);
  if (!slots.length) return '';
  const cards = slots.map((s: any) => {
    const info = buildingInfo(s.kind);
    const tr = s.training;
    const u = (s.trainable || []).find((t: any) => t.key === tr.unit);
    const name = u?.name ?? unitName(tr.unit);
    const trainSec = (u?.trainSec ?? 30) * 1000;
    const startAt = (tr.nextDoneAt || 0) - trainSec; // 按首兵 trainSec 反推起点，用于进度条
    return `<div class="card train-queue-card" data-open-bld="${escapeAttr(s.slotId)}" title="点击查看 ${escapeAttr(info.name)} 详情">
      ${art(info.icon, info.name, 'md')}
      <div class="cardbody">
        <div class="card-title">${escapeHtml(info.name)} <b class="lv">Lv${s.level}</b>
          <small class="bld-detail-hint">详情 ›</small></div>
        <div class="hint-sm">🎯 ${escapeHtml(name)} ×${tr.remaining}</div>
        ${progressBar(startAt, tr.nextDoneAt, '训练中')}
      </div>
    </div>`;
  }).join('');
  return `<h3>训练队列 <small>（正在练兵的军事建筑 · 点击看详情）</small></h3>
    <div class="grid">${cards}</div>`;
}

/** 解散部队区：每个驻守兵种一行（含数量输入和解散按钮）。雇佣兵为永久持有，不可解散。 */
function renderDisbandSection(army: any): string {
  const troops = Object.entries(army.troops || {}).filter(([k]) => !unitInfo(k).isMercenary);
  if (!troops.length) return '';

  const rows = troops.map(([key, count]: any) => {
    const info = unitInfo(key);
    const popReturn = info.popCost * count;
    return `<div class="disband-row">
      ${art(unitArt(key), info.name, 'sm', unitArtFallback(key))}
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

  // 耗粮标注（兵种军晌）为每兵固定值，已在渲染时写死，无需随数量更新。

  // availablePop = currentPop（平民数，即可转化为士兵的劳动人口）
  const ps = getPopState();
  const currentPop = interpolatePop(); // 平民外插值
  const popWarn = document.getElementById(`pop-warn-${unitKey}`);
  const btn = document.getElementById(`btn-${unitKey}`) as HTMLButtonElement;
  const hasEnoughPop = currentPop >= totalPop;

  if (popWarn) {
    if (!hasEnoughPop && ps) {
      popWarn.textContent = `可用人口不足：需 ${totalPop}，当前平民 ${fmt(currentPop)}`;
    } else if (ps && ps.inFamine) {
      // 饥荒中：人口正在减少，给出预警但不阻止（失败原因由 toast 即时反馈）
      popWarn.textContent = '⚠️ 当前处于饥荒，人口正在减少，谨慎训练';
    } else {
      popWarn.textContent = '';
    }
  }

  // 按钮保持可点，失败原因用 toast 即时反馈，不让用户点了没反应。
  if (btn) btn.disabled = false;
}

/** 解散数量变化时，实时更新返还人口预估。 */
function updateDisbandPopReturn(unitKey: string) {
  const inp = document.getElementById(`dis-cnt-${unitKey}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
  const popReturn = unitInfo(unitKey).popCost * cnt;
  const el = document.getElementById(`dis-pop-${unitKey}`);
  if (el) el.textContent = `+${fmt(popReturn)} 人口`;
}

/** 兵种详情：右侧抽屉展开（与建造抽屉一致的形态），属性一行一项清晰列出 + 训练造价。
 *  直接注入 body（不进 #page，避免 5s 全量刷新把它一起重建/关掉）。点遮罩、✕ 或 Esc 关闭。 */
export function openUnitDetail(unitKey: string): void {
  closeUnitDetail(); // 单例：先关旧的
  const u = (getCache().army?.trainable || []).find((x: any) => x.key === unitKey);
  const info = unitInfo(unitKey);
  const name = u?.name ?? info.name;
  // 雇佣兵无训练表项(u)，但 mercenaryInfo 含完整属性 → 构造一个虚拟表项供详情渲染
  const m = mercenaryInfo(unitKey);
  const uForStats = u ?? (m ? { key: unitKey, form: m.form, meleeAtk: m.meleeAtk, rangedAtk: m.rangedAtk, meleeDef: m.meleeDef, rangedDef: m.rangedDef, speed: m.speed, carry: m.carry, upkeep: 0 } : null);

  const wrap = document.createElement('div');
  wrap.id = 'unit-detail-modal';
  const stats = uForStats ? renderUnitDetailRows(uForStats) : '<div class="hint-sm">该兵种暂无详细数据</div>';
  const costHtml = u ? costPreview(u.cost, u.trainSec) : '';
  const lockHtml = u && u.unlocked === false
    ? `<div class="drawer-sec-title">解锁条件</div><small class="tag tag-lock">${escapeHtml(u.lockReason ?? '未解锁')}</small>`
    : '';
  wrap.innerHTML = `
    <div class="drawer-mask" data-close-detail="1"></div>
    <aside class="drawer drawer--opening unit-drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        ${art(unitArt(unitKey), name, 'sm', unitArtFallback(unitKey))}
        <span class="unit-drawer-name">${escapeHtml(name)}</span>
        ${u ? `<small class="tag">${formName(u.form)}</small>` : ''}
        <button class="drawer-close" data-close-detail="1" aria-label="关闭">✕</button>
      </div>
      <div class="drawer-body">
        ${lockHtml}
        <div class="drawer-sec-title">战斗属性</div>
        ${stats}
        ${costHtml ? `<div class="drawer-sec-title">训练造价</div>${costHtml}` : ''}
      </div>
    </aside>`;
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

/** 绑定军队页交互（训练 + 解散 + 数量框实时重算 + 兵种详情抽屉）。 */
export function bindArmy(act: (p: Promise<any>) => void): void {
  // 兵种详情抽屉：整张训练卡 / 驻军 chip 可点；卡内训练区(.train-row)点击不触发详情
  document.querySelectorAll<HTMLElement>('[data-unit-detail]').forEach((el) =>
    el.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('.train-row')) return; // 训练输入/按钮：不展开详情
      openUnitDetail(el.dataset.unitDetail!);
    });

  // 训练队列区：点击正在练兵的建筑卡 → 打开该建筑详情抽屉（查看/操作训练）
  document.querySelectorAll<HTMLElement>('[data-open-bld]').forEach((el) =>
    el.onclick = () => openBuilding(el.dataset.openBld!));

  // 训练
  document.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) =>
    b.onclick = () => {
      // 训练是单批次进行：已有训练在进行时点击 → 即时提示（点 4 的队列已满同源体验）
      if (getCache().army?.training) { showToast('已有训练在进行，请等当前完成'); return; }
      const u = b.dataset.train!;
      const cnt = Math.max(1, Math.floor(Number((document.getElementById(`cnt-${u}`) as HTMLInputElement)?.value || 1)));
      const def = (getCache().army?.trainable || []).find((x: any) => x.key === u);
      if (!def) { showToast('该兵种暂不可训练'); return; }
      if (def.unlocked === false) {
        showToast(def.lockReason ? String(def.lockReason) : '前置建筑未满足，尚未解锁');
        return;
      }
      const total: Record<string, number> = {};
      for (const r of resourceKeys()) total[r] = (def.cost[r] ?? 0) * cnt;
      if (!canAfford(total)) { showToast('资源不足，无法训练'); return; }
      const needPop = calcPopCost(u, cnt);
      const currentPop = interpolatePop(); // 平民数 = currentPop（可转化为士兵的劳动人口）
      if (getPopState() && currentPop < needPop) {
        showToast(`可用人口不足：需 ${needPop}，当前平民 ${currentPop}`);
        return;
      }
      act(req('TrainTroops', { unit: u, count: cnt }).then((res) => {
        if (!res.ok) {
          const code = res.error?.code;
          let msg = errText(code);
          // 动员上限：用本族实际上限百分比解释“为什么失败”，并给出可操作建议
          if (code === 'mobilize_cap_exceeded') {
            const cap = getPopState()?.mobilizeCap;
            if (cap) {
              msg = `已达本族动员上限（上限 ${Math.round(cap * 100)}% 人口可参军），无法继续训练，请先提升人口上限或解散部分士兵`;
            }
          }
          showToast(`训练失败：${msg}`);
        }
        return res;
      }));
    });

  // 训练数量步进：− / + 包裹输入框，点按友好（手动输入仍可用）
  document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => {
    b.onclick = () => {
      const unit = b.dataset.unit!;
      const inp = document.getElementById(`cnt-${unit}`) as HTMLInputElement | null;
      if (!inp) return;
      const step = Number(b.dataset.step) || 0;
      const cur = Math.max(1, Math.floor(Number(inp.value) || 1));
      const next = Math.max(1, cur + step);
      inp.value = String(next);
      updateTrainCost(unit);
    };
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
