import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = join(root, 'config');

function readTable(name) {
  const path = join(configDir, name);
  const source = readFileSync(path, 'utf8');
  const bom = source.startsWith('\ufeff') ? '\ufeff' : '';
  const lines = source.replace(/^\ufeff/, '').trimEnd().split(/\r?\n/);
  const header = lines[0].split(',');
  const comments = lines.slice(1).filter((line) => line.startsWith('#'));
  const rows = lines.slice(1).filter((line) => line && !line.startsWith('#')).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
  });
  return { path, bom, header, comments, rows };
}

function writeTable(table) {
  const lines = [table.header.join(','), ...table.comments];
  for (const row of table.rows) lines.push(table.header.map((key) => row[key] ?? '').join(','));
  writeFileSync(table.path, table.bom + lines.join('\n') + '\n', 'utf8');
}

function setConstant(rows, key, value, description) {
  const row = rows.find((entry) => entry.key === key);
  if (row) {
    row.value = String(value);
    if (description) row.description = description;
    return;
  }
  rows.push({ key, value: String(value), type: 'number', description });
}

const constants = readTable('game_constants.csv');
const balanceAlreadyApplied = constants.rows.some((row) => row.key === 'release_balance_version' && row.value === '1');
const constantValues = {
  storage_base: 5000,
  start_resource_amount: 1500,
  start_gold_amount: 500,
  gold_tax_per_civilian_per_hour: 1,
  found_min_main_level: 4,
  found_resource_cost_base: 3000,
  trade_order_ttl_sec: 43200,
  treasure_camp_drop_chance: 0.12,
  treasure_npc_offer_chance: 0.15,
  villager_request_trigger_chance: 0.2,
  kingdom_task_initial_min_sec: 1800,
  kingdom_task_initial_max_sec: 3600,
  kingdom_task_interval_min_sec: 21600,
  kingdom_task_interval_max_sec: 43200,
  kingdom_task_duration_sec: 43200,
  kingdom_reinforcement_duration_sec: 21600,
  m8_attack_delay_sec: 3600,
  alliance_project_duration_sec: 21600,
  sanctum_first_hold_sec: 21600,
  sanctum_repeat_personal_cooldown_sec: 21600,
  sanctum_repeat_pvp_pair_cooldown_sec: 43200,
};
for (const [key, value] of Object.entries(constantValues)) setConstant(constants.rows, key, value);
setConstant(constants.rows, 'season_settlement_min_days', 7, '正式服赛季最早结算日；仅定义窗口 不自动刷档');
setConstant(constants.rows, 'season_settlement_max_days', 10, '正式服赛季最晚结算日；结算后重置仍需人工备份与授权');
setConstant(constants.rows, 'release_balance_version', 1, '正式服数值基线版本；生成脚本据此避免重复放大倍率');
writeTable(constants);

const buildings = readTable('building_levels.csv');
const categoryMultiplier = {
  main: 0.6, woodcutter: 0.7, claypit: 0.7, ironmine: 0.7, cropland: 0.7,
  warehouse: 0.8, granary: 0.8, barracks: 1, stable: 1.1, workshop: 1.2,
  academy: 1.1, smithy: 1.1, wall: 1, rallypoint: 0.7, hospital: 1.1,
  residence: 1, treasury: 1, tavern: 0.9, vault: 1, council: 1.1,
  mercenarycamp: 1, tradecenter: 1, explorers_guild: 0.8, alliance_hall: 1.3, alchemy: 1.1,
};
const timeWeights = buildings.rows.map((row) => {
  const level = Number(row.level);
  return Math.pow(level, 1.85) * (categoryMultiplier[row.code] ?? 1);
});
const targetRawBuildSeconds = 10 * 24 * 60 * 60;
const secondsPerWeight = targetRawBuildSeconds / timeWeights.reduce((sum, value) => sum + value, 0);
let assignedBuildSeconds = 0;
for (let index = 0; index < buildings.rows.length; index++) {
  const row = buildings.rows[index];
  const level = Number(row.level);
  const multiplier = categoryMultiplier[row.code] ?? 1;
  const perResource = Math.max(20, Math.round(80 * Math.pow(1.75, level - 1) * multiplier));
  const oldCosts = ['costWood', 'costClay', 'costIron', 'costCrop'].map((key) => Math.max(1, Number(row[key]) || 1));
  const oldAverage = oldCosts.reduce((sum, value) => sum + value, 0) / oldCosts.length;
  ['costWood', 'costClay', 'costIron', 'costCrop'].forEach((key, costIndex) => {
    row[key] = String(Math.max(1, Math.round(perResource * oldCosts[costIndex] / oldAverage)));
  });
  row.costGold = String(Math.max(1, Math.round(perResource * 0.02)));
  const seconds = Math.max(60, Math.round(timeWeights[index] * secondsPerWeight));
  row.timeSec = String(seconds);
  assignedBuildSeconds += seconds;
  if (row.code === 'warehouse' || row.code === 'granary') {
    row.storagePerLevel = String([1000, 1500, 2500, 4000, 6000, 9000, 13000, 18000, 24000, 32000][level - 1]);
  }
  if (row.code === 'tavern') {
    row.taskRefreshSec = String([21600, 18000, 14400, 10800, 7200][level - 1]);
    row.taskSideQuestChance = '0.2';
  }
}
const lastBuilding = buildings.rows.at(-1);
lastBuilding.timeSec = String(Number(lastBuilding.timeSec) + targetRawBuildSeconds - assignedBuildSeconds);
writeTable(buildings);

const research = readTable('research.csv');
const durationByTier = { 1: 7200, 2: 21600, 3: 43200, 4: 72000 };
const rpByTier = { 1: 2, 2: 5, 3: 10, 4: 16 };
for (const row of research.rows) {
  row.durationSec = String(durationByTier[Number(row.tier)]);
  row.rpCost = String(rpByTier[Number(row.tier)]);
}
writeTable(research);

const academy = readTable('academy.csv');
for (const row of academy.rows) {
  const level = Number(row.level);
  row.checkIntervalSec = String(Math.round(3600 - (level - 1) * (2400 / 9)));
  row.baseProbability = (0.25 + (level - 1) * (0.45 / 9)).toFixed(2);
  row.probabilityGainPerFail = '0.05';
  row.maxProbability = '0.95';
}
writeTable(academy);

const units = readTable('units.csv');
for (const row of units.rows) {
  if (!balanceAlreadyApplied) {
    for (const key of ['costWood', 'costClay', 'costIron', 'costCrop']) {
      row[key] = String(Math.max(1, Math.round((Number(row[key]) || 0) * 10)));
    }
    row.trainSec = String(Math.min(3600, Math.max(180, Math.round((Number(row.trainSec) || 10) * 30))));
  }
}
const teutonSettler = units.rows.find((row) => row.code === 'teusettler');
if (teutonSettler) teutonSettler.popCost = '5';
writeTable(units);

const trade = readTable('trade_center.csv');
for (const row of trade.rows) row.npcRefreshSec = '1800';
writeTable(trade);

const mercenaryCamp = readTable('merc_camp.csv');
for (const row of mercenaryCamp.rows) {
  const level = Number(row.level);
  row.refreshSec = String(Math.round(21600 - (level - 1) * (14400 / 9)));
}
writeTable(mercenaryCamp);

console.log('Applied release balance: building raw budget=10d (2 queues≈5d), research graduation=5d, settlement=7–10d.');
