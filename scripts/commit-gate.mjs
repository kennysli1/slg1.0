#!/usr/bin/env node
/** 提交总闸门：只验证当前暂存快照，不连接或改变生产环境。 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, label) {
  console.log(`\n==> ${label}`);
  // Windows 下只有 npm 需要经过 shell 解析 .cmd；Node 自身路径可能含空格，不能交给 shell 拼接。
  const result = spawnSync(command, args, {
    cwd: ROOT, stdio: 'inherit', env: process.env,
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

function stagedPaths() {
  return output('git', ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((path) => path.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

// commit-msg 只在说明格式通过后调用这里；快照检查统一复用一次，手动运行 verify:commit 也不会漏掉。
run(process.execPath, ['scripts/commit-snapshot.mjs'], 'G0 · 提交作者与快照');
run('npm', ['run', 'guard'], 'G1 · 变更契约');
run('npm', ['run', 'verify:changed'], 'G2 · 按变更范围验证');
const paths = stagedPaths();
const touchesRuntime = paths.some((path) => path.startsWith('packages/') || path.startsWith('config/'));
if (touchesRuntime) run('npm', ['run', 'verify:deploy'], 'G3 · 构建并执行本地生产部署端到端冒烟');
else console.log('\n==> G3 · 非运行时改动，跳过生产产物冒烟');

console.log('\n✔ 提交总闸门通过：当前暂存快照已完成本地验证；生产部署仅允许显式部署 origin/main。');
