import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameApp, type GameApp } from '../app.js';

/**
 * 配置下发接口测试：GetGameConfig 返回前端渲染最小集，且新增 CSV 内容自动出现
 * （此处用已有 units 数量验证"全量下发"，不改 CSV 也能证明链路：meta 遍历 config）。
 */

function freshApp(): GameApp {
  let clock = 1_000_000;
  const app = createGameApp({ now: () => clock, manualScheduler: true });
  app.setupWorld();
  return app;
}

test('GetGameConfig：返回 resources/buildings/units/pve/常量最小集', async () => {
  const app = freshApp();
  const r = await app.commands.send({ name: 'meta.GetGameConfig', from: 'test', payload: {} });
  assert.equal(r.ok, true);
  const p = r.payload as any;
  // 资源 4 种，字段齐全
  assert.equal(p.resources.length, 4);
  assert.ok(p.resources[0].key && p.resources[0].name && p.resources[0].icon);
  // 兵种：下发数量 = config 兵种数量（新增 CSV 行会自动出现）
  assert.equal(p.units.length, Object.keys(app.config.units).length);
  assert.ok(p.units.every((u: any) => u.key && u.tribe && u.name && u.icon && u.form));
  // 建筑：下发数量 = config 建筑数量（含资源田，均带 zone）
  assert.equal(p.buildings.length, Object.keys(app.config.buildings).length);
  assert.ok(p.buildings.every((b: any) => b.kind && b.name && b.icon && b.zone));
  assert.ok(p.buildings.some((b: any) => b.zone === 'outer' && b.resource), '资源田应带 resource');
  assert.equal(p.pveTemplates.length, Object.keys(app.config.pveTemplates).length);
  // 白名单常量
  assert.equal(p.constants.mapViewRadius, app.config.constants.mapViewRadius);
  // 不泄漏平衡参数（如成本公式/铁匠加成）
  assert.equal(p.constants.smithyBonusPerLevel, undefined);
});
