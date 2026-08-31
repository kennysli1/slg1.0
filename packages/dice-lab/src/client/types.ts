import type { DiceGameState } from '../domain/engine.js';
import type { ScoreOption } from '../domain/rules.js';

export type ClientSessionView = {
  id: string;
  revision: number;
  state: DiceGameState;
  selectableOptions: ScoreOption[];
};
