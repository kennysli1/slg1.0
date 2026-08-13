/**
 * 任务条（常驻村庄页）：
 *  - 进行中任务（主线不可放弃 / 随机可放弃）
 *  - 上交资源类任务 → 弹窗提交
 *  - 清理营地类任务 → 提示前往地图清除标记营地
 *  - 酒馆可接取的随机任务 → 直接接取
 */
import { useState } from 'preact/hooks';
import { dataVersion, taskStates, tab, openModal } from '../../app/store.js';
import { me, req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { Panel, SectionHead, Btn, Tag, CostRow } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { fmt } from '../../shared/utils/format.js';
import { resInfo, treasureInfo, treasureEffectText } from '../../app/config.js';

function vid(): string {
  return me?.villageId ?? '';
}

function objText(task: any): string {
  const o = task.objective;
  if (o.kind === 'submit_resources') return '上交资源';
  if (o.kind === 'clear_camp') return `清理营地 ×${task.campTotal}`;
  if (o.kind === 'sell_discard_treasure') return `出售/丢弃稀有+宝物 ×${o.count}`;
  return o.kind;
}

/** 任务类型标签：主线=金、支线=橙、日常=绿。 */
function typeTag(type: string) {
  if (type === 'main') return <Tag kind="gold">主线</Tag>;
  if (type === 'side') return <Tag kind="ember">支线</Tag>;
  return <Tag kind="jade">日常</Tag>;
}

// ── 奖励展示（资源 + 任务专属宝物）────────────────────────────────────────────
function RewardRow({ rewards }: { rewards: any }) {
  if (!rewards) return null;
  const res: Record<string, number> = rewards.resources ?? {};
  const tres: string[] = rewards.treasures ?? [];
  const resEntries = Object.entries(res);
  if (resEntries.length === 0 && tres.length === 0) return null;
  return (
    <div class="task-card-reward">
      <span class="task-reward-label">奖励</span>
      <div class="task-reward-list">
        {resEntries.map(([k, v]: any) => {
          const info = resInfo(k);
          return (
            <span class="task-reward-chip" key={k}>
              {info.icon ? <img class="task-reward-ico" src={info.icon} alt="" /> : null}
              {info.name} {fmt(v)}
            </span>
          );
        })}
        {tres.map((code: string) => {
          const t = treasureInfo(code);
          return (
            <span class="task-reward-chip task-reward-chip--tre" key={code} title={t ? treasureEffectText(t) : code}>
              {t?.icon ? <img class="task-reward-ico" src={t.icon} alt="" /> : null}
              {t?.name ?? code}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── 上交资源弹窗 ───────────────────────────────────────────────────────────────
function SubmitModal({ task, close }: { task: any; close: () => void }) {
  const o = task.objective;
  const reqRes: Record<string, number> = o.resources ?? {};
  const submitted: Record<string, number> = task.submitted ?? {};
  const [vals, setVals] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const [k, need] of Object.entries(reqRes)) {
      init[k] = Math.max(0, need - (submitted[k] ?? 0));
    }
    return init;
  });

  const onInput = (k: string, v: string) => {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    setVals((p) => ({ ...p, [k]: n }));
  };

  const confirm = async () => {
    const resources: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals)) if (v > 0) resources[k] = v;
    await act(req('task.SubmitResources', { code: task.code, resources }), {
      okToast: '已上交资源',
      onOk: () => close(),
    });
  };

  return (
    <Modal title={`上交资源 · ${task.name}`} sub={task.desc} onClose={close}>
      <p class="task-submit-hint">仅需补齐剩余需求，不会超额扣除。</p>
      <div class="task-submit-grid">
        {Object.entries(reqRes).map(([k, need]) => {
          const info = resInfo(k);
          const done = submitted[k] ?? 0;
          return (
            <div class="task-submit-row" key={k}>
              <span class="task-submit-res">{info.name}</span>
              <input
                class="task-submit-input"
                type="number" min="0" value={vals[k] ?? 0}
                data-modal-initial-focus={k === Object.keys(reqRes)[0] ? 'true' : undefined}
                onInput={(e) => onInput(k, (e.target as HTMLInputElement).value)}
              />
              <span class="task-submit-prog">已交 {fmt(done)}/{fmt(need)}</span>
            </div>
          );
        })}
      </div>
      <div class="modal-foot">
        <Btn variant="ghost" onClick={close}>取消</Btn>
        <Btn variant="primary" onClick={confirm}>确认上交</Btn>
      </div>
    </Modal>
  );
}

// ── 单个进行中任务卡片 ────────────────────────────────────────────────────────
function TaskCard({ task }: { task: any }) {
  const o = task.objective;
  const isMain = task.type === 'main';

  const doAbandon = async () => {
    await act(req('task.Abandon', { code: task.code }), { okToast: '已放弃任务' });
  };
  const onAbandon = () => {
    if (task.type !== 'side') { void doAbandon(); return; }
    // 支线任务：放弃后永久不再出现，弹警告确认
    openModal((close) => (
      <Modal title="放弃支线任务" sub={task.name} onClose={close}>
        <p class="task-abandon-warn">支线任务放弃后将<strong>永久无法再次接取</strong>，确定要放弃吗？</p>
        <div class="modal-foot">
          <Btn variant="ghost" onClick={close}>取消</Btn>
          <Btn variant="danger" onClick={() => { close(); void doAbandon(); }}>确认放弃</Btn>
        </div>
      </Modal>
    ), `task-abandon-${task.code}`);
  };
  const onSubmit = () => {
    openModal((close) => <SubmitModal task={task} close={close} />, `task-submit-${task.code}`);
  };
  const onGoMap = () => { tab.value = 'map'; };

  return (
    <div class={`task-card task-card--${task.type}`}>
      <div class="task-card-head">
        <span class="task-card-name">{task.name}</span>
        {typeTag(task.type)}
      </div>
      <div class="task-card-desc">{task.desc}</div>

      {o.kind === 'submit_resources' && (
        <div class="task-card-obj">
          <CostRow cost={o.resources} />
          <div class="task-card-prog">
            {Object.entries(o.resources ?? {}).map(([k, need]: any) => {
              const done = task.submitted?.[k] ?? 0;
              return (
                <span key={k} class={`task-prog-chip${done >= need ? ' done' : ''}`}>
                  {resInfo(k).name} {fmt(done)}/{fmt(need)}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {o.kind === 'clear_camp' && (
        <div class="task-card-obj">
          <div class="task-card-prog">
            <span class={`task-prog-chip${task.campCleared >= task.campTotal ? ' done' : ''}`}>
              已清营地 {task.campCleared}/{task.campTotal}
            </span>
            {task.campTotal > 0 && <span class="task-prog-hint">地图上带 🎯 标记的营地</span>}
          </div>
        </div>
      )}
      {o.kind === 'sell_discard_treasure' && (
        <div class="task-card-obj">
          <div class="task-card-prog">
            <span class={`task-prog-chip${(task.progress ?? 0) >= (o.count ?? 1) ? ' done' : ''}`}>
              已出售/丢弃 {task.progress ?? 0}/{o.count} 个稀有+宝物
            </span>
          </div>
        </div>
      )}

      <RewardRow rewards={task.rewards} />

      <div class="task-card-actions">
        {o.kind === 'submit_resources' && (
          <Btn size="sm" variant="primary" onClick={onSubmit}>上交资源</Btn>
        )}
        {o.kind === 'clear_camp' && (
          <Btn size="sm" variant="ghost" onClick={onGoMap}>前往地图</Btn>
        )}
        {!isMain && (
          <Btn size="sm" variant="danger" onClick={onAbandon}>放弃</Btn>
        )}
      </div>
    </div>
  );
}

// ── 可接取任务（支线 + 酒馆日常委托）─────────────────────────────────────────
function OfferCard({ q, onAccept }: { q: any; onAccept: (code: string) => void }) {
  return (
    <div class="task-offer" key={q.code}>
      <div class="task-offer-info">
        <span class="task-offer-name">{q.name}</span>
        <span class="task-offer-desc">{q.desc}</span>
        <span class="task-offer-obj">{objText({ objective: q.objective })}</span>
        <RewardRow rewards={q.rewards} />
      </div>
      <Btn size="sm" variant="primary" onClick={() => onAccept(q.code)}>接取</Btn>
    </div>
  );
}

export function TaskOffers({ offered, offeredSide }: { offered: any[]; offeredSide?: any[] }) {
  const side = offeredSide ?? [];
  const onAccept = async (code: string) => {
    await act(req('task.Accept', { code }), { okToast: '已接取任务' });
  };
  if (!offered?.length && !side.length) return null;
  return (
    <div class="task-offers">
      {side.length > 0 && (
        <>
          <SectionHead sub={`${side.length} 个任务`}>支线任务</SectionHead>
          <div class="task-offer-list">
            {side.map((q) => <OfferCard q={q} onAccept={onAccept} />)}
          </div>
        </>
      )}
      {offered?.length > 0 && (
        <>
          <SectionHead sub={`${offered.length} 个委托`}>酒馆日常委托</SectionHead>
          <div class="task-offer-list">
            {offered.map((q) => <OfferCard q={q} onAccept={onAccept} />)}
          </div>
        </>
      )}
    </div>
  );
}

// ── 任务条主体 ────────────────────────────────────────────────────────────────
export function TaskBar() {
  dataVersion.value; // 资源/任务数据刷新时重渲
  taskStates.value;  // 任务推送时重渲
  const ts = taskStates.value[vid()] ?? null;
  const active: any[] = ts?.active ?? [];
  const offered: any[] = ts?.offered ?? [];
  const offeredSide: any[] = ts?.offeredSide ?? [];

  return (
    <section class="task-bar">
      <SectionHead>任务</SectionHead>
      {active.length === 0 && offered.length === 0 && offeredSide.length === 0 ? (
        <Panel variant="flat" pad class="task-empty">暂无可进行的任务。</Panel>
      ) : (
        <div class="task-active-list">
          {active.map((t) => <TaskCard task={t} key={t.code} />)}
        </div>
      )}
      <TaskOffers offered={offered} offeredSide={offeredSide} />
    </section>
  );
}
