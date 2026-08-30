/** 配置中心权威、旧覆盖迁移和 revision/outbox 回归测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp } from '../app.js';
import { applyBalanceEdits, BALANCE_TABLES } from '../gateway/gm.js';
import { loadGameConfig, mergeOverridesIntoRows } from '../infra/config.js';
import { ConfigAuthority, migrateLegacyBalanceOverrides } from '../infra/config-authority.js';
import { parseCsvStructured } from '../infra/csv.js';

function tempDir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }
function seedConfig(): { dir: string; cleanup: () => void } {
  const seed = createGameApp({ now: () => 1, manualScheduler: true });
  const dir = tempDir('kow-config-');
  cpSync(seed.configDir, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function applyConfigEdit(configDir: string, tableName: string, changes: Record<string, Record<string, string>>): void {
  const table = BALANCE_TABLES[tableName];
  const tmp = tempDir('kow-config-edit-');
  try {
    cpSync(configDir, tmp, { recursive: true });
    applyBalanceEdits(configDir, tmp, table, changes);
    cpSync(join(tmp, table.file), join(configDir, table.file));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('配置中心：CSV 是唯一运行时来源，GM 不再读取或写入 balance_overrides.json', async () => {
  const cfg = seedConfig();
  const dataDir = tempDir('kow-config-state-');
  const storePath = join(dataDir, 'game.json');
  try {
    const app = createGameApp({ now: () => 1_000_000, manualScheduler: true, storePath, configDir: cfg.dir });
    assert.equal(existsSync(app.balanceOverridePath!), false);
    applyConfigEdit(cfg.dir, 'buildings', { '1': { popGrowthPerLevel: '99' } });
    app.configAuthority.recordChange(['buildings.csv']);
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 99);
    assert.ok(existsSync(join(dataDir, 'config', 'buildings.csv')));
    assert.ok(existsSync(join(dataDir, 'config_revision.json')));
    assert.ok(existsSync(join(dataDir, 'config_sync_outbox.json')));
    await app.resetWorld({ keepAccounts: false });
    app.reloadConfig();
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 99, '删档只清进度，不回退 CSV');
    const app2 = createGameApp({ now: () => 1_000_000, manualScheduler: true, storePath: join(dataDir, 'fresh.json'), configDir: cfg.dir });
    assert.equal(app2.config.buildings.main.popGrowthPerLevel, 99, '新进程读取同一 CSV 默认值');
  } finally {
    cfg.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('旧覆盖迁移：合法 balance_overrides.json 折叠进 CSV，成功后带时间戳归档', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-migration-');
  const overridePath = join(state, 'balance_overrides.json');
  try {
    writeFileSync(overridePath, JSON.stringify({ buildings: { '1': { popGrowthPerLevel: '77' } }, constants: { ritual_buff_pop_cost: { value: '20' } } }));
    const result = migrateLegacyBalanceOverrides({ configDir: cfg.dir, persistentConfigDir: join(state, 'config'), overridePath, backupDir: state });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files.sort(), ['buildings.csv', 'game_constants.csv']);
    assert.equal(existsSync(overridePath), false);
    assert.ok(result.backupPath && existsSync(result.backupPath));
    const app = createGameApp({ now: () => 1, manualScheduler: true, configDir: cfg.dir });
    assert.equal(app.config.buildings.main.popGrowthPerLevel, 77);
    assert.equal(app.config.constants.ritualBuffPopCost, 20);
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test('旧覆盖迁移：已删除的历史常量只归档、不阻塞有效覆盖迁移', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-migration-removed-');
  const overridePath = join(state, 'balance_overrides.json');
  try {
    writeFileSync(overridePath, JSON.stringify({
      constants: {
        treasure_trade_drop_chance: { value: '1' },
        ritual_buff_pop_cost: { value: '21' },
      },
    }));
    const result = migrateLegacyBalanceOverrides({ configDir: cfg.dir, persistentConfigDir: join(state, 'config'), overridePath, backupDir: state });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files, ['game_constants.csv']);
    assert.match(result.reason ?? '', /treasure_trade_drop_chance/);
    assert.equal(existsSync(overridePath), false);
    assert.ok(result.backupPath && existsSync(result.backupPath), '原始 JSON 必须完整归档');
    const app = createGameApp({ now: () => 1, manualScheduler: true, configDir: cfg.dir });
    assert.equal(app.config.constants.ritualBuffPopCost, 21);
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test('旧覆盖迁移：已删除字段只归档、同一行的有效字段仍会迁移', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-migration-removed-field-');
  const overridePath = join(state, 'balance_overrides.json');
  try {
    writeFileSync(overridePath, JSON.stringify({
      research: {
        '14': { effectValue: '99', durationSec: '123' },
      },
    }));
    const result = migrateLegacyBalanceOverrides({ configDir: cfg.dir, persistentConfigDir: join(state, 'config'), overridePath, backupDir: state });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files, ['research.csv']);
    assert.match(result.reason ?? '', /research\.14\.effectValue/);
    assert.equal(existsSync(overridePath), false);
    assert.ok(result.backupPath && existsSync(result.backupPath), '原始 JSON 必须完整归档');
    const row = parseCsvStructured(readFileSync(join(cfg.dir, 'research.csv'), 'utf8')).rows.find((entry) => entry.id === '14');
    assert.equal(row?.durationSec, '123');
    assert.equal('effectValue' in (row ?? {}), false);
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test('旧覆盖迁移：新版主基地删除的旧等级行只归档，不阻塞有效覆盖', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-migration-main-level-');
  const overridePath = join(state, 'balance_overrides.json');
  try {
    const baselineMainL4 = loadGameConfig(cfg.dir).buildings.main.levels[4].popCap;
    writeFileSync(overridePath, JSON.stringify({
      building_levels: {
        'main|5': { popCap: '99' },
        'main|1': { popCap: '11' },
      },
    }));
    const result = migrateLegacyBalanceOverrides({ configDir: cfg.dir, persistentConfigDir: join(state, 'config'), overridePath, backupDir: state });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files, ['building_levels.csv']);
    assert.match(result.reason ?? '', /building_levels\.main\|5/);
    assert.equal(existsSync(overridePath), false);
    const app = createGameApp({ now: () => 1, manualScheduler: true, configDir: cfg.dir });
    assert.equal(app.config.buildings.main.levels[1].popCap, 11);
    assert.equal(app.config.buildings.main.levels[4].popCap, baselineMainL4);
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test('旧覆盖迁移：未知表或非法 JSON 会中止且保留原文件', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-migration-bad-');
  const overridePath = join(state, 'balance_overrides.json');
  try {
    writeFileSync(overridePath, JSON.stringify({ unknown_table: { x: { value: '1' } } }));
    assert.throws(() => migrateLegacyBalanceOverrides({ configDir: cfg.dir, overridePath }), /未知表/);
    assert.ok(existsSync(overridePath));
    writeFileSync(overridePath, JSON.stringify({ buildings: { '1': { notAColumn: '1' } } }));
    assert.throws(() => migrateLegacyBalanceOverrides({ configDir: cfg.dir, overridePath }), /不存在的字段/);
    assert.ok(existsSync(overridePath));
    writeFileSync(overridePath, '{broken');
    assert.throws(() => migrateLegacyBalanceOverrides({ configDir: cfg.dir, overridePath }), /无法解析/);
    assert.ok(existsSync(overridePath));
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test('mergeOverridesIntoRows：非法数值仍被拒绝', () => {
  const cfg = seedConfig();
  try {
    const doc = parseCsvStructured(readFileSync(join(cfg.dir, 'buildings.csv'), 'utf8'));
    const rows = mergeOverridesIntoRows(doc.rows, { file: 'buildings.csv', key: 'id', numeric: ['popGrowthPerLevel'] }, { '1': { popGrowthPerLevel: '42' } });
    assert.equal(rows.find((row) => row.id === '1')?.popGrowthPerLevel, '42');
    assert.throws(() => mergeOverridesIntoRows(doc.rows, { file: 'buildings.csv', key: 'id', numeric: ['popGrowthPerLevel'] }, { '1': { popGrowthPerLevel: 'abc' } }), /不是合法数字/);
  } finally {
    cfg.cleanup();
  }
});

test('发布配置合并：旧十级城镇中心不能覆盖新版主基地四级上限', () => {
  const dir = tempDir('kow-config-merge-script-');
  const canonical = join(dir, 'buildings.csv');
  const persisted = join(dir, 'persisted-buildings.csv');
  try {
    writeFileSync(canonical, 'id,code,name,maxLevel,mainBaseLevel\n1,main,主基地,4,1\n2,warehouse,仓库,10,1\n');
    // 这是升级前 shared/config 中仍可能存在的旧表头与旧主基地等级。
    writeFileSync(persisted, 'id,code,name,maxLevel\n1,main,城镇中心,10\n2,warehouse,仓库,10\n');
    const repoRoot = existsSync(join(process.cwd(), 'scripts', 'merge-persisted-config.mjs'))
      ? process.cwd()
      : join(process.cwd(), '..', '..');
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'merge-persisted-config.mjs'), canonical, persisted, 'buildings.csv'], { stdio: 'pipe' });
    const rows = parseCsvStructured(readFileSync(canonical, 'utf8')).rows;
    assert.equal(rows.find((row) => row.code === 'main')?.maxLevel, '4');
    assert.equal(rows.find((row) => row.code === 'main')?.name, '主基地');
    assert.equal(rows.find((row) => row.code === 'warehouse')?.maxLevel, '10');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('发布配置合并：多段对话可共享 id 并按 code+segment 覆盖', () => {
  const dir = tempDir('kow-dialogue-merge-script-');
  const canonical = join(dir, 'dialogues.csv');
  const persisted = join(dir, 'persisted-dialogues.csv');
  try {
    writeFileSync(canonical, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段,,',
      '39,m11_deliver,m11,deliver,2,长老,第二段,,',
      '',
    ].join('\n'));
    writeFileSync(persisted, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段（已调参）,,',
      '39,m11_deliver,m11,deliver,2,长老,第二段（已调参）,,',
      '',
    ].join('\n'));
    const repoRoot = existsSync(join(process.cwd(), 'scripts', 'merge-persisted-config.mjs'))
      ? process.cwd()
      : join(process.cwd(), '..', '..');
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'merge-persisted-config.mjs'), canonical, persisted, 'dialogues.csv'], { stdio: 'pipe' });
    const rows = parseCsvStructured(readFileSync(canonical, 'utf8')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.segment === '1')?.npcText, '第一段（已调参）');
    assert.equal(rows.find((row) => row.segment === '2')?.npcText, '第二段（已调参）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置同步 outbox：只合并未发送的差异，不重复上传上次成功文件', () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-outbox-');
  try {
    const authority = new ConfigAuthority({ configDir: cfg.dir, stateDir: state, syncDelayMs: 60_000 });
    authority.recordChange(['buildings.csv']);
    const first = JSON.parse(readFileSync(join(state, 'config_sync_outbox.json'), 'utf8')) as { files: string[] };
    assert.deepEqual(first.files, ['buildings.csv']);
    authority.recordChange(['units.csv']);
    const second = JSON.parse(readFileSync(join(state, 'config_sync_outbox.json'), 'utf8')) as { files: string[] };
    assert.deepEqual(second.files, ['buildings.csv', 'units.csv']);
    authority.close();

    // 模拟上一批成功：状态文件保留历史 files，但新批次只应从 pending 合并。
    writeFileSync(join(state, 'config_sync_status.json'), JSON.stringify({
      revision: 2, files: ['buildings.csv', 'units.csv'], lastSuccessAt: new Date().toISOString(),
    }));
    rmSync(join(state, 'config_sync_outbox.json'), { force: true });
    const next = new ConfigAuthority({ configDir: cfg.dir, stateDir: state, syncDelayMs: 60_000 });
    next.recordChange(['dialogues.csv']);
    const third = JSON.parse(readFileSync(join(state, 'config_sync_outbox.json'), 'utf8')) as { files: string[]; lastSuccessAt?: string };
    assert.deepEqual(third.files, ['dialogues.csv']);
    assert.ok(third.lastSuccessAt, '新批次仍应保留最近一次成功时间');
    next.close();
  } finally {
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});
