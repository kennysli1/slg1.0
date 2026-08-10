#!/usr/bin/env node
/**
 * 发版：把 CHANGELOG 的 [未发布] 段封版 + 同步四个 package.json 的 version + 打 tag。
 * 用法：npm run release -- patch | minor | major | 1.2.3   （默认 patch）
 *       npm run release -- patch --dry
 * 见 docs/00_变更契约.md R6。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/client/package.json',
];
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};
const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

if (git(['status', '--porcelain']).trim() && !dry) {
  die('工作区不干净，先提交或 stash 再发版');
}

const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const next = (() => {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [ma, mi, pa] = current.split('.').map(Number);
  if (bump === 'major') return `${ma + 1}.0.0`;
  if (bump === 'minor') return `${ma}.${mi + 1}.0`;
  if (bump === 'patch') return `${ma}.${mi}.${pa + 1}`;
  return die(`未知的版本参数：${bump}（用 patch/minor/major 或 x.y.z）`);
})();

const log = readFileSync(CHANGELOG, 'utf8').replace(/\r\n/g, '\n');
const start = log.search(/^##\s*\[未发布\].*$/m);
if (start === -1) die('CHANGELOG.md 里找不到 "## [未发布]" 段');
const headerEnd = log.indexOf('\n', start) + 1;
const rest = log.slice(headerEnd);
const nextHeading = rest.search(/^##\s/m);
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();

if (!/^[-*]\s+\S/m.test(body)) die('[未发布] 段是空的，没有可发布的内容');

const today = new Date().toISOString().slice(0, 10);
const released =
  log.slice(0, headerEnd) +
  '\n_（下次改动写在这里）_\n\n' +
  `## [${next}] - ${today}\n\n${body}\n\n` +
  (nextHeading === -1 ? '' : rest.slice(nextHeading));

if (dry) {
  console.log(`[dry] ${current} → ${next}`);
  console.log(body);
  process.exit(0);
}

writeFileSync(CHANGELOG, released, 'utf8');
for (const rel of PKGS) {
  const p = join(ROOT, rel);
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${next}"`), 'utf8');
}

git(['add', 'CHANGELOG.md', ...PKGS]);
git(['commit', '-m', `chore(release): v${next}`]);
git(['tag', '-a', `v${next}`, '-m', `v${next}`]);

console.log(`✔ 已发版 v${next}（已提交并打 tag）`);
console.log(`  推送：git push && git push origin v${next}`);
