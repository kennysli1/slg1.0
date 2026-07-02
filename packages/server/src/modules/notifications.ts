import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { StoredNotification } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

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

interface VillageNotifications {
  items: StoredNotification[];
  seq: number;
}

/** 内部事件名 → 对外推送名的映射（与各模块 MANIFEST.eventPushMap 保持一致）。 */
const EVENT_MAP: Record<string, string> = {
  'combat.BattleEnded':       'BattleEnded',
  'combat.BattleStarted':     'BattleStarted',
  'building.Upgraded':        'BuildingUpgraded',
  'military.TroopTrained':    'TroopTrained',
  'movement.Sent':            'MarchSent',
  'movement.Returned':        'MarchReturned',
  'movement.IncomingAttack':  'IncomingAttack',
  'movement.Intercepted':     'MarchIntercepted',
};

export class NotificationsModule {
  static readonly NAME = 'notifications';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'notifications',
    publicActions: {
      GetNotifications: { command: 'notifications.List', ownVillage: true, needAuth: true },
    },
    eventPushMap: {},
  };

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    private config: GameConfig,
  ) {}

  init(): void {
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
      payload: evt.payload as Record<string, unknown>,
      ts: evt.ts,
    };
    bucket.items.push(notification);
    const cap = this.config.constants.notificationsPerVillage;
    if (bucket.items.length > cap) bucket.items.splice(0, bucket.items.length - cap);
    this.store.set(COLLECTION, villageId, bucket);
  }

  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const bucket = this.store.get<VillageNotifications>(COLLECTION, villageId);
    return { ok: true, payload: { notifications: bucket?.items ?? [] } };
  }
}
