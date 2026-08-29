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
