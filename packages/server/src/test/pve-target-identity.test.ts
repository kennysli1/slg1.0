import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp } from '../app.js';

test('PvE 目标：集合键是权威身份，不会因旧记录 id 冲突解析到另一座营地', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.pve.create('pve-0', 'rats', 3, 1);
  app.pve.create('pve-44', 'rats', 12, 40);

  const original = app.store.get<any>('pve', 'pve-44');
  assert.ok(original);
  // 模拟生产中曾出现的旧档：pve-44 集合键下嵌入了 pve-0 的 id。
  app.store.set('pve', 'pve-44', { ...original, id: 'pve-0' });

  // 启动恢复应先按集合键修复内部身份。
  app.pve.resume();
  assert.equal(app.store.get<any>('pve', 'pve-44')?.id, 'pve-44');

  const result = await app.commands.send({
    name: 'pve.GetTarget',
    from: 'test',
    payload: { id: 'pve-44' },
  });
  assert.equal(result.ok, true);
  assert.equal((result.payload as any).id, 'pve-44');
  assert.deepEqual({ q: (result.payload as any).q, r: (result.payload as any).r }, { q: 12, r: 40 });
});

test('PvE 目标：重启恢复会从军队当前位置修正已经落库的错误路线', async () => {
  const app = createGameApp({ manualScheduler: true });
  app.pve.create('pve-0', 'rats', 3, 1);
  app.pve.create('pve-44', 'rats', 12, 40);
  const target = app.store.get<any>('pve', 'pve-44')!;
  app.store.set('pve', 'pve-44', { ...target, id: 'pve-0' });
  app.store.set('movement', 'mv-repair', {
    id: 'mv-repair', type: 'raid', status: 'marching', fromVillage: 'v-p-5-1',
    fromXY: { q: 17, r: 38 }, pos: { q: 17, r: 38 }, toXY: { q: 3, r: 1 },
    path: [{ q: 17, r: 38 }, { q: 3, r: 1 }], stepIndex: 0, stepToken: 4,
    perStepMs: 1000, nextStepAt: 1000, arriveAt: 1000, departAt: 0,
    targetId: 'pve-44', troops: { legionnaire: 1 },
  });

  app.movement.resume();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const repaired = app.store.get<any>('movement', 'mv-repair');
  assert.deepEqual(repaired.toXY, { q: 12, r: 40 });
  assert.deepEqual(repaired.path[0], { q: 17, r: 38 });
  assert.deepEqual(repaired.path[repaired.path.length - 1], { q: 12, r: 40 });
});
