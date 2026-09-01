import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorldPlan } from '../infra/world-generation.js';
import { createGameApp } from '../app.js';

test('王国城邦：世界计划按数量确定性生成且不占用重复格', () => {
  const a = generateWorldPlan(41, 41, 'city-state-test', [], 3);
  const b = generateWorldPlan(41, 41, 'city-state-test', [], 3);
  assert.deepEqual(a, b);
  const cities = a.pveSpawns.filter((p) => p.type === 'kingdom_city_state');
  assert.equal(cities.length, 3);
  assert.equal(new Set(cities.map((p) => `${p.q},${p.r}`)).size, 3);
});

test('王国城邦：四类资源田保底，受损兵力按12–48小时恢复且资源多6小时', async () => {
  let now = 0;
  const app = createGameApp({ manualScheduler: true, now: () => now });
  app.setupWorld();
  const city = app.store.all<any>('pve').find((p) => p.cityState);
  assert.ok(city);
  assert.deepEqual(new Set(city.buildings.filter((b: any) => b.zone === 'outer' && ['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(b.kind)).map((b: any) => b.kind)), new Set(['woodcutter', 'claypit', 'ironmine', 'cropland']));
  const snapshot = await app.commands.send({ name: 'pve.GetDefenderSnapshot', from: 'test', payload: { id: city.id, purpose: 'siege' } });
  const code = Object.keys((snapshot.payload as any).snapshot)[0];
  await app.commands.send({ name: 'pve.ApplyResult', from: 'test', payload: { id: city.id, defenderLosses: { [code]: 1 }, attackerWins: false, looterCarry: 0, battleType: 'siege' } });
  const after = app.store.get<any>('pve', city.id)!;
  assert.ok(after.recovery.troopDurationSec >= app.config.constants.kingdomCityStateRecoveryMinSec);
  assert.ok(after.recovery.troopDurationSec <= app.config.constants.kingdomCityStateRecoveryMaxSec);
  assert.equal(after.recovery.resourceDurationSec, after.recovery.troopDurationSec + app.config.constants.kingdomCityStateRecoveryResourceExtraSec);
  now = after.recovery.troopDurationSec * 1000;
  const recovered = await app.commands.send({ name: 'pve.GetDefenderSnapshot', from: 'test', payload: { id: city.id, purpose: 'siege' } });
  assert.equal((recovered.payload as any).recovery.troopProgress, 1);
});

test('王国城邦：三级兵种数量/兵力范围与种族兵种池生效', () => {
  const cases = [
    { tier: 1 as const, count: 3, min: 0, max: 20, resourceMin: 500, resourceMax: 1500 },
    { tier: 2 as const, count: 4, min: 5, max: 35, resourceMin: 1500, resourceMax: 5000 },
    { tier: 3 as const, count: 5, min: 10, max: 50, resourceMin: 5000, resourceMax: 15000 },
  ];
  for (const item of cases) {
    const app = createGameApp({ manualScheduler: true });
    app.config.constants.kingdomCityStateTierWeights = { 1: item.tier === 1 ? 1 : 0, 2: item.tier === 2 ? 1 : 0, 3: item.tier === 3 ? 1 : 0 };
    const id = `city-tier-${item.tier}`;
    app.pve.create(id, 'kingdom_city_state', 10 + item.tier, 10 + item.tier);
    const city = app.store.get<any>('pve', id);
    assert.equal(city.cityStateTier, item.tier);
    assert.ok(['romans', 'gauls', 'teutons'].includes(city.cityStateTribe));
    assert.equal(Object.keys(city.defender).length, item.count);
    for (const [code, unit] of Object.entries<any>(city.defender)) {
      assert.equal(app.config.units[code].tribe, city.cityStateTribe, `${code} 必须属于 ${city.cityStateTribe}`);
      assert.ok(unit.count >= item.min && unit.count <= item.max, `${code} 数量 ${unit.count} 不在 ${item.min}–${item.max}`);
    }
    for (const resource of ['wood', 'clay', 'iron', 'crop']) assert.ok(city.loot[resource] >= item.resourceMin && city.loot[resource] <= item.resourceMax);
  }
});

test('王国城邦：兵种随机抽取，不强制包含侦察兵', () => {
  const app = createGameApp({ manualScheduler: true });
  app.config.constants.kingdomCityStateTierWeights = { 1: 1, 2: 0, 3: 0 };
  const scoutCodes = new Set(['equlegati', 'pathfinder', 'teuscout']);
  let withScout = 0;
  let withoutScout = 0;
  for (let i = 0; i < 64; i++) {
    const id = `city-random-units-${i}`;
    app.pve.create(id, 'kingdom_city_state', 20 + i, 20 + i);
    const city = app.store.get<any>('pve', id)!;
    if (Object.keys(city.defender).some((code) => scoutCodes.has(code))) withScout++;
    else withoutScout++;
  }
  assert.ok(withScout > 0, '随机池中应有机会抽到侦察兵');
  assert.ok(withoutScout > 0, '随机抽取不应保证每座城邦都有侦察兵');
});

test('王国城邦：侦察快照提供资源与建筑两种模式', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  const city = app.store.all<any>('pve').find((p) => p.cityState);
  assert.ok(city);
  const result = await app.commands.send({ name: 'pve.GetDefenderSnapshot', from: 'test', payload: { id: city.id, purpose: 'scout' } });
  assert.deepEqual((result.payload as any).scoutModes, ['scout_resources', 'scout_buildings']);
  assert.equal((result.payload as any).cityStateTier, city.cityStateTier);
  assert.equal((result.payload as any).cityStateTribe, city.cityStateTribe);
});

test('王国 PvE 高等级档位：四封地统一标准且高于三级城邦，王都更高', () => {
  const app = createGameApp({ manualScheduler: true });
  app.pve.create('test-fief', 'royal_fief_ne', 3, 3);
  app.pve.create('test-capital', 'royal_capital', 8, 8);
  const fief = app.store.get<any>('pve', 'test-fief')!;
  const capital = app.store.get<any>('pve', 'test-capital')!;
  assert.equal(fief.cityState, true);
  assert.equal(fief.kingdomProfile, 'fief');
  assert.equal(capital.kingdomProfile, 'capital');
  assert.equal(fief.cityStateTier, undefined, '封地不应带城邦等级');
  assert.equal(capital.cityStateTier, undefined, '王都不应带城邦等级');
  assert.ok(Object.keys(fief.defender).length >= app.config.constants.kingdomFiefUnitCount);
  assert.ok(Object.keys(capital.defender).length >= Math.min(app.config.constants.kingdomCapitalUnitCount, 8));
  assert.ok(Object.values(fief.loot).reduce((sum: number, value: any) => sum + Number(value), 0) > app.config.constants.kingdomCityStateTier3ResourceMin * 4);
  assert.ok(Object.values(capital.loot).reduce((sum: number, value: any) => sum + Number(value), 0) >= Object.values(fief.loot).reduce((sum: number, value: any) => sum + Number(value), 0));
  assert.equal(new Set(fief.buildings.filter((b: any) => b.zone === 'outer' && ['woodcutter', 'claypit', 'ironmine', 'cropland'].includes(b.kind)).map((b: any) => b.kind)).size, 4);
});

test('王国 PvE 旧存档迁移：普通 PvE 记录升级后封地和王都都提供攻城', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.setupWorld();
  const ids = ['kingdom-capital', 'kingdom-fief-ne', 'kingdom-fief-se', 'kingdom-fief-sw', 'kingdom-fief-nw'];
  for (const id of ids) {
    const target = app.store.get<any>('pve', id);
    assert.ok(target, `${id} 应存在`);
    // 模拟城市目标功能上线前的旧存档：类型仍是 royal_*，但没有 cityState 标记。
    app.store.set('pve', id, { ...target, cityState: false, kingdomProfile: undefined, cityStateGenerationVersion: undefined });
    const tiles = app.store.all<any>('world_tile').filter((tile) => tile.refId === id);
    for (const tile of tiles) app.store.set('world_tile', `${tile.q},${tile.r}`, { ...tile, cityState: false });
  }

  app.pve.resume();
  for (const id of ids) {
    const target = app.store.get<any>('pve', id);
    assert.equal(target?.cityState, true, `${id} 应迁移为王国城市目标`);
    const options = await app.commands.send({ name: 'movement.GetMarchOptions', from: 'test', payload: { villageId: 'test-village', kind: 'pve', refId: id, q: target.q, r: target.r } });
    assert.ok((options.payload as any).modes.some((mode: any) => mode.mode === 'attack'), `${id} 应显示攻城选项`);
  }
});
