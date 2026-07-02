import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 全循环端到端测试（假时钟）：经济 → 训练 → 行军打PvE → 掠夺回村。
 * 验证 6 个模块串起来的核心循环（S0 定义的循环）。
 */

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  app.createVillage('v1', 0, 0, '测试村');
  return app;
}
const setClock = (t: number) => (clock = t);
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}
/**
 * 战斗改为有状态逐 tick 推进。Scheduler.fireDue 在一次 advanceTo 内会把"已到期"任务
 * 全部跑完（含 tick 自我重排的后续 tick，因为跳进的时钟已远超它们），所以用**大步**(默认1小时)
 * 快进即可让"整场战斗 + 一段行军"在一次调用内跑完；反复几次直到没有待处理任务，驱动全链路。
 */
async function drain(app: GameApp, bigStepMs = 3_600_000, maxIters = 30000): Promise<void> {
  let iters = 0;
  while (app.scheduler.pending > 0 && iters < maxIters) {
    await app.scheduler.advanceTo(clock + bigStepMs, setClock);
    iters++;
  }
}

test('经济：4资源初始化与惰性产出', async () => {
  const app = freshApp();
  const r = await send(app, 'economy.GetResources', { villageId: 'v1' });
  assert.equal(r.ok, true);
  const res = (r.payload as any).resources;
  for (const t of ['wood', 'clay', 'iron', 'crop']) assert.ok(res[t] > 0, `${t} 应>0`);
});

test('建筑：升级资源田提升产率', async () => {
  const app = freshApp();
  const before = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  // 升级第0块田(woodcutter)
  const up = await send(app, 'building.UpgradeField', { villageId: 'v1', fieldIndex: 0 });
  assert.equal(up.ok, true, `升级田应成功: ${up.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 60_000, setClock);
  const after = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(after.netRate.wood > before.netRate.wood, '木产率应提升');
});

test('军队：训练消耗资源并产兵，军队耗粮上报', async () => {
  const app = freshApp();
  // 训练3个军团兵（需 barracks，但骨架 rallypoint 也有兵种；legionnaire 需 barracks）
  // 先给资源
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const r = await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 2 });
  assert.equal(r.ok, true, `训练应成功: ${r.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 27_000, setClock);
  await app.scheduler.advanceTo(clock + 27_000, setClock);
  const army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.equal(army.troops.legionnaire, 2, '应有2个军团兵');
  // 耗粮已上报：净crop产率应比无兵时低
  const eco = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  assert.ok(eco.cropUpkeep > 0, 'crop消耗应>0（含军队耗粮）');
});

test('完整循环：训练→出征打PvE→掠夺→返程入库', async () => {
  const app = freshApp();
  // 先升仓库提高容量，再多次补给（单次Grant受容量截断）
  await send(app, 'economy.Grant', { villageId: 'v1', gain: { wood: 800, clay: 800, iron: 800, crop: 800 } });

  // 训练 5 个军团兵（成本 wood 600 < 容量800），足以击败老鼠窝
  await send(app, 'military.TrainTroops', { villageId: 'v1', unit: 'legionnaire', count: 5 });
  for (let i = 0; i < 5; i++) await app.scheduler.advanceTo(clock + 27_000, setClock);
  let army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.equal(army.troops.legionnaire, 5);

  // 记录出征前资源
  const beforeRes = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;

  // 派 5 军团兵 raid pve-0 (rats)
  const raid = await send(app, 'movement.SendRaid', {
    villageId: 'v1', fromXY: { q: 0, r: 0 }, targetId: 'pve-0', troops: { legionnaire: 5 },
  });
  assert.equal(raid.ok, true, `出征应成功: ${raid.reason ?? ''}`);

  // 出征后村内无兵
  army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.equal(army.troops.legionnaire ?? 0, 0, '出征后村内应无兵');

  // 收集战斗结束事件（战斗改为有状态逐 tick 推进，到达后开战，结束发 BattleEnded）
  let battleEnded: any = null;
  app.bus.on('combat.BattleEnded', (e) => { if ((e.payload as any).side === 'attacker') battleEnded = e.payload; });

  // 反复小步快进：驱动"到达→逐 tick 战斗→结束→返程"整条链
  await drain(app);
  assert.ok(battleEnded, '应产生战斗结束事件');
  assert.equal(battleEnded.attackerWins, true, '5军团兵应击败老鼠窝');
  assert.ok(Object.keys(battleEnded.looted).length > 0, '应掠夺到资源');

  // 兵已归队（drain 已把返程也跑完）
  army = (await send(app, 'military.GetArmy', { villageId: 'v1' })).payload as any;
  assert.ok((army.troops.legionnaire ?? 0) > 0, '幸存兵应已返回');

  // 资源已增加（掠夺入库）
  const afterRes = (await send(app, 'economy.GetResources', { villageId: 'v1' })).payload as any;
  const gained = afterRes.resources.wood - beforeRes.resources.wood;
  assert.ok(gained > 0 || afterRes.resources.wood >= afterRes.capacity.wood, '木材应因掠夺增加（或已满仓）');
});
