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
    military.createVillage(vid, 'romans');
    treasure.createVillage(vid);

    // 直接注入所有 modifier 到 state
    await commands.send({ name: 'military.SetTreasureCavalryTrainMult', from: 'test', payload: { villageId: vid, mult: 0.5 } });
    await commands.send({ name: 'building.SetBuildSpeedMult', from: 'test', payload: { villageId: vid, mult: 0.5 } });
    await commands.send({ name: 'economy.SetOverflowCap', from: 'test', payload: { villageId: vid, cap: 1.0 } });
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

  it('economy.GetResources: overflowCap + rawRate', async () => {
    const res = await commands.send({ name: 'economy.GetResources', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok);
    const r = res.payload as any;
    assert.equal(r.overflowCap, 1, 'overflowCap');
    assert.ok(r.rawRate, 'rawRate missing');
    assert.ok(typeof r.rawRate.wood === 'number', 'rawRate.wood');
  });

  it.skip('population.GetSnapshot: conscriptionBonus 反映到 mobilizeCap', async () => {
    const res = await commands.send({ name: 'population.GetSnapshot', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok);
    const p = res.payload as any;
    // 罗马基础 0.75 + 0.15 = 0.90，至少大于基础
    assert.ok((p.mobilizeCap ?? 0) > 0.75, `mobilizeCap=${p.mobilizeCap} should > 0.75`);
  });

  it('economy.GetCropContext: overflowRatio', async () => {
    const res = await commands.send({ name: 'economy.GetCropContext', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok);
    const p = res.payload as any;
    assert.ok(typeof p.overflowRatio === 'number', 'overflowRatio');
  });

  it('treasure 精神食粮: 士兵粮耗-1 且 军晌=1 不减', async () => {
    const g = await commands.send({ name: 'treasure.Grant', from: 'test', payload: { villageId: vid, code: 'spiritual_food' } });
    assert.ok(g.ok, `grant spiritual_food failed: ${g.reason}`);
    const res = await commands.send({ name: 'military.GetArmy', from: 'test', payload: { villageId: vid } });
    assert.ok(res.ok, 'GetArmy failed');
    const p = res.payload as any;
    const trainable = p.trainable ?? [];
    const legion = trainable.find((t: any) => t.key === 'legionnaire');
    const equimp = trainable.find((t: any) => t.key === 'equimperatoris');
    assert.ok(legion, 'legionnaire missing');
    assert.ok(equimp, 'equimperatoris missing');
    // 军晌=1（legionnaire, popCost=1）不减：cropPerHourEach 仍为 2（(1+1)*1）
    assert.equal(legion.cropPerHourEach, 2, `legionnaire 军晌=1 应不减（保持 2），实际 ${legion.cropPerHourEach}`);
    // 军晌=3（equimperatoris, popCost=3）每兵粮耗 -1：原 (1+3)*3=12 → 12-1=11（原始 upkeep 不变）
    assert.equal(equimp.upkeep, 3, `equimperatoris 原始 upkeep 应仍为 3，实际 ${equimp.upkeep}`);
    assert.equal(equimp.cropPerHourEach, 11, `equimperatoris 粮耗应 -1（12→11），实际 ${equimp.cropPerHourEach}`);
  });
});
