/**
 * 玩家任务页（历史文件名保留 TaskBar 以兼容旧入口）：
 *  - 进行中任务（主线不可放弃 / 随机可放弃）
 *  - 上交资源类任务 → 弹窗提交
 *  - 清理营地类任务 → 提示前往地图清除标记营地
 *  - 酒馆可接取的随机任务 → 直接接取
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { dataVersion, taskStates, playerTaskState, kingdomState, tick, tab, openModal, selected, showToast } from '../../app/store.js';
import { me, req, selectVillage } from '../../api.js';
import { act, setMapCenter } from '../../app/refresh.js';
import { Btn, Tag, Icon, CostRow, confirmDanger } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { fmt, secLeft } from '../../shared/utils/format.js';
import { buildingInfo, resInfo, treasureInfo, treasureEffectText } from '../../app/config.js';
import { pendingTaskCamps, type TaskCampCoordinate } from '../map/map-navigation.js';
import { openTradeCenter } from '../trade/TradeModal.js';
import { VillageList } from '../../shared/ui/VillageList.js';
import { readTaskMenuOpenState, writeTaskMenuOpenState, type TaskMenuOpenState } from './task-menu-state.js';
import { acceptReplyIntent, deliverReplyIntent, nextDialogueSegment, visibleDialogueSegments } from './task-dialogue-flow.js';

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

/** 全局任务由当前选中的村执行；村庄任务才需要切换到任务绑定村。 */
async function ensureTaskExecution(task: any): Promise<boolean> {
  if (task?.scope === 'global') return Boolean(me?.villageId);
  return ensureTaskVillage(task?.villageId);
}

function objText(task: any): string {
  const o = task.objective;
  if (o.kind === 'submit_resources') return '上交资源';
  if (o.kind === 'repair_buildings') return `修复资源田（${(o.buildingKinds ?? []).map((kind: string) => buildingInfo(kind).name).join('、')}）`;
  if (o.kind === 'build_buildings') return `建造城内建筑 ×${o.count}`;
  if (o.kind === 'population_reached') return `主城人口达到 ${o.count}`;
  if (o.kind === 'resource_owned') return `主城拥有${resInfo(o.resourceKey).name} ${o.count}`;
  if (o.kind === 'explore_tiles') return `累计探索地图 ${o.count} 格`;
  if (o.kind === 'clear_camp') return `清理营地 ×${task.campTotal}`;
  if (o.kind === 'sell_discard_treasure') return `出售/丢弃稀有+宝物 ×${o.count}`;
  if (o.kind === 'deliver_to_npc') return `向幸福村运输 ${resInfo(o.deliverResource).name} ×${o.deliverAmount}`;
  if (o.kind === 'research_completed') return `拥有学院并研发科技 ×${o.count}`;
  if (o.kind === 'kill_units') return `累计击杀${o.unitCategory === 'cavalry' ? '骑兵' : (o.unitCategory ?? '指定兵种')} ${o.count} 人口`;
  if (o.kind === 'defend_task_village') return '守住天王老子村的攻城';
  if (o.kind === 'raid_task_village') return '掠夺天王老子村';
  if (o.kind === 'reputation_at_most') return `声望值达到 ${o.threshold} 或更低`;
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
  const population = Number(rewards.population) || 0;
  const populationGrowth = rewards.populationGrowth ?? null;
  const resourceGrowth = rewards.resourceGrowth ?? null;
  const buildingUnlocks: string[] = rewards.buildingUnlocks ?? [];
  const researchPoints = Number(rewards.researchPoints) || 0;
  const mercenaries: Record<string, number> = rewards.mercenaries ?? {};
  const mercenaryExchange = rewards.reputationMercenaryExchange ?? null;
  const reputationResetFrom = Number(rewards.reputationResetFrom) || 0;
  const resEntries = Object.entries(res);
  if (resEntries.length === 0 && tres.length === 0 && reputation === 0 && reputationResetFrom === 0 && population === 0 && researchPoints === 0 && Object.keys(mercenaries).length === 0 && !mercenaryExchange && !populationGrowth && !resourceGrowth && buildingUnlocks.length === 0) return null;
  return (
    <div class="task-card-reward">
      <span class="task-reward-label">{label}</span>
      <div class="task-reward-list">
        {resEntries.map(([k, v]: any) => {
          const info = resInfo(k);
          return (
            <span class="task-reward-chip" key={k}>
              {info.icon ? <Icon icon={info.icon} label={info.name} size="2xs" class="task-reward-ico" decorative /> : null}
              {info.name} {fmt(v)}
            </span>
          );
        })}
        {tres.map((code: string) => {
          const t = treasureInfo(code);
          return (
            <span class="task-reward-chip task-reward-chip--tre" key={code} title={t ? treasureEffectText(t) : code}>
              {t?.icon ? <Icon icon={t.icon} label={t.name} size="2xs" class="task-reward-ico" decorative /> : null}
              {t?.name ?? code}
            </span>
          );
        })}
        {reputation !== 0 && (
          <span class="task-reward-chip task-reward-chip--reputation">
            声望 {reputation > 0 ? '+' : ''}{reputation}
          </span>
        )}
        {reputationResetFrom > 0 && (
          <span class="task-reward-chip task-reward-chip--reputation">
            声望归零（-{reputationResetFrom}）
          </span>
        )}
        {researchPoints > 0 && <span class="task-reward-chip">科研点 {fmt(researchPoints)}</span>}
        {Object.entries(mercenaries).map(([code, count]: any) => (
          <span class="task-reward-chip" key={`merc-${code}`}>佣兵 {code} ×{fmt(count)}</span>
        ))}
        {mercenaryExchange && (
          <span class="task-reward-chip">正声望归零：每减少1点获得 {mercenaryExchange.perPoint} 名佣兵</span>
        )}
        {population !== 0 && (
          <span class="task-reward-chip task-reward-chip--population">
            人口 {population > 0 ? '+' : ''}{fmt(population)}
          </span>
        )}
        {populationGrowth && Number(populationGrowth.percent) > 0 && (
          <span class="task-reward-chip task-reward-chip--population-growth">
            人口增长 +{fmt(populationGrowth.percent)}%（{Math.round(Number(populationGrowth.durationSec) / 3600)}小时）
          </span>
        )}
        {resourceGrowth && Number(resourceGrowth.percent) > 0 && (
          <span class="task-reward-chip task-reward-chip--population-growth">
            {resourceGrowth.resource ? `${resInfo(resourceGrowth.resource).name}产量` : '四种资源产量'} +{fmt(resourceGrowth.percent)}%（{Math.round(Number(resourceGrowth.durationSec) / 3600)}小时）
          </span>
        )}
        {buildingUnlocks.map((kind) => <span class="task-reward-chip" key={kind}>解锁建筑 {kind}</span>)}
      </div>
    </div>
  );
}

function OutcomeRows({ rewards, failed = false }: { rewards: any; failed?: boolean }) {
  if (!rewards) return null;
  if (failed) return <RewardRow rewards={rewards.failure} label="任务失败可得" />;
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
    if (!await ensureTaskExecution(task)) return;
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
function RewardModal({ task, previewRewards, rewardVillageId, dialogue, close }: { task: any; previewRewards: any; rewardVillageId?: string; dialogue?: any; close: () => void }) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rewards, setRewards] = useState(previewRewards);
  const deliveryInFlight = useRef(false);
  const segments = visibleDialogueSegments(dialogue);
  const current = segments[segmentIndex] ?? dialogue;
  const closeSession = useCallback(() => {
    if (!deliveryInFlight.current) close();
  }, [close]);
  const advanceSegment = useCallback(() => {
    const next = nextDialogueSegment(segmentIndex, segments.length);
    if (next == null) close();
    else setSegmentIndex(next);
  }, [close, segmentIndex, segments.length]);
  const onReply = async (key: string) => {
    if (deliveryInFlight.current) return;
    const intent = deliverReplyIntent(key, claimed);
    if (intent === 'close') {
      closeSession();
      return;
    }
    if (intent === 'advance') {
      advanceSegment();
      return;
    }
    if (intent !== 'claim') return;

    // useRef 与 busy 双保险：同一渲染帧内的双击也只能发送一个 Deliver。
    deliveryInFlight.current = true;
    setBusy(true);
    let settled: any = null;
    const ok = await act(req('task.Deliver', { code: task.code }), {
      okToast: '奖励已领取',
      onOk: (payload) => { settled = payload; },
    });
    if (ok) {
      setRewards(settled?.rewards ?? previewRewards);
      setClaimed(true);
      advanceSegment();
    }
    deliveryInFlight.current = false;
    setBusy(false);
  };
  const res = rewards?.resources ?? null;
  const tres: string[] = rewards?.treasures ?? [];
  const hasRes = res && Object.keys(res).length > 0;
  const hasTres = tres.length > 0;
  const hasReputation = Number(rewards?.reputation) !== 0;
  const hasPopulation = Number(rewards?.population) !== 0;
  const hasPopulationGrowth = !!rewards?.populationGrowth;
  const hasResourceGrowth = !!rewards?.resourceGrowth;
  const hasBuildingUnlocks = (rewards?.buildingUnlocks ?? []).length > 0;
  const hasResearchPoints = Number(rewards?.researchPoints) !== 0;
  const hasMercenaries = Object.keys(rewards?.mercenaries ?? {}).length > 0;
  const hasMercenaryExchange = !!rewards?.reputationMercenaryExchange;
  const hasReputationReset = Number(rewards?.reputationResetFrom) > 0;
  return (
    <Modal title={`${claimed ? '任务完成' : '领取奖励'} · ${task.name}`} onClose={closeSession}>
      <p class="task-reward-hint">{claimed ? '已领取以下奖励：' : '完成任务后将获得：'}</p>
      {(hasRes || hasTres || hasReputation || hasReputationReset || hasPopulation || hasPopulationGrowth || hasResourceGrowth || hasBuildingUnlocks || hasResearchPoints || hasMercenaries || hasMercenaryExchange) && (
        <RewardRow rewards={{ resources: res ?? {}, treasures: tres, reputation: rewards?.reputation, reputationResetFrom: rewards?.reputationResetFrom, population: rewards?.population, populationGrowth: rewards?.populationGrowth, resourceGrowth: rewards?.resourceGrowth, buildingUnlocks: rewards?.buildingUnlocks, researchPoints: rewards?.researchPoints, mercenaries: rewards?.mercenaries, reputationMercenaryExchange: rewards?.reputationMercenaryExchange }} label={claimed ? '实际奖励' : '预计奖励'} />
      )}
      {(rewards?.rewardVillageId || rewardVillageId || task?.rewardVillageId) && (
        <p class="task-reward-hint">奖励发放至：{villageName(rewards?.rewardVillageId ?? rewardVillageId ?? task.rewardVillageId)}</p>
      )}
      {current && (current.npcName || current.npcText || (current.replies ?? []).length > 0) && (
        <div class="dialogue-session task-delivery-dialogue">
          {current.npcName && <div class="dialogue-npc-name">{current.npcName}</div>}
          {current.npcText && <div class="dialogue-npc-text">{current.npcText}</div>}
          {(current.replies ?? []).length > 0 && (
            <div class="dialogue-replies" aria-label="玩家回复">
              {(current.replies ?? []).map((reply: any) => (
                <Btn key={reply.key} variant={reply.key === 'leave' ? 'ghost' : 'primary'} disabled={busy} onClick={() => void onReply(reply.key)}>
                  {reply.label}
                </Btn>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── 失败确认弹窗 ─────────────────────────────────────────────────────────────
// 失败奖励和失败对话在点击“任务失败”后一次性展示；没有配置奖励/文本时仍明确告知玩家任务已失败。
function FailureModal({ task, rewards, dialogue, close }: { task: any; rewards: any; dialogue?: any; close: () => void }) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const segments = (Array.isArray(dialogue?.segments) && dialogue.segments.length ? dialogue.segments : [dialogue])
    .filter((item: any) => item && (item.npcName || item.npcText));
  const current = segments[segmentIndex];
  const hasRewards = Boolean(
    rewards?.resources && Object.keys(rewards.resources).length
      || rewards?.treasures?.length
      || Number(rewards?.reputation)
      || Number(rewards?.population)
      || rewards?.populationGrowth
      || Number(rewards?.researchPoints)
      || Object.keys(rewards?.mercenaries ?? {}).length,
  );
  const next = () => {
    if (segmentIndex < segments.length - 1) setSegmentIndex((value) => value + 1);
    else close();
  };
  return (
    <Modal title={`任务失败 · ${task.name}`} onClose={close}>
      <p class="task-reward-hint">{hasRewards ? '任务失败后获得以下物品：' : '任务已失败，本次没有奖励。'}</p>
      {hasRewards && <RewardRow rewards={rewards} label="失败获得" />}
      {(rewards?.rewardVillageId || task?.rewardVillageId) && (
        <p class="task-reward-hint">物品发放至：{villageName(rewards?.rewardVillageId ?? task.rewardVillageId)}</p>
      )}
      {current && (
        <div class="dialogue-session task-delivery-dialogue">
          {current.npcName && <div class="dialogue-npc-name">{current.npcName}</div>}
          {current.npcText && <div class="dialogue-npc-text">{current.npcText}</div>}
        </div>
      )}
      <div class="modal-foot">
        <Btn variant="primary" onClick={next}>{segmentIndex < segments.length - 1 ? '继续' : '关闭'}</Btn>
      </div>
    </Modal>
  );
}

// ── 任务 NPC 对话弹窗 ────────────────────────────────────────────────────────
function DialogueModal({ dialogue, task, close }: { dialogue: any; task: any; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const accepting = useRef(false);
  const segments = visibleDialogueSegments(dialogue);
  const current = segments[segmentIndex] ?? dialogue;
  const closeSession = useCallback(() => close(), [close]);
  const advanceSegment = useCallback(() => {
    const next = nextDialogueSegment(segmentIndex, segments.length);
    if (next == null) close();
    else setSegmentIndex(next);
  }, [close, segmentIndex, segments.length]);
  const onReply = async (key: string) => {
    if (accepting.current) return;
    const intent = acceptReplyIntent(key, accepted);
    if (intent === 'close') {
      closeSession();
      return;
    }
    if (intent === 'advance') {
      advanceSegment();
      return;
    }
    accepting.current = true;
    setBusy(true);
    if (!await ensureTaskExecution(task)) {
      accepting.current = false;
      setBusy(false);
      return;
    }
    await act(req('task.Accept', { code: task.code }), {
      okToast: '已接取任务',
      onOk: () => {
        setAccepted(true);
        advanceSegment();
      },
    });
    accepting.current = false;
    setBusy(false);
  };

  return (
    <Modal title={current?.npcName || '任务对话'} sub={task.name} onClose={closeSession}>
      <div class="dialogue-session">
        <div class="dialogue-npc-text">{current?.npcText ?? ''}</div>
        <div class="dialogue-replies" aria-label="玩家回复">
          {(current?.replies ?? []).map((reply: any) => (
            <Btn
              key={reply.key}
              variant={reply.key === 'leave' ? 'ghost' : 'primary'}
              disabled={busy}
              onClick={() => void onReply(reply.key)}
            >
              {reply.label}
            </Btn>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function TaskCard({ task, hideHeader = false }: { task: any; hideHeader?: boolean }) {
  // m8 攻城倒计时按秒刷新；不依赖服务端重复推送任务快照。
  tick.value;
  const o = task.objective;
  const isMain = task.type === 'main';
  const camps = o.kind === 'clear_camp'
    ? pendingTaskCamps(task.camps as TaskCampCoordinate[] | undefined)
    : [];
  const taskVillage = (o.kind === 'defend_task_village' || o.kind === 'raid_task_village') && task.taskVillageXY
    ? { id: String(task.taskVillageId ?? `${task.taskVillageXY.q},${task.taskVillageXY.r}`), q: Number(task.taskVillageXY.q), r: Number(task.taskVillageXY.r) }
    : undefined;

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
    if (!await ensureTaskExecution(task)) return;
    await act(req('task.Abandon', { code: task.code }), { okToast: '已放弃任务' });
  };
  const onSubmit = () => {
    openModal((close) => <SubmitModal task={task} close={close} />, `task-submit-${task.code}`);
  };
  const onGoMap = async (camp = camps[0] ?? taskVillage) => {
    if (!camp) return;
    if (!await ensureTaskExecution(task)) return;
    // 设置地图初始视角与选中目标：地图挂载后会显示既有的金色选中环和目标面板。
    setMapCenter({ q: camp.q, r: camp.r });
    selected.value = { refId: camp.id, kind: 'pve', q: camp.q, r: camp.r, name: taskVillage && camp.id === taskVillage.id ? '天王老子村' : '任务营地', icon: 'pve_bandits' };
    tab.value = 'map';
  };
  const onDeliver = () => {
    void (async () => {
      if (!await ensureTaskExecution(task)) return;
      await act(req('task.StartDeliver', { code: task.code }), {
        onOk: (payload) => {
          openModal((close) => (
            <RewardModal
              task={task}
              previewRewards={payload?.previewRewards}
              rewardVillageId={payload?.rewardVillageId}
              dialogue={payload?.dialogue}
              close={close}
            />
          ), `task-reward-${task.code}`);
        },
      });
    })();
  };
  const onFail = () => {
    void (async () => {
      if (!await ensureTaskExecution(task)) return;
      await act(req('task.Fail', { code: task.code }), {
        okToast: '任务已确认失败',
        onOk: (payload) => {
          openModal((close) => (
            <FailureModal task={task} rewards={payload?.rewards} dialogue={payload?.dialogue} close={close} />
          ), `task-failure-${task.code}`);
        },
      });
    })();
  };
  const onOpenTrade = async () => {
    if (await ensureTaskExecution(task)) openTradeCenter();
  };

  return (
    <div class={`task-card task-card--${task.type}`}>
      {!hideHeader && (
        <div class="task-card-head">
          <span class="task-card-name">{task.name}</span>
          {typeTag(task.type)}
          {task.scope === 'global'
            ? <Tag kind="steel">全局</Tag>
            : task.villageId && <span class="task-card-village">{villageName(task.villageId)}</span>}
        </div>
      )}
      <div class="task-card-desc">{task.desc}</div>
      <div class="task-card-objective-content">
      {o.kind === 'defend_task_village' && task.taskVillageAttackAt && !task.outcome && (
        <div class="task-card-obj"><span class="task-prog-hint task-prog-hint--warn">
          {task.taskVillageAttackAt > Date.now() ? `天王老子村将在 ${secLeft(task.taskVillageAttackAt)} 后发动攻城` : '天王老子村已发动攻城，等待战斗结果'}
        </span></div>
      )}
      {(o.kind === 'defend_task_village' || o.kind === 'raid_task_village') && task.taskVillageXY && (
        <div class="task-card-obj"><span class="task-prog-hint">任务村坐标 X {task.taskVillageXY.q} · Y {task.taskVillageXY.r}</span>{task.outcome && <span class="task-prog-hint">m8 结局：{task.outcome === 'success' ? '防守成功' : '防守失败'}</span>}<Btn size="sm" variant="ghost" onClick={() => void onGoMap(taskVillage)}>前往地图</Btn></div>
      )}

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
      {o.kind === 'repair_buildings' && (
        <div class="task-card-obj">
          <ol class="task-checklist" aria-label="资源田修复进度">
            {((o.buildingKinds ?? []) as string[]).map((kind, index) => {
              const done = (task.repairedBuildings ?? []).includes(kind);
              const info = buildingInfo(kind);
              return (
                <li key={kind} class={`task-checklist-item${done ? ' done' : ''}`}>
                  <span class="task-checklist-mark" aria-hidden="true">{done ? '✓' : index + 1}</span>
                  <Icon icon={info.icon} label={info.name} size="2xs" class="task-checklist-icon" decorative />
                  <span class="task-checklist-name">{info.name}</span>
                  <span class="task-checklist-status">{done ? '已修复' : '待修复'}</span>
                </li>
              );
            })}
          </ol>
          <span class="task-prog-hint">请在村庄页面修复被破坏的资源田</span>
        </div>
      )}
      {(o.kind === 'build_buildings' || o.kind === 'population_reached' || o.kind === 'resource_owned' || o.kind === 'explore_tiles' || o.kind === 'main_base_level' || o.kind === 'kill_units') && (
        <div class="task-card-obj">
          <div class="task-card-prog">
            <span class={`task-prog-chip${(task.progress ?? 0) >= (o.count ?? 1) ? ' done' : ''}`}>
              当前进度 {fmt(Math.min(task.progress ?? 0, o.count ?? 1))}/{fmt(o.count ?? 1)}
            </span>
            {o.kind === 'build_buildings' && <span class="task-prog-hint">主城城内已建成建筑</span>}
            {o.kind === 'population_reached' && <span class="task-prog-hint">主城总人口（含军队人口）</span>}
            {o.kind === 'resource_owned' && <span class="task-prog-hint">不消耗资源，只检查主城当前拥有量</span>}
            {o.kind === 'explore_tiles' && <span class="task-prog-hint">城镇初始视野与之后探索的格子都会计入</span>}
            {o.kind === 'main_base_level' && <span class="task-prog-hint">主基地等级达到目标后即可领取</span>}
            {o.kind === 'kill_units' && <span class="task-prog-hint">累计消灭敌方{ o.unitCategory === 'cavalry' ? '骑兵' : (o.unitCategory ?? '指定兵种') }人口</span>}
          </div>
        </div>
      )}
      {o.kind === 'reputation_at_most' && (
        <div class="task-card-obj">
          <div class="task-card-prog">
            <span class={`task-prog-chip${Number(task.progress) <= Number(o.threshold) ? ' done' : ''}`}>
              当前声望 {fmt(Number(task.progress) || 0)} / 目标 ≤{fmt(Number(o.threshold) || 0)}
            </span>
            <span class="task-prog-hint">声望达到目标后即可领取</span>
          </div>
        </div>
      )}
      {o.kind === 'research_completed' && (
        <div class="task-card-obj"><div class="task-card-prog"><span class={`task-prog-chip${(task.progress ?? 0) >= (o.count ?? 1) ? ' done' : ''}`}>已研发 {fmt(Math.min(task.progress ?? 0, o.count ?? 1))}/{fmt(o.count ?? 1)} 项科技</span><span class="task-prog-hint">需要先建造学院</span></div></div>
      )}
      {(o.kind === 'defend_task_village' || o.kind === 'raid_task_village') && (task.ready || task.failureReady) && (
        <div class="task-card-obj"><span class={`task-prog-hint ${task.failureReady ? 'task-prog-hint--warn' : 'task-prog-hint--ok'}`}>
          {task.failureReady ? '任务失败，请确认任务失败' : '目标已达成，请领取奖励'}
        </span></div>
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
      </div>

      <OutcomeRows rewards={task.rewards} failed={task.failureReady === true} />

      <div class="task-card-actions">
        {task.failureReady ? (
          <Btn size="sm" variant="danger" onClick={onFail}>任务失败</Btn>
        ) : task.ready ? (
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
        {!isMain && !task.failureReady && (
          <Btn size="sm" variant="danger" onClick={onAbandon}>放弃</Btn>
        )}
      </div>
    </div>
  );
}

// ── 可接取任务（支线 + 酒馆日常委托）─────────────────────────────────────────
function OfferCard({ q, onAccept, hideHeader = false }: { q: any; onAccept: (q: any) => void; hideHeader?: boolean }) {
  return (
    <div class="task-offer" key={q.code}>
      <div class="task-offer-info">
        {!hideHeader && (
          <div class="task-offer-head">
            <span class="task-offer-name">{q.name}</span>
            {q.scope === 'global' ? <Tag kind="steel">全局</Tag> : q.villageId && <span class="task-offer-village">{villageName(q.villageId)}</span>}
          </div>
        )}
        <span class="task-offer-desc">{q.desc}</span>
        <span class="task-offer-obj">{objText({ objective: q.objective })}</span>
        <OutcomeRows rewards={q.rewards} />
      </div>
      <Btn size="sm" variant="primary" onClick={() => onAccept(q)}>接取</Btn>
    </div>
  );
}

type TaskCategory = 'main' | 'side' | 'daily';

function categoryName(type: TaskCategory): string {
  if (type === 'main') return '主线任务';
  if (type === 'side') return '支线任务';
  return '日常任务';
}

function categoryItems(state: any, type: TaskCategory): { active: any[]; offers: any[] } {
  const active = (state?.active ?? []).filter((task: any) => task.type === type);
  const offers = [
    ...(type === 'main' ? (state?.offeredMain ?? []) : []),
    ...(type === 'daily' ? (state?.offered ?? []) : []),
    // 酒馆任务槽是 mixed offered：其中可能是日常，也可能是 tavern_refresh 支线。
    ...(type === 'side' ? [...(state?.offered ?? []), ...(state?.offeredSide ?? [])] : []),
  ].filter((task: any) => task.type === type);
  return { active, offers: offers.filter((task: any, index: number) => offers.findIndex((item: any) => item.code === task.code) === index) };
}

function TaskEntry({ task, offer, openState = true, onToggle = () => {}, showOfferAlert = true }: { task?: any; offer?: any; openState?: boolean; onToggle?: (event: Event) => void; showOfferAlert?: boolean }) {
  const item = task ?? offer;
  if (!item) return null;
  const isOffer = !task;
  const onAccept = async (q: any) => {
    if (!await ensureTaskExecution(q)) return;
    const started = await req('task.StartAccept', { code: q.code });
    if (!started.ok) {
      await act(Promise.resolve(started), { silent: true });
      return;
    }
    const dialogue = (started.payload as any)?.dialogue;
    if (dialogue) {
      openModal((close) => <DialogueModal dialogue={dialogue} task={q} close={close} />, `dialogue-${dialogue.id}`);
      return;
    }
    await act(req('task.Accept', { code: q.code }), { okToast: '已接取任务' });
  };
  return (
    <details class="task-menu task-menu--task" open={openState} onToggle={onToggle}>
      <summary>
        <span class="task-menu-summary-name">{item.name}</span>
        {typeTag(item.type)}
        {item.scope === 'global'
          ? <Tag kind="steel">全局</Tag>
          : item.villageId && <span class="task-card-village">{villageName(item.villageId)}</span>}
        <span class="task-menu-summary-state">{isOffer ? '可接取' : item.failureReady ? '任务失败' : item.ready ? '待领取' : '进行中'}</span>
        {isOffer && showOfferAlert && <span class="task-menu-alert" aria-label="有可接取任务">!</span>}
      </summary>
      <div class="task-menu-task-body">
        {isOffer
          ? <OfferCard q={item} onAccept={onAccept} hideHeader />
          : <TaskCard task={item} hideHeader />}
      </div>
    </details>
  );
}

function TaskCategoryMenu({ type, state, openState, onToggle, taskOpenState, onTaskToggle }: {
  type: TaskCategory;
  state: any;
  openState: boolean;
  onToggle: (event: Event) => void;
  taskOpenState: TaskMenuOpenState;
  onTaskToggle: (key: string, event: Event) => void;
}) {
  const { active, offers } = categoryItems(state, type);
  const count = active.length + offers.length;
  // 酒馆日常仍正常展示和接取，但不在任务页/导航栏的提醒范围内。
  const offerCount = type === 'daily' ? 0 : offers.length;
  if (count === 0) return null;
  return (
    <details class="task-menu task-menu--category" open={openState} onToggle={onToggle}>
      <summary>
        <span>{categoryName(type)}</span>
        <span class="task-menu-count">{count}</span>
        {!openState && offerCount > 0 && <span class="task-menu-alert" aria-label={`${offerCount} 个可接取任务`}>{offerCount}</span>}
      </summary>
      <div class="task-menu-body">
        {active.map((item) => <TaskEntry key={`active:${item.code}`} task={item} openState={taskOpenState[`task:${item.code}`] ?? true} onToggle={(event) => onTaskToggle(`task:${item.code}`, event)} />)}
        {offers.map((item) => <TaskEntry key={`offer:${item.code}`} offer={item} showOfferAlert={type !== 'daily'} openState={taskOpenState[`task:${item.code}`] ?? true} onToggle={(event) => onTaskToggle(`task:${item.code}`, event)} />)}
      </div>
    </details>
  );
}

function kingdomObjective(task: any): string {
  if (task.kind === 'tribute') return `上贡 ${resInfo(task.resource).name} ×${fmt(task.amount ?? 0)}`;
  if (task.kind === 'clear_pve') return `清理指定的现有 PvE 营地（X ${task.targetQ} · Y ${task.targetR}）`;
  if (task.kind === 'attack_evil') return `攻打负声望玩家 ${task.targetPlayerName ?? task.targetPlayerId}`;
  if (task.kind === 'eliminate_troops') return `消灭 ${task.targetPlayerName ?? task.targetPlayerId} 的兵力 ${(task.eliminatedTroops ?? 0)}/${task.requiredTroops ?? 0}`;
  return '等待封地领主指令';
}

function KingdomTaskMenu({ openState, onToggle, taskOpenState, onTaskToggle }: {
  openState: boolean;
  onToggle: (event: Event) => void;
  taskOpenState: TaskMenuOpenState;
  onTaskToggle: (key: string, event: Event) => void;
}) {
  tick.value;
  const state = kingdomState.value;
  // 王国任务由议会厅解锁；服务器在未解锁时返回 kingdomEnabled=false，
  // 此时连同二级菜单一起隐藏，避免把“等待指令”误显示成可用王国任务。
  if (!state || state.kingdomEnabled === false) return null;
  const task = state.task;
  const goMap = () => {
    if (!task || !Number.isFinite(task.targetQ) || !Number.isFinite(task.targetR)) return;
    setMapCenter({ q: task.targetQ, r: task.targetR });
    selected.value = { refId: task.targetPveId, kind: 'pve', q: task.targetQ, r: task.targetR, name: '王国任务目标' };
    tab.value = 'map';
  };
  const submit = async () => {
    await act(req('SubmitKingdomTribute'), { okToast: '上贡完成，任务可领取' });
  };
  const claim = async () => {
    await act(req('ClaimKingdomTask'), { okToast: `王国任务完成，声望 +${task?.rewardReputation ?? 0}` });
  };
  const status = task?.status === 'ready' ? '待领取'
    : task?.status === 'failed' ? '已过期'
      : task?.status === 'claimed' ? '已领取' : task ? '进行中' : '等待指令';
  return (
    <details class="task-menu task-menu--category" open={openState} onToggle={onToggle}>
      <summary><span>王国任务</span><span class="task-menu-count">{task ? 1 : 0}</span></summary>
      <div class="task-menu-body">
        <details class="task-menu task-menu--task" open={taskOpenState['task:kingdom'] ?? true} onToggle={(event) => onTaskToggle('task:kingdom', event)}>
          <summary>
            <span class="task-menu-summary-name">{state.fiefName}领主的指令</span>
            <Tag kind="gold">王国</Tag>
            <Tag kind="steel">全局</Tag>
            <span class="task-menu-summary-state">{status}</span>
          </summary>
          <div class="task-menu-task-body">
            <div class="task-card task-card--side">
              <div class="task-card-desc">
                {task ? kingdomObjective(task) : `下一项指令将在 ${secLeft(state.nextIssueAt)} 后下达。`}
              </div>
              {task?.status === 'active' && (
                <div class="task-card-prog">
                  <span class="task-prog-chip">剩余 {secLeft(task.expiresAt)}</span>
                  <span class="task-prog-chip">奖励声望 +{task.rewardReputation}</span>
                </div>
              )}
              {task?.status === 'ready' && (
                <div class="task-card-prog">
                  <span class="task-prog-chip">目标已完成 · 期限已冻结</span>
                  <span class="task-prog-chip">奖励声望 +{task.rewardReputation}</span>
                </div>
              )}
              {task?.status === 'failed' && <div class="task-prog-hint">任务已过期，没有惩罚；之后仍会循环出现新任务。</div>}
              {task?.status === 'claimed' && <div class="task-prog-hint">下一项指令将在 {secLeft(state.nextIssueAt)} 后下达。</div>}
              <div class="task-card-actions">
                {task?.status === 'active' && task.kind === 'tribute' && <Btn size="sm" variant="primary" onClick={() => void submit()}>上贡资源</Btn>}
                {(task?.status === 'active' || task?.status === 'ready') && task?.kind === 'clear_pve' && <Btn size="sm" variant="ghost" onClick={goMap}>前往地图</Btn>}
                {task?.status === 'ready' && <Btn size="sm" variant="primary" onClick={() => void claim()}>领取声望奖励</Btn>}
              </div>
            </div>
          </div>
        </details>
      </div>
    </details>
  );
}

function TaskScopeMenu({ scope, state, currentVillageId, openState, onMenuToggle, taskOpenState, onTaskToggle }: {
  scope: 'global' | 'village';
  state: any;
  currentVillageId?: string;
  openState: boolean;
  onMenuToggle: (key: string, event: Event) => void;
  taskOpenState: TaskMenuOpenState;
  onTaskToggle: (key: string, event: Event) => void;
}) {
  const categories: TaskCategory[] = scope === 'global' ? ['main', 'side', 'daily'] : ['side', 'daily'];
  const count = categories.reduce((total, type) => {
    const { active, offers } = categoryItems(state, type);
    return total + active.length + offers.length;
  }, 0) + (scope === 'global' && kingdomState.value?.task ? 1 : 0);
  const offerCount = categories.reduce((total, type) => total + (type === 'daily' ? 0 : categoryItems(state, type).offers.length), 0);
  const label = scope === 'global' ? '全局任务' : '村庄任务';
  const sub = scope === 'global'
    ? '主线、全局支线与全局日常；可从任意村庄执行'
    : `${currentVillageId ? villageName(currentVillageId) : '当前村庄'} · 仅显示本村支线与日常任务`;
  return (
    <details class="task-menu task-menu--scope" open={openState} onToggle={(event) => onMenuToggle(scope, event)}>
      <summary>
        <span class="task-menu-scope-title">{label}</span>
        <span class="task-menu-scope-sub">{sub}</span>
        <span class="task-menu-count">{count}</span>
        {!openState && offerCount > 0 && <span class="task-menu-alert" aria-label={`${offerCount} 个可接取任务`}>{offerCount}</span>}
      </summary>
      <div class="task-menu-body task-menu-scope-body">
        {categories.map((type) => (
          <TaskCategoryMenu
            key={type}
            type={type}
            state={state}
            openState={taskOpenState[`${scope}.${type}`] ?? true}
            onToggle={(event) => onMenuToggle(`${scope}.${type}`, event)}
            taskOpenState={taskOpenState}
            onTaskToggle={onTaskToggle}
          />
        ))}
        {scope === 'global' && (
          <KingdomTaskMenu
            openState={taskOpenState['global.kingdom'] ?? true}
            onToggle={(event) => onMenuToggle('global.kingdom', event)}
            taskOpenState={taskOpenState}
            onTaskToggle={onTaskToggle}
          />
        )}
      </div>
    </details>
  );
}

/** 兼容旧入口：按单个村庄快照渲染任务分类。 */
export function TaskOffers({ offered, offeredSide }: { offered: any[]; offeredSide?: any[] }) {
  const side = offeredSide ?? [];
  const mixedSide = (offered ?? []).filter((q) => q.type === 'side');
  const mixedDaily = (offered ?? []).filter((q) => q.type !== 'side');
  const sideOffers = [...side, ...mixedSide].filter((q, index, all) => all.findIndex((item) => item.code === q.code) === index);
  if (!mixedDaily.length && !mixedSide.length && !side.length) return null;
  return (
    <div class="task-offers">
      {sideOffers.map((q) => <TaskEntry key={`${q.villageId ?? ''}:${q.code}`} offer={q} showOfferAlert />)}
      {mixedDaily.map((q) => <TaskEntry key={`${q.villageId ?? ''}:${q.code}`} offer={q} showOfferAlert={false} />)}
    </div>
  );
}

// ── 任务页主体 ────────────────────────────────────────────────────────────────
function legacyScopeState(state: any, scope: 'global' | 'village', villageId?: string): any {
  const matches = (task: any) => (task.scope ?? (task.type === 'main' ? 'global' : 'village')) === scope
    && (!villageId || scope === 'global' || task.villageId === villageId);
  return {
    active: (state?.active ?? []).filter(matches),
    offeredMain: (state?.offeredMain ?? []).filter(matches),
    offered: (state?.offered ?? []).filter(matches),
    offeredSide: (state?.offeredSide ?? []).filter(matches),
  };
}

function TaskBoard({ state }: { state: any }) {
  const currentVillageId = me?.villageId;
  const globalState = state?.global ?? legacyScopeState(state, 'global');
  const villageState = state?.villages?.find((v: any) => v.villageId === currentVillageId)
    ?? state?.village
    ?? legacyScopeState(state, 'village', currentVillageId);
  const playerId = String(state?.playerId ?? me?.id ?? 'guest');
  const [prefsPlayerId, setPrefsPlayerId] = useState(playerId);
  const [openState, setOpenState] = useState<TaskMenuOpenState>(() => readTaskMenuOpenState(playerId));
  useEffect(() => {
    if (prefsPlayerId === playerId) return;
    setPrefsPlayerId(playerId);
    setOpenState(readTaskMenuOpenState(playerId));
  }, [playerId, prefsPlayerId]);
  const setMenuOpen = (key: string, event: Event) => {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    setOpenState((prev) => {
      const next = { ...prev, [key]: open };
      writeTaskMenuOpenState(playerId, next);
      return next;
    });
  };
  return (
    <section class="task-bar">
      <TaskScopeMenu
        scope="global"
        state={globalState}
        currentVillageId={currentVillageId}
        openState={openState.global ?? true}
        onMenuToggle={setMenuOpen}
        taskOpenState={openState}
        onTaskToggle={setMenuOpen}
      />
      <TaskScopeMenu
        scope="village"
        state={villageState}
        currentVillageId={currentVillageId}
        openState={openState.village ?? true}
        onMenuToggle={setMenuOpen}
        taskOpenState={openState}
        onTaskToggle={setMenuOpen}
      />
    </section>
  );
}

/** 玩家绑定的独立任务页。 */
export function TasksScreen() {
  dataVersion.value;
  playerTaskState.value;
  return (
    <>
      <VillageList />
      <TaskBoard state={playerTaskState.value} />
    </>
  );
}

/** 兼容旧嵌入点：村庄页不再渲染，但保留按当前村读取的组件供旧入口使用。 */
export function TaskBar() {
  dataVersion.value; // 资源/任务数据刷新时重渲
  taskStates.value;  // 任务推送时重渲
  const ts = taskStates.value[vid()] ?? null;
  return <TaskBoard state={ts} />;
}
