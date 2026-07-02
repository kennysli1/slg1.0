// @ts-check
/**
 * ESLint 扁平配置 —— 把两条架构铁律做成"写代码时就红线"的写时闸门。
 * 对应 docs/2_2.0设计/07_扩展与代码规范.md 的四铁律。
 *
 * 这里只放 ESLint 能结构化识别、且能当场阻断的规则：
 *   铁律#3 时间统一走 Scheduler —— 全模块禁 setTimeout/setInterval
 *   铁律#2 模块之间不互相 import —— modules/ 下禁止相对 import 兄弟模块（combat 纯函数除外）
 * 铁律#1(状态归属唯一) 靠 test/architecture.test.ts 兜底（跨文件分析，lint 规则表达不了）。
 *
 * 用法：npm run lint -w @slg/server（提交前）；装 ESLint 编辑器插件即可实时红线。
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  // 领域模块禁定时器（铁律#3）。infra/ 下的 scheduler.ts / store.ts 是定时器的
  // 唯一合法归宿(Scheduler 本体 / 落盘防抖)，不在此约束——铁律说的是"模块内"。
  {
    files: ['src/modules/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: '铁律#3：模块内禁用 setTimeout，改用注入的 Scheduler.schedule()。' },
        { name: 'setInterval', message: '铁律#3：模块内禁用 setInterval，改用注入的 Scheduler。' },
      ],
    },
  },

  // 仅 modules/ 下：禁止 import 兄弟模块（铁律#2）。combat 是无状态纯函数，是唯一例外。
  {
    files: ['src/modules/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '!./combat.js'],
              message:
                '铁律#2：模块之间不能互相 import，请改发 Command（要结果）或订阅 Event（广播）。唯一例外是无状态纯函数 combat.js。',
            },
          ],
        },
      ],
    },
  },
);
