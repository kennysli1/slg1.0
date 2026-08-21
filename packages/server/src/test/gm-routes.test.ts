/**
 * GM HTTP 路由测试（Fastify inject）：
 *  1. 未设 GM_TOKEN 时所有路由开放（保持现有默认行为不变）
 *  2. 设置 GM_TOKEN 时，缺少 X-GM-Token header → 401
 *  3. 设置 GM_TOKEN 时，携带正确 X-GM-Token header → 200
 *  4. 危险路由（DELETE /gm/:collection）不带 ?confirm=yes → 400
 *  5. /gm/balance/data GET → 返回 ok:true + meta 字段
 *  6. /gm/balance/save POST round-trip（需 balanceOverridePath 配置；无 storePath 时跳过）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerGmRoutes } from '../gateway/gm.js';
import { createGameApp } from '../app.js';

const SECRET = 'test-gm-token-xyz';

function buildFastify(storePath?: string, configDir?: string) {
  const app = createGameApp({ now: () => 1_000_000, manualScheduler: true, storePath, configDir });
  const fastify = Fastify({ logger: false });
  registerGmRoutes(fastify, app.store, app);
  return { fastify, app };
}

// ─── 1. 未设 GM_TOKEN → 开放 ─────────────────────────────────────────
test('GM_TOKEN 未设时 /gm/collections 无需鉴权', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/gm/collections' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

// ─── 2. 设 GM_TOKEN + 无 header → 401 ────────────────────────────────
test('GM_TOKEN 设置后无 X-GM-Token header → 401', async () => {
  const prev = process.env.GM_TOKEN;
  process.env.GM_TOKEN = SECRET;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/gm/collections' });
    assert.equal(res.statusCode, 401, '缺少 token 应返回 401');
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, false);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

// ─── 3. 设 GM_TOKEN + 正确 header → 200 ─────────────────────────────
test('GM_TOKEN 设置后携带正确 X-GM-Token header → 200', async () => {
  const prev = process.env.GM_TOKEN;
  process.env.GM_TOKEN = SECRET;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({
      method: 'GET',
      url: '/gm/collections',
      headers: { 'x-gm-token': SECRET },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

// ─── 4. 危险路由不带 ?confirm=yes → 400 ─────────────────────────────
test('DELETE /gm/:collection 不带 confirm=yes → 400', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify, app } = buildFastify();
    // 写入一条数据以确保集合存在
    app.store.set('test_col', 'k1', { v: 1 });
    await fastify.ready();
    const res = await fastify.inject({ method: 'DELETE', url: '/gm/test_col' });
    assert.equal(res.statusCode, 400, '危险路由无 confirm 应返回 400');
    const body = JSON.parse(res.body) as { ok: boolean; reason?: string };
    assert.equal(body.ok, false);
    assert.ok(body.reason?.includes('confirm'), `reason 应提及 confirm，实际: ${body.reason}`);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

// ─── 4b. 危险路由带 ?confirm=yes → 成功 ────────────────────────────
test('DELETE /gm/:collection 带 confirm=yes → 清空集合', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify, app } = buildFastify();
    app.store.set('test_col', 'k1', { v: 1 });
    await fastify.ready();
    const res = await fastify.inject({ method: 'DELETE', url: '/gm/test_col?confirm=yes' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

// ─── 5. /gm/balance/data 返回正确结构 ───────────────────────────────
test('/gm/balance/data 返回 ok:true + meta 字段', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/gm/balance/data' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean; meta?: unknown; buildings?: unknown };
    assert.equal(body.ok, true, 'balance/data 应成功');
    assert.ok(body.meta, 'balance/data 应包含 meta 字段');
    assert.ok(body.buildings, 'balance/data 应包含 buildings 数据');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/gm/balance 暴露宝库逐级主/备用槽编辑说明', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/gm/balance' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /每级主\/备用槽/, 'GM 页面应明确显示宝库每级主/备用槽字段');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/gm/quest-modules/data 与 /gm/quest-graph/data 返回完整声明式任务图', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const modulesRes = await fastify.inject({ method: 'GET', url: '/gm/quest-modules/data' });
    assert.equal(modulesRes.statusCode, 200);
    const modules = JSON.parse(modulesRes.body) as { ok: boolean; tables?: Record<string, { rows: unknown[] }> };
    assert.equal(modules.ok, true);
    assert.equal(modules.tables?.['quest_lines.csv'].rows.length, 5);
    assert.ok((modules.tables?.['quest_effects.csv'].rows.length ?? 0) >= 12);
    const graphRes = await fastify.inject({ method: 'GET', url: '/gm/quest-graph/data' });
    assert.equal(graphRes.statusCode, 200);
    const graph = JSON.parse(graphRes.body) as { ok: boolean; graph?: { quests: Record<string, unknown>; edges: unknown[] } };
    assert.equal(graph.ok, true);
    assert.ok(graph.graph?.quests.s2, '关系图必须包含耀武扬威');
    assert.ok((graph.graph?.edges.length ?? 0) >= 5);
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/gm/quest-modules 页面脚本可解析并生成可切换标签', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const page = await fastify.inject({ method: 'GET', url: '/gm/quest-modules' });
    assert.equal(page.statusCode, 200);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, '编辑器页面应包含初始化脚本');
    assert.doesNotThrow(() => new Function(script), '编辑器脚本必须是合法 JavaScript');
    assert.match(page.body, /data-tab=/, '标签按钮必须使用安全的数据属性绑定');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/gm/quest-modules/save 整图校验后热重载，非法边不写入', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const tempRoot = mkdtempSync(join(tmpdir(), 'kow-quest-modules-'));
  const tempConfig = join(tempRoot, 'config');
  const seed = buildFastify();
  cpSync(seed.app.configDir, tempConfig, { recursive: true });
  await seed.fastify.close();
  try {
    const { fastify, app } = buildFastify(undefined, tempConfig);
    await fastify.ready();
    const get = await fastify.inject({ method: 'GET', url: '/gm/quest-modules/data' });
    const data = JSON.parse(get.body) as { tables: Record<string, { rows: Array<Record<string, string>> }> };
    data.tables['quests.csv'].rows[0].desc = 'GM 可编辑描述';
    const ok = await fastify.inject({ method: 'POST', url: '/gm/quest-modules/save', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tables: data.tables }) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(app.config.quests.m1.desc, 'GM 可编辑描述', '校验通过后必须热重载');
    const before = app.config.quests.m1.desc;
    data.tables['quest_edges.csv'].rows[0].toQuest = 'does_not_exist';
    const bad = await fastify.inject({ method: 'POST', url: '/gm/quest-modules/save', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tables: data.tables }) });
    assert.equal(bad.statusCode, 400, '非法关系边必须被拒绝');
    assert.equal(app.config.quests.m1.desc, before, '失败不能留下半截配置或重载');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ─── 6. balance save/get round-trip ──────────────────────────────────
test('/gm/balance/save → save 写入覆盖 → balance/data 反映修改', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const dataDir = mkdtempSync(join(tmpdir(), 'kow-gm-'));
  const storePath = join(dataDir, 'game.json');
  try {
    const { fastify, app } = buildFastify(storePath);
    await fastify.ready();

    // 取 main 建筑 id 以作主键
    const mainId = String(app.config.buildings['main'].id);
    const origGrowth = app.config.buildings['main'].popGrowthPerLevel;

    // 保存覆盖：把 main 的 popGrowthPerLevel 改成 999
    const saveRes = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buildings: { [mainId]: { popGrowthPerLevel: '999' } } }),
    });
    assert.equal(saveRes.statusCode, 200, `save 应成功：${saveRes.body}`);
    const saveBody = JSON.parse(saveRes.body) as { ok: boolean };
    assert.equal(saveBody.ok, true);

    // 热重载后 config 应已更新
    assert.equal(
      app.config.buildings['main'].popGrowthPerLevel,
      999,
      `热重载后 popGrowthPerLevel 应为 999，原值=${origGrowth}`,
    );

    // balance/data 返回值也应反映覆盖
    const dataRes = await fastify.inject({ method: 'GET', url: '/gm/balance/data' });
    const dataBody = JSON.parse(dataRes.body) as { ok: boolean; buildings?: Array<Record<string, unknown>> };
    assert.equal(dataBody.ok, true);
    const mainRow = (dataBody.buildings ?? []).find((r) => String(r['id']) === mainId);
    assert.ok(mainRow, 'balance/data 中应包含 main 行');
    assert.equal(
      Number(mainRow['popGrowthPerLevel']),
      999,
      'balance/data 中 main.popGrowthPerLevel 应为 999',
    );

    // 宝库每级的 treasureSlots 是复合主键字段；GM 修改后应热重载，
    // 且该增量同时作为主宝物栏与备用宝物栏的容量来源。
    const treasurySave = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ building_levels: { 'treasury|1': { treasureSlots: '7' } } }),
    });
    assert.equal(treasurySave.statusCode, 200, `宝库槽位覆盖应成功：${treasurySave.body}`);
    assert.equal(app.config.buildings.treasury.levels[1].treasureSlots, 7, '宝库 L1 treasureSlots 应热重载为 7');

    const levelData = JSON.parse((await fastify.inject({ method: 'GET', url: '/gm/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const treasuryLevel = (levelData.building_levels ?? []).find((r) => r.code === 'treasury' && String(r.level) === '1');
    assert.equal(Number(treasuryLevel?.treasureSlots), 7, 'balance/data 应返回修改后的宝库槽位');

    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
