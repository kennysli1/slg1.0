/**
 * 学院详情抽屉 — 点击 academy 建筑打开。
 * 显示 RP 余额、生产状态（概率/保底/倒计时）、进入科技树按钮。
 */
import { req } from '../../api.js';
import { art, escapeHtml } from '../../shared/ui/widgets.js';
import { buildingInfo } from '../../app/config.js';

let currentAct: ((p: Promise<any>, onOk?: (payload: any) => void) => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function refreshAcademyIfOpen(): void {
  if (!currentAct) return;
  const slotId = document.getElementById('academy-drawer')?.dataset.slotId;
  if (slotId) void renderAcademyContent(slotId);
}

export function openAcademy(act: (p: Promise<any>, onOk?: (payload: any) => void) => void, slotId: string): void {
  closeAcademy();
  currentAct = act;
  void renderAcademyContent(slotId);
}

export function closeAcademy(): void {
  currentAct = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const el = document.getElementById('academy-drawer');
  if (el) el.remove();
}

async function renderAcademyContent(slotId: string): Promise<void> {
  const [rRes, bRes] = await Promise.all([
    req('GetState'),
    req('GetVillage'),
  ]);
  if (!rRes.ok) return;

  const st = rRes.payload as any;
  const layout = bRes.ok ? (bRes.payload as any).layout : null;
  const academySlot = layout?.slots?.find((s: any) => s.slotId === slotId);
  const academyLevel = academySlot?.level ?? 0;
  const academy = st.academy ?? {};
  const info = buildingInfo('academy');

  const rp = st.rp ?? 0;
  const researching = st.researching;
  const highestLevel = academy.highestLevel ?? 0;
  const academyCount = academy.academyCount ?? 0;
  const failStreak = academy.failStreak ?? 0;
  const now = Date.now();
  const lastCheck = academy.lastCheckTime ?? now;
  const checkIntervalSec = academyCount > 0 ? Math.max(1, Math.round((3600 / academyCount))) : 0;
  const nextIn = checkIntervalSec > 0 ? Math.max(0, Math.round((lastCheck + checkIntervalSec * 1000 - now) / 1000)) : 0;

  // 概率显示
  const baseProb = 0.10 + (highestLevel - 1) * 0.01;
  const gain = 0.02;
  const maxProb = 0.30 + (highestLevel - 1) * 0.02;
  const currentP = Math.min(maxProb, baseProb + failStreak * gain);
  const probPct = (currentP * 100).toFixed(1);

  // 在途研发
  let researchingHtml = '';
  if (researching) {
    const elapsed = now - (researching.startedAt || 0);
    const remaining = Math.max(0, (researching.durationMs || 0) - elapsed);
    const pct = researching.durationMs ? Math.min(100, Math.round((elapsed / researching.durationMs) * 100)) : 0;
    researchingHtml = `<div class="drawer-sec-title">研发中</div>
      <div class="hint-sm">${researching.code} · ${pct}%</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  }

  const html = `<div class="drawer-mask" data-close-acad="1"></div>
    <aside class="drawer drawer--opening bld-drawer drawer--center" role="dialog" aria-modal="true">
      <div class="drawer-head">
        ${art(info?.icon ?? '', info?.name ?? '学院', 'sm')}
        <span class="bld-drawer-name">${escapeHtml(info?.name ?? '学院')}</span>
        <small class="tag">Lv${academyLevel}</small>
        <button class="drawer-close" data-close-acad="1" aria-label="关闭">X</button>
      </div>
      <div class="drawer-body">
        <div class="drawer-sec-title">科研点</div>
        <div style="font-size:24px;color:#fbbf24;margin:8px 0">${rp}</div>
        ${researchingHtml}
        <div class="drawer-sec-title">生产状态</div>
        <div class="bld-detail-row"><span class="bld-detail-k">当前概率</span><span class="bld-detail-v">${probPct}%（上限 ${(maxProb*100).toFixed(0)}%）</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">连续失败</span><span class="bld-detail-v">${failStreak}次</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">下次判定</span><span class="bld-detail-v">${checkIntervalSec > 0 ? (nextIn > 60 ? Math.floor(nextIn/60)+'分'+nextIn%60+'秒' : nextIn+'秒') : '无学院'}</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">学院数量</span><span class="bld-detail-v">${academyCount}座${academyCount > 1 ? '（判定间隔/'+academyCount+'）' : ''}</span></div>
        <div style="margin-top:12px">
          <button type="button" class="btn-sm" onclick="window._gotoTechTree()">进入科技树</button>
        </div>
      </div>
    </aside>`;

  const existing = document.getElementById('academy-drawer');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'academy-drawer';
  wrap.dataset.slotId = slotId;
  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  // 关闭事件
  wrap.querySelectorAll('[data-close-acad]').forEach(el => {
    el.addEventListener('click', closeAcademy);
  });

  // 定时刷新 RP 数据
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAcademyIfOpen(), 5000);
}
