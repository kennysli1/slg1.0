/**
 * R1 文档分层与行数预算 / R2 front-matter / R3 索引即真相 / R4 规划文档归档上限
 * 见 docs/00_变更契约.md
 */
import {
  ROOT,
  listMarkdown,
  readRepoFile,
  fileExists,
  countLines,
  parseFrontMatter,
  createReporter,
  changeContext,
  previousContent,
} from './lib.mjs';
import { join, posix } from 'node:path';
import { readdirSync } from 'node:fs';

/** L0/L1 入口文件的行数上限：这几个是 AI 每次都要读的，必须短。 */
const ROOT_BUDGET = {
  'CLAUDE.md': 120,
  'PROJECT.md': 300,
  'README.md': 160,
  'AGENTS.md': 40,
};

/** docs/ 下按 class 分的正文行数上限（不含 front-matter）。 */
const CLASS_BUDGET = { index: 300, reference: 400, design: Infinity };

/** 活跃 design 文档篇数上限——超了就得先还债（归档旧的）。 */
const DESIGN_CAP = 8;

const REQUIRED_KEYS = ['class', 'status', 'updated', 'owner', 'summary'];
const CLASSES = ['index', 'reference', 'design'];
const STATUSES = ['active', 'draft', 'archived'];
const OWNERS = ['design', 'server', 'client', 'ops', 'art'];
const SUMMARY_MAX = 60;

const ARCHIVE_DIR = 'docs/archive/';
const INDEX_FILE = 'PROJECT.md';
const CONFIG_INDEX = 'config/README.md';
const MODULES_DIR = 'packages/server/src/modules';

/**
 * 摘出正文里的文档引用，用于死链检查。分两类：
 *   带路径（含 /）—— 精确校验；docs//config/ 开头按仓库根解析，其余按所在目录解析
 *   裸文件名     —— 只校验"仓库里存在同名文档"，避免把 `PROJECT.md` 这类根文件误判成同级文件
 */
const SEG = '[^\\s()\\[\\]`"\'*#|、，：；。>]';
const PATH_REF = new RegExp(
  `(?:^|[\\s(\\[\`"'|>])((?:\\.{0,2}\\/)?(?:${SEG}+\\/)+${SEG}+\\.(?:md|csv))`,
  'gm',
);
/** 只认 markdown 链接语法里的裸文件名；反引号里的裸名可能是在讲一个已删除的历史文件，不算引用。 */
const BARE_LINK = /\]\((\.{0,2}\/)?([^\s()/]+\.(?:md|csv))\)/g;

function extractPathRefs(text, fromRel) {
  const paths = new Set();
  const bases = new Set();
  const dir = posix.dirname(fromRel);
  for (const m of text.matchAll(PATH_REF)) {
    const raw = m[1].replace(/^\.\//, '');
    // 同一个引用允许三种写法：仓库根相对 / 所在目录相对 / docs 目录相对
    paths.add(
      [raw, posix.normalize(posix.join(dir, raw)), posix.join('docs', raw)].find(fileExists) ?? raw,
    );
  }
  for (const m of text.matchAll(BARE_LINK)) bases.add(m[2]);
  return { paths: [...paths], bases: [...bases] };
}

/** 仓库里所有 md/csv 的文件名集合，供裸文件名引用校验。 */
function knownBasenames(allDocs) {
  const set = new Set(['PROJECT.md', 'CLAUDE.md', 'README.md', 'AGENTS.md', 'CHANGELOG.md']);
  for (const rel of allDocs) set.add(posix.basename(rel));
  if (fileExists('config')) for (const f of readdirSync(join(ROOT, 'config'))) set.add(f);
  return set;
}

export function checkDocs() {
  const r = createReporter('docs');
  const changed = new Set(changeContext().files);

  // ---- R1：入口文件行数预算 ----
  for (const [file, max] of Object.entries(ROOT_BUDGET)) {
    const text = readRepoFile(file);
    if (text === null) continue;
    const n = countLines(text);
    if (n > max) {
      r.fail(
        `${file} 有 ${n} 行，超过上限 ${max} 行`,
        `把细节挪进 docs/ 并在此处只留一行指路；入口文件必须短，AI 每次都要读它`,
      );
    }
  }

  const allDocs = listMarkdown('docs');
  const active = [];

  for (const rel of allDocs) {
    const text = readRepoFile(rel);
    const isArchived = rel.startsWith(ARCHIVE_DIR);
    const fm = parseFrontMatter(text);

    // ---- R2：front-matter ----
    if (!fm) {
      r.fail(
        `${rel} 缺少 front-matter`,
        ['在文件最开头加：', '---', 'class: reference', 'status: active', 'updated: YYYY-MM-DD', 'owner: server', 'summary: 一句话说清这篇讲什么', '---'].join('\n       '),
      );
      continue;
    }
    if (fm.__malformed) {
      r.fail(`${rel} 的 front-matter 有非法行：${fm.__malformed}`, `只支持 \`key: value\` 平铺格式`);
      continue;
    }
    for (const k of REQUIRED_KEYS) {
      if (!fm[k]) r.fail(`${rel} 的 front-matter 缺字段 ${k}`, `必填：${REQUIRED_KEYS.join(' / ')}`);
    }
    if (fm.class && !CLASSES.includes(fm.class))
      r.fail(`${rel} class=${fm.class} 非法`, `只能是 ${CLASSES.join(' / ')}`);
    if (fm.status && !STATUSES.includes(fm.status))
      r.fail(`${rel} status=${fm.status} 非法`, `只能是 ${STATUSES.join(' / ')}`);
    if (fm.owner && !OWNERS.includes(fm.owner))
      r.fail(`${rel} owner=${fm.owner} 非法`, `只能是 ${OWNERS.join(' / ')}`);
    if (fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(fm.updated))
      r.fail(`${rel} updated=${fm.updated} 格式不对`, `用 YYYY-MM-DD`);
    if (fm.summary && [...fm.summary].length > SUMMARY_MAX)
      r.fail(
        `${rel} 的 summary 有 ${[...fm.summary].length} 字，超过 ${SUMMARY_MAX}`,
        `summary 是给 AI 扫的目录条目，一句话说清即可`,
      );

    // ---- R4：归档位置与状态必须一致 ----
    if (fm.status === 'archived' && !isArchived)
      r.fail(`${rel} 标了 status: archived 却不在 ${ARCHIVE_DIR}`, `git mv 到 ${ARCHIVE_DIR} 下`);
    if (isArchived && fm.status !== 'archived')
      r.fail(`${rel} 在归档目录里但 status=${fm.status}`, `改成 status: archived`);

    if (isArchived) continue;
    active.push({ rel, fm });

    // ---- R1：docs 正文行数预算 ----
    const bodyLines = countLines(text.replace(/^\uFEFF/, '').split(/^---\s*$/m).slice(2).join('---'));
    const max = CLASS_BUDGET[fm.class] ?? CLASS_BUDGET.reference;
    if (bodyLines > max) {
      r.fail(
        `${rel} 正文 ${bodyLines} 行，超过 class=${fm.class} 的上限 ${max} 行`,
        `拆成多篇并登记到 ${INDEX_FILE} 文档清单，或把已过期的推演内容归档到 ${ARCHIVE_DIR}`,
      );
    }

    // ---- R2：改了正文就必须改 updated ----
    if (changed.has(rel)) {
      const prev = previousContent(rel);
      if (prev) {
        const prevFm = parseFrontMatter(prev);
        const prevBody = prev.split(/^---\s*$/m).slice(2).join('---');
        const curBody = text.split(/^---\s*$/m).slice(2).join('---');
        if (prevBody.trim() !== curBody.trim() && prevFm?.updated === fm.updated) {
          r.fail(
            `${rel} 正文改了但 updated 还是 ${fm.updated}`,
            `把 front-matter 的 updated 改成今天`,
          );
        }
      }
    }
  }

  // ---- R4：活跃 design 文档篇数上限 ----
  const designs = active.filter((d) => d.fm.class === 'design');
  if (designs.length > DESIGN_CAP) {
    r.fail(
      `活跃的 class: design 文档有 ${designs.length} 篇，超过上限 ${DESIGN_CAP} 篇`,
      `把已上线系统的规划文档结论并入常青文档后 git mv 到 ${ARCHIVE_DIR}：\n       ${designs.map((d) => d.rel).join('\n       ')}`,
    );
  }

  // ---- R3：索引即真相 ----
  const indexText = readRepoFile(INDEX_FILE);
  if (indexText === null) {
    r.fail(`找不到 ${INDEX_FILE}`, `索引文件不能删`);
  } else {
    for (const { rel } of active) {
      const short = rel.slice('docs/'.length);
      if (!indexText.includes(short) && !indexText.includes(rel)) {
        r.fail(
          `${rel} 没有登记在 ${INDEX_FILE} 的文档清单里`,
          `在 ${INDEX_FILE} §五 文档清单加一行（文档 / 作用 / 何时看），否则后来的 AI 不知道它存在`,
        );
      }
    }
    if (fileExists(MODULES_DIR)) {
      for (const f of readdirSync(join(ROOT, MODULES_DIR))) {
        if (!f.endsWith('.ts')) continue;
        const base = f.replace(/\.ts$/, '');
        if (!indexText.includes(f) && !indexText.includes(`\`${base}\``)) {
          r.fail(
            `模块 ${MODULES_DIR}/${f} 没有登记在 ${INDEX_FILE} 的模块清单里`,
            `在 ${INDEX_FILE} §四 模块清单加一行，写清它 own 哪块状态`,
          );
        }
      }
    }
  }

  const cfgIndex = readRepoFile(CONFIG_INDEX);
  if (cfgIndex !== null) {
    for (const f of readdirSync(join(ROOT, 'config'))) {
      if (f.endsWith('.csv') && !cfgIndex.includes(f)) {
        r.fail(`配置表 config/${f} 没有登记在 ${CONFIG_INDEX}`, `补上该表每一列的说明`);
      }
    }
  }

  // ---- R3 反向：死链（归档区是冻结的历史，不维护其链接） ----
  const known = knownBasenames(allDocs);
  const linkSources = [
    'CLAUDE.md',
    'AGENTS.md',
    'PROJECT.md',
    'README.md',
    'CHANGELOG.md',
    ...allDocs.filter((d) => !d.startsWith(ARCHIVE_DIR)),
  ];
  for (const src of linkSources) {
    const text = readRepoFile(src);
    if (text === null) continue;
    const { paths, bases } = extractPathRefs(text, src);
    for (const ref of paths) {
      if (!fileExists(ref)) r.fail(`${src} 引用了不存在的文件：${ref}`, `改成正确路径，或补上该文件`);
    }
    for (const base of bases) {
      if (!known.has(base)) r.fail(`${src} 引用了不存在的文档：${base}`, `仓库里找不到同名文件`);
    }
  }

  return r;
}
