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
  assert.equal(cfg.buildings['barracks'].zone, 'inner', '兵营归 inner（军事建筑迁入城内）');
  assert.equal(cfg.buildings['woodcutter'].zone, 'outer', '资源田归 outer');
  assert.equal(cfg.buildings['woodcutter'].resource, 'wood', '伐木场产木');
  assert.ok((cfg.buildings['woodcutter'].levels?.[1]?.prod ?? 0) > 0, '资源田第1级应有产量');
  // 城镇中心 1 级槽位配额
  const t1 = cfg.townCenterSlots[1];
  assert.ok(t1 && t1.inner > 0 && t1.outer > 0 && t1.queue >= 2, '开局应有城内/城外槽位与≥2队列');
});

test('校验器：合法配置不抛错', () => {
  const cfg = loadGameConfig(configDir);
  assert.doesNotThrow(() => validateGameConfig(cfg));
});

test('任务图：六表编译后保留任务线、目标、效果与关系', () => {
  const cfg = loadGameConfig(configDir);
  assert.equal(cfg.questGraph.lines.main_foundation.entryQuest, 'm1');
  assert.equal(cfg.questGraph.quests.s2.lineCode, 'show_of_force');
  assert.ok(cfg.questGraph.objectives.some((x) => x.questCode === 's2' && x.kind === 'carry_flag'));
  assert.ok(cfg.questGraph.effects.some((x) => x.questCode === 'm2' && x.params === 'iron:200|gold:150'));
  assert.ok(cfg.questGraph.edges.some((x) => x.fromQuest === 'm1' && x.toQuest === 'm2' && x.relation === 'requires'));
  // 旧运行时仍从编译后的兼容定义取得完全相同的实际奖励。
  assert.deepEqual(cfg.quests.m2.rewards.resources, { iron: 200, gold: 150 });
});

test('任务图校验：关系边引用不存在任务应拒绝', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    questGraph: { ...cfg.questGraph, edges: [...cfg.questGraph.edges, { id: 'bad', fromQuest: 'm1', toQuest: 'missing', relation: 'requires', order: 99 }] },
  };
  assert.throws(() => validateGameConfig(bad), /终点任务不存在/);
});

test('建筑逐级参数：building_levels.csv 被载入并覆盖 1..maxLevel', () => {
  const cfg = loadGameConfig(configDir);
  for (const b of Object.values(cfg.buildings)) {
    for (let lv = 1; lv <= b.maxLevel; lv++) {
      const ld = b.levels[lv];
      assert.ok(ld, `建筑 ${b.kind} 应有 level=${lv} 的逐级参数`);
      assert.ok(ld.popCap >= 0, `建筑 ${b.kind} level=${lv} popCap 应≥0`);
      if (b.resource !== undefined) assert.ok((ld.prod ?? -1) >= 0, `资源田 ${b.kind} level=${lv} 应有 prod`);
      else assert.equal(ld.prod, undefined, `非资源田 ${b.kind} level=${lv} 不应有 prod`);
    }
  }
  // 逐等级人口上限求和应等于「旧 popCapPerLevel × level」在 L10 时的值（1:1 迁移校验）
  const main = cfg.buildings['main'];
  const sumL10 = Object.values(main.levels).reduce((s, l) => s + l.popCap, 0);
  assert.equal(sumL10, 200, '主城 10 级每级 20，总和应为 200');
  const res = cfg.buildings['residence'];
  assert.equal(Object.keys(res.levels).length, 10, '居民楼应有 10 级');
});

test('超上限惩罚常量：pop_overcap_penalty_full_ratio 载入=2.0', () => {
  const c = loadGameConfig(configDir).constants;
  assert.equal(c.popOvercapPenaltyFullRatio, 2.0, '超上限惩罚拐点默认 2.0');
});

test('校验器：pop_overcap_penalty_full_ratio ≤1 应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, popOvercapPenaltyFullRatio: 1 },
  };
  assert.throws(() => validateGameConfig(bad), /pop_overcap_penalty_full_ratio/);
});

test('校验器：building_levels 缺级应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    buildings: {
      ...cfg.buildings,
      main: {
        ...cfg.buildings['main'],
        levels: (() => { const cp = { ...cfg.buildings['main'].levels }; delete cp[5]; return cp; })(),
      },
    },
  };
  assert.throws(() => validateGameConfig(bad), /building_levels/);
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
  // 多特性解析（| 分隔）：禁卫兵引用 trait 1(shield)+2(heavy_armor)，两个都应生效
  assert.deepEqual(cfg.units['praetorian'].traits, ['shield', 'heavy_armor']);
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

test('校验器：PvE 模板没有守军应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = { ...cfg, pveTemplates: { ...cfg.pveTemplates } };
  const p = Object.keys(bad.pveTemplates)[0];
  bad.pveTemplates[p] = { ...bad.pveTemplates[p], defender: {} };
  assert.throws(() => validateGameConfig(bad), /没有任何守军/);
});

test('校验器：PvE spawn 坐标可为负/超出 [0,W)×[0,H)（环面放置时归一，不再抛错）', () => {
  const cfg = loadGameConfig(configDir);
  const ok: GameConfig = {
    ...cfg,
    pveSpawns: [{ ...cfg.pveSpawns[0], q: cfg.constants.worldW + 5, r: -3 }],
  };
  // 环面世界里任何有限坐标都合法：放置时由 world.PlacePve 按 worldW/worldH 取模归一
  assert.doesNotThrow(() => validateGameConfig(ok));
});

test('校验器：PvE spawn 坐标非数值仍抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    pveSpawns: [{ ...cfg.pveSpawns[0], q: NaN as unknown as number, r: 0 }],
  };
  assert.throws(() => validateGameConfig(bad), /坐标非数值/);
});

test('校验器：关键常量范围非法应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, combatTickMs: 0, marchSpeedMultiplier: 0 },
  };
  assert.throws(() => validateGameConfig(bad), /combat_tick_ms|march_speed_multiplier/);
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

test('游戏设计约束表：军事科技、PvP曲线、佣兵合同与随机任务冷却均从 CSV 载入', () => {
  const cfg = loadGameConfig(configDir);
  const formation = cfg.research.melee_attack_iii;
  assert.deepEqual(formation.effects.map((e) => e.effectType), ['combat_atk']);
  assert.equal(cfg.mercCamp[1].capacity, 10);
  assert.equal(cfg.units.merc_champion.commandCost, 5);
  assert.equal(cfg.units.merc_champion.contractSec, 259200);
  assert.equal(cfg.quests.d1.repeatable, true);
  assert.equal(cfg.quests.d1.cooldownSec, 21600);
  assert.deepEqual(cfg.pvpPowerCurve.map((x) => x.lootMult), [1, 0.75, 0.5, 0.25, 0.1]);
  assert.equal(cfg.treasures.dragon_banner.effectCap, 50);
});
