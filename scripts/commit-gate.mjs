#!/usr/bin/env node
/** 提交总闸门：只验证当前暂存快照，不连接或改变生产环境。 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, label) {
  console.log(`\n==> ${label}`);
  // Windows 下 node 的 spawnSync('npm') 不会自动解析 .cmd；经 shell 执行保持与终端 npm 一致。
  const result = spawnSync(command, args, {
    cwd: ROOT, stdio: 'inherit', env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

// 禁止 Git 用机器名猜测作者身份；否则 GitHub 无法归属贡献，服务器提交也无法追责到人。
const authorIdent = output('git', ['var', 'GIT_AUTHOR_IDENT']);
const authorEmail = authorIdent.match(/<([^>]+)>/)?.[1] ?? '';
if (!authorEmail || /(?:\.local|localhost\.localdomain)$/i.test(authorEmail)) {
  console.error(`\n✘ 提交已阻止：请先显式配置可识别的 Git 邮箱（当前：${authorEmail || '空'}）。`);
  console.error('  git config user.email "你的 GitHub 邮箱或 noreply 邮箱"');
  process.exit(1);
}

// 构建必须对应即将提交的 index。否则未暂存代码可能让错误快照“替身通过”。
const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: ROOT }).status !== 0;
const untracked = output('git', ['ls-files', '--others', '--exclude-standard']);
if (unstaged || untracked) {
  console.error('\n✘ 提交已阻止：工作区必须与暂存区完全一致，才能证明部署的就是即将提交的内容。');
  if (unstaged) console.error('  - 存在未暂存改动');
  if (untracked) console.error(`  - 存在未跟踪文件：\n${untracked.split('\n').map((f) => `    ${f}`).join('\n')}`);
  process.exit(1);
}

run('npm', ['run', 'guard'], 'G1 · 变更契约');
run('npm', ['run', 'verify:quick'], 'G2 · 完整构建、静态检查与全部测试');
run('npm', ['run', 'verify:deploy'], 'G3 · 构建并执行本地生产部署端到端冒烟');

console.log('\n✔ 提交总闸门通过：当前暂存快照已完成本地验证；生产部署仅允许显式部署 origin/main。');
