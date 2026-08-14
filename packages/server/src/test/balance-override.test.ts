/**
 * 平衡调参覆盖持久化测试（用户需求 A）：
 *  GM 面板 /gm/balance 的手动修改必须写入 data/balance_overrides.json，
 *  该文件在 .gitignore 中，故「部署（git reset --hard）」与「wipe:all 刷档」都不会动它。
 *
 *  覆盖不变量：
 *   P1  保存覆盖后 reloadConfig，应用生效（内存 config 反映修改）。
 *   P2  覆盖文件真实落盘，loadBalanceOverrides 可原样读回（round-trip）。
 *   P3  wipe（resetWorld）不清空/删除 balance_overrides.json，重载后修改依旧生效。
 *   P4  全新进程（再 createGameApp 同 storePath）启动时即读取已有覆盖，无需手动 reload。
 *   P5  mergeOverridesIntoRows 对非法数值（非数字）抛出，防止写坏配置被静默接受。
 *   P6  后一次保存对同字段深合并覆盖前一次（不丢其他字段）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp, type GameApp } from '../app.js';
import {
  loadBalanceOverrides, saveBalanceOverrides, mergeOverridesIntoRows, mergeBalanceOverrides,
  type BalanceOverrides,
} from '../infra/config.js';
import { parseCsvStructured, serializeCsv } from '../infra/csv.js';
import { writeFileSync } from 'node:fs';

let clock = 1_000_000;

/** 取真实 config 目录（与运行时默认一致）。 */
function realConfigDir(): string {
  const probe = createGameApp({ now: () => 1, manualScheduler: true });
  const dir = probe.configDir;
  return dir;
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'kow-bal-'));
}

test('P1+P2+P3+P4：覆盖写入→重载生效→wipe 不动→重启仍生效', () => {
  const dataDir = tmpDataDir();
  const storePath = join(dataDir, 'game.json');
  try {
    const app = createGameApp({ now: () => clock, manualScheduler: true, storePath });
    const overridePath = app.balanceOverridePath;
    assert.ok(overridePath, 'balanceOverridePath 应已配置（storePath 给定）');
    assert.equal(existsSync(overridePath!), false, '初始不应有覆盖文件');

    const before = app.config.buildings.main.popGrowthPerLevel;
    assert.ok(before > 0, 'main.popGrowthPerLevel 应有默认值');

    // 模拟 GM 保存：把 main 的 popGrowthPerLevel 改成 99
    const edits: BalanceOverrides = {
      buildings: { '1': { popGrowthPerLevel: '99' } },
      // 用户手填的祭祀人口成本必须和其他 GM 覆盖一样跨 wipe、生效于新进程。
      constants: { ritual_buff_pop_cost: { value: '20' } },
    };
    saveBalanceOverrides(overridePath!, edits);

    // P1：reloadConfig 后应用生效
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 99, 'reload 后覆盖应生效（P1）');
    assert.equal(app.config.constants.ritualBuffPopCost, 20, 'GM 的祭祀人口成本应生效（P1）');

    // P2：文件真实落盘且可原样读回
    assert.ok(existsSync(overridePath!), '覆盖文件应已落盘');
    const rt = loadBalanceOverrides(overridePath!);
    assert.deepEqual(rt, edits, 'loadBalanceOverrides 应原样读回（P2）');

    // P3：wipe（resetWorld）不应删除覆盖文件，重载后修改依旧
    app.resetWorld({ keepAccounts: false });
    assert.ok(existsSync(overridePath!), 'wipe 不应删除 balance_overrides.json（P3）');
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 99, 'wipe 后重载覆盖应依旧生效（P3）');
    assert.equal(app.config.constants.ritualBuffPopCost, 20, 'wipe 后 GM 的祭祀人口成本仍应生效（P3）');

    // P4：全新进程启动即读取已有覆盖
    const app2 = createGameApp({ now: () => clock, manualScheduler: true, storePath });
    assert.equal(app2.config.buildings.main.popGrowthPerLevel, 99, '新进程启动应读取已有覆盖（P4）');
    assert.equal(app2.config.constants.ritualBuffPopCost, 20, '新进程应读取 GM 的祭祀人口成本（P4）');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('P5：mergeOverridesIntoRows 对非法数值抛出', () => {
  const configDir = realConfigDir();
  const raw = readFileSync(join(configDir, 'buildings.csv'), 'utf8');
  const doc = parseCsvStructured(raw);
  // 合法：数值应通过
  const okRows = mergeOverridesIntoRows(doc.rows, { file: 'buildings.csv', key: 'id', numeric: ['popGrowthPerLevel'] }, {
    '1': { popGrowthPerLevel: '42' },
  });
  const mainRow = okRows.find((r) => String(r.id) === '1');
  assert.equal(mainRow?.popGrowthPerLevel, '42', '合法数值应被写入');

  // 非法：非数字应抛出
  assert.throws(() => {
    mergeOverridesIntoRows(doc.rows, { file: 'buildings.csv', key: 'id', numeric: ['popGrowthPerLevel'] }, {
      '1': { popGrowthPerLevel: 'abc' },
    });
  }, /不是合法数字/, '非数字覆盖应抛错（P5）');
});

test('P6：连续两次保存对同/异字段深合并', () => {
  const dataDir = tmpDataDir();
  const storePath = join(dataDir, 'game.json');
  try {
    const app = createGameApp({ now: () => clock, manualScheduler: true, storePath });
    const overridePath = app.balanceOverridePath!;

    // 第一次：改 main.popGrowthPerLevel + residence.maxLevel
    saveBalanceOverrides(overridePath, { buildings: { '1': { popGrowthPerLevel: '10' }, '16': { maxLevel: '5' } } });
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 10, '第一次保存应生效');
    assert.equal(app.config.buildings.residence.maxLevel, 5, '第一次保存应生效（另一行）');

    // 第二次：只改 main.popGrowthPerLevel，residence 行应保留（模拟 GM 端点深合并）
    const current = loadBalanceOverrides(overridePath);
    const merged = mergeBalanceOverrides(current, { buildings: { '1': { popGrowthPerLevel: '20' } } });
    saveBalanceOverrides(overridePath, merged);
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 20, '第二次保存覆盖同字段');
    assert.equal(app.config.buildings.residence.maxLevel, 5, '第二次保存不应丢失其他字段（P6）');

    // 落盘文件应含两行
    const rt = loadBalanceOverrides(overridePath);
    assert.equal(rt.buildings['1'].popGrowthPerLevel, '20');
    assert.equal(rt.buildings['16'].maxLevel, '5');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('P7：meta.GetGameConfig 下发的 popCapByLevel 反映平衡覆盖（per-level）', async () => {
  const dataDir = tmpDataDir();
  const storePath = join(dataDir, 'game.json');
  try {
    const app = createGameApp({ now: () => clock, manualScheduler: true, storePath });
    const overridePath = app.balanceOverridePath!;
    const baseline = app.config.buildings.woodcutter.levels[1].popCap;
    assert.ok(baseline > 0, 'woodcutter L1 默认 popCap 应 > 0');
    saveBalanceOverrides(overridePath, {
      building_levels: { 'woodcutter|1': { popCap: '99' }, 'woodcutter|2': { popCap: '88' } },
    });
    app.reloadConfig();
    const r = await app.commands.send({ name: 'meta.GetGameConfig', from: 'test', payload: {} });
    assert.equal(r.ok, true);
    const payload = r.payload as any;
    const wc = (payload.buildings as any[]).find((b) => b.kind === 'woodcutter');
    assert.ok(wc, 'meta 应含 woodcutter');
    assert.ok(Array.isArray(wc.popCapByLevel), 'popCapByLevel 应为数组');
    assert.equal(wc.popCapByLevel[0], 99, 'woodcutter L1 覆盖 99 应反映到 meta.popCapByLevel[0]');
    assert.equal(wc.popCapByLevel[1], 88, 'woodcutter L2 覆盖 88 应反映到 meta.popCapByLevel[1]');
    assert.notEqual(wc.popCapByLevel[0], baseline, 'meta 不应回退到默认 CSV 值');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
