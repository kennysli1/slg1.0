/**
 * 玩家任务页（历史文件名保留 TaskBar 以兼容旧入口）：
 *  - 进行中任务（主线不可放弃 / 随机可放弃）
 *  - 上交资源类任务 → 弹窗提交
 *  - 清理营地类任务 → 提示前往地图清除标记营地
 *  - 酒馆可接取的随机任务 → 直接接取
 */
import { useState } from 'preact/hooks';
import { dataVersion, taskStates, playerTaskState, tab, openModal, selected, showToast } from '../../app/store.js';
import { me, req, selectVillage } from '../../api.js';
import { act, setMapCenter } from '../../app/refresh.js';
import { Panel, SectionHead, Btn, Tag, CostRow, confirmDanger } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { fmt } from '../../shared/utils/format.js';
import { resInfo, treasureInfo, treasureEffectText } from '../../app/config.js';
import { pendingTaskCamps, type TaskCampCoordinate } from '../map/map-navigation.js';
import { openTradeCenter } from '../trade/TradeModal.js';

function vid(): string {
  return me?.villageId ?? '';
}

function villageName(villageId?: string): string {
  if (!villageId) return '';
  return me?.villages?.find((v) => v.id === villageId)?.name ?? villageId;
}

/** 聚合任务卡操作前切换到任务来源村，保证 ownVillage 路由落到正确状态。 */
async function ensureTaskVillage(villageId?: string): Promise<boolean> {
  if (!villageId || villageId === me?.villageId) return true;
  const result = await selectVillage(villageId);
  if (!result.ok) {
    showToast('无法切换到任务所属村庄', 'bad');
    return false;
  }
  return true;
}

function objText(task: any): string {
  const o = task.objective;
  if (o.kind === 'submit_resources') return '上交资源';
  if (o.kind === 'clear_camp') return `清理营地 ×${task.campTotal}`;
  if (o.kind === 'sell_discard_treasure') return `出售/丢弃稀有+宝物 ×${o.count}`;
  if (o.kind === 'deliver_to_npc') return `向幸福村运输 ${resInfo(o.deliverResource).name} ×${o.deliverAmount}`;
  return o.kind;
}

/** 任务类型标签：主线=金、支线=橙、日常=绿。 */
function typeTag(type: string) {
  if (type === 'main') return <Tag kind="gold">主线</Tag>;
  if (type === 'side') return <Tag kind="ember">支线</Tag>;
  return <Tag kind="jade">日常</Tag>;
}

// ── 奖励展示（资源 + 任务专属宝物）────────────────────────────────────────────
function RewardRow({ rewards, label = '奖励' }: { rewards: any; label?: string }) {
  if (!rewards) return null;
  const res: Record<string, number> = rewards.resources ?? {};
  const tres: string[] = rewards.treasures ?? [];
  const reputation = Number(rewards.reputation) || 0;
  const resEntries = Object.entries(res);
  if (resEntries.length === 0 && tres.length === 0 && reputation === 0) return null;
  return (
    <div class="task-card-reward">
      <span class="task-reward-label">{label}</span>
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
        {reputation !== 0 && (
          <span class="task-reward-chip task-reward-chip--reputation">
            声望 {reputation > 0 ? '+' : ''}{reputation}
          </span>
        )}
      </div>
    </div>
  );
}

function OutcomeRows({ rewards }: { rewards: any }) {
  if (!rewards) return null;
  return (
    <>
      <RewardRow rewards={rewards} label="完成可得" />
      {rewards.failure && <RewardRow rewards={rewards.failure} label="任务失败可得" />}
      {(rewards.choices ?? []).map((choice: any) => (
        <RewardRow key={choice.key} rewards={choice} label={choice.label ?? '分支结果'} />
      ))}
    </>
  );
}

// ── 上交资源弹窗 ───────────────────────────────────────────────────────────────
function SubmitModal({ task, close }: { task: any; close: () => void }) {
  const o = task.objective;
  const reqRes: Record<string, number> = o.resources ?? {};
  const submitted: Record<string, number> = task.submitted ?? {};
  const remaining = (k: string) => Math.max(0, (reqRes[k] ?? 0) - (submitted[k] ?? 0));
  const [vals, setVals] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const [k, need] of Object.entries(reqRes)) {
      init[k] = Math.max(0, need - (submitted[k] ?? 0));
    }
    return init;
  });

  const onInput = (k: string, v: string) => {
    const n = Math.min(remaining(k), Math.max(0, Math.floor(Number(v) || 0)));
    setVals((p) => ({ ...p, [k]: n }));
  };

  const confirm = async () => {
    const resources: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals)) if (v > 0) resources[k] = v;
    if (!await ensureTaskVillage(task.villageId)) return;
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
                type="number" min="0" max={remaining(k)} value={vals[k] ?? 0}
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

// ── 交付奖励弹窗 ───────────────────────────────────────────────────────────────
function RewardModal({ task, rewards, close }: { task: any; rewards: any; close: () => void }) {
  const res = rewards?.resources ?? null;
  const tres: string[] = rewards?.treasures ?? [];
  const hasRes = res && Object.keys(res).length > 0;
  const hasTres = tres.length > 0;
  return (
    <Modal title={`任务完成 · ${task.name}`} onClose={close}>
      {hasRes || hasTres
        ? <p class="task-reward-hint">你获得了以下奖励：</p>
        : <p class="task-reward-hint">任务已完成（本次无奖励，可能已达每日预算上限）。</p>}
      <RewardRow rewards={{ resources: res ?? {}, treasures: tres, reputation: rewards?.reputation }} label="本次获得" />
      <div class="modal-foot">
        <Btn variant="primary" onClick={close}>收下</Btn>
      </div>
    </Modal>
  );
}
function TaskCard({ task }: { task: any }) {
  const o = task.objective;
  const isMain = task.type === 'main';
  const camps = o.kind === 'clear_camp'
    ? pendingTaskCamps(task.camps as TaskCampCoordinate[] | undefined)
    : [];

  const onAbandon = async () => {
    const isSide = task.type === 'side';
    const ok = await confirmDanger({
      title: `放弃任务 · ${task.name}`,
      body: isSide
        ? '支线任务放弃后将永久无法再次接取，确定要放弃吗？'
        : '当前任务进度会被清除；如果任务再次出现，需要从头开始。',
      confirmText: '确认放弃',
    });
    if (!ok) return;
    if (!await ensureTaskVillage(task.villageId)) return;
    await act(req('task.Abandon', { code: task.code }), { okToast: '已放弃任务' });
  };
  const onSubmit = () => {
    openModal((close) => <SubmitModal task={task} close={close} />, `task-submit-${task.code}`);
  };
  const onGoMap = async (camp = camps[0]) => {
    if (!camp) return;
    if (!await ensureTaskVillage(task.villageId)) return;
    // 设置地图初始视角与选中目标：地图挂载后会显示既有的金色选中环和目标面板。
    setMapCenter({ q: camp.q, r: camp.r });
    selected.value = { refId: camp.id, kind: 'pve', q: camp.q, r: camp.r, name: '任务营地', icon: 'pve_bandits' };
    tab.value = 'map';
  };
  const onDeliver = () => {
    void (async () => {
      if (!await ensureTaskVillage(task.villageId)) return;
      await act(req('task.Deliver', { code: task.code }), {
      okToast: '任务完成',
      onOk: (payload) => {
        openModal((close) => <RewardModal task={task} rewards={payload?.rewards} close={close} />, `task-reward-${task.code}`);
      },
      });
    })();
  };
  const onOpenTrade = async () => {
    if (await ensureTaskVillage(task.villageId)) openTradeCenter();
  };

  return (
    <div class={`task-card task-card--${task.type}`}>
      <div class="task-card-head">
        <span class="task-card-name">{task.name}</span>
        {typeTag(task.type)}
        {task.villageId && <span class="task-card-village">{villageName(task.villageId)}</span>}
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
            {camps.length > 0
              ? <span class="task-prog-hint">地图上带 🎯 标记的营地</span>
              : task.campTotal > 0 && <span class="task-prog-hint">所有营地均已清理</span>}
            {task.awaitingNatalieDecision && <span class="task-prog-hint task-prog-hint--warn">阶段 2/2：请在报告中选择释放或放入宝库。</span>}
          </div>
          {camps.length > 0 && (
            <div class="task-camp-locations" aria-label="待清理任务营地坐标">
              <span class="task-camp-locations-label">营地坐标</span>
              {camps.map((camp) => (
                <Btn size="sm" variant="ghost" key={camp.id} onClick={() => onGoMap(camp)}>
                  X {camp.q} · Y {camp.r}
                </Btn>
              ))}
            </div>
          )}
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
      {o.kind === 'deliver_to_npc' && (
        <div class="task-card-obj">
          <div class="task-card-prog">
            <span class="task-prog-hint">向幸福村运输 {resInfo(o.deliverResource).name} ×{o.deliverAmount}</span>
            {task.npcPending ? (
              <span class="task-prog-hint task-prog-hint--warn">幸福村已出现；建造贸易中心后可创建送达订单</span>
            ) : task.npcVillageId ? (
              <span class="task-prog-hint task-prog-hint--ok">幸福村已出现在附近，前往贸易中心接取粮食订单</span>
            ) : (
              <span class="task-prog-hint">正在生成幸福村…</span>
            )}
          </div>
        </div>
      )}

      <OutcomeRows rewards={task.rewards} />

      <div class="task-card-actions">
        {task.ready ? (
          <Btn size="sm" variant="primary" onClick={onDeliver}>{task.natalieDecision === 'release' ? '领取奖励' : '完成任务'}</Btn>
        ) : (
          <>
            {o.kind === 'submit_resources' && (
              <Btn size="sm" variant="primary" onClick={onSubmit}>上交资源</Btn>
            )}
            {o.kind === 'clear_camp' && camps.length > 0 && (
              <Btn size="sm" variant="ghost" onClick={() => onGoMap()}>前往地图</Btn>
            )}
            {o.kind === 'deliver_to_npc' && !task.npcPending && (
              <Btn size="sm" variant="primary" onClick={() => void onOpenTrade()}>前往贸易中心</Btn>
            )}
          </>
        )}
        {!isMain && (
          <Btn size="sm" variant="danger" onClick={onAbandon}>放弃</Btn>
        )}
      </div>
    </div>
  );
}

// ── 可接取任务（支线 + 酒馆日常委托）─────────────────────────────────────────
function OfferCard({ q, onAccept }: { q: any; onAccept: (q: any) => void }) {
  return (
    <div class="task-offer" key={q.code}>
      <div class="task-offer-info">
        <span class="task-offer-name">{q.name}</span>
        {q.villageId && <span class="task-offer-village">{villageName(q.villageId)}</span>}
        <span class="task-offer-desc">{q.desc}</span>
        <span class="task-offer-obj">{objText({ objective: q.objective })}</span>
        <OutcomeRows rewards={q.rewards} />
      </div>
      <Btn size="sm" variant="primary" onClick={() => onAccept(q)}>接取</Btn>
    </div>
  );
}

export function TaskOffers({ offered, offeredSide }: { offered: any[]; offeredSide?: any[] }) {
  const side = offeredSide ?? [];
  const onAccept = async (q: any) => {
    if (!await ensureTaskVillage(q.villageId)) return;
    await act(req('task.Accept', { code: q.code }), { okToast: '已接取任务' });
  };
  if (!offered?.length && !side.length) return null;
  return (
    <div class="task-offers">
      {side.length > 0 && (
        <>
          <SectionHead sub={`${side.length} 个任务`}>支线任务</SectionHead>
          <div class="task-offer-list">
            {side.map((q) => <OfferCard key={`${q.villageId ?? ''}:${q.code}`} q={q} onAccept={onAccept} />)}
          </div>
        </>
      )}
      {offered?.length > 0 && (
        <>
          <SectionHead sub={`${offered.length} 个委托`}>酒馆日常委托</SectionHead>
          <div class="task-offer-list">
            {offered.map((q) => <OfferCard key={`${q.villageId ?? ''}:${q.code}`} q={q} onAccept={onAccept} />)}
          </div>
        </>
      )}
    </div>
  );
}

// ── 任务页主体 ────────────────────────────────────────────────────────────────
function TaskBoard({ state, playerWide = false }: { state: any; playerWide?: boolean }) {
  const active: any[] = state?.active ?? [];
  const offered: any[] = state?.offered ?? [];
  const offeredSide: any[] = state?.offeredSide ?? [];
  return (
    <section class="task-bar">
      <SectionHead sub={playerWide ? '跨村统一显示；每张任务卡标注所属村庄' : undefined}>任务</SectionHead>
      {active.length === 0 && offered.length === 0 && offeredSide.length === 0 ? (
        <Panel variant="flat" pad class="task-empty">暂无可进行的任务。</Panel>
      ) : (
        <div class="task-active-list">
          {active.map((t) => <TaskCard task={t} key={`${t.villageId ?? ''}:${t.code}`} />)}
        </div>
      )}
      <TaskOffers offered={offered} offeredSide={offeredSide} />
    </section>
  );
}

/** 玩家绑定的独立任务页。 */
export function TasksScreen() {
  dataVersion.value;
  playerTaskState.value;
  return <TaskBoard state={playerTaskState.value} playerWide />;
}

/** 兼容旧嵌入点：村庄页不再渲染，但保留按当前村读取的组件供旧入口使用。 */
export function TaskBar() {
  dataVersion.value; // 资源/任务数据刷新时重渲
  taskStates.value;  // 任务推送时重渲
  const ts = taskStates.value[vid()] ?? null;
  return <TaskBoard state={ts} />;
}
