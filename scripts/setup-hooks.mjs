#!/usr/bin/env node
/**
 * 安装仓库 Git 钩子，并统一多人协作所需的安全默认值。
 * 由 package.json 的 prepare 脚本在 npm install 后自动执行；不在 git 仓库里则静默跳过。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = join(ROOT, '.githooks');

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' });
} catch {
  process.exit(0); // 不是 git 仓库（比如 CI 里解压的产物），无需安装
}

if (!existsSync(HOOKS_DIR)) process.exit(0);

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'ignore' });
  execFileSync('git', ['config', 'pull.ff', 'only'], { cwd: ROOT, stdio: 'ignore' });
  execFileSync('git', ['config', 'fetch.prune', 'true'], { cwd: ROOT, stdio: 'ignore' });
  execFileSync('git', ['config', 'rerere.enabled', 'true'], { cwd: ROOT, stdio: 'ignore' });
  if (process.platform !== 'win32') {
    for (const f of readdirSync(HOOKS_DIR)) chmodSync(join(HOOKS_DIR, f), 0o755);
  }
  console.log('✔ Git 协作配置已安装（钩子、仅快进 pull、自动清理远端分支、冲突复用）');
} catch (err) {
  console.warn('⚠ 安装 Git 协作配置失败，请手动执行：npm run hooks:install');
  console.warn(String(err?.message ?? err));
}
