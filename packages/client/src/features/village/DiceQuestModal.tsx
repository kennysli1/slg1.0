import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { me, req } from '../../api.js';
import { showToast } from '../../app/store.js';
import { Btn, Tag, confirmDanger } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';

type Die = { id: string; value: number };
type DiceEvent = {
  kind: string;
  side: 'player' | 'ai';
  dice?: Die[];
  option?: { dieIds: string[]; score: number; label: string };
  points?: number;
  message: string;
};
type Snapshot = {
  sessionId: string;
  taskCode: string;
  state: { phase: 'player' | 'finished'; targetScore: number; playerScore: number; aiScore: number; turnScore: number; turnBreakdown: { label: string; score: number }[]; dice: Die[]; winner?: 'player' | 'ai'; result?: { kind: string; label: string; message: string } };
  selectableOptions: Array<{ dieIds: string[]; score: number; label: string }>;
  events: DiceEvent[];
  match: { playerWins: number; npcWins: number; winsRequired: number };
  round?: { outcome?: 'player' | 'npc'; ready?: boolean; failureReady?: boolean } | null;
};

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
  const [shownEvent, setShownEvent] = useState<DiceEvent | null>(null);
  const [shownEventIndex, setShownEventIndex] = useState(-1);
  const [busy, setBusy] = useState(true);
  const timers = useRef<number[]>([]);
  const closed = useRef(false);
  const taskName = task?.name ?? task?.code ?? '骰子对局';

  const clearTimers = () => { for (const id of timers.current) window.clearTimeout(id); timers.current = []; };
  useEffect(() => () => { closed.current = true; clearTimers(); }, []);

  const playEvents = (events: DiceEvent[]) => {
    clearTimers();
    if (!events.length) { setShownEvent(null); setShownEventIndex(-1); return; }
    events.forEach((event, index) => {
      const timer = window.setTimeout(() => {
        if (!closed.current) { setShownEvent(event); setShownEventIndex(index); }
        if (index === events.length - 1) {
          const clear = window.setTimeout(() => {
            if (!closed.current) { setShownEvent(null); setShownEventIndex(-1); }
          }, 750);
          timers.current.push(clear);
        }
      }, index * 1050);
      timers.current.push(timer);
    });
  };

  useEffect(() => {
    let alive = true;
    void req('dice.StartMatch', { taskCode: task.code }).then((result) => {
      if (!alive) return;
      if (!result.ok) { showToast('无法开始骰子对局', 'bad'); close(); return; }
      setSnapshot(result.payload as Snapshot);
      setBusy(false);
    }).catch(() => { if (alive) { showToast('骰子对局连接失败', 'bad'); close(); } });
    return () => { alive = false; };
  }, [task.code, close]);

  const state = snapshot?.state;
  const boardDice = shownEvent?.dice ?? state?.dice ?? [];
  const isBust = shownEvent?.kind === 'bust';
  const activeSide = shownEvent?.side ?? 'player';
  const playbackEvents = shownEventIndex >= 0 ? snapshot?.events.slice(0, shownEventIndex + 1) ?? [] : [];
  const aiBoundary = (() => {
    // bank/bust 本身是本阶段的结算事件，查找边界时要保留它之前的 keep；
    // roll 则标记新阶段开始，因此当前 roll 可以作为边界。
    const current = playbackEvents.at(-1);
    const end = current && (current.kind === 'bank' || current.kind === 'bust')
      ? playbackEvents.length - 2
      : playbackEvents.length - 1;
    for (let index = end; index >= 0; index--) {
      const event = playbackEvents[index];
      if (event.side === 'ai' && (event.kind === 'bank' || event.kind === 'bust' || event.kind === 'roll')) return index;
    }
    return -1;
  })();
  const aiStageEvents = playbackEvents
    .slice(aiBoundary + 1)
    .filter((event) => event.side === 'ai' && event.kind === 'keep' && event.option);
  const aiStageScore = aiStageEvents.reduce((sum, event) => sum + Number(event.option?.score ?? event.points ?? 0), 0);
  const turnBreakdown = activeSide === 'ai' && shownEvent
    ? aiStageEvents.map((event) => ({ label: event.option!.label, score: event.option!.score }))
    : state?.turnBreakdown ?? [];
  const turnScore = activeSide === 'ai' && shownEvent ? aiStageScore : state?.turnScore ?? 0;
  const selectedOption = useMemo(() => snapshot?.selectableOptions.find((option) => option.dieIds.length === selected.length && option.dieIds.every((id) => selected.includes(id))), [snapshot, selected]);

  const act = async (type: 'roll' | 'bank' | 'forfeit') => {
    if (!snapshot || busy) return;
    if ((type === 'roll' || type === 'bank') && state?.dice.length && !selectedOption) {
      showToast('请选择完整的计分组合', 'bad');
      return;
    }
    setBusy(true); setSelected([]);
    try {
      const result = await req('dice.Action', { sessionId: snapshot.sessionId, type, ...(selected.length ? { selectedDieIds: selected } : {}) });
      if (!result.ok) { showToast(result.error?.code ?? '骰子动作失败', 'bad'); setBusy(false); return; }
      const next = result.payload as Snapshot;
      setSnapshot(next); playEvents(next.events ?? []); setBusy(false);
    } catch { showToast('骰子对局连接失败', 'bad'); setBusy(false); }
  };

  const exit = async () => {
    if (!snapshot) { close(); return; }
    await req('dice.ExitMatch', { sessionId: snapshot.sessionId }).catch(() => {});
    close();
  };
  const quit = async () => {
    if (!snapshot || busy) return;
    const ok = await confirmDanger({ title: '放弃本局对局', body: '放弃本局会判定 NPC 赢得这一局，确定退出吗？', confirmText: '确认放弃' });
    if (!ok) return;
    await act('forfeit');
    await req('dice.ExitMatch', { sessionId: snapshot.sessionId }).catch(() => {});
    close();
  };
  const toggleDie = (id: string) => {
    if (busy || !state || state.phase !== 'player' || !state.dice.length) return;
    setSelected((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  if (!snapshot || !state) return <Modal title={taskName} onClose={close}><div class="dice-quest-loading">正在准备牌桌…</div></Modal>;
  const finished = state.phase === 'finished';
  const playerWon = snapshot.round?.outcome === 'player' || state.winner === 'player';
  return (
    <Modal title={`骰子王 · ${taskName}`} sub={task.code === 's7' ? '三局两胜 · 简单 NPC · 目标 2000 分' : '单局 · 简单 NPC · 目标 2000 分'} onClose={finished ? exit : quit} wide>
      <div class="dice-quest-shell">
        <div class="dice-quest-scoreboard">
          <div class={state.winner === 'player' ? 'dice-quest-scoreboard__winner' : ''}><span>你</span><strong>{state.playerScore}</strong>{state.winner === 'player' && <em class="dice-quest-win-mark">本局胜者</em>}<small>本场 {snapshot.match.playerWins}/{snapshot.match.winsRequired} 局</small></div>
          <div class="dice-quest-target"><span>目标</span><strong>{state.targetScore}</strong><small>先达目标得分</small></div>
          <div class={`dice-quest-scoreboard__npc${state.winner === 'ai' ? ' dice-quest-scoreboard__winner' : ''}`}><span>普通 NPC</span><strong>{state.aiScore}</strong>{state.winner === 'ai' && <em class="dice-quest-win-mark">本局胜者</em>}<small>本场 {snapshot.match.npcWins}/{snapshot.match.winsRequired} 局</small></div>
        </div>
        <div class={`dice-quest-table dice-quest-table--${activeSide}${isBust ? ' dice-quest-table--bust' : ''}`}>
          <div class="dice-quest-round-label">{finished ? '本局结算' : activeSide === 'ai' ? 'NPC掷骰阶段' : '你的掷骰阶段'}</div>
          <div class="dice-quest-turn-score">本轮累计 <b>{turnScore}</b></div>
          <div class="dice-quest-reserved">前面阶段已保留：{turnBreakdown.length ? turnBreakdown.map((item) => `${item.label}（${item.score}）`).join('、') : '暂无'}</div>
          <div class="dice-quest-dice" aria-label="骰子">
            {boardDice.map((die) => {
              const active = selected.includes(die.id);
              const npcKept = activeSide === 'ai' && shownEvent?.kind === 'keep' && shownEvent.option?.dieIds.includes(die.id);
              return <button type="button" key={die.id} class={`dice-quest-die${active || npcKept ? ' is-selected' : ''}`} onClick={() => toggleDie(die.id)} disabled={activeSide !== 'player' || busy || finished}>{dieFace(die.value)}<span>{active ? '已选' : npcKept ? '保留' : ''}</span></button>;
            })}
          </div>
          {isBust && <div class="dice-quest-bust-text">爆骰！本轮分数全部丢失</div>}
          {finished && <div class={`dice-quest-result ${playerWon ? 'is-win' : 'is-loss'}`}>
            <strong>{playerWon ? '本局胜利' : '本局失败'}</strong>
            <span>牌型：{state.result?.kind ?? '—'} {state.result?.label ? `（${state.result.label}）` : ''}</span>
            <span>{state.result?.message ?? ''}</span>
          </div>}
        </div>
        {!finished ? (
          <div class="dice-quest-actions">
            {!state.dice.length ? <Btn variant="primary" disabled={busy} onClick={() => void act('roll')}>掷出六枚骰子</Btn> : <>
              <Btn variant="ghost" disabled={busy || !selectedOption} onClick={() => void act('roll')}>继续掷骰</Btn>
              <Btn variant="primary" disabled={busy || !selectedOption} onClick={() => void act('bank')}>收下本轮分数</Btn>
            </>}
            <Btn variant="danger" disabled={busy} onClick={() => void quit()}>放弃对局</Btn>
          </div>
        ) : <div class="dice-quest-actions"><Btn variant="primary" onClick={() => void exit()}>退出对局</Btn></div>}
      </div>
    </Modal>
  );
}
