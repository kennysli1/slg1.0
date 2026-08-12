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

test('上交资源完成 m1 → 解锁 m2/m3，奖励发放', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试2');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();

  const sub = await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { wood: 200, clay: 200 } });
  assert.equal(sub.ok, true, `上交应成功: ${sub.reason ?? ''}`);
  assert.equal((sub.payload as any).completed, true, 'm1 应完成');

  const st = await send(app, 'task.GetState', { villageId: va });
  const p = st.payload as any;
  assert.ok(p.completedMain.includes('m1'), 'm1 应在 completedMain');
  const activeCodes = p.active.map((a: any) => a.code).sort();
  // m2(requires m1) 与 m3(requires m1, clear_camp) 应解锁
  assert.ok(activeCodes.includes('m2'), 'm2 应解锁');
  assert.ok(activeCodes.includes('m3'), 'm3 应解锁');
  // 资源奖励 wood:100 gold:50 应已到账
  const res = await send(app, 'economy.GetResources', { villageId: va });
  const r = res.payload as any;
  assert.ok(r.resources.gold >= 50, `应获 gold:50 奖励，实际 gold=${r.resources.gold}`);
});

test('clear_camp 主线 m3 自动生成真实营地；战斗清空营地后完成并发锁定宝物', async () => {
  const app = freshApp();
  const regRes = await reg(app, '任务测试3');
  const va = (regRes.payload as any).player.villageId;
  await grant(app, va, { wood: 9999, clay: 9999, iron: 9999, crop: 9999 });
  await tick();
  // 完成 m1 → m3 解锁并生成营地
  await send(app, 'task.SubmitResources', { villageId: va, code: 'm1', resources: { wood: 200, clay: 200 } });

  const st = await send(app, 'task.GetState', { villageId: va });
  const m3 = (st.payload as any).active.find((a: any) => a.code === 'm3');
  assert.ok(m3, 'm3 应处于 active');
  assert.equal(m3.campTotal, 1, 'm3 应生成 1 个营地');
  const camp = m3.camps[0];
  assert.ok(camp && camp.id, '营地应有 id 与坐标');
  const campId = camp.id;

  // 营地应是真实 pve 地块
  const tile = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'pve' });
  assert.equal(tile.ok, true, '营地应在地图上有 pve 地块');

  // 模拟战斗结束：玩家清空该营地
  await app.bus.emit({
    name: 'combat.BattleEnded', source: 'test', ts: clock,
    payload: { villageId: va, side: 'attacker', targetKind: 'pve', targetId: campId, attackerWins: true, battleId: 'b-test' },
  } as any);
  await tick();

  const st2 = await send(app, 'task.GetState', { villageId: va });
  const p2 = st2.payload as any;
  assert.ok(p2.completedMain.includes('m3'), 'm3 应已完成');
  assert.ok(!p2.active.find((a: any) => a.code === 'm3'), 'm3 应从 active 移除');
  assert.ok(p2.completedMain.includes('m4') === false, 'm4 需 m3，但 m4 自身完成才进 completedMain（此处仅验证 m3）');
  // m4(requires m3) 应解锁为 active
  assert.ok(p2.active.find((a: any) => a.code === 'm4'), 'm4 应解锁');

  // 营地地块应被移除
  const tileAfter = await send(app, 'world.GetTileByRef', { refId: campId, kind: 'pve' });
  assert.equal(tileAfter.ok, false, '营地地块应已被清除');

  // 任务专属宝物 warrior_token 应进入 locked 桶（不可出售/遗弃）
  const tr = app.store.get<any>('treasure', va);
  assert.ok(tr && tr.locked.includes('warrior_token'), 'warrior_token 应进入 treasure.locked');
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

  // 若为目标为 submit_resources，上交完成
  const inst = p2.active.find((a: any) => a.code === code);
  if (inst.objective.kind === 'submit_resources') {
    const res = inst.objective.resources ?? {};
    await grant(app, va, res); // 确保有足够资源
    const sub = await send(app, 'task.SubmitResources', { villageId: va, code, resources: res });
    assert.equal(sub.ok, true, `上交应成功: ${sub.reason ?? ''}`);
    assert.equal((sub.payload as any).completed, true, '随机 submit 任务应完成');
    const st3 = await send(app, 'task.GetState', { villageId: va });
    assert.ok((st3.payload as any).completedRandom.includes(code), '随机任务应记完成');
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
