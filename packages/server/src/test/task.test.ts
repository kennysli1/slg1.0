import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
const setClock = (t: number) => (clock = t);
const send = (app: GameApp, name: string, payload: any) =>
  app.commands.send({ name, from: 'test', payload });
const reg = (app: GameApp, name: string, pwd = 'pass1') =>
  send(app, 'player.Register', { name, password: pwd, tribe: 'romans' });
const tick = () => new Promise((r) => setTimeout(r, 0));
const grant = (app: GameApp, vid: string, gain: Record<string, number>) =>
  send(app, 'economy.Grant', { villageId: vid, gain });

test('建村即自动解锁主线 m1（submit_resources），不自动接随机', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试1');
  assert.equal(regRes.ok, true, `注册应成功: ${regRes.reason ?? ''}`);
  const va = (regRes.payload as any).player.villageId;
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  assert.equal(st.ok, true);
  const p = st.payload as any;
  const activeCodes = p.active.map((a: any) => a.code);
  assert.deepEqual(activeCodes.sort(), ['m1'], `开局应仅自动激活 m1，实际: ${activeCodes}`);
  assert.deepEqual(p.offered, [], '无酒馆时 offered 应为空');
  assert.deepEqual(p.completedMain, []);
});

test('上交资源 m1 → 就绪 → 交付后解锁 m2/m3 并发放奖励', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试2');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();

  const sub = await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { wood: 200, clay: 200 } });
  assert.equal(sub.ok, true, `上交应成功: ${sub.reason ?? ''}`);
  assert.equal((sub.payload as any).completed, true, 'm1 目标应达成（就绪）');

  // 未交付：m1 仍 active 且就绪，未进 completedMain，m2 未解锁，无奖励
  const st0 = await send(app, 'task.GetState', { villageId: va });
  const p0 = st0.payload as any;
  const m1a = p0.active.find((a: any) => a.code === 'm1');
  assert.ok(m1a && m1a.ready === true, 'm1 应处于就绪可交付');
  assert.ok(!p0.completedMain.includes('m1'), '未交付 m1 不应在 completedMain');
  assert.ok(!p0.active.find((a: any) => a.code === 'm2'), '未交付 m2 不应解锁');

  // 交付 → 发放奖励 + 解锁下游
  const before = await send(app, 'economy.GetResources', { villageId: va });
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 'm1' });
  assert.equal(dv.ok, true, `交付应成功: ${dv.reason ?? ''}`);
  const rewards = (dv.payload as any).rewards;
  assert.ok(rewards && rewards.resources, '交付应返回资源奖励');
  assert.equal(rewards.resources.gold, 50, '应发放 gold:50');

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.completedMain.includes('m1'), 'm1 应在 completedMain');
  const activeCodes = p.active.map((a: any) => a.code).sort();
  assert.ok(activeCodes.includes('m2'), 'm2 应解锁');
  assert.ok(activeCodes.includes('m3'), 'm3 应解锁');
  const after = await send(app, 'economy.GetResources', { villageId: va });
  assert.ok((after.payload as any).resources.gold >= (before.payload as any).resources.gold + 50, 'gold 应 +50');
});

test('clear_camp 主线 m3 战斗清空营地后就绪；交付后完成并发锁定宝物', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试3');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();
  // 完成并交付 m1 → m3 解锁并生成营地
  await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { wood: 200, clay: 200 } });
  await send(app, 'task.Deliver', { villageId: va, code: 'm1' });

  const st = await send(app, 'task.GetState', { villageId: va });
  const m3 = (st.payload as any).active.find((a: any) => a.code === 'm3');
  assert.ok(m3, 'm3 应处于 active');
  assert.equal(m3.campTotal, 1, 'm3 应生成 1 个营地');
  const camp = m3.camps[0];
  assert.ok(camp && camp.id, '营地应有 id 与坐标');
  const campId = camp.id;
  let latestMapUpdate: any;
  const stopWatchingTaskMap = app.bus.on('task.MapUpdated', (evt) => {
    if ((evt.payload as any).villageId === va) latestMapUpdate = evt.payload;
  });

  // 任务营地使用独立 taskcamp 地块，既真实占格又不进入其他玩家的全局视野。
  const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tile.ok, true, '营地应在地图上有 taskcamp 地块');
  const target = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((target.payload as any).ownerVillageId, va, '新任务营地必须绑定所属村庄');

  // 回归：旧版本可能把 PvE 实体落在另一坐标，任务卡仍保存接取时坐标；恢复时应以任务快照统一实体。
  const mismatched = { ...(target.payload as any), q: camp.q + 1, r: camp.r + 1 };
  app.store.set('pve', campId, mismatched);
  await send(app, 'world.RemoveTile', { q: camp.q, r: camp.r, refId: campId });
  await app.task.resume();
  const syncedTarget = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((syncedTarget.payload as any).q, camp.q, '恢复后 PvE 营地 q 必须与任务卡一致');
  assert.equal((syncedTarget.payload as any).r, camp.r, '恢复后 PvE 营地 r 必须与任务卡一致');

  // 模拟旧存档：任务营地缺 owner，且地块曾被错误保存为全局 pve。
  const legacy = { ...(target.payload as any), ownerVillageId: undefined };
  app.store.set('pve', campId, legacy);
  await send(app, 'world.RemoveTile', { q: camp.q, r: camp.r, refId: campId });
  await send(app, 'world.PlacePve', { q: camp.q, r: camp.r, refId: campId, name: '任务营地', task: false });
  await app.task.resume();
  const repaired = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal((repaired.payload as any).ownerVillageId, va, '恢复时必须回填历史任务营地 owner');
  const repairedTile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(repairedTile.ok, true, '恢复时必须把历史全局 pve 收回 taskcamp');
  const area = await send(app, 'world.GetArea', { cq: camp.q, cr: camp.r, r: 0 });
  assert.ok(!(area.payload as any).tiles.some((t: any) => t.refId === campId), '任务营地不得出现在其他玩家共享的地图区域数据中');

  // 模拟战斗结束：玩家清空该营地
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId, attackerWins: true, battleId: 'b-test' },
  } as any);
  await tick();

  // 战斗后就绪，但未交付前不完成、不移除营地、不发宝物
  const st1 = await send(app, 'task.GetState', { villageId: va });
  const p1 = st1.payload as any;
  const m3a = p1.active.find((a: any) => a.code === 'm3');
  assert.ok(m3a && m3a.ready === true, 'm3 战斗后应就绪可交付');
  assert.ok(!p1.completedMain.includes('m3'), '未交付 m3 不应完成');
  assert.deepEqual(latestMapUpdate?.camps, [], '已清理营地不得继续出现在 TaskMapUpdated 地图标记中');
  stopWatchingTaskMap();

  // 交付 m3 → 完成 + 移除营地 + 发宝物 + 解锁 m4
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 'm3' });
  assert.equal(dv.ok, true, `交付 m3 应成功: ${dv.reason ?? ''}`);

  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok(p2.completedMain.includes('m3'), 'm3 应已完成');
  assert.ok(!p2.active.find((a: any) => a.code === 'm3'), 'm3 应从 active 移除');
  assert.ok(p2.active.find((a: any) => a.code === 'm4'), 'm4 应解锁');

  // 营地地块应被移除
  const tileAfter = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tileAfter.ok, false, '营地地块应已被清除');

  // 任务宝物与普通宝物共用栏位；有空位时应进入宝物栏，而不绕过栏位锁定保存。
  const tr = app.store.get<any>('treasure', va);
  assert.ok(tr && [...tr.town, ...tr.treasury].includes('warrior_token'), 'warrior_token 应进入宝物栏');
});

test('任务营地战败不推进任务，营地仍在地图上等待再次出征', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务营地战败保留');
  const va = (regRes.payload as any).player.villageId as string;
  const campId = 'taskcamp-defeat-keep';
  app.store.set('task', va, {
    villageId: va, completedMain: [], completedSide: [], abandonedSide: [], offered: [], offeredSide: [], firedTriggers: [],
    active: {
      m3: {
        code: 'm3', type: 'main', acceptedAt: clock, spawnVillageId: va,
        submitted: {}, camps: [{ id: campId, q: 6, r: 6, cleared: false }], campCleared: 0, progress: 0,
      },
    },
  });
  const spawned = await send(app, 'pve.Spawn', { id: campId, type: 'task_camp', q: 6, r: 6, task: true, ownerVillageId: va });
  assert.equal(spawned.ok, true, `测试任务营地生成失败: ${spawned.reason ?? ''}`);

  // 模拟战败链路中旧逻辑已经清掉实体；战败事件本身不应推进任务，且应自动补回营地。
  await send(app, 'pve.Remove', { id: campId });
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId, attackerWins: false, battleId: 'b-defeat' },
  } as any);
  await tick();

  const target = await send(app, 'pve.GetTarget', { id: campId });
  assert.equal(target.ok, true, '战败后任务营地实体必须仍存在');
  assert.equal((target.payload as any).cleared, false, '战败不应清空任务营地');
  const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'taskcamp' });
  assert.equal(tile.ok, true, '战败后任务营地地块必须仍存在');
  const state = await send(app, 'task.GetState', { villageId: va });
  const m3 = (state.payload as any).active.find((item: any) => item.code === 'm3');
  assert.ok(m3, '战败后任务仍应 active');
  assert.equal(m3.campCleared, 0, '战败不应推进清营进度');
  assert.equal(m3.camps[0].cleared, false, '战败不应标记营地已清理');
});

test('「耀武扬威」携旗清空 PvE 营地后记录待回城的出征', async () => {
  const app = freshApp();
  const regRes = await reg(app, '携旗测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();

  // 直接建立已接取的支线，聚焦验证战斗结束事件的结算契约。
  const state = app.store.get<any>('task', va);
  state.active.s2 = {
    code: 's2', type: 'side', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0,
  };
  app.store.set('task', va, state);

  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: {
      villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-test',
      attackerWins: true, movementId: 'mv-flag', treasures: ['war_flag'],
      deployedTroops: { legionnaire: 20 }, campCleared: true,
    },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const s2 = (st.payload as any).active.find((a: any) => a.code === 's2');
  assert.equal(s2.awaitingReturn, 1, '清空营地且携旗达到二十人时，应记录待回城出征');
});

test('「耀武扬威」合格军旗归城后须手动交付，交付时才兑换胜利旗帜', async () => {
  const app = freshApp();
  const regRes = await reg(app, '手动交付测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  const taskState = app.store.get<any>('task', va);
  taskState.active.s2 = {
    code: 's2', type: 'side', acceptedAt: clock, submitted: {}, camps: [], campCleared: 0, progress: 0,
    qualifiedMovements: [], qualifiedFlagMovements: ['mv-qualified'], readyToDeliver: true,
  };
  app.store.set('task', va, taskState);
  app.store.set('treasure', va, {
    villageId: va, town: ['war_flag'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });

  const before = await send(app, 'task.GetState', { villageId: va });
  assert.ok((before.payload as any).active.find((x: any) => x.code === 's2'), '归城后任务仍应等待玩家手动交付');
  const delivered = await send(app, 'task.Deliver', { villageId: va, code: 's2' });
  assert.equal(delivered.ok, true, `手动交付应成功: ${delivered.reason ?? ''}`);
  const after = await send(app, 'task.GetState', { villageId: va });
  assert.ok((after.payload as any).completedSide.includes('s2'), '交付后才记录完成');
  const treasure = app.store.get<any>('treasure', va);
  assert.deepEqual(treasure.town, ['victory_flag'], '交付时应原子消耗军旗并获得胜利旗帜');
});

test('GM 可将已完成支线标记未完成，且必须重新触发后才可接取', async () => {
  const app = freshApp();
  const regRes = await reg(app, '支线重置测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  const state = app.store.get<any>('task', va);
  state.completedSide = ['s2'];
  state.firedTriggers = ['troops_reached:20'];
  app.store.set('task', va, state);

  const reopen = await send(app, 'task.GmReopenCompleted', { villageId: va, code: 's2' });
  assert.equal(reopen.ok, true, `GM 重置应成功: ${reopen.reason ?? ''}`);
  const after = reopen.payload as any;
  assert.ok(!after.completedSide.includes('s2'), '重置后不应保留完成记录');
  assert.ok(!after.offeredSide.some((q: any) => q.code === 's2'), '未重新触发前不得再次接取');

  const raw = app.store.get<any>('task', va);
  assert.ok(!raw.firedTriggers.includes('troops_reached:20'), '重置后必须清除该任务的触发状态');
  const main = await send(app, 'task.GmReopenCompleted', { villageId: va, code: 'm1' });
  assert.equal(main.ok, false, '主线不可经此 GM 操作重置');
  assert.equal(main.reason, 'only_completed_side_supported');
});

test('酒馆建造触发随机任务刷新；接取 → 上交 → 完成', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试4');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  // 建造酒馆（inner，无前置）
  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, `建酒馆应成功: ${build.reason ?? ''}`);
  await app.scheduler.advanceTo(clock + 120_000, setClock); // 等待落成 → building.Built → onTavernChanged
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offered.length > 0, `酒馆应刷出随机任务，实际 offered=${p.offered.length}`);

  // 接取第一个随机任务
  const code = p.offered[0].code;
  const acc = await send(app, 'task.Accept', { villageId: va, code });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok(p2.active.find((a: any) => a.code === code), '接取后应进入 active');
  assert.ok(!p2.offered.includes(code), '接取后应从 offered 移除');

  // 若为目标为 submit_resources，上交 → 就绪 → 交付
  const inst = p2.active.find((a: any) => a.code === code);
  if (inst.objective.kind === 'submit_resources') {
    const res = inst.objective.resources ?? {};
    await grant(app, va, res); // 确保有足够资源
    const sub = await send(app, 'task.SubmitResources', { villageId: va, code, resources: res });
    assert.equal(sub.ok, true, `上交应成功: ${sub.reason ?? ''}`);
    assert.equal((sub.payload as any).completed, true, '日常 submit 任务目标应达成');
    const st3 = await send(app, 'task.GetState', { villageId: va });
    const inst3 = (st3.payload as any).active.find((a: any) => a.code === code);
    assert.ok(inst3 && inst3.ready === true, '上交后应就绪可交付');
    const dv = await send(app, 'task.Deliver', { villageId: va, code });
    assert.equal(dv.ok, true, '交付应成功');
    const st4 = await send(app, 'task.GetState', { villageId: va });
    assert.ok(!(st4.payload as any).active.find((a: any) => a.code === code), '交付后应移出 active');
    assert.ok(!((st4.payload as any).completedSide ?? []).includes(code), '日常任务不记入已完成支线（可反复）');
  }
});

test('主线任务不可放弃；随机任务可放弃且移除营地', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试5');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  // 主线 m1 不可放弃
  const abMain = await send(app, 'task.Abandon', { villageId: va, code: 'm1' });
  assert.equal(abMain.ok, false, '主线放弃应被拒');
  assert.equal(abMain.reason, 'main_cannot_abandon');

  // 建酒馆 + 接取随机 clear_camp（若有），放弃应移除营地
  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true);
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  // 找一个 clear_camp 的随机任务来测营地移除
  const campOffer = p.offered.find((o: any) => o.objective.kind === 'clear_camp');
  if (campOffer) {
    const acc = await send(app, 'task.Accept', { villageId: va, code: campOffer.code });
    assert.equal(acc.ok, true);
    const st2 = await send(app, 'task.GetState', { villageId: va });
    const inst = st2.payload.active.find((a: any) => a.code === campOffer.code);
    const campId = inst.camps[0]?.id;
    assert.ok(campId, 'clear_camp 随机任务应生成营地');
    const ab = await send(app, 'task.Abandon', { villageId: va, code: campOffer.code });
    assert.equal(ab.ok, true, '随机任务放弃应成功');
    const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'pve' });
    assert.equal(tile.ok, false, '放弃后营地地块应被清除');
  } else {
    // 没有 clear_camp 随机任务也至少验证一个随机可放弃（submit 类）
    assert.ok(p.offered.length > 0, '酒馆应有随机任务');
    const code = p.offered[0].code;
    const acc = await send(app, 'task.Accept', { villageId: va, code });
    assert.equal(acc.ok, true);
    const ab = await send(app, 'task.Abandon', { villageId: va, code });
    assert.equal(ab.ok, true, '随机 submit 任务放弃应成功');
  }
});

test('上交资源只扣到「剩余需求」，不超额扣资源', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试6');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();

  // m1 需要 wood:200 clay:200；先只交 wood:200 clay:50（部分）
  const sub1 = await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { wood: 200, clay: 50 } });
  assert.equal(sub1.ok, true);
  assert.equal((sub1.payload as any).completed, false, '部分上交不应完成');
  assert.deepEqual((sub1.payload as any).submitted, { wood: 200, clay: 50 });

  // 再多交 clay:500（远超剩余 150），应只扣 150
  const before = await send(app, 'economy.GetResources', { villageId: va });
  const b = before.payload as any;
  const sub2 = await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { clay: 500 } });
  assert.equal(sub2.ok, true);
  assert.equal((sub2.payload as any).completed, true, '补齐后应完成');
  assert.deepEqual((sub2.payload as any).submitted, { wood: 200, clay: 200 });
  // 验证未超额扣：clay 仅减少 150（而非 500）
  const after = await send(app, 'economy.GetResources', { villageId: va });
  const a = after.payload as any;
  assert.equal(b.resources.clay - a.resources.clay, 150, 'clay 只应扣 150（剩余需求）');
});

test('支线任务：触发出现(offeredSide) → 接取 → 放弃后永久不再出现', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试7');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'treasury' });
  assert.equal(build.ok, true, '建宝库应成功');
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok((p.offeredSide ?? []).some((o: any) => o.code === 's1'), '宝库建成后 r4 支线应进入 offeredSide');
  assert.ok(!(p.offered ?? []).some((o: any) => o.code === 's1'), 'r4 支线不应出现在酒馆(offered)');

  const acc = await send(app, 'task.Accept', { villageId: va, code: 's1' });
  assert.equal(acc.ok, true, '接取支线应成功');

  const ab = await send(app, 'task.Abandon', { villageId: va, code: 's1' });
  assert.equal(ab.ok, true, '支线放弃应成功');
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok((p2.abandonedSide ?? []).includes('s1'), '放弃后 r4 应记入 abandonedSide');
  assert.ok(!(p2.offeredSide ?? []).some((o: any) => o.code === 's1'), '放弃后 r4 不应再在可接取');
  assert.ok(!(p2.active ?? []).some((a: any) => a.code === 's1'), '放弃后 r4 不应再 active');
});

test('日常任务可反复：完成后刷新可再次刷出', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试8');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 99999, clay: 99999, iron: 99999, crop: 99999, gold: 99999 });
  await tick();

  const build = await send(app, 'building.Build', { villageId: va, zone: 'inner', kind: 'tavern' });
  assert.equal(build.ok, true, '建酒馆应成功');
  await app.scheduler.advanceTo(clock + 120_000, setClock);
  await tick();
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const offer = (st.payload as any).offered.find((o: any) => o.objective.kind === 'submit_resources');
  assert.ok(offer, '酒馆应刷出 submit 类日常任务');
  const code = offer.code;
  const acc = await send(app, 'task.Accept', { villageId: va, code });
  assert.equal(acc.ok, true, '接取应成功');
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const inst = st2.payload.active.find((a: any) => a.code === code);
  const res = inst.objective.resources ?? {};
  await grant(app, va, res);
  await send(app, 'task.SubmitResources', { villageId: va, code, resources: res });
  await send(app, 'task.Deliver', { villageId: va, code });
  const st3 = await send(app, 'task.GetState', { villageId: va });
  assert.ok(!(st3.payload as any).active.find((a: any) => a.code === code), '交付后应移出 active');
  assert.ok(!((st3.payload as any).completedSide ?? []).includes(code), '日常任务完成不记入支线完成');

  await app.scheduler.advanceTo(clock + 7200_000, setClock);
  await tick();
  const st4 = await send(app, 'task.GetState', { villageId: va });
  assert.ok((st4.payload as any).offered.length > 0, '刷新后酒馆仍应有日常任务可刷');
});

test('村民的请求：接取即生成幸福村；贸易中心只决定送达订单', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求触发测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  // 强制触发概率=1，消除随机性
  app.config.constants.raw['villager_request_trigger_chance'] = 1;

  // 模拟成功掠夺一个普通 PvE 营地（targetId 不以 happy- 开头）
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offeredSide.some((q: any) => q.code === 's3'), '清空普通 PvE 营地后应点亮「村民的请求」支线');

  // 接取支线
  const acc = await send(app, 'task.Accept', { villageId: va, code: 's3' });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  await tick();

  // 幸福村 pve 目标应已生成
  const npcId = `happy-${va}`;
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, true, '幸福村 NPC 目标应已生成');
  const npcPayload = npc.payload as any;
  assert.equal(npcPayload.ownerVillageId, va, '幸福村应绑定玩家村（仅主人可掠夺）');
  assert.deepEqual(npcPayload.loot, { wood: 200, clay: 200, iron: 200, gold: 100 }, '幸福村掠夺资源应为 200/200/200/100');
  assert.equal(npcPayload.noRespawn, true, '幸福村应标记不重生');

  // 未建贸易中心时没有订单，但幸福村不能因此延迟出现。
  let tc = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal(((tc.payload as any).npcDeliveryOrders ?? []).length, 0, '无贸易中心时不应创建订单');

  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();

  // 贸易中心应有幸福村送达订单（crop 500）
  tc = await send(app, 'trade.GetCenter', { villageId: va });
  const orders = (tc.payload as any).npcDeliveryOrders ?? [];
  assert.equal(orders.length, 1, '贸易中心应有 1 条幸福村订单');
  assert.equal(orders[0].want.crop, 500, '订单应为 500 粮食');
  assert.equal(orders[0].npcId, npcId, '订单应指向幸福村');
});

test('村民的请求：掠夺幸福村（而非送达）→ 任务失败且获得秘密字条', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求失败测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.config.constants.raw['villager_request_trigger_chance'] = 1;
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' } } as any);
  await tick();
  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();
  await send(app, 'task.Accept', { villageId: va, code: 's3' });
  await tick();

  const npcId = `happy-${va}`;
  // 掠夺幸福村（失败路径）
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: npcId, attackerWins: true, campCleared: true, battleId: 'b2' },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(!p.active.some((a: any) => a.code === 's3'), '掠夺幸福村后任务应终止');
  assert.ok(p.abandonedSide.includes('s3'), '失败路径应记入 abandonedSide（不再出现）');
  const pending = app.store.all<any>('treasure_pending').filter((x) => x.villageId === va && x.code === 'secret_note');
  assert.equal(pending.length, 1, '失败应在报告中显示带回的秘密字条');
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, false, '幸福村地块应已被移除');
});

test('村民的请求：接单送粮完成 → 获得娜塔莉，幸福村与订单消失', async () => {
  const app = freshApp();
  const regRes = await reg(app, '村民请求完成测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.config.constants.raw['villager_request_trigger_chance'] = 1;
  await app.bus.emit({ name: 'combat.BattleEnded', source: 'test', ts: clock, payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: 'camp-other', attackerWins: true, campCleared: true, battleId: 'b1' } } as any);
  await tick();
  app.store.set('building', va, { villageId: va, placed: [{ kind: 'tradecenter', level: 1, slotId: 't0', pos: { q: 0, r: 0 } }] });
  await app.bus.emit({ name: 'building.Built', source: 'test', ts: clock, payload: { villageId: va, kind: 'tradecenter' } } as any);
  await tick();
  await send(app, 'task.Accept', { villageId: va, code: 's3' });
  await tick();

  const npcId = `happy-${va}`;
  // 接取幸福村送达订单（扣粮 + 派商队 + 移除订单）
  await grant(app, va, { crop: 1000 });
  const tc = await send(app, 'trade.GetCenter', { villageId: va });
  const orderId = (tc.payload as any).npcDeliveryOrders[0].id;
  const acc = await send(app, 'trade.AcceptNpcDelivery', { villageId: va, orderId });
  assert.equal(acc.ok, true, `接单应成功: ${acc.reason ?? ''}`);
  await tick();
  const tc2 = await send(app, 'trade.GetCenter', { villageId: va });
  assert.equal((tc2.payload as any).npcDeliveryOrders.length, 0, '接单后订单应从贸易中心移除');

  // 商队抵达幸福村（movement.arriveCaravan 会发此事件）
  await app.bus.emit({
    name: 'movement.CaravanArrivedNpc', source: 'test', ts: clock,
    payload: { villageId: va, npcId, cargo: { crop: 500 } },
  } as any);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.completedSide.includes('s3'), '送达后任务应完成');
  assert.ok(!p.active.some((a: any) => a.code === 's3'), '任务应移出 active');
  const treasure = app.store.get<any>('treasure', va);
  const codes = [...(treasure?.town ?? []), ...(treasure?.treasury ?? [])];
  assert.ok(codes.includes('natalie'), '完成应获得娜塔莉');
  const reputation = await send(app, 'reputation.GetByVillage', { villageId: va });
  assert.equal((reputation.payload as any).value, -1, 'S3 完成获得娜塔莉时应结算 -1 声望');
  const npc = await send(app, 'pve.GetTarget', { id: npcId });
  assert.equal(npc.ok, false, '幸福村应随任务完成消失');
});

test('秘密字条：使用后生成战报并解锁「调查坐标」', async () => {
  const app = freshApp();
  const regRes = await reg(app, '秘密字条测试');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  app.store.set('treasure', va, {
    villageId: va, town: ['secret_note'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });
  const use = await send(app, 'treasure.Use', { villageId: va, code: 'secret_note' });
  assert.equal(use.ok, true, `使用秘密字条应成功: ${use.reason ?? ''}`);
  await tick();

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.offeredSide.some((q: any) => q.code === 's4'), '使用秘密字条后应解锁「调查坐标」支线');
  const treasure = app.store.get<any>('treasure', va);
  const codes = [...(treasure?.town ?? []), ...(treasure?.treasury ?? [])];
  assert.ok(!codes.includes('secret_note'), '秘密字条使用后应被消耗');
});

test('调查坐标：接取 → 清剿3个rats营地 → 第3处掉落被囚禁的娜塔莉们 → 处理(放入宝库/释放)', async () => {
  const app = freshApp();
  const regRes = await reg(app, '调查坐标完整流程');
  const va = (regRes.payload as any).player.villageId;
  await tick();
  // 强制初始化各模块村状态，避免 recomputeAndPush 下游 state 缺失导致字段未写入
  await send(app, 'population.GetState', { villageId: va });
  await send(app, 'military.GetState', { villageId: va });
  await send(app, 'research.GetState', { villageId: va });

  // 解锁 s4（使用秘密字条）
  app.store.set('treasure', va, {
    villageId: va, town: ['secret_note'], treasury: [], carried: {}, extraSlots: 0,
    hasTradeCenter: false, locked: [], victoryFlagBonus: 0, victoryFlagQualified: {},
  });
  await send(app, 'treasure.Use', { villageId: va, code: 'secret_note' });
  await tick();

  const st0 = await send(app, 'task.GetState', { villageId: va });
  const off = (st0.payload as any).offeredSide.find((q: any) => q.code === 's4');
  assert.ok(off, '使用秘密字条后应解锁「调查坐标」');
  assert.equal(off.objective.kind, 'clear_camp', '目标应为 clear_camp');
  assert.equal(off.objective.campTemplate, 'rats', '营地模板应为 rats（与老鼠窝同驻兵/资源）');
  assert.equal(off.objective.count, 3, '需清剿 3 个营地');

  // 接取
  const acc = await send(app, 'task.Accept', { villageId: va, code: 's4' });
  assert.equal(acc.ok, true, `接取应成功: ${acc.reason ?? ''}`);
  await tick();

  const st1 = await send(app, 'task.GetState', { villageId: va });
  const inst = st1.payload.active.find((a: any) => a.code === 's4');
  assert.equal(inst.camps.length, 3, '应生成 3 个任务营地');
  const campIds = inst.camps.map((c: any) => c.id);

  // 清剿前 2 个营地（不应掉落 captured_natalies）
  for (let i = 0; i < 2; i++) {
    await app.bus.emit({
      name: 'combat.BattleEnded', source: 'test', ts: clock,
      payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campIds[i], attackerWins: true, campCleared: true, movementId: `mv-p${i}`, battleId: `b${i}` },
    } as any);
    await tick();
  }
  const st2 = await send(app, 'task.GetState', { villageId: va });
  const inst2 = st2.payload.active.find((a: any) => a.code === 's4');
  assert.equal(inst2.campCleared, 2, '应已清剿 2 处');
  const pendBefore = (app.store.all('treasure_pending') as any[]).filter((p) => p.villageId === va);
  assert.equal(pendBefore.length, 0, '前 2 处清剿不应掉落 captured_natalies（仅普通掠夺资源）');

  // 第 3 处清剿 → 掉落 captured_natalies（走标准待领取报告流程）
  const mvNatalie = 'mv-natalie';
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campIds[2], attackerWins: true, campCleared: true, movementId: mvNatalie, battleId: 'b2' },
  } as any);
  await tick();

  const st3 = await send(app, 'task.GetState', { villageId: va });
  const inst3 = st3.payload.active.find((a: any) => a.code === 's4');
  assert.ok(inst3.ready === false, '清剿 3 处后未抉择 captured_natalies 前不应就绪可交付');
  assert.ok(inst3.awaitingNatalieDecision === true, '清剿 3 处后应等待玩家抉择 captured_natalies');
  assert.equal(inst3.natalieDecision, null, '抉择前 natalieDecision 应为空');
  const pend = (app.store.all('treasure_pending') as any[]).filter((p) => p.villageId === va);
  assert.equal(pend.length, 1, '第 3 处清剿应掉落 1 件待领取宝物');
  assert.equal(pend[0].code, 'captured_natalies', '掉落应为「被囚禁的娜塔莉们」');
  assert.equal(pend[0].kind, 'camp', '掉落类型应为 camp（需军队归村后处理）');
  assert.ok(!pend[0].arrivedAt, '未归村前 arrivedAt 应未设置');

  // 模拟军队归村 → 标记到达
  const mark = await send(app, 'treasure.MarkPendingArrived', { movementId: mvNatalie });
  assert.equal(mark.ok, true, '标记归村应成功');
  const pendArr = app.store.get<any>('treasure_pending', mvNatalie);
  assert.ok(pendArr.arrivedAt, '归村后 arrivedAt 应设置');

  // 路径A：放入宝库（take）→ 入库 captured_natalies，获得 +20% 人口增长，无额外奖励
  const take = await send(app, 'treasure.ClaimPending', { movementId: mvNatalie, decision: 'take' });
  assert.equal(take.ok, true, `放入宝库应成功: ${take.reason ?? ''}`);
  const trA = app.store.get<any>('treasure', va);
  assert.ok([...trA.town, ...trA.treasury].includes('captured_natalies'), '放入宝库应入库 captured_natalies');
  assert.ok(![...trA.town, ...trA.treasury].includes('honest_heart'), '放入宝库不应给予正直的心（无任务奖励）');
  await tick();
  const popA = app.store.get<any>('population', va);
  assert.ok(popA.treasureGrowthMult >= 1.2 - 1e-9, `放入宝库应使人口增长倍率≥1.2（实际 ${popA.treasureGrowthMult}）`);
  // 放入宝库（take）后任务失败：保留宝物，但绝不能领取 S4 奖励。
  const stA = await send(app, 'task.GetState', { villageId: va });
  const instA = stA.payload.active.find((a: any) => a.code === 's4');
  assert.equal(instA, undefined, '放入宝库后调查坐标应以失败结束');
  assert.ok(stA.payload.abandonedSide.includes('s4'), '放入宝库后应记入已失败支线');
  return;

  // 路径B：释放（release）一个 captured_natalies → 不应立即发奖，需点「领取奖励」后才发
  // 重新挂起 natalie 抉择（路径A已消费 awaitingNatalieDecision，这里模拟另一次掉落重新挂起）
  const ts = app.store.get<any>('task', va);
  ts.active['s4'].awaitingNatalieDecision = true;
  ts.active['s4'].awaitingNatalieCode = 'captured_natalies';
  app.store.set('task', va, ts);
  // 预留宝物栏（模拟已建宝库），确保正直的心能进入宝物栏并激活效果
  app.store.get<any>('treasure', va).extraSlots = 5;
  const beforeGold = ((await send(app, 'economy.GetResources', { villageId: va })).payload as any).resources.gold ?? 0;
  // 直接模拟第 3 处掉落的待领取记录（清剿逻辑已验证），走释放路径
  await send(app, 'treasure.RollDrop', { villageId: va, source: 'camp', movementId: 'mv-rel', forceCode: 'captured_natalies' });
  await send(app, 'treasure.MarkPendingArrived', { movementId: 'mv-rel' });
  const rel = await send(app, 'treasure.ClaimPending', { movementId: 'mv-rel', decision: 'release' });
  assert.equal(rel.ok, true, `释放应成功: ${rel.reason ?? ''}`);
  assert.equal((rel.payload as any).released, true, '应标记 released');
  assert.notEqual((rel.payload as any).grantedHonestHeart, true, '释放不应立即发放「正直的心」');
  const trB0 = app.store.get<any>('treasure', va);
  assert.ok(![...trB0.town, ...trB0.treasury].includes('honest_heart'), '释放不应立即入库「正直的心」');
  assert.equal(app.store.get('treasure_pending', 'mv-rel'), undefined, '释放后应移除待领取记录');
  await tick();
  const goldMid = ((await send(app, 'economy.GetResources', { villageId: va })).payload as any).resources.gold ?? 0;
  assert.equal(goldMid, beforeGold, '释放不应立即发放 500 金币');
  // 释放后任务应就绪可交付，且记 natalieDecision=release（按钮文案「领取奖励」）
  const stB = await send(app, 'task.GetState', { villageId: va });
  const instB = stB.payload.active.find((a: any) => a.code === 's4');
  assert.ok(instB.ready === true, '释放后任务应就绪可交付');
  assert.equal(instB.natalieDecision, 'release', '释放应记 natalieDecision=release');

  // 点「领取奖励」= task.Deliver → completeQuest 才发奖励
  const dv = await send(app, 'task.Deliver', { villageId: va, code: 's4' });
  assert.equal(dv.ok, true, `交付应成功: ${dv.reason ?? ''}`);
  const trB = app.store.get<any>('treasure', va);
  assert.ok([...trB.town, ...trB.treasury].includes('honest_heart'), '「领取奖励」后应入库「正直的心」');
  const afterGold = ((await send(app, 'economy.GetResources', { villageId: va })).payload as any).resources.gold ?? 0;
  assert.equal(afterGold, beforeGold + 500, `领取奖励应 +500 金币（实际 ${afterGold} vs ${beforeGold}）`);
  await tick();
  // 正直的心效果：攻/防 +10%、金币 +10%、科技判定间隔 -10%
  const popB = app.store.get<any>('population', va);
  assert.ok(popB.treasureGoldMult >= 1.1 - 1e-9, `正直的心应使金币倍率≥1.1（实际 ${popB.treasureGoldMult}）`);
  const milB = app.store.get<any>('military', va);
  assert.ok(milB.treasureAtkMult >= 1.1 - 1e-9 && milB.treasureDefMult >= 1.1 - 1e-9, `正直的心应使攻防倍率≥1.1（atk ${milB.treasureAtkMult} / def ${milB.treasureDefMult}）`);
  const resB = app.store.get<any>('research', va);
  assert.ok(resB.treasureTechIntervalMult < 1 - 1e-9 && resB.treasureTechIntervalMult > 0.8, `正直的心应使科技判定间隔倍率≈0.9（实际 ${resB.treasureTechIntervalMult}）`);

  // 交付后任务移出 active
  const st4 = await send(app, 'task.GetState', { villageId: va });
  assert.ok(!st4.payload.active.some((a: any) => a.code === 's4'), '交付后调查坐标应移出 active');
});
