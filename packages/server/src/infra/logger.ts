/**
 * 基础设施 · 结构化调试日志
 *
 * 用法：
 *   const log = makeLogger('combat');
 *   log('开战', { attacker, defender });
 *   log.warn('异常', { ... });
 *
 * 控制开关（环境变量 GAME_LOG，默认全开）：
 *   不设置 / GAME_LOG=all   启用全部模块
 *   GAME_LOG=combat,economy 只启用指定模块
 *   GAME_LOG=off            关闭全部
 *
 * 初始化（main.ts 启动时调用一次）：
 *   initLogger('data/logs');   写文件 + 清理7天前的旧日志
 *
 * 输出格式（同时写控制台和日志文件）：
 *   [12:34:56.789][combat] 开战 {"attacker":...}
 *   日志文件：data/logs/2026-07-03.log（按天滚动）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

export interface Logger {
  (msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// 默认全开；GAME_LOG=off 才关闭
let enabledSet: Set<string> | 'all' | false = 'all';

function parseEnv(): void {
  const raw = process.env.GAME_LOG?.trim().toLowerCase();
  if (!raw || raw === 'all' || raw === 'true') {
    enabledSet = 'all';
  } else if (raw === 'off' || raw === 'false' || raw === '0') {
    enabledSet = false;
  } else {
    enabledSet = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
}

parseEnv();

let logDir: string | null = null;

/**
 * 初始化文件日志（main.ts 启动时调用）。
 * - 创建日志目录（不存在时自动建）
 * - 清理7天前的旧日志文件（文件名格式 YYYY-MM-DD.log）
 */
export function initLogger(dir: string): void {
  logDir = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue;
      const ts = Date.parse(f.replace('.log', ''));
      if (!isNaN(ts) && ts < cutoff) rmSync(join(dir, f));
    }
  } catch { /* ignore — 清理失败不影响启动 */ }
}

function isEnabled(scope: string): boolean {
  if (enabledSet === false) return false;
  if (enabledSet === 'all') return true;
  return enabledSet.has(scope);
}

function fmt(scope: string, level: Level, msg: string, data?: unknown): void {
  const now = new Date();
  const time = now.toISOString().slice(11, 23); // HH:mm:ss.mmm
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const levelTag = level === 'info' ? '' : ` ${level.toUpperCase()}`;
  const body = data !== undefined ? `${msg} ${JSON.stringify(data, null, 0)}` : msg;
  const line = `[${time}][${scope}]${levelTag} ${body}`;

  if (level === 'info') console.log(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);

  if (logDir) {
    try {
      appendFileSync(join(logDir, `${dateStr}.log`), line + '\n');
    } catch { /* ignore — 写文件失败不影响运行 */ }
  }
}

export function makeLogger(scope: string): Logger {
  const fn = (msg: string, data?: unknown) => {
    if (isEnabled(scope)) fmt(scope, 'info', msg, data);
  };
  fn.warn = (msg: string, data?: unknown) => {
    if (isEnabled(scope)) fmt(scope, 'warn', msg, data);
  };
  fn.error = (msg: string, data?: unknown) => {
    if (isEnabled(scope)) fmt(scope, 'error', msg, data);
  };
  return fn as Logger;
}
