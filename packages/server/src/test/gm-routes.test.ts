/**
 * GM HTTP 路由测试（Fastify inject）：
 *  1. 未设 GM_TOKEN 时所有路由开放（保持现有默认行为不变）
 *  2. 设置 GM_TOKEN 时，缺少 X-GM-Token header → 401
 *  3. 设置 GM_TOKEN 时，携带正确 X-GM-Token header → 200
 *  4. 危险路由（DELETE /gm/:collection）不带 ?confirm=yes → 400
 *  5. /config/balance/data GET → 返回 ok:true + meta 字段
 *  6. /config/balance/save POST round-trip（配置中心写回 CSV）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
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
    assert.deepEqual((moved.payload as any).tile, { q: 17, r: 35, kind: 'village', refId: 'v-gm-sync', name: '测试村', icon: 'bld_main' });
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

// ─── 5. /config/balance/data 返回正确结构 ───────────────────────────────
test('/config/balance/data 返回 ok:true + meta 字段', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/config/balance/data' });
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

test('/config/balance 暴露宝库逐级主/备用槽编辑说明', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const res = await fastify.inject({ method: 'GET', url: '/config/balance' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /每级主\/备用槽/, 'GM 页面应明确显示宝库每级主/备用槽字段');
    assert.match(res.body, /保木材\/级/, 'GM 页面应显示保险库木材保护量字段');
    assert.match(res.body, /保金币\/级/, 'GM 页面应显示保险库金币保护量字段');
    assert.match(res.body, /炼金炉功能参数（合并在升级消耗栏）/, 'GM 页面应把炼金炉参数合并到炼金炉升级消耗卡片');
    assert.match(res.body, /alchemy_refine_sec/, 'GM 页面应提供炼金时间参数');
    assert.match(res.body, /声望参数/, 'GM 页面应包含声望专用调参板块');
    assert.match(res.body, /reputation_s4_release_delta/, 'GM 页面应列出 S4 声望值参数');
    assert.match(res.body, /任务中的声望目标\/效果/, 'GM 页面应集中显示任务声望目标与效果');
    assert.match(res.body, /宝物被动声望和议会厅声望价格/, 'GM 页面应集中显示宝物和议会厅的声望参数');
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
    assert.match(res.body, /地图格子特性 \/ 地形参数/, 'GM 页面应提供地图格子特性专用参数板块');
    assert.match(res.body, /forest_vision_penalty/, 'GM 页面应提供森林视野参数');
    assert.match(res.body, /hills_vision_bonus/, 'GM 页面应提供丘陵视野参数');
    assert.match(res.body, /hills_march_speed_multiplier/, 'GM 页面应提供丘陵行军速度参数');
    assert.match(res.body, /军队规模行军参数/, 'GM 页面应提供军队规模减速参数板块');
    assert.match(res.body, /march_size_reference_pop/, 'GM 页面应提供规模免惩罚人口基准');
    assert.match(res.body, /march_size_penalty/, 'GM 页面应提供规模减速系数');
    assert.match(res.body, /march_size_min_multiplier/, 'GM 页面应提供规模减速最低速度比例');
    assert.match(res.body, /王国城邦参数（三级\/三种族）/, 'GM 页面应提供三级三种族城邦参数板块');
    assert.match(res.body, /kingdom_city_state_tier1_unit_count/, 'GM 页面应提供一级城邦兵种数量参数');
    assert.match(res.body, /kingdom_city_state_unit_pool_gauls/, 'GM 页面应提供高卢城邦兵种池参数');
    assert.match(res.body, /kingdom_fief_unit_count/, 'GM 页面应提供封地兵种数量参数');
    assert.match(res.body, /kingdom_capital_unit_count/, 'GM 页面应提供王都兵种数量参数');
    assert.match(res.body, /kingdom_pve_killed_population_per_reputation/, 'GM 页面应提供王国 PvE 声望人口阈值');
    assert.match(res.body, /kingdom_pve_retaliation_raid_threshold/, 'GM 页面应提供封地掠夺阈值');
    assert.match(res.body, /kingdom_pve_retaliation_siege_threshold/, 'GM 页面应提供封地攻城阈值');
    assert.match(res.body, /kingdom_fief_mercenary_min_ratio/, 'GM 页面应提供封地雇佣军比例参数');
    const renderStart = res.body.indexOf('function render()');
    const reputationCall = res.body.indexOf('html += sectionReputation();', renderStart);
    const terrainCall = res.body.indexOf('html += sectionTerrain();', renderStart);
    assert.ok(renderStart >= 0 && reputationCall >= 0 && terrainCall > reputationCall, '声望参数板块应位于地形参数之前');
    const reputationFnStart = res.body.indexOf('var REP_ROWS = [');
    const reputationFnEnd = res.body.indexOf('function sectionAmbush()', reputationFnStart);
    const reputationSection = res.body.slice(reputationFnStart, reputationFnEnd);
    for (const key of [
      'kingdom_task_tribute_weight',
      'kingdom_task_clear_pve_weight',
      'kingdom_task_attack_evil_weight',
      'kingdom_task_eliminate_troops_weight',
      'kingdom_task_evil_target_threshold',
      'kingdom_task_tribute_reward_reputation',
      'kingdom_task_clear_pve_reward_reputation',
      'kingdom_task_attack_evil_reward_reputation',
      'kingdom_task_eliminate_troops_reward_reputation',
      'kingdom_pve_killed_population_per_reputation',
      'kingdom_pve_retaliation_chunk',
      'kingdom_pve_retaliation_raid_threshold',
      'kingdom_pve_retaliation_siege_threshold',
      'kingdom_fief_mercenary_min_ratio',
      'kingdom_fief_mercenary_max_ratio',
      'kingdom_city_state_reputation_penalty',
    ]) assert.match(reputationSection, new RegExp(key), `声望参数板块应包含 ${key}`);
    const cityStateFnStart = res.body.indexOf('function sectionCityState()');
    const cityStateFnEnd = res.body.indexOf('function sectionKingdom()', cityStateFnStart);
    assert.doesNotMatch(res.body.slice(cityStateFnStart, cityStateFnEnd), /kingdom_pve_killed_population_per_reputation/, '王国 PvE 声望累计参数不应继续散落在城邦板块');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('GM 与配置中心入口分离：GM 首页不再暴露 CSV 编辑器', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const gm = await fastify.inject({ method: 'GET', url: '/gm' });
    assert.equal(gm.statusCode, 200);
    assert.match(gm.body, /配置中心（CSV）/);
    assert.match(gm.body, /任务状态管理/);
    assert.doesNotMatch(gm.body, /任务模块编辑/);
    const center = await fastify.inject({ method: 'GET', url: '/config' });
    assert.equal(center.statusCode, 200);
    assert.match(center.body, /配置中心（CSV）/);
    const page = await fastify.inject({ method: 'GET', url: '/config/quest-modules' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /\/config\/quest-modules\/data/);
    const status = await fastify.inject({ method: 'GET', url: '/config/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.body).ok, true);
    const sync = await fastify.inject({ method: 'POST', url: '/config/sync' });
    assert.equal(sync.statusCode, 200);
    assert.equal(JSON.parse(sync.body).ok, true);
    const legacyPage = await fastify.inject({ method: 'GET', url: '/gm/balance' });
    assert.equal(legacyPage.statusCode, 302, '旧配置页面应跳转到配置中心');
    assert.equal(legacyPage.headers.location, '/config/balance');
    const legacyApi = await fastify.inject({ method: 'GET', url: '/gm/balance/data' });
    assert.equal(legacyApi.statusCode, 410, '旧配置 API 应拒绝写入/读取，避免误用 GM');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/config/quest-modules/data 与 /config/quest-graph/data 返回完整声明式任务图', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const modulesRes = await fastify.inject({ method: 'GET', url: '/config/quest-modules/data' });
    assert.equal(modulesRes.statusCode, 200);
    const modules = JSON.parse(modulesRes.body) as { ok: boolean; tables?: Record<string, { rows: unknown[] }> };
    assert.equal(modules.ok, true);
    assert.equal(modules.tables?.['quest_lines.csv'].rows.length, 6);
    assert.ok((modules.tables?.['quest_effects.csv'].rows.length ?? 0) >= 12);
    const graphRes = await fastify.inject({ method: 'GET', url: '/config/quest-graph/data' });
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

test('/config/dialogues 编辑器返回 S3 对话并拒绝未知任务绑定', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const root = mkdtempSync(join(tmpdir(), 'kow-dialogues-'));
  const tempConfig = join(root, 'config');
  try {
    const seed = buildFastify();
    cpSync(seed.app.configDir, tempConfig, { recursive: true });
    await seed.fastify.close();
    const { fastify, app } = buildFastify(undefined, tempConfig);
    await fastify.ready();
    const page = await fastify.inject({ method: 'GET', url: '/config/dialogues' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /NPC 对话编辑/);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script), '对话编辑器脚本必须是合法 JavaScript');
    assert.match(page.body, /function compareNatural\(a,b\)/, '对话编辑器应使用数字感知排序');
    assert.match(page.body, /match\(\/\\d\+\|\\D\+\/g\)/, '对话编辑器自然排序必须保留数字匹配正则');
    assert.match(page.body, /function compareDialogueCode\(a,b\)/, '对话编辑器应按下划线分段比较 code');
    assert.match(page.body, /function sortRows\(\)/, '对话编辑器应在渲染前按 code、taskCode 排序');
    assert.match(page.body, /r\.trigger==='deliver'.*take:收下/, '新增 deliver 对话段落应默认提供收下回复');
    assert.match(page.body, /\{villageName\}/, '对话编辑器应说明村庄变量');
    assert.match(page.body, /\{fiefName\}/, '对话编辑器应说明封地变量');
    const data = await fastify.inject({ method: 'GET', url: '/config/dialogues/data' });
    assert.equal(data.statusCode, 200);
    const parsed = JSON.parse(data.body) as { header: string[]; rows: Array<Record<string, string>> };
    assert.ok(parsed.header.includes('segment'));
    assert.match(page.body, /\+ 段落/);
    assert.match(page.body, /只有 npcName、npcText、replies 可编辑/);
    const sortedKeys = parsed.rows.map((row) => `${row.code}:${row.taskCode}:${row.segment}`);
    assert.deepEqual(sortedKeys, [...sortedKeys].sort((a, b) => {
      const [codeA, taskCodeA, segmentA] = a.split(':');
      const [codeB, taskCodeB, segmentB] = b.split(':');
      const natural = (left: string, right: string) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
      const codePartsA = codeA.split('_');
      const codePartsB = codeB.split('_');
      const codeParts = Math.min(codePartsA.length, codePartsB.length);
      let codeOrder = 0;
      for (let i = 0; i < codeParts; i++) {
        codeOrder = natural(codePartsA[i], codePartsB[i]);
        if (codeOrder !== 0) break;
      }
      if (codeOrder === 0) codeOrder = codePartsA.length - codePartsB.length;
      if (codeOrder !== 0) return codeOrder;
      const taskCodeOrder = natural(taskCodeA, taskCodeB);
      return taskCodeOrder !== 0 ? taskCodeOrder : Number(segmentA) - Number(segmentB);
    }), '对话编辑器数据应按数字感知的 code、taskCode、段落号排序');
    const m9Index = parsed.rows.findIndex((row) => row.code === 'm9_accept');
    const m10Index = parsed.rows.findIndex((row) => row.code === 'm10_accept');
    assert.ok(m9Index >= 0 && m10Index > m9Index, 'm10 对话必须排在 m9 对话之后');
    const firstS3 = parsed.rows.find((row) => row.code === 's3_accept' && row.segment === '1');
    assert.equal(firstS3?.taskCode, 's3');
    assert.match(firstS3?.npcText ?? '', /感谢你清除了附近的威胁/);
    const byKey = new Map(parsed.rows.map((row) => [`${row.code}:${row.segment}`, row]));
    assert.match(byKey.get('m7_accept:1')?.npcText ?? '', /社会的进步离不开科技的发展/);
    assert.match(byKey.get('m8_accept:1')?.npcText ?? '', /携款潜逃的畜生/);
    assert.match(byKey.get('m8_deliver:1')?.npcText ?? '', /英明的战略决策/);
    assert.equal(byKey.get('m8_deliver:1')?.replies, 'take:收下', '交付对话应在配置中心提供收下回复');
    assert.match(byKey.get('m9_accept:1')?.npcText ?? '', /乘胜追击/);
    assert.match(byKey.get('m9_deliver:1')?.npcText ?? '', /洗劫干净/);
    assert.equal(byKey.get('m8_deliver_success:1'), undefined);
    assert.equal(byKey.get('m9_accept_m8_success:1'), undefined);
    assert.equal(byKey.get('m9_deliver_m8_success:1'), undefined);
    assert.match(byKey.get('m9_deliver_m8_failure:1')?.npcText ?? '', /缴获了一个宝物/);
    assert.match(byKey.get('m12_accept:1')?.npcText ?? '', /\{villageName\}/, '配置中心应保存 M12 村庄变量');
    assert.match(byKey.get('m12_accept:1')?.npcText ?? '', /\{fiefName\}/, '配置中心应保存 M12 封地变量');
    assert.doesNotMatch(byKey.get('m12_accept:1')?.npcText ?? '', /\{封地\}/, '配置中心不应保存中文封地占位符');
    const saved = await fastify.inject({
      method: 'POST', url: '/config/dialogues/save', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: parsed.rows }),
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.match(app.config.dialogues['m12_accept:1']?.npcText ?? '', /\{fiefName\}/, '保存后服务端热重载仍应保留变量');
    const configured = new Set(parsed.rows.map((row) => `${row.taskCode}:${row.trigger}`));
    for (const code of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4']) {
      assert.ok(configured.has(`${code}:accept`), `GM 对话表应预置 ${code} 接取模板`);
    }
    for (const code of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4']) {
      assert.ok(configured.has(`${code}:deliver`), `GM 对话表应预置 ${code} 交付模板`);
    }
    assert.ok(configured.has('s3:accept'), 'GM 对话表应包含 S3 接取模板');
    assert.equal(byKey.get('s3_accept:2'), undefined, 'GM 对话表不应把 S3 after_accept 当作接取第二段');
    assert.ok(byKey.get('s3_after_accept:1'), 'GM 对话表应包含 S3 独立 after_accept 对话');
    assert.ok(configured.has('s3:after_accept'), 'GM 对话表应包含 S3 接取后模板');
    const bad = await fastify.inject({
      method: 'POST', url: '/config/dialogues/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ ...parsed.rows[0], taskCode: 'missing-task' }] }),
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /dialogues\.csv/);
    await fastify.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('配置中心：新增支线任务时自动补齐空白接取/交付对话模板', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const root = mkdtempSync(join(tmpdir(), 'kow-side-dialogue-default-'));
  const tempConfig = join(root, 'config');
  try {
    const seed = buildFastify();
    cpSync(seed.app.configDir, tempConfig, { recursive: true });
    await seed.fastify.close();
    const { fastify } = buildFastify(undefined, tempConfig);
    await fastify.ready();
    const modulesRes = await fastify.inject({ method: 'GET', url: '/config/quest-modules/data' });
    const modules = JSON.parse(modulesRes.body) as { tables: Record<string, { rows: Array<Record<string, string>> }> };
    const side = modules.tables['quests.csv'].rows.find((row) => row.code === 's1');
    const objective = modules.tables['quest_objectives.csv'].rows.find((row) => row.questCode === 's1');
    assert.ok(side && objective, '测试需要复制现有支线的任务与目标节点');
    modules.tables['quests.csv'].rows.push({ ...side, id: '99', code: 's_future_test', name: '测试支线' });
    modules.tables['quest_objectives.csv'].rows.push({ ...objective, id: 'future-objective', questCode: 's_future_test' });
    const save = await fastify.inject({
      method: 'POST', url: '/config/quest-modules/save', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tables: modules.tables }),
    });
    assert.equal(save.statusCode, 200, save.body);
    const dialogues = parseCsvStructured(readFileSync(join(tempConfig, 'dialogues.csv'), 'utf8'));
    assert.ok(dialogues.rows.some((row) => row.code === 's_future_test_accept' && row.taskCode === 's_future_test' && row.trigger === 'accept'));
    assert.ok(dialogues.rows.some((row) => row.code === 's_future_test_deliver' && row.taskCode === 's_future_test' && row.trigger === 'deliver' && row.replies === 'take:收下'));
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('/config 首页将配置入口置于页面顶部', async () => {
  const { fastify } = buildFastify();
  await fastify.ready();
  const page = await fastify.inject({ method: 'GET', url: '/config' });
  assert.equal(page.statusCode, 200);
  const nav = page.body.indexOf('href="/config/balance"');
  const notice = page.body.indexOf('这里修改的是版本化游戏配置');
  assert.ok(nav >= 0, '配置中心首页必须保留配置入口');
  assert.ok(notice >= 0 && nav < notice, '配置入口应出现在说明和状态卡片之前');
  await fastify.close();
});

test('/config/quest-modules 页面脚本可解析并生成可切换标签', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const page = await fastify.inject({ method: 'GET', url: '/config/quest-modules' });
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

test('/gm/tasks 使用任务 code 而不是 active 数组下标', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  try {
    const { fastify } = buildFastify();
    await fastify.ready();
    const page = await fastify.inject({ method: 'GET', url: '/gm/tasks' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Array\.isArray\(s\.active\)/);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script), '任务管理脚本必须是合法 JavaScript');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
  }
});

test('/config/quest-modules/save 整图校验后热重载，非法边不写入', async () => {
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
    const get = await fastify.inject({ method: 'GET', url: '/config/quest-modules/data' });
    const data = JSON.parse(get.body) as { tables: Record<string, { rows: Array<Record<string, string>> }> };
    data.tables['quests.csv'].rows[0].desc = 'GM 可编辑描述';
    const ok = await fastify.inject({ method: 'POST', url: '/config/quest-modules/save', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tables: data.tables }) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(app.config.quests.m1.desc, 'GM 可编辑描述', '校验通过后必须热重载');
    const before = app.config.quests.m1.desc;
    data.tables['quest_edges.csv'].rows[0].toQuest = 'does_not_exist';
    const bad = await fastify.inject({ method: 'POST', url: '/config/quest-modules/save', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tables: data.tables }) });
    assert.equal(bad.statusCode, 400, '非法关系边必须被拒绝');
    assert.equal(app.config.quests.m1.desc, before, '失败不能留下半截配置或重载');
    await fastify.close();
  } finally {
    if (prev !== undefined) process.env.GM_TOKEN = prev;
    else delete process.env.GM_TOKEN;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ─── 6. config center save/get round-trip ──────────────────────────────────
test('/config/balance/save → 写回 CSV → balance/data 反映修改', async () => {
  const prev = process.env.GM_TOKEN;
  delete process.env.GM_TOKEN;
  const dataDir = mkdtempSync(join(tmpdir(), 'kow-gm-'));
  const tempConfig = mkdtempSync(join(tmpdir(), 'kow-gm-config-'));
  const storePath = join(dataDir, 'game.json');
  try {
    // GM 保存现在会写回配置 CSV；测试必须使用隔离副本，不能污染仓库 config/。
    const seed = createGameApp({ now: () => 1_000_000, manualScheduler: true });
    cpSync(seed.configDir, tempConfig, { recursive: true });
    // 模拟历史 shared/config：新增的酒馆支线概率列存在但整列是空值。
    // 配置中心应显示运行时默认 0.5，而不是让管理员看到空白。
    const staleLevelsPath = join(tempConfig, 'building_levels.csv');
    const staleLevels = readFileSync(staleLevelsPath, 'utf8').replace(/^tavern,.*$/gm, (line) => line.replace(',0.5,', ',,'));
    writeFileSync(staleLevelsPath, staleLevels, 'utf8');
    const { fastify, app } = buildFastify(storePath, tempConfig);
    await fastify.ready();

    const initialLevelData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const initialTavernRows = (initialLevelData.building_levels ?? []).filter((r) => r.code === 'tavern');
    assert.equal(initialTavernRows.length, 5, '配置中心应返回全部酒馆等级');
    assert.ok(initialTavernRows.every((r) => Number(r.taskSideQuestChance) === 0.5), '历史空值应展示酒馆支线默认概率 0.5');

    // 取 main 建筑 id 以作主键
    const mainId = String(app.config.buildings['main'].id);
    const origGrowth = app.config.buildings['main'].popGrowthPerLevel;

    // 保存覆盖：把 main 的 popGrowthPerLevel 改成 999
    const saveRes = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
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
    const dataRes = await fastify.inject({ method: 'GET', url: '/config/balance/data' });
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
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ building_levels: { 'treasury|1': { treasureSlots: '7' } } }),
    });
    assert.equal(treasurySave.statusCode, 200, `宝库槽位覆盖应成功：${treasurySave.body}`);
    assert.equal(app.config.buildings.treasury.levels[1].treasureSlots, 7, '宝库 L1 treasureSlots 应热重载为 7');
    const savedLevels = parseCsvStructured(readFileSync(join(app.configDir, 'building_levels.csv'), 'utf8'));
    const savedTreasuryLevel = savedLevels.rows.find((row) => row.code === 'treasury' && row.level === '1');
    assert.equal(savedTreasuryLevel?.treasureSlots, '7',
      '逐级平衡参数必须写回默认 building_levels.csv');

    const levelData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const treasuryLevel = (levelData.building_levels ?? []).find((r) => r.code === 'treasury' && String(r.level) === '1');
    assert.equal(Number(treasuryLevel?.treasureSlots), 7, 'balance/data 应返回修改后的宝库槽位');

    const vaultSave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ building_levels: { 'vault|1': { vaultProtectWood: '777', vaultProtectGold: '8888' } } }),
    });
    assert.equal(vaultSave.statusCode, 200, `保险库保护量覆盖应成功：${vaultSave.body}`);
    assert.equal(app.config.buildings.vault.levels[1].vaultProtectWood, 777, '保险库木材保护量应热重载');
    assert.equal(app.config.buildings.vault.levels[1].vaultProtectGold, 8888, '保险库金币保护量应热重载');

    const vaultData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const vaultLevel = (vaultData.building_levels ?? []).find((r) => r.code === 'vault' && String(r.level) === '1');
    assert.equal(Number(vaultLevel?.vaultProtectWood), 777, 'balance/data 应返回修改后的保险库木材保护量');

    const tavernSave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ building_levels: { 'tavern|1': { taskSideQuestChance: '0' } } }),
    });
    assert.equal(tavernSave.statusCode, 200, `酒馆支线概率覆盖应成功：${tavernSave.body}`);
    assert.equal(app.config.buildings.tavern.levels[1].taskSideQuestChance, 0, '酒馆支线概率可配置为 0');
    const tavernData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      building_levels?: Array<Record<string, unknown>>;
    };
    const tavernLevel = (tavernData.building_levels ?? []).find((r) => r.code === 'tavern' && String(r.level) === '1');
    assert.equal(Number(tavernLevel?.taskSideQuestChance), 0, 'balance/data 应返回酒馆支线概率');

    const alchemySave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constants: { alchemy_refine_sec: { value: '42' } } }),
    });
    assert.equal(alchemySave.statusCode, 200, `炼金时间覆盖应成功：${alchemySave.body}`);
    assert.equal(app.config.constants.alchemyRefineSec, 42, '炼金炉炼化时间应热重载为 42 秒');
    const constantsData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      constants?: Array<Record<string, unknown>>;
    };
    const alchemyConstant = (constantsData.constants ?? []).find((r) => r.key === 'alchemy_refine_sec');
    assert.equal(Number(alchemyConstant?.value), 42, 'balance/data 应返回修改后的炼金时间');

    const foundingSave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
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
    const foundingData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      constants?: Array<Record<string, unknown>>;
    };
    const foundingBase = (foundingData.constants ?? []).find((r) => r.key === 'found_resource_cost_base');
    const foundingGrowth = (foundingData.constants ?? []).find((r) => r.key === 'found_resource_cost_growth');
    assert.equal(Number(foundingBase?.value), 4321, 'balance/data 应返回修改后的拓荒基础成本');
    assert.equal(Number(foundingGrowth?.value), 1.5, 'balance/data 应返回修改后的拓荒成本倍率');

    const marchSizeSave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constants: {
        march_size_reference_pop: { value: '30' },
        march_size_penalty: { value: '0.002' },
        march_size_min_multiplier: { value: '0.5' },
      } }),
    });
    assert.equal(marchSizeSave.statusCode, 200, `规模减速参数覆盖应成功：${marchSizeSave.body}`);
    assert.equal(app.config.constants.marchSizeReferencePop, 30, '规模免惩罚人口基准应热重载');
    assert.equal(app.config.constants.marchSizePenalty, 0.002, '规模减速系数应热重载');
    assert.equal(app.config.constants.marchSizeMinMultiplier, 0.5, '规模减速下限应热重载');
    const marchSizeData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      constants?: Array<Record<string, unknown>>;
    };
    for (const [key, value] of [
      ['march_size_reference_pop', 30],
      ['march_size_penalty', 0.002],
      ['march_size_min_multiplier', 0.5],
    ] as const) {
      const row = (marchSizeData.constants ?? []).find((r) => r.key === key);
      assert.equal(Number(row?.value), value, `balance/data 应返回修改后的 ${key}`);
    }

    const reputationData = JSON.parse((await fastify.inject({ method: 'GET', url: '/config/balance/data' })).body) as {
      kingdom_services?: Array<Record<string, unknown>>;
      treasures?: Array<Record<string, unknown>>;
      quest_objectives?: Array<Record<string, unknown>>;
      quest_effects?: Array<Record<string, unknown>>;
    };
    assert.ok(reputationData.kingdom_services && reputationData.treasures, '声望专用视图应读取议会厅与宝物表');
    assert.ok(reputationData.quest_objectives && reputationData.quest_effects, '声望专用视图应读取任务目标与效果表');
    const reputationSave = await fastify.inject({
      method: 'POST',
      url: '/config/balance/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kingdom_services: { '1': { reputationCost: '3' } },
        treasures: { '25': { reputationValue: '2' } },
        quest_objectives: { 'o-m15': { params: '-6' } },
        quest_effects: { 'e-m12-reputation': { params: '6' } },
      }),
    });
    assert.equal(reputationSave.statusCode, 200, `声望相关行级参数覆盖应成功：${reputationSave.body}`);
    assert.equal(app.config.kingdomServices.supplies_small.reputationCost, 3, '议会厅服务声望价格应热重载');
    assert.equal(app.config.treasures.honest_heart.reputationValue, 2, '宝物被动声望值应热重载');
    assert.equal(app.config.quests.m12.rewards.reputation, 6, '任务声望调整应热重载');
    assert.equal(app.config.quests.m15.objective.threshold, -6, '任务声望目标阈值应热重载');

    await fastify.close();
    // 模拟删档/重启：game.json 会换新，但同一 configDir 和共享 CSV 必须继续作为默认值。
    const restarted = createGameApp({ now: () => 1_000_000, manualScheduler: true, storePath: join(dataDir, 'fresh-game.json'), configDir: tempConfig });
    assert.equal(restarted.config.buildings.main.popGrowthPerLevel, 999, '重启后应读取 GM 写回的 buildings.csv');
    assert.equal(restarted.config.buildings.treasury.levels[1].treasureSlots, 7, '重启后应读取 GM 写回的 building_levels.csv');
    assert.equal(restarted.config.buildings.tavern.levels[1].taskSideQuestChance, 0, '重启后应保留酒馆支线概率');
    assert.equal(restarted.config.constants.foundResourceCostBase, 4321, '重启后应读取 GM 写回的 game_constants.csv');
    assert.equal(restarted.config.constants.marchSizeReferencePop, 30, '重启后应读取规模免惩罚人口基准');
    assert.equal(restarted.config.constants.marchSizePenalty, 0.002, '重启后应读取规模减速系数');
    assert.equal(restarted.config.constants.marchSizeMinMultiplier, 0.5, '重启后应读取规模减速下限');
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
      url: '/config/balance/save',
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
