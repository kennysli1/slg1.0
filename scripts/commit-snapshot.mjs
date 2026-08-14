#!/usr/bin/env node
/** 提交前的秒级快检：确认作者身份与当前工作区能代表暂存快照。 */
import { spawnSync } from 'node:child_process';

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

const authorIdent = output('git', ['var', 'GIT_AUTHOR_IDENT']);
const authorEmail = authorIdent.match(/<([^>]+)>/)?.[1] ?? '';
if (!authorEmail || /(?:\.local|localhost\.localdomain)$/i.test(authorEmail)) {
  console.error(`\n✘ 提交已阻止：请先显式配置可识别的 Git 邮箱（当前：${authorEmail || '空'}）。`);
  process.exit(1);
}

const unstaged = spawnSync('git', ['diff', '--quiet']).status !== 0;
const untracked = output('git', ['ls-files', '--others', '--exclude-standard']);
if (unstaged || untracked) {
  console.error('\n✘ 提交已阻止：工作区必须与暂存区完全一致，才能证明验证对应即将提交的内容。');
  if (unstaged) console.error('  - 存在未暂存改动');
  if (untracked) console.error(`  - 存在未跟踪文件：\n${untracked.split('\n').map((f) => `    ${f}`).join('\n')}`);
  process.exit(1);
}
