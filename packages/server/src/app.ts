import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventBus } from './infra/event-bus.js';
import { CommandBus } from './infra/command-bus.js';
import { Scheduler } from './infra/scheduler.js';
import { KeyedSerialQueue } from './infra/keyed-serial-queue.js';
import { MemoryStore, JsonFileStore, type Store } from './infra/store.js';
import { loadGameConfig, type GameConfig } from './infra/config.js';
import { EconomyModule } from './modules/economy.js';
import { BuildingModule } from './modules/building.js';
import { MilitaryModule } from './modules/military.js';
import { PopulationModule } from './modules/population.js';
import { WorldModule } from './modules/world.js';
import { PveModule } from './modules/pve.js';
import { MovementModule } from './modules/movement.js';
import { CombatModule } from './modules/combat.js';
import { PlayerModule } from './modules/player.js';
import { MetaModule } from './modules/meta.js';
import { NotificationsModule } from './modules/notifications.js';

/**
 * 应用组装层：加载配置(CSV) → 拼装基础设施 + 领域模块 → 可运行游戏内核。
 * 所有游戏数据来自 config/*.csv，模块从 GameConfig 读，不硬编码。
 */

/**
 * 游戏进度类集合：刷档时清空这些，玩家账号（player*）视模式决定是否保留。
 * 新增有状态模块时，若其数据属于「一局游戏进度」而非「账号」，务必在此登记。
 */
const PROGRESS_COLLECTIONS = [
  'economy',
  'building',
  'military',
  'population',
  'movement',
  'movement_seq',
  'battle',
  'battle_seq',
  'pve',
  'world_meta',
  'world_tile',
  'notifications',
] as const;

/** 账号类集合：wipe:all 时才清空。 */
const ACCOUNT_COLLECTIONS = [
  'player',
  'player_byname',
  'player_byvillage',
  'player_seq',
] as const;

export interface GameApp {
  config: GameConfig;
  /** 启动时使用的配置目录（config/*.csv 所在），热重载与平衡调参写回都基于它。 */
  configDir: string;
  store: Store;
  bus: EventBus;
  commands: CommandBus;
  scheduler: Scheduler;
  /**
   * 全局共享串行队列。Gateway 用 "village:<id>" 串行化 WS 写请求，
   * Scheduler 带 serializationKey 的任务通过同一实例执行，确保同村任务与
   * WS 请求严格 FIFO，消除定时器与请求之间的写竞争。
   */
  serialQueue: KeyedSerialQueue;
  economy: EconomyModule;
  building: BuildingModule;
  military: MilitaryModule;
  population: PopulationModule;
  world: WorldModule;
  pve: PveModule;
  movement: MovementModule;
  combat: CombatModule;
  player: PlayerModule;
  meta: MetaModule;
  notifications: NotificationsModule;
  now: () => number;
  createVillage(villageId: string, q?: number, r?: number, name?: string): void | Promise<void>;
  setupWorld(): void;
  /** 重启后恢复所有在途定时任务（建造/训练/行军/重生）。 */
  resume(): void;
  /**
   * 热重载配置：重新从 configDir 读取全部 CSV（经校验），赋值给所有领域模块，
   * 并让存量村庄即时重报派生值（资源田产率/仓储容量/人口硬上限），
   * 使 GM 平衡调参的改动无需刷档即对所有在线村庄生效。
   * 返回新加载的 GameConfig。
   */
  reloadConfig(): GameConfig;
  /**
   * 刷档：清空游戏进度并重建世界。三种粒度：
   *  - {keepAccounts:true,  reassignSpots:false} 新赛季：留账号+地图位置，进度归零
   *  - {keepAccounts:true,  reassignSpots:true}  重排：留登录凭据，重新分配地图位置
   *  - {keepAccounts:false}                      删档：连账号一起清空
   * 返回受影响的账号数（keepAccounts=false 时为被清空的账号数）。
   */
  resetWorld(opts: { keepAccounts: boolean; reassignSpots?: boolean }): { accounts: number };
  /**
   * 删除单个玩家账号及其所有游戏进度（经济/建筑/兵力/地图等）。
   * 返回被删除的主城 villageId + 全部 villageIds；若玩家不存在返回 null。
   */
  deletePlayer(playerId: string): { villageId: string; villageIds: string[] } | null;
}

/** 默认 config 目录：仓库根的 config/（相对编译后/源码位置回溯到 packages/server 再上两级）。 */
function defaultConfigDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../packages/server/src 或 dist
  return join(here, '../../../config');
}

export function createGameApp(opts?: {
  now?: () => number;
  manualScheduler?: boolean;
  configDir?: string;
  /** 数据落盘路径。给了就用 JSON 文件持久化；不给用内存（测试）。 */
  storePath?: string;
}): GameApp {
  const now = opts?.now ?? (() => Date.now());
  const configDir = opts?.configDir ?? defaultConfigDir();
  const config = loadGameConfig(configDir);

  const store: Store = opts?.storePath ? new JsonFileStore(opts.storePath) : new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const serialQueue = new KeyedSerialQueue();
  const scheduler = new Scheduler(now, opts?.manualScheduler ?? false, serialQueue);

  const economy = new EconomyModule(store, bus, commands, now, config);
  const building = new BuildingModule(store, bus, commands, scheduler, now, config);
  const military = new MilitaryModule(store, bus, commands, scheduler, now, config);
  const population = new PopulationModule(store, bus, commands, scheduler, now, config);
  const world = new WorldModule(store, bus, commands, now, config);
  const pve = new PveModule(store, bus, commands, scheduler, now, config);
  const movement = new MovementModule(store, bus, commands, scheduler, now, config);
  const combat = new CombatModule(store, bus, commands, scheduler, now, config);

  // 实际建村的函数（供 Player 注册时调用）。坐标为六边形轴坐标 (q,r)。
  const doCreateVillage = async (villageId: string, q: number, r: number, name: string, tribe = 'romans') => {
    try {
      economy.createVillage(villageId);
      building.createVillage(villageId, tribe);
      military.createVillage(villageId, tribe);
      // population 必须在 economy/building/military 之后创建（需要产率/维护已上报）
      await population.createVillage(villageId, tribe);
      const placeRes = await commands.send({
        name: 'world.PlaceVillage', from: 'app',
        payload: { q, r, refId: villageId, name },
      });
      if (!placeRes.ok) throw new Error(`world.PlaceVillage failed: ${placeRes.reason ?? 'unknown'}`);
    } catch (err) {
      // 回滚：清除已写入的进度集合，避免孤儿记录
      store.delete('economy', villageId);
      store.delete('building', villageId);
      store.delete('military', villageId);
      store.delete('population', villageId);
      throw err;
    }
  };
  const player = new PlayerModule(store, bus, commands, now, doCreateVillage, config.constants.worldW, config.constants.worldH, serialQueue);
  const meta = new MetaModule(commands, config);
  const notifications = new NotificationsModule(store, bus, commands, now, config);

  /** 清理单村进度/行军/战斗/地图（放弃分城与删号共用）。 */
  const wipeSingleVillage = (villageId: string): void => {
    for (const prefix of [
      `building:${villageId}`,
      `military:${villageId}`,
      `population:starve:${villageId}`,
    ]) {
      scheduler.cancelByOwner(prefix);
    }
    for (const mv of store.all<{ id?: string; fromVillage?: string }>('movement')) {
      if (mv.fromVillage === villageId && mv.id) scheduler.cancelByOwner(`movement:${mv.id}`);
    }
    for (const b of store.all<{ id?: string; targetId?: string; contributions?: Record<string, { fromVillage?: string }> }>('battle')) {
      const involves =
        b.targetId === villageId ||
        Object.values(b.contributions ?? {}).some((c) => c.fromVillage === villageId);
      if (involves && b.id) scheduler.cancelByOwner(`combat:${b.id}`);
    }
    for (const c of ['economy', 'building', 'military', 'population', 'notifications'] as const) {
      store.delete(c, villageId);
    }
    for (const m of store.all<{ id?: string; fromVillage?: string; targetId?: string; targetVillage?: string }>('movement')) {
      if (m.fromVillage === villageId || m.targetId === villageId || m.targetVillage === villageId) {
        store.delete('movement', (m as any).id ?? '');
      }
    }
    for (const b of store.all<{ id?: string; targetId?: string; contributions?: Record<string, { fromVillage?: string }> }>('battle')) {
      const involves =
        b.targetId === villageId ||
        Object.values(b.contributions ?? {}).some((c) => c.fromVillage === villageId);
      if (involves) store.delete('battle', b.id ?? '');
    }
    for (const t of store.all<{ refId?: string; q: number; r: number; kind?: string }>('world_tile')) {
      if (t.kind === 'village' && t.refId === villageId) {
        store.set('world_tile', `${t.q},${t.r}`, { q: t.q, r: t.r, kind: 'empty' });
      }
    }
  };
  player.setVillageWiper(wipeSingleVillage, config.constants.foundAbandonLockSec);

  economy.init();
  building.init();
  military.init();
  population.init();
  world.init();
  pve.init();
  movement.init();
  combat.init();
  player.init();
  meta.init();
  notifications.init();

  return {
    config, configDir, store, bus, commands, scheduler, serialQueue,
    economy, building, military, population, world, pve, movement, combat, player, meta, notifications, now,
    createVillage(villageId, q = 0, r = 0, name = '我的村庄') {
      return doCreateVillage(villageId, q, r, name, 'romans');
    },
    setupWorld() {
      world.setup(config.constants.worldW, config.constants.worldH);
      // PvE 目标点位由 config/pve_spawns.csv 决定
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
    },
    resume() {
      building.resume();
      military.resume();
      population.resume();
      movement.resume();
      combat.resume();
      pve.resume();
    },
    reloadConfig() {
      const newConfig = loadGameConfig(configDir);
      // 把新配置灌给所有领域模块（各模块运行时经 this.config 读取，故替换引用即可生效）
      economy.setConfig(newConfig);
      building.setConfig(newConfig);
      military.setConfig(newConfig);
      population.setConfig(newConfig);
      world.setConfig(newConfig);
      pve.setConfig(newConfig);
      movement.setConfig(newConfig);
      combat.setConfig(newConfig);
      meta.setConfig(newConfig);
      notifications.setConfig(newConfig);
      this.config = newConfig;
      // 存量村庄即时重报派生值，使 CSV 改动立刻生效（无需刷档）
      for (const b of store.all<{ villageId: string }>('building')) {
        try {
          building.reReportProduction(b.villageId);
          void population.refreshHardCap(b.villageId);
        } catch (err) {
          console.warn('[reloadConfig] 村庄 ' + b.villageId + ' 重报派生值失败:', err);
        }
      }
      return newConfig;
    },
    resetWorld({ keepAccounts, reassignSpots = false }) {
      // 0. 先清空调度器：取消所有待处理定时任务，避免刷档后遗留任务触发旧逻辑。
      scheduler.reset();
      serialQueue.reset();

      // 1. 清空所有游戏进度集合。
      for (const c of PROGRESS_COLLECTIONS) store.clear(c);

      // 2. 不保留账号 → 连账号集合一起清，回到零玩家状态，重建世界骨架。
      if (!keepAccounts) {
        const n = store.all('player').length;
        for (const c of ACCOUNT_COLLECTIONS) store.clear(c);
        world.setup(config.constants.worldW, config.constants.worldH);
        for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
        return { accounts: n };
      }

      // 3. 保留账号：重建世界（地图 + PvE），再为每个账号重建村庄。
      world.setup(config.constants.worldW, config.constants.worldH);
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
      player.rebuildVillages(reassignSpots);
      return { accounts: store.all('player').length };
    },
    deletePlayer(playerId) {
      const p = store.get<{
        villageId?: string;
        capitalVillageId?: string;
        name: string;
        ownedVillages?: { id: string }[];
      }>('player', playerId);
      if (!p) return null;
      const { name } = p;
      const villageIds = p.ownedVillages?.length
        ? p.ownedVillages.map((v) => v.id)
        : (p.villageId ? [p.villageId] : []);
      const capitalId = p.capitalVillageId ?? p.villageId ?? villageIds[0] ?? '';
      const villageSet = new Set(villageIds);

      for (const villageId of villageIds) {
        for (const prefix of [
          `building:${villageId}`,
          `military:${villageId}`,
          `population:starve:${villageId}`,
        ]) {
          scheduler.cancelByOwner(prefix);
        }
      }
      for (const mv of store.all<{ id?: string; fromVillage?: string }>('movement')) {
        if (mv.fromVillage && villageSet.has(mv.fromVillage) && mv.id) {
          scheduler.cancelByOwner(`movement:${mv.id}`);
        }
      }
      for (const b of store.all<{ id?: string; targetId?: string; contributions?: Record<string, { fromVillage?: string }> }>('battle')) {
        const involves =
          (b.targetId && villageSet.has(b.targetId)) ||
          Object.values(b.contributions ?? {}).some((c) => c.fromVillage && villageSet.has(c.fromVillage));
        if (involves && b.id) scheduler.cancelByOwner(`combat:${b.id}`);
      }

      store.delete('player', playerId);
      store.delete('player_byname', name);
      for (const villageId of villageIds) store.delete('player_byvillage', villageId);

      const progressByVillage = ['economy', 'building', 'military', 'population', 'notifications'] as const;
      for (const villageId of villageIds) {
        for (const c of progressByVillage) store.delete(c, villageId);
      }
      for (const m of store.all<{ id?: string; fromVillage?: string; targetId?: string; targetVillage?: string }>('movement')) {
        if (
          (m.fromVillage && villageSet.has(m.fromVillage)) ||
          (m.targetId && villageSet.has(m.targetId)) ||
          (m.targetVillage && villageSet.has(m.targetVillage))
        ) {
          store.delete('movement', (m as any).id ?? '');
        }
      }
      for (const b of store.all<{ id?: string; targetId?: string; contributions?: Record<string, { fromVillage?: string }> }>('battle')) {
        const involves =
          (b.targetId && villageSet.has(b.targetId)) ||
          Object.values(b.contributions ?? {}).some((c) => c.fromVillage && villageSet.has(c.fromVillage));
        if (involves) store.delete('battle', b.id ?? '');
      }
      for (const t of store.all<{ refId?: string; q: number; r: number }>('world_tile')) {
        if (t.refId && villageSet.has(t.refId)) {
          store.set('world_tile', `${t.q},${t.r}`, { q: t.q, r: t.r, kind: 'empty' });
        }
      }
      return { villageId: capitalId, villageIds };
    },
  };
}
