import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCsvStructured, serializeCsv, type CsvRow } from './csv.js';
import {
  mergeOverridesIntoRows,
  type BalanceOverrides,
  type BalanceTableMeta,
} from './balance-overrides.js';
import { loadGameConfig } from './config.js';

/**
 * 配置权威与同步基础设施。
 *
 * 运行时游戏状态由 GameApp 的 JSON store 管理；这里管理的是静态 config/*.csv
 * 的版本、共享镜像和 GitHub 异步镜像队列。队列文件是运维元数据，不是游戏参数。
 */

export const CONFIG_MANIFEST = 'balance_csv_files.list';
export const CONFIG_REVISION_FILE = 'config_revision.json';
export const CONFIG_SYNC_OUTBOX_FILE = 'config_sync_outbox.json';
export const CONFIG_SYNC_STATUS_FILE = 'config_sync_status.json';
export const CONFIG_SYNC_BRANCH = 'config-sync/live';

export interface ConfigRevision {
  revision: number;
  updatedAt: string;
  files: Record<string, string>;
}

export type ConfigSyncState = 'idle' | 'pending' | 'checking' | 'conflict' | 'ready' | 'merged' | 'error';

export interface ConfigCheckStatus {
  name: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
}

export interface ConfigPullRequestStatus {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeStateStatus: string | null;
  baseSha: string | null;
  headSha: string | null;
  changedFiles: string[];
  conflictFiles: string[];
  checks: ConfigCheckStatus[];
  checkedAt: string;
}

export interface ConfigConflictFile {
  file: string;
  status: string;
  authority: string;
  main: string;
  branch: string;
}

export interface ConfigSyncStatus {
  revision: number;
  updatedAt: string | null;
  files: Record<string, string>;
  pending: { revision: number; files: string[]; enqueuedAt: string } | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastStatusError: string | null;
  pullRequestUrl: string | null;
  pullRequest: ConfigPullRequestStatus | null;
  syncState: ConfigSyncState;
  blockedReason: string | null;
  enabled: boolean;
}

interface Outbox {
  revision: number;
  files: string[];
  enqueuedAt: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastStatusError?: string;
  pullRequestUrl?: string;
  pullRequest?: ConfigPullRequestStatus;
  syncState?: ConfigSyncState;
  blockedReason?: string;
}

interface GithubRefResponse { object: { sha: string }; }
interface GithubCommitResponse { sha: string; tree: { sha: string }; }
interface GithubPullResponse {
  number: number;
  html_url: string;
  state: string;
  /** GitHub returns `state: closed` for both merged and closed PRs. */
  merged_at?: string | null;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string | null;
  base: { sha: string };
  head: { sha: string };
}
interface GithubPullFileResponse {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
}
interface GithubCheckRunsResponse {
  check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; html_url?: string | null }>;
}
interface GithubContentResponse {
  type?: string;
  encoding?: string;
  content?: string;
}

function configFileName(path: string): string | null {
  if (!/^config\/[A-Za-z0-9_.-]+\.csv$/.test(path)) return null;
  return path.slice('config/'.length);
}

function isConflictState(pr: ConfigPullRequestStatus | null): boolean {
  return Boolean(pr && pr.state.toLowerCase() === 'open'
    && (pr.mergeable === false || ['dirty', 'blocked'].includes(pr.mergeStateStatus ?? '')));
}

function deriveSyncState(
  outbox: Outbox | null,
  pullRequest: ConfigPullRequestStatus | null,
  lastError: string | null,
): ConfigSyncState {
  if (lastError) return 'error';
  if (outbox) return 'pending';
  if (!pullRequest) return 'idle';
  if (pullRequest.state.toUpperCase() === 'MERGED') return 'merged';
  if (isConflictState(pullRequest)) return 'conflict';
  if (pullRequest.mergeable === true) {
    const completed = pullRequest.checks.length > 0
      && pullRequest.checks.every((check) => ['success', 'skipped', 'neutral'].includes((check.conclusion ?? '').toLowerCase()));
    return completed ? 'ready' : 'checking';
  }
  return 'checking';
}

export interface ConfigAuthorityOptions {
  configDir: string;
  /** production: shared/config；测试/内存模式可以不提供。 */
  persistentConfigDir?: string | null;
  /** production: shared/data；用于版本、队列和旧 JSON 迁移备份。 */
  stateDir?: string | null;
  now?: () => number;
  syncDelayMs?: number;
  githubToken?: string;
  githubRepo?: string;
  githubApiBase?: string;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function resolveSharedConfigDir(configDir: string, stateDir?: string | null): string | null {
  if (!stateDir) return null;
  try {
    if (lstatSync(stateDir).isSymbolicLink()) {
      return join(dirname(realpathSync(stateDir)), 'config');
    }
  } catch {
    // 目录尚未创建时使用传入路径。
  }
  return join(stateDir, 'config');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function csvFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^[A-Za-z0-9_.-]+\.csv$/.test(file))
    .sort();
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function tableKey(row: CsvRow, table: BalanceTableMeta): string {
  if (table.keyComposite) return table.keyComposite.map((key) => row[key] ?? '').join('|');
  return row[table.key ?? ''] ?? '';
}

/**
 * Rows removed by a deliberate schema/configuration migration may still be
 * present in the one-time legacy JSON.  They must be archived rather than
 * aborting startup (otherwise an old main|5 override would prevent every
 * release after the main-base model changed to four levels).
 */
function isRemovedLegacyRow(name: string, rowKey: string, rows: CsvRow[], table: BalanceTableMeta): boolean {
  if (name !== 'building_levels' || !table.keyComposite?.includes('code') || !table.keyComposite.includes('level')) return false;
  const [code, rawLevel] = rowKey.split('|');
  const level = Number(rawLevel);
  if (code !== 'main' || !Number.isInteger(level)) return false;
  const mainLevels = rows
    .filter((row) => row.code === 'main')
    .map((row) => Number(row.level))
    .filter((value) => Number.isInteger(value));
  const maxLevel = Math.max(...mainLevels);
  return mainLevels.length > 0 && level > maxLevel;
}

/** 仅供一次性迁移使用的旧 JSON 表映射。迁移后运行时不再读取 JSON。 */
const LEGACY_TABLES: Record<string, BalanceTableMeta> = {
  buildings: { file: 'buildings.csv', key: 'id', numeric: ['maxLevel', 'maxCount', 'mainBaseLevel', 'prosperityPerLevel', 'popGrowthPerLevel'] },
  building_levels: { file: 'building_levels.csv', keyComposite: ['code', 'level'], numeric: ['costWood', 'costClay', 'costIron', 'costCrop', 'costGold', 'timeSec', 'popCap', 'prod', 'treasureSlots', 'storagePerLevel', 'defensePerLevel', 'buildSpeedupPerLevel', 'trainTimeReducePerLevel', 'trainCostReducePerLevel', 'taskRefreshSec', 'taskMaxTasks', 'taskSideQuestChance', 'vaultProtectWood', 'vaultProtectClay', 'vaultProtectIron', 'vaultProtectCrop', 'vaultProtectGold'] },
  units: { file: 'units.csv', key: 'id', numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'speed', 'vision', 'carry', 'upkeep', 'costWood', 'costClay', 'costIron', 'costCrop', 'trainSec', 'popCost'] },
  mercenaries: { file: 'mercenaries.csv', key: 'id', numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'speed', 'carry', 'goldCost'] },
  merc_camp: { file: 'merc_camp.csv', key: 'level', numeric: ['refreshSec', 'mercCount', 'maxStoredRefreshes'] },
  trade_center: { file: 'trade_center.csv', key: 'level', numeric: ['tradeRoutes', 'tradeViewRadius', 'npcOrderCount', 'npcRefreshSec', 'npcStoredRefreshes'] },
  kingdom_services: { file: 'kingdom_services.csv', key: 'id', numeric: ['minCouncilLevel', 'reputationCost', 'unitCount', 'wood', 'clay', 'iron', 'crop', 'gold', 'delaySec'] },
  pve_targets: { file: 'pve_targets.csv', key: 'id', numeric: ['respawnSec', 'lootWood', 'lootClay', 'lootIron', 'lootCrop'] },
  pve_defenders: { file: 'pve_defenders.csv', keyComposite: ['targetId', 'unitCode'], numeric: ['count', 'meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'carry'] },
  treasures: { file: 'treasures.csv', key: 'id', numeric: ['effectValue', 'reputationValue', 'priceGold', 'dropRate'] },
  constants: { file: 'game_constants.csv', key: 'key', numericByType: true },
  research: { file: 'research.csv', key: 'id', numeric: ['tier', 'mainBaseLevel', 'effectValue', 'durationSec', 'rpCost'] },
  academy: { file: 'academy.csv', key: 'level', numeric: ['checkIntervalSec', 'baseProbability', 'probabilityGainPerFail', 'maxProbability', 'popFactor'] },
};

/**
 * 旧版曾存在、但已经从运行时和 CSV 正式删除的覆盖键。
 * 这些键不能再映射到一个含义不同的新参数；迁移时仅从待应用集合中
 * 排除并把原始 JSON 完整归档，避免服务器因历史遗留值无法发布。
 */
const REMOVED_LEGACY_ROWS: Record<string, ReadonlySet<string>> = {
  constants: new Set(['treasure_trade_drop_chance', 'pop_labor_floor']),
};

/** 旧版表中曾存在、但当前 CSV 已删除的字段；原始 JSON 仍会完整归档。 */
const REMOVED_LEGACY_FIELDS: Record<string, ReadonlySet<string>> = {
  research: new Set(['effectValue']),
};

export interface LegacyMigrationResult {
  migrated: boolean;
  files: string[];
  backupPath?: string;
  reason?: string;
}

/**
 * 将旧版 balance_overrides.json 一次性折叠进 CSV，并在成功后改名归档。
 * 所有写入先在临时目录中完整 loadGameConfig 校验，失败时保留原 JSON。
 */
export function migrateLegacyBalanceOverrides(opts: {
  configDir: string;
  persistentConfigDir?: string | null;
  overridePath: string;
  backupDir?: string;
}): LegacyMigrationResult {
  if (!existsSync(opts.overridePath)) return { migrated: false, files: [], reason: 'not_found' };
  let overrides: BalanceOverrides;
  try {
    const parsed = JSON.parse(readFileSync(opts.overridePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点必须是对象');
    overrides = parsed as BalanceOverrides;
  } catch (err) {
    throw new Error(`balance_overrides.json 无法解析，已保留原文件：${err instanceof Error ? err.message : String(err)}`);
  }
  const nonEmptyEntries = Object.entries(overrides).filter(([, changes]) => Object.keys(changes ?? {}).length > 0);
  const unknown = nonEmptyEntries.filter(([name]) => !LEGACY_TABLES[name]).map(([name]) => name);
  if (unknown.length > 0) throw new Error(`旧配置包含未知表，已停止迁移以避免丢值：${unknown.join(', ')}`);
  const ignoredRemoved: string[] = [];
  const entries = nonEmptyEntries
    .map(([name, changes]) => {
      const removed = REMOVED_LEGACY_ROWS[name];
      const removedFields = REMOVED_LEGACY_FIELDS[name];
      if ((!removed && !removedFields) || !changes || typeof changes !== 'object' || Array.isArray(changes)) return [name, changes] as const;
      const kept: Record<string, Record<string, string>> = {};
      for (const [rowKey, fields] of Object.entries(changes)) {
        if (removed?.has(rowKey)) {
          ignoredRemoved.push(`${name}.${rowKey}`);
          continue;
        }
        if (removedFields && fields && typeof fields === 'object' && !Array.isArray(fields)) {
          const keptFields: Record<string, string> = {};
          for (const [field, value] of Object.entries(fields)) {
            if (removedFields.has(field)) ignoredRemoved.push(`${name}.${rowKey}.${field}`);
            else keptFields[field] = value as string;
          }
          if (Object.keys(keptFields).length > 0) kept[rowKey] = keptFields;
        } else {
          kept[rowKey] = fields as Record<string, string>;
        }
      }
      return [name, kept] as const;
    })
    .filter(([, changes]) => Object.keys(changes ?? {}).length > 0);
  if (entries.length === 0) {
    const backup = `${opts.overridePath}.migrated.${Date.now()}`;
    renameSync(opts.overridePath, backup);
    return {
      migrated: true,
      files: [],
      backupPath: backup,
      reason: ignoredRemoved.length > 0 ? `removed_legacy_rows:${ignoredRemoved.join(',')}` : 'empty_or_unknown',
    };
  }

  const tmp = `${opts.configDir}.legacy-migrate-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  try {
    for (const file of csvFiles(opts.configDir)) copyFileSync(join(opts.configDir, file), join(tmp, file));
    const changedFiles: string[] = [];
    for (const [name, changes] of entries) {
      const table = LEGACY_TABLES[name];
      const path = join(tmp, table.file);
      if (!existsSync(path)) throw new Error(`旧配置引用的 CSV 不存在：${table.file}`);
      const doc = parseCsvStructured(readFileSync(path, 'utf8'));
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new Error(`旧配置 ${name} 的行覆盖必须是对象`);
      }
      // A canonical CSV may intentionally have fewer rows than an old
      // balance_overrides.json (for example main|5..10 after the four-stage
      // main-base migration).  Drop only rows that are provably removed by
      // that migration; unknown/misspelled rows continue to fail loudly.
      const activeChanges: Record<string, Record<string, string>> = {};
      const actualKeys = new Set(doc.rows.map((row) => tableKey(row, table)));
      for (const [rowKey, fields] of Object.entries(changes)) {
        if (!actualKeys.has(rowKey)) {
          if (isRemovedLegacyRow(name, rowKey, doc.rows, table)) {
            ignoredRemoved.push(`${name}.${rowKey}`);
            continue;
          }
          throw new Error(`旧配置 ${name} 引用不存在的行：${rowKey}`);
        }
        activeChanges[rowKey] = fields;
      }
      const keyColumns = table.keyComposite ?? (table.key ? [table.key] : []);
      for (const [rowKey, fields] of Object.entries(activeChanges)) {
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          throw new Error(`旧配置 ${name} 行 ${rowKey} 的字段覆盖必须是对象`);
        }
        for (const field of Object.keys(fields)) {
          if (!doc.header.includes(field)) throw new Error(`旧配置 ${name} 行 ${rowKey} 引用不存在的字段：${field}`);
          if (keyColumns.includes(field)) throw new Error(`旧配置 ${name} 不允许覆盖主键字段：${field}`);
        }
      }
      const rows = mergeOverridesIntoRows(doc.rows, table, activeChanges);
      doc.rows = rows;
      writeFileSync(path, serializeCsv(doc), 'utf8');
      changedFiles.push(table.file);
    }
    loadGameConfig(tmp);
    mkdirSync(opts.configDir, { recursive: true });
    for (const file of changedFiles) copyFileSync(join(tmp, file), join(opts.configDir, file));
    if (opts.persistentConfigDir) {
      mkdirSync(opts.persistentConfigDir, { recursive: true });
      for (const file of changedFiles) copyFileSync(join(opts.configDir, file), join(opts.persistentConfigDir, file));
      const manifest = join(opts.backupDir ?? dirname(opts.overridePath), CONFIG_MANIFEST);
      const old = readJson<string[]>(manifest) ?? [];
      atomicWrite(manifest, [...new Set([...old, ...changedFiles])].sort().join('\n') + '\n');
    }
    const backupDir = opts.backupDir ?? dirname(opts.overridePath);
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `balance_overrides.migrated.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    renameSync(opts.overridePath, backup);
    return {
      migrated: true,
      files: changedFiles,
      backupPath: backup,
      ...(ignoredRemoved.length > 0 ? { reason: `ignored_removed_rows:${ignoredRemoved.join(',')}` } : {}),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export class ConfigAuthority {
  readonly configDir: string;
  readonly persistentConfigDir: string | null;
  readonly stateDir: string | null;
  private readonly now: () => number;
  private readonly syncDelayMs: number;
  private readonly githubToken: string;
  private readonly githubRepo: string;
  private readonly githubApiBase: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<ConfigSyncStatus> | null = null;

  constructor(opts: ConfigAuthorityOptions) {
    this.configDir = opts.configDir;
    this.stateDir = opts.stateDir ?? null;
    this.persistentConfigDir = opts.persistentConfigDir ?? resolveSharedConfigDir(opts.configDir, this.stateDir);
    this.now = opts.now ?? (() => Date.now());
    this.syncDelayMs = Math.max(1000, opts.syncDelayMs ?? Number(process.env.CONFIG_SYNC_DELAY_MS ?? 30000));
    this.githubToken = opts.githubToken ?? process.env.GITHUB_CONFIG_SYNC_TOKEN ?? '';
    this.githubRepo = opts.githubRepo ?? process.env.GITHUB_CONFIG_SYNC_REPO ?? 'kennysli1/slg1.0';
    this.githubApiBase = (opts.githubApiBase ?? process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private get revisionPath(): string | null { return this.stateDir ? join(this.stateDir, CONFIG_REVISION_FILE) : null; }
  private get outboxPath(): string | null { return this.stateDir ? join(this.stateDir, CONFIG_SYNC_OUTBOX_FILE) : null; }
  private get syncStatusPath(): string | null { return this.stateDir ? join(this.stateDir, CONFIG_SYNC_STATUS_FILE) : null; }

  private readRevision(): ConfigRevision | null {
    return this.revisionPath ? readJson<ConfigRevision>(this.revisionPath) : null;
  }

  private readOutbox(): Outbox | null {
    return this.outboxPath ? readJson<Outbox>(this.outboxPath) : null;
  }

  private readSyncStatus(): Outbox | null {
    return this.syncStatusPath ? readJson<Outbox>(this.syncStatusPath) : null;
  }

  private writeSyncStatus(status: Outbox): void {
    if (this.syncStatusPath) atomicWrite(this.syncStatusPath, JSON.stringify(status, null, 2) + '\n');
  }

  private writeOutbox(outbox: Outbox | null): void {
    if (!this.outboxPath) return;
    if (!outbox) {
      try { renameSync(this.outboxPath, `${this.outboxPath}.done-${Date.now()}`); } catch { /* already absent */ }
      return;
    }
    atomicWrite(this.outboxPath, JSON.stringify(outbox, null, 2) + '\n');
  }

  private snapshot(files: readonly string[], revision: number): ConfigRevision {
    const hashes: Record<string, string> = {};
    for (const file of csvFiles(this.configDir)) hashes[file] = sha256(join(this.configDir, file));
    return { revision, updatedAt: new Date(this.now()).toISOString(), files: hashes };
  }

  /** 记录一次配置提交；本地 CSV/共享镜像完成后才进入此方法。 */
  recordChange(files: readonly string[]): ConfigRevision | null {
    const valid = [...new Set(files)].filter((file) => /^[A-Za-z0-9_.-]+\.csv$/.test(file));
    if (valid.length === 0) return null;
    if (this.persistentConfigDir) {
      mkdirSync(this.persistentConfigDir, { recursive: true });
      for (const file of valid) {
        const source = join(this.configDir, file);
        if (existsSync(source)) copyFileSync(source, join(this.persistentConfigDir, file));
      }
      const manifestPath = this.stateDir ? join(this.stateDir, CONFIG_MANIFEST) : join(dirname(this.persistentConfigDir), CONFIG_MANIFEST);
      const previous = readJson<string[]>(manifestPath) ?? (existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean) : []);
      atomicWrite(manifestPath, [...new Set([...previous, ...valid])].sort().join('\n') + '\n');
    }
    const previous = this.readRevision();
    const revision = this.snapshot(valid, (previous?.revision ?? 0) + 1);
    if (this.revisionPath) atomicWrite(this.revisionPath, JSON.stringify(revision, null, 2) + '\n');
    // 只合并仍在队列中的文件；sync status 里的 files 是上一次成功记录，
    // 不应被当作本次差异再次上传。历史成功/失败元数据仍保留在 outbox，
    // 便于配置中心在下一次 flush 前展示最近状态。
    const pending = this.readOutbox();
    const previousStatus = this.readSyncStatus();
    this.writeOutbox({
      revision: revision.revision,
      files: [...new Set([...(pending?.files ?? []), ...valid])].sort(),
      enqueuedAt: pending?.enqueuedAt ?? revision.updatedAt,
      lastAttemptAt: pending?.lastAttemptAt ?? previousStatus?.lastAttemptAt,
      lastSuccessAt: previousStatus?.lastSuccessAt,
      lastError: pending?.lastError,
      pullRequestUrl: pending?.pullRequestUrl ?? previousStatus?.pullRequestUrl,
    });
    this.scheduleFlush();
    return revision;
  }

  private scheduleFlush(): void {
    if (this.timer || !this.readOutbox()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.syncDelayMs);
    this.timer.unref?.();
  }

  status(): ConfigSyncStatus {
    const revision = this.readRevision();
    const outbox = this.readOutbox();
    const syncStatus = outbox ?? this.readSyncStatus();
    const pullRequest = syncStatus?.pullRequest ?? null;
    const lastError = syncStatus?.lastError ?? null;
    return {
      revision: revision?.revision ?? 0,
      updatedAt: revision?.updatedAt ?? null,
      files: revision?.files ?? {},
      pending: outbox ? { revision: outbox.revision, files: outbox.files, enqueuedAt: outbox.enqueuedAt } : null,
      lastAttemptAt: syncStatus?.lastAttemptAt ?? null,
      lastSuccessAt: syncStatus?.lastSuccessAt ?? null,
      lastError,
      lastStatusError: syncStatus?.lastStatusError ?? null,
      pullRequestUrl: syncStatus?.pullRequestUrl ?? null,
      pullRequest,
      syncState: syncStatus?.syncState ?? deriveSyncState(outbox, pullRequest, lastError),
      blockedReason: syncStatus?.blockedReason ?? null,
      enabled: Boolean(this.githubToken),
    };
  }

  private async github<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.githubToken) throw new Error('未配置 GITHUB_CONFIG_SYNC_TOKEN');
    const response = await fetch(`${this.githubApiBase}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    const payload = body ? JSON.parse(body) as T & { message?: string } : {} as T;
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(payload as { message?: string }).message ?? body}`);
    return payload;
  }

  private pullRequestNumber(url: string | null): number | null {
    const match = url?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
    return match ? Number(match[1]) : null;
  }

  private async fetchGithubContent(path: string, ref: string): Promise<string> {
    const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    const content = await this.github<GithubContentResponse>(
      `/repos/${this.githubRepo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    if (content.type !== 'file' || content.encoding !== 'base64' || typeof content.content !== 'string') {
      throw new Error(`GitHub 文件不是可读取的 CSV：${path}`);
    }
    return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }

  private async fetchPullRequestStatus(url: string | null): Promise<ConfigPullRequestStatus | null> {
    if (!this.githubToken) return null;
    const [owner] = this.githubRepo.split('/');
    let number = this.pullRequestNumber(url);
    if (!number) {
      const open = await this.github<Array<{ number: number; html_url: string }>>(
        `/repos/${this.githubRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${CONFIG_SYNC_BRANCH}`)}&base=main`,
      );
      number = open[0]?.number ?? null;
      if (!number) return null;
    }
    const pr = await this.github<GithubPullResponse>(`/repos/${this.githubRepo}/pulls/${number}`);
    const changed = await this.github<GithubPullFileResponse[]>(`/repos/${this.githubRepo}/pulls/${number}/files?per_page=100`);
    let checks: ConfigCheckStatus[] = [];
    try {
      const checkRuns = await this.github<GithubCheckRunsResponse>(
        `/repos/${this.githubRepo}/commits/${pr.head.sha}/check-runs?per_page=100`,
      );
      checks = (checkRuns.check_runs ?? []).map((check) => ({
        name: check.name ?? '未命名检查',
        status: check.status ?? null,
        conclusion: check.conclusion ?? null,
        url: check.html_url ?? null,
      }));
    } catch {
      // 检查权限不足不应把 PR 状态误报成配置上传失败；页面会显示“检查不可见”。
    }
    const changedFiles = changed
      .map((entry) => configFileName(entry.filename))
      .filter((file): file is string => Boolean(file));
    const result: ConfigPullRequestStatus = {
      number,
      url: pr.html_url,
      // The pulls API reports a merged PR as `closed` and exposes the actual
      // outcome through `merged_at`. Preserve our public MERGED state so the
      // config center does not leave successfully merged syncs stuck at
      // “PR 检查中”.
      state: pr.merged_at ? 'MERGED' : pr.state,
      draft: Boolean(pr.draft),
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeable_state,
      baseSha: pr.base?.sha ?? null,
      headSha: pr.head?.sha ?? null,
      changedFiles,
      conflictFiles: pr.state.toLowerCase() === 'open'
        && (pr.mergeable === false || ['dirty', 'blocked'].includes(pr.mergeable_state ?? '')) ? changedFiles : [],
      checks,
      checkedAt: new Date(this.now()).toISOString(),
    };
    return result;
  }

  private persistPullRequestStatus(pullRequest: ConfigPullRequestStatus | null, statusError?: string | null): void {
    const current = this.readSyncStatus() ?? {} as Outbox;
    const next: Outbox = {
      ...current,
      ...(pullRequest ? { pullRequest, pullRequestUrl: pullRequest.url } : {}),
      ...(statusError !== undefined ? { lastStatusError: statusError ?? undefined } : {}),
      syncState: deriveSyncState(this.readOutbox(), pullRequest, current.lastError ?? null),
      blockedReason: isConflictState(pullRequest)
        ? `PR #${pullRequest?.number ?? '?'} 存在冲突，请在配置中心确认并解决：${pullRequest?.conflictFiles.join('、') || '未识别文件'}`
        : undefined,
    };
    this.writeSyncStatus(next);
  }

  /** 读取并刷新 GitHub PR 状态；上传成功不等于 PR 可合并。 */
  async inspectStatus(): Promise<ConfigSyncStatus> {
    const local = this.status();
    if (!this.githubToken) return local;
    try {
      const pullRequest = await this.fetchPullRequestStatus(local.pullRequestUrl);
      if (pullRequest) this.persistPullRequestStatus(pullRequest, null);
      return this.status();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.readSyncStatus() ?? {} as Outbox;
      this.writeSyncStatus({ ...current, lastStatusError: message });
      return this.status();
    }
  }

  /** 返回冲突文件的配置中心、main 和 PR 当前版本，供人工逐文件确认。 */
  async conflictDetails(): Promise<{ pullRequest: ConfigPullRequestStatus; files: ConfigConflictFile[] }> {
    const status = await this.inspectStatus();
    const pullRequest = status.pullRequest;
    if (!pullRequest || !isConflictState(pullRequest)) throw new Error('当前没有可处理的配置 PR 冲突');
    const files: ConfigConflictFile[] = [];
    for (const file of pullRequest.conflictFiles) {
      const authorityPath = join(this.persistentConfigDir ?? this.configDir, file);
      const authority = existsSync(authorityPath) ? readFileSync(authorityPath, 'utf8') : '';
      const main = pullRequest.baseSha ? await this.fetchGithubContent(`config/${file}`, pullRequest.baseSha) : '';
      const branch = pullRequest.headSha ? await this.fetchGithubContent(`config/${file}`, pullRequest.headSha) : '';
      files.push({ file, status: 'conflict', authority, main, branch });
    }
    return { pullRequest, files };
  }

  private validateResolvedConfig(files: ReadonlyMap<string, string>): void {
    const tmp = mkdtempSync(join(tmpdir(), 'kow-config-conflict-'));
    try {
      for (const file of csvFiles(this.configDir)) copyFileSync(join(this.configDir, file), join(tmp, file));
      for (const [file, content] of files) {
        if (!/^[A-Za-z0-9_.-]+\.csv$/.test(file)) throw new Error(`非法配置文件名：${file}`);
        parseCsvStructured(content);
        writeFileSync(join(tmp, file), content, 'utf8');
      }
      loadGameConfig(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * 提交人工确认后的合并树。以最新 main 为基底，并以最终文本覆盖冲突 CSV，
   * 通过双父提交把 main 纳入 config-sync/live，避免 force push 和重复冲突。
   */
  async resolveConflicts(input: { expectedHeadSha?: string; files: Array<{ file: string; content: string }> }): Promise<ConfigSyncStatus> {
    if (!this.githubToken) throw new Error('未配置 GITHUB_CONFIG_SYNC_TOKEN');
    const details = await this.conflictDetails();
    const expected = new Set(details.files.map((entry) => entry.file));
    const resolutions = new Map<string, string>();
    for (const entry of input.files ?? []) {
      if (!expected.has(entry.file)) throw new Error(`不是当前 PR 的冲突文件：${entry.file}`);
      if (typeof entry.content !== 'string' || entry.content.length > 5_000_000) throw new Error(`冲突文件内容无效：${entry.file}`);
      if (resolutions.has(entry.file)) throw new Error(`重复提交冲突文件：${entry.file}`);
      resolutions.set(entry.file, entry.content);
    }
    const missing = [...expected].filter((file) => !resolutions.has(file));
    if (missing.length > 0) throw new Error(`仍有冲突文件未确认：${missing.join('、')}`);
    this.validateResolvedConfig(resolutions);

    const mainRef = await this.github<GithubRefResponse>(`/repos/${this.githubRepo}/git/ref/heads/main`);
    const branchRef = await this.github<GithubRefResponse>(`/repos/${this.githubRepo}/git/ref/heads/${CONFIG_SYNC_BRANCH}`);
    if (input.expectedHeadSha && input.expectedHeadSha !== branchRef.object.sha) {
      throw new Error('配置 PR 在确认期间已更新，请刷新冲突内容后再提交');
    }
    const mainCommit = await this.github<GithubCommitResponse>(`/repos/${this.githubRepo}/git/commits/${mainRef.object.sha}`);
    const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const [file, content] of resolutions) {
      const blob = await this.github<{ sha: string }>(`/repos/${this.githubRepo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' }),
      });
      tree.push({ path: `config/${file}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const mergedTree = await this.github<{ sha: string }>(`/repos/${this.githubRepo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: mainCommit.tree.sha, tree }),
    });
    const commit = await this.github<GithubCommitResponse>(`/repos/${this.githubRepo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `config: resolve conflicts revision ${this.status().revision}`,
        tree: mergedTree.sha,
        parents: [branchRef.object.sha, mainRef.object.sha],
      }),
    });
    await this.github(`/repos/${this.githubRepo}/git/refs/heads/${CONFIG_SYNC_BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return this.inspectStatus();
  }

  private async pushToGithub(outbox: Outbox): Promise<string | null> {
    const [owner] = this.githubRepo.split('/');
    const mainRef = await this.github<{ object: { sha: string } }>(`/repos/${this.githubRepo}/git/ref/heads/main`);
    let parentSha = mainRef.object.sha;
    try {
      const branchRef = await this.github<{ object: { sha: string } }>(`/repos/${this.githubRepo}/git/ref/heads/${CONFIG_SYNC_BRANCH}`);
      parentSha = branchRef.object.sha;
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('404')) throw err;
      await this.github(`/repos/${this.githubRepo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${CONFIG_SYNC_BRANCH}`, sha: parentSha }) });
    }
    const commit = await this.github<{ tree: { sha: string } }>(`/repos/${this.githubRepo}/git/commits/${parentSha}`);
    const tree = [] as Array<{ path: string; mode: string; type: string; sha: string }>;
    for (const file of outbox.files) {
      const source = join(this.persistentConfigDir ?? this.configDir, file);
      if (!existsSync(source)) throw new Error(`待同步配置不存在：${file}`);
      const blob = await this.github<{ sha: string }>(`/repos/${this.githubRepo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: readFileSync(source, 'base64'), encoding: 'base64' }) });
      tree.push({ path: `config/${file}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.github<{ sha: string }>(`/repos/${this.githubRepo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
    const newCommit = await this.github<{ sha: string }>(`/repos/${this.githubRepo}/git/commits`, { method: 'POST', body: JSON.stringify({ message: `config: sync GM 配置 revision ${outbox.revision}`, tree: newTree.sha, parents: [parentSha] }) });
    await this.github(`/repos/${this.githubRepo}/git/refs/heads/${CONFIG_SYNC_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
    const query = `/repos/${this.githubRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${CONFIG_SYNC_BRANCH}`)}&base=main`;
    const open = await this.github<Array<{ html_url: string }>>(query);
    if (open.length > 0) return open[0]?.html_url ?? null;
    const pr = await this.github<{ html_url: string }>(`/repos/${this.githubRepo}/pulls`, { method: 'POST', body: JSON.stringify({ title: `配置同步 revision ${outbox.revision}`, head: CONFIG_SYNC_BRANCH, base: 'main', body: `服务器配置中心异步同步。\n\n- revision: ${outbox.revision}\n- 文件: ${outbox.files.join(', ')}\n- 合并后按 CLAUDE.md 运行 deploy:prod。` }) });
    return pr.html_url;
  }

  private async flushOnce(): Promise<ConfigSyncStatus> {
    const outbox = this.readOutbox();
    if (!outbox) return this.status();
    outbox.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const pullRequestUrl = await this.pushToGithub(outbox);
      outbox.lastSuccessAt = new Date(this.now()).toISOString();
      outbox.lastError = undefined;
      outbox.pullRequestUrl = pullRequestUrl ?? outbox.pullRequestUrl;
      if (pullRequestUrl && this.githubToken) {
        try {
          outbox.pullRequest = await this.fetchPullRequestStatus(pullRequestUrl) ?? undefined;
          outbox.syncState = deriveSyncState(null, outbox.pullRequest ?? null, null);
          outbox.blockedReason = isConflictState(outbox.pullRequest ?? null)
            ? `PR 存在冲突，请在配置中心确认：${outbox.pullRequest?.conflictFiles.join('、') || '未识别文件'}`
            : undefined;
          outbox.lastStatusError = undefined;
        } catch (err) {
          outbox.lastStatusError = err instanceof Error ? err.message : String(err);
        }
      }
      this.writeSyncStatus(outbox);
      this.writeOutbox(null);
      // 最近一次成功信息保留在版本文件中，队列文件删除后 status 仍可读 revision。
      return this.status();
    } catch (err) {
      outbox.lastError = err instanceof Error ? err.message : String(err);
      if (this.syncStatusPath) atomicWrite(this.syncStatusPath, JSON.stringify(outbox, null, 2) + '\n');
      this.writeOutbox(outbox);
      return this.status();
    }
  }

  /** 手动重试与定时 flush 共用互斥 promise，避免同一批配置创建重复提交。 */
  async flush(): Promise<ConfigSyncStatus> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOnce();
    try {
      return await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** remote-release.sh 在构建完成后调用的旧覆盖迁移入口。 */
if (process.argv[1]?.endsWith('config-authority.js') && process.argv[2] === '--migrate') {
  const configDir = process.env.KOW_CONFIG_DIR;
  const overridePath = process.env.KOW_LEGACY_OVERRIDES;
  if (!configDir || !overridePath) throw new Error('迁移需要 KOW_CONFIG_DIR 与 KOW_LEGACY_OVERRIDES');
  const result = migrateLegacyBalanceOverrides({
    configDir,
    persistentConfigDir: process.env.KOW_SHARED_CONFIG || null,
    overridePath,
    backupDir: process.env.KOW_MIGRATION_BACKUP_DIR,
  });
  // 迁移本身也要留下 revision/outbox，后续运行时异步同步器才能把折叠后的
  // CSV 提交到配置 PR；没有 stateDir 时仍只执行一次性文件迁移。
  if (result.files.length > 0 && process.env.KOW_STATE_DIR) {
    const authority = new ConfigAuthority({
      configDir,
      persistentConfigDir: process.env.KOW_SHARED_CONFIG || null,
      stateDir: process.env.KOW_STATE_DIR,
    });
    authority.recordChange(result.files);
    authority.close();
  }
  console.log(JSON.stringify(result));
}
