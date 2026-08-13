#!/usr/bin/env node
/** 提交总闸门：只允许“当前暂存快照已通过变更契约、完整测试与本地生产冒烟”的提交。 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, label) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 构建必须对应即将提交的 index。只拦「未暂存的已跟踪改动」；未跟踪文件不参与提交、无需阻止
// （否则 ._ 等垃圾未跟踪文件也会误拦）。
const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: ROOT }).status !== 0;
if (unstaged) {
  console.error('\n✘ 提交已阻止：存在未暂存的已跟踪改动，构建可能无法对应即将提交的内容。');
  console.error('  → 先 git add 或 stash 这些改动再提交。');
  process.exit(1);
}

run('npm', ['run', 'guard'], 'G1 · 变更契约');
run('npm', ['run', 'verify:quick'], 'G2 · 完整构建、静态检查与全部测试');
run('npm', ['run', 'verify:deploy'], 'G3 · 构建并执行本地生产部署端到端冒烟');

console.log('\n✔ 提交总闸门通过：当前暂存快照已通过变更契约、完整测试与本地生产冒烟。');
