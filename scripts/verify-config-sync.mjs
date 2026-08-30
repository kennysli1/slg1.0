#!/usr/bin/env node
/**
 * Validate a configuration-center change without asserting the current tuning
 * against the game's canonical defaults.
 *
 * Configuration CSV values are intentionally editable.  The ordinary unit
 * suite contains regression checks for the shipped defaults, so running it on
 * a config-sync PR would reject legitimate GM/config-center tuning.  This
 * check keeps the safety properties that matter for a config-only change:
 * every versioned table must be present and non-empty, the complete game
 * configuration must parse, and the cross-table validator must accept it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameConfig, validateGameConfig } from '../packages/server/src/infra/config.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configDir = join(root, 'config');

// These are the tables that the runtime loader owns.  Keeping the list here
// explicit makes a deleted/empty table fail before a deployment can hide it.
const requiredTables = [
  'academy.csv',
  'building_levels.csv',
  'buildings.csv',
  'dialogues.csv',
  'game_constants.csv',
  'mercenaries.csv',
  'research.csv',
  'trade_center.csv',
  'treasures.csv',
  'units.csv',
];

for (const file of requiredTables) {
  const path = join(configDir, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`[config-sync] 缺少配置表：${file}`);
  }
  const content = readFileSync(path, 'utf8').trim();
  if (!content) throw new Error(`[config-sync] 配置表为空：${file}`);
  if (!content.includes('\n')) throw new Error(`[config-sync] 配置表缺少数据行：${file}`);
}

const config = loadGameConfig(configDir);
validateGameConfig(config);

console.log(`[config-sync] 校验通过：${requiredTables.length} 张运行时配置表，允许当前调参值。`);
