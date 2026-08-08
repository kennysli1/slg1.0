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

/**
 * 结构化解析：保留注释行、表头列序与数据行列序，便于「只改若干单元格后写回」。
 * 与 parseCsv 不同，这里把原文件逐行存下（raw），并标注：哪行是表头、每条数据行对应
 * 原文件哪一行。serializeCsv 据此还原——注释/空行原样保留，数据行按表头列序重排写出。
 *
 * 注释行约定：行首以 # 开头（配置表大量用于中文列说明）；空行也原样保留。
 * 这些值内不含逗号（字段约定不出现英文逗号），故按逗号切分安全。
 */
export interface CsvDoc {
  /** 原文件所有行（含注释/空行），写回时按索引对应。 */
  raw: string[];
  /** 表头列名（第 1 个非注释非空行）。 */
  header: string[];
  /** 表头在 raw 中的行索引。 */
  headerIndex: number;
  /** 数据行（跳过注释与表头），与 rowIndices 一一对应。 */
  rows: CsvRow[];
  /** 每条数据行在 raw 中的原行索引。 */
  rowIndices: number[];
}

export function parseCsvStructured(text: string): CsvDoc {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const raw = clean.split(/\r?\n/);
  const doc: CsvDoc = { raw: [...raw], header: [], headerIndex: -1, rows: [], rowIndices: [] };
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim().length === 0) continue;             // 空行：原样保留（不进 rows）
    if (line.trimStart().startsWith('#')) continue;     // 注释行：原样保留
    if (doc.headerIndex === -1) {
      doc.headerIndex = i;
      doc.header = line.split(',').map((h) => h.trim());
      continue;
    }
    const cells = line.split(',');
    const row: CsvRow = {};
    doc.header.forEach((h, j) => { row[h] = (cells[j] ?? '').trim(); });
    doc.rows.push(row);
    doc.rowIndices.push(i);
  }
  return doc;
}

export function serializeCsv(doc: CsvDoc): string {
  const out: string[] = [];
  for (let i = 0; i < doc.raw.length; i++) {
    if (i === doc.headerIndex) {
      out.push(doc.header.join(','));
      continue;
    }
    const dataPos = doc.rowIndices.indexOf(i);
    if (dataPos !== -1) {
      const row = doc.rows[dataPos];
      out.push(doc.header.map((h) => row[h] ?? '').join(','));
      continue;
    }
    out.push(doc.raw[i]); // 注释行 / 空行：原样保留
  }
  // 保留原文件的末尾换行（配置表通常以 \n 结尾）
  const hadTrailingNewline = doc.raw.length > 0 && doc.raw[doc.raw.length - 1] === '';
  return hadTrailingNewline ? out.join('\n') + '\n' : out.join('\n');
}
