import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CsvRow } from './csv.js';

export type BalanceOverrides = Record<string, Record<string, Record<string, string>>>;

export interface BalanceTableMeta {
  file: string;
  key?: string;
  keyComposite?: string[];
  numeric?: string[];
  /** game_constants.csv 按行 type 列校验 number/bool，其余字段按文本保留。 */
  numericByType?: boolean;
}

export function loadBalanceOverrides(overridePath: string): BalanceOverrides {
  if (!existsSync(overridePath)) return {};
  try {
    const obj = JSON.parse(readFileSync(overridePath, 'utf8'));
    return obj && typeof obj === 'object' ? obj as BalanceOverrides : {};
  } catch {
    return {};
  }
}

export function saveBalanceOverrides(overridePath: string, overrides: BalanceOverrides): void {
  const tmp = overridePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf8');
  try {
    renameSync(tmp, overridePath);
  } catch {
    copyFileSync(tmp, overridePath);
    unlinkSync(tmp);
  }
}

export function mergeOverridesIntoRows(
  rows: CsvRow[],
  table: BalanceTableMeta,
  changes: Record<string, Record<string, string>>,
): CsvRow[] {
  const incByKey = new Map(Object.entries(changes));
  const compCols = table.keyComposite ?? [];
  return rows.map((orig) => {
    const keyVal = table.key
      ? String(orig[table.key] ?? '')
      : compCols.map((c) => String(orig[c] ?? '')).join('|');
    const inc = incByKey.get(keyVal);
    if (!inc) return orig;
    const merged = { ...orig };
    for (const [field, value] of Object.entries(inc)) {
      if (value === '') continue;
      if (table.numericByType) {
        const type = String(orig.type ?? 'number');
        if (type === 'number') {
          const number = Number(value);
          if (!Number.isFinite(number)) throw new Error(`${table.file} 行 ${keyVal} 字段 ${field}="${value}" 不是合法数字`);
          merged[field] = String(number);
        } else if (type === 'bool') {
          if (!['true', 'false', '0', '1'].includes(value)) throw new Error(`${table.file} 行 ${keyVal} 字段 ${field}="${value}" 不是合法 bool(true/false/0/1)`);
          merged[field] = value;
        } else {
          merged[field] = value;
        }
      } else if (table.numeric?.includes(field)) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${table.file} 行 ${keyVal} 字段 ${field}="${value}" 不是合法数字`);
        merged[field] = String(number);
      } else {
        merged[field] = value;
      }
    }
    return merged;
  });
}

export function mergeBalanceOverrides(existing: BalanceOverrides, incoming: BalanceOverrides): BalanceOverrides {
  const merged: BalanceOverrides = { ...existing };
  for (const [table, rows] of Object.entries(incoming)) {
    merged[table] = { ...(merged[table] ?? {}) };
    for (const [key, fields] of Object.entries(rows)) {
      merged[table][key] = { ...(merged[table][key] ?? {}), ...fields };
    }
  }
  return merged;
}
