import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';
import { Gateway } from '../gateway/gateway.js';
import type { WireRequest, WireResponse, WirePush } from '@slg/shared';
import { WIRE_VERSION } from '@slg/shared';

let clock = 1_000_000;
function freshApp(): GameApp {
  clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}
async function send(app: GameApp, action: string, payload: any) {
  return app.commands.send({ name: action, from: 'test', payload });
}

test('注册：单主城 + villages 列表 + 新 id 格式', async () => {
  const app = freshApp();
  const r = await send(app, 'player.Register', {
    name: 'mvuser1', password: 'pass1', tribe: 'romans',
  });
  assert.equal(r.ok, true, r.reason);
  const p = (r.payload as any).player;
  assert.ok(p.villages?.length === 1);
  assert.equal(p.villages[0].isCapital, true);
  assert.equal(p.capitalVillageId, p.villageId);
  assert.equal(p.currentVillageId, p.villageId);
  assert.ok(String(p.villageId).startsWith('v-p-'), `villageId=${p.villageId}`);
  assert.ok(String(p.villageId).includes('-'), '新村 id 应为 v-<playerId>-<n>');
});

test('旧档单 villageId 字段自动迁移为 ownedVillages', async () => {
  const app = freshApp();
  // 手工写入旧格式
  app.store.set('player', 'p-old', {
    id: 'p-old',
    name: 'oldguy',
    pwd: '00:00', // 不会走登录校验
    tribe: 'romans',
    villageId: 'v-p-old',
    q: 2,
    r: 3,
    createdAt: 1,
  });
  app.store.set('player_byvillage', 'v-p-old', 'p-old');

  const g = await send(app, 'player.Get', { playerId: 'p-old' });
  assert.equal(g.ok, true);
  const p = (g.payload as any).player;
  assert.equal(p.capitalVillageId, 'v-p-old');
  assert.equal(p.villages.length, 1);
  assert.equal(p.villages[0].q, 2);
  assert.equal(p.villages[0].r, 3);

  // 写回后应已持久化新字段
  const raw = app.store.get<any>('player', 'p-old');
  assert.ok(Array.isArray(raw.ownedVillages) && raw.ownedVillages.length === 1);
  assert.equal(raw.capitalVillageId, 'v-p-old');
});

test('Attach 第二村后 SelectVillage 切换当前村', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'mvuser2', password: 'pass2', tribe: 'gauls',
  });
  const p0 = (reg.payload as any).player;
  const pid = p0.id as string;
  const capital = p0.villageId as string;

  const alloc = await send(app, 'player.AllocVillageId', { playerId: pid });
  assert.equal(alloc.ok, true);
  const vid2 = (alloc.payload as any).villageId as string;
  assert.notEqual(vid2, capital);

  // 避开出生点与常见 PvE 点
  const q2 = 12, r2 = -8;
  await app.createVillage(vid2, q2, r2, '分城甲');
  const att = await send(app, 'player.AttachVillage', {
    playerId: pid, villageId: vid2, q: q2, r: r2, name: '分城甲',
  });
  assert.equal(att.ok, true, att.reason);
  assert.equal((att.payload as any).player.villages.length, 2);

  const selBad = await send(app, 'player.SelectVillage', {
    playerId: pid, villageId: 'v-nope',
  });
  assert.equal(selBad.ok, false);
  assert.equal(selBad.reason, 'village_not_owned');

  const sel = await send(app, 'player.SelectVillage', {
    playerId: pid, villageId: vid2,
  });
  assert.equal(sel.ok, true, sel.reason);
  assert.equal((sel.payload as any).currentVillageId, vid2);
  assert.equal((sel.payload as any).player.villageId, vid2);
  assert.equal((sel.payload as any).player.q, q2);
  assert.equal((sel.payload as any).player.capitalVillageId, capital);
});

test('RenameVillage：仅能修改自己的村庄并同步地图地块', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'mvrename', password: 'pass1', tribe: 'romans',
  });
  assert.equal(reg.ok, true, reg.reason);
  const player = (reg.payload as any).player;
  const villageId = player.villageId as string;
  const original = app.store.get<any>('world_tile', `${player.q},${player.r}`);
  assert.equal(original?.name, 'mvrename的村庄');

  const renamed = await send(app, 'player.RenameVillage', {
    playerId: player.id, villageId, name: '新曙光城',
  });
  assert.equal(renamed.ok, true, renamed.reason);
  assert.equal((renamed.payload as any).player.villages[0].name, '新曙光城');
  assert.equal(app.store.get<any>('player', player.id).ownedVillages[0].name, '新曙光城');
  assert.equal(app.store.get<any>('world_tile', `${player.q},${player.r}`).name, '新曙光城');

  const blank = await send(app, 'player.RenameVillage', { playerId: player.id, villageId, name: '   ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, 'village_name_empty');
  const foreign = await send(app, 'player.RenameVillage', { playerId: 'p-nope', villageId, name: '越权' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'player_not_found');
});

test('Gateway：SelectVillage 后 ownVillage 打到新当前村', async () => {
  const app = freshApp();
  const gw = new Gateway(app);
  const replies: (WireResponse | WirePush)[] = [];
  const session = gw.addClient({ send: (m) => { replies.push(m); } });

  const req = (action: string, payload: Record<string, unknown>, id: string): WireRequest => ({
    v: WIRE_VERSION, type: 'req', id, action, payload, ts: clock,
  });

  const regRes = await gw.handleRequest(
    req('Register', { name: 'gwmv1', password: 'pass99', tribe: 'romans' }, 'r1'),
    session,
  );
  assert.equal(regRes.ok, true, regRes.error?.msg);
  const capital = (regRes.payload as any).player.villageId as string;
  assert.equal(session.villageId, capital);

  const pid = (regRes.payload as any).player.id as string;
  const alloc = await send(app, 'player.AllocVillageId', { playerId: pid });
  const vid2 = (alloc.payload as any).villageId as string;
  const q2 = 11, r2 = -7;
  await app.createVillage(vid2, q2, r2, '分城乙');
  await send(app, 'player.AttachVillage', {
    playerId: pid, villageId: vid2, q: q2, r: r2, name: '分城乙',
  });
  // 推送索引应能覆盖第二村（登录后需刷新 villageIds——通过再 Select 或重新 bind）
  // 先 Select 到分城
  const selRes = await gw.handleRequest(
    req('SelectVillage', { villageId: vid2 }, 's1'),
    session,
  );
  assert.equal(selRes.ok, true, selRes.error?.msg);
  assert.equal(session.villageId, vid2);
  assert.ok(session.villageIds?.includes(capital));
  assert.ok(session.villageIds?.includes(vid2));

  const renameRes = await gw.handleRequest(
    req('RenameVillage', { villageId: vid2, name: '新分城乙' }, 'n1'),
    session,
  );
  assert.equal(renameRes.ok, true, renameRes.error?.msg);
  assert.equal(session.villageId, vid2, '重命名不应改变当前操作村');
  assert.equal(app.store.get<any>('player', pid).ownedVillages.find((v: any) => v.id === vid2).name, '新分城乙');
  const renamePush = replies.find((m: any) => m.type === 'push' && m.event === 'VillageRenamed') as any;
  assert.ok(renamePush, '重命名应向玩家会话推送刷新事件');
  assert.equal(renamePush.payload.villageId, vid2);
  assert.equal(renamePush.payload.name, '新分城乙');

  // ownVillage 的 GetResources 应读到分城经济
  const eco = await gw.handleRequest(req('GetResources', {}, 'e1'), session);
  assert.equal(eco.ok, true, eco.error?.msg);
  assert.ok((eco.payload as any).resources);
});

test('任务板：GetPlayerState 聚合玩家所有村庄并标注来源村', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: 'mvtask', password: 'pass1', tribe: 'romans' });
  assert.equal(reg.ok, true, reg.reason);
  const player = (reg.payload as any).player;
  const capital = player.villageId as string;
  const alloc = await send(app, 'player.AllocVillageId', { playerId: player.id });
  const branch = (alloc.payload as any).villageId as string;
  await app.createVillage(branch, 12, -8, '任务分城');
  const attach = await send(app, 'player.AttachVillage', {
    playerId: player.id, villageId: branch, q: 12, r: -8, name: '任务分城',
  });
  assert.equal(attach.ok, true, attach.reason);
  await Promise.resolve();

  const board = await send(app, 'task.GetPlayerState', { playerId: player.id });
  assert.equal(board.ok, true, board.reason);
  const payload = board.payload as any;
  assert.deepEqual(new Set(payload.villageIds), new Set([capital, branch]));
  assert.equal(payload.villages.length, 2);
  assert.equal(payload.active.length, 1, '玩家任务板应按任务 code 去重，不能因分城重复显示 m1');
  assert.ok([capital, branch].includes(payload.active[0].villageId), '聚合任务应保留一个可执行的来源村');
});

test('任务归属：全局主线可在分城执行，奖励发给最后执行村；村庄区不重复显示', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', { name: 'mvtaskscope', password: 'pass1', tribe: 'romans' });
  assert.equal(reg.ok, true, reg.reason);
  const player = (reg.payload as any).player;
  const capital = player.villageId as string;
  const alloc = await send(app, 'player.AllocVillageId', { playerId: player.id });
  const branch = (alloc.payload as any).villageId as string;
  await app.createVillage(branch, 13, -9, '执行分城');
  const attached = await send(app, 'player.AttachVillage', { playerId: player.id, villageId: branch, q: 13, r: -9, name: '执行分城' });
  assert.equal(attached.ok, true, attached.reason);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const board0 = (await send(app, 'task.GetPlayerState', { playerId: player.id })).payload as any;
  assert.equal(board0.global.active.filter((x: any) => x.code === 'm1').length, 1);
  assert.ok(board0.villages.every((v: any) => !v.active.some((x: any) => x.code === 'm1')), '全局任务不应进入村庄任务区');

  await send(app, 'economy.Grant', { villageId: branch, gain: { wood: 9999, clay: 9999, iron: 9999, crop: 9999 } });
  const submit = await send(app, 'task.SubmitResources', { villageId: branch, code: 'm1', resources: { wood: 200, clay: 200 } });
  assert.equal(submit.ok, true, submit.reason);
  const branchBefore = (await send(app, 'economy.GetResources', { villageId: branch })).payload as any;
  const deliver = await send(app, 'task.Deliver', { villageId: branch, code: 'm1' });
  assert.equal(deliver.ok, true, deliver.reason);
  assert.equal((deliver.payload as any).rewards.rewardVillageId, branch);
  const branchAfter = (await send(app, 'economy.GetResources', { villageId: branch })).payload as any;
  assert.ok(branchAfter.resources.gold >= branchBefore.resources.gold + 50, '全局任务奖励必须发给最后执行村');

  const capState = (await send(app, 'task.GetState', { villageId: capital })).payload as any;
  assert.ok(capState.completedMain.includes('m1'), '全局任务完成记录应在主城锚点');
  const branchState = (await send(app, 'task.GetState', { villageId: branch })).payload as any;
  assert.ok(branchState.global.completedMain.includes('m1'), '任意村读取都应看到全局完成状态');
});

test('deletePlayer 清除全部村庄进度', async () => {
  const app = freshApp();
  const reg = await send(app, 'player.Register', {
    name: 'mvdel', password: 'pass3', tribe: 'teutons',
  });
  const pid = (reg.payload as any).player.id as string;
  const capital = (reg.payload as any).player.villageId as string;
  const alloc = await send(app, 'player.AllocVillageId', { playerId: pid });
  const vid2 = (alloc.payload as any).villageId as string;
  await app.createVillage(vid2, 10, -9, '分城丙');
  await send(app, 'player.AttachVillage', {
    playerId: pid, villageId: vid2, q: 10, r: -9, name: '分城丙',
  });

  const result = app.deletePlayer(pid);
  assert.ok(result);
  assert.deepEqual(new Set(result!.villageIds), new Set([capital, vid2]));
  assert.equal(app.store.get('economy', capital), undefined);
  assert.equal(app.store.get('economy', vid2), undefined);
  assert.equal(app.store.get('player', pid), undefined);
});
