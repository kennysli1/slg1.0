/**
 * 学院详情弹窗：科研点余额、产出判定状态、进入科技树、拆除学院。
 * 由村庄建筑弹窗在 kind === 'academy' 时调用（签名固定）。
 */
import { useEffect } from 'preact/hooks';
import { openModal, closeModalByKey, researchState, tab, tick } from '../../app/store.js';
import { reloadResearch } from '../../app/refresh.js';
import { buildingInfo } from '../../app/config.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import {
  Modal, IconPlate, Btn, Bar, TimerBar, StatGrid, Stat, Divider,
} from '../../ui/index.js';
import { BuildingManagement } from '../village/BuildingManagement.js';
import '../../styles/research.css';

const KEY = 'academy';

export function openAcademy(slotId: string): void {
  openModal((close) => <AcademyModal slotId={slotId} onClose={close} />, KEY);
}

function AcademyModal({ slotId, onClose }: { slotId: string; onClose: () => void }) {
  tick.value; // 判定倒计时每秒推进
  const state = researchState.value;

  useEffect(() => { void reloadResearch(); }, []);

  const info = buildingInfo('academy');
  const academy = state?.academy ?? {};
  const rp: number = state?.rp ?? 0;
  const count: number = academy.academyCount ?? 0;
  const highest: number = academy.highestLevel ?? 0;
  const failStreak: number = academy.failStreak ?? 0;
  const intervalSec: number = state?.intervalSec ?? 0;
  const lastCheck: number = academy.lastCheckTime ?? Date.now();
  const researching = state?.researching ?? null;
  const formula = state?.rpFormula ?? {};
  const baseProb = Number(formula.baseProbability ?? 0);
  const maxProb = Number(formula.maxProbability ?? 0);
  const curProb = Number(formula.currentProbability ?? 0);
  const baseIntervalSec = Number(formula.baseIntervalSec ?? 0);

  function gotoTechTree() {
    closeModalByKey(KEY);
    tab.value = 'tech';
  }

  return (
    <Modal
      title={info.name}
      sub={count > 0 ? `Lv${highest} · 本村 ${count} 座` : '尚未建成'}
      icon={<IconPlate icon={info.icon} label={info.name} size="md" plate="gold" />}
      onClose={onClose}
      foot={<>
        <Btn variant="primary" onClick={gotoTechTree}>进入科技树</Btn>
      </>}
    >
      <div class="acad-rp">
        <span class="num">{fmt(rp)}</span>
        <small>科研点</small>
      </div>

      {researching && (
        <TimerBar
          startAt={researching.startedAt}
          finishAt={researching.startedAt + (researching.durationMs ?? 0)}
          label={<>正在研发：<b>{researching.name ?? researching.code}</b></>}
          kind="gold"
        />
      )}

      <Divider />

      <StatGrid>
        <Stat label="当前成功率" value={`${(curProb * 100).toFixed(1)}%`} title="每次判定产出科研点的概率" />
        <Stat label="基础概率" value={`${(baseProb * 100).toFixed(1)}%`} />
        <Stat label="概率上限" value={`${(maxProb * 100).toFixed(1)}%`} />
        <Stat label="连续失败" value={`${failStreak} 次`} title="失败会累积概率，属于保底机制" />
        <Stat label="学院数量" value={`${count} 座`} title="学院越多，判定间隔越短" />
      </StatGrid>

      <div class="acad-prob-bar">
        <Bar pct={(curProb / Math.max(0.01, maxProb)) * 100} kind="steel" thin />
      </div>

      {count > 0 && <ResearchFormula formula={formula} baseIntervalSec={baseIntervalSec} intervalSec={intervalSec} />}

      {count > 0 && intervalSec > 0 && (
        <>
          <Divider />
          <TimerBar
            startAt={lastCheck}
            finishAt={lastCheck + intervalSec * 1000}
            label={`下次判定（每 ${fmtDur(intervalSec * 1000)} 一次）`}
            kind="steel"
          />
        </>
      )}

      <p class="acad-note">
        学院按固定间隔掷一次判定，成功则产出科研点。连续失败会逐次提高下一次的概率，
        所以长期期望是稳定的；多建学院会缩短判定间隔。
      </p>

      <BuildingManagement slotId={slotId} name="学院" onClose={onClose} />
    </Modal>
  );
}

function ResearchFormula({ formula, baseIntervalSec, intervalSec }: { formula: any; baseIntervalSec: number; intervalSec: number }) {
  const intervalSources = Array.isArray(formula?.intervalSources) ? formula.intervalSources : [];
  const probabilitySources = Array.isArray(formula?.probabilitySources) ? formula.probabilitySources : [];
  if (!intervalSources.length && !probabilitySources.length) return null;
  const sourceRows = (items: any[]) => items.map((item: any) => (
    <div class="acad-source-row" key={`${item.source}-${item.label}`}>
      <span>{item.label}</span><b>{item.displayValue}</b><small>{item.durationLabel ?? '持续生效'}</small>
    </div>
  ));
  return (
    <details class="acad-formula" open>
      <summary>判定间隔、概率与来源</summary>
      <div class="acad-formula-grid">
        <div>
          <h4>判定间隔</h4>
          <p class="acad-formula-total">基础 {fmtDur(baseIntervalSec * 1000)} → 当前 {fmtDur(intervalSec * 1000)}</p>
          {sourceRows(intervalSources)}
        </div>
        <div>
          <h4>成功概率</h4>
          <p class="acad-formula-total">当前 {((Number(formula.currentProbability) || 0) * 100).toFixed(1)}% · 上限 {((Number(formula.maxProbability) || 0) * 100).toFixed(1)}%</p>
          {sourceRows(probabilitySources)}
        </div>
      </div>
    </details>
  );
}
