/**
 * Dice Lab 的三档 NPC 决策。难度只改变收手和选骰策略，掷骰仍由同一套公平随机源产生。
 */
import { legalOptions, type Die, type DiceRng, type ScoreOption } from './rules.js';

export type Difficulty = 'easy' | 'normal' | 'hard';

export type AiDecision = {
  option: ScoreOption;
  bank: boolean;
};

const BUST_RISK_BY_DICE: Record<number, number> = {
  1: 0.67,
  2: 0.44,
  3: 0.30,
  4: 0.20,
  5: 0.11,
  6: 0.06,
};

function chooseRandom<T>(items: T[], rng: DiceRng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

function thresholdFor(diceCount: number): number {
  return ({ 1: 250, 2: 350, 3: 500, 4: 650, 5: 800, 6: 950 } as Record<number, number>)[diceCount] ?? 500;
}

function easyDecision(
  dice: Die[],
  options: ScoreOption[],
  turnScore: number,
  aiScore: number,
  targetScore: number,
  rng: DiceRng,
): AiDecision {
  const option = chooseRandom(options.slice(0, Math.min(options.length, 4)), rng);
  const projected = aiScore + turnScore + option.score;
  const bank = projected >= targetScore || (turnScore + option.score >= 350 && rng() < 0.65);
  return { option, bank: dice.length > option.dieIds.length ? bank : false };
}

function normalDecision(
  dice: Die[],
  options: ScoreOption[],
  turnScore: number,
  aiScore: number,
  playerScore: number,
  targetScore: number,
  rng: DiceRng,
): AiDecision {
  const best = options.slice(0, Math.min(options.length, 10));
  const option = best.reduce((current, candidate) => {
    const currentValue = current.score + (current.dieIds.length < dice.length ? (dice.length - current.dieIds.length) * 28 : 0);
    const candidateValue = candidate.score + (candidate.dieIds.length < dice.length ? (dice.length - candidate.dieIds.length) * 28 : 0);
    return candidateValue > currentValue ? candidate : current;
  }, best[0]);
  const projected = aiScore + turnScore + option.score;
  const threshold = thresholdFor(dice.length);
  const isBehind = aiScore + turnScore < playerScore;
  const bank = projected >= targetScore
    || (turnScore + option.score >= threshold && (!isBehind || rng() < 0.25));
  return { option, bank: dice.length > option.dieIds.length ? bank : false };
}

function hardDecision(
  dice: Die[],
  options: ScoreOption[],
  turnScore: number,
  aiScore: number,
  playerScore: number,
  targetScore: number,
  rng: DiceRng,
): AiDecision {
  const remaining = targetScore - aiScore;
  const opponentRemaining = targetScore - playerScore;
  const risk = BUST_RISK_BY_DICE[dice.length] ?? 0.3;
  let best = options[0];
  let bestUtility = Number.NEGATIVE_INFINITY;
  for (const option of options) {
    const kept = option.dieIds.length;
    const futureDice = dice.length - kept;
    const futureValue = futureDice > 0 ? (1 - (BUST_RISK_BY_DICE[futureDice] ?? risk)) * futureDice * 65 : 0;
    const total = turnScore + option.score;
    const winBonus = aiScore + total >= targetScore ? 100_000 : 0;
    const raceBonus = total >= remaining ? 10_000 : total >= opponentRemaining ? 400 : 0;
    const utility = winBonus + raceBonus + total + futureValue - risk * Math.max(0, total - 200);
    if (utility > bestUtility || (utility === bestUtility && rng() < 0.5)) {
      bestUtility = utility;
      best = option;
    }
  }
  const projected = aiScore + turnScore + best.score;
  const bank = projected >= targetScore
    || (turnScore + best.score >= 450 && (risk > 0.35 || projected >= playerScore));
  return { option: best, bank: dice.length > best.dieIds.length ? bank : false };
}

export function chooseAiDecision(
  difficulty: Difficulty,
  dice: Die[],
  turnScore: number,
  aiScore: number,
  playerScore: number,
  targetScore: number,
  rng: DiceRng,
): AiDecision {
  const options = legalOptions(dice);
  if (options.length === 0) throw new Error('AI 只能在存在合法计分骰时行动');
  if (difficulty === 'easy') return easyDecision(dice, options, turnScore, aiScore, targetScore, rng);
  if (difficulty === 'normal') return normalDecision(dice, options, turnScore, aiScore, playerScore, targetScore, rng);
  return hardDecision(dice, options, turnScore, aiScore, playerScore, targetScore, rng);
}
