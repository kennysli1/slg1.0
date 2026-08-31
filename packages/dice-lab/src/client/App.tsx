import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Difficulty } from '../domain/ai.js';
import type { Die, ScoreOption } from '../domain/rules.js';
import { scoreOption } from '../domain/rules.js';
import type { GameEvent } from '../domain/engine.js';
import type { ClientSessionView } from './types.js';
import { applyAction, createSession, DiceLabApiError } from './api.js';

const DIFFICULTIES: Array<{ value: Difficulty; label: string; description: string }> = [
  { value: 'easy', label: '简单 NPC', description: '偏保守，偶尔会冒险' },
  { value: 'normal', label: '普通 NPC', description: '会结合风险与比分' },
  { value: 'hard', label: '困难 NPC', description: '使用期望收益判断收手' },
];

const BUST_PREVIEW_MS = 2_500;

export function DiceLabApp() {
  const [token, setToken] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [targetScore, setTargetScore] = useState(4000);
  const [session, setSession] = useState<ClientSessionView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bustPreview, setBustPreview] = useState<GameEvent | null>(null);
  const lastBustSignature = useRef('');
  const [notice, setNotice] = useState('输入访问码后开始一局实验对局。刷新页面会开启新对局。');

  const state = session?.state;
  const selection = useMemo<ScoreOption | null>(() => (
    state ? scoreOption(state.dice, [...selected]) : null
  ), [state, selected]);

  useEffect(() => {
    if (!session) {
      lastBustSignature.current = '';
      setBustPreview(null);
      return;
    }
    const event = [...session.state.events].reverse().find((item) => item.kind === 'bust' && item.side === 'player');
    if (!event) return;
    const bustCount = session.state.events.filter((item) => item.kind === 'bust' && item.side === 'player').length;
    const signature = JSON.stringify([bustCount, event.kind, event.side, event.message, event.dice?.map((die) => die.value)]);
    if (signature === lastBustSignature.current) return;
    lastBustSignature.current = signature;
    setBustPreview(event);
    const timer = window.setTimeout(() => setBustPreview(null), BUST_PREVIEW_MS);
    return () => window.clearTimeout(timer);
  }, [session]);

  async function start() {
    setBusy(true); setNotice('正在创建实验对局…'); setSelected(new Set());
    lastBustSignature.current = '';
    setBustPreview(null);
    try {
      setSession(await createSession(token, difficulty, targetScore));
      setNotice('你先手。点击“掷骰”开始。');
    } catch (error) { setNotice(errorMessage(error)); setSession(null); }
    finally { setBusy(false); }
  }

  async function act(action: Parameters<typeof applyAction>[3]) {
    if (!session || busy || bustPreview) return;
    setBusy(true); setNotice('服务器正在结算…');
    try {
      setSession(await applyAction(token, session.id, session.revision, action));
      setSelected(new Set());
      setNotice('');
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof DiceLabApiError && (error.code === 'not_found' || error.code === 'stale_revision')) setSession(null);
    } finally { setBusy(false); }
  }

  function toggleDie(die: Die) {
    if (!state || state.phase !== 'player' || busy || state.dice.length === 0) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(die.id)) next.delete(die.id); else next.add(die.id);
      return next;
    });
  }

  const currentDifficulty = DIFFICULTIES.find((item) => item.value === difficulty)!;
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
            <div class="score-side player-side"><span class="side-label">你</span><strong>{state.playerScore.toLocaleString()}</strong></div>
            <div class="target-score"><span>目标</span><strong>{state.targetScore.toLocaleString()}</strong></div>
            <div class="score-side ai-side"><span class="side-label">{currentDifficulty.label}</span><strong>{state.aiScore.toLocaleString()}</strong></div>
          </section>

          <section class="play-layout">
            <div class="play-card panel-card">
              <div class="turn-heading"><div><span class="eyebrow">当前回合</span><h2>{state.phase === 'finished' ? (state.winner === 'player' ? '你赢了' : 'NPC获胜') : '你的掷骰阶段'}</h2></div><span class="turn-points">本轮累计 <b>{state.turnScore.toLocaleString()}</b></span></div>
              <div class="dice-tray" aria-label="当前骰子">
                {state.dice.length === 0 && <p class="empty-dice">点击下方按钮掷出六枚骰子</p>}
                {state.dice.map((die) => <button key={die.id} type="button" class={`die-button${selected.has(die.id) ? ' is-selected' : ''}`} onClick={() => toggleDie(die)} aria-label={`${die.value}点骰子${selected.has(die.id) ? '，已选中' : ''}`}><DieFace value={die.value} /></button>)}
              </div>
              <div class="selection-readout"><span>本次选择</span><strong>{selection ? `+${selection.score.toLocaleString()}` : '请选择完整计分组合'}</strong>{selection && <small>骰子：{selection.label}</small>}</div>
              <div class="action-row">
                <button class="primary-button" type="button" onClick={() => void act({ type: 'roll', selectedDieIds: state.dice.length ? [...selected] : undefined })} disabled={busy || state.phase === 'finished' || (state.dice.length > 0 && !selection)}>{state.dice.length ? '保留并继续' : '掷骰'}</button>
                <button class="gold-button" type="button" onClick={() => void act({ type: 'bank', selectedDieIds: [...selected] })} disabled={busy || state.phase === 'finished' || !selection}>收下本轮分数</button>
                <button class="ghost-button" type="button" onClick={() => void act({ type: 'forfeit' })} disabled={busy || state.phase === 'finished'}>放弃对局</button>
              </div>
              {state.phase === 'finished' && <button class="primary-button restart-button" type="button" onClick={() => void start()}>再来一局</button>}
              {notice && <p class="notice" role="status">{notice}</p>}
            </div>
            <aside class="log-card panel-card"><div class="turn-heading"><div><span class="eyebrow">事件记录</span><h2>对局记录</h2></div><span class="revision">第 {session.revision} 次结算</span></div><EventLog events={state.events} /></aside>
          </section>
          {bustPreview && <BustPreview event={bustPreview} />}
        </>
      )}
      <footer class="rules-foot">1点=100 · 5点=50 · 三个相同点数起计分 · 六连顺/三对=1500 · 爆骰丢失本轮未收下分数 · 六骰全计分触发热骰</footer>
    </main>
  );
}

function BustPreview({ event }: { event: GameEvent }) {
  return (
    <div class="bust-overlay" role="alert" aria-live="assertive">
      <section class="bust-result panel-card">
        <p class="eyebrow">本次掷骰结果</p>
        <h2>爆骰</h2>
        <div class="bust-dice" aria-label="爆骰时掷出的骰子">
          {(event.dice ?? []).map((die) => <div class="bust-die" key={die.id}><DieFace value={die.value} /><span>{die.value}</span></div>)}
        </div>
        <p>{event.message}</p>
        <small>结果展示结束后，你可以开始下一轮</small>
      </section>
    </div>
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
