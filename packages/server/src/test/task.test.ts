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

  // 任务专属宝物 warrior_token 应进入 locked 桶（不可出售/遗弃）
  const tr = app.store.get<any>('treasure', va);
  assert.ok(tr && tr.locked.includes('warrior_token'), 'warrior_token 应进入 treasure.locked');
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
