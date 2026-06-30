import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateManifests, type ModuleManifest } from '../gateway/manifest.js';

/**
 * Manifest 汇总测试：动作/事件名冲突要在启动期抛错（避免静默覆盖路由）。
 */

test('aggregateManifests：正常汇总动作与事件', () => {
  const a: ModuleManifest = {
    moduleName: 'a',
    publicActions: { DoA: { command: 'a.DoA', needAuth: true } },
    eventPushMap: { 'a.Done': 'ADone' },
  };
  const b: ModuleManifest = {
    moduleName: 'b',
    publicActions: { DoB: { command: 'b.DoB' } },
  };
  const { actionRoutes, eventToPush } = aggregateManifests([a, b]);
  assert.equal(actionRoutes.DoA.command, 'a.DoA');
  assert.equal(actionRoutes.DoA.needAuth, true);
  assert.equal(actionRoutes.DoB.command, 'b.DoB');
  assert.equal(eventToPush['a.Done'], 'ADone');
});

test('aggregateManifests：动作名冲突应抛错', () => {
  const a: ModuleManifest = { moduleName: 'a', publicActions: { Dup: { command: 'a.X' } } };
  const b: ModuleManifest = { moduleName: 'b', publicActions: { Dup: { command: 'b.Y' } } };
  assert.throws(() => aggregateManifests([a, b]), /动作名冲突/);
});

test('aggregateManifests：事件名冲突应抛错', () => {
  const a: ModuleManifest = { moduleName: 'a', publicActions: {}, eventPushMap: { 'e': 'A' } };
  const b: ModuleManifest = { moduleName: 'b', publicActions: {}, eventPushMap: { 'e': 'B' } };
  assert.throws(() => aggregateManifests([a, b]), /事件名冲突/);
});
