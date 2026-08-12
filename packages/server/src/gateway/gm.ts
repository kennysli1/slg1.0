/**
 * GM HTTP API（调试专用）
 *
 * 端点：
 *   GET    /gm                             Web 面板（浏览器直接访问）
 *   GET    /gm/collections                列出所有 store 集合名 + 文档数
 *   GET    /gm/:collection                列出集合内所有 key → 文档（支持 ?limit=50&offset=0）
 *   GET    /gm/:collection/:key           读一条文档
 *   PUT    /gm/:collection/:key           写/覆盖一条文档（body 为 JSON）
 *   DELETE /gm/:collection/:key           删一条文档
 *   DELETE /gm/:collection                清空整个集合（危险，需 ?confirm=yes）
 *   POST   /gm/ops/reset                  刷档（body: {mode:"season"|"respawn"|"wipe"}，需 ?confirm=yes）
 *   DELETE /gm/ops/player/:playerId       删除单个玩家账号及所有进度（需 ?confirm=yes）
 *   POST   /gm/ops/grant-treasure         GM 测试：授予村庄某宝物并推送效果（body: {villageId, code}）
 *   POST   /gm/ops/use-treasure           GM 测试：使用村庄某特殊宝物（即时发金币，body: {villageId, code}）
 *
 * 安全：GM_TOKEN=<secret> 时所有请求需带 X-GM-Token header（面板自动处理）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Store } from '../infra/store.js';
import type { GameApp } from '../app.js';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCsv, parseCsvStructured, serializeCsv, type CsvRow } from '../infra/csv.js';
import { loadGameConfig, loadBalanceOverrides, saveBalanceOverrides, mergeBalanceOverrides, mergeOverridesIntoRows, type BalanceOverrides } from '../infra/config.js';

const GM_PANEL_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>GM 面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;font-size:13px;background:#1a1a2e;color:#e0e0e0;display:flex;height:100vh;overflow:hidden}
#sidebar{width:200px;background:#16213e;border-right:1px solid #0f3460;display:flex;flex-direction:column;flex-shrink:0}
#sidebar h2{padding:12px;font-size:12px;color:#a0a8c0;text-transform:uppercase;border-bottom:1px solid #0f3460}
#col-list{overflow-y:auto;flex:1}
.col-item{padding:8px 12px;cursor:pointer;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between}
.col-item:hover,.col-item.active{background:#0f3460;color:#4cc9f0}
.col-badge{background:#0f3460;color:#4cc9f0;border-radius:10px;padding:1px 6px;font-size:11px}
.col-item.active .col-badge{background:#4cc9f0;color:#16213e}
#ops-panel{padding:10px 12px;border-top:1px solid #0f3460;flex-shrink:0}
#ops-panel h3{font-size:11px;color:#a0a8c0;text-transform:uppercase;margin-bottom:8px}
#ops-panel .ops-row{display:flex;flex-direction:column;gap:5px}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}
#toolbar{padding:8px 12px;background:#16213e;border-bottom:1px solid #0f3460;display:flex;gap:8px;align-items:center;flex-shrink:0}
#search{flex:1;background:#0f3460;border:1px solid #4cc9f0;color:#e0e0e0;padding:4px 8px;border-radius:4px;font-family:monospace}
#content{flex:1;display:flex;overflow:hidden}
#doc-list{width:220px;overflow-y:auto;border-right:1px solid #0f3460;flex-shrink:0}
.doc-item{padding:6px 10px;cursor:pointer;border-bottom:1px solid #0f3460;word-break:break-all;font-size:12px}
.doc-item:hover,.doc-item.active{background:#0f3460;color:#4cc9f0}
#editor-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}
#editor-toolbar{padding:6px 10px;background:#16213e;border-bottom:1px solid #0f3460;display:flex;gap:6px;flex-shrink:0}
button{background:#0f3460;border:1px solid #4cc9f0;color:#4cc9f0;padding:4px 10px;cursor:pointer;border-radius:3px;font-family:monospace;font-size:12px}
button:hover{background:#4cc9f0;color:#16213e}
button.danger{border-color:#f07070;color:#f07070}
button.danger:hover{background:#f07070;color:#16213e}
button.warn{border-color:#f0b070;color:#f0b070}
button.warn:hover{background:#f0b070;color:#16213e}
button.save{border-color:#70f070;color:#70f070}
button.save:hover{background:#70f070;color:#16213e}
button.sm{padding:3px 7px;font-size:11px}
#editor{flex:1;background:#0d1117;color:#c9d1d9;padding:12px;font-family:monospace;font-size:12px;border:none;resize:none;outline:none;overflow:auto}
#status{padding:4px 12px;font-size:11px;color:#a0a8c0;background:#16213e;border-top:1px solid #0f3460;flex-shrink:0}
#cur-key{color:#4cc9f0;font-weight:bold}
.empty{padding:20px;color:#555;text-align:center}
.player-item{padding:5px 10px;font-size:12px;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between;align-items:center;gap:4px}
.player-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<div id="sidebar">
  <h2>集合</h2>
  <div id="col-list"><div class="empty">加载中…</div></div>
  <div id="ops-panel">
    <h3>运维操作</h3>
    <div class="ops-row">
      <button class="warn sm" onclick="window.open('/gm/balance','_blank')">平衡调参</button>
      <button class="warn sm" onclick="window.open('/gm/tasks','_blank')">任务管理</button>
      <button class="warn sm" onclick="window.open('/gm/quests','_blank')">任务目录</button>
      <button class="warn sm" onclick="showPlayers()">管理玩家</button>
      <button class="warn sm" onclick="resetOp('season')">新赛季（留进度位置）</button>
      <button class="warn sm" onclick="resetOp('respawn')">重排位置（留账号）</button>
      <button class="danger sm" onclick="resetOp('wipe')">清档（删所有账号）</button>
    </div>
  </div>
</div>
<div id="main">
  <div id="toolbar">
    <span style="color:#a0a8c0">当前：</span>
    <span id="cur-key">未选择</span>
    <input id="search" placeholder="过滤 key…" oninput="filterDocs()">
    <button onclick="newDoc()">+ 新建</button>
    <button onclick="refreshAll()">刷新</button>
  </div>
  <div id="content">
    <div id="doc-list"><div class="empty">选择左侧集合</div></div>
    <div id="editor-pane">
      <div id="editor-toolbar">
        <button class="save" onclick="saveDoc()">保存</button>
        <button class="danger" onclick="deleteDoc()">删除</button>
        <button onclick="formatJson()">格式化</button>
        <button onclick="copyDoc()">复制</button>
      </div>
      <textarea id="editor" placeholder="选择左侧文档查看/编辑…"></textarea>
      <div id="status">就绪</div>
    </div>
  </div>
</div>
<script>
let token = sessionStorage.getItem('gmToken') ?? '';

let curCol = '', curKey = '', allDocs = {};

async function api(method, path, body, retryAuth=true) {
  const headers = {'Content-Type':'application/json'};
  if (token) headers['X-GM-Token'] = token;
  const r = await fetch('/gm' + path, {method, headers, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = {ok:false, reason:\`HTTP \${r.status}: \${text || r.statusText}\`}; }

  if (r.status === 401 && retryAuth) {
    const next = prompt('请输入 GM Token：', token);
    if (next !== null) {
      token = next.trim();
      if (token) sessionStorage.setItem('gmToken', token);
      else sessionStorage.removeItem('gmToken');
      return api(method, path, body, false);
    }
  }
  if (!r.ok && data.ok === undefined) data.ok = false;
  return data;
}

function status(msg, ok=true) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = ok ? '#70f070' : '#f07070';
}

async function refreshAll() {
  const data = await api('GET', '/collections');
  const list = document.getElementById('col-list');
  list.innerHTML = '';
  for (const {collection, count} of data.collections ?? []) {
    const d = document.createElement('div');
    d.className = 'col-item' + (collection === curCol ? ' active' : '');
    d.innerHTML = \`<span>\${collection}</span><span class="col-badge">\${count}</span>\`;
    d.onclick = () => loadCollection(collection);
    list.appendChild(d);
  }
}

async function loadCollection(col) {
  curCol = col; curKey = '';
  document.getElementById('cur-key').textContent = col;
  document.getElementById('editor').value = '';
  document.querySelectorAll('.col-item').forEach(el => el.classList.toggle('active', el.querySelector('span').textContent === col));
  const data = await api('GET', \`/\${col}?limit=500\`);
  allDocs = data.docs ?? {};
  renderDocList(allDocs);
  status(\`已加载 \${Object.keys(allDocs).length} 条\`);
}

function renderDocList(docs) {
  const list = document.getElementById('doc-list');
  const keys = Object.keys(docs);
  if (!keys.length) { list.innerHTML = '<div class="empty">空集合</div>'; return; }
  list.innerHTML = '';
  for (const k of keys) {
    const d = document.createElement('div');
    d.className = 'doc-item' + (k === curKey ? ' active' : '');
    d.textContent = k;
    d.onclick = () => loadDoc(k, docs[k]);
    list.appendChild(d);
  }
}

function filterDocs() {
  const q = document.getElementById('search').value.toLowerCase();
  const filtered = {};
  for (const [k, v] of Object.entries(allDocs)) {
    if (k.toLowerCase().includes(q) || JSON.stringify(v).toLowerCase().includes(q)) filtered[k] = v;
  }
  renderDocList(filtered);
}

function loadDoc(key, doc) {
  curKey = key;
  document.getElementById('cur-key').textContent = curCol + ' / ' + key;
  document.getElementById('editor').value = JSON.stringify(doc, null, 2);
  document.querySelectorAll('.doc-item').forEach(el => el.classList.toggle('active', el.textContent === key));
  status('已加载 ' + key);
}

async function saveDoc() {
  if (!curCol || !curKey) { status('请先选择文档', false); return; }
  let val;
  try { val = JSON.parse(document.getElementById('editor').value); }
  catch(e) { status('JSON 格式错误: ' + e.message, false); return; }
  const r = await api('PUT', \`/\${curCol}/\${curKey}\`, val);
  if (r.ok) { status('已保存 ' + curKey); allDocs[curKey] = val; }
  else status('保存失败: ' + r.reason, false);
}

async function deleteDoc() {
  if (!curCol || !curKey) { status('请先选择文档', false); return; }
  if (curCol === 'player') {
    const player = allDocs[curKey] ?? {};
    await deletePlayer(curKey, player.name ?? curKey);
    return;
  }
  if (!confirm(\`确定删除 \${curCol}/\${curKey}？\`)) return;
  const r = await api('DELETE', \`/\${curCol}/\${curKey}\`);
  if (r.ok) {
    delete allDocs[curKey];
    curKey = '';
    document.getElementById('editor').value = '';
    document.getElementById('cur-key').textContent = curCol;
    renderDocList(allDocs);
    status('已删除');
    refreshAll();
  } else status('删除失败: ' + r.reason, false);
}

function newDoc() {
  if (!curCol) { status('请先选择集合', false); return; }
  const key = prompt('新文档 key：');
  if (!key) return;
  curKey = key;
  document.getElementById('cur-key').textContent = curCol + ' / ' + key;
  document.getElementById('editor').value = '{}';
  status('输入内容后点保存');
}

function formatJson() {
  try {
    const v = JSON.parse(document.getElementById('editor').value);
    document.getElementById('editor').value = JSON.stringify(v, null, 2);
  } catch(e) { status('JSON 格式错误', false); }
}

function copyDoc() {
  navigator.clipboard.writeText(document.getElementById('editor').value);
  status('已复制到剪贴板');
}

async function resetOp(mode) {
  const labels = {season:'新赛季（保留账号+地图位置，进度归零）', respawn:'重排位置（保留登录凭据，重新分配坐标）', wipe:'清档（删除所有账号及全部进度）'};
  if (!confirm(\`确定执行：\${labels[mode]}？\\n此操作不可撤销。\`)) return;
  const r = await api('POST', '/ops/reset?confirm=yes', {mode});
  if (r.ok) { status(\`\${labels[mode]} 完成，受影响账号：\${r.accounts}\`); refreshAll(); }
  else status('操作失败: ' + (r.reason ?? JSON.stringify(r)), false);
}

async function showPlayers() {
  const data = await api('GET', '/player?limit=500');
  if (!data.ok) { status('加载玩家失败: ' + (data.reason ?? JSON.stringify(data)), false); return; }
  const docs = data.docs ?? {};
  allDocs = docs;
  curCol = 'player';
  curKey = '';
  document.getElementById('editor').value = '';
  const list = document.getElementById('doc-list');
  const keys = Object.keys(docs);
  if (!keys.length) { list.innerHTML = '<div class="empty">暂无玩家</div>'; return; }
  list.innerHTML = '';
  for (const k of keys) {
    const p = docs[k];
    const row = document.createElement('div');
    row.className = 'player-item';
    row.innerHTML = \`<span class="player-name" title="\${k}">\${p.name ?? k}</span><span style="color:#a0a8c0;font-size:11px">\${p.tribe ?? ''}</span>\`;
    row.onclick = () => loadDoc(k, p);
    const btn = document.createElement('button');
    btn.className = 'danger sm';
    btn.textContent = '删';
    btn.onclick = (event) => {
      event.stopPropagation();
      deletePlayer(k, p.name ?? k);
    };
    row.appendChild(btn);
    list.appendChild(row);
  }
  document.getElementById('cur-key').textContent = '玩家管理';
  status(\`共 \${keys.length} 个玩家\`);
}

async function deletePlayer(playerId, name) {
  if (!confirm(\`确定删除玩家「\${name}」及其所有进度？\`)) return;
  const r = await api('DELETE', \`/ops/player/\${encodeURIComponent(playerId)}?confirm=yes\`);
  if (r.ok) {
    curKey = '';
    document.getElementById('editor').value = '';
    await refreshAll();
    await showPlayers();
    status(\`已删除玩家 \${name}（村庄 \${r.villageId}）\`);
  }
  else status('删除失败: ' + (r.reason ?? JSON.stringify(r)), false);
}

refreshAll();
</script>
</body>
</html>`;

/**
 * 平衡调参表元数据：声明每个可编辑表对应哪个 CSV 文件、主键列、哪些列是数值可编辑。
 * 客户端据此渲染可编辑输入框；服务端据此校验并回写。新增可编辑列只需在此登记。
 */
interface BalanceTable {
  file: string;
  /** 单主键列名；与 keyComposite 二选一。 */
  key?: string;
  /** 复合主键（多列组合，key 用 '|' 连接）；存在时按多列匹配行。 */
  keyComposite?: string[];
  numeric?: string[];
  numericByType?: boolean;
  labels: string[];
}

export const BALANCE_TABLES: Record<string, BalanceTable> = {
  buildings: {
    file: 'buildings.csv', key: 'id',
    numeric: ['maxLevel', 'prosperityPerLevel', 'popGrowthPerLevel'],
    labels: ['id', 'code', 'name'],
  },
  building_levels: {
    file: 'building_levels.csv',
    keyComposite: ['code', 'level'],
    numeric: ['costWood', 'costClay', 'costIron', 'costCrop', 'costGold', 'timeSec', 'popCap', 'prod', 'treasureSlots', 'storagePerLevel', 'defensePerLevel', 'buildSpeedupPerLevel', 'trainTimeReducePerLevel', 'trainCostReducePerLevel'],
    labels: ['code', 'level', 'name'],
  },
  units: {
    file: 'units.csv', key: 'id',
    numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'speed', 'carry', 'upkeep', 'costWood', 'costClay', 'costIron', 'costCrop', 'trainSec', 'popCost', 'popPermanent'],
    labels: ['id', 'code', 'name', 'tribe'],
  },
  // 雇佣兵（tribe=merc）：可编辑战斗属性 + 单价；upkeep/cost*/trainSec/popCost 由引擎强制为 0（不经训练队列），故不在此暴露
  mercenaries: {
    file: 'mercenaries.csv', key: 'id',
    numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'speed', 'carry', 'goldCost'],
    labels: ['id', 'code', 'name', 'tribe'],
  },
  // 雇佣兵营地刷新参数（merc_camp.csv）：level → {refreshSec, mercCount, maxStoredRefreshes}
  merc_camp: {
    file: 'merc_camp.csv', key: 'level',
    numeric: ['refreshSec', 'mercCount', 'maxStoredRefreshes'],
    labels: ['level'],
  },
  // 贸易中心逐级参数（trade_center.csv）：level → {tradeRoutes, tradeViewRadius, npcOrderCount, npcRefreshSec, npcStoredRefreshes}
  trade_center: {
    file: 'trade_center.csv', key: 'level',
    numeric: ['tradeRoutes', 'tradeViewRadius', 'npcOrderCount', 'npcRefreshSec', 'npcStoredRefreshes'],
    labels: ['level'],
  },
  // 宝物目录（treasures.csv）：id → {effectValue, priceGold, dropRate} 可编辑；其余为展示标签
  treasures: {
    file: 'treasures.csv', key: 'id',
    numeric: ['effectValue', 'priceGold', 'dropRate'],
    labels: ['id', 'code', 'name', 'category', 'rarity', 'effectType', 'applyType'],
  },
  constants: {
    file: 'game_constants.csv', key: 'key',
    numericByType: true, // 用行内 type 列判定（number/bool/string）
    labels: ['key', 'note'],
  },
  // 科研系统
  research: {
    file: 'research.csv', key: 'id',
    numeric: ['tier', 'effectValue', 'durationSec', 'rpCost'],
    labels: ['id', 'code', 'name', 'branch', 'tier', 'requires', 'effectType', 'effectKey', 'scope'],
  },
  academy: {
    file: 'academy.csv', key: 'level',
    numeric: ['checkIntervalSec', 'baseProbability', 'probabilityGainPerFail', 'maxProbability', 'popFactor'],
    labels: ['level'],
  },
};

/**
 * 把一个表的改动（changes: { 主键: { 字段: 新值 } }）合并进 CSV 并写回 targetDir。
 * 策略：读 srcDir 的结构化 CSV → 按主键匹配 → 仅覆盖客户端发来的字段（空值=不改动）→ 保留注释与表头写回。
 * 数值字段会做有限性校验，非法则抛错（由调用方捕获，绝不写半截文件）。
 */
/** 取一行的主键字符串（复合主键用 '|' 连接）。 */
function balanceRowKey(row: CsvRow, table: BalanceTable): string {
  return table.keyComposite ? table.keyComposite.map((k) => row[k] ?? '').join('|') : (row[table.key ?? ''] ?? '');
}
/** 该列是否为主键列（写回时跳过）。 */
function isBalanceKeyCol(col: string, table: BalanceTable): boolean {
  return table.keyComposite ? table.keyComposite.includes(col) : col === (table.key ?? '');
}

export function applyBalanceEdits(srcDir: string, targetDir: string, table: BalanceTable, changes: Record<string, Record<string, string>>): void {
  const doc = parseCsvStructured(readFileSync(join(srcDir, table.file), 'utf8'));
  const incByKey = new Map(Object.entries(changes));
  doc.rows = doc.rows.map((orig) => {
    const keyVal = balanceRowKey(orig, table);
    const inc = incByKey.get(keyVal);
    if (!inc) return orig;
    const merged = { ...orig };
    for (const h of doc.header) {
      if (isBalanceKeyCol(h, table)) continue;
      const newVal = inc[h];
      if (newVal === undefined || newVal === '') continue; // 空值=不改动该字段
      if (table.numericByType) {
        const type = (orig['type'] ?? 'number').toString();
        if (type === 'number') {
          const n = Number(newVal);
          if (!Number.isFinite(n)) throw new Error(table.file + ' 行 ' + keyVal + ' 字段 ' + h + '="' + newVal + '" 不是合法数字');
          merged[h] = String(n);
        } else if (type === 'bool') {
          if (!['true', 'false', '0', '1'].includes(newVal)) throw new Error(table.file + ' 行 ' + keyVal + ' 字段 ' + h + '="' + newVal + '" 不是合法 bool(true/false/0/1)');
          merged[h] = newVal;
        } else {
          merged[h] = newVal;
        }
      } else if (table.numeric?.includes(h)) {
        const n = Number(newVal);
        if (!Number.isFinite(n)) throw new Error(table.file + ' 行 ' + keyVal + ' 字段 ' + h + '="' + newVal + '" 不是合法数字');
        merged[h] = String(n);
      }
      // 非声明可编辑字段：忽略（不覆盖原值）
    }
    return merged;
  });
  writeFileSync(join(targetDir, table.file), serializeCsv(doc), 'utf8');
}

const GM_BALANCE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>平衡调参</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;font-size:13px;background:#1a1a2e;color:#e0e0e0;padding:14px}
#topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}
#topbar h1{font-size:15px;color:#4cc9f0}
button{background:#0f3460;border:1px solid #4cc9f0;color:#4cc9f0;padding:5px 12px;cursor:pointer;border-radius:3px;font-family:monospace;font-size:12px}
button:hover{background:#4cc9f0;color:#16213e}
button.save{border-color:#70f070;color:#70f070}
button.save:hover{background:#70f070;color:#16213e}
#status{margin:8px 0;padding:6px 10px;border-radius:3px;font-size:12px}
#status.ok{background:#16331f;color:#70f070}
#status.bad{background:#331616;color:#f07070}
.sec{margin-bottom:24px;background:#16213e;border:1px solid #0f3460;border-radius:4px;padding:10px;overflow-x:auto}
.sec h2{font-size:13px;color:#a0a8c0;text-transform:uppercase;margin-bottom:8px}
table.bt{border-collapse:collapse;font-size:12px}
table.bt th{background:#0f3460;color:#4cc9f0;padding:4px 8px;text-align:left;border:1px solid #0f3460;white-space:nowrap}
table.bt td{padding:3px 6px;border:1px solid #0f3460;white-space:nowrap}
table.bt td.lbl{color:#c9d1d9}
table.bt input{width:90px;background:#0d1117;color:#c9d1d9;border:1px solid #0f3460;padding:3px 5px;border-radius:3px;font-family:monospace}
table.bt input:focus{outline:1px solid #4cc9f0}
.hint{color:#a0a8c0;font-size:12px;margin-bottom:6px}
.bl-card{margin-bottom:8px;border:1px solid #0f3460;border-radius:4px;overflow:hidden}
.bl-head{background:#0f3460;padding:6px 10px;cursor:pointer;font-size:13px;color:#e0e0e0;user-select:none}
.bl-head:hover{color:#4cc9f0}
.bl-arrow{display:inline-block;width:14px;color:#4cc9f0}
.bl-sub{color:#7a86a8;font-size:11px;margin-left:6px}
.bl-body{padding:6px 8px}
</style>
</head>
<body>
<div id="topbar">
  <h1>平衡调参 · 改 CSV 即时生效（无需刷档）</h1>
  <div>
    <button onclick="load()">重新加载</button>
    <button class="save" onclick="save()">保存并热重载</button>
  </div>
</div>
<div id="status" class="ok">就绪</div>
<div id="tables"></div>
<script>
const TOKEN = '';
const H = TOKEN ? {'X-GM-Token': TOKEN, 'Content-Type':'application/json'} : {'Content-Type':'application/json'};
const TABLES = ['buildings','building_levels','units','mercenaries','merc_camp','trade_center','treasures','constants','research','academy'];
const CHANGES = {buildings:{}, building_levels:{}, units:{}, mercenaries:{}, merc_camp:{}, trade_center:{}, treasures:{}, constants:{}, research:{}, academy:{}};
let DATA = null;

function esc(s){ s = String(s==null?'':s); return s.replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function status(msg, bad){ var el=document.getElementById('status'); el.textContent=msg; el.className = bad ? 'bad':'ok'; }
async function api(method, path, body){ var r = await fetch('/gm'+path, {method:method, headers:H, body: body?JSON.stringify(body):undefined}); return r.json(); }

async function load(){
  status('加载中…');
  var r = await api('GET','/balance/data');
  if (!r.ok){ status('加载失败: '+(r.reason||''), true); return; }
  DATA = r;
  render();
  status('已加载，可编辑后保存');
}

function sectionGeneric(table){
  var meta = DATA.meta[table];
  var rows = DATA[table] || [];
  var fields = meta.numericByType ? ['value'] : meta.numeric;
  var TITLES = { buildings:'建筑 / 资源田', units:'兵种', mercenaries:'雇佣兵', merc_camp:'雇佣兵营地刷新', trade_center:'贸易中心逐级参数', treasures:'宝物目录', constants:'全局常量', research:'科技目录', academy:'学院RP参数' };
  var title = TITLES[table] || table;
  var h = '<div class="hint">主键 ' + esc(meta.key) + ' · 可编辑字段: ' + esc(fields.join(', ')) + '</div>';
  h += '<table class="bt"><thead><tr>';
  for (var i=0;i<meta.labels.length;i++) h += '<th>'+esc(meta.labels[i])+'</th>';
  for (var j=0;j<fields.length;j++) h += '<th>'+esc(fields[j])+'</th>';
  h += '</tr></thead><tbody>';
  for (var k=0;k<rows.length;k++){
    var row = rows[k];
    var key = row[meta.key];
    h += '<tr>';
    for (var a=0;a<meta.labels.length;a++) h += '<td class="lbl">'+esc(row[meta.labels[a]])+'</td>';
    for (var b=0;b<fields.length;b++){
      var f = fields[b];
      var val = row[f]==null?'':row[f];
      h += '<td><input type="number" step="any" value="'+esc(val)+'" data-t="'+esc(table)+'" data-k="'+esc(key)+'" data-f="'+esc(f)+'" oninput="onEdit(this)"></td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>'+title+'</h2>'+h+'</div>';
}

// ── 建筑参数统一视图 ── 合并 buildings + building_levels + trade_center + merc_camp，每栋一张折叠卡片。
// 根据建筑类型决定显示哪些奖励列（非该类型的列自动隐藏）。
function sectionBuildings(){
  var levelMeta = DATA.meta.building_levels;
  var buildMeta = DATA.meta.buildings;
  var levelRows = DATA.building_levels || [];
  var buildRows = DATA.buildings || [];
  var tradeRows = DATA.trade_center || [];
  var mercRows = DATA.merc_camp || [];
  var academyRows = DATA.academy || [];
  // 按 level 索引
  var tradeByLv = {};
  for (var tr=0;tr<tradeRows.length;tr++){ tradeByLv[tradeRows[tr].level] = tradeRows[tr]; }
  var mercByLv = {};
  for (var mr=0;mr<mercRows.length;mr++){ mercByLv[mercRows[mr].level] = mercRows[mr]; }
  var academyByLv = {};
  for (var ar=0;ar<academyRows.length;ar++){ academyByLv[academyRows[ar].level] = academyRows[ar]; }
  var buildByCode = {};
  for (var i=0;i<buildRows.length;i++){ buildByCode[buildRows[i].code] = buildRows[i]; }
  var byCode = {};
  for (var i=0;i<levelRows.length;i++){ (byCode[levelRows[i].code] = byCode[levelRows[i].code] || []).push(levelRows[i]); }
  // 基础字段（所有建筑通用）
  var baseCols = ['costWood','costClay','costIron','costCrop','costGold','timeSec','popCap','prod'];
  // 根据建筑类型决定额外奖励列
  function bonusCols(code){
    var c = [];
    if (code === 'treasury') c.push({k:'treasureSlots',l:'+宝物格'});
    if (code === 'warehouse' || code === 'granary') c.push({k:'storagePerLevel',l:'+容量'});
    if (code === 'wall') c.push({k:'defensePerLevel',l:'+防御'});
    if (code === 'main') c.push({k:'buildSpeedupPerLevel',l:'-建造耗时'});
    if (code === 'barracks' || code === 'stable' || code === 'workshop') {
      c.push({k:'trainTimeReducePerLevel',l:'-训练耗时'});
      c.push({k:'trainCostReducePerLevel',l:'-训练花费'});
    }
    return c;
  }
  var bFields = ['maxLevel','prosperityPerLevel','popGrowthPerLevel'];
  var bLabels = ['最高等级','繁荣/级','人口增长/级·时'];
  var h = '<div class="hint">每栋建筑独立卡片——建筑属性(顶部) + 通用逐级参数 + 建筑专属奖励列 + 贸易中心/雇佣兵营地功能参数(如有)</div>';
  h += '<div class="bl-list">';
  var codes = Object.keys(byCode).sort();
  for (var c=0;c<codes.length;c++){
    var code = codes[c];
    var group = byCode[code].slice().sort(function(a,b){ return a.level - b.level; });
    var bld = buildByCode[code];
    var name = (bld ? bld.name : (group[0]||{}).name) || code;
    var zoneInfo = bld ? (bld.zone || '') : '';
    var bCols = bonusCols(code);
    var bid = 'bl-' + code, aid = 'ar-' + code;
    h += '<div class="bl-card">';
    // 折叠头：名称 · code · zone · 级数
    h += '<div class="bl-head" data-code="'+esc(code)+'" onclick="toggleBl(this.dataset.code)"><span class="bl-arrow" id="'+aid+'">▶</span> '+esc(name)+' <span class="bl-sub">'+esc(code)+' · '+esc(zoneInfo)+' · '+group.length+'级</span></div>';
    h += '<div class="bl-body" id="'+bid+'" style="display:none">';
    // ── 建筑自身属性（来自 buildings.csv）──
    if (bld){
      var bKey = bld[buildMeta.key];
      h += '<div style="background:#0d1117;padding:4px 8px;border-radius:3px;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;gap:3px">';
      h += '<span style="color:#7a86a8;font-size:11px;white-space:nowrap">属性</span>';
      for (var bf=0;bf<bFields.length;bf++){
        var f0 = bFields[bf];
        var val0 = bld[f0]==null?'':bld[f0];
        h += '<label style="font-size:10px;color:#7a86a8;margin-left:4px;white-space:nowrap">'+bLabels[bf]+':</label> ';
        h += '<input type="number" step="any" value="'+esc(val0)+'" data-t="buildings" data-k="'+esc(bKey)+'" data-f="'+esc(f0)+'" oninput="onEdit(this)" style="width:62px;font-size:11px">';
      }
      h += '</div>';
    }
    // ── 逐级参数表（通用 + 奖励列）──
    h += '<table class="bt"><thead><tr><th>lv</th>';
    for (var f1=0;f1<baseCols.length;f1++) h += '<th>'+esc(baseCols[f1])+'</th>';
    for (var bc=0;bc<bCols.length;bc++) h += '<th style="color:#f0b070">'+esc(bCols[bc].l)+'</th>';
    h += '</tr></thead><tbody>';
    for (var g=0;g<group.length;g++){
      var row = group[g];
      var key = code + '|' + row.level;
      h += '<tr><td class="lbl">'+esc(row.level)+'</td>';
      for (var lf=0;lf<baseCols.length;lf++){
        var f2 = baseCols[lf];
        var val2 = row[f2]==null?'':row[f2];
        h += '<td><input type="number" step="any" value="'+esc(val2)+'" data-t="building_levels" data-k="'+esc(key)+'" data-f="'+esc(f2)+'" oninput="onEdit(this)"></td>';
      }
      for (var bc2=0;bc2<bCols.length;bc2++){
        var bk = bCols[bc2].k;
        var valbk = row[bk]==null?'':row[bk];
        h += '<td><input type="number" step="any" value="'+esc(valbk)+'" data-t="building_levels" data-k="'+esc(key)+'" data-f="'+esc(bk)+'" oninput="onEdit(this)" style="border-color:#f0b070;background:#1a1500"></td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    // ── 贸易中心/雇佣兵营地功能参数（来自 trade_center.csv / merc_camp.csv）──
    if (code === 'tradecenter' && Object.keys(tradeByLv).length){
      h += '<div style="margin-top:8px"><span style="color:#f0b070;font-size:12px">贸易功能参数（trade_center.csv）</span>';
      h += '<table class="bt"><thead><tr><th>lv</th><th>tradeRoutes</th><th>tradeViewRadius</th><th>npcOrderCount</th><th>npcRefreshSec</th><th>npcStoredRefreshes</th></tr></thead><tbody>';
      var tLvs = Object.keys(tradeByLv).sort(function(a,b){ return a - b; });
      for (var tl=0;tl<tLvs.length;tl++){
        var tlKey = tLvs[tl]; var trRow = tradeByLv[tlKey];
        h += '<tr><td class="lbl">'+esc(tlKey)+'</td>';
        var tFields = ['tradeRoutes','tradeViewRadius','npcOrderCount','npcRefreshSec','npcStoredRefreshes'];
        for (var tf=0;tf<tFields.length;tf++){
          var tfv = trRow[tFields[tf]]==null?'':trRow[tFields[tf]];
          h += '<td><input type="number" step="any" value="'+esc(tfv)+'" data-t="trade_center" data-k="'+esc(tlKey)+'" data-f="'+esc(tFields[tf])+'" oninput="onEdit(this)"></td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table></div>';
    }
    if (code === 'mercenarycamp' && Object.keys(mercByLv).length){
      h += '<div style="margin-top:8px"><span style="color:#f0b070;font-size:12px">雇佣兵营地功能参数（merc_camp.csv）</span>';
      h += '<table class="bt"><thead><tr><th>lv</th><th>refreshSec</th><th>mercCount</th><th>maxStoredRefreshes</th></tr></thead><tbody>';
      var mLvs = Object.keys(mercByLv).sort(function(a,b){ return a - b; });
      for (var ml=0;ml<mLvs.length;ml++){
        var mlKey = mLvs[ml]; var mrRow = mercByLv[mlKey];
        h += '<tr><td class="lbl">'+esc(mlKey)+'</td>';
        var mFields = ['refreshSec','mercCount','maxStoredRefreshes'];
        for (var mf=0;mf<mFields.length;mf++){
          var mfv = mrRow[mFields[mf]]==null?'':mrRow[mFields[mf]];
          h += '<td><input type="number" step="any" value="'+esc(mfv)+'" data-t="merc_camp" data-k="'+esc(mlKey)+'" data-f="'+esc(mFields[mf])+'" oninput="onEdit(this)"></td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table></div>';
    }
    if (code === 'academy' && Object.keys(academyByLv).length){
      h += '<div style="margin-top:8px"><span style="color:#f0b070;font-size:12px">学院RP参数（academy.csv）</span>';
      h += '<table class="bt"><thead><tr><th>lv</th><th>checkIntervalSec</th><th>baseProbability</th><th>probabilityGainPerFail</th><th>maxProbability</th><th>popFactor</th></tr></thead><tbody>';
      var aLvs = Object.keys(academyByLv).sort(function(a,b){ return a - b; });
      for (var al=0;al<aLvs.length;al++){
        var alKey = aLvs[al]; var acRow = academyByLv[alKey];
        h += '<tr><td class="lbl">'+esc(alKey)+'</td>';
        var aFields = ['checkIntervalSec','baseProbability','probabilityGainPerFail','maxProbability','popFactor'];
        for (var af=0;af<aFields.length;af++){
          var afv = acRow[aFields[af]]==null?'':acRow[aFields[af]];
          h += '<td><input type="number" step="any" value="'+esc(afv)+'" data-t="academy" data-k="'+esc(alKey)+'" data-f="'+esc(aFields[af])+'" oninput="onEdit(this)"></td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table></div>';
    }
    h += '</div></div>';
  }
  h += '</div>';
  return '<div class="sec"><h2>建筑参数（合并视图·每栋建筑所有功能参数集中一张卡片）</h2>'+h+'</div>';
}

function toggleBl(code){
  var el = document.getElementById('bl-' + code);
  var ar = document.getElementById('ar-' + code);
  if (el.style.display === 'none'){ el.style.display = 'block'; ar.textContent = '▼'; }
  else { el.style.display = 'none'; ar.textContent = '▶'; }
}

function render(){
  var html = '';
  // ── 建筑统一卡片（合并 buildings + building_levels，点开展开全部参数）──
  html += sectionBuildings();
  for (var i=0;i<TABLES.length;i++){
    var t = TABLES[i];
    if (t === 'buildings' || t === 'building_levels' || t === 'trade_center' || t === 'merc_camp' || t === 'academy') continue; // 已在 sectionBuildings 合并渲染
    html += sectionGeneric(t);
  }
  document.getElementById('tables').innerHTML = html;
}

function onEdit(el){
  var t = el.dataset.t, k = el.dataset.k, f = el.dataset.f, v = el.value;
  if (!CHANGES[t][k]) CHANGES[t][k] = {};
  if (v==='') delete CHANGES[t][k][f];
  else CHANGES[t][k][f] = v;
  status('已修改「'+t+' / '+k+' / '+f+'」，记得点保存');
}

async function save(){
  var body = {};
  var any = false;
  for (var i=0;i<TABLES.length;i++){ if (Object.keys(CHANGES[TABLES[i]]).length){ body[TABLES[i]] = CHANGES[TABLES[i]]; any=true; } }
  if (!any){ status('没有任何改动', true); return; }
  status('保存中…');
  var r = await api('POST','/balance/save', body);
  if (r.ok){ status('已保存并热重载，改动对所有在线村庄即时生效'); for (var i=0;i<TABLES.length;i++) CHANGES[TABLES[i]]={}; }
  else status('保存失败: '+(r.reason||'未知错误'), true);
}

load();
</script>
</body>
</html>`;

export function registerGmRoutes(fastify: FastifyInstance, store: Store, gameApp: GameApp): void {
  const token = process.env.GM_TOKEN?.trim() || null;

  const auth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!token) return true;
    if (req.headers['x-gm-token'] === token) return true;
    void reply.code(401).send({ ok: false, reason: '需要 X-GM-Token header' });
    return false;
  };

  // GET /gm — Web 面板
  fastify.get('/gm', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_PANEL_HTML);
  });

  // GET /gm/collections
  fastify.get('/gm/collections', (req, reply) => {
    if (!auth(req, reply)) return;
    const cols = store.collections();
    const result = cols.map((c) => ({ collection: c, count: store.keys(c).length }));
    void reply.send({ ok: true, collections: result });
  });

  // GET /gm/:collection
  fastify.get('/gm/:collection', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection } = req.params as { collection: string };
    const query = req.query as Record<string, string>;
    const limit = Math.min(500, parseInt(query.limit ?? '50', 10) || 50);
    const offset = parseInt(query.offset ?? '0', 10) || 0;
    const keys = store.keys(collection);
    const page = keys.slice(offset, offset + limit);
    const docs: Record<string, unknown> = {};
    for (const k of page) docs[k] = store.get(collection, k);
    void reply.send({ ok: true, collection, total: keys.length, offset, limit, docs });
  });

  // GET /gm/:collection/:key
  fastify.get('/gm/:collection/:key', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection, key } = req.params as { collection: string; key: string };
    const doc = store.get(collection, key);
    if (doc === undefined) {
      void reply.code(404).send({ ok: false, reason: 'not_found', collection, key });
      return;
    }
    void reply.send({ ok: true, collection, key, doc });
  });

  // PUT /gm/:collection/:key
  fastify.put('/gm/:collection/:key', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection, key } = req.params as { collection: string; key: string };
    const body = req.body;
    if (body === undefined || body === null) {
      void reply.code(400).send({ ok: false, reason: '请求 body 不能为空（发送 JSON 文档）' });
      return;
    }
    store.set(collection, key, body);
    store.flush();
    void reply.send({ ok: true, collection, key, doc: body });
  });

  // DELETE /gm/:collection/:key
  fastify.delete('/gm/:collection/:key', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection, key } = req.params as { collection: string; key: string };
    const deleted = store.delete(collection, key);
    store.flush();
    void reply.send({ ok: true, collection, key, deleted });
  });

  // DELETE /gm/:collection（清空整个集合，需 ?confirm=yes）
  fastify.delete('/gm/:collection', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection } = req.params as { collection: string };
    const query = req.query as Record<string, string>;
    if (query.confirm !== 'yes') {
      void reply.code(400).send({ ok: false, reason: '危险操作：需加 ?confirm=yes 参数' });
      return;
    }
    store.clear(collection);
    store.flush();
    void reply.send({ ok: true, collection, cleared: true });
  });

  // POST /gm/ops/reset — 刷档（需 ?confirm=yes，body: {mode:"season"|"respawn"|"wipe"}）
  fastify.post('/gm/ops/reset', (req, reply) => {
    if (!auth(req, reply)) return;
    const query = req.query as Record<string, string>;
    if (query.confirm !== 'yes') {
      void reply.code(400).send({ ok: false, reason: '危险操作：需加 ?confirm=yes 参数' });
      return;
    }
    const { mode } = (req.body ?? {}) as { mode?: string };
    if (mode !== 'season' && mode !== 'respawn' && mode !== 'wipe') {
      void reply.code(400).send({ ok: false, reason: 'mode 必须为 season | respawn | wipe' });
      return;
    }
    const opts =
      mode === 'wipe'
        ? { keepAccounts: false }
        : { keepAccounts: true, reassignSpots: mode === 'respawn' };
    const { accounts } = gameApp.resetWorld(opts);
    store.flush();
    void reply.send({ ok: true, mode, accounts });
  });

  // DELETE /gm/ops/player/:playerId — 删除单个玩家账号及所有进度（需 ?confirm=yes）
  fastify.delete('/gm/ops/player/:playerId', (req, reply) => {
    if (!auth(req, reply)) return;
    const query = req.query as Record<string, string>;
    if (query.confirm !== 'yes') {
      void reply.code(400).send({ ok: false, reason: '危险操作：需加 ?confirm=yes 参数' });
      return;
    }
    const { playerId } = req.params as { playerId: string };
    const result = gameApp.deletePlayer(playerId);
    if (!result) {
      void reply.code(404).send({ ok: false, reason: 'player_not_found', playerId });
      return;
    }
    store.flush();
    void reply.send({ ok: true, playerId, villageId: result.villageId });
  });

  // POST /gm/ops/grant-treasure — GM 测试：授予村庄某宝物并推送效果（body: {villageId, code}）
  fastify.post('/gm/ops/grant-treasure', async (req, reply) => {
    if (!auth(req, reply)) return;
    const { villageId, code } = (req.body ?? {}) as { villageId?: string; code?: string };
    if (!villageId || !code) {
      void reply.code(400).send({ ok: false, reason: 'villageId 与 code 必填' });
      return;
    }
    const res: any = await gameApp.commands.send({ name: 'treasure.Grant', from: 'gm', payload: { villageId, code } });
    if (!res.ok) {
      void reply.code(400).send({ ok: false, reason: res.reason ?? 'grant_failed', payload: res.payload });
      return;
    }
    store.flush();
    void reply.send(res);
  });

  // POST /gm/ops/use-treasure — GM 测试：使用村庄某特殊宝物（即时发放金币并移除，body: {villageId, code}）
  fastify.post('/gm/ops/use-treasure', async (req, reply) => {
    if (!auth(req, reply)) return;
    const { villageId, code } = (req.body ?? {}) as { villageId?: string; code?: string };
    if (!villageId || !code) {
      void reply.code(400).send({ ok: false, reason: 'villageId 与 code 必填' });
      return;
    }
    const res: any = await gameApp.commands.send({ name: 'treasure.Use', from: 'gm', payload: { villageId, code } });
    if (!res.ok) {
      void reply.code(400).send({ ok: false, reason: res.reason ?? 'use_failed', payload: res.payload });
      return;
    }
    store.flush();
    void reply.send(res);
  });

  // ── 任务模块 GM 运维端点（body 取 villageId，必要时取 code/resources）──
  const taskOp = async (
    req: FastifyRequest, reply: FastifyReply, name: string,
    pick: (b: Record<string, any>) => Record<string, unknown>,
  ) => {
    if (!auth(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, any>;
    const res: any = await gameApp.commands.send({ name, from: 'gm', payload: pick(b) });
    if (!res.ok) {
      void reply.code(400).send({ ok: false, reason: res.reason ?? 'failed', payload: res.payload });
      return;
    }
    store.flush();
    void reply.send(res);
  };
  fastify.post('/gm/ops/task/state', (req, reply) => taskOp(req, reply, 'task.GetState', (b) => ({ villageId: b.villageId })));
  fastify.post('/gm/ops/task/accept', (req, reply) => taskOp(req, reply, 'task.Accept', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/abandon', (req, reply) => taskOp(req, reply, 'task.Abandon', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/submit', (req, reply) => taskOp(req, reply, 'task.SubmitResources', (b) => ({ villageId: b.villageId, code: b.code, resources: b.resources ?? {} })));
  fastify.post('/gm/ops/task/complete', (req, reply) => taskOp(req, reply, 'task.GmComplete', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/refresh', (req, reply) => taskOp(req, reply, 'task.GmRefreshRandom', (b) => ({ villageId: b.villageId })));
  fastify.post('/gm/ops/task/reset', (req, reply) => taskOp(req, reply, 'task.GmReset', (b) => ({ villageId: b.villageId })));

  // GET /gm/tasks — 任务管理 Web 面板
  fastify.get('/gm/tasks', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_TASKS_HTML);
  });

  // GET /gm/quests — 任务目录(quests.csv) Web 编辑器
  fastify.get('/gm/quests', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_QUESTS_HTML);
  });

  // GET /gm/quests/data — 返回 quests.csv 解析后的行 + 表头（供编辑器渲染）
  fastify.get('/gm/quests/data', (req, reply) => {
    if (!auth(req, reply)) return;
    const dir = gameApp.configDir;
    const text = readFileSync(join(dir, 'quests.csv'), 'utf-8');
    const doc = parseCsvStructured(text);
    void reply.send({ ok: true, rows: doc.rows, header: doc.header });
  });

  // POST /gm/quests/save — 写回 quests.csv 并热重载（body: { rows: CsvRow[] }）
  fastify.post('/gm/quests/save', (req, reply) => {
    if (!auth(req, reply)) return;
    const body = (req.body ?? {}) as { rows?: Record<string, string>[] };
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      void reply.code(400).send({ ok: false, reason: 'rows 必填且非空' });
      return;
    }
    const dir = gameApp.configDir;
    const tmp = mkdtempSync(join(tmpdir(), 'kow-quests-'));
    try {
      const text = readFileSync(join(dir, 'quests.csv'), 'utf-8');
      const doc = parseCsvStructured(text);
      const header = doc.header;
      // 按表头列序重排，确保每行列齐全
      doc.rows = rows.map((r) => {
        const o: Record<string, string> = {};
        for (const h of header) o[h] = r[h] ?? '';
        return o;
      });
      const csv = serializeCsv(doc);
      cpSync(dir, tmp, { recursive: true });
      writeFileSync(join(tmp, 'quests.csv'), csv, 'utf-8');
      loadGameConfig(tmp); // 校验：失败在此抛出（不落盘）
      writeFileSync(join(dir, 'quests.csv'), csv, 'utf-8');
      gameApp.reloadConfig();
      void reply.send({ ok: true, count: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void reply.code(400).send({ ok: false, reason: msg });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // GET /gm/balance — 平衡调参 Web 面板
  fastify.get('/gm/balance', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_BALANCE_HTML);
  });

  // GET /gm/balance/data — 返回可编辑配置行（建筑 / 建筑逐级 / 兵种 / 全局常量）
  // 必须把 data/balance_overrides.json 的覆盖叠在 CSV 之上后再返回，否则编辑器会一直显示 CSV 默认值，
  // 而实际 app.config（meta + 游戏逻辑）已是覆盖后的值——造成「编辑器与游戏不一致」的误导。
  fastify.get('/gm/balance/data', (req, reply) => {
    if (!auth(req, reply)) return;
    const dir = gameApp.configDir;
    const data: Record<string, unknown> = { meta: BALANCE_TABLES };
    const buildingNames: Record<string, string> = {};
    for (const r of loadCsv(join(dir, 'buildings.csv'))) buildingNames[r.code] = r.name;
    const overrides = gameApp.balanceOverridePath ? loadBalanceOverrides(gameApp.balanceOverridePath) : {} as BalanceOverrides;
    for (const name of Object.keys(BALANCE_TABLES)) {
      let rows = loadCsv(join(dir, BALANCE_TABLES[name].file));
      const tableChanges = overrides[name];
      if (tableChanges && Object.keys(tableChanges).length) {
        const t = BALANCE_TABLES[name];
        rows = mergeOverridesIntoRows(rows, { file: t.file, key: t.key, keyComposite: t.keyComposite, numeric: t.numeric }, tableChanges);
      }
      if (name === 'building_levels') {
        for (const r of rows) r.name = buildingNames[r.code] ?? r.code;
      }
      data[name] = rows;
    }
    void reply.send({ ok: true, ...data });
  });

  // POST /gm/balance/save — 校验 → 写覆盖到 data/balance_overrides.json → 热重载（失败绝不留半截配置）
  fastify.post('/gm/balance/save', (req, reply) => {
    if (!auth(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, Record<string, Record<string, string>>>;
    const dir = gameApp.configDir;
    const overridePath = gameApp.balanceOverridePath;
    if (!overridePath) {
      void reply.code(500).send({ ok: false, reason: 'balanceOverridePath 未配置（storePath 未设置？测试环境不支持平衡调参）' });
      return;
    }
    const edits: Array<[string, BalanceTable, Record<string, Record<string, string>>]> = [];
    for (const name of Object.keys(BALANCE_TABLES)) {
      const c = (body as Record<string, Record<string, Record<string, string>>>)[name];
      if (c && Object.keys(c).length) edits.push([name, BALANCE_TABLES[name], c]);
    }
    if (edits.length === 0) {
      void reply.code(400).send({ ok: false, reason: '没有可保存的改动' });
      return;
    }
    try {
      // 1) 读当前覆盖，合并本次编辑（深合并：表→主键→字段，后写覆盖先写）
      const current = loadBalanceOverrides(overridePath);
      const incoming: BalanceOverrides = {};
      for (const [name, , changes] of edits) incoming[name] = changes;
      const merged = mergeBalanceOverrides(current, incoming);
      // 2) 校验：把合并后的覆盖应用到临时 configDir 副本，跑 loadGameConfig；失败整段回滚
      const tmp = mkdtempSync(join(tmpdir(), 'kow-balance-'));
      try {
        cpSync(dir, tmp, { recursive: true });
        for (const [name, table, changes] of edits) applyBalanceEdits(dir, tmp, table, changes);
        loadGameConfig(tmp); // 失败在此抛出
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      // 3) 校验通过 → 持久化覆盖（data/balance_overrides.json，git 忽略，wipe:all 不动）
      saveBalanceOverrides(overridePath, merged);
      // 4) 热重载（内存 + 存量村庄派生值即时生效）
      gameApp.reloadConfig();
      void reply.send({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void reply.code(400).send({ ok: false, reason: msg });
    }
  });
}

const GM_TASKS_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>任务管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;font-size:13px;background:#1a1a2e;color:#e0e0e0;padding:12px}
h1{font-size:15px;color:#4cc9f0;margin-bottom:8px}
h2{font-size:13px;color:#a0a8c0;margin:14px 0 6px;border-bottom:1px solid #0f3460;padding-bottom:3px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input{padding:4px 8px;background:#0f3460;border:1px solid #4cc9f0;color:#e0e0e0;border-radius:4px;font-family:monospace}
button{background:#0f3460;border:1px solid #4cc9f0;color:#4cc9f0;padding:4px 10px;cursor:pointer;border-radius:3px;font-family:monospace;font-size:12px;margin:2px}
button:hover{background:#4cc9f0;color:#16213e}
.card{background:#16213e;border:1px solid #0f3460;border-radius:4px;padding:8px;margin:4px 0}
#status{padding:4px 0;font-size:12px;color:#70f070}
#status.bad{color:#f07070}
</style></head>
<body>
<h1>任务管理（GM · 线上村庄）</h1>
<div id="status" class="ok">就绪</div>
<div class="toolbar">
  村庄ID：<input id="vid" placeholder="villageId">
  <button onclick="loadTasks()">加载</button>
  <button onclick="refreshRandom()">刷新随机任务</button>
  <button onclick="resetTasks()">重置进度</button>
</div>
<div id="content"></div>
<script>
let token = sessionStorage.getItem('gmToken') ?? '';
function esc(s){s=String(s==null?'':s);return s.replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function statusMsg(m,bad){var e=document.getElementById('status');e.textContent=m;e.className=bad?'bad':'';}
async function api(method,path,body,retryAuth){
  retryAuth=retryAuth!==false;
  var headers={'Content-Type':'application/json'};
  if(token)headers['X-GM-Token']=token;
  var r=await fetch('/gm'+path,{method:method,headers:headers,body:body?JSON.stringify(body):undefined});
  var text=await r.text();var data;try{data=text?JSON.parse(text):{};}catch(e){data={ok:false,reason:'HTTP '+r.status};}
  if(r.status===401&&retryAuth){var next=prompt('GM Token:');if(next!==null){token=next.trim();if(token)sessionStorage.setItem('gmToken',token);else sessionStorage.removeItem('gmToken');return api(method,path,body,false);}}
  if(!r.ok&&data.ok===undefined)data.ok=false;
  return data;
}
function vid(){return document.getElementById('vid').value.trim();}
async function loadTasks(){
  var v=vid();if(!v){statusMsg('请填写村庄ID',true);return;}
  var r=await api('POST','/ops/task/state',{villageId:v});
  if(!r.ok){statusMsg('加载失败: '+(r.reason||''),true);return;}
  render(r.payload);statusMsg('已加载');
}
function render(s){
  var h='';
  h+='<h2>进行中 ('+Object.keys(s.active||{}).length+')</h2>';
  for(var c in (s.active||{})){var t=s.active[c];
    h+='<div class="card" data-code="'+esc(c)+'"><b>'+esc(t.name)+'</b> ['+esc(t.type)+'] code='+esc(c);
    if(t.objective&&t.objective.kind==='submit_resources')h+=' 已交:'+esc(JSON.stringify(t.submitted))+' / 需'+esc(JSON.stringify(t.required));
    if(t.objective&&t.objective.kind==='clear_camp')h+=' 营地'+esc(t.campCleared)+'/'+esc(t.campTotal);
    h+=' <button class="act" data-act="complete" data-code="'+esc(c)+'">完成</button>';
    if(t.canAbandon)h+=' <button class="act" data-act="abandon" data-code="'+esc(c)+'">放弃</button>';
    if(t.objective&&t.objective.kind==='submit_resources')h+=' 资源<input class="res" data-code="'+esc(c)+'" placeholder="wood:100,clay:100" style="width:160px"> <button class="act" data-act="submit" data-code="'+esc(c)+'">上交</button>';
    h+='</div>';
  }
  h+='<h2>酒馆展示（可接取 '+((s.offered||[]).length)+'）</h2>';
  for(var i=0;i<(s.offered||[]).length;i++){var o=s.offered[i];
    h+='<div class="card" data-code="'+esc(o.code)+'">'+esc(o.name)+' ['+esc(o.type)+'] <button class="act" data-act="accept" data-code="'+esc(o.code)+'">接取</button></div>';
  }
  h+='<h2>已完成主线</h2><div class="card">'+(s.completedMain||[]).join(', ')+'</div>';
  h+='<h2>已完成随机</h2><div class="card">'+(s.completedRandom||[]).join(', ')+'</div>';
  document.getElementById('content').innerHTML=h;
}
document.addEventListener('click',function(e){
  var btn=e.target.closest('.act');if(!btn)return;
  var act=btn.getAttribute('data-act');var code=btn.getAttribute('data-code');
  if(act==='complete')doComplete(code);
  else if(act==='abandon')doAbandon(code);
  else if(act==='accept')doAccept(code);
  else if(act==='submit')doSubmit(code);
});
async function doComplete(code){var r=await api('POST','/ops/task/complete',{villageId:vid(),code:code});after(r,'完成');}
async function doAbandon(code){var r=await api('POST','/ops/task/abandon',{villageId:vid(),code:code});after(r,'放弃');}
async function doAccept(code){var r=await api('POST','/ops/task/accept',{villageId:vid(),code:code});after(r,'接取');}
async function doSubmit(code){var raw=document.querySelector('input.res[data-code="'+code+'"]').value.trim();var res={};raw.split(',').forEach(function(p){var kv=p.split(':');if(kv.length===2)res[kv[0].trim()]=Number(kv[1].trim());});var r=await api('POST','/ops/task/submit',{villageId:vid(),code:code,resources:res});after(r,'上交');}
async function refreshRandom(){var r=await api('POST','/ops/task/refresh',{villageId:vid()});after(r,'刷新随机');}
async function resetTasks(){if(!confirm('确认重置该村全部任务进度（重激活主线 m1）？'))return;var r=await api('POST','/ops/task/reset',{villageId:vid()});after(r,'重置');}
async function after(r,act){if(!r.ok){statusMsg(act+'失败: '+(r.reason||''),true);return;}statusMsg(act+'成功');loadTasks();}
loadTasks();
</script>
</body></html>`;

const GM_QUESTS_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>任务目录编辑</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;font-size:13px;background:#1a1a2e;color:#e0e0e0;padding:12px}
h1{font-size:15px;color:#4cc9f0;margin-bottom:8px}
.toolbar{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
input{padding:3px 6px;background:#0f3460;border:1px solid #4cc9f0;color:#e0e0e0;border-radius:3px;font-family:monospace;font-size:12px;width:110px}
button{background:#0f3460;border:1px solid #4cc9f0;color:#4cc9f0;padding:4px 10px;cursor:pointer;border-radius:3px;font-family:monospace;font-size:12px;margin:2px}
button:hover{background:#4cc9f0;color:#16213e}
button.save{border-color:#70f070;color:#70f070}
button.save:hover{background:#70f070;color:#16213e}
#grid{overflow:auto;border:1px solid #0f3460;border-radius:4px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #0f3460;padding:3px 5px;font-size:12px;white-space:nowrap}
th{background:#16213e;color:#a0a8c0;text-align:left}
#status{margin-top:8px;font-size:12px;color:#70f070}
#status.bad{color:#f07070}
</style></head>
<body>
<h1>任务目录（quests.csv）· 保存后即时热重载</h1>
<div id="status" class="ok">就绪</div>
<div class="toolbar">
  <button onclick="load()">重新加载</button>
  <button onclick="addRow()">新增一行</button>
  <button class="save" onclick="save()">保存并热重载</button>
</div>
<div id="grid"></div>
<script>
let token=sessionStorage.getItem('gmToken')??'';
var COLS=['id','code','name','desc','type','requires','objKind','objParam','rewardRes','rewardTreasure','weight'];
var NUM=['id','weight'];
var ROWS=[];
function esc(s){s=String(s==null?'':s);return s.replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function statusMsg(m,bad){var e=document.getElementById('status');e.textContent=m;e.className=bad?'bad':'';}
async function api(method,path,body,retryAuth){
  retryAuth=retryAuth!==false;
  var headers={'Content-Type':'application/json'};
  if(token)headers['X-GM-Token']=token;
  var r=await fetch('/gm'+path,{method:method,headers:headers,body:body?JSON.stringify(body):undefined});
  var text=await r.text();var data;try{data=text?JSON.parse(text):{};}catch(e){data={ok:false,reason:'HTTP '+r.status};}
  if(r.status===401&&retryAuth){var next=prompt('GM Token:');if(next!==null){token=next.trim();if(token)sessionStorage.setItem('gmToken',token);else sessionStorage.removeItem('gmToken');return api(method,path,body,false);}}
  if(!r.ok&&data.ok===undefined)data.ok=false;
  return data;
}
async function load(){
  var r=await api('GET','/quests/data');
  if(!r.ok){statusMsg('加载失败',true);return;}
  if(Array.isArray(r.header)&&r.header.length)COLS=r.header;
  ROWS=r.rows||[];
  render();statusMsg('已加载 '+ROWS.length+' 条');
}
function render(){
  var h='<table><thead><tr>';
  for(var i=0;i<COLS.length;i++)h+='<th>'+esc(COLS[i])+'</th>';
  h+='<th></th></tr></thead><tbody>';
  for(var k=0;k<ROWS.length;k++){var row=ROWS[k];
    h+='<tr data-i="'+k+'">';
    for(var j=0;j<COLS.length;j++){var f=COLS[j];var val=row[f]==null?'':row[f];var tp=NUM.indexOf(f)>=0?'number':'text';
      h+='<td><input type="'+tp+'" data-i="'+k+'" data-f="'+f+'" value="'+esc(val)+'" oninput="onEdit(this)"></td>';
    }
    h+='<td><button onclick="delRow('+k+')">删除</button></td></tr>';
  }
  h+='</tbody></table>';
  document.getElementById('grid').innerHTML=h;
}
function onEdit(el){var i=+el.getAttribute('data-i');var f=el.getAttribute('data-f');ROWS[i][f]=el.value;}
function delRow(i){ROWS.splice(i,1);render();}
function addRow(){var o={};for(var i=0;i<COLS.length;i++)o[COLS[i]]='';ROWS.push(o);render();}
async function save(){
  var r=await api('POST','/quests/save',{rows:ROWS});
  if(!r.ok){statusMsg('保存失败: '+(r.reason||''),true);return;}
  statusMsg('已保存 '+r.count+' 条并热重载');load();
}
load();
</script>
</body></html>`;

