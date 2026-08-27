/** 配置中心权威、旧覆盖迁移和 revision/outbox 回归测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameApp } from '../app.js';
import { applyBalanceEdits, BALANCE_TABLES } from '../gateway/gm.js';
import { mergeOverridesIntoRows } from '../infra/config.js';
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
