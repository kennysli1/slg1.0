import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { StoredNotification } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';

/**
 * 领域模块 · Notifications（通知/战报持久化）
 *
 * 职责：监听所有需要记录的领域事件，按 villageId 写入 notifications 集合。
 * 每村保留最新 N 条（N = config.constants.notificationsPerVillage）。
 * 客户端登录后拉一次历史，后续实时更新走现有 Push 机制，此模块不产生新 Push。
 *
 * 注意：内部事件名 ≠ 对外推送名（building.Upgraded → BuildingUpgraded 等），
 * 此处存的是对外推送名，与各模块 manifest 的 eventPushMap 保持一致。
 * 若源模块改了推送名，此处也需同步更新。
 */

const COLLECTION = 'notifications';
const MAX_STORED_REPLAY_ROUNDS = 120;

interface VillageNotifications {
  items: StoredNotification[];
  seq: number;
}

/**
 * 战报只保留可复盘的战斗结算与侦察情报。
 * 其他领域事件仍由 gateway 实时推送给各自页面刷新，但不会进入历史报告。
 */
export const EVENT_MAP: Record<string, string> = {
  'combat.BattleEnded':       'BattleEnded',
  'movement.ScoutReport':     'ScoutReport',
};

const REPORT_EVENTS = new Set(Object.values(EVENT_MAP));

export class NotificationsModule {
  static readonly NAME = 'notifications';



  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    private config: GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.compactHistoricalBattleReports();
    this.commands.register('notifications.List', (c) => this.list(c));
    for (const internalName of Object.keys(EVENT_MAP)) {
      this.bus.on(internalName, (e: DomainEvent) => this.record(internalName, e));
    }
  }

  private record(internalName: string, evt: DomainEvent): void {
    const villageId = (evt.payload as any)?.villageId as string | undefined;
    if (!villageId) return;

    const pushEvent = EVENT_MAP[internalName];
    const bucket = this.store.get<VillageNotifications>(COLLECTION, villageId) ?? { items: [], seq: 0 };
    const notification: StoredNotification = {
      id: `nt-${villageId}-${++bucket.seq}`,
      event: pushEvent,
      payload: compactBattlePayload(pushEvent, evt.payload as Record<string, unknown>).payload,
      ts: evt.ts,
    };
    bucket.items.push(notification);
    const cap = this.config.constants.notificationsPerVillage;
    if (bucket.items.length > cap) bucket.items.splice(0, bucket.items.length - cap);
    this.store.set(COLLECTION, villageId, bucket);
  }

  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const bucket = this.compactVillageBucket(villageId);
    return { ok: true, payload: { notifications: bucket?.items ?? [] } };
  }

  /**
   * 兼容旧存档：历史极端战斗曾把最多 20,000 个逐轮快照写进单条通知，
   * 导致登录时 GetNotifications 占住同村串行队列。启动时压缩回放、
   * 清理旧版写入的非战斗/侦察通知，保留战报结算摘要。
   */
  private compactHistoricalBattleReports(): void {
    for (const villageId of this.store.keys(COLLECTION)) this.compactVillageBucket(villageId);
  }

  private compactVillageBucket(villageId: string): VillageNotifications | undefined {
    const bucket = this.store.get<VillageNotifications>(COLLECTION, villageId);
    if (!bucket?.items?.length) return bucket;
    let changed = false;
    const items = bucket.items
      .filter((item) => REPORT_EVENTS.has(item.event))
      .map((item) => {
      const compacted = compactBattlePayload(item.event, item.payload);
      if (!compacted.changed) return item;
      changed = true;
      return { ...item, payload: compacted.payload };
      });
    if (items.length !== bucket.items.length) changed = true;
    if (!changed) return bucket;
    const compactedBucket = { ...bucket, items };
    this.store.set(COLLECTION, villageId, compactedBucket);
    return compactedBucket;
  }
}

function compactBattlePayload(
  event: string,
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; changed: boolean } {
  if (event !== 'BattleEnded' || !Array.isArray(payload.rounds)) return { payload, changed: false };
  const rounds = payload.rounds;
  const lastRound = Number((rounds.at(-1) as { round?: unknown } | undefined)?.round);
  const declaredTotal = Number(payload.totalRounds);
  const totalRounds = Number.isFinite(declaredTotal) && declaredTotal >= rounds.length
    ? Math.floor(declaredTotal)
    : Number.isFinite(lastRound) && lastRound >= rounds.length
      ? Math.floor(lastRound)
      : rounds.length;
  const sampled = sampleReplayRounds(rounds);
  const changed = sampled.length !== rounds.length || declaredTotal !== totalRounds;
  return changed
    ? { payload: { ...payload, totalRounds, rounds: sampled }, changed: true }
    : { payload, changed: false };
}

function sampleReplayRounds<T>(rounds: T[]): T[] {
  if (rounds.length <= MAX_STORED_REPLAY_ROUNDS) return rounds;
  const sampled: T[] = [];
  let previous = -1;
  for (let i = 0; i < MAX_STORED_REPLAY_ROUNDS; i++) {
    const index = Math.round((i * (rounds.length - 1)) / (MAX_STORED_REPLAY_ROUNDS - 1));
    if (index !== previous) sampled.push(rounds[index]);
    previous = index;
  }
  return sampled;
}
