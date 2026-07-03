import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventBus } from './infra/event-bus.js';
import { CommandBus } from './infra/command-bus.js';
import { Scheduler } from './infra/scheduler.js';
import { MemoryStore, JsonFileStore, type Store } from './infra/store.js';
import { loadGameConfig, type GameConfig } from './infra/config.js';
import { EconomyModule } from './modules/economy.js';
import { BuildingModule } from './modules/building.js';
import { MilitaryModule } from './modules/military.js';
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
  store: Store;
  bus: EventBus;
  commands: CommandBus;
  scheduler: Scheduler;
  economy: EconomyModule;
  building: BuildingModule;
  military: MilitaryModule;
  world: WorldModule;
  pve: PveModule;
  movement: MovementModule;
  combat: CombatModule;
  player: PlayerModule;
  meta: MetaModule;
  notifications: NotificationsModule;
  now: () => number;
  createVillage(villageId: string, q?: number, r?: number, name?: string): void;
  setupWorld(): void;
  /** 重启后恢复所有在途定时任务（建造/训练/行军/重生）。 */
  resume(): void;
  /**
   * 刷档：清空游戏进度并重建世界。三种粒度：
   *  - {keepAccounts:true,  reassignSpots:false} 新赛季：留账号+地图位置，进度归零
   *  - {keepAccounts:true,  reassignSpots:true}  重排：留登录凭据，重新分配地图位置
   *  - {keepAccounts:false}                      删档：连账号一起清空
   * 返回受影响的账号数（keepAccounts=false 时为被清空的账号数）。
   */
  resetWorld(opts: { keepAccounts: boolean; reassignSpots?: boolean }): { accounts: number };
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
  const config = loadGameConfig(opts?.configDir ?? defaultConfigDir());

  const store: Store = opts?.storePath ? new JsonFileStore(opts.storePath) : new MemoryStore();
  const bus = new EventBus();
  const commands = new CommandBus();
  const scheduler = new Scheduler(now, opts?.manualScheduler ?? false);

  const economy = new EconomyModule(store, bus, commands, now, config);
  const building = new BuildingModule(store, bus, commands, scheduler, now, config);
  const military = new MilitaryModule(store, bus, commands, scheduler, now, config);
  const world = new WorldModule(store, bus, commands, now);
  const pve = new PveModule(store, bus, commands, scheduler, now, config);
  const movement = new MovementModule(store, bus, commands, scheduler, now, config);
  const combat = new CombatModule(store, bus, commands, scheduler, now, config);

  // 实际建村的函数（供 Player 注册时调用）。坐标为六边形轴坐标 (q,r)。
  const doCreateVillage = (villageId: string, q: number, r: number, name: string, tribe = 'romans') => {
    economy.createVillage(villageId);
    building.createVillage(villageId, tribe);
    military.createVillage(villageId, tribe);
    void commands.send({ name: 'world.PlaceVillage', from: 'app', payload: { q, r, refId: villageId, name } });
  };
  const player = new PlayerModule(store, bus, commands, now, doCreateVillage, config.constants.mapSize);
  const meta = new MetaModule(commands, config);
  const notifications = new NotificationsModule(store, bus, commands, now, config);

  economy.init();
  building.init();
  military.init();
  world.init();
  pve.init();
  movement.init();
  combat.init();
  player.init();
  meta.init();
  notifications.init();

  return {
    config, store, bus, commands, scheduler,
    economy, building, military, world, pve, movement, combat, player, meta, notifications, now,
    createVillage(villageId, q = 0, r = 0, name = '我的村庄') {
      doCreateVillage(villageId, q, r, name, 'romans');
    },
    setupWorld() {
      world.setup(config.constants.mapSize);
      // PvE 目标点位由 config/pve_spawns.csv 决定
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
    },
    resume() {
      building.resume();
      military.resume();
      movement.resume();
      combat.resume();
      pve.resume();
    },
    resetWorld({ keepAccounts, reassignSpots = false }) {
      // 1. 清空所有游戏进度集合。
      for (const c of PROGRESS_COLLECTIONS) store.clear(c);

      // 2. 不保留账号 → 连账号集合一起清，回到零玩家状态。
      if (!keepAccounts) {
        const n = store.all('player').length;
        for (const c of ACCOUNT_COLLECTIONS) store.clear(c);
        return { accounts: n };
      }

      // 3. 保留账号：重建世界（地图 + PvE），再为每个账号重建村庄。
      world.setup(config.constants.mapSize);
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.q, s.r);
      player.rebuildVillages(reassignSpots);
      return { accounts: store.all('player').length };
    },
  };
}
