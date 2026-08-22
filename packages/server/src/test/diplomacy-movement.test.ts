import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

const send = (app: ReturnType<typeof createGameApp>, name: string, payload: any) => app.commands.send({ name, from: 'test', payload });

test('外交与行军模式：默认中立、选项由关系决定、显式宣战才转敌对', async () => {
  const app = createGameApp({ manualScheduler: true }); app.setupWorld();
  const a = (await send(app, 'player.Register', { name: '外交甲', password: 'p1234' })).payload as any;
  const b = (await send(app, 'player.Register', { name: '外交乙', password: 'p1234' })).payload as any;
  const va = a.player.villageId, vb = b.player.villageId;
  const ownerA = (await send(app, 'player.GetByVillage', { villageId: va })).payload as any;
  const ownerB = (await send(app, 'player.GetByVillage', { villageId: vb })).payload as any;
  const rel = await send(app, 'diplomacy.GetRelation', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal((rel.payload as any).relation, 'neutral');
  const opts = await send(app, 'movement.GetMarchOptions', { villageId: va, kind: 'village', refId: vb, q: b.player.q, r: b.player.r });
  assert.deepEqual((opts.payload as any).modes.map((m: any) => m.mode), ['reinforce', 'scout', 'raid', 'attack']);
  const war = await send(app, 'diplomacy.DeclareWar', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal(war.ok, true);
  const hostile = await send(app, 'diplomacy.GetRelation', { playerId: ownerA.player.id, targetPlayerId: ownerB.player.id });
  assert.equal((hostile.payload as any).relation, 'hostile');
  const hostileOpts = await send(app, 'movement.GetMarchOptions', { villageId: va, kind: 'village', refId: vb, q: b.player.q, r: b.player.r });
  assert.deepEqual((hostileOpts.payload as any).modes.map((m: any) => m.mode), ['scout', 'raid', 'attack']);
});
