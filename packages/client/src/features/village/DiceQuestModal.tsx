import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { req } from '../../api.js';
import { showToast } from '../../app/store.js';
import { reloadPlayerTasks } from '../../app/refresh.js';
import { Btn, confirmDanger } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import {
  projectDiceQuestReplay,
  type DiceQuestDie as Die,
  type DiceQuestEvent as DiceEvent,
  type DiceQuestMatchScore,
  type DiceQuestReplayBase,
} from './dice-quest-replay.js';

type Snapshot = {
  sessionId: string;
  taskCode: string;
  state: { phase: 'player' | 'finished'; targetScore: number; playerScore: number; aiScore: number; turnScore: number; turnBreakdown: { label: string; score: number }[]; dice: Die[]; events: DiceEvent[]; winner?: 'player' | 'ai'; result?: { kind: string; label: string; message: string } };
  selectableOptions: Array<{ dieIds: string[]; score: number; label: string }>;
  events: DiceEvent[];
  match: { playerWins: number; npcWins: number; winsRequired: number };
  round?: { outcome?: 'player' | 'npc'; ready?: boolean; failureReady?: boolean } | null;
};
type PlaybackState = {
  base: DiceQuestReplayBase;
  events: DiceEvent[];
  index: number;
  bustAlertVisible: boolean;
  finalMatch: DiceQuestMatchScore;
};

// 每一帧展示完才安排下一帧，浏览器短暂卡顿后不会把多个绝对定时器挤在一起执行。
const DICE_EVENT_HOLD_MS = 780;
const BUST_REVEAL_HOLD_MS = 800;
const BUST_ALERT_HOLD_MS = 850;

function dieFace(value: number): JSX.Element {
  const positions: Record<number, number[]> = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  return <span class="dice-quest-die-art" aria-hidden="true">
    {(positions[value] ?? []).map((position) => <i key={position} class={`dice-quest-pip dice-quest-pip-${position}`} />)}
  </span>;
}

export function DiceQuestModal({ task, close }: { task: any; close: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [busy, setBusy] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [pendingAction, setPendingAction] = useState<'roll' | 'bank' | 'forfeit' | null>(null);
  const timers = useRef<number[]>([]);
  const closed = useRef(false);
  const sessionClosed = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const actionPending = useRef(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const taskName = task?.name ?? task?.code ?? '骰子对局';

  const clearTimers = () => { for (const id of timers.current) window.clearTimeout(id); timers.current = []; };
  useEffect(() => () => { closed.current = true; clearTimers(); }, []);

  const playEvents = (base: DiceQuestReplayBase, events: DiceEvent[], finalMatch: DiceQuestMatchScore) => {
    clearTimers();
    if (!events.length) {
      setPlayback(null); setSelected([]);
      return;
    }

    const finish = () => {
      if (closed.current) return;
      setPlayback(null); setSelected([]);
    };
    const show = (index: number) => {
      if (closed.current) return;
      const event = events[index];
      setPlayback({ base, events, index, bustAlertVisible: false, finalMatch });
      const advance = () => index + 1 < events.length ? show(index + 1) : finish();
      if (event.kind === 'bust') {
        const reveal = window.setTimeout(() => {
          if (closed.current) return;
          setPlayback({ base, events, index, bustAlertVisible: true, finalMatch });
          const alert = window.setTimeout(advance, BUST_ALERT_HOLD_MS);
          timers.current = [alert];
        }, BUST_REVEAL_HOLD_MS);
        timers.current = [reveal];
        return;
      }
      const next = window.setTimeout(advance, DICE_EVENT_HOLD_MS);
      timers.current = [next];
    };
    // 首帧与响应快照在同一批更新中提交，不闪现服务端最终牌面。
    show(0);
  };

  useEffect(() => {
    let alive = true;
    void req('dice.StartMatch', { taskCode: task.code }).then((result) => {
      if (!alive) return;
      if (!result.ok) { showToast('无法开始骰子对局', 'bad'); closeRef.current(); return; }
      const started = result.payload as Snapshot;
      sessionIdRef.current = started.sessionId;
      sessionClosed.current = false;
      setSnapshot(started);
      setPlayback(null);
      setShowHistory(false);
      setBusy(false);
    }).catch(() => { if (alive) { showToast('骰子对局连接失败', 'bad'); closeRef.current(); } });
    return () => { alive = false; };
    // close 由弹层宿主创建，叠加确认框时引用会变化；牌桌只能按任务 code 初始化一次。
  }, [task.code]);

  const state = snapshot?.state;
  const shownEvent = playback?.events[playback.index] ?? null;
  const isBustEvent = shownEvent?.kind === 'bust';
  const isBust = isBustEvent && Boolean(playback?.bustAlertVisible);
  const playbackEvents = playback ? playback.events.slice(0, playback.index + 1) : [];
  const playbackView = playback
    ? projectDiceQuestReplay(playback.base, playbackEvents, isBust, playback.finalMatch)
    : null;
  const boardDice = playbackView?.dice ?? state?.dice ?? [];
  const activeSide = playbackView?.activeSide ?? 'player';
  const turnBreakdown = playbackView?.turnBreakdown ?? state?.turnBreakdown ?? [];
  const turnScore = playbackView?.turnScore ?? state?.turnScore ?? 0;
  const selectedOption = useMemo(() => snapshot?.selectableOptions.find((option) => option.dieIds.length === selected.length && option.dieIds.every((id) => selected.includes(id))), [snapshot, selected]);
  const replaying = playback !== null;
  const displayedPlayerScore = playbackView?.playerScore ?? state?.playerScore ?? 0;
  const displayedNpcScore = playbackView?.aiScore ?? state?.aiScore ?? 0;
  const displayedMatch = playbackView?.match ?? snapshot?.match ?? { playerWins: 0, npcWins: 0, winsRequired: 1 };

  const act = async (type: 'roll' | 'bank' | 'forfeit'): Promise<boolean> => {
    if (!snapshot || busy || replaying || actionPending.current) return false;
    if ((type === 'roll' || type === 'bank') && state?.dice.length && !selectedOption) {
      showToast('请选择完整的计分组合', 'bad');
      return false;
    }
    const actionSelection = [...selected];
    const before = snapshot;
    actionPending.current = true;
    setBusy(true);
    setPendingAction(type);
    try {
      const sendAction = (sessionId: string) => req('dice.Action', {
        sessionId,
        type,
        ...(actionSelection.length ? { selectedDieIds: actionSelection } : {}),
      });
      let result = await sendAction(sessionIdRef.current ?? before.sessionId);
      if (!result.ok && result.error?.code === 'dice_session_not_found') {
        // 服务重启或旧页面会丢失内存牌桌。普通操作自动重开并让玩家重新掷骰；
        // 已确认的“放弃”则在新牌桌上重试，保证 NPC 局分一定写入任务进度。
        const restarted = await req('dice.StartMatch', { taskCode: task.code });
        if (!restarted.ok) {
          showToast('牌桌重新准备失败，请稍后再试', 'bad');
          return false;
        }
        const fresh = restarted.payload as Snapshot;
        sessionIdRef.current = fresh.sessionId;
        sessionClosed.current = false;
        if (type === 'forfeit') {
          result = await sendAction(fresh.sessionId);
        } else {
          clearTimers();
          setSnapshot(fresh);
          setPlayback(null);
          setSelected([]);
          showToast('牌桌已重新准备，本局从头开始', 'info');
          return false;
        }
      }
      if (!result.ok) {
        showToast(result.error?.code ?? '骰子动作失败', 'bad');
        return false;
      }
      const next = result.payload as Snapshot;
      sessionIdRef.current = next.sessionId;
      if (type === 'forfeit') {
        // 放弃是明确的退出动作：服务端已经记录 NPC 获胜，本地不再回放
        // 这次动作附带的 NPC 回合或结算事件，避免关闭前牌桌继续变化。
        clearTimers();
        setSnapshot(next);
        setPlayback(null);
        setSelected([]);
        return true;
      }
      const base: DiceQuestReplayBase = {
        playerScore: before.state.playerScore,
        aiScore: before.state.aiScore,
        turnScore: before.state.turnScore,
        turnBreakdown: before.state.turnBreakdown.map((item) => ({ ...item })),
        dice: before.state.dice.map((die) => ({ ...die })),
        match: { ...before.match },
      };
      playEvents(base, next.events ?? [], next.match);
      setSnapshot(next);
      return true;
    } catch {
      showToast('骰子对局连接失败', 'bad');
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
      setPendingAction(null);
    }
  };

  const exit = async () => {
    if (sessionClosed.current) { closeRef.current(); return; }
    sessionClosed.current = true;
    const sessionId = sessionIdRef.current;
    if (sessionId) await req('dice.ExitMatch', { sessionId }).catch(() => {});
    closeRef.current();
  };
  const quit = async () => {
    if (!snapshot || busy || replaying) return;
    const ok = await confirmDanger({ title: '放弃本局对局', body: '放弃本局会判定 NPC 赢得这一局，确定退出吗？', confirmText: '确认放弃' });
    if (!ok) return;
    const forfeited = await act('forfeit');
    if (!forfeited) return;
    // 放弃会写入 s6/s7 的胜场进度；先只刷新任务栏，再幂等关闭临时牌桌。
    await reloadPlayerTasks();
    await exit();
  };
  const toggleDie = (id: string) => {
    if (busy || replaying || !state || state.phase !== 'player' || !state.dice.length) return;
    setSelected((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  if (!snapshot || !state) return <Modal title={taskName} onClose={close}><div class="dice-quest-loading">正在准备牌桌…</div></Modal>;
  const finished = state.phase === 'finished' && !replaying;
  const playerWon = snapshot.round?.outcome === 'player' || state.winner === 'player';
  const visibleWinner = replaying ? undefined : state.winner;
  const breakdownTotal = turnBreakdown.reduce((sum, item) => sum + item.score, 0);
  const playerEventOption = shownEvent?.side === 'player' && (shownEvent.kind === 'keep' || shownEvent.kind === 'bank') ? shownEvent.option : undefined;
  const currentSelection = activeSide === 'ai' && shownEvent
    ? shownEvent.kind === 'bank'
      ? `收下 ${(shownEvent.points ?? 0).toLocaleString()} 分`
      : shownEvent.option
      ? `+${shownEvent.option.score.toLocaleString()}`
      : shownEvent.kind === 'bust' ? (isBust ? '爆骰' : '—') : '—'
    : shownEvent?.side === 'player' && shownEvent.kind === 'bank'
      ? `收下 ${(shownEvent.points ?? 0).toLocaleString()} 分`
      : playerEventOption
      ? `+${playerEventOption.score.toLocaleString()}`
      : selectedOption ? `+${selectedOption.score.toLocaleString()}` : '请选择完整计分组合';
  const currentSelectionDetail = activeSide === 'ai' && shownEvent
    ? shownEvent.option ? `骰子：${shownEvent.option.label}` : (isBust ? shownEvent.message : undefined)
    : playerEventOption ? `骰子：${playerEventOption.label}` : selectedOption ? `骰子：${selectedOption.label}` : undefined;
  const pendingLabel = pendingAction === 'roll'
    ? '正在掷骰…'
    : pendingAction === 'bank'
      ? '正在收下本轮分数…'
      : pendingAction === 'forfeit'
        ? '正在结算放弃结果…'
        : null;
  return (
    <Modal title={`骰子王 · ${taskName}`} sub={task.code === 's7' ? '三局两胜 · 简单 NPC · 目标 2000 分' : '单局 · 简单 NPC · 目标 2000 分'} onClose={finished ? exit : quit} wide>
      <div class="dice-quest-shell">
        <div class="dice-quest-scoreboard">
          <div class={visibleWinner === 'player' ? 'dice-quest-scoreboard__winner' : ''}><span>你</span><strong>{displayedPlayerScore}</strong>{visibleWinner === 'player' && <em class="dice-quest-win-mark">本局胜者</em>}<small>本场 {displayedMatch.playerWins}/{displayedMatch.winsRequired} 局</small></div>
          <div class="dice-quest-target"><span>目标</span><strong>{state.targetScore}</strong><small>先达目标得分</small></div>
          <div class={`dice-quest-scoreboard__npc${visibleWinner === 'ai' ? ' dice-quest-scoreboard__winner' : ''}`}><span>普通 NPC</span><strong>{displayedNpcScore}</strong>{visibleWinner === 'ai' && <em class="dice-quest-win-mark">本局胜者</em>}<small>本场 {displayedMatch.npcWins}/{displayedMatch.winsRequired} 局</small></div>
        </div>
        <div class={`dice-quest-table dice-quest-table--${activeSide}${isBust ? ' dice-quest-table--bust' : ''}`}>
          <div class="dice-quest-round-label">{finished ? '本局结算' : activeSide === 'ai' ? 'NPC掷骰阶段' : '你的掷骰阶段'}</div>
          <div class="dice-quest-turn-score">本轮累计 <b>{turnScore}</b></div>
          <div class="dice-quest-breakdown">
            <div class="dice-quest-breakdown-heading"><span>前面阶段已保留</span><strong>{breakdownTotal.toLocaleString()} 分</strong></div>
            {turnBreakdown.length ? <ul>{turnBreakdown.map((item, index) => <li key={`${item.label}-${index}`}><span>骰子 {item.label}</span><b>+{item.score.toLocaleString()}</b></li>)}</ul> : <small>还没有前面阶段的拿分记录</small>}
          </div>
          <div class="dice-quest-dice" aria-label="骰子">
            {boardDice.map((die) => {
              const active = selected.includes(die.id);
              const replayKept = playbackView?.selectedDieIds.includes(die.id) ?? false;
              return <button type="button" key={die.id} class={`dice-quest-die${active || replayKept ? ' is-selected' : ''}`} onClick={() => toggleDie(die.id)} disabled={activeSide !== 'player' || busy || replaying || finished}>{dieFace(die.value)}<span>{active || (replayKept && activeSide === 'player') ? '已选' : replayKept ? '保留' : ''}</span></button>;
            })}
          </div>
          <div class={`dice-quest-selection-readout${activeSide === 'ai' ? ' is-ai' : ''}`}>
            <span>{activeSide === 'ai' ? 'NPC本次操作' : '本次选择'}</span>
            <strong>{pendingLabel ?? currentSelection}</strong>
            {!pendingLabel && currentSelectionDetail && <small>{currentSelectionDetail}</small>}
          </div>
          {isBust && <div class="dice-quest-bust-text">爆骰！本轮分数全部丢失</div>}
          {finished && <div class={`dice-quest-result ${playerWon ? 'is-win' : 'is-loss'}`}>
            <strong>{playerWon ? '本局胜利' : '本局失败'}</strong>
            <span>牌型：{state.result?.kind ?? '—'} {state.result?.label ? `（${state.result.label}）` : ''}</span>
            <span>{state.result?.message ?? ''}</span>
          </div>}
        </div>
        <div class="dice-quest-history-actions">
          <Btn variant="ghost" size="sm" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>{showHistory ? '隐藏历史操作' : '查看历史操作'}</Btn>
        </div>
        {showHistory && <DiceQuestHistory events={state.events ?? []} />}
        {!finished ? (
          <div class="dice-quest-actions">
            {!state.dice.length ? <Btn variant="primary" disabled={busy || replaying} onClick={() => void act('roll')}>掷出六枚骰子</Btn> : <>
              <Btn variant="ghost" disabled={busy || replaying || !selectedOption} onClick={() => void act('roll')}>继续掷骰</Btn>
              <Btn variant="primary" disabled={busy || replaying || !selectedOption} onClick={() => void act('bank')}>收下本轮分数</Btn>
            </>}
            <Btn variant="danger" disabled={busy || replaying} onClick={() => void quit()}>放弃对局</Btn>
          </div>
        ) : <div class="dice-quest-actions"><Btn variant="primary" onClick={() => void exit()}>退出对局</Btn></div>}
        <div class="dice-quest-rules-foot">1点=100 · 5点=50（可与顺子、同点数组合叠加） · 1-5顺=500 · 2-6顺=750 · 1-6顺=1500 · 三个相同点数起计分 · 爆骰丢失本轮未收下分数 · 六骰全计分触发热骰</div>
      </div>
    </Modal>
  );
}

function DiceQuestHistory({ events }: { events: DiceEvent[] }) {
  return <section class="dice-quest-history" aria-label="历史操作">
    <div class="dice-quest-history-heading"><strong>事件记录</strong><span>最近 {Math.min(events.length, 40)} 条</span></div>
    {events.length ? <ol>{events.slice(-40).reverse().map((event, index) => <li key={`${event.kind}-${index}`} class={event.side === 'ai' ? 'is-ai' : 'is-player'}><b>{event.side === 'ai' ? 'NPC' : '你'}</b><span>{event.message}</span></li>)}</ol> : <small>还没有历史操作</small>}
  </section>;
}
