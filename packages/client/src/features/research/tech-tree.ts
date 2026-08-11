/**
 * 科技树页 — 新增顶级 tab "科技"。
 * 显示三分支切换、科技卡片（含依赖状态和研发按钮）。
 */
import { req } from '../../api.js';
import { art, escapeHtml } from '../../shared/ui/widgets.js';

function durStr(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

let currentAct: ((p: Promise<any>, onOk?: (payload: any) => void) => void) | null = null;
let currentBranch = 'military';

export function bindTechTree(act: (p: Promise<any>, onOk?: (payload: any) => void) => void): void {
  currentAct = act;
  // branch 切换
  document.querySelectorAll('[data-tech-branch]').forEach(b => {
    b.addEventListener('click', () => {
      currentBranch = (b as HTMLElement).dataset.techBranch || 'military';
      refreshTechTree();
    });
  });
  // 开始研发按钮
  document.querySelectorAll('[data-start-tech]').forEach(b => {
    b.addEventListener('click', () => {
      const code = (b as HTMLElement).dataset.startTech!;
      const rp = parseInt(((b as HTMLElement).dataset.rpNeed ?? '0'), 10);
      if (act) {
        const p = req('StartResearch', { techCode: code });
        act(p, () => { void refreshTechTree(); });
      }
    });
  });
  // 取消研发按钮
  document.querySelectorAll('[data-cancel-tech]').forEach(b => {
    b.addEventListener('click', () => {
      if (act) {
        const p = req('CancelResearch', {});
        act(p, () => { void refreshTechTree(); });
      }
    });
  });
}

/** 定时刷新（仅当科技页签打开且无交互时可用）。 */
export async function refreshTechTree(): Promise<void> {
  const el = document.getElementById('research-page');
  if (!el) return;
  const [rRes, vRes] = await Promise.all([
    req('GetTechTree'),
    req('GetVillage'),
  ]);
  if (!rRes.ok) return;
  const data = rRes.payload as any;
  const layout = vRes.ok ? (vRes.payload as any).layout : null;
  const hasAcademy = layout?.slots?.some((s: any) => s.kind === 'academy' && s.level >= 1) ?? false;
  el.innerHTML = renderTechTreeInner(data, currentBranch, hasAcademy);
  bindTechTree(currentAct!);
}

export function renderTechTree(data?: any, branch?: string, hasAcademy?: boolean): string {
  return `<div id="research-page">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="font-size:14px;color:#fbbf24">科研点：${data?.rp ?? 0}</span>
      ${data?.researching ? `<span class="tag">研发中：${data.researching}</span>
        <button type="button" class="btn-sm btn-danger" data-cancel-tech>取消研发</button>` : ''}
    </div>
    <div class="tabs" style="margin-bottom:12px">
      <button data-tech-branch="military" class="${branch === 'military' ? 'active' : ''}">军事</button>
      <button data-tech-branch="production" class="${branch === 'production' ? 'active' : ''}">生产</button>
      <button data-tech-branch="social" class="${branch === 'social' ? 'active' : ''}">社会</button>
    </div>
    <div id="tech-grid" style="display:flex;flex-wrap:wrap;gap:10px">
      ${renderTechCards(data?.techs ?? [], data?.rp ?? 0, branch || 'military', data?.researching ?? null)}
    </div>
    ${!hasAcademy ? '<div class="hint-sm" style="margin-top:16px">需要建造学院才能产生科研点。（城镇中心 Lv3 → 城内空槽建造学院）</div>' : ''}
  </div>`;
}

function renderTechTreeInner(data: any, branch: string, hasAcademy: boolean): string {
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="font-size:14px;color:#fbbf24">科研点：${data.rp ?? 0}</span>
      ${data.researching ? `<span class="tag">研发中：${data.researching}</span>
        <button type="button" class="btn-sm btn-danger" data-cancel-tech>取消研发</button>` : ''}
    </div>
    <div class="tabs" style="margin-bottom:12px">
      <button data-tech-branch="military" class="${branch === 'military' ? 'active' : ''}">军事</button>
      <button data-tech-branch="production" class="${branch === 'production' ? 'active' : ''}">生产</button>
      <button data-tech-branch="social" class="${branch === 'social' ? 'active' : ''}">社会</button>
    </div>
    <div id="tech-grid" style="display:flex;flex-wrap:wrap;gap:10px">
      ${renderTechCards(data.techs ?? [], data.rp ?? 0, branch, data.researching ?? null)}
    </div>
    ${!hasAcademy ? '<div class="hint-sm" style="margin-top:16px">需要建造学院（城镇中心 Lv3 → 城内空槽）才能产生科研点。</div>' : ''}
  `;
}

function renderTechCards(techs: any[], rp: number, branch: string, researching: string | null): string {
  const filtered = techs.filter((t: any) => t.branch === branch);
  // 按 tier 分组
  const byTier: Record<number, any[]> = {};
  for (const t of filtered) {
    (byTier[t.tier] = byTier[t.tier] || []).push(t);
  }
  let html = '';
  for (const [tier, group] of Object.entries(byTier).sort(([a], [b]) => Number(a) - Number(b))) {
    html += `<div class="tech-tier-label" style="width:100%;margin-top:8px;font-size:11px;color:#a0a8c0">Tier ${tier}</div>`;
    for (const t of group) {
      html += renderTechCard(t, rp, researching);
    }
  }
  return html;
}

function renderTechCard(t: any, rp: number, researching: string | null): string {
  const isCompleted = t.status === 'completed';
  const isResearching = t.status === 'researching';
  const isLocked = t.status === 'locked';
  const canResearch = t.status === 'available' && rp >= t.rpCost;

  let borderColor = '#334155';
  let bgColor = '#1e293b';
  if (isCompleted) { borderColor = '#22c55e'; bgColor = '#0c2a1a'; }
  else if (isResearching) { borderColor = '#fbbf24'; bgColor = '#2a200c'; }
  else if (canResearch) { borderColor = '#4cc9f0'; bgColor = '#0c1f2a'; }

  const branchIcon: Record<string, string> = { military: '#f87171', production: '#4ade80', social: '#a78bfa' };
  const effectDesc = formatEffect(t);

  const requiresHtml = t.requires && t.requires.length
    ? `<div class="hint-sm" style="margin-top:4px">前置：${t.requires.join(', ')}</div>`
    : '';

  let btnHtml = '';
  if (isCompleted) {
    btnHtml = '<span style="color:#22c55e;font-size:11px">已完成</span>';
  } else if (isResearching) {
    btnHtml = '<span style="color:#fbbf24;font-size:11px">研发中…</span>';
  } else if (isLocked) {
    btnHtml = '<span style="color:#64748b;font-size:11px">前置未满足</span>';
  } else if (canResearch) {
    btnHtml = `<button type="button" class="btn-sm" data-start-tech="${t.code}" data-rp-need="${t.rpCost}">研发（${t.rpCost} RP · ${durStr(t.durationSec)}）</button>`;
  } else {
    btnHtml = `<span style="color:#64748b;font-size:11px">资源不足（需 ${t.rpCost} RP）</span>`;
  }

  return `<div class="tech-card" style="border:1px solid ${borderColor};background:${bgColor};border-radius:6px;padding:10px;width:200px;display:flex;flex-direction:column;gap:4px">
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:8px;height:8px;border-radius:50%;background:${branchIcon[t.branch] || '#888'};display:inline-block;flex-shrink:0"></span>
      <span style="font-size:13px;color:#e0e0e0;flex:1">${escapeHtml(t.name)}</span>
      ${t.scope === 'player' ? '<span class="tag" style="font-size:10px" title="全局科技">全局</span>' : ''}
    </div>
    <div style="font-size:11px;color:#a0a8c0">${effectDesc}</div>
    <div style="font-size:10px;color:#64748b">${t.rpCost}RP · ${durStr(t.durationSec)}</div>
    ${requiresHtml}
    <div style="margin-top:4px">${btnHtml}</div>
  </div>`;
}

function formatEffect(t: any): string {
  const v = t.effectValue;
  switch (t.effectType) {
    case 'resource_rate': return `${t.effectKey} 产量 +${Math.round(v * 100)}%`;
    case 'combat_atk': return `${t.effectKey} 攻击 +${Math.round(v * 100)}%`;
    case 'combat_def': return `${t.effectKey} 防御 +${Math.round(v * 100)}%`;
    case 'unit_unlock': return `解锁 ${t.effectKey}`;
    case 'building_unlock': return `解锁 ${t.effectKey}`;
    case 'pop_growth': return `人口增长 +${Math.round(v * 100)}%`;
    case 'storage_cap': return `仓储 +${Math.round(v * 100)}%`;
    case 'train_speed': return `训练加速 ${Math.round(v * 100)}%`;
    case 'build_speed': return `建造加速 ${Math.round(v * 100)}%`;
    case 'march_speed': return `行军加速 ${Math.round(v * 100)}%`;
    case 'carry_cap': return `运载 +${Math.round(v * 100)}%`;
    case 'mechanism': return `特殊机制：${t.effectKey}`;
    default: return `${t.effectType}: +${v}`;
  }
}
