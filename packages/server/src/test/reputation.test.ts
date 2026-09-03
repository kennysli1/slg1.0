import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('声望：新玩家默认为0，调整后返回正负声望及派生效果', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '声望甲', password: 'p1234', tribe: 'romans' });
  const villageId = (reg.payload as any).player.villageId;
  const before = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((before.payload as any).value, 0);
  const adjusted = await send(app, 'reputation.AdjustByVillage', { villageId, delta: 20, reason: 'test' });
  assert.equal(adjusted.ok, true);
  assert.equal((adjusted.payload as any).alignment, 'good');
  assert.equal((adjusted.payload as any).populationGrowthMult, 1.1);
  const pop = await send(app, 'population.GetSnapshot', { villageId });
  assert.equal((pop.payload as any).growthPerHour > 0, true);
});

test('声望：负声望降低人口增长，正声望降低金币税收', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = await send(app, 'player.Register', { name: '声望乙', password: 'p1234', tribe: 'romans' });
  const villageId = (reg.payload as any).player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: -20 });
  const evil = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((evil.payload as any).populationGrowthMult, 0.9);
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: 40 });
  const good = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((good.payload as any).value, 20);
  assert.equal((good.payload as any).goldTaxMult, 0.9);
});

test('声望：不再为军队快照提供额外战斗倍率', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = (await send(app, 'player.Register', { name: '声望军队', password: 'p1234', tribe: 'romans' })).payload as any;
  const villageId = reg.player.villageId;
  await send(app, 'military.AdjustTroops', { villageId, delta: { legionnaire: 1 } });
  const neutral = await send(app, 'military.GetCombatSnapshot', { villageId, units: { legionnaire: 1 } });
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: -20 });
  const evil = await send(app, 'military.GetCombatSnapshot', { villageId, units: { legionnaire: 1 } });
  const before = (neutral.payload as any).snapshot.legionnaire;
  const after = (evil.payload as any).snapshot.legionnaire;
  assert.equal(after.attack, before.attack);
  assert.equal(after.defense, before.defense);
  const rep = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((rep.payload as any).armyAttackBonus, 0.1);
  assert.equal((rep.payload as any).armyDefenseBonus, 0.1);
});

test('声望：正负声望按每十点敌方士兵人口结算击杀奖励并保留余数', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '声望善', password: 'p1234', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '声望恶', password: 'p1234', tribe: 'romans' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId: va, delta: 1 });
  await send(app, 'reputation.AdjustByVillage', { villageId: vb, delta: -11 });
  const half = await send(app, 'reputation.ProcessPvpBattle', { attackerVillageId: va, targetVillageId: vb, defenderLosses: { legionnaire: 5 } });
  assert.equal((half.payload as any).rewarded, false);
  const hit = await send(app, 'reputation.ProcessPvpBattle', { attackerVillageId: va, targetVillageId: vb, defenderLosses: { legionnaire: 5 } });
  assert.equal((hit.payload as any).rewardUnits, 1);
  assert.equal((hit.payload as any).value, 2);
  await send(app, 'reputation.AdjustByVillage', { villageId: va, delta: 10 });
  const evil = await send(app, 'reputation.ProcessPvpBattle', { attackerVillageId: vb, targetVillageId: va, defenderLosses: { legionnaire: 10 } });
  assert.equal((evil.payload as any).value, -12);
});

test('声望：娜塔莉宝物不再被动扣声望，任务线负责结算', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = (await send(app, 'player.Register', { name: '声望丙', password: 'p1234', tribe: 'romans' })).payload as any;
  const villageId = reg.player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId, delta: 2, reason: 's4_release_natalies' });
  const released = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((released.payload as any).value, 2);
  await send(app, 'treasure.Grant', { villageId, code: 'captured_natalies' });
  const stored = await send(app, 'reputation.GetByVillage', { villageId });
  assert.equal((stored.payload as any).value, 2);
});

test('声望：PvP BattleEnded 事件按实际消灭的士兵人口结算', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '声望戊', password: 'p1234', tribe: 'romans' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '声望己', password: 'p1234', tribe: 'romans' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  await send(app, 'reputation.AdjustByVillage', { villageId: va, delta: 1 });
  await send(app, 'reputation.AdjustByVillage', { villageId: vb, delta: -11 });
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: 0, payload: {
    side: 'attacker', targetKind: 'village', targetId: vb, fromVillage: va,
    defenderLossesAttributed: { legionnaire: 10 },
  } } as any);
  const rep = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((rep.payload as any).value, 2);
});

test('声望：王国 PvE 击杀人口按25累计，跨战斗保留余数且不再按侦察/攻击固定扣分', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = (await send(app, 'player.Register', { name: '王国PvE声望', password: 'p1234', tribe: 'romans' })).payload as any;
  const villageId = reg.player.villageId;
  app.pve.create('rep-kingdom-city', 'kingdom_city_state', 4, 4);
  const emitBattle = async (losses: Record<string, number>) => app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: 0, payload: {
    side: 'attacker', targetKind: 'pve', targetId: 'rep-kingdom-city', fromVillage: villageId, defenderLossesAttributed: losses,
  } } as any);
  await emitBattle({ legionnaire: 24 });
  assert.equal((await send(app, 'reputation.GetByVillage', { villageId })).payload.value, 0);
  await emitBattle({ legionnaire: 1 });
  assert.equal((await send(app, 'reputation.GetByVillage', { villageId })).payload.value, -1);
  await emitBattle({ legionnaire: 24 });
  assert.equal((await send(app, 'reputation.GetByVillage', { villageId })).payload.value, -1);
});

test('王国 PvE 声望批次：-10 触发封地掠夺，-20 改为攻城，雇佣军不占玩家驻军', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const reg = (await send(app, 'player.Register', { name: '王国报复', password: 'p1234', tribe: 'romans' })).payload as any;
  const villageId = reg.player.villageId;
  // 每满一个惩罚批次都应检查阈值，但高于 -10 时不能派出复仇军。
  await app.bus.emit({ name: 'reputation.Changed', source: 'test', ts: 0, payload: { playerId: reg.player.id, value: -1, kingdomPvePenaltyChunks: 1 } } as any);
  assert.equal(app.store.all<any>('movement').filter((m) => m.kingdomMercenary).length, 0, '声望 -1 不应触发王国复仇军');
  await app.bus.emit({ name: 'reputation.Changed', source: 'test', ts: 0, payload: { playerId: reg.player.id, value: -10, kingdomPvePenaltyChunks: 1 } } as any);
  const first = app.store.all<any>('movement').find((m) => m.kingdomMercenary);
  assert.ok(first);
  assert.equal(first.battleType, 'raid');
  assert.equal(first.npcService, true);
  assert.ok(String(first.fromVillage).startsWith('kingdom-fief:'));
  assert.equal((await send(app, 'military.GetArmy', { villageId })).ok, true);
  await app.bus.emit({ name: 'reputation.Changed', source: 'test', ts: 0, payload: { playerId: reg.player.id, value: -20, kingdomPvePenaltyChunks: 1 } } as any);
  const all = app.store.all<any>('movement').filter((m) => m.kingdomMercenary);
  assert.ok(all.some((m) => m.battleType === 'siege'));
});
