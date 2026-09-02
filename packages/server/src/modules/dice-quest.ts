/**
 * 骰子王任务的临时对局 owner。
 *
 * session 不落盘：刷新页面/断线会结束当前牌桌，任务胜场只在每局结算后
 * 通过 task.RecordDiceRound 写入任务 owner。这样不会把实验场 HTTP 会话或
 * 任何实验场页面依赖带入主游戏。
 */
import type { Command, CommandResult } from '@slg/shared';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import { applyDiceAction, createDiceState, legalOptions, type DiceAction, type DiceDifficulty, type DiceEvent, type DiceState } from '../infra/dice-quest-engine.js';

interface Session {
  id: string;
  /** 牌桌创建者；后续动作不能因切换当前村庄而丢失牌桌。 */
  playerId?: string;
  villageId: string;
  taskCode: 's6' | 's7' | 's8';
  winsRequired: number;
  playerWins: number;
  npcWins: number;
  state: DiceState;
  createdAt: number;
}

export class DiceQuestModule {
  static readonly NAME = 'diceQuest';
  private config: GameConfig;
  private readonly sessions = new Map<string, Session>();
  private nextSessionId = 0;

  constructor(private commands: CommandBus, private now: () => number, config: GameConfig, private rng: () => number = Math.random) {
    this.config = config;
  }

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('diceQuest.StartMatch', (cmd) => this.startMatch(cmd));
    this.commands.register('diceQuest.GetMatch', (cmd) => this.getMatch(cmd));
    this.commands.register('diceQuest.Action', (cmd) => this.action(cmd));
    this.commands.register('diceQuest.ExitMatch', (cmd) => this.exitMatch(cmd));
  }

  private async startMatch(cmd: Command): Promise<CommandResult> {
    const { villageId, taskCode, playerId } = cmd.payload as { villageId?: string; taskCode?: string; playerId?: string };
    if (!villageId || (taskCode !== 's6' && taskCode !== 's7' && taskCode !== 's8')) return { ok: false, payload: {}, reason: 'invalid_dice_task' };
    // 对局不做断线续接：刷新页面或重新建立连接时，新的 StartMatch 直接
    // 丢弃旧的内存 session，从当前任务胜场快照重新开桌。这样不会因旧
    // session 留在服务端而把玩家永久挡在“已有对局”错误上。
    const existing = [...this.sessions.values()].find((session) => session.villageId === villageId);
    if (existing) this.sessions.delete(existing.id);
    const context = await this.commands.send({ name: 'task.GetDiceMatch', from: DiceQuestModule.NAME, payload: { villageId, code: taskCode } });
    if (!context.ok) return context;
    let p = context.payload as any;
    // S6 是“单局胜负 + 失败可重新尝试”，败局的 NPC 胜场只用于展示上一局，
    // 点击重新尝试时必须从 0:0 开始，不把上一局的结果带进新局。
    if (taskCode === 's6' && p.lastOutcome === 'npc') {
      const reset = await this.commands.send({ name: 'task.ResetDiceMatch', from: DiceQuestModule.NAME, payload: { villageId, code: taskCode } });
      if (!reset.ok) return reset;
      const refreshed = await this.commands.send({ name: 'task.GetDiceMatch', from: DiceQuestModule.NAME, payload: { villageId, code: taskCode } });
      if (!refreshed.ok) return refreshed;
      p = refreshed.payload as any;
    }
    const session: Session = {
      id: `dice-task-${taskCode}-${Math.floor(this.now())}-${++this.nextSessionId}`,
      playerId,
      villageId,
      taskCode,
      winsRequired: Math.max(1, Number(p.winsRequired) || 1),
      playerWins: Math.max(0, Number(p.playerWins) || 0),
      npcWins: Math.max(0, Number(p.npcWins) || 0),
      state: createDiceState((p.difficulty ?? 'easy') as DiceDifficulty, Math.max(1, Number(p.targetScore) || 2000)),
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return { ok: true, payload: this.snapshot(session) };
  }

  private getMatch(cmd: Command): CommandResult {
    const { villageId, sessionId, playerId } = cmd.payload as { villageId?: string; sessionId?: string; playerId?: string };
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    // Gateway 会继续注入当前操作村来保持请求串行，但牌桌归属是开桌时的村庄。
    // 已鉴权的 playerId 是更可靠的身份；切村后读取同一牌桌不应被当前村覆盖。
    if (!session || (playerId && session.playerId !== playerId) || (!playerId && villageId && session.villageId !== villageId)) return { ok: false, payload: {}, reason: 'dice_session_not_found' };
    return { ok: true, payload: this.snapshot(session) };
  }

  private async action(cmd: Command): Promise<CommandResult> {
    const { villageId, sessionId, playerId, type, selectedDieIds } = cmd.payload as { villageId?: string; sessionId?: string; playerId?: string; type?: string; selectedDieIds?: string[] };
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || (playerId && session.playerId !== playerId) || (!playerId && villageId && session.villageId !== villageId)) return { ok: false, payload: {}, reason: 'dice_session_not_found' };
    if (type !== 'roll' && type !== 'bank' && type !== 'forfeit') return { ok: false, payload: {}, reason: 'invalid_dice_action' };
    const action: DiceAction = { type, selectedDieIds } as DiceAction;
    const result = applyDiceAction(session.state, action, this.rng);
    if (result.error) return { ok: false, payload: this.snapshot(session, result.events), reason: result.error };
    let round: any = null;
    if (session.state.phase === 'finished' && session.state.winner) {
      const recorded = await this.commands.send({
        name: 'task.RecordDiceRound', from: DiceQuestModule.NAME,
        // 进度始终写回开桌时的任务村；玩家在牌桌期间切换当前操作村
        // 不应改变骰子任务的归属。
        payload: { villageId: session.villageId, code: session.taskCode, winner: session.state.winner === 'player' ? 'player' : 'npc' },
      });
      if (!recorded.ok) return recorded;
      round = recorded.payload;
      session.playerWins = Number((round as any).playerWins) || session.playerWins;
      session.npcWins = Number((round as any).npcWins) || session.npcWins;
    }
    return { ok: true, payload: { ...this.snapshot(session, result.events), round } };
  }

  private exitMatch(cmd: Command): CommandResult {
    const { villageId, sessionId, playerId } = cmd.payload as { villageId?: string; sessionId?: string; playerId?: string };
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    // 退出是幂等清理：用户关闭弹窗、刷新页面或旧弹窗在重新开桌后
    // 可能重复发送同一个 sessionId。此时牌桌已经不存在，仍视为退出成功，
    // 避免把正常的关闭动作显示成 dice_session_not_found。
    if (!session) return { ok: true, payload: { sessionId, alreadyClosed: true } };
    if ((playerId && session.playerId !== playerId) || (!playerId && villageId && session.villageId !== villageId)) return { ok: false, payload: {}, reason: 'dice_session_not_found' };
    this.sessions.delete(session.id);
    return { ok: true, payload: { sessionId: session.id } };
  }

  private snapshot(session: Session, events?: DiceEvent[]): Record<string, unknown> {
    return {
      sessionId: session.id,
      taskCode: session.taskCode,
      state: session.state,
      selectableOptions: session.state.phase === 'player' ? legalOptions(session.state.dice) : [],
      events: events ?? [],
      match: { playerWins: session.playerWins, npcWins: session.npcWins, winsRequired: session.winsRequired },
    };
  }
}
