#!/usr/bin/env node
/**
 * 按当前改动范围执行本地快速验证。
 * 提交时读取暂存区；手动运行时读取 VERIFY_BASE...HEAD 或 origin/main...HEAD。
 * PR 的完整回归仍由 verify:ci/CI 负责，这里只减少本地重复等待。
 */
import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function run(script, args = []) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`\n==> npm run ${script}${args.length ? ` -- ${args.join(' ')}` : ''}`);
  const result = spawnSync(npm, ['run', script, ...args], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function changedPaths() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (staged) return staged.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  const base = process.env.VERIFY_BASE?.trim()
    || (git(['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : 'HEAD~1');
  const ranged = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  return ranged.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

const paths = changedPaths();
if (paths.length === 0) {
  console.log('↷ 未发现可验证的改动；完整验证请运行 npm run verify:ci');
  process.exit(0);
}

const has = (prefix) => paths.some((path) => path.startsWith(prefix));
const hasServer = has('packages/server/');
const hasShared = has('packages/shared/');
const hasClient = has('packages/client/');
const hasConfig = has('config/');

console.log(`变更范围：${paths.join(', ')}`);
if (hasShared) {
  run('build:shared');
  run('lint:all');
  run('typecheck');
  run('test:all');
} else {
  if (hasServer) {
    run('build:shared');
    run('lint');
    run('test:server');
  }
  if (hasClient) {
    run('lint', ['-w', '@slg/client']);
    run('typecheck');
    run('test', ['-w', '@slg/client']);
  }
}
if (hasConfig) run('verify:config-sync');
if (!hasServer && !hasShared && !hasClient && !hasConfig) {
  console.log('↷ 仅文档/工具/运维改动；跳过业务回归。PR CI 仍执行不可绕过的契约检查。');
}
