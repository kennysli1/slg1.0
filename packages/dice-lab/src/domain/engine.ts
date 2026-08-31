/**
 * Dice Lab 的回合状态机。所有分数、爆骰、热骰和胜负都在这里决定，HTTP 层只负责会话与输入校验。
 */
import {
  isHotDice,
  legalOptions,
  remainingDice,
  rollDice,
  scoreOption,
  type DiceRng,
  type Die,
  type ScoreOption,
} from './rules.js';
import { chooseAiDecision, type AiDecision, type Difficulty } from './ai.js';

export type GamePhase = 'player' | 'finished';

export type GameEvent = {
  kind: 'roll' | 'keep' | 'bank' | 'bust' | 'hot_dice' | 'win' | 'loss';
  side: 'player' | 'ai';
  dice?: Die[];
  option?: ScoreOption;
  points?: number;
  message: string;
};

export type DiceGameState = {
  phase: GamePhase;
  difficulty: Difficulty;
  targetScore: number;
  playerScore: number;
  aiScore: number;
  turnScore: number;
  dice: Die[];
  rollNumber: number;
  winner?: 'player' | 'ai';
  events: GameEvent[];
};

export type PlayerAction =
  | { type: 'roll'; selectedDieIds?: string[] }
  | { type: 'bank'; selectedDieIds: string[] }
  | { type: 'forfeit' };

export type ActionResult = {
  state: DiceGameState;
  error?: string;
  aiEvents: GameEvent[];
};

export function createGame(difficulty: Difficulty, targetScore: number): DiceGameState {
  return {
    phase: 'player', difficulty, targetScore,
    playerScore: 0, aiScore: 0, turnScore: 0,
    dice: [], rollNumber: 0, events: [],
  };
}

function append(state: DiceGameState, event: GameEvent): void {
  state.events = [...state.events.slice(-39), event];
}

function newRoll(state: DiceGameState, count: number, rng: DiceRng, side: 'player' | 'ai'): Die[] {
  state.rollNumber += 1;
  const dice = rollDice(count, rng, state.rollNumber);
  append(state, { kind: 'roll', side, dice, message: side === 'player' ? '你掷出了骰子' : 'NPC掷出了骰子' });
  return dice;
}

function selectedOption(state: DiceGameState, selectedDieIds: string[]): ScoreOption | null {
  return scoreOption(state.dice, selectedDieIds);
}

function finishIfReached(state: DiceGameState, side: 'player' | 'ai'): boolean {
  const score = side === 'player' ? state.playerScore : state.aiScore;
  if (score < state.targetScore) return false;
  state.phase = 'finished';
  state.winner = side;
  append(state, {
    kind: side === 'player' ? 'win' : 'loss', side,
    points: score, message: side === 'player' ? '你先达到目标分数，赢得对局' : 'NPC先达到目标分数，对局结束',
  });
  return true;
}

function playerRoll(state: DiceGameState, selectedDieIds: string[] | undefined, rng: DiceRng): ActionResult {
  if (state.dice.length === 0) {
    state.dice = newRoll(state, 6, rng, 'player');
    if (legalOptions(state.dice).length === 0) return playerBust(state, rng);
    return { state, aiEvents: [] };
  }
  if (!selectedDieIds?.length) return { state, error: '继续掷骰前至少选择一组计分骰', aiEvents: [] };
  const option = selectedOption(state, selectedDieIds);
  if (!option) return { state, error: '所选骰子不是完整的合法计分组合', aiEvents: [] };
  state.turnScore += option.score;
  append(state, { kind: 'keep', side: 'player', option, points: option.score, message: `保留 ${option.label}，获得 ${option.score} 分` });
  const rest = remainingDice(state.dice, option);
  if (isHotDice(state.dice, option)) {
    append(state, { kind: 'hot_dice', side: 'player', points: option.score, message: '热骰：重新掷出六枚骰子' });
    state.dice = newRoll(state, 6, rng, 'player');
  } else {
    state.dice = newRoll(state, rest.length, rng, 'player');
  }
  if (legalOptions(state.dice).length === 0) return playerBust(state, rng);
  return { state, aiEvents: [] };
}

function playerBust(state: DiceGameState, rng: DiceRng): ActionResult {
  const lost = state.turnScore;
  state.turnScore = 0;
  state.dice = [];
  append(state, { kind: 'bust', side: 'player', points: lost, message: `爆骰，本轮 ${lost} 分全部丢失` });
  const aiEvents = runAiTurn(state, state.difficulty, rng);
  return { state, aiEvents };
}

function playerBank(state: DiceGameState, selectedDieIds: string[], rng: DiceRng): ActionResult {
  const option = selectedOption(state, selectedDieIds);
  if (!option) return { state, error: '收分前必须选择完整的合法计分组合', aiEvents: [] };
  const gained = state.turnScore + option.score;
  state.playerScore += gained;
  state.turnScore = 0;
  state.dice = [];
  append(state, { kind: 'bank', side: 'player', option, points: gained, message: `收下本轮分数 ${gained}` });
  if (finishIfReached(state, 'player')) return { state, aiEvents: [] };
  const aiEvents = runAiTurn(state, state.difficulty, rng);
  return { state, aiEvents };
}

function runAiTurn(state: DiceGameState, difficulty: Difficulty, rng: DiceRng): GameEvent[] {
  const before = state.events.length;
  let dice = newRoll(state, 6, rng, 'ai');
  let turnScore = 0;
  while (true) {
    const options = legalOptions(dice);
    if (options.length === 0) {
      append(state, { kind: 'bust', side: 'ai', points: turnScore, message: `NPC爆骰，丢失本轮 ${turnScore} 分` });
      break;
    }
    const decision: AiDecision = chooseAiDecision(
      difficulty, dice, turnScore, state.aiScore, state.playerScore, state.targetScore, rng,
    );
    turnScore += decision.option.score;
    append(state, {
      kind: 'keep', side: 'ai', option: decision.option, points: decision.option.score,
      message: `NPC保留 ${decision.option.label}，获得 ${decision.option.score} 分`,
    });
    const rest = remainingDice(dice, decision.option);
    if (decision.bank) {
      state.aiScore += turnScore;
      append(state, { kind: 'bank', side: 'ai', option: decision.option, points: turnScore, message: `NPC收下本轮 ${turnScore} 分` });
      if (finishIfReached(state, 'ai')) break;
      break;
    }
    if (isHotDice(dice, decision.option)) {
      append(state, { kind: 'hot_dice', side: 'ai', points: turnScore, message: 'NPC触发热骰，重新掷出六枚骰子' });
      dice = newRoll(state, 6, rng, 'ai');
    } else {
      dice = newRoll(state, rest.length, rng, 'ai');
    }
  }
  state.dice = [];
  state.turnScore = 0;
  return state.events.slice(before);
}

export function applyAction(
  state: DiceGameState,
  action: PlayerAction,
  rng: DiceRng = Math.random,
): ActionResult {
  if (state.phase === 'finished') return { state, error: '对局已经结束，请重新开始', aiEvents: [] };
  if (action.type === 'forfeit') {
    state.phase = 'finished'; state.winner = 'ai'; state.dice = []; state.turnScore = 0;
    append(state, { kind: 'loss', side: 'ai', message: '你放弃了对局' });
    return { state, aiEvents: [] };
  }
  if (action.type === 'roll') return playerRoll(state, action.selectedDieIds, rng);
  if (action.type === 'bank') return playerBank(state, action.selectedDieIds, rng);
  return { state, error: '未知的对局动作', aiEvents: [] };
}

export function selectableOptions(state: DiceGameState): ScoreOption[] {
  return legalOptions(state.dice);
}
