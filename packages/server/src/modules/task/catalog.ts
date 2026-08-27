/**
 * CSV 任务图的运行时目录。
 *
 * quest_* 六张表是配置唯一事实源；infra/config 将它们编译为兼容旧任务执行器的
 * QuestDef。本目录把图节点、条件/目标/效果/边与兼容投影按任务聚合，避免业务
 * 代码重新在平铺数组上做隐式查询。当前执行器保持单目标兼容语义，不改现有 CSV。
 */
import type {
  GameConfig, QuestConditionDef, QuestDef, QuestEdgeDef, QuestEffectDef,
  QuestGraphQuestDef, QuestObjectiveDef,
} from '../../infra/config.js';

export interface TaskCatalogEntry {
  readonly node: QuestGraphQuestDef;
  readonly legacy: QuestDef;
  readonly conditions: readonly QuestConditionDef[];
  readonly objectives: readonly QuestObjectiveDef[];
  readonly effects: readonly QuestEffectDef[];
  readonly edges: readonly QuestEdgeDef[];
}

export class TaskCatalog {
  private readonly entries: ReadonlyMap<string, TaskCatalogEntry>;

  constructor(config: GameConfig) {
    const entries = new Map<string, TaskCatalogEntry>();
    for (const node of Object.values(config.questGraph.quests)) {
      const legacy = config.quests[node.code];
      if (!legacy) throw new Error(`任务图缺少兼容投影：${node.code}`);
      entries.set(node.code, Object.freeze({
        node,
        legacy,
        conditions: Object.freeze(config.questGraph.conditions.filter((row) => row.questCode === node.code)),
        objectives: Object.freeze(config.questGraph.objectives.filter((row) => row.questCode === node.code)),
        effects: Object.freeze(config.questGraph.effects.filter((row) => row.questCode === node.code)),
        edges: Object.freeze(config.questGraph.edges.filter((row) => row.fromQuest === node.code || row.toQuest === node.code)),
      }));
    }
    this.entries = entries;
  }

  get(code: string): TaskCatalogEntry | undefined {
    return this.entries.get(code);
  }

  legacy(code: string): QuestDef | undefined {
    return this.get(code)?.legacy;
  }

  all(): readonly QuestDef[] {
    return [...this.entries.values()].map((entry) => entry.legacy);
  }
}
