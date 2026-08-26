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
import { cpSync, mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerGmRoutes } from '../gateway/gm.js';
import { createGameApp } from '../app.js';
import { parseCsvStructured } from '../infra/csv.js';

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

test('GM 修改玩家村庄坐标时同步移动 World 地块', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify, app } = buildFastify();
    const old = await app.commands.send({
      name: 'world.PlaceVillage',
      from: 'test',
      payload: { q: 12, r: 14, refId: 'v-gm-sync', name: '测试村' },
    });
    assert.equal(old.ok, true);
    await fastify.ready();
    const response = await fastify.inject({
      method: 'PUT',
      url: '/gm/player/p-gm-sync',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'p-gm-sync',
        name: '测试玩家',
        ownedVillages: [{ id: 'v-gm-sync', q: 17, r: 35, name: '测试村' }],
      }),
    });
    assert.equal(response.statusCode, 200, response.body);
    const moved = await app.commands.send({ name: 'world.GetTileByRef', from: 'test', payload: { refId: 'v-gm-sync', kind: 'village' } });
    assert.equal(moved.ok, true);
    assert.deepEqual((moved.payload as any).tile, { q: 17, r: 35, kind: 'village', refId: 'v-gm-sync', name: '测试村' });
    const previous = await app.commands.send({ name: 'world.GetTile', from: 'test', payload: { q: 12, r: 14 } });
    assert.equal(previous.ok, true);
    assert.equal((previous.payload as any).tile.kind, 'empty');
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
    assert.match(res.body, /保木材\/级/, 'GM 页面应显示保险库木材保护量字段');
    assert.match(res.body, /保金币\/级/, 'GM 页面应显示保险库金币保护量字段');
    assert.match(res.body, /炼金炉功能参数（合并在升级消耗栏）/, 'GM 页面应把炼金炉参数合并到炼金炉升级消耗卡片');
    assert.match(res.body, /alchemy_refine_sec/, 'GM 页面应提供炼金时间参数');
    assert.match(res.body, /声望参数/, 'GM 页面应包含声望专用调参板块');
    assert.match(res.body, /reputation_s4_release_delta/, 'GM 页面应列出 S4 声望值参数');
    assert.match(res.body, /娜塔莉任务的声望结算/, 'GM 页面应说明娜塔莉任务的声望结算位置');
    assert.match(res.body, /拓荒参数/, 'GM 页面应包含拓荒专用调参板块');
    assert.match(res.body, /found_resource_cost_base/, 'GM 页面应提供第2座城每种资源成本参数');
    assert.match(res.body, /found_resource_cost_growth/, 'GM 页面应提供后续城成本增长倍率参数');
    assert.match(res.body, /第2座城为木材\/泥土\/钢\/粮食各 3000/, 'GM 页面应说明当前默认拓荒成本');
    assert.match(res.body, /kingdom_services/, 'GM 页面应提供议会厅服务参数表');
    assert.match(res.body, /pve_targets/, 'GM 页面应提供 PvE 目标参数表');
    assert.match(res.body, /pve_defenders/, 'GM 页面应提供 PvE 守军参数表');
    assert.match(res.body, /M8 任务村参数/, 'GM 页面应提供 M8 任务村专用参数板块');
    assert.match(res.body, /M8 攻城倒计时（秒）/, 'GM 页面应提供 M8 攻城倒计时编辑项');
    assert.match(res.body, /m8_attack_delay_sec/, 'GM 页面应提供 M8 攻城倒计时参数键');
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

test('/gm/dialogues 编辑器返回 S3 对话并拒绝未知任务绑定', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const page = await fastify.inject({ method: 'GET', url: '/gm/dialogues' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /NPC 对话编辑/);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script), '对话编辑器脚本必须是合法 JavaScript');
    const data = await fastify.inject({ method: 'GET', url: '/gm/dialogues/data' });
    assert.equal(data.statusCode, 200);
    const parsed = JSON.parse(data.body) as { header: string[]; rows: Array<Record<string, string>> };
    assert.ok(parsed.header.includes('segment'));
    assert.match(page.body, /\+ 段落/);
    assert.match(page.body, /只有 npcName、npcText、replies 可编辑/);
    assert.equal(parsed.rows[0]?.taskCode, 's3');
    assert.match(parsed.rows[0]?.npcText ?? '', /感谢你清除了附近的威胁/);
    const configured = new Set(parsed.rows.map((row) => `${row.taskCode}:${row.trigger}`));
    for (const code of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4']) {
      assert.ok(configured.has(`${code}:accept`), `GM 对话表应预置 ${code} 接取模板`);
    }
    for (const code of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      assert.ok(configured.has(`${code}:deliver`), `GM 对话表应预置 ${code} 交付模板`);
    }
    assert.ok(configured.has('s3:after_accept'), 'GM 对话表应包含 S3 接取后模板');
    const bad = await fastify.inject({
      method: 'POST', url: '/gm/dialogues/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ ...parsed.rows[0], taskCode: 'missing-task' }] }),
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /dialogues\.csv/);
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
  const tempConfig = mkdtempSync(join(tmpdir(), 'kow-gm-config-'));
  const storePath = join(dataDir, 'game.json');
  try {
    // GM 保存现在会写回配置 CSV；测试必须使用隔离副本，不能污染仓库 config/。
    const seed = createGameApp({ now: () => 1_000_000, manualScheduler: true });
    cpSync(seed.configDir, tempConfig, { recursive: true });
    const { fastify, app } = buildFastify(storePath, tempConfig);
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
    const savedBuildings = readFileSync(join(app.configDir, 'buildings.csv'), 'utf8');
    assert.match(savedBuildings, /,main,[^\r\n]*,999,/,
      'GM 平衡参数必须写回当前 release 的默认 buildings.csv');
    assert.ok(existsSync(join(dataDir, 'config', 'buildings.csv')),
      'GM 平衡 CSV 必须镜像到 shared/config 以跨部署保留');

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
    const savedLevels = parseCsvStructured(readFileSync(join(app.configDir, 'building_levels.csv'), 'utf8'));
    const savedTreasuryLevel = savedLevels.rows.find((row) => row.code === 'treasury' && row.level === '1');
    assert.equal(savedTreasuryLevel?.treasureSlots, '7',
      '逐级平衡参数必须写回默认 building_levels.csv');

    const levelData = JSON.parse((await fastify.inject({ method: 'GET', url: '/gm/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const treasuryLevel = (levelData.building_levels ?? []).find((r) => r.code === 'treasury' && String(r.level) === '1');
    assert.equal(Number(treasuryLevel?.treasureSlots), 7, 'balance/data 应返回修改后的宝库槽位');

    const vaultSave = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ building_levels: { 'vault|1': { vaultProtectWood: '777', vaultProtectGold: '8888' } } }),
    });
    assert.equal(vaultSave.statusCode, 200, `保险库保护量覆盖应成功：${vaultSave.body}`);
    assert.equal(app.config.buildings.vault.levels[1].vaultProtectWood, 777, '保险库木材保护量应热重载');
    assert.equal(app.config.buildings.vault.levels[1].vaultProtectGold, 8888, '保险库金币保护量应热重载');

    const vaultData = JSON.parse((await fastify.inject({ method: 'GET', url: '/gm/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const vaultLevel = (vaultData.building_levels ?? []).find((r) => r.code === 'vault' && String(r.level) === '1');
    assert.equal(Number(vaultLevel?.vaultProtectWood), 777, 'balance/data 应返回修改后的保险库木材保护量');

    const alchemySave = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constants: { alchemy_refine_sec: { value: '42' } } }),
    });
    assert.equal(alchemySave.statusCode, 200, `炼金时间覆盖应成功：${alchemySave.body}`);
    assert.equal(app.config.constants.alchemyRefineSec, 42, '炼金炉炼化时间应热重载为 42 秒');
    const constantsData = JSON.parse((await fastify.inject({ method: 'GET', url: '/gm/balance/data' })).body) as {
      constants?: Array<Record<string, unknown>>;
    };
    const alchemyConstant = (constantsData.constants ?? []).find((r) => r.key === 'alchemy_refine_sec');
    assert.equal(Number(alchemyConstant?.value), 42, 'balance/data 应返回修改后的炼金时间');

    const foundingSave = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constants: {
        found_resource_cost_base: { value: '4321' },
        found_resource_cost_growth: { value: '1.5' },
      } }),
    });
    assert.equal(foundingSave.statusCode, 200, `拓荒成本覆盖应成功：${foundingSave.body}`);
    assert.equal(app.config.constants.foundResourceCostBase, 4321, '第2座城每种资源成本应热重载');
    assert.equal(app.config.constants.foundResourceCostGrowth, 1.5, '后续城成本增长倍率应热重载');
    const savedConstants = parseCsvStructured(readFileSync(join(app.configDir, 'game_constants.csv'), 'utf8'));
    const savedFoundBase = savedConstants.rows.find((row) => row.key === 'found_resource_cost_base');
    assert.equal(savedFoundBase?.value, '4321',
      '常量参数必须写回默认 game_constants.csv');
    const foundingData = JSON.parse((await fastify.inject({ method: 'GET', url: '/gm/balance/data' })).body) as {
      constants?: Array<Record<string, unknown>>;
    };
    const foundingBase = (foundingData.constants ?? []).find((r) => r.key === 'found_resource_cost_base');
    const foundingGrowth = (foundingData.constants ?? []).find((r) => r.key === 'found_resource_cost_growth');
    assert.equal(Number(foundingBase?.value), 4321, 'balance/data 应返回修改后的拓荒基础成本');
    assert.equal(Number(foundingGrowth?.value), 1.5, 'balance/data 应返回修改后的拓荒成本倍率');

    await fastify.close();
    // 模拟删档/重启：game.json 会换新，但同一 configDir 和共享 CSV 必须继续作为默认值。
    const restarted = createGameApp({ now: () => 1_000_000, manualScheduler: true, storePath: join(dataDir, 'fresh-game.json'), configDir: tempConfig });
    assert.equal(restarted.config.buildings.main.popGrowthPerLevel, 999, '重启后应读取 GM 写回的 buildings.csv');
    assert.equal(restarted.config.buildings.treasury.levels[1].treasureSlots, 7, '重启后应读取 GM 写回的 building_levels.csv');
    assert.equal(restarted.config.constants.foundResourceCostBase, 4321, '重启后应读取 GM 写回的 game_constants.csv');
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
  }
});

test('生产式 data 符号链接：GM CSV 镜像写入 shared/config 而不是 shared/data/config', { skip: process.platform === 'win32' }, async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const root = mkdtempSync(join(tmpdir(), 'kow-gm-link-'));
  const sharedData = join(root, 'shared', 'data');
  const sharedConfig = join(root, 'shared', 'config');
  const linkedData = join(root, 'current-data');
  const tempConfig = mkdtempSync(join(tmpdir(), 'kow-gm-link-config-'));
  try {
    // 与生产 current/data -> ../../shared/data 相同：balanceOverridePath 保留
    // 符号链接路径，GM 持久化逻辑必须解析到 shared 的同级 config。
    mkdirSync(sharedData, { recursive: true });
    mkdirSync(sharedConfig, { recursive: true });
    symlinkSync(sharedData, linkedData, 'dir');
    const seed = createGameApp({ now: () => 1_000_000, manualScheduler: true });
    cpSync(seed.configDir, tempConfig, { recursive: true });
    const { fastify, app } = buildFastify(join(linkedData, 'game.json'), tempConfig);
    await fastify.ready();
    const mainId = String(app.config.buildings.main.id);
    const res = await fastify.inject({
      method: 'POST',
      url: '/gm/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buildings: { [mainId]: { popGrowthPerLevel: '321' } } }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(existsSync(join(sharedConfig, 'buildings.csv')), '生产式符号链接必须写到 shared/config');
    assert.equal(existsSync(join(sharedData, 'config', 'buildings.csv')), false,
      '不能把持久化配置误写进 shared/data/config');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(root, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
  }
});
