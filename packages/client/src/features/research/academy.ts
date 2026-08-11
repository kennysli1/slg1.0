/**
 * 学院详情抽屉 — 点击 academy 建筑打开。
 * 显示 RP 余额、生产状态、拆除按钮、进入科技树按钮。
 * 定时刷新仅更新数据，不重建 DOM（避免闪烁）。
 */
import { req } from '../../api.js';
import { art, escapeHtml } from '../../shared/ui/widgets.js';
import { buildingInfo } from '../../app/config.js';

let currentAct: ((p: Promise<any>, onOk?: (payload: any) => void) => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let currentSlotId = '';

export function refreshAcademyIfOpen(): void {
  if (!currentAct || !currentSlotId) return;
  void updateAcademyData();
}

export function openAcademy(act: (p: Promise<any>, onOk?: (payload: any) => void) => void, slotId: string): void {
  closeAcademy();
  currentAct = act;
  currentSlotId = slotId;
  void buildAcademyDrawer(slotId);
}

export function closeAcademy(): void {
  currentAct = null;
  currentSlotId = '';
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const el = document.getElementById('academy-drawer');
  if (el) el.remove();
}

async function buildAcademyDrawer(slotId: string): Promise<void> {
  const [rRes] = await Promise.all([req('GetState')]);
  if (!rRes.ok) return;
  const st = rRes.payload as any;
  const info = buildingInfo('academy');

  const html = `<div class="drawer-mask" data-close-acad="1"></div>
    <aside class="drawer drawer--opening bld-drawer drawer--center" role="dialog" aria-modal="true">
      <div class="drawer-head">
        ${art(info?.icon ?? '', info?.name ?? '学院', 'sm')}
        <span class="bld-drawer-name">${escapeHtml(info?.name ?? '学院')}</span>
        <small class="tag" id="acad-lv-tag">Lv?</small>
        <button class="drawer-close" data-close-acad="1" aria-label="关闭">X</button>
      </div>
      <div class="drawer-body">
        <div class="drawer-sec-title">科研点</div>
        <div style="display:flex;align-items:center;gap:12px;margin:8px 0">
          <span style="font-size:24px;color:#fbbf24" id="acad-rp">0</span>
          <button type="button" class="btn-sm" style="padding:8px 18px;font-size:14px;border-color:#fbbf24;color:#fbbf24" onclick="window._gotoTechTree()">进入科技树</button>
        </div>
        <div id="acad-researching"></div>
        <div class="drawer-sec-title">生产状态</div>
        <div class="bld-detail-row"><span class="bld-detail-k">当前概率</span><span class="bld-detail-v" id="acad-prob">-</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">连续失败</span><span class="bld-detail-v" id="acad-fails">-</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">下次判定</span><span class="bld-detail-v" id="acad-next">-</span></div>
        <div class="bld-detail-row"><span class="bld-detail-k">学院数量</span><span class="bld-detail-v" id="acad-count">-</span></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn-sm btn-danger" id="acad-demolish" data-slot="${slotId}">拆除学院</button>
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

  // 拆除按钮
  const demolishBtn = document.getElementById('acad-demolish');
  if (demolishBtn) {
    demolishBtn.addEventListener('click', () => {
      if (!currentAct) return;
      const p = req('DemolishBuilding', { slotId });
      currentAct(p, () => {
        closeAcademy();
      });
    });
  }

  // 填充数据
  await updateAcademyData();

  // 定时刷新
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setInterval(() => updateAcademyData(), 5000);
}

/** 仅更新抽屉内的数据，不重建 DOM。 */
async function updateAcademyData(): Promise<void> {
  if (!currentAct) { clearInterval(refreshTimer!); refreshTimer = null; return; }
  try {
    const rRes = await req('GetState');
    if (!rRes.ok) return;
    const st = rRes.payload as any;
    const academy = st.academy ?? {};
    const rp = st.rp ?? 0;
    const highestLevel = academy.highestLevel ?? 0;
    const academyCount = academy.academyCount ?? 0;
    const failStreak = academy.failStreak ?? 0;
    const now = Date.now();
    const lastCheck = academy.lastCheckTime ?? now;

    // 更新等级
    const lvTag = document.getElementById('acad-lv-tag');
    if (lvTag) lvTag.textContent = academyCount > 0 ? `Lv${highestLevel}（${academyCount}座）` : 'Lv?';

    // RP
    const rpEl = document.getElementById('acad-rp');
    if (rpEl) rpEl.textContent = String(rp);

    // 研发中
    const researching = st.researching;
    const resEl = document.getElementById('acad-researching');
    if (resEl) {
      if (researching) {
        const elapsed = now - (researching.startedAt || 0);
        const pct = researching.durationMs ? Math.min(100, Math.round((elapsed / researching.durationMs) * 100)) : 0;
        resEl.innerHTML = `<div class="drawer-sec-title">研发中</div>
          <div class="hint-sm">${researching.code} · ${pct}%</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
      } else {
        resEl.innerHTML = '';
      }
    }

    // 概率
    const baseProb = 0.10 + (highestLevel - 1) * 0.01;
    const gain = 0.02;
    const maxProb = 0.30 + (highestLevel - 1) * 0.02;
    const currentP = Math.min(maxProb, baseProb + failStreak * gain);
    const probPct = (currentP * 100).toFixed(1);

    const probEl = document.getElementById('acad-prob');
    if (probEl) probEl.textContent = `${probPct}%（上限${(maxProb*100).toFixed(0)}%）`;

    const failEl = document.getElementById('acad-fails');
    if (failEl) failEl.textContent = `${failStreak}次`;

    // 下次判定
    // 下次判定（用服务端返回的精确 intervalSec）
    const intervalSec = (st.intervalSec as number) ?? (academyCount > 0 ? Math.max(1, Math.round(3600 / academyCount)) : 0);
    let nextStr = '无学院';
    if (intervalSec > 0) {
      const nextInMs = lastCheck + intervalSec * 1000 - now;
      const nextIn = Math.max(0, Math.round(nextInMs / 1000));
      nextStr = nextIn > 60 ? `${Math.floor(nextIn/60)}分${nextIn%60}秒` : `${nextIn}秒`;
    }
    const nextEl = document.getElementById('acad-next');
    if (nextEl) nextEl.textContent = nextStr;

    const countEl = document.getElementById('acad-count');
    if (countEl) countEl.textContent = academyCount > 0 ? `${academyCount}座${academyCount > 1 ? '（判定间隔/'+academyCount+'）' : ''}` : '0座';
  } catch { /* network error, retry next interval */ }
}
