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
import { PlayerModule } from './modules/player.js';

/**
 * 应用组装层：加载配置(CSV) → 拼装基础设施 + 领域模块 → 可运行游戏内核。
 * 所有游戏数据来自 config/*.csv，模块从 GameConfig 读，不硬编码。
 */
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
  player: PlayerModule;
  now: () => number;
  createVillage(villageId: string, x?: number, y?: number, name?: string): void;
  setupWorld(): void;
  /** 重启后恢复所有在途定时任务（建造/训练/行军/重生）。 */
  resume(): void;
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

  // 实际建村的函数（供 Player 注册时调用）
  const doCreateVillage = (villageId: string, x: number, y: number, name: string, tribe = 'romans') => {
    economy.createVillage(villageId);
    building.createVillage(villageId);
    military.createVillage(villageId, tribe);
    void commands.send({ name: 'world.PlaceVillage', from: 'app', payload: { x, y, refId: villageId, name } });
  };
  const player = new PlayerModule(store, bus, commands, now, doCreateVillage);

  economy.init();
  building.init();
  military.init();
  world.init();
  pve.init();
  movement.init();
  player.init();

  return {
    config, store, bus, commands, scheduler,
    economy, building, military, world, pve, movement, player, now,
    createVillage(villageId, x = 0, y = 0, name = '我的村庄') {
      doCreateVillage(villageId, x, y, name, 'romans');
    },
    setupWorld() {
      world.setup(20);
      // PvE 目标点位由 config/pve_spawns.csv 决定
      for (const s of config.pveSpawns) pve.create(s.id, s.type, s.x, s.y);
    },
    resume() {
      building.resume();
      military.resume();
      movement.resume();
      pve.resume();
    },
  };
}
