/** 配置中心权威、旧覆盖迁移和 revision/outbox 回归测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

test('发布配置合并：配置中心空值、自建行与 Git 新行同时保留', () => {
  const dir = tempDir('kow-dialogue-merge-script-');
  const canonical = join(dir, 'dialogues.csv');
  const persisted = join(dir, 'persisted-dialogues.csv');
  try {
    writeFileSync(canonical, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段,take:收下',
      '39,m11_deliver,m11,deliver,2,长老,第二段,take:收下',
      '40,m12_accept,m12,accept,1,使者,Git 新增对话,accept:接受任务',
      '',
    ].join('\n'));
    writeFileSync(persisted, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段（已调参）,take:收下',
      '39,m11_deliver,m11,deliver,2,长老,第二段（已调参）,',
      '99,custom_deliver,m11,deliver,1,长老,配置中心新增对话,',
      '',
    ].join('\n'));
    const repoRoot = existsSync(join(process.cwd(), 'scripts', 'merge-persisted-config.mjs'))
      ? process.cwd()
      : join(process.cwd(), '..', '..');
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'merge-persisted-config.mjs'), canonical, persisted, 'dialogues.csv'], { stdio: 'pipe' });
    const rows = parseCsvStructured(readFileSync(canonical, 'utf8')).rows;
    assert.equal(rows.length, 4);
    assert.equal(rows.find((row) => row.segment === '1')?.npcText, '第一段（已调参）');
    const second = rows.find((row) => row.code === 'm11_deliver' && row.segment === '2');
    assert.equal(second?.npcText, '第二段（已调参）');
    assert.equal(second?.replies, '', '配置中心明确清空的 replies 不能被 Git 默认值补回');
    assert.ok(rows.some((row) => row.code === 'm12_accept'), 'Git 新增行仍应进入新 release');
    assert.ok(rows.some((row) => row.code === 'custom_deliver'), '配置中心新增行在配置 PR 合并前也必须跨部署保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('发布配置合并：配置中心删除行通过墓碑跨部署保留', () => {
  const dir = tempDir('kow-dialogue-delete-merge-script-');
  const canonical = join(dir, 'dialogues.csv');
  const persisted = join(dir, 'persisted-dialogues.csv');
  const tombstones = join(dir, 'config_row_tombstones.json');
  try {
    writeFileSync(canonical, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段,take:收下',
      '39,m11_deliver,m11,deliver,2,长老,第二段,take:收下',
      '40,m12_accept,m12,accept,1,使者,Git 新增对话,accept:接受任务',
      '',
    ].join('\n'));
    writeFileSync(persisted, [
      'id,code,taskCode,trigger,segment,npcName,npcText,replies',
      '39,m11_deliver,m11,deliver,1,长老,第一段,take:收下',
      '',
    ].join('\n'));
    writeFileSync(tombstones, JSON.stringify({
      version: 1,
      tables: { 'dialogues.csv': [['m11_deliver', '2']] },
    }));
    const repoRoot = existsSync(join(process.cwd(), 'scripts', 'merge-persisted-config.mjs'))
      ? process.cwd()
      : join(process.cwd(), '..', '..');
    execFileSync(process.execPath, [
      join(repoRoot, 'scripts', 'merge-persisted-config.mjs'), canonical, persisted, 'dialogues.csv', tombstones,
    ], { stdio: 'pipe' });
    const rows = parseCsvStructured(readFileSync(canonical, 'utf8')).rows;
    assert.equal(rows.some((row) => row.code === 'm11_deliver' && row.segment === '2'), false,
      '配置中心明确删除的段落不能被 Git 行复活');
    assert.ok(rows.some((row) => row.code === 'm12_accept'), '没有删除记录的 Git 新行仍应进入新 release');
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

test('配置中心：显示 PR 冲突并可提交人工确认后的双父解决提交', async () => {
  const cfg = seedConfig();
  const state = tempDir('kow-config-conflict-state-');
  const localUnits = readFileSync(join(cfg.dir, 'units.csv'), 'utf8');
  const mainUnits = localUnits.replace('4000', '4001');
  const branchUnits = localUnits.replace('4000', '40');
  let branchSha = 'branch-sha';
  let mergeable = false;
  let mergeState = 'dirty';
  let pullState = 'open';
  let mergedAt: string | null = null;
  let commitParents: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/repos/owner/repo/pulls/7') {
      return send(200, {
        number: 7,
        html_url: 'https://github.com/owner/repo/pull/7',
        state: pullState,
        merged_at: mergedAt,
        draft: false,
        mergeable,
        mergeable_state: mergeState,
        base: { sha: 'main-sha' },
        head: { sha: branchSha },
      });
    }
    if (req.method === 'GET' && path === '/repos/owner/repo/pulls/7/files') {
      return send(200, [{ filename: 'config/units.csv', status: 'modified', additions: 1, deletions: 1 }]);
    }
    if (req.method === 'GET' && path === `/repos/owner/repo/commits/${branchSha}/check-runs`) {
      return send(200, { check_runs: [] });
    }
    if (req.method === 'GET' && path === '/repos/owner/repo/contents/config/units.csv') {
      const text = url.searchParams.get('ref') === 'main-sha' ? mainUnits : branchUnits;
      return send(200, { type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
    }
    if (req.method === 'GET' && path === '/repos/owner/repo/git/ref/heads/main') return send(200, { object: { sha: 'main-sha' } });
    if (req.method === 'GET' && path === '/repos/owner/repo/git/ref/heads/config-sync/live') return send(200, { object: { sha: branchSha } });
    if (req.method === 'GET' && path === '/repos/owner/repo/git/commits/main-sha') return send(200, { sha: 'main-sha', tree: { sha: 'main-tree' } });
    if (req.method === 'POST' && path === '/repos/owner/repo/git/blobs') return send(201, { sha: 'resolved-blob' });
    if (req.method === 'POST' && path === '/repos/owner/repo/git/trees') return send(201, { sha: 'resolved-tree' });
    if (req.method === 'POST' && path === '/repos/owner/repo/git/commits') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { parents?: string[] };
      commitParents = body.parents ?? [];
      return send(201, { sha: 'resolved-sha', tree: { sha: 'resolved-tree' } });
    }
    if (req.method === 'PATCH' && path === '/repos/owner/repo/git/refs/heads/config-sync/live') {
      branchSha = 'resolved-sha';
      mergeable = true;
      mergeState = 'clean';
      return send(200, {});
    }
    return send(404, { message: `unhandled ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    writeFileSync(join(state, 'config_revision.json'), JSON.stringify({ revision: 53, updatedAt: new Date().toISOString(), files: { 'units.csv': 'hash' } }));
    writeFileSync(join(state, 'config_sync_status.json'), JSON.stringify({ revision: 53, pullRequestUrl: 'https://github.com/owner/repo/pull/7' }));
    const authority = new ConfigAuthority({
      configDir: cfg.dir,
      stateDir: state,
      persistentConfigDir: cfg.dir,
      githubToken: 'test-token',
      githubRepo: 'owner/repo',
      githubApiBase: `http://127.0.0.1:${address.port}`,
      syncDelayMs: 60_000,
    });
    const details = await authority.conflictDetails();
    assert.equal(details.pullRequest.mergeable, false);
    assert.deepEqual(details.pullRequest.conflictFiles, ['units.csv']);
    assert.equal(details.files[0]?.authority, localUnits);
    assert.equal(details.files[0]?.main, mainUnits);
    assert.equal(details.files[0]?.branch, branchUnits);
    const resolved = await authority.resolveConflicts({ expectedHeadSha: 'branch-sha', files: [{ file: 'units.csv', content: localUnits }] });
    assert.equal(resolved.pullRequest?.headSha, 'resolved-sha');
    assert.equal(resolved.syncState, 'checking');
    assert.deepEqual(commitParents, ['branch-sha', 'main-sha']);

    // GitHub's pulls API reports merged PRs as `closed` and uses `merged_at`
    // to distinguish them from an ordinary closed PR.  The config center
    // must expose the merged state instead of showing “PR 检查中” forever.
    pullState = 'closed';
    mergedAt = new Date().toISOString();
    const merged = await authority.inspectStatus();
    assert.equal(merged.pullRequest?.state, 'MERGED');
    assert.equal(merged.syncState, 'merged');
    authority.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cfg.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});
