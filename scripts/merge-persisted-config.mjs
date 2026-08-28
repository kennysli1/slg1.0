#!/usr/bin/env node
/**
 * Merge a persisted GM CSV over the canonical release CSV.
 *
 * The persisted file is an overlay, not a replacement: values for rows that
 * still exist in the canonical table are kept, while new canonical rows and
 * columns are imported automatically. Persisted-only rows are intentionally
 * ignored so a removed/renamed setting cannot resurrect on the next release.
 * Comments, ordering and the canonical header are preserved.
 *
 * Usage: node scripts/merge-persisted-config.mjs <canonical> <persisted> <name>
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [canonicalPath, persistedPath, fileName] = process.argv.slice(2);
if (!canonicalPath || !persistedPath || !fileName) {
  console.error('用法：merge-persisted-config.mjs <canonical> <persisted> <name>');
  process.exit(2);
}

// Stable identity for every persisted configuration table. The fallback is
// deliberately the first column so a newly added manifest table still gets a
// safe row-level merge instead of silently replacing the canonical file.
const KEY_COLUMNS = {
  'academy.csv': ['level'],
  'building_levels.csv': ['code', 'level'],
  'buildings.csv': ['id'],
  'dialogues.csv': ['id'],
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

const persistedColumns = new Set(persisted.header);
for (let i = 0; i < canonical.rows.length; i += 1) {
  const target = canonical.rows[i];
  const overlay = persistedByKey.get(rowKey(target, keyColumns, `${fileName} 默认行`));
  if (!overlay) continue;
  // Only fields present in the canonical header can be overlaid. This keeps
  // newly removed fields out while preserving every manually edited value.
  for (const column of canonical.header) {
    if (!persistedColumns.has(column)) continue;
    const structural = CANONICAL_STRUCTURAL_FIELDS[fileName]?.[target.code];
    if (structural?.has(column)) continue;
    // A blank in an old shared row means “no override” for a newly introduced
    // numeric/config column. Do not let it erase a non-empty canonical default
    // (notably tavern.taskSideQuestChance=0.5). Explicit zero remains a real
    // override because it is serialized as the string "0".
    if ((overlay[column] ?? '') === '' && (target[column] ?? '') !== '') continue;
    target[column] = overlay[column] ?? '';
  }
}

for (let i = 0; i < canonical.raw.length; i += 1) {
  const dataPos = canonical.rowIndices.indexOf(i);
  if (dataPos !== -1) {
    const row = canonical.rows[dataPos];
    canonical.raw[i] = canonical.header.map((h) => row[h] ?? '').join(',');
  }
}
let output = canonical.raw.join('\n');
if (canonical.bom) output = `\ufeff${output}`;
const tempPath = join(dirname(canonicalPath), `.${fileName}.${process.pid}.merge-tmp`);
writeFileSync(tempPath, output, 'utf8');
renameSync(tempPath, canonicalPath);
