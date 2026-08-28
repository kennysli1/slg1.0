import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGameConfig, validateGameConfig, type BuildingDef } from '../infra/config.js';
import { applyBalanceEdits, BALANCE_TABLES } from '../gateway/gm.js';

/**
 * GM 平衡调参面板 · 复合主键编辑 round-trip 冒烟测试
 * 模拟真实保存流程：复制到临时目录 → applyBalanceEdits 改 building_levels.csv（code|level 复合主键）
 *   → loadGameConfig(tmp) 校验（对应真实保存前的合法性校验）→ 断言写回结果与注释/表头保留。
 *
 * 注：逐等级 popCap 是「该级相对上一级的增量贡献」，硬上限 = Σ 1..当前等级 popCap。
 *   具体增量由配置中心维护；测试只校验编辑目标生效且其余行保持原始配置。
 */

const configDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../config');

function withTmp(fn: (tmp: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'kow-rt-'));
  try {
    cpSync(configDir, tmp, { recursive: true });
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 某建筑所有等级 popCap 增量之和（= 该建筑建到满级时的总硬上限贡献）。 */
function popCapSum(b: BuildingDef): number {
  return Object.values(b.levels).reduce((s, l) => s + l.popCap, 0);
}

test('GM 面板：building_levels 复合主键编辑 round-trip（改 main|1 popCap=99）', () => {
  const table = BALANCE_TABLES['building_levels'];
  assert.ok(table.keyComposite, 'building_levels 应声明复合主键');

  withTmp((tmp) => {
    const baseline = loadGameConfig(configDir);
    // 编辑复合主键 main|1 的 popCap（增量）
    applyBalanceEdits(configDir, tmp, table, { 'main|1': { popCap: '99' } });

    // 1) 临时目录配置必须合法（真实保存前会 loadGameConfig 校验）
    const cfg = loadGameConfig(tmp);
    assert.doesNotThrow(() => validateGameConfig(cfg));

    // 2) 目标单元格已改，其余不变
    assert.equal(cfg.buildings['main'].levels[1].popCap, 99, 'main L1 popCap 增量应改为 99');
    assert.equal(cfg.buildings['main'].levels[2].popCap, baseline.buildings['main'].levels[2].popCap, 'main L2 popCap 增量应保持不变');
    assert.ok((cfg.buildings['woodcutter'].levels[1].prod ?? 0) > 0, '资源田产量不应受影响');
    // 其它建筑逐等级参数及主基地其余等级都应保持当前配置中心值。
    assert.equal(cfg.buildings['residence'].levels[10].popCap, baseline.buildings['residence'].levels[10].popCap, '居民楼 L10 增量应保持不变');
    assert.equal(popCapSum(cfg.buildings['residence']), popCapSum(baseline.buildings['residence']), '居民楼未编辑等级不应受影响');
    assert.equal(popCapSum(cfg.buildings['main']), popCapSum(baseline.buildings['main']) - baseline.buildings['main'].levels[1].popCap + 99, '主基地总和应只反映被编辑等级');

    // 3) 注释与表头原样保留
    const raw = readFileSync(join(tmp, 'building_levels.csv'), 'utf8');
    const lines = raw.split('\n');
    assert.ok(lines[0].startsWith('code,level,'), '首行应为表头');
    assert.ok(lines[1].trimStart().startsWith('#'), '第二行应为注释（注释保留）');
    assert.ok(lines.some((l) => l.startsWith('main,1,') && l.includes(',99,')), '应包含 main,1,...,99 行');
  });
});

test('GM 面板：保险库每级保护量写回 CSV 并由删档后的配置继续加载', () => {
  const table = BALANCE_TABLES['building_levels'];
  assert.ok((table.numeric ?? []).includes('vaultProtectGold'), '保险库保护字段必须列入 GM 数值白名单');
  withTmp((tmp) => {
    applyBalanceEdits(configDir, tmp, table, { 'vault|1': { vaultProtectWood: '777', vaultProtectGold: '8888' } });
    const cfg = loadGameConfig(tmp);
    assert.doesNotThrow(() => validateGameConfig(cfg));
    assert.equal(cfg.buildings.vault.levels[1].vaultProtectWood, 777);
    assert.equal(cfg.buildings.vault.levels[1].vaultProtectGold, 8888);
    const raw = readFileSync(join(tmp, 'building_levels.csv'), 'utf8');
    assert.match(raw, /vault,1,[^\n]*,777,100,100,100,8888(?:,|\r?$)/m, '保险库保护量应写入 CSV 末列');
  });
});

test('GM 面板：非法数值（popCap=-5）应被校验拦截，绝不写半截', () => {
  const table = BALANCE_TABLES['building_levels'];
  withTmp((tmp) => {
    applyBalanceEdits(configDir, tmp, table, { 'main|1': { popCap: '-5' } });
    assert.throws(() => loadGameConfig(tmp), /popCap/, '负数 popCap 应触发校验报错');
  });
});

test('GM 面板：不存在的复合主键应是 no-op（不报错、不新增行、不改已有值）', () => {
  const table = BALANCE_TABLES['building_levels'];
  withTmp((tmp) => {
    const baseline = loadGameConfig(configDir);
    applyBalanceEdits(configDir, tmp, table, { 'nope|99': { popCap: '1' } });
    const cfg = loadGameConfig(tmp);
    assert.equal(cfg.buildings['main'].levels[1].popCap, baseline.buildings['main'].levels[1].popCap, '未改动的行增量应保持配置中心值');
  });
});

test('GM 面板：单主键建筑表（buildings）编辑 round-trip（改 residence maxLevel=5）', () => {
  const table = BALANCE_TABLES['buildings'];
  assert.ok(table.key && !table.keyComposite, 'buildings 应为单主键');
  withTmp((tmp) => {
    // residence 的 id=16（从配置读，避免硬编码）
    const resId = String(loadGameConfig(configDir).buildings['residence'].id);
    applyBalanceEdits(configDir, tmp, table, { [resId]: { maxLevel: '5' } });
    const cfg = loadGameConfig(tmp);
    assert.equal(cfg.buildings['residence'].maxLevel, 5, 'residence maxLevel 应改为 5');
    assert.equal(cfg.buildings['main'].maxLevel, 4, 'main maxLevel 应保持新版四级主基地');
  });
});

test('GM 面板：兵种视野可编辑并由配置加载为运行时权威值', () => {
  const table = BALANCE_TABLES['units'];
  const numeric = table.numeric ?? [];
  assert.ok(numeric.includes('vision'), 'GM units 白名单必须包含 vision');
  withTmp((tmp) => {
    const legionnaireId = String(loadGameConfig(configDir).units.legionnaire.id);
    applyBalanceEdits(configDir, tmp, table, { [legionnaireId]: { vision: '7' } });
    const cfg = loadGameConfig(tmp);
    assert.equal(cfg.units.legionnaire.vision, 7, 'GM 保存的视野值必须覆盖 CSV 并进入运行时配置');
  });
});
