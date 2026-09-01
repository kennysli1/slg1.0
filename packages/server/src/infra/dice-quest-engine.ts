/**
 * 主游戏骰子任务的纯规则层。
 *
 * 这是实验场规则的独立副本：主游戏不会 import dice-lab workspace，实验场
 * 的 UI/调试改动也不会改变线上任务的计分结果。
 */
export type DiceDifficulty = 'easy' | 'normal' | 'hard';
export type Die = { id: string; value: number };
export type ScoreOption = { dieIds: string[]; score: number; label: string; kind: string };
export type DiceEvent = {
  kind: 'roll' | 'keep' | 'bank' | 'bust' | 'hot_dice' | 'win' | 'loss';
  side: 'player' | 'ai';
  dice?: Die[];
  option?: ScoreOption;
  points?: number;
  /** NPC 回合在该动作结束后的阶段累计；用于客户端按事件精确回放。 */
  turnScore?: number;
  message: string;
};
export type DiceState = {
  phase: 'player' | 'finished';
  difficulty: DiceDifficulty;
  targetScore: number;
  playerScore: number;
  aiScore: number;
  turnScore: number;
  turnBreakdown: { label: string; score: number }[];
  dice: Die[];
  rollNumber: number;
  winner?: 'player' | 'ai';
  result?: { winner: 'player' | 'ai'; kind: string; label: string; points: number; dice: Die[]; message: string };
  events: DiceEvent[];
};

function fairRoll(rng: () => number): number { return Math.floor(rng() * 6) + 1; }
function rollDice(count: number, rng: () => number, rollId: number): Die[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${rollId}-${index}`, value: fairRoll(rng) }));
}
function countsFor(values: number[]): number[] {
  const counts = Array.from({ length: 7 }, () => 0);
  for (const value of values) if (Number.isInteger(value) && value >= 1 && value <= 6) counts[value]++;
  return counts;
}
function straightScore(counts: number[]): { score: number; kind: string } | null {
  const straights = [
    { values: [1, 2, 3, 4, 5, 6], score: 1500 },
    { values: [1, 2, 3, 4, 5], score: 500 },
    { values: [2, 3, 4, 5, 6], score: 750 },
  ];
  for (const straight of straights) {
    if (!straight.values.every((value) => counts[value] > 0)) continue;
    const remaining = [...counts];
    for (const value of straight.values) remaining[value]--;
    const onlyScoringExtras = remaining.every((count, value) => value === 0 || value === 1 || value === 5 ? true : count === 0);
    if (!onlyScoringExtras) continue;
    const extra = remaining[1] * 100 + remaining[5] * 50;
    return { score: straight.score + extra, kind: extra ? '顺子＋单骰' : '顺子' };
  }
  return null;
}
function scoreValues(values: number[]): number | null {
  if (!values.length || values.length > 6) return null;
  const counts = countsFor(values);
  const straight = straightScore(counts);
  if (straight) return straight.score;
  let score = 0, consumed = 0;
  for (let value = 1; value <= 6; value++) {
    const count = counts[value];
    if (count < 3) continue;
    const base = value === 1 ? 1000 : value * 100;
    const multiplier = count >= 6 ? 8 : count >= 5 ? 4 : count >= 4 ? 2 : 1;
    score += base * multiplier;
    consumed += count;
  }
  for (const value of [1, 5]) {
    const remaining = counts[value] >= 3 ? 0 : counts[value];
    score += remaining * (value === 1 ? 100 : 50);
    consumed += remaining;
  }
  return consumed === values.length ? score : null;
}
function scoreKind(values: number[]): string {
  const straight = straightScore(countsFor(values));
  if (straight) return straight.kind;
  if (values.length === 1) return '单骰';
  if (countsFor(values).some((count) => count >= 3)) return '同点数组合';
  return '单骰组合';
}
function scoreOption(dice: Die[], ids: string[]): ScoreOption | null {
  if (!ids.length || new Set(ids).size !== ids.length) return null;
  const selected = dice.filter((die) => ids.includes(die.id));
  if (selected.length !== ids.length) return null;
  const score = scoreValues(selected.map((die) => die.value));
  if (score == null) return null;
  return { dieIds: selected.map((die) => die.id), score, label: selected.map((die) => die.value).sort((a, b) => a - b).join('、'), kind: scoreKind(selected.map((die) => die.value)) };
}
export function legalOptions(dice: Die[]): ScoreOption[] {
  const out: ScoreOption[] = [];
  for (let mask = 1; mask < (1 << dice.length); mask++) {
    const ids = dice.filter((_, index) => mask & (1 << index)).map((die) => die.id);
    const option = scoreOption(dice, ids);
    if (option) out.push(option);
  }
  return out.sort((a, b) => b.score - a.score || a.dieIds.length - b.dieIds.length);
}
function isHotDice(dice: Die[], option: ScoreOption): boolean { return dice.length === option.dieIds.length; }
function remainingDice(dice: Die[], option: ScoreOption): Die[] { const used = new Set(option.dieIds); return dice.filter((die) => !used.has(die.id)); }

export function createDiceState(difficulty: DiceDifficulty, targetScore: number): DiceState {
  return { phase: 'player', difficulty, targetScore, playerScore: 0, aiScore: 0, turnScore: 0, turnBreakdown: [], dice: [], rollNumber: 0, events: [] };
}
function append(state: DiceState, event: DiceEvent, delta: DiceEvent[]): void { state.events = [...state.events.slice(-39), event]; delta.push(event); }
function newRoll(state: DiceState, count: number, rng: () => number, side: 'player' | 'ai', delta: DiceEvent[]): Die[] {
  state.rollNumber++;
  const dice = rollDice(count, rng, state.rollNumber);
  append(state, { kind: 'roll', side, dice, message: side === 'player' ? '你掷出了骰子' : 'NPC掷出了骰子' }, delta);
  return dice;
}
function finishIfReached(state: DiceState, side: 'player' | 'ai', details: Partial<NonNullable<DiceState['result']>>, delta: DiceEvent[]): boolean {
  const score = side === 'player' ? state.playerScore : state.aiScore;
  if (score < state.targetScore) return false;
  state.phase = 'finished'; state.winner = side;
  const message = side === 'player' ? '你先达到目标分数，赢得对局' : 'NPC先达到目标分数，对局结束';
  append(state, { kind: side === 'player' ? 'win' : 'loss', side, points: score, message }, delta);
  state.result = { winner: side, kind: details.kind ?? '对局结算', label: details.label ?? '—', points: details.points ?? score, dice: details.dice?.map((die) => ({ ...die })) ?? [], message };
  return true;
}

type AiDecision = { option: ScoreOption; bank: boolean };
function chooseAiDecision(state: DiceState, dice: Die[], turnScore: number, rng: () => number): AiDecision {
  const options = legalOptions(dice);
  const option = options[Math.min(options.length - 1, Math.floor(rng() * Math.min(options.length, 4)))]!;
  const projected = state.aiScore + turnScore + option.score;
  const bank = projected >= state.targetScore || (turnScore + option.score >= 350 && rng() < 0.65);
  return { option, bank: dice.length > option.dieIds.length ? bank : false };
}
function runAiTurn(state: DiceState, rng: () => number, delta: DiceEvent[]): void {
  let dice = newRoll(state, 6, rng, 'ai', delta), turnScore = 0;
  while (true) {
    const options = legalOptions(dice);
    if (!options.length) {
      append(state, { kind: 'bust', side: 'ai', dice, points: turnScore, turnScore, message: `NPC爆骰，丢失本轮 ${turnScore} 分` }, delta);
      break;
    }
    const decision = chooseAiDecision(state, dice, turnScore, rng);
    turnScore += decision.option.score;
    append(state, { kind: 'keep', side: 'ai', dice: dice.slice(), option: decision.option, points: decision.option.score, turnScore, message: `NPC保留 ${decision.option.label}，获得 ${decision.option.score} 分` }, delta);
    const rest = remainingDice(dice, decision.option);
    if (decision.bank) {
      state.aiScore += turnScore;
      append(state, { kind: 'bank', side: 'ai', dice: dice.slice(), option: decision.option, points: turnScore, turnScore, message: `NPC收下本轮 ${turnScore} 分` }, delta);
      if (finishIfReached(state, 'ai', { kind: decision.option.kind, label: decision.option.label, points: turnScore, dice }, delta)) state.dice = dice.slice();
      break;
    }
    dice = newRoll(state, isHotDice(dice, decision.option) ? 6 : rest.length, rng, 'ai', delta);
  }
  if (state.phase !== 'finished') state.dice = [];
  state.turnScore = 0;
}

function playerBust(state: DiceState, rng: () => number, delta: DiceEvent[]): void {
  const lost = state.turnScore;
  append(state, { kind: 'bust', side: 'player', dice: state.dice.slice(), points: lost, message: `爆骰，本轮 ${lost} 分全部丢失` }, delta);
  state.turnScore = 0; state.turnBreakdown = []; state.dice = [];
  runAiTurn(state, rng, delta);
}

export type DiceAction = { type: 'roll' | 'bank' | 'forfeit'; selectedDieIds?: string[] };
export function applyDiceAction(state: DiceState, action: DiceAction, rng: () => number = Math.random): { state: DiceState; events: DiceEvent[]; error?: string } {
  const events: DiceEvent[] = [];
  if (state.phase === 'finished') return { state, events, error: '对局已经结束' };
  if (action.type === 'forfeit') {
    state.phase = 'finished'; state.winner = 'ai'; state.dice = []; state.turnScore = 0; state.turnBreakdown = [];
    append(state, { kind: 'loss', side: 'ai', message: '你放弃了本局对局' }, events);
    state.result = { winner: 'ai', kind: '放弃对局', label: '—', points: 0, dice: [], message: '你放弃了本局对局' };
    return { state, events };
  }
  if (!state.dice.length) {
    state.dice = newRoll(state, 6, rng, 'player', events);
    if (!legalOptions(state.dice).length) playerBust(state, rng, events);
    return { state, events };
  }
  const ids = action.selectedDieIds ?? [];
  const option = scoreOption(state.dice, ids);
  if (!option) return { state, events, error: action.type === 'roll' ? '继续掷骰前至少选择一组完整的计分骰' : '收分前必须选择完整的合法计分组合' };
  state.turnScore += option.score;
  state.turnBreakdown = [...state.turnBreakdown, { label: option.label, score: option.score }];
  append(state, { kind: 'keep', side: 'player', dice: state.dice.slice(), option, points: option.score, message: `保留 ${option.label}，获得 ${option.score} 分` }, events);
  if (action.type === 'bank') {
    const gained = state.turnScore;
    const finalDice = state.dice.slice();
    state.playerScore += gained; state.turnScore = 0; state.turnBreakdown = [];
    append(state, { kind: 'bank', side: 'player', dice: finalDice, option, points: gained, message: `收下本轮分数 ${gained}` }, events);
    if (finishIfReached(state, 'player', { kind: option.kind, label: option.label, points: gained, dice: finalDice }, events)) { state.dice = finalDice; return { state, events }; }
    state.dice = []; runAiTurn(state, rng, events); return { state, events };
  }
  const rest = remainingDice(state.dice, option);
  state.dice = newRoll(state, isHotDice(state.dice, option) ? 6 : rest.length, rng, 'player', events);
  if (!legalOptions(state.dice).length) playerBust(state, rng, events);
  return { state, events };
}
