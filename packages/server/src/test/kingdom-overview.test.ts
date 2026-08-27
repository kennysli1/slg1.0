import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';
import { Gateway } from '../gateway/gateway.js';
import { WIRE_VERSION } from '@slg/shared';

test('王国概览：汇总自己全部村庄的资源快照，且客户端不能伪造 playerId', async () => {
  const app = createGameApp({ now: () => 1_000_000, manualScheduler: true });
  app.setupWorld();
  const gateway = new Gateway(app);
  const firstSession = gateway.addClient({ send: () => {} });
  const secondSession = gateway.addClient({ send: () => {} });
  let requestId = 0;
  const request = (action: string, payload: Record<string, unknown> = {}) => ({
    v: WIRE_VERSION, type: 'req' as const, id: `overview-${++requestId}`, ts: 1_000_000, action, payload,
  });

  const first = await gateway.handleRequest(
    request('Register', { name: 'overview-owner', password: 'pass12', tribe: 'romans' }), firstSession,
  );
  assert.equal(first.ok, true, first.error?.code);
  const firstPlayer = (first.payload as any).player;
  const capitalId = firstPlayer.villageId as string;

  const allocated = await app.commands.send({
    name: 'player.AllocVillageId', from: 'test', payload: { playerId: firstPlayer.id },
  });
  assert.equal(allocated.ok, true, allocated.reason);
  const branchId = (allocated.payload as any).villageId as string;
  await app.createVillage(branchId, 11, 7, '边境城');
  const attached = await app.commands.send({
    name: 'player.AttachVillage', from: 'test',
    payload: { playerId: firstPlayer.id, villageId: branchId, q: 11, r: 7, name: '边境城' },
  });
  assert.equal(attached.ok, true, attached.reason);

  await app.commands.send({ name: 'economy.Grant', from: 'test', payload: { villageId: capitalId, gain: { wood: 120, gold: 9 } } });
  await app.commands.send({ name: 'economy.Grant', from: 'test', payload: { villageId: branchId, gain: { wood: 250, clay: 80, gold: 4 } } });

  const overview = await gateway.handleRequest(request('GetKingdomOverview'), firstSession);
  assert.equal(overview.ok, true, overview.error?.code);
  const payload = overview.payload as any;
  assert.equal(payload.villages.length, 2);
  const capital = payload.villages.find((v: any) => v.villageId === capitalId);
  const branch = payload.villages.find((v: any) => v.villageId === branchId);
  assert.equal(capital?.isCapital, true);
  assert.deepEqual(
    { villageId: branch?.villageId, name: branch?.name, q: branch?.q, r: branch?.r, isCapital: branch?.isCapital },
    { villageId: branchId, name: '边境城', q: 11, r: 7, isCapital: false },
  );
  for (const key of ['wood', 'clay', 'iron', 'crop', 'gold'] as const) {
    assert.equal(payload.resources[key], capital.resources[key] + branch.resources[key], `${key} 资源应为两村合计`);
    assert.equal(payload.capacity[key], capital.capacity[key] + branch.capacity[key], `${key} 容量应为两村合计`);
    assert.equal(payload.netRate[key], capital.netRate[key] + branch.netRate[key], `${key} 净产率应为两村合计`);
  }

  const second = await gateway.handleRequest(
    request('Register', { name: 'overview-other', password: 'pass12', tribe: 'gauls' }), secondSession,
  );
  assert.equal(second.ok, true, second.error?.code);
  const forged = await gateway.handleRequest(request('GetKingdomOverview', { playerId: firstPlayer.id }), secondSession);
  assert.equal(forged.ok, true, forged.error?.code);
  assert.equal((forged.payload as any).villages.length, 1, '未声明字段必须被 Gateway 剥离，概览只能读取会话所属玩家');
  assert.notEqual((forged.payload as any).villages[0].villageId, capitalId);
});
