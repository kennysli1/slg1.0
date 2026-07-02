/**
 * 架构守卫测试：把"四条架构铁律"从"人得记得遵守"变成"违反就红灯，提交不过去"。
 * 对应设计文档 docs/2_2.0设计/07_扩展与代码规范.md 的四铁律。
 *
 * 静态扫描 src/modules/*.ts 源码文本（不执行、不依赖运行时），检查：
 *   铁律#2 跨模块只传 Command/Event —— 模块之间不互相 import
 *   铁律#3 时间统一走 Scheduler   —— 模块内禁 setTimeout/setInterval
 *   铁律#1 状态归属唯一          —— 每个 store 集合名(COLLECTION 字面量)只在其 owner 文件出现
 *
 * 这不是替代 code review，而是把最容易被无意破坏的三条兜底住。
 * 新增合法例外时，改下面的白名单常量并写清理由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

/**
 * 战斗重做后：combat 升级为有状态模块（owns battle 集合），不再被任何模块 import——
 * 三方共用的战斗类型(Snapshot/CombatUnit)已下沉到 infra/combat-types.ts（基础设施可被合法 import）。
 * 因此模块间 import 白名单为空：一律只能走 Command/Event。
 */
const IMPORT_WHITELIST = new Set<string>([]);

interface ModuleFile {
  name: string; // 文件名，如 'economy.ts'
  base: string; // 去后缀，如 'economy'
  text: string; // 源码全文
}

function loadModules(): ModuleFile[] {
  return readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({
      name,
      base: name.replace(/\.ts$/, ''),
      text: readFileSync(join(MODULES_DIR, name), 'utf8'),
    }));
}

test('铁律#2：模块之间不互相 import（combat 纯函数除外）', () => {
  const mods = loadModules();
  const offenders: string[] = [];
  // 匹配从兄弟模块相对导入：from './xxx.js'
  const relImport = /from\s+['"]\.\/([\w-]+\.js)['"]/g;
  for (const m of mods) {
    for (const match of m.text.matchAll(relImport)) {
      const target = match[1];
      if (!IMPORT_WHITELIST.has(target)) {
        offenders.push(`${m.name} → ${target}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `模块间禁止直接 import（应走 Command/Event）。违规：\n  ${offenders.join('\n  ')}`,
  );
});

test('铁律#3：模块内禁止 setTimeout/setInterval（用 Scheduler）', () => {
  const mods = loadModules();
  const offenders: string[] = [];
  const timer = /\b(setTimeout|setInterval)\s*\(/;
  for (const m of mods) {
    m.text.split('\n').forEach((line, i) => {
      if (timer.test(line)) offenders.push(`${m.name}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `模块内禁用定时器，改用注入的 Scheduler。违规：\n  ${offenders.join('\n  ')}`,
  );
});

test('铁律#1：每个 store 集合(COLLECTION 字面量)只属于一个 owner 模块', () => {
  const mods = loadModules();
  // 抽取每个文件里声明的集合名常量：const COLLECTION... = 'xxx'
  // 覆盖 COLLECTION / COLLECTION_BYNAME / COLLECTION_META 等命名变体。
  const declRe = /const\s+COLLECTION\w*\s*=\s*['"]([\w-]+)['"]/g;
  const owner = new Map<string, string>(); // 集合名 → owner 文件
  for (const m of mods) {
    for (const match of m.text.matchAll(declRe)) {
      const coll = match[1];
      const prev = owner.get(coll);
      assert.equal(
        prev,
        undefined,
        `store 集合 '${coll}' 被多个模块声明为 owner：${prev} 与 ${m.name}。一块状态只能有一个 owner。`,
      );
      owner.set(coll, m.name);
    }
  }

  // 反向检查：非 owner 模块不应把别人的集合名传给 store 方法访问其状态。
  // 只匹配 store.<method>('coll' 形态（get/set/all/delete/clear，可带 <泛型>），
  // 避免与恰好同名的普通字符串字面量(如 tile 的 kind:'pve')误撞。
  const offenders: string[] = [];
  for (const [coll, ownerFile] of owner) {
    const storeAccess = new RegExp(`store\\s*\\.\\s*\\w+\\s*(<[^>]*>)?\\s*\\(\\s*['"]${coll}['"]`);
    for (const m of mods) {
      if (m.name === ownerFile) continue;
      m.text.split('\n').forEach((line, i) => {
        if (storeAccess.test(line)) {
          offenders.push(`${m.name}:${i + 1} 通过 store 访问了 '${coll}'（owner 是 ${ownerFile}）`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `别的模块出现了非自己的集合名，疑似直接读写他人状态（应发 Command）。违规：\n  ${offenders.join('\n  ')}`,
  );
});
