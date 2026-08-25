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
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
}

/** 对话中的 {villageName} 等展示占位符只在服务端解析，避免客户端自行猜测村庄。 */
function renderVillageTemplate(value: string, villageName?: string): string {
  return value.replaceAll('{villageName}', villageName ?? '当前村庄');
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
  }

  private startForTask(cmd: Command): CommandResult {
    const payload = cmd.payload as { taskCode?: string; trigger?: string; villageName?: string };
    const taskCode = String(payload.taskCode ?? '').trim();
    const trigger = String(payload.trigger ?? 'accept').trim() || 'accept';
    if (!taskCode) return { ok: false, payload: {}, reason: 'taskCode_required' };
    const def = Object.values(this.config.dialogues ?? {})
      .find((item) => item.taskCode === taskCode && item.trigger === trigger);
    // GM 可以先建立空白模板，等策划填文本/对象；空白模板不阻塞任务接取。
    if (!def || (!def.npcName && !def.npcText)) return { ok: true, payload: { dialogue: null } };
    const session: DialogueSession = {
      id: `dialogue-${def.code}-${Math.floor(this.now())}`,
      code: def.code,
      taskCode: def.taskCode,
      trigger: def.trigger,
      npcName: renderVillageTemplate(def.npcName, payload.villageName),
      npcText: renderVillageTemplate(def.npcText, payload.villageName),
      replies: def.replies.map((reply) => ({ ...reply })),
    };
    return { ok: true, payload: { dialogue: session } };
  }
}
