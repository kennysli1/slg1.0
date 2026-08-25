import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../infra/store.js';
import { EventBus } from '../infra/event-bus.js';
import { CommandBus } from '../infra/command-bus.js';
import { KeyedSerialQueue } from '../infra/keyed-serial-queue.js';
import { Scheduler } from '../infra/scheduler.js';
import { loadGameConfig } from '../infra/config.js';
import { EconomyModule } from '../modules/economy.js';
import { BuildingModule } from '../modules/building.js';
import { MilitaryModule } from '../modules/military.js';
import { PopulationModule } from '../modules/population.js';
import { TreasureModule } from '../modules/treasures.js';
import { WorldModule } from '../modules/world.js';
import { MovementModule } from '../modules/movement.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', '..', '..', '..', 'config');

let now = 1_000_000_000_000;

const config = loadGameConfig(configDir);
const store = new MemoryStore();
const bus = new EventBus();
const commands = new CommandBus();
const serialQueue = new KeyedSerialQueue();
const scheduler = new Scheduler(() => now, true, serialQueue);

const economy = new EconomyModule(store, bus, commands, () => now, config);
const building = new BuildingModule(store, bus, commands, scheduler, () => now, config);
const military = new MilitaryModule(store, bus, commands, scheduler, () => now, config);
const population = new PopulationModule(store, bus, commands, scheduler, () => now, config);
const world = new WorldModule(store, bus, commands, () => now, config);
const movement = new MovementModule(store, bus, commands, scheduler, () => now, config);
const treasure = new TreasureModule(store, bus, commands, scheduler, () => now, config, Math.random);

const vid = 'v-cover';

describe('modifier 覆盖率', () => {
  it('setup 注入所有 modifier', async () => {
    economy.init();
    building.init();
    military.init();
    population.init();
    world.init();
    movement.init();
    treasure.init();
    world.setup(41, 41);
    economy.createVillage(vid);
    building.createVillage(vid, 'romans');
    const raw = store.get<any>('building', vid)!;
    for (const p of raw.placed) {
      if (['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(p.kind)) {
        p.level = 1;
        delete p.repairTargetLevel;
      }
    }
    store.set('building', vid, raw);
    building.reReportProduction(vid);
    military.createVillage(vid, 'romans');
    treasure.createVillage(vid);

    // 直接注入所有真实存在的 modifier 到 state（不含任何虚构命令）
    await commands.send({ name: 'military.SetTreasureCavalryTrainMult', from: 'test', payload: { villageId: vid, mult: 0.5 } });
    await commands.send({ name: 'building.SetBuildSpeedMult', from: 'test', payload: { villageId: vid, mult: 0.5 } });
    await commands.send({ name: 'population.SetConscriptionMult', from: 'test', payload: { villageId: vid, bonus: 0.15 } });
    await commands.send({ name: 'population.SetTechGrowthMult', from: 'test', payload: { villageId: vid, mult: 0.1 } });
    await commands.send({ name: 'economy.SetRateModifier', from: 'test', payload: { villageId: vid, source: 'test', mult: { crop: 0.5 } } });
  });

  it('military.GetArmy: 骑兵 trainSec 含宝物加速', async () => {
    const res = await commands.send({ name: 'military.GetArmy', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok, 'GetArmy failed');
    const p = res.payload as any;
    const trainable = p.trainable ?? [];
    const equ = trainable.find((t: any) => t.key === 'equlegati');
    assert.ok(equ, 'equlegati not in trainable');
    assert.ok(equ.trainSec < 14, `trainSec=${equ.trainSec} should < 14`);
  });

  it('economy.GetResources: SetRateModifier 改变 netRate.crop 且字段真实', async () => {
    const before = await commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
    assert.ok(before.ok, 'GetResources failed');
    const b = before.payload as any;
    // 再叠加一个 crop 速率修正，验证 modifier 真实生效（无 overflowCap / rawRate 等虚构字段）
    await commands.send({ name: 'economy.SetRateModifier', from: 'test', payload: { villageId: vid, source: 'test-extra', mult: { crop: 0.5 } } });
    const after = await commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
    assert.ok(after.ok, 'GetResources#2 failed');
    const a = after.payload as any;
    assert.ok(typeof a.resources === 'object', 'resources');
    assert.ok(typeof a.capacity === 'object', 'capacity');
    assert.ok(typeof a.netRate === 'object', 'netRate');
    assert.ok(typeof a.overCapacity === 'object', 'overCapacity');
    assert.ok(typeof a.productionPaused === 'object', 'productionPaused');
    assert.ok(typeof a.cropUpkeep === 'number', 'cropUpkeep');
    assert.ok(typeof a.netRate.crop === 'number', 'netRate.crop');
    // 速率修正叠加后 crop 净产率应提升
    assert.ok(a.netRate.crop > b.netRate.crop, `crop netRate 应随修正提升: before=${b.netRate.crop} after=${a.netRate.crop}`);
  });

  it.skip('population.GetSnapshot: conscriptionBonus 反映到 mobilizeCap', async () => {
    const res = await commands.send({ name: 'population.GetSnapshot', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok);
    const p = res.payload as any;
    // 罗马基础 0.75 + 0.15 = 0.90，至少大于基础
    assert.ok((p.mobilizeCap ?? 0) > 0.75, `mobilizeCap=${p.mobilizeCap} should > 0.75`);
  });

  it('economy.GetCropContext: 返回真实字段', async () => {
    const res = await commands.send({ name: 'economy.GetCropContext', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok, 'GetCropContext failed');
    const p = res.payload as any;
    assert.ok(typeof p.baseCropPerHour === 'number', 'baseCropPerHour');
    assert.ok(typeof p.buildingUpkeepPerHour === 'number', 'buildingUpkeepPerHour');
    assert.ok(typeof p.troopUpkeepPerHour === 'number', 'troopUpkeepPerHour');
    assert.ok(typeof p.nonCivilianUpkeep === 'number', 'nonCivilianUpkeep');
    assert.ok(typeof p.currentCrop === 'number', 'currentCrop');
    assert.ok(typeof p.cropCapacity === 'number', 'cropCapacity');
  });

  it('treasure money_bag(instantGold): Use 发放金币', async () => {
    // 授予一个真实即时宝物
    const g = await commands.send({ name: 'treasure.Grant', from: 'test', payload: { villageId: vid, code: 'money_bag' } });
    assert.ok(g.ok, `grant money_bag failed: ${g.reason}`);
    const before = await commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
    const use = await commands.send({ name: 'treasure.Use', from: 'test', payload: { villageId: vid, code: 'money_bag' } });
    assert.ok(use.ok, `use money_bag failed: ${use.reason}`);
    const after = await commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
    const delta = after.payload.resources.gold - before.payload.resources.gold;
    assert.ok(delta >= 299, `gold 应约 +300（实际 +${delta}）`);
  });

  it('treasure.Grant 未知 code 返回 unknown_treasure', async () => {
    const g = await commands.send({ name: 'treasure.Grant', from: 'test', payload: { villageId: vid, code: 'nonexistent_treasure' } });
    assert.ok(!g.ok, '未知宝物应失败');
    assert.equal(g.reason, 'unknown_treasure');
  });

  it('treasure spiritual_food(soldierFoodReduce): 每兵减粮绝对值，popCost>1 不减多', async () => {
    // 授予精神食粮（减粮 1）
    const g = await commands.send({ name: 'treasure.Grant', from: 'test', payload: { villageId: vid, code: 'spiritual_food' } });
    assert.ok(g.ok, `grant spiritual_food failed: ${g.reason}`);
    const res = await commands.send({ name: 'military.GetArmy', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok, 'GetArmy failed');
    const trainable = (res.payload as any).trainable ?? [];
    const legion = trainable.find((t: any) => t.key === 'legionnaire');
    const imper = trainable.find((t: any) => t.key === 'equimperatoris');
    assert.ok(legion, 'legionnaire not in trainable');
    assert.ok(imper, 'equimperatoris not in trainable');
    // legionnaire：base(1)+upkeep(1)=2，军晌≤1 不减 → 仍 2
    assert.equal(legion.cropPerHourEach, 2, `legionnaire cropPerHourEach=${legion.cropPerHourEach} 应=2（军晌1不减）`);
    // equimperatoris：popCost=3，原始 (1+3)*3=12，减 1 → 11（不是减 popCost×1=3）
    assert.equal(imper.cropPerHourEach, 11, `equimperatoris cropPerHourEach=${imper.cropPerHourEach} 应=11（减绝对值1，非popCost×1）`);
  });
});
