/**
 * 任务 owner 的持久化状态与旧档归一化。
 *
 * 此文件是 task 集合结构的唯一维护点；任务规则、营地生命周期与投影不得私自
 * 添加/迁移字段，避免同一份存档契约散落在多个 handler 中。
 */
import type { GameConfig } from '../../infra/config.js';
import type { Store } from '../../infra/store.js';

export const TASK_COLLECTION = 'task';

export interface TaskCamp {
  id: string;
  q: number;
  r: number;
  cleared: boolean;
}

export interface TaskInstance {
  code: string;
  lineCode?: string;
  definitionRevision?: string;
  type: 'main' | 'daily' | 'side';
  executionVillageId?: string;
  spawnVillageId?: string;
  acceptedAt: number;
  submitted: Record<string, number>;
  repairedBuildings?: string[];
  camps: TaskCamp[];
  campCleared: number;
  progress: number;
  buildingBaseline?: number;
  buildingInitialSlots?: string[];
  buildingFreedSlots?: string[];
  buildingCountedSlots?: string[];
  buildingBuiltCount?: number;
  qualifiedMovements?: string[];
  qualifiedFlagMovements?: string[];
  readyToDeliver?: boolean;
  failureReady?: boolean;
  spawnAttempts?: number;
  npcVillageId?: string;
  npcXY?: { q: number; r: number };
  npcOrderId?: string;
  npcRes?: string;
  npcAmt?: number;
  npcPending?: boolean;
  awaitingNatalieDecision?: boolean;
  awaitingNatalieCode?: string;
  natalieDecision?: 'store' | 'release';
  taskVillageId?: string;
  taskVillageXY?: { q: number; r: number };
  taskVillageAttackAt?: number;
  taskVillageAttackDispatched?: boolean;
  outcome?: 'success' | 'failure';
}

export interface PendingTaskDialogue {
  id: string;
  taskCode: string;
  trigger: string;
  villageId: string;
  createdAt: number;
}

export interface SerializedDialogueSegment {
  code: string;
  taskCode: string;
  trigger: string;
  segment: number;
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
}

export interface SerializedDialogueSession {
  id: string;
  code: string;
  taskCode: string;
  trigger: string;
  segment: number;
  segmentCount: number;
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
  segments: SerializedDialogueSegment[];
}

export interface TaskState {
  villageId: string;
  completedMain: string[];
  completedSide: string[];
  abandonedSide: string[];
  active: Record<string, TaskInstance>;
  offeredMain: string[];
  offered: string[];
  offeredSide: string[];
  firedTriggers: string[];
  cooldownUntil?: Record<string, number>;
  pendingDialogues?: PendingTaskDialogue[];
  outcomes?: Record<string, 'success' | 'failure'>;
  taskVillages?: Record<string, { id: string; q: number; r: number; name: string }>;
}

export interface TavernInfo {
  level: number;
  refreshSec: number;
  maxTasks: number;
}

export function emptyTaskState(villageId: string): TaskState {
  return {
    villageId, completedMain: [], completedSide: [], abandonedSide: [], active: {},
    offeredMain: [], offered: [], offeredSide: [], firedTriggers: [], pendingDialogues: [], outcomes: {}, taskVillages: {},
  };
}

/**
 * 读取时惰性归一化历史 task 集合。字段与旧 code 的兼容规则保持既有语义，
 * 不引入 SAVE_SCHEMA_VERSION 变更。
 */
export function ensureTaskState(store: Store, villageId: string, config: GameConfig): TaskState {
  let state = store.get<TaskState>(TASK_COLLECTION, villageId);
  if (!state) {
    state = emptyTaskState(villageId);
    store.set(TASK_COLLECTION, villageId, state);
  }
  if (!Array.isArray(state.completedMain)) state.completedMain = [];
  if (!Array.isArray(state.completedSide)) state.completedSide = [];
  if (!Array.isArray(state.abandonedSide)) state.abandonedSide = [];
  if (!state.active || typeof state.active !== 'object') state.active = {};
  if (!Array.isArray(state.offeredMain)) state.offeredMain = [];
  if (!Array.isArray(state.offered)) state.offered = [];
  if (!Array.isArray(state.offeredSide)) state.offeredSide = [];
  if (!Array.isArray(state.firedTriggers)) state.firedTriggers = [];
  if (!Array.isArray(state.pendingDialogues)) state.pendingDialogues = [];
  state.outcomes ??= {};
  state.taskVillages ??= {};

  const legacy = state as TaskState & { completedRandom?: string[] };
  if (Array.isArray(legacy.completedRandom)) {
    for (const code of legacy.completedRandom) {
      if (config.quests[code]?.type === 'side' && !state.completedSide.includes(code)) state.completedSide.push(code);
    }
    delete legacy.completedRandom;
  }
  if (state.offered.some((code) => config.quests[code]?.type === 'side')) {
    const remaining: string[] = [];
    for (const code of state.offered) {
      if (config.quests[code]?.type === 'side') {
        if (!state.offeredSide.includes(code)) state.offeredSide.push(code);
      } else remaining.push(code);
    }
    state.offered = remaining;
  }

  const codeMap: Record<string, string> = {
    r1: 'd1', r2: 'd2', r3: 'd3', r4: 's1',
    villager_request: 's3', investigate_coords: 's4',
  };
  const remap = (code: string) => codeMap[code] ?? code;
  state.completedSide = state.completedSide.map(remap);
  state.abandonedSide = state.abandonedSide.map(remap);
  state.offered = state.offered.map(remap);
  state.offeredMain = state.offeredMain.map(remap);
  state.offeredSide = state.offeredSide.map(remap);
  for (const old of Object.keys(state.active)) {
    const next = remap(old);
    if (next !== old) {
      state.active[next] = { ...state.active[old], code: next, lineCode: config.questGraph.quests[next]?.lineCode };
      delete state.active[old];
    }
  }
  state.cooldownUntil ??= {};
  for (const old of Object.keys(state.cooldownUntil)) {
    const next = remap(old);
    if (next !== old) {
      state.cooldownUntil[next] = state.cooldownUntil[old];
      delete state.cooldownUntil[old];
    }
  }
  return state;
}
