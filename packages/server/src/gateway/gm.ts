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
const TOKEN = '';  // 若设了 GM_TOKEN，把值填这里
const H = TOKEN ? {'X-GM-Token': TOKEN, 'Content-Type':'application/json'} : {'Content-Type':'application/json'};

let curCol = '', curKey = '', allDocs = {};

async function api(method, path, body) {
  const r = await fetch('/gm' + path, {method, headers: H, body: body ? JSON.stringify(body) : undefined});
  return r.json();
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
  const docs = data.docs ?? {};
  const list = document.getElementById('doc-list');
  const keys = Object.keys(docs);
  if (!keys.length) { list.innerHTML = '<div class="empty">暂无玩家</div>'; return; }
  list.innerHTML = '';
  for (const k of keys) {
    const p = docs[k];
    const row = document.createElement('div');
    row.className = 'player-item';
    row.innerHTML = \`<span class="player-name" title="\${k}">\${p.name ?? k}</span><span style="color:#a0a8c0;font-size:11px">\${p.tribe ?? ''}</span>\`;
    const btn = document.createElement('button');
    btn.className = 'danger sm';
    btn.textContent = '删';
    btn.onclick = () => deletePlayer(k, p.name ?? k);
    row.appendChild(btn);
    list.appendChild(row);
  }
  curCol = 'player';
  document.getElementById('cur-key').textContent = '玩家管理';
  status(\`共 \${keys.length} 个玩家\`);
}

async function deletePlayer(playerId, name) {
  if (!confirm(\`确定删除玩家「\${name}」及其所有进度？\`)) return;
  const r = await api('DELETE', \`/ops/player/\${playerId}?confirm=yes\`);
  if (r.ok) { status(\`已删除玩家 \${name}（村庄 \${r.villageId}）\`); refreshAll(); showPlayers(); }
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
    numeric: ['costWood', 'costClay', 'costIron', 'costCrop', 'costGold', 'timeSec', 'popCap', 'prod'],
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
const TABLES = ['buildings','building_levels','units','mercenaries','merc_camp','trade_center','treasures','constants'];
const CHANGES = {buildings:{}, building_levels:{}, units:{}, mercenaries:{}, merc_camp:{}, trade_center:{}, treasures:{}, constants:{}};
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
  var TITLES = { buildings:'建筑 / 资源田', units:'兵种', mercenaries:'雇佣兵', merc_camp:'雇佣兵营地刷新', trade_center:'贸易中心逐级参数', treasures:'宝物目录', constants:'全局常量' };
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

// 建筑逐级参数：按 code 分组，默认折叠，点开看每级 7 个数值输入
function sectionLevels(table){
  var meta = DATA.meta[table];
  var rows = DATA[table] || [];
  var fields = meta.numeric;
  var byCode = {};
  for (var i=0;i<rows.length;i++){ (byCode[rows[i].code] = byCode[rows[i].code] || []).push(rows[i]); }
  var h = '<div class="hint">主键 code|level · 可编辑: ' + esc(fields.join(', ')) + '（点建筑名展开每级数值）</div>';
  h += '<div class="bl-list">';
  var codes = Object.keys(byCode).sort();
  for (var c=0;c<codes.length;c++){
    var code = codes[c];
    var group = byCode[code].slice().sort(function(a,b){ return a.level - b.level; });
    var name = group[0].name || code;
    var bid = 'bl-' + code, aid = 'ar-' + code;
    h += '<div class="bl-card">';
    h += '<div class="bl-head" data-code="'+esc(code)+'" onclick="toggleBl(this.dataset.code)"><span class="bl-arrow" id="'+aid+'">▶</span> '+esc(name)+' <span class="bl-sub">'+esc(code)+' · '+group.length+'级</span></div>';
    h += '<div class="bl-body" id="'+bid+'" style="display:none">';
    h += '<table class="bt"><thead><tr><th>level</th>';
    for (var f2=0;f2<fields.length;f2++) h += '<th>'+esc(fields[f2])+'</th>';
    h += '</tr></thead><tbody>';
    for (var g=0;g<group.length;g++){
      var row = group[g];
      var key = code + '|' + row.level;
      h += '<tr><td class="lbl">'+esc(row.level)+'</td>';
      for (var b2=0;b2<fields.length;b2++){
        var f = fields[b2];
        var val = row[f]==null?'':row[f];
        h += '<td><input type="number" step="any" value="'+esc(val)+'" data-t="building_levels" data-k="'+esc(key)+'" data-f="'+esc(f)+'" oninput="onEdit(this)"></td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div></div>';
  }
  h += '</div>';
  return '<div class="sec"><h2>建筑逐级参数</h2>'+h+'</div>';
}

function toggleBl(code){
  var el = document.getElementById('bl-' + code);
  var ar = document.getElementById('ar-' + code);
  if (el.style.display === 'none'){ el.style.display = 'block'; ar.textContent = '▼'; }
  else { el.style.display = 'none'; ar.textContent = '▶'; }
}

function render(){
  var html = '';
  for (var i=0;i<TABLES.length;i++){
    var t = TABLES[i];
    if (t === 'building_levels') html += sectionLevels(t);
    else html += sectionGeneric(t);
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

