#!/usr/bin/env node
/**
 * 分支开发守卫：禁止直接在 main/master 上创建提交。
 * 主分支只接受远程平台合并已经验收的功能分支。
 * 仅在本地 pre-commit 生效；CI（GitHub Actions 在 main 上验证 push，非本地提交）跳过。
 */
import { execFileSync } from 'node:child_process';

if (process.env.CI === 'true' || process.env.GUARD_BASE) process.exit(0);

function currentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const branch = currentBranch();
if (branch === 'main' || branch === 'master') {
  console.error(`✖ 禁止直接在 ${branch} 上提交。`);
  console.error('  → 请先执行：git switch -c <type>/<short-description>');
  process.exit(1);
}

if (branch) console.log(`✔ 分支开发守卫（当前：${branch}）`);
