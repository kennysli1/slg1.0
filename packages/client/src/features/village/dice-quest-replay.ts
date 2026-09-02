export type DiceQuestDie = { id: string; value: number };

export type DiceQuestEvent = {
  kind: string;
  side: 'player' | 'ai';
  dice?: DiceQuestDie[];
  option?: { dieIds: string[]; score: number; label: string };
  points?: number;
  turnScore?: number;
  message: string;
};

export type DiceQuestMatchScore = {
  playerWins: number;
  npcWins: number;
  winsRequired: number;
};

export type DiceQuestReplayBase = {
  playerScore: number;
  aiScore: number;
  turnScore: number;
  turnBreakdown: Array<{ label: string; score: number }>;
  dice: DiceQuestDie[];
  match: DiceQuestMatchScore;
};

export type DiceQuestReplayView = DiceQuestReplayBase & {
  activeSide: 'player' | 'ai';
  selectedDieIds: string[];
};

function startsSideStage(event: DiceQuestEvent): boolean {
  return event.kind === 'roll' || event.kind === 'keep' || event.kind === 'bank' || event.kind === 'bust';
}

/**
 * 从操作前快照逐条重放服务端事件，生成牌面与计分板的同一时刻视图。
 * 这样客户端不会在展示旧牌面时提前读取响应里的最终分数。
 */
export function projectDiceQuestReplay(
  base: DiceQuestReplayBase,
  events: DiceQuestEvent[],
  bustAlertVisible: boolean,
  finalMatch: DiceQuestMatchScore,
): DiceQuestReplayView {
  const view: DiceQuestReplayView = {
    ...base,
    dice: base.dice.map((die) => ({ ...die })),
    turnBreakdown: base.turnBreakdown.map((item) => ({ ...item })),
    match: { ...base.match },
    activeSide: 'player',
    selectedDieIds: [],
  };

  for (const event of events) {
    if (event.side !== view.activeSide && startsSideStage(event)) {
      view.activeSide = event.side;
      view.turnScore = 0;
      view.turnBreakdown = [];
      view.selectedDieIds = [];
    }
    if (event.dice) view.dice = event.dice.map((die) => ({ ...die }));

    if (event.kind === 'roll') {
      view.activeSide = event.side;
      view.selectedDieIds = [];
      continue;
    }

    if (event.kind === 'keep' && event.option) {
      view.activeSide = event.side;
      view.selectedDieIds = [...event.option.dieIds];
      view.turnScore = typeof event.turnScore === 'number'
        ? event.turnScore
        : view.turnScore + event.option.score;
      view.turnBreakdown = [
        ...view.turnBreakdown,
        { label: event.option.label, score: event.option.score },
      ];
      continue;
    }

    if (event.kind === 'bank') {
      view.activeSide = event.side;
      view.selectedDieIds = [...(event.option?.dieIds ?? [])];
      const gained = Math.max(0, Number(event.points) || view.turnScore);
      view.turnScore = typeof event.turnScore === 'number' ? event.turnScore : gained;
      if (event.side === 'player') view.playerScore += gained;
      else view.aiScore += gained;
      continue;
    }

    if (event.kind === 'bust') {
      view.activeSide = event.side;
      view.selectedDieIds = [];
      if (bustAlertVisible) {
        view.turnScore = 0;
        view.turnBreakdown = [];
      }
      continue;
    }

    if (event.kind === 'win' || event.kind === 'loss') {
      view.activeSide = event.side;
      view.match = { ...finalMatch };
      if (!event.dice) view.dice = [];
    }
  }

  return view;
}
