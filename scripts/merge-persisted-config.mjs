#!/usr/bin/env node
/**
 * Merge a persisted GM CSV over the canonical release CSV.
 *
 * The config center is authoritative for every column it already knows,
 * including explicit blank values. Canonical Git config contributes only new
 * columns/rows and structural fields. Config-center-only rows are retained;
 * rows explicitly deleted in the editor are removed through the optional
 * tombstone metadata file. Comments, ordering and the canonical header are
 * preserved.
 *
 * Usage: node scripts/merge-persisted-config.mjs <canonical> <persisted> <name> [tombstones]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [canonicalPath, persistedPath, fileName, tombstonesPath] = process.argv.slice(2);
if (!canonicalPath || !persistedPath || !fileName) {
  console.error('用法：merge-persisted-config.mjs <canonical> <persisted> <name> [tombstones]');
  process.exit(2);
}

// Stable identity for every persisted configuration table. The fallback is
// deliberately the first column so a newly added manifest table still gets a
// safe row-level merge instead of silently replacing the canonical file.
const KEY_COLUMNS = {
  'academy.csv': ['level'],
  'building_levels.csv': ['code', 'level'],
  'buildings.csv': ['id'],
  // Dialogue ids identify the dialogue object, so multiple ordered segments
  // intentionally share one id.  The code + segment pair is the row identity.
  'dialogues.csv': ['code', 'segment'],
  'game_constants.csv': ['key'],
  'kingdom_services.csv': ['id'],
  'merc_camp.csv': ['level'],
  'mercenaries.csv': ['id'],
  'pve_defenders.csv': ['targetId', 'unitCode'],
  'pve_spawns.csv': ['id'],
  'pve_targets.csv': ['id'],
  'pvp_power_curve.csv': ['maxRatio'],
  'quest_conditions.csv': ['id'],
  'quest_edges.csv': ['id'],
  'quest_effects.csv': ['id'],
  'quest_lines.csv': ['code'],
  'quest_objectives.csv': ['id'],
  'quests.csv': ['id'],
  'research_effects.csv': ['techCode', 'order'],
  'research.csv': ['id'],
  'resources.csv': ['id'],
  'town_center_slots.csv': ['tcLevel'],
  'trade_center.csv': ['level'],
  'treasures.csv': ['id'],
  'unit_traits.csv': ['id'],
  'units.csv': ['id'],
  'village_templates.csv': ['tribe'],
};

// Some schema migrations intentionally narrow a structural limit.  The old
// town-center table used ten levels, while the main-base model is fixed at
// four stages.  A shared CSV produced before that migration may still carry
// `main.maxLevel=10`; treating it as a player override would make the new
// four-row town_center_slots table fail validation on every release.  Keep the
// new canonical structural limit, while continuing to preserve all actual
// tuning fields from the shared CSV.
const CANONICAL_STRUCTURAL_FIELDS = {
  // The main-base stage model owns both the four-stage limit and its
  // canonical display name. Older shared CSVs may still say 城镇中心 and
  // must not overwrite the release definition 主基地.
  'buildings.csv': { main: new Set(['maxLevel', 'name']) },
};

function parse(text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const clean = bom ? text.slice(1) : text;
  const raw = clean.split(/\r?\n/);
  let headerIndex = -1;
  let header = [];
  const rows = [];
  const rowIndices = [];
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (headerIndex === -1) {
      headerIndex = i;
      header = line.split(',').map((h) => h.trim());
      continue;
    }
    const cells = line.split(',');
    const row = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').trim()]));
    rows.push(row);
    rowIndices.push(i);
  }
  if (headerIndex === -1 || header.length === 0) throw new Error('CSV 缺少表头');
  return { bom, raw, header, headerIndex, rows, rowIndices };
}

function rowKey(row, columns, label) {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === undefined || value === '')) {
    throw new Error(`${label} 缺少主键列 ${columns.join('+')}`);
  }
  return values.join('\u001f');
}

function readTombstones(path, name, columns) {
  if (!path || !existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed?.version !== 1 || !parsed.tables || typeof parsed.tables !== 'object' || Array.isArray(parsed.tables)) {
    throw new Error('配置行删除记录格式无效');
  }
  const rows = parsed.tables[name] ?? [];
  if (!Array.isArray(rows)) throw new Error(`${name} 配置行删除记录必须是数组`);
  const result = new Set();
  for (const values of rows) {
    if (!Array.isArray(values) || values.length !== columns.length
      || values.some((value) => typeof value !== 'string' || value === '')) {
      throw new Error(`${name} 配置行删除记录主键无效`);
    }
    const key = values.join('\u001f');
    if (result.has(key)) throw new Error(`${name} 配置行删除记录主键重复：${key}`);
    result.add(key);
  }
  return result;
}

const canonical = parse(readFileSync(canonicalPath, 'utf8'));
const persisted = parse(readFileSync(persistedPath, 'utf8'));
const keyColumns = KEY_COLUMNS[fileName] ?? [canonical.header[0]];
for (const column of keyColumns) {
  if (!canonical.header.includes(column)) throw new Error(`${fileName} 主键列不存在：${column}`);
  if (!persisted.header.includes(column)) throw new Error(`${fileName} 持久化 CSV 缺少主键列：${column}`);
}

const persistedByKey = new Map();
for (const row of persisted.rows) {
  const key = rowKey(row, keyColumns, `${fileName} 持久化行`);
  if (persistedByKey.has(key)) throw new Error(`${fileName} 持久化 CSV 主键重复：${key}`);
  persistedByKey.set(key, row);
}

const tombstones = readTombstones(tombstonesPath, fileName, keyColumns);
for (const key of tombstones) {
  if (persistedByKey.has(key)) {
    throw new Error(`${fileName} 同一行同时存在于共享 CSV 和删除记录：${key}`);
  }
}

const persistedColumns = new Set(persisted.header);
const canonicalKeys = new Set();
const removedCanonicalRows = new Set();
for (let i = 0; i < canonical.rows.length; i += 1) {
  const target = canonical.rows[i];
  const key = rowKey(target, keyColumns, `${fileName} 默认行`);
  canonicalKeys.add(key);
  if (tombstones.has(key)) {
    removedCanonicalRows.add(i);
    continue;
  }
  const overlay = persistedByKey.get(key);
  if (!overlay) continue;
  // Only fields present in the canonical header can be overlaid. This keeps
  // newly removed fields out while preserving every manually edited value.
  for (const column of canonical.header) {
    if (!persistedColumns.has(column)) continue;
    const structural = CANONICAL_STRUCTURAL_FIELDS[fileName]?.[target.code];
    if (structural?.has(column)) continue;
    // Presence in the persisted header means the config center owns this
    // cell. An empty string is an explicit clear, not "no override". A Git
    // default is used only when the persisted CSV predates the whole column.
    target[column] = overlay[column] ?? '';
  }
}

// Rows created in the config center must survive code deployments even before
// their asynchronous config PR reaches main. Git-only rows are already kept by
// the canonical iteration above; explicit editor deletions are represented by
// tombstones so they are not confused with newly introduced canonical rows.
const persistedOnlyRows = [];
for (const row of persisted.rows) {
  const key = rowKey(row, keyColumns, `${fileName} 持久化行`);
  if (canonicalKeys.has(key)) continue;
  persistedOnlyRows.push(Object.fromEntries(canonical.header.map((column) => [column, row[column] ?? ''])));
}

const dataPositionByRawIndex = new Map(canonical.rowIndices.map((rawIndex, dataPosition) => [rawIndex, dataPosition]));
const outputRaw = [];
for (let i = 0; i < canonical.raw.length; i += 1) {
  const dataPos = dataPositionByRawIndex.get(i);
  if (dataPos !== undefined) {
    if (removedCanonicalRows.has(dataPos)) continue;
    const row = canonical.rows[dataPos];
    outputRaw.push(canonical.header.map((h) => row[h] ?? '').join(','));
  } else {
    outputRaw.push(canonical.raw[i]);
  }
}
let insertAt = outputRaw.length;
while (insertAt > 0 && outputRaw[insertAt - 1].trim() === '') insertAt -= 1;
outputRaw.splice(insertAt, 0, ...persistedOnlyRows.map((row) => canonical.header.map((h) => row[h] ?? '').join(',')));
let output = outputRaw.join('\n');
if (canonical.bom) output = `\ufeff${output}`;
const tempPath = join(dirname(canonicalPath), `.${fileName}.${process.pid}.merge-tmp`);
writeFileSync(tempPath, output, 'utf8');
renameSync(tempPath, canonicalPath);
