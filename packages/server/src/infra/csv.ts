import { readFileSync } from 'node:fs';

/**
 * 基础设施 · CSV 配置加载器
 * 把 config/*.csv 解析成对象数组。无第三方依赖，支持：
 *  - 首行表头
 *  - 逗号分隔（值内不含逗号——配置表场景足够）
 *  - 自动跳过空行
 *  - 跳过 BOM（兼容 Excel 以 UTF-8 打开，避免中文乱码）
 *  - 跳过「注释行」：首列以 # 开头的整行（给人看的中文字段说明，代码不读）
 *  - 数字字段由调用方按需转换（这里统一返回字符串，registry 负责转型）
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  // 去掉可能存在的 UTF-8 BOM，否则首个表头名会带不可见的
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // 跳过注释行：首列以 # 开头（中文字段说明，仅供配置时阅读）
    if (lines[i].trimStart().startsWith('#')) continue;
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
