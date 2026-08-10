#!/usr/bin/env node
/**
 * 变更契约总闸：R1–R6 一次跑完。见 docs/00_变更契约.md
 * 用法：npm run guard            手动自查
 *       .githooks/pre-commit     提交前自动跑
 * 逃生阀：GUARD_SKIP=docs,changelog,version|all
 */
import { checkDocs } from './check-docs.mjs';
import { checkChangelog } from './check-changelog.mjs';
import { checkVersion } from './check-version.mjs';
import { isSkipped, GUARD_SKIP, inSpecialGitState } from './lib.mjs';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('90', s);
const bold = (s) => c('1', s);

const CHECKS = [
  { id: 'docs', label: 'R1–R4 文档分层 / front-matter / 索引一致 / 归档上限', run: checkDocs },
  { id: 'changelog', label: 'R5 CHANGELOG 记账', run: checkChangelog },
  { id: 'version', label: 'R6 协议与存档版本号', run: checkVersion },
];

if (inSpecialGitState()) {
  console.log(dim('· merge/rebase 中途，跳过变更契约检查'));
  process.exit(0);
}

let failed = 0;
const skipped = [];

for (const check of CHECKS) {
  if (isSkipped(check.id)) {
    skipped.push(check.id);
    console.log(`${yellow('○')} ${check.label} ${yellow('（已跳过）')}`);
    continue;
  }
  const r = check.run();
  if (r.failures.length === 0) {
    console.log(`${green('✔')} ${check.label}`);
  } else {
    failed += r.failures.length;
    console.log(`${red('✖')} ${check.label}`);
    for (const f of r.failures) {
      console.log(`   ${red('·')} ${f.msg}`);
      if (f.fix) console.log(`     ${dim('→ ' + f.fix)}`);
    }
  }
}

if (skipped.length) {
  console.log('');
  console.log(yellow(bold(`⚠ 用逃生阀跳过了：${skipped.join(', ')}（GUARD_SKIP=${GUARD_SKIP.join(',')}）`)));
  console.log(yellow('  按约定当天补齐，并单独提一个 docs: 提交。CI 不认逃生阀。'));
}

if (failed > 0) {
  console.log('');
  console.log(red(bold(`变更契约未通过：${failed} 项。提交已中止。`)));
  console.log(dim('规矩全文：docs/00_变更契约.md    手动自查：npm run guard'));
  process.exit(1);
}

console.log(green(bold('变更契约通过。')));
