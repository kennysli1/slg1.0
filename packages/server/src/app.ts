import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventBus } from './infra/event-bus.js';
import { CommandBus } from './infra/command-bus.js';
import { Scheduler } from './infra/scheduler.js';
import { KeyedSerialQueue } from './infra/keyed-serial-queue.js';
import { MemoryStore, JsonFileStore, type Store } from './infra/store.js';
import { loadGameConfig, loadBalanceOverrides, type GameConfig, type BalanceOverrides } from './infra/config.js';
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
import { MercenaryModule } from './modules/mercenary.js';
import { TradeModule } from './modules/trade.js';
import { TreasureModule } from './modules/treasures.js';
import { ResearchModule } from './modules/research.js';
import { TasksModule } from './modules/tasks.js';
import { VisionModule } from './modules/vision.js';
import { DiplomacyModule } from './modules/diplomacy.js';
import { ReputationModule } from './modules/reputation.js';
import { AlchemyModule } from './modules/alchemy.js';

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
  'merc',
  'trade',
  'treasure',
  'treasure_pending',
  'research',
  'task',
  'vision',
  'vision_reveal',
  'diplomacy',
  'reputation',
  'alchemy',
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
  /** 平衡调参覆盖文件路径（持久化在 data/balance_overrides.json，git 忽略）。null 表示关闭覆盖。 */
  balanceOverridePath: string | null;
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
  mercenary: MercenaryModule;
  trade: TradeModule;
  treasure: TreasureModule;
  task: TasksModule;
  vision: VisionModule;
  diplomacy: DiplomacyModule;
  reputation: ReputationModule;
  alchemy: AlchemyModule;
  now: () => number;
  createVillage(villageId: string, q?: number, r?: number, name?: string, initialPop?: number): void | Promise<void>;
  setupWorld(): void;
  /** 启动时用 Player 的村庄快照校准 World 地块，修复旧 GM 直写造成的坐标漂移。 */
  syncWorldVillages(): Promise<{ synced: number; failed: number }>;
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
  /** 平衡调参覆盖文件路径。默认 <storePath 目录>/balance_overrides.json。 */
  balanceOverridePath?: string;
  /** 随机数生成器（默认 Math.random）。测试可注入确定性 RNG 以复现掉落/加权结果。 */
  rng?: () => number;
}): GameApp {
  const now = opts?.now ?? (() => Date.now());
  const configDir = opts?.configDir ?? defaultConfigDir();
  // 平衡覆盖路径：与 game.json 同目录（在 data/ 下，git 忽略，wipe:all 不动）
  const balanceOverridePath = opts?.balanceOverridePath
    ?? (opts?.storePath ? join(dirname(opts.storePath), 'balance_overrides.json') : null);
  // 启动时加载一次覆盖，灌进初始 config
  const initialOverrides = balanceOverridePath ? loadBalanceOverrides(balanceOverridePath) : {};
  let config = loadGameConfig(configDir, initialOverrides);

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
  const diplomacy = new DiplomacyModule(store, bus, commands, now);
  const movement = new MovementModule(store, bus, commands, scheduler, now, config, serialQueue);
  const combat = new CombatModule(store, bus, commands, scheduler, now, config);

  // 实际建村的函数（供 Player 注册时调用）。坐标为六边形轴坐标 (q,r)。
  const doCreateVillage = async (villageId: string, q: number, r: number, name: string, tribe = 'romans', initialPop?: number) => {
    try {
      economy.createVillage(villageId);
      building.createVillage(villageId, tribe);
      military.createVillage(villageId, tribe);
      // population 必须在 economy/building/military 之后创建（需要产率/维护已上报）
      await population.createVillage(villageId, tribe, initialPop);
      treasure.createVillage(villageId);
      alchemy.createVillage(villageId);
      task.createVillage(villageId);
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
      store.delete('treasure', villageId);
      store.delete('alchemy', villageId);
      store.delete('task', villageId);
      throw err;
    }
  };
  const player = new PlayerModule(store, bus, commands, now, config, doCreateVillage, config.constants.worldW, config.constants.worldH, serialQueue, () => world.getOccupiedTileKeys());
  const meta = new MetaModule(commands, config);
  const notifications = new NotificationsModule(store, bus, commands, now, config);
  const mercenary = new MercenaryModule(store, bus, commands, scheduler, now, config);
  const trade = new TradeModule(store, bus, commands, scheduler, now, config);
  const treasure = new TreasureModule(store, bus, commands, scheduler, now, config, opts?.rng ?? Math.random);
  // playerVillages: 轻量跨村查询（任务聚合与 scope=player 科技共用）。
  const playerVillages = (playerId: string): string[] => {
    const owner = store.all<{ id?: string; ownedVillages?: ({ id: string } | string)[] }>('player')
      .find((p) => p.id === playerId);
    return owner?.ownedVillages?.map((v) => typeof v === 'string' ? v : v.id).filter((id): id is string => typeof id === 'string') ?? [];
  };
  const villageOwner = (villageId: string): string | null => {
    return store.get<string>('player_byvillage', villageId) ?? null;
  };
  const task = new TasksModule(store, bus, commands, scheduler, now, config, opts?.rng ?? Math.random, playerVillages, villageOwner);
  const vision = new VisionModule(store, commands, config);
  const research = new ResearchModule(store, bus, commands, scheduler, now, config, playerVillages, (vid) => {
    const owner = store.all<{ id?: string; ownedVillages?: ({ id: string } | string)[] }>('player')
      .find((p) => p.ownedVillages?.some((v) => (typeof v === 'string' ? v : v.id) === vid));
    return owner?.id ?? null;
  });
  const reputation = new ReputationModule(store, bus, commands, now, config);
  const alchemy = new AlchemyModule(store, bus, commands, scheduler, now, config, opts?.rng ?? Math.random);

  /** 单一生命周期清单：新增 owner 后只在此登记一次 init/config；恢复能力按需提供。 */
  const modules = [
    economy, building, military, population, world, pve, diplomacy, movement, combat,
    player, meta, notifications, mercenary, trade, treasure, research, task, vision, reputation, alchemy,
  ] as const;
  const resumableModules = [
    building, military, population, movement, combat, pve,
    mercenary, trade, treasure, research, task, reputation, alchemy,
  ] as const;

  /** 清理单村进度/行军/战斗/地图（放弃分城与删号共用）。 */
  const wipeSingleVillage = (villageId: string): void => {
    for (const prefix of [
      `building:${villageId}`,
      `military:${villageId}`,
      `population:starve:${villageId}`,
      `mercenary:${villageId}`,
      `trade:${villageId}`,
      `research:${villageId}`,
      `task-refresh:${villageId}`,
      `alchemy:${villageId}`,
    ]) {
      scheduler.cancelByOwner(prefix);
    }
    trade.wipeSingleVillage(villageId);
    treasure.wipeSingleVillage(villageId);
    alchemy.wipeSingleVillage(villageId);
    task.wipeSingleVillage(villageId);
    // 通知行军模块：来向该村的进攻/运输/商队应原路返回（见 movement.onVillageRemoved）。
    // 必须在删除行军记录之前发出，并保留「来向本村」的行军，留给 onVillageRemoved→startReturn
    // 就地改写为返程；否则村庄数据被清后行军记录已删，客户端只看到陈旧倒计时且不刷新。
    void bus.emit({
      name: 'world.VillageRemoved', source: 'app', ts: now(),
      payload: { villageId },
    } as any);
    for (const mv of store.all<{ id?: string; fromVillage?: string }>('movement')) {
      if (mv.fromVillage === villageId && mv.id) scheduler.cancelByOwner(`movement:${mv.id}`);
    }
    for (const b of store.all<{ id?: string; targetId?: string; contributions?: Record<string, { fromVillage?: string }> }>('battle')) {
      const involves =
        b.targetId === villageId ||
        Object.values(b.contributions ?? {}).some((c) => c.fromVillage === villageId);
      if (involves && b.id) scheduler.cancelByOwner(`combat:${b.id}`);
    }
    for (const c of ['economy', 'building', 'military', 'population', 'notifications', 'merc', 'trade', 'treasure', 'treasure_pending', 'task', 'alchemy'] as const) {
      store.delete(c, villageId);
    }
    for (const m of store.all<{ id?: string; fromVillage?: string; targetId?: string; targetVillage?: string }>('movement')) {
      // 来向本村的行军（targetVillage===villageId）已触发 world.VillageRemoved 返程，勿删
      if (m.targetVillage === villageId) continue;
      if (m.fromVillage === villageId || m.targetId === villageId) {
        if (m.id) scheduler.cancelByOwner(`movement:${m.id}`);
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

  for (const module of modules) module.init();

  return {
    config, configDir, balanceOverridePath, store, bus, commands, scheduler, serialQueue,
    economy, building, military, population, world, pve, diplomacy, movement, combat, player, meta, notifications, mercenary, trade, treasure, task, vision, reputation, alchemy, now,
    createVillage(villageId, q = 0, r = 0, name = '我的村庄', initialPop?: number) {
      return doCreateVillage(villageId, q, r, name, 'romans', initialPop);
    },
    setupWorld() {
      world.setup(config.constants.worldW, config.constants.worldH);
      // PvE 目标点位由 config/pve_spawns.csv 决定
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
    },
    async syncWorldVillages() {
      let synced = 0, failed = 0;
      for (const raw of store.all<{ ownedVillages?: Array<{ id?: string; q?: number; r?: number; name?: string }> }>('player')) {
        for (const village of raw.ownedVillages ?? []) {
          if (!village.id || !Number.isFinite(Number(village.q)) || !Number.isFinite(Number(village.r))) {
            failed++;
            continue;
          }
          const result = await commands.send({
            name: 'world.MoveVillage',
            from: 'app',
            payload: { refId: village.id, q: village.q, r: village.r, name: village.name },
          });
          if (result.ok) synced++;
          else {
            failed++;
            console.warn(`[world-sync] 村庄 ${village.id} 坐标同步失败：${result.reason ?? 'unknown'}`);
          }
        }
      }
      if (synced > 0) store.flush();
      return { synced, failed };
    },
    resume() {
      for (const module of resumableModules) void module.resume();
    },
    reloadConfig() {
      // 每次热重载都重新读覆盖文件，玩家运行时改的 /gm/balance 立即生效
      const overrides = balanceOverridePath ? loadBalanceOverrides(balanceOverridePath) : {};
      const newConfig = loadGameConfig(configDir, overrides);
      // 把新配置灌给所有领域模块（各模块运行时经 this.config 读取，故替换引用即可生效）
      for (const module of modules) module.setConfig(newConfig);
      // app 的世界重建/新村创建闭包也必须切到新配置，不能继续引用启动时的 config。
      config = newConfig;
      this.config = config;
      player.setVillageWiper(wipeSingleVillage, config.constants.foundAbandonLockSec);
      // 存量村庄即时重报派生值，使 CSV 改动立刻生效（无需刷档）
      for (const b of store.all<{ villageId: string }>('building')) {
        try {
          building.reReportProduction(b.villageId);
          void population.refreshHardCap(b.villageId);
          void treasure.recomputeAndPush(b.villageId);
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
          `mercenary:${villageId}`,
          `trade:${villageId}`,
          `alchemy:${villageId}`,
        ]) {
          scheduler.cancelByOwner(prefix);
        }
        trade.wipeSingleVillage(villageId);
        treasure.wipeSingleVillage(villageId);
        alchemy.wipeSingleVillage(villageId);
        task.wipeSingleVillage(villageId);
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

      const progressByVillage = ['economy', 'building', 'military', 'population', 'notifications', 'merc', 'trade', 'treasure', 'treasure_pending', 'task', 'alchemy'] as const;
      for (const villageId of villageIds) {
        for (const c of progressByVillage) store.delete(c, villageId);
      }
      store.delete('reputation', playerId);
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
