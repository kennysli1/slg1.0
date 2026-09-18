import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface AiActivityEntry {
  at: number;
  actor: string;
  persona: string;
  event: string;
  target?: string;
  outcome: string;
  details?: Record<string, string | number | boolean | undefined>;
}

const RETENTION_MS = 30 * 86_400_000;

/**
 * 面向运营阅读的 AI 行为纪要。它不是游戏状态，也不参与玩法恢复；写入失败不得阻断游戏。
 * 文件按中国标准时间自然日滚动，内容只接受 AI owner 主动整理后的有限字段。
 */
export class AiActivityJournal {
  private initialized = false;

  constructor(private readonly dir: string | null) {}

  append(entry: AiActivityEntry): void {
    if (!this.dir) return;
    try {
      this.ensureDir(entry.at);
      const shifted = new Date(entry.at + 8 * 3_600_000).toISOString();
      const date = shifted.slice(0, 10);
      const time = shifted.slice(11, 19);
      const path = join(this.dir, `${date}.md`);
      if (!existsSync(path)) {
        appendFileSync(path, `# AI 行为纪要 · ${date}\n\n> 自动生成；时间均为 UTC+8。只记录游戏内行为摘要，不包含密码、令牌或完整内部状态。\n\n`, 'utf8');
      }
      const lines = [
        `## ${time} · ${clean(entry.actor)}`,
        '',
        `- 人格：${clean(entry.persona)}`,
        `- 事件：${clean(entry.event)}`,
        ...(entry.target ? [`- 对象：${clean(entry.target)}`] : []),
        `- 结果：${clean(entry.outcome)}`,
      ];
      for (const [label, value] of Object.entries(entry.details ?? {})) {
        if (value === undefined || value === '') continue;
        lines.push(`- ${clean(label)}：${clean(String(value))}`);
      }
      appendFileSync(path, `${lines.join('\n')}\n\n`, 'utf8');
    } catch {
      // 纪要是可观测性副产物，磁盘异常不能改变服务器权威行为。
    }
  }

  private ensureDir(now: number): void {
    if (this.initialized || !this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const cutoff = now - RETENTION_MS;
    for (const file of readdirSync(this.dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) continue;
      const timestamp = Date.parse(file.slice(0, 10));
      if (Number.isFinite(timestamp) && timestamp < cutoff) rmSync(join(this.dir, file));
    }
    this.initialized = true;
  }
}

function clean(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').trim().slice(0, 500);
}
