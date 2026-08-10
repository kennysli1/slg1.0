/**
 * R5 CHANGELOG 是唯一的历史入口。见 docs/00_变更契约.md
 * 改了业务代码 / 配置表的提交，必须在 `## [未发布]` 段里留下条目。
 */
import {
  changeContext,
  currentContent,
  previousContent,
  unreleasedSection,
  bulletsOf,
  createReporter,
} from './lib.mjs';

const CHANGELOG = 'CHANGELOG.md';
const CATEGORIES = ['新增', '变更', '修复', '移除', '破坏性'];

/** 需要记账的改动：业务源码与游戏数值表。测试/脚本/文档/构建产物不算。 */
function isAccountable(path) {
  if (/(^|\/)__tests__\//.test(path)) return false;
  if (/\.test\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (/^packages\/[^/]+\/src\/test\//.test(path)) return false;
  if (/^packages\/[^/]+\/src\/.+\.(ts|tsx|css|html)$/.test(path)) return true;
  if (/^config\/.+\.csv$/.test(path)) return true;
  return false;
}

export function checkChangelog() {
  const r = createReporter('changelog');
  const ctx = changeContext();
  if (ctx.mode === 'none') return r; // 不在提交/CI 流程里，无从判断

  const accountable = ctx.files.filter(isAccountable);
  if (accountable.length === 0) return r;

  if (!ctx.files.includes(CHANGELOG)) {
    r.fail(
      `本次改动了 ${accountable.length} 个业务文件，但没有更新 ${CHANGELOG}`,
      `在 ${CHANGELOG} 的 ## [未发布] 下加一条（分类：${CATEGORIES.join(' / ')}），然后 git add ${CHANGELOG}\n       改动文件：${accountable.slice(0, 8).join(', ')}${accountable.length > 8 ? ' …' : ''}`,
    );
    return r;
  }

  const section = unreleasedSection(currentContent(CHANGELOG));
  if (!section) {
    r.fail(`${CHANGELOG} 里找不到 "## [未发布]" 段`, `保留该段落标题，新条目一律先写进这里`);
    return r;
  }

  const prevBullets = bulletsOf(unreleasedSection(previousContent(CHANGELOG)));
  const added = bulletsOf(section).filter((b) => !prevBullets.includes(b));
  if (added.length === 0) {
    r.fail(
      `${CHANGELOG} 的 [未发布] 段没有新增条目`,
      `写一条说清这次改了什么、为什么；需要刷档的话条目里带 [需刷档] 标记`,
    );
  }

  if (!CATEGORIES.some((c) => new RegExp(`^###\\s*${c}`, 'm').test(section))) {
    r.fail(
      `${CHANGELOG} 的 [未发布] 段缺少分类小标题`,
      `条目要挂在 ### ${CATEGORIES.join(' / ### ')} 之一下面`,
    );
  }

  return r;
}
