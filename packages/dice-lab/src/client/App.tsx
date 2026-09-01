import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Difficulty } from '../domain/ai.js';
import type { Die, ScoreOption } from '../domain/rules.js';
import { scoreOption } from '../domain/rules.js';
import type { GameEvent, RoundResult } from '../domain/engine.js';
import type { ClientSessionView } from './types.js';
import { applyAction, createSession, DiceLabApiError } from './api.js';

const DIFFICULTIES: Array<{ value: Difficulty; label: string; description: string }> = [
  { value: 'easy', label: '简单 NPC', description: '偏保守，偶尔会冒险' },
  { value: 'normal', label: '普通 NPC', description: '会结合风险与比分' },
  { value: 'hard', label: '困难 NPC', description: '使用期望收益判断收手' },
];

// 爆骰牌面在上一版基础上再停留 0.5 秒，确保结果与红色提示都能看清。
const BUST_TABLE_DISPLAY_MS = 3_700;
const BUST_REVEAL_DELAY_MS = 900;
const AI_ACTION_PAUSE_MS = 1_350;
const AI_BUST_ACTION_PAUSE_MS = AI_ACTION_PAUSE_MS + 500;

type AiPlayback = {
  events: GameEvent[];
  index: number;
};

type AiTurnProgress = {
  score: number;
  turnScore: number;
  entries: Array<{ label: string; score: number }>;
};

function getAiTurnProgress(events: GameEvent[], index: number, finalScore: number): AiTurnProgress {
  const visibleEvents = events.slice(0, index + 1);
  const entries = visibleEvents
    .filter((event) => event.side === 'ai' && event.kind === 'keep' && event.option)
    .map((event) => ({ label: event.option!.label, score: event.option!.score }));
  const turnScore = entries.reduce((sum, entry) => sum + entry.score, 0);
  const bankEvent = events.find((event) => event.side === 'ai' && event.kind === 'bank');
  const bankShown = Boolean(bankEvent && visibleEvents.includes(bankEvent));
  const committedPoints = bankEvent?.points ?? 0;

  return {
    score: Math.max(0, finalScore - (bankShown ? 0 : committedPoints)),
    turnScore: bankShown ? 0 : turnScore,
    entries,
  };
}

export function DiceLabApp() {
  const [token, setToken] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [targetScore, setTargetScore] = useState(4000);
  const [session, setSession] = useState<ClientSessionView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bustDisplay, setBustDisplay] = useState<GameEvent | null>(null);
  const [bustPhase, setBustPhase] = useState<'reveal' | 'alert'>('reveal');
  const [bustBreakdown, setBustBreakdown] = useState<Array<{ label: string; score: number }> | null>(null);
  const [pendingAiEvents, setPendingAiEvents] = useState<GameEvent[] | null>(null);
  const [aiPlayback, setAiPlayback] = useState<AiPlayback | null>(null);
  const [notice, setNotice] = useState('输入访问码后开始一局实验对局。刷新页面会开启新对局。');

  const state = session?.state;
  const selection = useMemo<ScoreOption | null>(() => (
    state ? scoreOption(state.dice, [...selected]) : null
  ), [state, selected]);

  useEffect(() => {
    if (!bustDisplay) return;
    const timer = window.setTimeout(() => setBustPhase('alert'), BUST_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [bustDisplay]);

  useEffect(() => {
    if (!bustDisplay) return;
    const timer = window.setTimeout(() => {
      setBustDisplay(null);
      if (pendingAiEvents?.length) setAiPlayback({ events: pendingAiEvents, index: 0 });
      setPendingAiEvents(null);
    }, BUST_TABLE_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [bustDisplay, pendingAiEvents]);

  useEffect(() => {
    if (!aiPlayback) return;
    if (aiPlayback.index >= aiPlayback.events.length) {
      setAiPlayback(null);
      return;
    }
    const event = aiPlayback.events[aiPlayback.index];
    const timer = window.setTimeout(() => {
      setAiPlayback((current) => current ? { ...current, index: current.index + 1 } : current);
    }, event.kind === 'bust' ? AI_BUST_ACTION_PAUSE_MS : AI_ACTION_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [aiPlayback]);

  async function start() {
    setBusy(true); setNotice('正在创建实验对局…'); setSelected(new Set());
    setBustDisplay(null);
    setBustPhase('reveal');
    setBustBreakdown(null);
    setPendingAiEvents(null);
    setAiPlayback(null);
    try {
      setSession(await createSession(token, difficulty, targetScore));
      setNotice('你先手。点击“掷骰”开始。');
    } catch (error) { setNotice(errorMessage(error)); setSession(null); }
    finally { setBusy(false); }
  }

  async function act(action: Parameters<typeof applyAction>[3]) {
    if (!session || busy || bustDisplay || aiPlayback) return;
    setBusy(true); setNotice('服务器正在结算…');
    const playerSelection = action.type === 'roll' && action.selectedDieIds?.length
      ? scoreOption(session.state.dice, action.selectedDieIds)
      : null;
    try {
      const nextSession = await applyAction(token, session.id, session.revision, action);
      setSession(nextSession);
      setSelected(new Set());
      if (nextSession.playerBust) {
        setBustPhase('reveal');
        setBustBreakdown([
          ...session.state.turnBreakdown,
          ...(playerSelection ? [{ label: playerSelection.label, score: playerSelection.score }] : []),
        ]);
        setBustDisplay(nextSession.playerBust);
        setPendingAiEvents(nextSession.aiEvents);
        setAiPlayback(null);
        setNotice('爆骰结果展示中…');
      } else {
        setBustDisplay(null);
        setPendingAiEvents(null);
        setBustBreakdown(null);
        setAiPlayback(nextSession.aiEvents.length ? { events: nextSession.aiEvents, index: 0 } : null);
        setNotice('');
      }
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof DiceLabApiError && (error.code === 'not_found' || error.code === 'stale_revision')) setSession(null);
    } finally { setBusy(false); }
  }

  function toggleDie(die: Die) {
    if (!state || state.phase !== 'player' || busy || bustDisplay || aiPlayback || state.dice.length === 0) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(die.id)) next.delete(die.id); else next.add(die.id);
      return next;
    });
  }

  const currentDifficulty = DIFFICULTIES.find((item) => item.value === difficulty)!;
  const aiFrame = aiPlayback && aiPlayback.index < aiPlayback.events.length ? aiPlayback.events[aiPlayback.index] : null;
  const aiProgress = aiPlayback ? getAiTurnProgress(aiPlayback.events, aiPlayback.index, state?.aiScore ?? 0) : null;
  return (
    <main class="dice-lab">
      <header class="lab-header">
        <div>
          <p class="eyebrow">KOW · 独立实验场</p>
          <h1>筛色子</h1>
          <p class="subtitle">普通六面骰 · 服务器权威结算 · 不写入游戏存档</p>
        </div>
        <div class="lab-header-actions">
          <a href="/" class="back-link">返回主游戏</a>
          <button class="ghost-button" type="button" onClick={() => void start()} disabled={busy}>重新开始</button>
        </div>
      </header>

      {!session && (
        <section class="setup-card panel-card">
          <h2>开始一局测试</h2>
          <p class="muted">实验对局仅保存在服务器内存中，页面刷新、断线或服务重启都会结束当前对局。</p>
          <div class="setup-grid">
            <label>访问码<input value={token} onInput={(event) => setToken((event.currentTarget as HTMLInputElement).value)} type="password" placeholder="本地可留空" /></label>
            <label>NPC难度<select value={difficulty} onChange={(event) => setDifficulty((event.currentTarget as HTMLSelectElement).value as Difficulty)}>{DIFFICULTIES.map((item) => <option value={item.value}>{item.label}</option>)}</select><small>{currentDifficulty.description}</small></label>
            <label>目标分数<select value={targetScore} onChange={(event) => setTargetScore(Number((event.currentTarget as HTMLSelectElement).value))}><option value="2000">2,000（快速测试）</option><option value="4000">4,000（默认）</option><option value="6000">6,000</option></select></label>
          </div>
          <button class="primary-button" type="button" onClick={() => void start()} disabled={busy}>开始对局</button>
        </section>
      )}

      {session && state && (
        <>
          <section class="scoreboard panel-card" aria-label="计分板">
            <div class={`score-side player-side${state.winner === 'player' ? ' is-winner' : ''}`}><span class="side-label">你</span><strong>{state.playerScore.toLocaleString()}</strong>{state.winner === 'player' && <span class="goal-badge">✓ 已达标</span>}</div>
            <div class="target-score"><span>目标</span><strong>{state.targetScore.toLocaleString()}</strong></div>
            <div class={`score-side ai-side${state.winner === 'ai' ? ' is-winner' : ''}`}><span class="side-label">{currentDifficulty.label}</span><strong>{(aiProgress?.score ?? state.aiScore).toLocaleString()}</strong>{state.winner === 'ai' && <span class="goal-badge">✓ 已达标</span>}</div>
          </section>

          <section class="play-layout">
            <div class="play-card panel-card">
              <div class="turn-heading"><div><span class="eyebrow">当前回合</span><h2>{aiPlayback ? 'NPC掷骰阶段' : state.phase === 'finished' ? (state.winner === 'player' ? '你赢了' : 'NPC获胜') : '你的掷骰阶段'}</h2></div><span class="turn-points">本轮累计 <b>{(aiProgress?.turnScore ?? (bustDisplay ? (bustPhase === 'alert' ? 0 : (bustBreakdown ?? []).reduce((sum, entry) => sum + entry.score, 0)) : state.turnScore)).toLocaleString()}</b></span></div>
              <TurnBreakdown entries={aiProgress?.entries ?? (bustDisplay ? bustBreakdown ?? [] : state.turnBreakdown)} />
              {aiPlayback && aiFrame && <AiTurnBoard event={aiFrame} />}
              {!aiPlayback && <div class={`dice-tray${bustDisplay && bustPhase === 'alert' ? ' is-bust-table' : ''}`} aria-label={bustDisplay ? (bustPhase === 'alert' ? '爆骰结果牌面' : '爆骰待确认牌面') : '当前骰子'}>
                {bustDisplay ? <>
                  {bustPhase === 'alert' && <div class="bust-table-heading is-alert"><strong>爆骰</strong><span>本轮未收下的分数已丢失</span></div>}
                  <div class="bust-table-dice">{(bustDisplay.dice ?? []).map((die) => <div key={die.id} class="die-button die-static bust-table-die" aria-label={bustPhase === 'alert' ? `${die.value}点爆骰结果` : `${die.value}点骰子`}><DieFace value={die.value} /></div>)}</div>
                </> : <>
                  {state.dice.length === 0 && <p class="empty-dice">点击下方按钮掷出六枚骰子</p>}
                  {state.dice.map((die) => state.phase === 'finished' ? <div key={die.id} class="die-button die-static" aria-label={`${die.value}点最终骰子`}><DieFace value={die.value} /></div> : <button key={die.id} type="button" class={`die-button${selected.has(die.id) ? ' is-selected' : ''}`} onClick={() => toggleDie(die)} aria-label={`${die.value}点骰子${selected.has(die.id) ? '，已选中' : ''}`}><DieFace value={die.value} /></button>)}
                </>}
              </div>}
              {aiPlayback && aiFrame ? <div class={`selection-readout ai-action-readout${aiFrame.kind === 'bust' ? ' is-bust' : ''}`}><span>NPC动作</span><strong>{describeAiAction(aiFrame)}</strong>{aiFrame.option && <small>牌型：{aiFrame.option.kind}（{aiFrame.option.label}）</small>}</div> : bustDisplay ? <div class={`selection-readout bust-action-readout${bustPhase === 'alert' ? ' is-alert' : ''}`}><span>{bustPhase === 'alert' ? '回合状态' : '本次选择'}</span><strong>{bustPhase === 'alert' ? '爆骰' : '—'}</strong>{bustPhase === 'alert' && <small>{bustDisplay.message} · {pendingAiEvents?.length ? '结果展示结束后进入 NPC 回合' : '结果展示结束后继续游戏'}</small>}</div> : <div class="selection-readout"><span>本次选择</span><strong>{selection ? `+${selection.score.toLocaleString()}` : '请选择完整计分组合'}</strong>{selection && <small>骰子：{selection.label}</small>}</div>}
              <div class="action-row">
                <button class="primary-button" type="button" onClick={() => void act({ type: 'roll', selectedDieIds: state.dice.length ? [...selected] : undefined })} disabled={busy || Boolean(bustDisplay) || Boolean(aiPlayback) || state.phase === 'finished' || (state.dice.length > 0 && !selection)}>{state.dice.length ? '保留并继续' : '掷骰'}</button>
                <button class="gold-button" type="button" onClick={() => void act({ type: 'bank', selectedDieIds: [...selected] })} disabled={busy || Boolean(bustDisplay) || Boolean(aiPlayback) || state.phase === 'finished' || !selection}>收下本轮分数</button>
                <button class="ghost-button" type="button" onClick={() => void act({ type: 'forfeit' })} disabled={busy || Boolean(bustDisplay) || Boolean(aiPlayback) || state.phase === 'finished'}>放弃对局</button>
              </div>
              {state.phase === 'finished' && state.result && <RoundResultView result={state.result} />}
              {state.phase === 'finished' && <button class="primary-button restart-button" type="button" onClick={() => void start()}>再来一局</button>}
              {notice && <p class="notice" role="status">{notice}</p>}
            </div>
            <aside class="log-card panel-card"><div class="turn-heading"><div><span class="eyebrow">事件记录</span><h2>对局记录</h2></div><span class="revision">第 {session.revision} 次结算</span></div><EventLog events={state.events} /></aside>
          </section>

        </>
      )}
      <footer class="rules-foot">1点=100 · 5点=50（可与顺子、同点数组合叠加） · 1-5顺=500 · 2-6顺=750 · 1-6顺=1500 · 三个相同点数起计分 · 爆骰丢失本轮未收下分数 · 六骰全计分触发热骰</footer>
    </main>
  );
}

function TurnBreakdown({ entries }: { entries: Array<{ label: string; score: number }> }) {
  const total = entries.reduce((sum, entry) => sum + entry.score, 0);
  return (
    <section class="turn-breakdown" aria-label="本轮前面阶段拿分明细">
      <div class="turn-breakdown-heading"><span>前面阶段已保留</span><strong>{total.toLocaleString()} 分</strong></div>
      {entries.length === 0 ? <small>还没有前面阶段的拿分记录</small> : (
        <ul>{entries.map((entry, index) => <li key={`${entry.label}-${index}`}><span>骰子 {entry.label}</span><b>+{entry.score.toLocaleString()}</b></li>)}</ul>
      )}
    </section>
  );
}

function AiTurnBoard({ event }: { event: GameEvent }) {
  const selectedIds = new Set(event.option?.dieIds ?? []);
  return (
    <section class={`ai-turn-board${event.kind === 'bust' ? ' is-bust' : ''}`} aria-label="NPC回合动作">
      <div class="ai-turn-heading"><span>NPC当前牌面</span><small>动作会短暂停留，便于查看</small></div>
      <div class="ai-dice-tray">
        {(event.dice ?? []).map((die) => <div key={die.id} class="ai-die-wrap"><div class={`die-button die-static${selectedIds.has(die.id) ? ' is-selected' : ''}`} aria-label={`NPC的${die.value}点骰子${selectedIds.has(die.id) ? '，已保留' : ''}`}><DieFace value={die.value} /></div>{selectedIds.has(die.id) && <span class="ai-die-badge">保留</span>}</div>)}
      </div>
    </section>
  );
}

function describeAiAction(event: GameEvent): string {
  if (event.kind === 'roll') return '掷骰';
  if (event.kind === 'keep') return `选择并保留 ${event.option?.label ?? '计分组合'}，+${(event.points ?? 0).toLocaleString()} 分`;
  if (event.kind === 'bank') return `收下本轮分数 ${(event.points ?? 0).toLocaleString()}`;
  if (event.kind === 'hot_dice') return '热骰，重新掷出六枚骰子';
  if (event.kind === 'bust') return `爆骰，本轮 ${(event.points ?? 0).toLocaleString()} 分丢失`;
  return event.message;
}

function RoundResultView({ result }: { result: RoundResult }) {
  return (
    <section class="round-result" aria-live="polite">
      <p class="eyebrow">牌桌结算</p>
      <h3>{result.winner === 'player' ? '胜利' : '失败'}</h3>
      <p><b>牌型：</b>{result.kind}（{result.label}）</p>
      <p><b>本次得分：</b>+{result.points.toLocaleString()}</p>
      <small>结果会保留在牌桌上；点击“再来一局”后才会清除分数和骰子。</small>
    </section>
  );
}

function DieFace({ value }: { value: number }) {
  const positions: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  return <span class="die-art" aria-hidden="true">{positions[value].map((position) => <i key={position} class={`pip pip-${position}`} />)}</span>;
}

function EventLog({ events }: { events: GameEvent[] }) {
  return <ol class="event-log">{events.slice(-12).reverse().map((event, index) => <li key={`${event.kind}-${index}`} class={event.side === 'player' ? 'event-player' : 'event-ai'}><span>{event.side === 'player' ? '你' : 'NPC'}</span>{event.message}</li>)}</ol>;
}

function errorMessage(error: unknown): string {
  return error instanceof DiceLabApiError ? error.message : '实验场请求失败，请重新开始';
}
