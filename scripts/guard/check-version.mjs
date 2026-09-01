/**
 * R6 三个版本号各管一摊，破坏性变更必须同步升。见 docs/00_变更契约.md
 *   - package.json version   应用版本（由 npm run release 统一改）
 *   - WIRE_VERSION           协议版本，wire.ts 有实质改动就必须升
 *   - SAVE_SCHEMA_VERSION    存档版本，与 CHANGELOG 的 [需刷档] 标记双向绑定
 */
import {
  changeContext,
  currentContent,
  previousContent,
  changedDiff,
  readRepoFile,
  unreleasedSection,
  bulletsOf,
  createReporter,
} from './lib.mjs';

const WIRE_FILE = 'packages/shared/src/wire.ts';
const SCHEMA_FILE = 'packages/server/src/infra/schema-version.ts';
const CHANGELOG = 'CHANGELOG.md';
const RESET_TAG = '[需刷档]';

const numOf = (text, name) => {
  const m = text ? new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text) : null;
  return m ? Number(m[1]) : null;
};

/** diff 里是否只动了注释/空行——只改文档不算协议变更。 */
function hasSubstantiveChange(diff) {
  return diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1).trim())
    .some((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

export function checkVersion() {
  const r = createReporter('version');

  const pkg = readRepoFile('package.json');
  if (pkg) {
    const v = JSON.parse(pkg).version;
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v ?? '')) {
      r.fail(`package.json 的 version="${v}" 不是合法语义化版本`, `用 x.y.z，发版走 npm run release`);
    }
  }

  const ctx = changeContext();
  if (ctx.mode === 'none') return r;

  // ---- 协议版本 ----
  if (ctx.files.includes(WIRE_FILE) && hasSubstantiveChange(changedDiff(WIRE_FILE))) {
    const before = numOf(previousContent(WIRE_FILE), 'WIRE_VERSION');
    const after = numOf(currentContent(WIRE_FILE), 'WIRE_VERSION');
    if (before !== null && after !== null && after <= before) {
      r.fail(
        `${WIRE_FILE} 有实质改动，但 WIRE_VERSION 还是 ${before}`,
        `协议信封/动作契约变了就把 WIRE_VERSION 升到 ${before + 1}，并考虑 WIRE_MIN_VERSION；\n       确属兼容改动（仅重命名注释、加可选字段）可用 GUARD_SKIP=version 跳过并在 CHANGELOG 说明`,
      );
    }
  }

  // ---- 存档版本 ↔ [需刷档] 双向绑定 ----
  const before = numOf(previousContent(SCHEMA_FILE), 'SAVE_SCHEMA_VERSION');
  const after = numOf(currentContent(SCHEMA_FILE), 'SAVE_SCHEMA_VERSION');
  const bumped = before !== null && after !== null && after > before;

  const newBullets = (() => {
    if (!ctx.files.includes(CHANGELOG)) return [];
    const cur = bulletsOf(unreleasedSection(currentContent(CHANGELOG)));
    const prev = bulletsOf(unreleasedSection(previousContent(CHANGELOG)));
    return cur.filter((b) => !prev.includes(b));
  })();
  const declaresReset = newBullets.some((b) => b.includes(RESET_TAG));

  if (declaresReset && !bumped) {
    r.fail(
      `CHANGELOG 里声明了 ${RESET_TAG}，但 SAVE_SCHEMA_VERSION 没升`,
      `把 ${SCHEMA_FILE} 的 SAVE_SCHEMA_VERSION 加 1（当前 ${before ?? '未知'}），并在条目中说明迁移/重置方案`,
    );
  }
  if (bumped && !declaresReset) {
    r.fail(
      `SAVE_SCHEMA_VERSION 升到了 ${after}，但 CHANGELOG 的新条目里没有 ${RESET_TAG}`,
      `在条目开头加 ${RESET_TAG}，并说明为何旧存档无法通过迁移兼容`,
    );
  }

  return r;
}
