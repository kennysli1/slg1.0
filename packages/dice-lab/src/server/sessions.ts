/**
 * Dice Lab 的临时会话 owner。会话只存在内存，刷新、进程重启或过期后不会恢复，也不会触碰 KOW 存档。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { applyAction, createGame, selectableOptions, type DiceGameState, type PlayerAction } from '../domain/engine.js';
import type { Difficulty, DiceRng, ScoreOption } from '../domain/index.js';

export type SessionView = {
  id: string;
  revision: number;
  state: DiceGameState;
  selectableOptions: ScoreOption[];
};

type RecordItem = {
  id: string;
  revision: number;
  state: DiceGameState;
  lastTouchedAt: number;
};

export class SessionError extends Error {
  constructor(public readonly code: 'not_found' | 'stale_revision' | 'invalid_action', message: string) {
    super(message);
  }
}

export class DiceLabSessions {
  private readonly records = new Map<string, RecordItem>();

  constructor(
    private readonly maxSessions = 500,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly rng: DiceRng = () => randomInt(0, 1_000_000) / 1_000_000,
  ) {}

  create(difficulty: Difficulty, targetScore: number): SessionView {
    this.prune();
    if (this.records.size >= this.maxSessions) {
      const oldest = [...this.records.values()].sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)[0];
      if (oldest) this.records.delete(oldest.id);
    }
    const id = randomBytes(16).toString('hex');
    const item: RecordItem = { id, revision: 0, state: createGame(difficulty, targetScore), lastTouchedAt: Date.now() };
    this.records.set(id, item);
    return this.view(item);
  }

  get(id: string): SessionView {
    const item = this.find(id);
    return this.view(item);
  }

  act(id: string, expectedRevision: number, action: PlayerAction): SessionView {
    const item = this.find(id);
    if (item.revision !== expectedRevision) throw new SessionError('stale_revision', '对局已经更新，请刷新当前状态');
    const result = applyAction(item.state, action, this.rng);
    if (result.error) throw new SessionError('invalid_action', result.error);
    item.revision += 1;
    item.lastTouchedAt = Date.now();
    return this.view(item);
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  private find(id: string): RecordItem {
    this.prune();
    const item = this.records.get(id);
    if (!item) throw new SessionError('not_found', '对局不存在或已过期，请重新开始');
    item.lastTouchedAt = Date.now();
    return item;
  }

  private view(item: RecordItem): SessionView {
    return { id: item.id, revision: item.revision, state: item.state, selectableOptions: selectableOptions(item.state) };
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, item] of this.records) if (item.lastTouchedAt < cutoff) this.records.delete(id);
  }
}
