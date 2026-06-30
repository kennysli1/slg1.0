import { readFileSync } from 'node:fs';

/**
 * 基础设施 · CSV 配置加载器
 * 把 config/*.csv 解析成对象数组。无第三方依赖，支持：
 *  - 首行表头
 *  - 逗号分隔（值内不含逗号——配置表场景足够）
 *  - 自动跳过空行
 *  - 数字字段由调用方按需转换（这里统一返回字符串，registry 负责转型）
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const row: CsvRow = {};
    headers.forEach((h, j) => {
      row[h] = (cells[j] ?? '').trim();
    });
    rows.push(row);
  }
  return rows;
}

export function loadCsv(path: string): CsvRow[] {
  return parseCsv(readFileSync(path, 'utf8'));
}

/** 数字转换助手（空串/非法 → 默认值）。 */
export function num(v: string | undefined, def = 0): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
