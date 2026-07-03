import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGameConfig, validateGameConfig, type GameConfig } from '../infra/config.js';

/**
 * 配置中心测试：常量/模板被正确解析；校验器能在非法配置时抛错（启动即失败）。
 */

const configDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../config');

test('常量表：game_constants.csv 被解析为强类型', () => {
  const c = loadGameConfig(configDir).constants;
  assert.equal(c.wallBonusPerLevel, 0.03, '城墙加成');
  assert.equal(c.smithyBonusPerLevel, 0.1, '铁匠加成');
  assert.equal(c.mainBuildSpeedupCap, 0.6, '主基地提速上限');
  assert.equal(c.startResourceAmount, 750, '初始资源');
  assert.equal(c.storageBase, 800, '基础容量');
  assert.equal(c.mapSize, 20, '地图尺寸');
  assert.equal(c.mapViewRadius, 6, '视野半径');
});

test('开局模板：village_templates.csv 展开预置建筑', () => {
  const t = loadGameConfig(configDir).villageTemplates['romans'];
  assert.ok(t, '应有罗马模板');
  assert.equal(t.startPlaced.main, 1, '城镇中心 1 级');
  assert.equal(t.startPlaced.rallypoint, 1, '集结点 1 级');
  assert.equal(t.startPlaced.woodcutter, 1, '伐木场 1 级');
});

test('三区/槽位配置：buildings.zone 解析 + town_center_slots 曲线', () => {
  const cfg = loadGameConfig(configDir);
  assert.equal(cfg.buildings['main'].zone, 'center', '城镇中心归 center');
  assert.equal(cfg.buildings['warehouse'].zone, 'inner', '仓库归 inner');
  assert.equal(cfg.buildings['barracks'].zone, 'outer', '兵营归 outer');
  assert.equal(cfg.buildings['woodcutter'].zone, 'outer', '资源田归 outer');
  assert.equal(cfg.buildings['woodcutter'].resource, 'wood', '伐木场产木');
  assert.ok((cfg.buildings['woodcutter'].prodBase ?? 0) > 0, '资源田应有产量基数');
  // 城镇中心 1 级槽位配额
  const t1 = cfg.townCenterSlots[1];
  assert.ok(t1 && t1.inner > 0 && t1.outer > 0 && t1.queue >= 2, '开局应有城内/城外槽位与≥2队列');
});

test('校验器：合法配置不抛错', () => {
  const cfg = loadGameConfig(configDir);
  assert.doesNotThrow(() => validateGameConfig(cfg));
});

test('校验器：跨表引用非法（兵种所需建筑不存在）应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = { ...cfg, units: { ...cfg.units } };
  const anyUnit = Object.keys(bad.units)[0];
  bad.units[anyUnit] = { ...bad.units[anyUnit], building: 'no_such_building' };
  assert.throws(() => validateGameConfig(bad), /no_such_building/);
});

test('校验器：建筑 requires 循环依赖应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = { ...cfg, buildings: { ...cfg.buildings } };
  const codes = Object.keys(bad.buildings);
  const a = codes[0], b = codes[1];
  // 制造 a→b→a 的环
  bad.buildings[a] = { ...bad.buildings[a], requires: [{ kind: b, level: 1 }] };
  bad.buildings[b] = { ...bad.buildings[b], requires: [{ kind: a, level: 1 }] };
  assert.throws(() => validateGameConfig(bad), /循环依赖/);
});

test('兵种：新战斗模型列被解析（form/近远攻防/特性）', () => {
  const cfg = loadGameConfig(configDir);
  const leg = cfg.units['legionnaire'];
  assert.equal(leg.form, 'melee', '军团兵近战');
  assert.equal(leg.meleeAtk, 40);
  assert.equal(leg.meleeDef, 35);
  assert.equal(leg.rangedDef, 50);
  const cat = cfg.units['catapult'];
  assert.equal(cat.form, 'ranged', '投石机远程');
  assert.ok(cat.rangedAtk > 0, '远程兵应有远攻');
  // 持盾特性解析：禁卫兵引用 trait id=1(shield)
  assert.deepEqual(cfg.units['praetorian'].traits, ['shield']);
  assert.equal(cfg.unitTraits['shield'].effects[0].effect, 'dmg_taken_ranged');
  assert.equal(cfg.unitTraits['shield'].effects[0].value, -0.25);
});

test('校验器：兵种 form 非法应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = { ...cfg, units: { ...cfg.units } };
  const u = Object.keys(bad.units)[0];
  bad.units[u] = { ...bad.units[u], form: 'flying' as any };
  assert.throws(() => validateGameConfig(bad), /form/);
});

test('校验器：兵种引用不存在的特性应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = { ...cfg, units: { ...cfg.units } };
  const u = Object.keys(bad.units)[0];
  bad.units[u] = { ...bad.units[u], traits: ['no_such_trait'] };
  assert.throws(() => validateGameConfig(bad), /特性/);
});

test('特性：多效果特性正确展开', () => {
  const cfg = loadGameConfig(configDir);
  const multiTrait = {
    id: 99, code: 'heavy', name: '重甲',
    effects: [
      { effect: 'def_melee' as const, value: 0.10 },
      { effect: 'dmg_taken_ranged' as const, value: -0.15 },
    ],
  };
  const patchedConfig = {
    ...cfg,
    unitTraits: { ...cfg.unitTraits, heavy: multiTrait },
    units: {
      ...cfg.units,
      legionnaire: { ...cfg.units['legionnaire'], traits: ['heavy'] },
    },
  };
  assert.doesNotThrow(() => validateGameConfig(patchedConfig));
  assert.equal(patchedConfig.unitTraits['heavy'].effects.length, 2);
});
