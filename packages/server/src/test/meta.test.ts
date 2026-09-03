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
  // 资源 5 种（含金币），字段齐全
  assert.equal(p.resources.length, 5);
  assert.ok(p.resources[0].key && p.resources[0].name && p.resources[0].icon);
  // 兵种：下发数量 = config 兵种数量（新增 CSV 行会自动出现）
  assert.equal(p.units.length, Object.keys(app.config.units).length);
  assert.ok(p.units.every((u: any) => u.key && u.tribe && u.name && u.icon && Number.isFinite(u.attack) && Number.isFinite(u.defense) && Number.isFinite(u.hp)));
  // 建筑：下发数量 = config 建筑数量（含资源田，均带 zone）
  assert.equal(p.buildings.length, Object.keys(app.config.buildings).length);
  assert.ok(p.buildings.every((b: any) => b.kind && b.name && b.icon && b.zone));
  assert.ok(p.buildings.some((b: any) => b.zone === 'outer' && b.resource), '资源田应带 resource');
  assert.equal(p.pveTemplates.length, Object.keys(app.config.pveTemplates).length);
  // 白名单常量
  assert.equal(p.constants.mapViewRadius, app.config.constants.mapViewRadius);
  // 建筑"功能/提供"展示用常量现已下发（客户端详情弹窗计算仓储上限/加成）
  assert.equal(p.constants.storageBase, app.config.constants.storageBase);
  assert.equal(p.constants.storageGrowthPerLevel, app.config.constants.storageGrowthPerLevel);
  assert.equal(p.constants.wallBonusPerLevel, app.config.constants.wallBonusPerLevel);
  assert.equal(p.constants.popOvercapPenaltyFullRatio, app.config.constants.popOvercapPenaltyFullRatio);
  assert.equal(p.constants.popHospitalRecoveryBase, app.config.constants.popHospitalRecoveryBase);
  assert.equal(p.constants.popHospitalRecoveryPerLevel, app.config.constants.popHospitalRecoveryPerLevel);
  assert.equal(p.constants.popHospitalRecoveryMax, app.config.constants.popHospitalRecoveryMax);
  // 每栋建筑下发 popCapByLevel（升级卡显示「本次升级获得的人口」用；反映覆盖）
  assert.ok(p.buildings.every((b: any) => Array.isArray(b.popCapByLevel) && b.popCapByLevel.length === app.config.buildings[b.kind].maxLevel), '每栋建筑应下发 popCapByLevel 数组（长度=maxLevel）');
  const mainMeta = p.buildings.find((b: any) => b.kind === 'main');
  const mainCfg = app.config.buildings.main;
  assert.deepEqual(mainMeta.popCapByLevel, Array.from({ length: mainCfg.maxLevel }, (_, i) => mainCfg.levels[i + 1].popCap), 'main.popCapByLevel 应等于 levels[].popCap');

  const vaultMeta = p.buildings.find((b: any) => b.kind === 'vault');
  const vaultCfg = app.config.buildings.vault;
  const vaultL1 = vaultCfg.levels[1]!;
  const vaultL2 = vaultCfg.levels[2]!;
  assert.ok(vaultMeta && Array.isArray(vaultMeta.vaultProtectionByLevel), '保险库应下发逐级累计保护量');
  assert.equal(vaultMeta.vaultProtectionByLevel.length, vaultCfg.maxLevel);
  assert.deepEqual(vaultMeta.vaultProtectionByLevel[1], {
    wood: (vaultL1.vaultProtectWood ?? 0) + (vaultL2.vaultProtectWood ?? 0),
    clay: (vaultL1.vaultProtectClay ?? 0) + (vaultL2.vaultProtectClay ?? 0),
    iron: (vaultL1.vaultProtectIron ?? 0) + (vaultL2.vaultProtectIron ?? 0),
    crop: (vaultL1.vaultProtectCrop ?? 0) + (vaultL2.vaultProtectCrop ?? 0),
    gold: (vaultL1.vaultProtectGold ?? 0) + (vaultL2.vaultProtectGold ?? 0),
  }, '保险库卡片应显示当前等级累计保护量');
});
