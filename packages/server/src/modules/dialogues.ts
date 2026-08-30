/**
 * 领域模块 · 对话（DialoguesModule）
 *
 * 对话定义来自 GameConfig/dialogues.csv；session 是一次性的服务端响应，
 * 不写入存档。任务模块只负责决定何时触发，客户端拿到 session 后选择回复。
 */
import type { Command, CommandResult } from '@slg/shared';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';

export interface DialogueSession {
  id: string;
  code: string;
  taskCode: string;
  trigger: string;
  segment: number;
  segmentCount: number;
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
  /** 同一触发点的有序段落；旧客户端可继续只读取顶层第一段。 */
  segments: DialogueSegment[];
}

export interface DialogueSegment {
  code: string;
  taskCode: string;
  trigger: string;
  segment: number;
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
}

export interface DialogueContext {
  villageName?: string;
  fiefName?: string;
}

/** 对话展示变量只在服务端解析，避免客户端自行猜测玩家归属。 */
function renderTemplate(value: string, context: DialogueContext = {}): string {
  return value
    .replaceAll('{villageName}', context.villageName ?? '当前村庄')
    .replaceAll('{fiefName}', context.fiefName ?? '当前封地');
}

export class DialoguesModule {
  static readonly NAME = 'dialogue';

  constructor(
    private commands: CommandBus,
    private now: () => number,
    private config: GameConfig,
  ) {}

  setConfig(config: GameConfig): void { this.config = config; }

  init(): void {
    this.commands.register('dialogue.StartForTask', (c) => this.startForTask(c));
    this.commands.register('dialogue.StartForTreasure', (c) => this.startForTreasure(c));
  }

  private startForTask(cmd: Command): CommandResult {
    const payload = cmd.payload as { taskCode?: string; trigger?: string } & DialogueContext;
    const taskCode = String(payload.taskCode ?? '').trim();
    const trigger = String(payload.trigger ?? 'accept').trim() || 'accept';
    if (!taskCode) return { ok: false, payload: {}, reason: 'taskCode_required' };
    const defs = Object.values(this.config.dialogues ?? {})
      .filter((item) => item.taskCode === taskCode && item.trigger === trigger)
      .sort((a, b) => a.segment - b.segment);
    // GM 可以先建立空白模板，等策划填文本/对象；空白模板不阻塞任务接取。
    return this.buildSession(defs, payload);
  }

  private startForTreasure(cmd: Command): CommandResult {
    const payload = cmd.payload as { treasureCode?: string } & DialogueContext;
    const treasureCode = String(payload.treasureCode ?? '').trim();
    if (!treasureCode) return { ok: false, payload: {}, reason: 'treasureCode_required' };
    const defs = Object.values(this.config.dialogues ?? {})
      .filter((item) => item.code === `${treasureCode}_use` && item.trigger === 'use')
      .sort((a, b) => a.segment - b.segment);
    return this.buildSession(defs, payload);
  }

  private buildSession(defs: GameConfig['dialogues'][string][], context: DialogueContext = {}): CommandResult {
    const visibleDefs = defs.filter((item) => item.npcName || item.npcText || item.replies.length);
    if (!visibleDefs.length) return { ok: true, payload: { dialogue: null } };
    const first = visibleDefs[0];
    const segments = visibleDefs.map((def): DialogueSegment => ({
      code: def.code,
      taskCode: def.taskCode,
      trigger: def.trigger,
      segment: def.segment,
      npcName: renderTemplate(def.npcName, context),
      npcText: renderTemplate(def.npcText, context),
      replies: def.replies.map((reply) => ({ ...reply })),
    }));
    const session: DialogueSession = {
      id: `dialogue-${first.code}-${Math.floor(this.now())}`,
      code: first.code,
      taskCode: first.taskCode,
      trigger: first.trigger,
      segment: first.segment,
      segmentCount: segments.length,
      npcName: segments[0].npcName,
      npcText: segments[0].npcText,
      replies: segments[0].replies,
      segments,
    };
    return { ok: true, payload: { dialogue: session } };
  }
}
