#!/usr/bin/env node
/**
 * 把 Git 钩子指向仓库内的 .githooks/（这样钩子本身也进版本管理，两个人自动同步）。
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
  if (process.platform !== 'win32') {
    for (const f of readdirSync(HOOKS_DIR)) chmodSync(join(HOOKS_DIR, f), 0o755);
  }
  console.log('✔ Git 钩子已指向 .githooks/（变更契约生效，见 docs/00_变更契约.md）');
} catch (err) {
  console.warn('⚠ 安装 Git 钩子失败，请手动执行：git config core.hooksPath .githooks');
  console.warn(String(err?.message ?? err));
}
