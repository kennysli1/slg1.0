/**
 * JsonFileStore 持久化回归：
 *  - WAL 即时落盘 + 崩溃恢复（未 flush 快照也能从 WAL 回放）
 *  - flush 后 WAL 截断，二次载入仅靠快照
 *  - 坏档 / 坏 WAL 拒绝空启动
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, MemoryStore } from '../infra/store.js';

test('MemoryStore.flush 为空操作且不抛错', () => {
  const s = new MemoryStore();
  s.set('a', 'k', { n: 1 });
  s.flush();
  assert.deepEqual(s.get('a', 'k'), { n: 1 });
});

test('JsonFileStore：WAL 未压缩时二次启动可恢复全部写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    const s1 = new JsonFileStore(file, 60_000); // 超长防抖，避免自动 flush
    s1.set('economy', 'v1', { wood: 100 });
    s1.set('player', 'p1', { name: 'Alice' });
    s1.delete('economy', 'missing'); // 不存在的 delete 不写 WAL
    // 故意不调用 flush：仅有 WAL
    assert.equal(existsSync(`${file}.wal`), true, '应产生 WAL 文件');

    const s2 = new JsonFileStore(file, 60_000);
    assert.deepEqual(s2.get('economy', 'v1'), { wood: 100 });
    assert.deepEqual(s2.get('player', 'p1'), { name: 'Alice' });
    // 回放后应压缩：WAL 被截断或删除，快照存在
    assert.equal(existsSync(file), true, '回放后应写出快照');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：flush 后 WAL 清空，仅靠快照即可载入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    const s1 = new JsonFileStore(file, 60_000);
    s1.set('building', 'v1', { level: 3 });
    s1.flush();
    const walPath = `${file}.wal`;
    if (existsSync(walPath)) {
      const wal = readFileSync(walPath, 'utf8').trim();
      assert.equal(wal, '', 'flush 后 WAL 应为空');
    }
    const s2 = new JsonFileStore(file, 60_000);
    assert.deepEqual(s2.get('building', 'v1'), { level: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：clear 经 WAL 回放生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    const s1 = new JsonFileStore(file, 60_000);
    s1.set('movement', 'm1', { id: 'm1' });
    s1.set('movement', 'm2', { id: 'm2' });
    s1.clear('movement');
    // 不 flush，靠 WAL 恢复
    const s2 = new JsonFileStore(file, 60_000);
    assert.equal(s2.all('movement').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：损坏的快照拒绝启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    writeFileSync(file, '{not-json', 'utf8');
    assert.throws(
      () => new JsonFileStore(file, 60_000),
      /载入快照失败|拒绝从空存档启动/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：损坏的 WAL 拒绝启动（快照完好也不覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    const s1 = new JsonFileStore(file, 60_000);
    s1.set('a', 'k', 1);
    s1.flush();
    writeFileSync(`${file}.wal`, '{bad-wal-line\n', 'utf8');
    assert.throws(
      () => new JsonFileStore(file, 60_000),
      /回放 WAL 失败|拒绝从空存档启动/,
    );
    // 原快照未被覆盖
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(snap.a.k, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：delete 经 WAL 回放生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'game.json');
  try {
    const s1 = new JsonFileStore(file, 60_000);
    s1.set('pve', 'pve-0', { alive: true });
    s1.flush();
    // 新进程删除但不 flush 快照（只靠 WAL）
    const s2 = new JsonFileStore(file, 60_000);
    s2.delete('pve', 'pve-0');
    const s3 = new JsonFileStore(file, 60_000);
    assert.equal(s3.get('pve', 'pve-0'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonFileStore：全新路径可创建并写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-store-'));
  const file = join(dir, 'nested', 'game.json');
  try {
    const s = new JsonFileStore(file, 60_000);
    s.set('x', '1', { ok: true });
    s.flush();
    assert.equal(existsSync(file), true);
    const s2 = new JsonFileStore(file, 60_000);
    assert.deepEqual(s2.get('x', '1'), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
