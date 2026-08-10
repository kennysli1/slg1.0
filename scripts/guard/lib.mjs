/**
 * guard 公共工具：仓库路径、git 读取、front-matter 解析、结果收集。
 * 零依赖（只用 node 内置），保持和项目"不引额外依赖"的调性一致。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 中文路径必须关掉 quotePath，否则 git 会输出八进制转义。 */
function git(args, opts = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
  });
}

function gitOrNull(args) {
  try {
    return git(args, { quiet: true });
  } catch {
    return null;
  }
}

const toLines = (s) =>
  (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** 本次提交暂存区里新增/改名/修改的文件（仓库相对路径，正斜杠）。 */
export function stagedFiles() {
  return toLines(gitOrNull(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])).map((p) =>
    p.replace(/\\/g, '/'),
  );
}

/**
 * 本次"改动"指的是什么，有两种来源：
 *   staged —— 本地 pre-commit：看暂存区
 *   range  —— CI：本地钩子能被 --no-verify 绕过，CI 改看 GUARD_BASE...HEAD 这段提交
 * 两种都没有（比如随手 npm run guard）时，依赖改动内容的检查自动放行。
 */
let cachedContext = null;
export function changeContext() {
  if (cachedContext) return cachedContext;
  const staged = stagedFiles();
  if (staged.length) {
    cachedContext = { mode: 'staged', files: staged, base: 'HEAD' };
    return cachedContext;
  }
  const base = (process.env.GUARD_BASE ?? '').trim();
  const ranged = base
    ? toLines(gitOrNull(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]))
    : [];
  cachedContext = base
    ? { mode: 'range', files: ranged.map((p) => p.replace(/\\/g, '/')), base }
    : { mode: 'none', files: [], base: 'HEAD' };
  return cachedContext;
}

/** 改动后的文件内容（暂存区版 / 工作区版）。 */
export function currentContent(path) {
  return changeContext().mode === 'staged' ? gitOrNull(['show', `:${path}`]) : readRepoFile(path);
}

/** 改动前的文件内容；文件是新增的则返回 null。 */
export function previousContent(path) {
  return gitOrNull(['show', `${changeContext().base}:${path}`]);
}

/** 某文件本次改动的 unified diff。 */
export function changedDiff(path) {
  const ctx = changeContext();
  const args =
    ctx.mode === 'staged'
      ? ['diff', '--cached', '-U0', '--', path]
      : ['diff', '-U0', `${ctx.base}...HEAD`, '--', path];
  return gitOrNull(args) ?? '';
}

/** 是否处于 merge / rebase / cherry-pick 中途——这些场景一律放行。 */
export function inSpecialGitState() {
  const gitDir = (gitOrNull(['rev-parse', '--git-dir']) ?? '').trim();
  if (!gitDir) return false;
  const dir = resolve(ROOT, gitDir);
  return ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) =>
    existsSync(join(dir, f)),
  );
}

/** 递归列出目录下所有 .md（仓库相对路径，正斜杠）。 */
export function listMarkdown(dirRel) {
  const abs = join(ROOT, dirRel);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (cur) => {
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  walk(abs);
  return out.sort();
}

export function readRepoFile(rel) {
  const abs = join(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

export function fileExists(rel) {
  return existsSync(join(ROOT, rel));
}

export function countLines(text) {
  const t = text.replace(/\r\n/g, '\n');
  const n = t.split('\n').length;
  return t.endsWith('\n') ? n - 1 : n;
}

/**
 * 解析文件头部 front-matter。只支持 `key: value` 平铺格式（够用且不引 yaml 依赖）。
 * 返回 null 表示没有 front-matter。
 */
export function parseFrontMatter(text) {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = t.slice(4, end + 1);
  const data = {};
  for (const line of body.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { __malformed: line.trim() };
    data[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return data;
}

/** 取 CHANGELOG 里 `## [未发布]` 段落的正文（到下一个 `## ` 为止）。 */
export function unreleasedSection(changelogText) {
  if (!changelogText) return null;
  const t = changelogText.replace(/\r\n/g, '\n');
  const start = t.search(/^##\s*\[未发布\]/m);
  if (start === -1) return null;
  const rest = t.slice(start);
  const nextIdx = rest.slice(1).search(/^##\s/m);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1);
}

/** 段落里的条目行（`- xxx`），用于判断"有没有真的写东西"。 */
export function bulletsOf(section) {
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l));
}

export const GUARD_SKIP = (process.env.GUARD_SKIP ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isSkipped(id) {
  return GUARD_SKIP.includes('all') || GUARD_SKIP.includes(id);
}

/** 一次检查的结果收集器：failures 非空即视为不通过。 */
export function createReporter(id) {
  const failures = [];
  return {
    id,
    failures,
    fail(msg, fix) {
      failures.push({ msg, fix });
    },
  };
}
