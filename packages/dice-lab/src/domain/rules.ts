/**
 * Dice Lab 的纯规则层：普通六面骰计分、合法选项和回合动作。
 * 该文件不依赖 KOW 状态或网络，服务器与客户端共用以保证预览和权威校验一致。
 */

export type Die = { id: string; value: number };

export type ScoreOption = {
  dieIds: string[];
  score: number;
  label: string;
  kind: string;
};

export type DiceRng = () => number;

export const TARGET_SCORE = 4_000;

export function fairRoll(rng: DiceRng = Math.random): number {
  return Math.floor(rng() * 6) + 1;
}

export function rollDice(count: number, rng: DiceRng = Math.random, rollId = 0): Die[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${rollId}-${index}`,
    value: fairRoll(rng),
  }));
}

function countsFor(values: number[]): number[] {
  const counts = Array.from({ length: 7 }, () => 0);
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > 6) return counts;
    counts[value]++;
  }
  return counts;
}

const STRAIGHTS: Array<{ values: number[]; score: number }> = [
  { values: [1, 2, 3, 4, 5, 6], score: 1_500 },
  { values: [1, 2, 3, 4, 5], score: 500 },
  { values: [2, 3, 4, 5, 6], score: 750 },
];

function straightScore(counts: number[]): { score: number; kind: string } | null {
  for (const straight of STRAIGHTS) {
    if (!straight.values.every((value) => counts[value] > 0)) continue;
    const remaining = [...counts];
    for (const value of straight.values) remaining[value] -= 1;
    const extraOnes = remaining[1];
    const extraFives = remaining[5];
    const onlyScoringExtras = remaining.every((count, value) => value === 0 || value === 1 || value === 5 ? true : count === 0);
    if (!onlyScoringExtras) continue;
    const extraScore = extraOnes * 100 + extraFives * 50;
    return {
      score: straight.score + extraScore,
      kind: extraScore > 0 ? '顺子＋单骰' : '顺子',
    };
  }
  return null;
}

/**
 * 返回一组骰子全部被计分时的最高分；null 表示其中有无法计分的骰子。
 * 顺子与同点数组合按 KCD2 普通骰子计分表计算；不在表中的组合不产生特殊奖励。
 */
export function scoreValues(values: number[]): number | null {
  if (values.length === 0 || values.length > 6) return null;
  const counts = countsFor(values);

  const straight = straightScore(counts);
  if (straight) return straight.score;

  let score = 0;
  let consumed = 0;
  for (let value = 1; value <= 6; value++) {
    const count = counts[value];
    if (count < 3) continue;
    const base = value === 1 ? 1_000 : value * 100;
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
  const counts = countsFor(values);
  const straight = straightScore(counts);
  if (straight) return straight.kind;
  if (values.length === 1) return '单骰';
  const sameKind = values.some((value) => counts[value] >= 3);
  if (sameKind) return '同点数组合';
  return '单骰组合';
}

export function scoreOption(dice: Die[], dieIds: string[]): ScoreOption | null {
  if (dieIds.length === 0) return null;
  const idSet = new Set(dieIds);
  if (idSet.size !== dieIds.length) return null;
  const selected = dice.filter((die) => idSet.has(die.id));
  if (selected.length !== dieIds.length) return null;
  const score = scoreValues(selected.map((die) => die.value));
  if (score === null) return null;
  return {
    dieIds: selected.map((die) => die.id),
    score,
    label: selected.map((die) => die.value).sort((a, b) => a - b).join('、'),
    kind: scoreKind(selected.map((die) => die.value)),
  };
}

/** 枚举最多 63 个非空子集，供按钮预览和 AI 选择使用。 */
export function legalOptions(dice: Die[]): ScoreOption[] {
  const options: ScoreOption[] = [];
  for (let mask = 1; mask < (1 << dice.length); mask++) {
    const ids = dice.filter((_, index) => (mask & (1 << index)) !== 0).map((die) => die.id);
    const option = scoreOption(dice, ids);
    if (option) options.push(option);
  }
  return options.sort((a, b) => b.score - a.score || a.dieIds.length - b.dieIds.length);
}

export function isHotDice(dice: Die[], option: ScoreOption): boolean {
  return option.dieIds.length === dice.length;
}

export function remainingDice(dice: Die[], option: ScoreOption): Die[] {
  const used = new Set(option.dieIds);
  return dice.filter((die) => !used.has(die.id));
}

export function formatScore(score: number): string {
  return score.toLocaleString('zh-CN');
}
