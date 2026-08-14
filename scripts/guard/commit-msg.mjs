#!/usr/bin/env node
/**
 * G2 commit message 规范校验（Conventional Commits，中文主题）。见 docs/00_变更契约.md
 * 由 .githooks/commit-msg 调用，参数是 git 传进来的消息文件路径。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSkipped } from './lib.mjs';

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'chore', 'config', 'build', 'revert'];
const MAX_HEADER = 72;
const PATTERN = new RegExp(`^(${TYPES.join('|')})(\\([\\w\\-+./, ]+\\))?!?: \\S.*$`);

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\u001b[31m${s}\u001b[0m` : s);
const dim = (s) => (color ? `\u001b[90m${s}\u001b[0m` : s);

if (isSkipped('commit-msg')) process.exit(0);

const file = process.argv[2];
if (!file) process.exit(0);

const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n').filter((l) => !l.startsWith('#'));
const header = (lines.find((l) => l.trim() !== '') ?? '').trim();

// 合并/回退/自动修补提交不管
if (/^(Merge|Revert|fixup!|squash!)\b/.test(header)) process.exit(0);

const problems = [];
if (!PATTERN.test(header)) {
  problems.push(`格式不对：应为 <type>(<scope>): <主题>，type 取 ${TYPES.join(' / ')}`);
}
if ([...header].length > MAX_HEADER) {
  problems.push(`首行 ${[...header].length} 字符，超过 ${MAX_HEADER}；细节写到正文里`);
}
if (/[。.]$/.test(header)) {
  problems.push('主题结尾不要加句号');
}

if (problems.length) {
  console.error('');
  console.error(red(`✖ commit message 不符合规范：${header || '(空)'}`));
  for (const p of problems) console.error(red(`  · ${p}`));
  console.error('');
  console.error(dim('  示例：'));
  console.error(dim('    feat(population): 三池口粮改为按 tick 结算'));
  console.error(dim('    fix(client): 地图选中格重复渲染'));
  console.error(dim('    docs: 归档人口系统架构规划'));
  console.error(dim('    feat(wire)!: Request 增加 seq 字段（破坏性）'));
  console.error(dim('  规矩全文：docs/00_变更契约.md'));
  console.error('');
  process.exit(1);
}

// Git 的 pre-commit 发生在 commit-msg 之前；把耗时验证放到这里，确保不合规说明瞬时失败。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync(process.execPath, ['scripts/commit-gate.mjs'], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
