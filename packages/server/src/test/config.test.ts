import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGameConfig, validateGameConfig, type GameConfig } from '../infra/config.js';
import { TaskCatalog } from '../modules/task/catalog.js';

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
  assert.equal(c.marchSizeReferencePop, 20, '军队规模减速基准人口');
  assert.equal(c.marchSizePenalty, 0.0015, '军队规模减速系数');
  assert.equal(c.marchSizeMinMultiplier, 0.45, '军队规模减速下限');
  assert.equal(c.tradeCaravanSpeed, 100, '商队速度默认值');
  assert.equal(c.tradeCaravanMinDurationSec, 3, '商队最低时长默认值');
  assert.equal(c.allianceProjectDurationSec, 10, '联盟建筑/科技默认耗时');
  assert.deepEqual(
    [c.allianceLogisticsRoleLevel, c.allianceWarRoleLevel, c.allianceTechRoleLevel, c.allianceAmbassadorRoleLevel],
    [1, 2, 3, 4],
    '联盟职位应按 1/2/3/4 级解锁',
  );
  assert.equal(c.allianceReputationBonusMaxMultiplier, 2, '联盟声望加成倍率上限');
  assert.ok(c.cavalryUnitCodes.includes('equlegati'), '骑兵代码配置应包含罗马骑兵');
  assert.ok(c.cavalryUnitCodes.includes('teutonknight'), '骑兵代码配置应包含条顿骑士');
});

test('猎马人支线与绞马索宝物配置已接入任务图', () => {
  const cfg = loadGameConfig(configDir);
  const hunter = cfg.quests.s5;
  assert.ok(hunter, '应存在猎马人支线');
  assert.equal(hunter?.type, 'side');
  assert.equal(hunter?.trigger, 'tavern_refresh');
  assert.deepEqual(hunter?.objective, { kind: 'kill_units', unitCategory: 'cavalry', count: 8 });
  assert.deepEqual(hunter?.rewards.treasures, ['horse_rope']);
  assert.equal(cfg.treasures.horse_rope.effectType, 'enemyCavalryDef');
  assert.equal(cfg.treasures.horse_rope.effectValue, 30);
  assert.equal(cfg.questGraph.conditions.filter((row) => row.questCode === 's5' && row.phase === 'offer').length, 2, '应同时有酒馆池与二级主基地前置');
});

test('开局模板：village_templates.csv 展开预置建筑', () => {
  const t = loadGameConfig(configDir).villageTemplates['romans'];
  assert.ok(t, '应有罗马模板');
  assert.equal(t.startPlaced.main, 1, '城镇中心 1 级');
  assert.equal(t.startPlaced.rallypoint, 1, '集结点 1 级');
  assert.equal(t.startPlaced.woodcutter, 0, '伐木场以 0 级受损占位');
  assert.deepEqual(t.startDamaged, {
    woodcutter: 1,
    claypit: 1,
    ironmine: 1,
    cropland: 1,
  }, '四种资源田应可修复至 1 级');
});

test('三区/槽位配置：buildings.zone 解析 + town_center_slots 曲线', () => {
  const cfg = loadGameConfig(configDir);
  assert.equal(cfg.buildings['main'].zone, 'center', '城镇中心归 center');
  assert.equal(cfg.buildings['warehouse'].zone, 'inner', '仓库归 inner');
  assert.equal(cfg.buildings['barracks'].zone, 'inner', '兵营归 inner（军事建筑迁入城内）');
  assert.equal(cfg.buildings['mercenarycamp'].zone, 'outer', '雇佣兵营地归 outer');
  assert.equal(cfg.buildings['council'].maxCount, 1, '议会厅每村最多 1 座');
  assert.equal(cfg.buildings['council'].mainBaseLevel, 2, '议会厅需要二级主基地');
  assert.equal(cfg.buildings['alliance_hall'].maxCount, 1, '联盟大厅每村最多 1 座');
  assert.equal(cfg.buildings['alliance_hall'].mainBaseLevel, 2, '联盟大厅需要二级主基地');
  assert.equal(cfg.buildings['woodcutter'].zone, 'outer', '资源田归 outer');
  assert.equal(cfg.buildings['woodcutter'].resource, 'wood', '伐木场产木');
  assert.ok((cfg.buildings['woodcutter'].levels?.[1]?.prod ?? 0) > 0, '资源田第1级应有产量');
  // 城镇中心 1 级槽位配额
  const t1 = cfg.townCenterSlots[1];
  assert.ok(t1 && t1.inner > 0 && t1.outer > 0 && t1.queue >= 2, '开局应有城内/城外槽位与≥2队列');
  assert.deepEqual(
    [1, 2, 3, 4].map((level) => [cfg.townCenterSlots[level]?.inner, cfg.townCenterSlots[level]?.outer]),
    [[4, 6], [8, 10], [12, 14], [16, 18]],
    '主基地每升一级应新增4个城内格和4个城外格',
  );
});

test('校验器：合法配置不抛错', () => {
  const cfg = loadGameConfig(configDir);
  assert.doesNotThrow(() => validateGameConfig(cfg));
  assert.deepEqual(Object.keys(cfg.allianceServices), ['alliance_supplies_small', 'alliance_reinforcement_guard']);
  assert.equal(cfg.allianceServices.alliance_supplies_small.category, 'supplies');
  assert.equal(cfg.allianceServices.alliance_reinforcement_guard.unitCode, 'legionnaire');
});

test('任务图：六表编译后保留任务线、目标、效果与关系', () => {
  const cfg = loadGameConfig(configDir);
  assert.equal(cfg.questGraph.lines.main_foundation.entryQuest, 'm1');
  assert.equal(cfg.questGraph.quests.s2.lineCode, 'show_of_force');
  assert.equal(cfg.quests.m1.scope, 'global', '主线必须是全局任务');
  assert.deepEqual(
    ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((code) => cfg.quests[code].name),
    ['初来乍到', '大兴土木', '人丁兴旺', '排除威胁', '那边有什么？', '国库充盈'],
    '主线名称应使用最新任务目录',
  );
  assert.equal(cfg.quests.d1.scope, 'village', '每日任务必须绑定村庄');
  assert.equal(cfg.quests.s4.scope, 'village', '当前支线默认绑定村庄');
  assert.ok(cfg.questGraph.objectives.some((x) => x.questCode === 's2' && x.kind === 'carry_flag'));
  assert.ok(cfg.questGraph.effects.some((x) => x.questCode === 'm1' && x.params === 'wood:100|clay:100|iron:100|crop:100'));
  assert.ok(cfg.questGraph.effects.some((x) => x.questCode === 'm2' && x.params === 'wood:150|clay:150|iron:150'));
  assert.ok(cfg.questGraph.effects.some((x) => x.questCode === 'm4' && x.params === 'gold:40'));
  assert.ok(cfg.questGraph.effects.some((x) => x.questCode === 'm6' && x.params === 'wood:200|clay:200|iron:200|crop:200'));
  assert.ok(cfg.questGraph.edges.some((x) => x.fromQuest === 'm1' && x.toQuest === 'm2' && x.relation === 'requires'));
  assert.ok(cfg.questGraph.edges.some((x) => x.fromQuest === 'm2' && x.toQuest === 'm3' && x.relation === 'requires'));
  assert.ok(cfg.questGraph.edges.some((x) => x.fromQuest === 'm4' && x.toQuest === 'm5' && x.relation === 'requires'));
  // 旧运行时仍从编译后的兼容定义取得完全相同的实际奖励。
  assert.deepEqual(cfg.quests.m1.rewards.resources, { wood: 100, clay: 100, iron: 100, crop: 100 });
  assert.deepEqual(cfg.quests.m2.rewards.resources, { wood: 150, clay: 150, iron: 150 });
  assert.deepEqual(cfg.quests.m4.rewards.resources, { gold: 40 });
  assert.deepEqual(cfg.quests.m6.rewards.resources, { wood: 200, clay: 200, iron: 200, crop: 200 });
  assert.equal(cfg.quests.s3.rewards.reputation, -1, 'S3 完成应从任务效果结算 -1 声望');
  assert.deepEqual(cfg.quests.s3.failureRewards?.treasures, ['secret_note'], 'S3 失败应显示秘密字条');
  assert.equal(cfg.quests.s4.failureRewards?.reputation, -2, 'S4 收纳失败应从任务效果结算 -2 声望');
  assert.equal(cfg.quests.m1.objective.kind, 'repair_buildings');
  assert.deepEqual(cfg.quests.m1.objective.buildingKinds, ['woodcutter', 'claypit', 'ironmine', 'cropland']);
  assert.equal(cfg.quests.m2.objective.kind, 'build_buildings');
  assert.equal(cfg.quests.m2.objective.buildingZone, 'inner');
  assert.equal(cfg.quests.m2.objective.count, 2);
  assert.equal(cfg.quests.m3.objective.kind, 'population_reached');
  assert.equal(cfg.quests.m3.objective.count, 30);
  assert.equal(cfg.quests.m4.objective.kind, 'clear_camp');
  assert.equal(cfg.quests.m4.objective.campTemplate, 'rats');
  assert.equal(cfg.quests.m5.objective.kind, 'explore_tiles');
  assert.equal(cfg.quests.m5.objective.count, 100);
  assert.equal(cfg.quests.m6.objective.kind, 'resource_owned');
  assert.equal(cfg.quests.m6.objective.resourceKey, 'gold');
  assert.equal(cfg.quests.m6.objective.count, 100);
  assert.equal(cfg.quests.m10.objective.kind, 'main_base_level');
  assert.equal(cfg.quests.m10.objective.count, 2, 'M10 目标为二级主基地');
  assert.deepEqual(cfg.quests.m10.rewards.resourceGrowth, { percent: 25, durationSec: 43200 }, 'M10 奖励四资源产量 +25%/12小时');
  assert.equal(cfg.quests.m11.trigger, 'main_base_level:2', 'M11 由二级主基地触发');
  assert.equal(cfg.quests.m11.objective.kind, 'explore_tiles');
  assert.equal(cfg.quests.m11.objective.count, 200);
  assert.deepEqual(cfg.quests.m11.rewards.buildingUnlocks, ['alliance_hall', 'council']);
  assert.ok(cfg.questGraph.lines.world_exploration, 'M11 应位于开眼看世界任务线');
  assert.equal(cfg.questGraph.lines.other_story.entryQuest, 'm13', '另一边的故事入口应为 M13');
  assert.equal(cfg.quests.m12.lineCode, 'world_exploration', 'M12 前置 M11，应归入开眼看世界任务线');
  assert.equal(cfg.quests.m13.lineCode, 'other_story', 'M13 应作为另一边的故事入口');
  assert.equal(cfg.quests.m14.lineCode, 'other_story', 'M14 应归入另一边的故事任务线');
  assert.equal(cfg.quests.m15.lineCode, 'other_story', 'M15 应归入另一边的故事任务线');
  assert.equal(cfg.quests.m16.lineCode, 'world_exploration', 'M16 应归入开眼看世界任务线');
  assert.deepEqual(cfg.quests.m16.requires, ['m12'], 'M16 前置应为 M12');
  assert.equal(cfg.quests.m16.objective.kind, 'reputation_at_least');
  assert.equal(cfg.quests.m16.objective.threshold, 10);
  assert.deepEqual(cfg.quests.m16.rewards.mercenaries, { merc_archer: 10 });
  assert.ok(cfg.questGraph.edges.some((edge) => edge.fromQuest === 'm12' && edge.toQuest === 'm16' && edge.relation === 'requires'));
  assert.deepEqual(cfg.quests.m14.objective.resources, { crop: 500 });
  assert.deepEqual(cfg.quests.m14.rewards.reputationMercenaryExchange, { unitCode: 'merc_sword', perPoint: 2 });
  assert.equal(cfg.quests.m15.objective.threshold, -5);
  assert.deepEqual(cfg.quests.m15.rewards.resourceGrowth, { resource: 'crop', percent: 25, durationSec: 86400 }, 'M15 只应提高粮食产量');
  assert.equal(cfg.quests.m7.objective.kind, 'research_completed');
  assert.equal(cfg.quests.m7.objective.count, 1);
  assert.equal(cfg.quests.m8.objective.kind, 'defend_task_village');
  assert.equal(cfg.quests.m8.objective.taskVillageCode, 'tianwang_village');
  assert.equal(cfg.quests.m9.objective.kind, 'raid_task_village');
  assert.equal(cfg.quests.m9.objective.taskVillageCode, 'tianwang_village');
  assert.deepEqual(cfg.quests.m7.rewards, { researchPoints: 3 }, 'M7 应奖励 3 科技点');
  assert.deepEqual(cfg.quests.m8.rewards.treasures, ['iron_wall_medal'], 'M8 应奖励铁壁勋章');
  assert.equal(cfg.quests.m9.conditionalRewards?.m8_success?.population, 5, 'M8 成功时 M9 应奖励 5 人口');
  assert.deepEqual(cfg.quests.m9.conditionalRewards?.m8_failure?.treasures, ['iron_wall_medal'], 'M8 失败时 M9 应奖励铁壁勋章');
  assert.equal(cfg.quests.m3.rewards.population, 5, 'M3 应奖励 5 人口');
  assert.equal(cfg.quests.m3.rewards.resources, undefined, 'M3 改为人口奖励后不应再发旧资源');
  assert.deepEqual(cfg.quests.m3.rewards.treasures, undefined, 'M3 改为人口奖励后不应再发旧宝物');
  assert.deepEqual(cfg.quests.m5.rewards.populationGrowth, { percent: 10, durationSec: 86400 }, 'M5 应奖励 +10% 人口增长24小时');
  assert.equal(cfg.quests.m5.rewards.resources, undefined, 'M5 改为人口增长奖励后不应再发旧金币');
  assert.ok(cfg.questGraph.conditions.some((x) => x.id === 'c-m1-clean' && x.phase === 'success' && x.kind === 'no_damaged_resource_level'), 'M1 应有隐藏 success 兜底条件');
  assert.deepEqual(cfg.quests.s4.choiceRewards?.find((x) => x.key === 'store')?.rewards.treasures, ['captured_natalies']);
  assert.equal(cfg.quests.s4.choiceRewards?.find((x) => x.key === 'release')?.rewards.reputation, 2);
  assert.equal(cfg.quests.s1.trigger, 'tavern_refresh', 'S1 应由酒馆任务槽刷新触发');
  assert.equal(cfg.quests.s7.name, '这下来真的了');
  assert.deepEqual(cfg.quests.s7.objective, { kind: 'dice_match', count: 2, diceDifficulty: 'easy', diceTargetScore: 2000, diceWinsRequired: 2 });
  assert.deepEqual(cfg.quests.s7.acceptCost, { gold: 100 });
  assert.deepEqual(cfg.quests.s7.rewards.resources, { gold: 200 });
  assert.equal(cfg.quests.s8.name, '有高手');
  assert.deepEqual(cfg.quests.s8.objective, { kind: 'dice_match', count: 2, diceDifficulty: 'normal', diceTargetScore: 4000, diceWinsRequired: 2 });
  assert.deepEqual(cfg.quests.s8.acceptCost, { gold: 150 });
  assert.deepEqual(cfg.quests.s8.rewards.resources, { gold: 300 });
  assert.ok(cfg.quests.s8.requires.includes('s7'));
  assert.equal(cfg.quests.s9.name, '巅峰对决');
  assert.deepEqual(cfg.quests.s9.objective, { kind: 'dice_match', count: 2, diceDifficulty: 'hard', diceTargetScore: 6000, diceWinsRequired: 2 });
  assert.deepEqual(cfg.quests.s9.acceptCost, { gold: 200 });
  assert.deepEqual(cfg.quests.s9.rewards.resources, { gold: 400 });
  assert.deepEqual(cfg.quests.s9.rewards.treasures, ['dice_trophy']);
  assert.ok(cfg.quests.s9.requires.includes('s8'));
  assert.equal(cfg.treasures.dice_trophy.reputationValue, 10);
  assert.equal(cfg.treasures.dice_trophy.priceGold, 600);
  assert.ok(cfg.questGraph.conditions.some((row) => row.questCode === 's7' && row.kind === 'treasure_used' && row.value === 'dice_tournament_ticket'), 's7 应要求使用骰子入场券');
  for (const code of ['s1', 's2', 's3', 's4']) {
    assert.ok(cfg.dialogues[`${code}_accept:1`], `${code} 应有默认接取对话模板`);
    assert.ok(cfg.dialogues[`${code}_deliver:1`], `${code} 应有默认交付对话模板`);
  }
});

test('任务运行时目录：以任务图分组，并保持既有 QuestDef 兼容投影', () => {
  const cfg = loadGameConfig(configDir);
  const catalog = new TaskCatalog(cfg);
  const s4 = catalog.get('s4');
  assert.ok(s4, '配置中的每个任务图节点都应有运行时目录项');
  assert.equal(s4.node, cfg.questGraph.quests.s4, '图节点保持为 CSV 编译结果');
  assert.equal(s4.legacy, cfg.quests.s4, '旧执行器继续使用相同的兼容投影');
  assert.ok(s4.objectives.some((row) => row.kind === 'clear_camp'));
  assert.ok(s4.effects.some((row) => row.kind === 'natalie_choice'));
  assert.ok(s4.edges.length >= 1, '任务关系不应在运行时目录中丢失');
});

test('交付对话：配置中心可编辑回复，运行时保留有效按钮配置', () => {
  const cfg = loadGameConfig(configDir);
  const deliver = Object.values(cfg.dialogues).filter((dialogue) => dialogue.trigger === 'deliver');
  assert.ok(deliver.length > 0, '应存在 deliver 对话');
  for (const dialogue of deliver) {
    // 对话按钮由配置中心决定：空 replies 合法，不能用出厂默认按钮
    // 反向覆盖管理员已经保存的对话。仍校验每个显式按钮的结构和唯一性。
    assert.ok(Array.isArray(dialogue.replies), `${dialogue.code}#${dialogue.segment} replies 应为数组`);
    const keys = new Set<string>();
    for (const reply of dialogue.replies) {
      assert.ok(reply.key && reply.label, `${dialogue.code}#${dialogue.segment} 存在空回复`);
      assert.equal(keys.has(reply.key), false, `${dialogue.code}#${dialogue.segment} 回复 key 重复`);
      keys.add(reply.key);
    }
  }
});

test('M7-M9 与冒险者协会配置：任务村、倒计时、通用冒险者兵种均从 CSV 载入', () => {
  const cfg = loadGameConfig(configDir);
  assert.ok(cfg.constants.m8AttackDelaySec > 0, 'M8 攻城倒计时应来自可调配置且为正数');
  assert.equal(cfg.constants.m8TaskVillageResourceAmount, 500);
  assert.equal(cfg.constants.m8TaskVillageGold, 500);
  assert.equal(cfg.buildings.explorers_guild.zone, 'outer');
  assert.equal(cfg.buildings.explorers_guild.maxLevel, 1);
  assert.equal(cfg.units.adventurer.tribe, 'all');
  assert.equal(cfg.units.adventurer.building, 'explorers_guild');
  assert.equal(cfg.units.adventurer.attack, 10);
  assert.equal(cfg.units.adventurer.defense, 4);
  assert.equal(cfg.pveTemplates.tianwang_village.name, '天王老子村');
  assert.deepEqual(cfg.pveTemplates.tianwang_village.loot, { wood: 500, clay: 500, iron: 500, crop: 500 }, '天王老子村模板应标记四种资源各 500');
  assert.equal(cfg.pveTemplates.tianwang_village.defender.clubswinger.count, 15);
  assert.equal(cfg.pveTemplates.tianwang_village.defender.clubswinger.attack, cfg.units.clubswinger.attack, '天王老子村应使用条顿棍棒兵战斗属性');
  assert.ok(cfg.dialogues['m8_deliver:1'], 'M8 成功交付对话应并入默认 deliver');
  assert.match(cfg.dialogues['m8_deliver:1']?.npcText ?? '', /英明的战略决策/);
  assert.ok(cfg.dialogues['m9_accept_m8_failure:1'], 'M9 失败分支对话代码应明确标注 M8 结局');
  assert.ok(cfg.dialogues['m9_accept:1'], 'M9 成功接取对话应并入默认 accept');
  assert.match(cfg.dialogues['m9_accept:1']?.npcText ?? '', /乘胜追击/);
  assert.ok(cfg.dialogues['m9_deliver_m8_failure:1'], 'M9 失败交付对话代码应明确标注 M8 结局');
  assert.ok(cfg.dialogues['m9_deliver:1'], 'M9 成功交付对话应并入默认 deliver');
  assert.match(cfg.dialogues['m9_deliver:1']?.npcText ?? '', /洗劫干净/);
  assert.equal(cfg.dialogues['m8_deliver_success:1'], undefined, 'M8 成功分支旧 entry 应移除');
  assert.equal(cfg.dialogues['m9_accept_m8_success:1'], undefined, 'M9 成功接取旧 entry 应移除');
  assert.equal(cfg.dialogues['m9_deliver_m8_success:1'], undefined, 'M9 成功交付旧 entry 应移除');
  assert.equal(cfg.dialogues['s3_accept:2'], undefined, 'S3 接取对话不应包含 after_accept 第二段');
  assert.equal(cfg.dialogues['s3_after_accept:1']?.npcText, '领主大人，据我所知隔壁幸福村妇女权益比较低，他们不应该会打着妇女儿童的旗号索求援助啊？');
  assert.match(cfg.dialogues['m12_accept:1']?.npcText ?? '', /\{villageName\}/, 'M12 接取文本应使用村庄变量');
  assert.match(cfg.dialogues['m12_accept:1']?.npcText ?? '', /\{fiefName\}/, 'M12 接取文本应使用封地变量');
  assert.doesNotMatch(cfg.dialogues['m12_accept:1']?.npcText ?? '', /\{封地\}/, 'M12 配置不应保存中文封地占位符');
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
  assert.deepEqual(
    Object.values(cfg.buildings.alliance_hall.levels ?? {}).map((level) => level.timeSec),
    Array.from({ length: 10 }, () => 10),
    '联盟大厅 1-10 级默认建造时间应与配置中心全十秒版本一致',
  );
  // 主基地固定四级；逐级人口上限增量由配置中心决定，不在测试中硬编码。
  const main = cfg.buildings['main'];
  assert.equal(main.name, '主基地', '主基地显示名应统一');
  assert.deepEqual(Object.keys(main.levels), ['1', '2', '3', '4'], '主基地只应有 1..4 级');
  const sumMain = Object.values(main.levels).reduce((s, l) => s + l.popCap, 0);
  assert.ok(sumMain > 0, '主基地满级应提供正的人口上限');
  const res = cfg.buildings['residence'];
  assert.equal(Object.keys(res.levels).length, 10, '居民楼应有 10 级');
  assert.equal(cfg.buildings['alchemy'].maxLevel, 1, '炼金炉最高等级应固定为 1');
  assert.deepEqual(Object.keys(cfg.buildings['alchemy'].levels), ['1'], '炼金炉只应有 1 级升级参数');
  assert.equal(cfg.buildings.tavern.levels[1].taskSideQuestChance, 0.5, '酒馆支线刷新概率默认应为 0.5');
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
        levels: (() => { const cp = { ...cfg.buildings['main'].levels }; delete cp[3]; return cp; })(),
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

test('兵种：新战斗模型列被解析（攻击/防御/生命）', () => {
  const cfg = loadGameConfig(configDir);
  const leg = cfg.units['legionnaire'];
  assert.equal(leg.attack, 59.04);
  assert.equal(leg.defense, 45.11);
  assert.equal(leg.hp, 280.14);
  const cat = cfg.units['catapult'];
  assert.ok(cat.attack > 0 && cat.defense > 0 && cat.hp > 0, '所有兵种只需三项战斗属性');
  assert.equal(cfg.units.phalanx.defense, 47.39);
  assert.equal(cfg.units.clubswinger.attack, 82.37);
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

test('校验器：军队规模参数范围非法应抛错', () => {
  const cfg = loadGameConfig(configDir);
  const badReference: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, marchSizeReferencePop: -1 },
  };
  assert.throws(() => validateGameConfig(badReference), /march_size_reference_pop/);
  const badPenalty: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, marchSizePenalty: -0.1 },
  };
  assert.throws(() => validateGameConfig(badPenalty), /march_size_penalty/);
  const badMinimum: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, marchSizeMinMultiplier: 1.1 },
  };
  assert.throws(() => validateGameConfig(badMinimum), /march_size_min_multiplier/);
});

test('校验器：商队速度必须为正', () => {
  const cfg = loadGameConfig(configDir);
  const bad: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, tradeCaravanSpeed: 0 },
  };
  assert.throws(() => validateGameConfig(bad), /trade_caravan_speed/);
  const badMinimum: GameConfig = {
    ...cfg,
    constants: { ...cfg.constants, tradeCaravanMinDurationSec: 0 },
  };
  assert.throws(() => validateGameConfig(badMinimum), /trade_caravan_min_duration_sec/);
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
  assert.equal(cfg.constants.popProsperityMaxBonus, 0.30);
  assert.deepEqual(cfg.pvpPowerCurve.map((x) => x.lootMult), [1, 0.75, 0.5, 0.25, 0.1]);
  assert.equal(cfg.treasures.dragon_banner.effectCap, 50);
});
