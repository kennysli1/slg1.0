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
 *   POST   /gm/ops/cancel-scout-encounters 解除旧版本错误产生的侦察野战并让双方从当前位置返村
 *
 * 安全：GM_TOKEN=<secret> 时所有请求需带 X-GM-Token header（面板自动处理）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Store } from '../infra/store.js';
import type { GameApp } from '../app.js';
import { readFileSync, writeFileSync, cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCsv, parseCsvStructured, serializeCsv, type CsvRow } from '../infra/csv.js';
import { loadGameConfig } from '../infra/config.js';

/** 数字感知的稳定字符串排序：m2 应排在 m10 前面。 */
function compareNatural(a: string, b: string): number {
  const chunksA = a.match(/\d+|\D+/g) ?? [''];
  const chunksB = b.match(/\d+|\D+/g) ?? [''];
  const length = Math.min(chunksA.length, chunksB.length);
  for (let i = 0; i < length; i++) {
    const chunkA = chunksA[i];
    const chunkB = chunksB[i];
    const numericA = /^\d+$/.test(chunkA);
    const numericB = /^\d+$/.test(chunkB);
    if (numericA && numericB) {
      const normalizedA = chunkA.replace(/^0+(?=\d)/, '');
      const normalizedB = chunkB.replace(/^0+(?=\d)/, '');
      if (normalizedA.length !== normalizedB.length) return normalizedA.length - normalizedB.length;
      if (normalizedA !== normalizedB) return normalizedA < normalizedB ? -1 : 1;
      if (chunkA.length !== chunkB.length) return chunkA.length - chunkB.length;
      continue;
    }
    if (chunkA !== chunkB) return chunkA < chunkB ? -1 : 1;
  }
  return chunksA.length - chunksB.length;
}

/** 对话 code 排序：下划线是分隔符，优先于后续数字；各段内部按自然数字顺序。 */
function compareDialogueCode(a: string, b: string): number {
  const partsA = String(a ?? '').split('_');
  const partsB = String(b ?? '').split('_');
  const length = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const order = compareNatural(partsA[i], partsB[i]);
    if (order !== 0) return order;
  }
  // 共有前缀时，先结束的 code 优先；等价于让 '_' 优先于后续数字/文字。
  return partsA.length - partsB.length;
}

/** 对话编辑器的确定性顺序：先按 code，再按 taskCode、段落号和 id。 */
function sortDialogueRows(rows: CsvRow[]): CsvRow[] {
  return [...rows].sort((a, b) => {
    const codeA = String(a.code ?? '');
    const codeB = String(b.code ?? '');
    const codeOrder = compareDialogueCode(codeA, codeB);
    if (codeOrder !== 0) return codeOrder;

    const taskCodeA = String(a.taskCode ?? '');
    const taskCodeB = String(b.taskCode ?? '');
    const taskCodeOrder = compareNatural(taskCodeA, taskCodeB);
    if (taskCodeOrder !== 0) return taskCodeOrder;

    const segmentA = Number(a.segment);
    const segmentB = Number(b.segment);
    if (Number.isFinite(segmentA) && Number.isFinite(segmentB) && segmentA !== segmentB) {
      return segmentA - segmentB;
    }
    if (Number.isFinite(segmentA) !== Number.isFinite(segmentB)) return Number.isFinite(segmentA) ? -1 : 1;

    // code/segment 按规范应唯一；id 作为异常或旧数据的稳定兜底顺序。
    const idA = Number(a.id);
    const idB = Number(b.id);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
    return 0;
  });
}

/**
 * 为每个支线任务补齐可编辑的接取/交付对话模板。
 *
 * 模板只在配置中心保存任务定义时自动写入；GET 接口仅在内存中补齐，避免
 * 打开页面产生隐式配置变更。已有自定义 taskCode+trigger 行优先保留。
 */
function ensureDefaultSideDialogueRows(rows: CsvRow[], questRows: CsvRow[]): { rows: CsvRow[]; added: number } {
  const result = rows.map((row) => ({ ...row }));
  const existing = new Set(result.map((row) => `${row.taskCode ?? ''}:${row.trigger ?? ''}`));
  let nextId = result.reduce((max, row) => {
    const id = Number(row.id);
    return Number.isFinite(id) ? Math.max(max, Math.floor(id)) : max;
  }, 0) + 1;
  let added = 0;
  for (const quest of questRows) {
    if (String(quest.type ?? '').trim() !== 'side') continue;
    const taskCode = String(quest.code ?? '').trim();
    if (!taskCode) continue;
    for (const trigger of ['accept', 'deliver']) {
      const key = `${taskCode}:${trigger}`;
      if (existing.has(key)) continue;
      result.push({
        id: String(nextId++), code: `${taskCode}_${trigger}`, taskCode, trigger, segment: '1',
        npcName: '', npcText: '', replies: trigger === 'deliver' ? 'take:收下' : '',
      });
      existing.add(key);
      added++;
    }
  }
  return { rows: result, added };
}

/** 按现有 CSV 文档的表头/注释布局重建数据行。 */
function replaceCsvRows(text: string, rows: CsvRow[]): string {
  const doc = parseCsvStructured(text);
  const oldDataIndices = new Set(doc.rowIndices);
  const raw = doc.raw.filter((_, index) => !oldDataIndices.has(index));
  doc.raw = raw;
  doc.headerIndex = raw.findIndex((line) => line.split(',').map((x) => x.trim()).join(',') === doc.header.join(','));
  doc.rows = rows.map((row) => Object.fromEntries(doc.header.map((header) => [header, row[header] ?? ''])));
  doc.rowIndices = [];
  for (let i = 0; i < doc.rows.length; i++) {
    doc.raw.push('');
    doc.rowIndices.push(doc.raw.length - 1);
  }
  return serializeCsv(doc);
}

/** 任务编辑器保存后，为新增支线任务持久化空白 accept/deliver 模板。 */
function ensureSideDialogueTemplatesInDir(dir: string): { added: number } {
  const dialoguePath = join(dir, 'dialogues.csv');
  const questsPath = join(dir, 'quests.csv');
  if (!existsSync(dialoguePath) || !existsSync(questsPath)) return { added: 0 };
  const dialogueText = readFileSync(dialoguePath, 'utf-8');
  const dialogueDoc = parseCsvStructured(dialogueText);
  const questRows = loadCsv(questsPath);
  const ensured = ensureDefaultSideDialogueRows(dialogueDoc.rows, questRows);
  if (ensured.added === 0) return { added: 0 };
  writeFileSync(dialoguePath, replaceCsvRows(dialogueText, sortDialogueRows(ensured.rows)), 'utf-8');
  return { added: ensured.added };
}

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
    <div style="color:#a0a8c0;font-size:10px;line-height:1.45;margin-bottom:7px">GM 只修改当前服务器实时 JSON 状态；任务定义、数值和对话请进入配置中心，合并配置 PR 并部署后生效。</div>
    <div class="ops-row">
      <button class="warn sm" onclick="window.open('/config','_blank')">配置中心（CSV）</button>
      <button class="warn sm" onclick="window.open('/gm/tasks','_blank')">任务状态管理</button>
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

/** 独立配置中心入口：只编辑版本化 CSV，保存后由配置同步队列创建 GitHub PR。 */
const CONFIG_CENTER_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>配置中心</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#0d1720;color:#dce7f7;font:14px ui-monospace,monospace}main{max-width:1180px;margin:auto}.card{border:1px solid #3b6e91;border-radius:8px;padding:18px;background:#142532;margin:14px 0}h1{color:#8ed5ff;margin:0 0 8px}.notice{border-left:4px solid #f1c575;padding:10px 12px;background:#2b2a22;color:#f7dda0;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}a,button{display:inline-block;padding:9px 12px;border:1px solid #65c7ff;border-radius:5px;color:#dce7f7;background:#173550;text-decoration:none;cursor:pointer;font:inherit;margin:3px 4px 3px 0}a:hover,button:hover{background:#2b6689}.meta{color:#9bb0c9;line-height:1.6;font-size:12px}#status{white-space:pre-wrap;color:#b9f6c8;overflow:auto;max-height:260px}.sync-state{display:inline-block;padding:5px 9px;border-radius:4px;background:#245b3d;color:#b9f6c8;margin:5px 0}.sync-state.warn{background:#6b4c1d;color:#ffe1a3}.sync-state.bad{background:#6d2d34;color:#ffd1d5}.pr-link{margin-left:8px}.conflict{border:1px solid #8e5f3b;border-radius:7px;padding:14px;margin:12px 0;background:#241e1a}.conflict h3{margin:0 0 8px;color:#ffd08a}.source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.source-grid section{min-width:0}.source-grid h4{margin:4px 0;color:#9dd8ff;font-size:12px}.source-grid pre{margin:0;padding:9px;background:#0b1219;border:1px solid #2b4358;white-space:pre-wrap;overflow:auto;max-height:180px;font:11px ui-monospace,monospace;color:#c4d1df}.resolved{width:100%;min-height:220px;background:#0b1219;border:1px solid #65c7ff;border-radius:4px;color:#e5eef8;padding:9px;font:12px ui-monospace,monospace}.resolve-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}.resolve-bar select{background:#0b1219;color:#e5eef8;border:1px solid #557692;border-radius:4px;padding:7px;font:inherit}.hidden{display:none}@media(max-width:780px){.source-grid{grid-template-columns:1fr}}
</style></head><body><main>
<h1>配置中心（CSV）</h1>
<div class="card"><div class="grid">
<a href="/config/balance">平衡参数与常量</a><a href="/config/quest-modules">任务定义模块</a><a href="/config/quests">任务目录</a><a href="/config/quest-graph">任务关系图（只读审查）</a><a href="/config/dialogues">任务/NPC 对话</a>
</div></div>
<div class="notice">这里修改的是版本化游戏配置，不是当前玩家状态。保存后会校验 CSV、写入共享配置、热重载当前服务器，并异步创建 GitHub 配置 PR。下方会显示 PR 检查与冲突状态；冲突时可逐文件确认最终内容，配置中心值默认作为权威版本。</div>
<div class="card"><div class="meta">GM 面板只负责实时 JSON 状态（资源、人口、任务进度、村庄和军队）。本页不提供删档或账号操作。</div><p><button onclick="loadStatus()">刷新配置同步状态</button> <button onclick="syncNow()">立即同步 / 重试</button> <a href="/gm">返回 GM 实时状态</a></p><div id="state" class="sync-state">加载中…</div><span id="pr"></span><pre id="status">加载中…</pre></div>
<div id="conflicts" class="card hidden"><h2>需要确认的配置冲突</h2><div class="meta">配置中心内容是运行时权威。每个文件都可以查看 main、PR 当前版本和配置中心版本，编辑“最终提交内容”后一次性提交。提交前会执行整套 CSV 校验。</div><div id="conflict-list"></div><div class="resolve-bar"><button id="resolve" onclick="resolveConflicts()">确认全部文件并更新 PR</button><span id="resolve-status" class="meta"></span></div></div>
<script>
let token=sessionStorage.getItem('gmToken')??'';let latest=null;let conflictData=null;
function headers(){let h={};if(token)h['X-GM-Token']=token;return h}
async function request(url,opt={}){opt.headers=Object.assign({},opt.headers||{},headers(),opt.body?{'Content-Type':'application/json'}:{});let r=await fetch(url,opt);if(r.status===401){let x=prompt('GM Token:',token);if(x!==null){token=x.trim();if(token)sessionStorage.setItem('gmToken',token);return request(url,opt)}}let d=await r.json();if(!r.ok&&!d.ok)throw Error(d.reason||'请求失败');return d}
function esc(s){return String(s??'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function renderStatus(d){latest=d;let state=d.syncState||'idle';let labels={idle:'尚未同步',pending:'等待同步',checking:'PR 检查中',conflict:'PR 存在冲突',ready:'可以合并',merged:'已合并 main',error:'同步失败'};let el=document.getElementById('state');el.textContent=labels[state]||state;el.className='sync-state '+(state==='conflict'||state==='error'?'bad':state==='checking'||state==='pending'?'warn':'');let pr=document.getElementById('pr');pr.innerHTML=d.pullRequestUrl?'<a class="pr-link" target="_blank" rel="noreferrer" href="'+esc(d.pullRequestUrl)+'">打开 GitHub PR</a>':'';document.getElementById('status').textContent=JSON.stringify(d,null,2);if(state==='conflict')loadConflicts();else document.getElementById('conflicts').classList.add('hidden')}
async function loadStatus(){try{renderStatus(await request('/config/status'))}catch(e){document.getElementById('state').textContent='状态读取失败：'+e.message;document.getElementById('state').className='sync-state bad'}}
async function syncNow(){try{renderStatus(await request('/config/sync',{method:'POST'}));}catch(e){document.getElementById('state').textContent='同步失败：'+e.message;document.getElementById('state').className='sync-state bad';loadStatus()}}
function setResolution(file,source){let card=document.querySelector('[data-file="'+CSS.escape(file)+'"]');if(!card||!conflictData)return;let entry=conflictData.files.find(x=>x.file===file);let area=card.querySelector('textarea');area.value=source==='authority'?entry.authority:source==='main'?entry.main:entry.branch;area.dataset.source=source}
function renderConflicts(d){conflictData=d;let list=document.getElementById('conflict-list');list.innerHTML=d.files.map(function(entry){return '<div class="conflict" data-file="'+esc(entry.file)+'"><h3>'+esc(entry.file)+'</h3><div class="source-grid"><section><h4>配置中心（权威）</h4><pre>'+esc(entry.authority)+'</pre></section><section><h4>main</h4><pre>'+esc(entry.main)+'</pre></section><section><h4>PR 当前版本</h4><pre>'+esc(entry.branch)+'</pre></section></div><div class="resolve-bar"><label>初始版本 <select onchange="setResolution(\''+esc(entry.file).replace(/'/g,"\\'")+'\',this.value)"><option value="authority">配置中心（权威）</option><option value="main">main</option><option value="branch">PR 当前版本</option></select></label></div><textarea class="resolved" data-source="authority">'+esc(entry.authority)+'</textarea></div>'}).join('');document.getElementById('conflicts').classList.remove('hidden')}
async function loadConflicts(){try{renderConflicts(await request('/config/sync/conflicts'))}catch(e){document.getElementById('resolve-status').textContent='冲突读取失败：'+e.message;document.getElementById('resolve-status').style.color='#ffb6b6'}}
async function resolveConflicts(){if(!conflictData||!latest?.pullRequest)return;let button=document.getElementById('resolve');button.disabled=true;document.getElementById('resolve-status').textContent='提交并校验中…';try{let files=[...document.querySelectorAll('.conflict')].map(function(card){return {file:card.dataset.file,content:card.querySelector('textarea').value}});let d=await request('/config/sync/resolve',{method:'POST',body:JSON.stringify({expectedHeadSha:latest.pullRequest.headSha,files})});renderStatus(d);document.getElementById('resolve-status').textContent=d.syncState==='conflict'?'仍需处理冲突':'已提交解决版本，等待 PR 检查';}catch(e){document.getElementById('resolve-status').textContent='提交失败：'+e.message;document.getElementById('resolve-status').style.color='#ffb6b6'}finally{button.disabled=false}}
loadStatus();
</script>
</main></body></html>`;

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
  /** 可编辑的文本字段（用于任务 params 等按 kind 解析的值）。 */
  text?: string[];
  numericByType?: boolean;
  labels: string[];
}

/** 任务图的六张配置表；顺序即 GM 编辑器与人工审查的阅读顺序。 */
const QUEST_MODULE_TABLES = [
  'quest_lines.csv',
  'quests.csv',
  'quest_conditions.csv',
  'quest_objectives.csv',
  'quest_effects.csv',
  'quest_edges.csv',
] as const;

/**
 * GM 编辑后的配置不能只停留在当前 release：release 目录会在下一次部署时
 * 被新的 git 包替换。把已编辑的 CSV 镜像到 shared/data 同级的 config 目录，
 * 由 remote-release.sh 在后续 release 构建完成后按稳定主键合并回去；manifest
 * 只记录允许合并的配置文件名，避免旧整文件遮蔽新的代码/配置变更。
 */
const GM_CONFIG_MANIFEST = 'balance_csv_files.list';
const CONFIG_ROW_TOMBSTONES_FILE = 'config_row_tombstones.json';

interface ConfigRowTombstones {
  version: 1;
  tables: Record<string, string[][]>;
}

type ConfigRowsSnapshot = Record<string, CsvRow[]>;

const WHOLE_TABLE_KEY_COLUMNS: Record<string, string[]> = {
  'dialogues.csv': ['code', 'segment'],
  'quest_lines.csv': ['code'],
  'quests.csv': ['id'],
  'quest_conditions.csv': ['id'],
  'quest_objectives.csv': ['id'],
  'quest_effects.csv': ['id'],
  'quest_edges.csv': ['id'],
};

function persistentConfigDir(gameApp: GameApp): string | null {
  if (!gameApp.balanceOverridePath) return null;
  const dataDir = dirname(gameApp.balanceOverridePath);
  // 生产 release 的 current/data 是指向 shared/data 的符号链接。必须先解析
  // 该链接，再取 shared 的同级 config；否则会误写到 shared/data/config，下一次
  // 发布的 overlay（shared/config）就看不到 GM 保存的 CSV。普通测试目录没有
  // 符号链接时仍沿用 data/config，便于隔离测试和本地开发。
  try {
    if (lstatSync(dataDir).isSymbolicLink()) {
      return join(dirname(realpathSync(dataDir)), 'config');
    }
  } catch {
    // 路径尚未创建时回退到本地 data/config；调用方随后会 mkdir。
  }
  return join(dataDir, 'config');
}

function configKeyColumns(file: string, header: readonly string[]): string[] {
  const wholeTableColumns = WHOLE_TABLE_KEY_COLUMNS[file];
  if (wholeTableColumns) return wholeTableColumns;
  const balance = Object.values(BALANCE_TABLES).find((table) => table.file === file);
  if (balance?.keyComposite) return balance.keyComposite;
  if (balance?.key) return [balance.key];
  return header.length > 0 ? [header[0]] : [];
}

function configRowIdentity(row: CsvRow, columns: readonly string[], label: string): string[] {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === undefined || value === '')) {
    throw new Error(`${label} 缺少主键列 ${columns.join('+')}`);
  }
  return values as string[];
}

function rowIdentityKey(values: readonly string[]): string {
  return JSON.stringify(values);
}

function readConfigRowTombstones(path: string): ConfigRowTombstones {
  if (!existsSync(path)) return { version: 1, tables: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConfigRowTombstones>;
  if (parsed.version !== 1 || !parsed.tables || typeof parsed.tables !== 'object' || Array.isArray(parsed.tables)) {
    throw new Error(`${CONFIG_ROW_TOMBSTONES_FILE} 格式无效`);
  }
  for (const [file, rows] of Object.entries(parsed.tables)) {
    if (!/^[A-Za-z0-9_.-]+\.csv$/.test(file) || !Array.isArray(rows)
      || rows.some((values) => !Array.isArray(values) || values.some((value) => typeof value !== 'string' || value === ''))) {
      throw new Error(`${CONFIG_ROW_TOMBSTONES_FILE} 的 ${file} 行主键无效`);
    }
  }
  return { version: 1, tables: parsed.tables };
}

function writeConfigRowTombstones(path: string, state: ConfigRowTombstones): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function snapshotConfigRows(dir: string, files: readonly string[]): ConfigRowsSnapshot {
  return Object.fromEntries(files.map((file) => {
    const rows = parseCsvStructured(readFileSync(join(dir, file), 'utf8')).rows;
    return [file, rows.map((row) => ({ ...row }))];
  }));
}

function persistConfigFiles(gameApp: GameApp, files: readonly string[], previousRows: ConfigRowsSnapshot = {}): void {
  const targetDir = persistentConfigDir(gameApp);
  if (!targetDir || files.length === 0) return;
  mkdirSync(targetDir, { recursive: true });
  const tombstonesPath = join(targetDir, CONFIG_ROW_TOMBSTONES_FILE);
  const tombstones = readConfigRowTombstones(tombstonesPath);
  const manifestPath = join(dirname(gameApp.balanceOverridePath!), GM_CONFIG_MANIFEST);
  let existing: string[] = [];
  try {
    existing = readFileSync(manifestPath, 'utf8')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    // 首次保存时 manifest 尚不存在，按空列表初始化。
  }
  const all = new Set(existing);
  for (const file of files) {
    // 调用方只传入固定的 CSV 表名；再次限制路径，防止 GM 请求借此越界写文件。
    if (!/^[A-Za-z0-9_.-]+\.csv$/.test(file)) throw new Error(`非法配置文件名: ${file}`);
    const sourcePath = join(gameApp.configDir, file);
    const persistedPath = join(targetDir, file);
    const nextDoc = parseCsvStructured(readFileSync(sourcePath, 'utf8'));
    const columns = configKeyColumns(file, nextDoc.header);
    if (columns.length === 0 || columns.some((column) => !nextDoc.header.includes(column))) {
      throw new Error(`${file} 缺少稳定主键列`);
    }
    const before = previousRows[file]
      ?? (existsSync(persistedPath) ? parseCsvStructured(readFileSync(persistedPath, 'utf8')).rows : nextDoc.rows);
    const beforeByKey = new Map(before.map((row) => {
      const values = configRowIdentity(row, columns, `${file} 保存前行`);
      return [rowIdentityKey(values), values] as const;
    }));
    const nextByKey = new Map(nextDoc.rows.map((row) => {
      const values = configRowIdentity(row, columns, `${file} 保存后行`);
      return [rowIdentityKey(values), values] as const;
    }));
    const tableTombstones = new Map((tombstones.tables[file] ?? []).map((values) => [rowIdentityKey(values), values]));
    for (const [key, values] of beforeByKey) {
      if (!nextByKey.has(key)) tableTombstones.set(key, values);
    }
    for (const key of nextByKey.keys()) tableTombstones.delete(key);
    const sorted = [...tableTombstones.values()].sort((left, right) => rowIdentityKey(left).localeCompare(rowIdentityKey(right)));
    if (sorted.length > 0) tombstones.tables[file] = sorted;
    else delete tombstones.tables[file];
    copyFileSync(sourcePath, persistedPath);
    all.add(file);
  }
  writeConfigRowTombstones(tombstonesPath, tombstones);
  writeFileSync(manifestPath, [...all].sort().join('\n') + '\n', 'utf8');
}

export const BALANCE_TABLES: Record<string, BalanceTable> = {
  buildings: {
    file: 'buildings.csv', key: 'id',
    numeric: ['maxLevel', 'maxCount', 'mainBaseLevel', 'prosperityPerLevel', 'popGrowthPerLevel'],
    labels: ['id', 'code', 'name'],
  },
  building_levels: {
    file: 'building_levels.csv',
    keyComposite: ['code', 'level'],
    numeric: ['costWood', 'costClay', 'costIron', 'costCrop', 'costGold', 'timeSec', 'popCap', 'prod', 'treasureSlots', 'storagePerLevel', 'defensePerLevel', 'buildSpeedupPerLevel', 'trainTimeReducePerLevel', 'trainCostReducePerLevel', 'taskRefreshSec', 'taskMaxTasks', 'taskSideQuestChance', 'vaultProtectWood', 'vaultProtectClay', 'vaultProtectIron', 'vaultProtectCrop', 'vaultProtectGold'],
    labels: ['code', 'level', 'name'],
  },
  units: {
    file: 'units.csv', key: 'id',
    numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'speed', 'vision', 'carry', 'upkeep', 'costWood', 'costClay', 'costIron', 'costCrop', 'trainSec', 'popCost'],
    text: ['simTraits'],
    labels: ['id', 'code', 'name', 'tribe'],
  },
  unit_traits: {
    file: 'unit_traits.csv', key: 'id',
    numeric: ['value1', 'value2', 'value3', 'value4', 'value5'],
    text: ['effect1', 'effect2', 'effect3', 'effect4', 'effect5'],
    labels: ['id', 'code', 'name'],
  },
  // 雇佣兵（tribe=merc）：可编辑战斗属性 + 单价；upkeep/cost*/trainSec/popCost 由引擎强制为 0（不经训练队列），故不在此暴露
  mercenaries: {
    file: 'mercenaries.csv', key: 'id',
    numeric: ['meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'speed', 'carry', 'goldCost'],
    text: ['traits', 'simTraits'],
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
  kingdom_services: {
    file: 'kingdom_services.csv', key: 'id',
    numeric: ['minCouncilLevel', 'reputationCost', 'unitCount', 'wood', 'clay', 'iron', 'crop', 'gold', 'delaySec'],
    labels: ['id', 'code', 'name', 'category', 'unitCode', 'treasureCode', 'desc'],
  },
  pve_targets: {
    file: 'pve_targets.csv', key: 'id',
    numeric: ['respawnSec', 'lootWood', 'lootClay', 'lootIron', 'lootCrop'],
    labels: ['id', 'code', 'name'],
  },
  pve_defenders: {
    file: 'pve_defenders.csv', keyComposite: ['targetId', 'unitCode'],
    numeric: ['count', 'meleeAtk', 'rangedAtk', 'meleeDef', 'rangedDef', 'hp', 'carry'],
    text: ['traits'],
    labels: ['targetId', 'unitCode', 'name', 'form'],
  },
  // 宝物目录（treasures.csv）：id → {effectValue, reputationValue, priceGold, dropRate} 可编辑；其余为展示标签
  treasures: {
    file: 'treasures.csv', key: 'id',
    numeric: ['effectValue', 'reputationValue', 'priceGold', 'dropRate'],
    labels: ['id', 'code', 'name', 'category', 'rarity', 'effectType', 'applyType'],
  },
  // 任务中的声望目标/效果也在声望专用视图集中展示；params 保持字符串，由运行时按 kind 校验。
  quest_objectives: {
    file: 'quest_objectives.csv', key: 'id',
    text: ['params'],
    labels: ['id', 'questCode', 'phase', 'kind', 'order'],
  },
  quest_effects: {
    file: 'quest_effects.csv', key: 'id',
    text: ['params'],
    labels: ['id', 'questCode', 'phase', 'kind', 'order'],
  },
  constants: {
    file: 'game_constants.csv', key: 'key',
    numericByType: true, // 用行内 type 列判定（number/bool/string）
    labels: ['key', 'note'],
  },
  // 科研系统
  research: {
    file: 'research.csv', key: 'id',
    numeric: ['tier', 'mainBaseLevel', 'effectValue', 'durationSec', 'rpCost'],
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
      } else if (table.text?.includes(h)) {
        merged[h] = newVal;
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
const TOKEN = sessionStorage.getItem('gmToken') ?? '';
const H = TOKEN ? {'X-GM-Token': TOKEN, 'Content-Type':'application/json'} : {'Content-Type':'application/json'};
const TABLES = ['buildings','building_levels','units','unit_traits','mercenaries','merc_camp','trade_center','kingdom_services','pve_targets','pve_defenders','treasures','quest_objectives','quest_effects','constants','research','academy'];
const CHANGES = {buildings:{}, building_levels:{}, units:{}, unit_traits:{}, mercenaries:{}, merc_camp:{}, trade_center:{}, kingdom_services:{}, pve_targets:{}, pve_defenders:{}, treasures:{}, quest_objectives:{}, quest_effects:{}, constants:{}, research:{}, academy:{}};
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
  if (table === 'constants' && typeof REP_ROWS !== 'undefined') {
    var repKeys = {}; for (var ri=0;ri<REP_ROWS.length;ri++) repKeys[REP_ROWS[ri][0]] = true;
    var foundingKeys = {}; for (var fi=0;fi<FOUND_ROWS.length;fi++) foundingKeys[FOUND_ROWS[fi][0]] = true;
    var kingdomKeys = {}; for (var ki=0;ki<KINGDOM_ROWS.length;ki++) kingdomKeys[KINGDOM_ROWS[ki][0]] = true;
    var m8Keys = {}; for (var mi=0;mi<M8_ROWS.length;mi++) m8Keys[M8_ROWS[mi][0]] = true;
    var terrainKeys = {}; for (var ti=0;ti<TERRAIN_ROWS.length;ti++) terrainKeys[TERRAIN_ROWS[ti][0]] = true;
    var cityStateKeys = {}; for (var ci=0;ci<CITY_STATE_ROWS.length;ci++) cityStateKeys[CITY_STATE_ROWS[ci][0]] = true;
    rows = rows.filter(function(r){ return !repKeys[r.key] && !foundingKeys[r.key] && !kingdomKeys[r.key] && !m8Keys[r.key] && !terrainKeys[r.key] && !cityStateKeys[r.key] && r.key !== 'cavalry_unit_codes' && r.key !== 'alchemy_refine_sec' && r.key !== 'ambush_attack_bonus'; });
  } else if (table === 'constants') {
    var foundingKeysOnly = {}; for (var fj=0;fj<FOUND_ROWS.length;fj++) foundingKeysOnly[FOUND_ROWS[fj][0]] = true;
    var m8KeysOnly = {}; for (var mj=0;mj<M8_ROWS.length;mj++) m8KeysOnly[M8_ROWS[mj][0]] = true;
    var terrainKeysOnly = {}; for (var tj=0;tj<TERRAIN_ROWS.length;tj++) terrainKeysOnly[TERRAIN_ROWS[tj][0]] = true;
    var cityStateKeysOnly = {}; for (var cj=0;cj<CITY_STATE_ROWS.length;cj++) cityStateKeysOnly[CITY_STATE_ROWS[cj][0]] = true;
    rows = rows.filter(function(r){ return !foundingKeysOnly[r.key] && !m8KeysOnly[r.key] && !terrainKeysOnly[r.key] && !cityStateKeysOnly[r.key] && r.key !== 'cavalry_unit_codes' && r.key !== 'alchemy_refine_sec' && r.key !== 'ambush_attack_bonus'; });
  }
  var fields = meta.numericByType ? ['value'] : (meta.numeric || []).concat(meta.text || []);
  var TITLES = { buildings:'建筑 / 资源田', units:'兵种', unit_traits:'兵种特性', mercenaries:'雇佣兵', merc_camp:'雇佣兵营地刷新', trade_center:'贸易中心逐级参数', kingdom_services:'议会厅王国服务', pve_targets:'PvE目标与王国地标', pve_defenders:'PvE与王国地标守军', treasures:'宝物目录', quest_objectives:'任务目标', quest_effects:'任务效果', constants:'全局常量', research:'科技目录', academy:'学院RP参数' };
  var title = TITLES[table] || table;
  var keyLabel = meta.key || (meta.keyComposite || []).join('|');
  var h = '<div class="hint">主键 ' + esc(keyLabel) + ' · 可编辑字段: ' + esc(fields.join(', ')) + '</div>';
  h += '<table class="bt"><thead><tr>';
  for (var i=0;i<meta.labels.length;i++) h += '<th>'+esc(meta.labels[i])+'</th>';
  for (var j=0;j<fields.length;j++) h += '<th>'+esc(fields[j])+'</th>';
  h += '</tr></thead><tbody>';
  for (var k=0;k<rows.length;k++){
    var row = rows[k];
    var key = meta.key ? row[meta.key] : (meta.keyComposite || []).map(function(col){ return row[col] || ''; }).join('|');
    h += '<tr>';
    for (var a=0;a<meta.labels.length;a++) h += '<td class="lbl">'+esc(row[meta.labels[a]])+'</td>';
    for (var b=0;b<fields.length;b++){
      var f = fields[b];
      var val = row[f]==null?'':row[f];
      var isText = (meta.text || []).indexOf(f) >= 0;
      h += '<td><input type="'+(isText ? 'text' : 'number')+'" step="any" value="'+esc(val)+'" data-t="'+esc(table)+'" data-k="'+esc(key)+'" data-f="'+esc(f)+'" oninput="onEdit(this)"></td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>'+title+'</h2>'+h+'</div>';
}

// ── 声望专用视图：把行为、门槛和城镇/PvE效果集中展示，避免在庞大的全局常量表中遗漏。 ──
var REP_ROWS = [
  ['reputation_s4_release_delta','S4释放娜塔莉们','选择释放时的声望值变化'],
  ['reputation_good_pvp_target_threshold','正声望攻击目标门槛','目标声望必须严格小于负门槛'],
  ['reputation_good_pvp_reward','正声望击杀奖励','每消灭十点敌方士兵人口增加的声望值'],
  ['reputation_evil_pvp_target_threshold','负声望攻击目标门槛','目标声望必须严格大于门槛'],
  ['reputation_evil_pvp_reward','负声望击杀奖励','每消灭十点敌方士兵人口增加的负声望绝对值'],
  ['kingdom_task_tribute_weight','上贡任务声望权重','影响可获得上贡声望奖励的任务抽取概率'],
  ['kingdom_task_clear_pve_weight','清理PvE任务声望权重','影响可获得清理PvE声望奖励的任务抽取概率'],
  ['kingdom_task_attack_evil_weight','攻打负声望任务权重','影响可获得攻打玩家声望奖励的任务抽取概率'],
  ['kingdom_task_eliminate_troops_weight','消灭兵力任务权重','影响可获得消灭兵力声望奖励的任务抽取概率'],
  ['kingdom_task_evil_target_threshold','负声望任务目标门槛','王国任务指定玩家时使用的负声望绝对值门槛'],
  ['kingdom_task_tribute_reward_reputation','上贡任务奖励声望','完成并领取上贡任务时增加的声望'],
  ['kingdom_task_clear_pve_reward_reputation','清理PvE任务奖励声望','完成并领取清理PvE任务时增加的声望'],
  ['kingdom_task_attack_evil_reward_reputation','攻打玩家任务奖励声望','完成并领取攻打负声望玩家任务时增加的声望'],
  ['kingdom_task_eliminate_troops_reward_reputation','消灭兵力任务奖励声望','完成并领取消灭兵力任务时增加的声望'],
  ['kingdom_pve_killed_population_per_reputation','王国PvE声望人口阈值','每累计消灭多少王国PvE军队人口扣1点声望；跨战斗累加'],
  ['kingdom_pve_retaliation_chunk','王国PvE报复批次','通过人口累计扣分每达到此数量时检查一次主城报复'],
  ['kingdom_pve_retaliation_raid_threshold','封地掠夺声望阈值','玩家声望小于等于此值时，主城对应封地派雇佣军掠夺'],
  ['kingdom_pve_retaliation_siege_threshold','封地攻城声望阈值','玩家声望小于等于此值时，将封地报复升级为攻城'],
  ['kingdom_fief_mercenary_min_ratio','封地雇佣军比例下限','声望触发报复时，雇佣军占封地守军总人口的比例下限'],
  ['kingdom_fief_mercenary_max_ratio','封地雇佣军比例上限','声望触发报复时，雇佣军占封地守军总人口的比例上限'],
  ['kingdom_city_state_reputation_penalty','旧版城邦固定扣分（弃用）','仅兼容旧配置，不再参与声望结算'],
  ['reputation_good_pop_growth_per_point','正声望人口增长/点','每点正声望带来的人口增长倍率'],
  ['reputation_good_pop_growth_cap','正声望人口增长上限','正声望人口增长倍率上限'],
  ['reputation_evil_pop_growth_penalty_per_point','负声望人口下降/点','每点负声望带来的人口增长下降倍率'],
  ['reputation_evil_pop_growth_penalty_cap','负声望人口下降上限','负声望人口增长下降倍率上限'],
  ['reputation_evil_army_attack_per_point','负声望军队攻击/点','每点负声望带来的军队攻击倍率加成'],
  ['reputation_evil_army_attack_cap','负声望军队攻击上限','负声望军队攻击倍率加成上限'],
  ['reputation_evil_army_defense_per_point','负声望军队防御/点','每点负声望带来的军队防御倍率加成'],
  ['reputation_evil_army_defense_cap','负声望军队防御上限','负声望军队防御倍率加成上限'],
  ['reputation_good_gold_tax_penalty_per_point','正声望税收下降/点','每点正声望带来的金币税收下降倍率'],
  ['reputation_good_gold_tax_penalty_cap','正声望税收下降上限','正声望金币税收下降倍率上限'],
  ['reputation_evil_pve_drop_rate_per_point','负声望PvE掉宝/点','每点负声望带来的PvE宝物掉落概率倍率'],
  ['reputation_evil_pve_drop_rate_cap','负声望PvE掉宝上限','负声望PvE宝物掉落概率倍率上限'],
];

var KINGDOM_ROWS = [
  ['kingdom_fief_offset_ratio','封地位置偏移比例','王都在中心 四封地按世界宽高比例偏移'],
  ['kingdom_task_initial_min_sec','首次任务最短等待','注册或首次进入系统后的秒数'],
  ['kingdom_task_initial_max_sec','首次任务最长等待','与最短值之间随机'],
  ['kingdom_task_interval_min_sec','循环最短间隔','领取或失败后下一任务的最短等待'],
  ['kingdom_task_interval_max_sec','循环最长间隔','领取或失败后下一任务的最长等待'],
  ['kingdom_task_duration_sec','任务有效期','超时失败且无惩罚'],
  ['kingdom_task_tribute_amount_min','上贡最小数量','随机资源需求下限'],
  ['kingdom_task_tribute_amount_max','上贡最大数量','随机资源需求上限'],
  ['kingdom_task_eliminate_troops_min','消灭兵力最小值','累计实际战损人数'],
  ['kingdom_task_eliminate_troops_max','消灭兵力最大值','累计实际战损人数'],
];

// ── M8 专用视图：避免在长的全局常量表里漏看任务村攻城倒计时。 ──
var M8_ROWS = [
  ['m8_attack_delay_sec','M8 攻城倒计时（秒）','接受 M8 后天王老子村等待多久再向玩家主城发动全军攻城；默认 28800 秒（8 小时）'],
];

function sectionM8(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">M8「冤家路窄」的任务村与攻城调度参数集中在此。修改倒计时后，新接取的 M8 立即使用新值；已生成任务村的既有倒计时不会被重新计算。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<M8_ROWS.length;j++){
    var item = M8_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" min="1" step="1" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>M8 任务村参数</h2>'+h+'</div>';
}

// ── 地图地形专用视图：不再让森林/丘陵规则埋在全局常量长表中。 ──
var TERRAIN_ROWS = [
  ['forest_vision_penalty','森林方向视野衰减','军队位于森林或朝森林方向观察时减少的视野格数'],
  ['hills_vision_bonus','丘陵视野加成','军队位于丘陵格时额外增加的视野格数'],
  ['hills_march_speed_multiplier','丘陵行军速度倍率','经过丘陵格的路径段速度倍率；0.6666666667 表示速度降低三分之一'],
];
function sectionTerrain(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">地图地貌由世界种子生成：森林会按方向降低视野，丘陵会增加驻军视野但降低经过该格的行军速度；拓荒只允许平原。修改后保存会写回 game_constants.csv 并热重载。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<TERRAIN_ROWS.length;j++){
    var item = TERRAIN_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" min="0" step="any" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>地图格子特性 / 地形参数</h2>'+h+'</div>';
}

// ── 军队规模专用视图：规模减速参数写入 game_constants.csv，影响新派出的行军。 ──
var MARCH_SIZE_ROWS = [
  ['march_size_reference_pop','规模免惩罚人口基准','有效军队人口不超过此值时不降低行军速度'],
  ['march_size_penalty','规模减速系数','超出基准人口后按 1/(1+系数×超出人口) 计算速度倍率'],
  ['march_size_min_multiplier','规模减速最低速度比例','规模减速倍率的下限，避免大军完全失去机动能力'],
];
function sectionMarchSize(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">军队有效人口按实际携带部队的数量 × units.csv 的 popCost 计算；先应用兵种/科技/全局/地形速度，再对每个路径段统一应用规模减速。商队固定速度不受影响；已在途行军不会因热重载改变原定时间。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<MARCH_SIZE_ROWS.length;j++){
    var item = MARCH_SIZE_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    var min = item[0] === 'march_size_min_multiplier' ? '0.0001' : '0';
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" min="'+min+'" step="any" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>军队规模行军参数</h2>'+h+'</div>';
}

// ── 骑兵分类专用视图：猎马人任务与绞马索效果共用该配置。 ──
function sectionCavalry(){
  var rows = DATA.constants || [], row = null;
  for (var i=0;i<rows.length;i++) if (rows[i].key === 'cavalry_unit_codes') { row = rows[i]; break; }
  if (!row) return '';
  var value = row.value == null ? '' : row.value;
  var h = '<div class="hint">以 | 分隔兵种 code。猎马人累计击杀和绞马索的敌方骑兵判定均读取此列表；保存后只影响新结算/新事件，不改变历史战报。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  h += '<tr><td class="lbl">骑兵兵种代码 <small style="color:#7a86a8">(cavalry_unit_codes)</small></td>';
  h += '<td><input type="text" value="'+esc(value)+'" data-t="constants" data-k="cavalry_unit_codes" data-f="value" oninput="onEdit(this)"></td>';
  h += '<td class="lbl">多个兵种代码用 | 分隔</td></tr></tbody></table>';
  return '<div class="sec"><h2>骑兵分类参数</h2>'+h+'</div>';
}

// ── 猎马人专用视图：目标数量与绞马索效果分别写回任务/宝物 CSV。 ──
// 这两个值不是运行时常量，配置中心直接编辑其声明式任务图和宝物目录，避免出现第二份事实源。
function sectionHorseHunter(){
  var objectives = DATA.quest_objectives || [], treasures = DATA.treasures || [];
  var objective = null, rope = null;
  for (var i=0;i<objectives.length;i++) if (String(objectives[i].id) === 'o-s5') { objective = objectives[i]; break; }
  for (var j=0;j<treasures.length;j++) if (String(treasures[j].code) === 'horse_rope') { rope = treasures[j]; break; }
  if (!objective && !rope) return '';

  var target = '';
  if (objective) {
    var parts = String(objective.params == null ? '' : objective.params).split(':');
    target = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }
  var reduction = rope && rope.effectValue != null ? rope.effectValue : '';
  var h = '<div class="hint">猎马人的可调数值集中在此。保存时分别写回 quest_objectives.csv 与 treasures.csv，并经过完整任务图/宝物配置校验；骑兵分类仍由上方 cavalry_unit_codes 控制。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  if (objective) {
    h += '<tr><td class="lbl">猎马人累计击杀人口 <small style="color:#7a86a8">(o-s5 / quest_objectives.params)</small></td>';
    h += '<td><input type="number" min="1" step="1" value="'+esc(target)+'" data-t="quest_objectives" data-k="o-s5" data-f="params" oninput="onHorseHunterTargetEdit(this)"></td>';
    h += '<td class="lbl">按 cavalry:&lt;数量&gt; 保存；实际进度按骑兵 popCost 累计</td></tr>';
  }
  if (rope) {
    h += '<tr><td class="lbl">绞马索骑兵防御削弱 <small style="color:#7a86a8">(horse_rope / effectValue)</small></td>';
    h += '<td><input type="number" min="0" step="any" value="'+esc(reduction)+'" data-t="treasures" data-k="'+esc(String(rope.id))+'" data-f="effectValue" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">百分比数值；30 表示敌方骑兵防御力降低 30%</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>猎马人 / 绞马索参数</h2>'+h+'</div>';
}

function onHorseHunterTargetEdit(el){
  var v = String(el.value == null ? '' : el.value).trim();
  var edits = CHANGES.quest_objectives['o-s5'];
  if (v === '') {
    if (edits) {
      delete edits.params;
      if (Object.keys(edits).length === 0) delete CHANGES.quest_objectives['o-s5'];
    }
  } else {
    if (!edits) edits = CHANGES.quest_objectives['o-s5'] = {};
    edits.params = 'cavalry:' + v;
  }
  status('已修改「quest_objectives / o-s5 / 目标人口」，记得点保存');
}

// ── 王国城邦专用视图：等级、种族、兵种和资源规则集中展示。 ──
var CITY_STATE_ROWS = [
  ['kingdom_city_state_count','地图城邦数量','每张地图随机生成的城邦数量'],
  ['kingdom_city_state_generation_version','城邦生成规则版本','提升版本后启动时按新规则重生成既有城邦'],
  ['kingdom_city_state_tier_weights','城邦等级权重','格式为 1:权重|2:权重|3:权重'],
  ['kingdom_city_state_tribe_pool','随机种族池','格式为 romans|gauls|teutons'],
  ['kingdom_city_state_resource_min','旧版资源下限','兼容旧存档/旧配置；新生成城邦使用下方三级资源范围'],
  ['kingdom_city_state_resource_max','旧版资源上限','兼容旧存档/旧配置；新生成城邦使用下方三级资源范围'],
  ['kingdom_city_state_gold_min','旧版金币下限','兼容旧存档/旧配置；新生成城邦使用下方三级金币范围'],
  ['kingdom_city_state_gold_max','旧版金币上限','兼容旧存档/旧配置；新生成城邦使用下方三级金币范围'],
  ['kingdom_city_state_troops_per_resource','旧版资源折算兵力','兼容旧存档/旧配置；新生成城邦按等级每种兵数量生成'],
  ['kingdom_city_state_troop_min','旧版总兵力下限','兼容旧存档/旧配置；新生成城邦使用下方三级每种兵范围'],
  ['kingdom_city_state_troop_max','旧版总兵力上限','兼容旧存档/旧配置；新生成城邦使用下方三级每种兵范围'],
  ['kingdom_city_state_scout_ratio','旧版侦察兵比例','兼容旧存档/旧配置；新生成城邦按种族兵种池随机抽取侦察兵'],
  ['kingdom_city_state_unit_pool','旧版通用兵种池','兼容旧存档/旧配置；新生成城邦使用下方三种族兵种池'],
  ['kingdom_city_state_unit_pool_romans','罗马兵种池','只从罗马兵种池中抽取'],
  ['kingdom_city_state_unit_pool_gauls','高卢兵种池','只从高卢兵种池中抽取'],
  ['kingdom_city_state_unit_pool_teutons','条顿兵种池','只从条顿兵种池中抽取'],
  ['kingdom_city_state_tier1_unit_count','一级随机兵种数','默认 3 种'],
  ['kingdom_city_state_tier1_unit_min','一级每种兵最少','默认 0'],
  ['kingdom_city_state_tier1_unit_max','一级每种兵最多','默认 20'],
  ['kingdom_city_state_tier1_resource_min','一级资源最少','四类资源各自随机下限；少量资源'],
  ['kingdom_city_state_tier1_resource_max','一级资源最多','四类资源各自随机上限；少量资源'],
  ['kingdom_city_state_tier1_gold_min','一级金币最少','金币随机下限'],
  ['kingdom_city_state_tier1_gold_max','一级金币最多','金币随机上限'],
  ['kingdom_city_state_tier2_unit_count','二级随机兵种数','默认 4 种'],
  ['kingdom_city_state_tier2_unit_min','二级每种兵最少','默认 5'],
  ['kingdom_city_state_tier2_unit_max','二级每种兵最多','默认 35'],
  ['kingdom_city_state_tier2_resource_min','二级资源最少','四类资源各自随机下限；中量资源'],
  ['kingdom_city_state_tier2_resource_max','二级资源最多','四类资源各自随机上限；中量资源'],
  ['kingdom_city_state_tier2_gold_min','二级金币最少','金币随机下限'],
  ['kingdom_city_state_tier2_gold_max','二级金币最多','金币随机上限'],
  ['kingdom_city_state_tier3_unit_count','三级随机兵种数','默认 5 种'],
  ['kingdom_city_state_tier3_unit_min','三级每种兵最少','默认 10'],
  ['kingdom_city_state_tier3_unit_max','三级每种兵最多','默认 50'],
  ['kingdom_city_state_tier3_resource_min','三级资源最少','四类资源各自随机下限；大量资源'],
  ['kingdom_city_state_tier3_resource_max','三级资源最多','四类资源各自随机上限；大量资源'],
  ['kingdom_city_state_tier3_gold_min','三级金币最少','金币随机下限'],
  ['kingdom_city_state_tier3_gold_max','三级金币最多','金币随机上限'],
  ['kingdom_city_state_raid_defense_min_ratio','掠夺防守比例下限','城邦随机分配用于防守掠夺的兵力比例'],
  ['kingdom_city_state_raid_defense_max_ratio','掠夺防守比例上限','城邦随机分配用于防守掠夺的兵力比例'],
  ['kingdom_city_state_recovery_min_sec','兵力恢复最短秒数','默认 43200 秒（12 小时）'],
  ['kingdom_city_state_recovery_max_sec','兵力恢复最长秒数','默认 172800 秒（48 小时）'],
  ['kingdom_city_state_recovery_resource_extra_sec','资源恢复额外秒数','资源比兵力恢复再多 21600 秒（6 小时）'],
  ['kingdom_fief_unit_count','封地随机兵种数','四个领主封地统一标准；从对应种族兵种池随机抽取'],
  ['kingdom_fief_unit_min','封地每种兵最少','封地每种随机兵种的数量下限'],
  ['kingdom_fief_unit_max','封地每种兵最多','封地每种随机兵种的数量上限'],
  ['kingdom_fief_resource_min','封地资源下限','封地四类资源各自随机下限'],
  ['kingdom_fief_resource_max','封地资源上限','封地四类资源各自随机上限'],
  ['kingdom_fief_gold_min','封地金币下限','封地金币随机下限'],
  ['kingdom_fief_gold_max','封地金币上限','封地金币随机上限'],
  ['kingdom_capital_unit_count','王都随机兵种数','王都从对应种族兵种池随机抽取的兵种数量'],
  ['kingdom_capital_unit_min','王都每种兵最少','王都每种随机兵种的数量下限'],
  ['kingdom_capital_unit_max','王都每种兵最多','王都每种随机兵种的数量上限'],
  ['kingdom_capital_resource_min','王都资源下限','王都四类资源各自随机下限'],
  ['kingdom_capital_resource_max','王都资源上限','王都四类资源各自随机上限'],
  ['kingdom_capital_gold_min','王都金币下限','王都金币随机下限'],
  ['kingdom_capital_gold_max','王都金币上限','王都金币随机上限'],
  ['kingdom_city_state_resource_field_level','资源田保底等级','四种城外资源田至少达到此等级'],
  ['kingdom_city_state_inner_building_count_min','城内建筑最少数','随机城内建筑数量下限'],
  ['kingdom_city_state_inner_building_count_max','城内建筑最多数','随机城内建筑数量上限'],
  ['kingdom_city_state_outer_building_count_min','城外建筑最少数','随机城外建筑数量下限（至少四座资源田）'],
  ['kingdom_city_state_outer_building_count_max','城外建筑最多数','随机城外建筑数量上限'],
  ['kingdom_city_state_building_level_min','随机建筑最低等级','非资源田保底建筑的随机等级下限'],
  ['kingdom_city_state_building_level_max','随机建筑最高等级','非资源田保底建筑的随机等级上限'],
  ['kingdom_city_state_inner_building_pool','城内建筑池','格式为 warehouse|granary|barracks…'],
  ['kingdom_city_state_outer_building_pool','城外建筑池','格式为 woodcutter|claypit|ironmine…'],
];
var CITY_STATE_STRING_KEYS = { kingdom_city_state_tier_weights: true, kingdom_city_state_tribe_pool: true, kingdom_city_state_unit_pool: true, kingdom_city_state_unit_pool_romans: true, kingdom_city_state_unit_pool_gauls: true, kingdom_city_state_unit_pool_teutons: true, kingdom_city_state_inner_building_pool: true, kingdom_city_state_outer_building_pool: true };
function sectionCityState(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">城邦按等级随机生成：一级 3 种兵、每种 0–20；二级 4 种兵、每种 5–35；三级 5 种兵、每种 10–50。每座城邦随机选择罗马/高卢/条顿之一，并只抽取该种族兵种池。侦察可选择“资源与守军”或“城内外建筑”两种模式。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<CITY_STATE_ROWS.length;j++){
    var item = CITY_STATE_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    var textInput = !!CITY_STATE_STRING_KEYS[item[0]];
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="'+(textInput ? 'text' : 'number')+'" '+(textInput ? '' : 'min="0" step="any" ')+'value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>王国城邦参数（三级/三种族） · 王国 PvE（城邦/封地/王都）</h2>'+h+'</div>';
}

function sectionKingdom(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">王国任务调度、权重、目标范围和声望奖励集中在此；议会厅商品、王国地标守军与掉落分别见下方独立表。所有保存均写回 CSV 并热重载，无需刷档。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<KINGDOM_ROWS.length;j++){
    var item = KINGDOM_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" step="any" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>王国任务参数</h2>'+h+'</div>';
}

// ── 拓荒专用视图：把开城包的真实成本集中展示，避免在全局常量长表中漏看。 ──
// 每个键仍然写入同一张 game_constants.csv；保存后 CSV 会被镜像到共享配置并进入配置同步队列。
var FOUND_ROWS = [
  ['found_resource_cost_base','第2座城每种资源成本','木材、泥土、钢、粮食各需多少；第2座城（N=2）使用此值'],
  ['found_resource_cost_growth','后续城成本增长倍率','第N座城每种资源 = base × growth^(N-2)，按最终结果四舍五入'],
  ['found_settler_count','所需拓荒者数量','每名拓荒者占用5人口；成功建城后由出发城转移'],
  ['found_min_main_level','出发城主基地最低等级','达到此等级后才允许发起拓荒'],
];
function sectionFounding(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">拓荒开城包按每种资源分别计算：第 N 座城（N≥2）每种资源需要 round(base × growth^(N-2))。因此当前默认第2座城为木材/泥土/钢/粮食各 3000（合计 12000），第3座城各 6000（合计 24000）。修改后保存会校验并写回 CSV、镜像共享配置并排队创建配置 PR；删档和后续部署都会沿用。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<FOUND_ROWS.length;j++){
    var item = FOUND_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" min="0" step="any" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  return '<div class="sec"><h2>拓荒参数</h2>'+h+'</div>';
}

// 声望相关的行级配置也在此处编辑，避免管理员还要在任务/宝物/议会厅表之间来回查找。
function reputationCsvTable(table, title, rows, labels, fields, filter, inputType){
  var selected = (rows || []).filter(filter || function(){ return true; });
  if (!selected.length) return '';
  var type = inputType || 'number';
  var h = '<h3 style="margin:12px 0 6px;color:#8ed5ff;font-size:12px">'+esc(title)+'</h3>';
  h += '<table class="bt"><thead><tr>';
  for (var i=0;i<labels.length;i++) h += '<th>'+esc(labels[i])+'</th>';
  for (var j=0;j<fields.length;j++) h += '<th>'+esc(fields[j][1])+'</th>';
  h += '</tr></thead><tbody>';
  for (var k=0;k<selected.length;k++){
    var row = selected[k], key = row.id == null ? '' : String(row.id);
    h += '<tr>';
    for (var a=0;a<labels.length;a++) h += '<td class="lbl">'+esc(row[labels[a]])+'</td>';
    for (var b=0;b<fields.length;b++){
      var field = fields[b][0], value = row[field] == null ? '' : row[field];
      h += '<td><input type="'+type+'" '+(type === 'number' ? 'step="any" ' : '')+'value="'+esc(value)+'" data-t="'+esc(table)+'" data-k="'+esc(key)+'" data-f="'+esc(field)+'" oninput="onEdit(this)"></td>';
    }
    h += '</tr>';
  }
  return h+'</tbody></table>';
}

function sectionReputation(){
  var rows = DATA.constants || [], byKey = {};
  for (var i=0;i<rows.length;i++) byKey[rows[i].key] = rows[i];
  var h = '<div class="hint">正声望为正数、负声望为负数、初始声望值为 0。所有会增加/扣除声望、以声望作为门槛或由声望派生效果的全局参数均集中在此：PvP、王国任务、王国 PvE 击杀累计、封地报复、人口增长、军队攻防、金币税收和 PvE 宝物掉落。任务中的声望目标/效果、宝物被动声望和议会厅声望价格也在本板块直接编辑；保存后分别写回对应 CSV。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  for (var j=0;j<REP_ROWS.length;j++){
    var item = REP_ROWS[j], row = byKey[item[0]] || {}, value = row.value == null ? '' : row.value;
    h += '<tr><td class="lbl">'+esc(item[1])+' <small style="color:#7a86a8">('+esc(item[0])+')</small></td>';
    h += '<td><input type="number" step="any" value="'+esc(value)+'" data-t="constants" data-k="'+esc(item[0])+'" data-f="value" oninput="onEdit(this)"></td>';
    h += '<td class="lbl">'+esc(item[2])+'</td></tr>';
  }
  h += '</tbody></table>';
  h += reputationCsvTable('kingdom_services', '议会厅服务声望价格（kingdom_services.csv）', DATA.kingdom_services, ['id','code','name','category'], [['reputationCost','声望价格']], null, 'number');
  h += reputationCsvTable('treasures', '宝物被动声望（treasures.csv）', DATA.treasures, ['id','code','name','effectType','applyType'], [['reputationValue','主宝物栏声望修正']], null, 'number');
  h += reputationCsvTable('treasures', '直接声望宝物效果（treasures.csv）', DATA.treasures, ['id','code','name','effectType','applyType'], [['effectValue','声望效果值']], function(row){ return row.effectType === 'reputation'; }, 'number');
  h += reputationCsvTable('quest_objectives', '任务声望目标（quest_objectives.csv）', DATA.quest_objectives, ['id','questCode','phase','kind','order'], [['params','声望阈值']], function(row){ return row.kind === 'reputation_at_most'; }, 'number');
  h += reputationCsvTable('quest_effects', '任务声望调整（quest_effects.csv）', DATA.quest_effects, ['id','questCode','phase','kind','order'], [['params','声望变化值']], function(row){ return row.kind === 'adjust_reputation'; }, 'number');
  h += reputationCsvTable('quest_effects', '正声望兑换佣兵（quest_effects.csv）', DATA.quest_effects, ['id','questCode','phase','kind','order'], [['params','兑换参数（兵种:每点数量）']], function(row){ return row.kind === 'grant_mercenaries_by_positive_reputation'; }, 'text');
  return '<div class="sec"><h2>声望参数</h2>'+h+'</div>';
}

// ── 伏击专用视图：与普通战斗常量分开，便于调试伏击强度。 ──
function sectionAmbush(){
  var rows = DATA.constants || [], row = null;
  for (var i=0;i<rows.length;i++) if (rows[i].key === 'ambush_attack_bonus') { row = rows[i]; break; }
  var value = row && row.value != null ? row.value : '';
  var h = '<div class="hint">伏击军抵达空地后进入隐蔽驻扎；敌方军队进入一格内触发伏击战。该攻击加成只作用于伏击方，不影响行军中的普通野战。</div>';
  h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
  h += '<tr><td class="lbl">伏击攻击加成 <small style="color:#7a86a8">(ambush_attack_bonus)</small></td>';
  h += '<td><input type="number" min="0" step="0.01" value="'+esc(value)+'" data-t="constants" data-k="ambush_attack_bonus" data-f="value" oninput="onEdit(this)"></td>';
  h += '<td class="lbl">0.5 表示 +50%；仅伏击战攻击方生效</td></tr></tbody></table>';
  return '<div class="sec"><h2>伏击参数</h2>'+h+'</div>';
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
    if (code === 'treasury') c.push({k:'treasureSlots',l:'每级主/备用槽'});
    if (code === 'tavern') {
      c.push({k:'taskRefreshSec',l:'任务刷新秒'});
      c.push({k:'taskMaxTasks',l:'任务槽数'});
      c.push({k:'taskSideQuestChance',l:'支线概率'});
    }
    if (code === 'vault') {
      c.push({k:'vaultProtectWood',l:'保木材/级'});
      c.push({k:'vaultProtectClay',l:'保泥土/级'});
      c.push({k:'vaultProtectIron',l:'保钢铁/级'});
      c.push({k:'vaultProtectCrop',l:'保粮食/级'});
      c.push({k:'vaultProtectGold',l:'保金币/级'});
    }
    if (code === 'warehouse' || code === 'granary') c.push({k:'storagePerLevel',l:'+容量'});
    if (code === 'wall') c.push({k:'defensePerLevel',l:'+防御'});
    if (code === 'main') c.push({k:'buildSpeedupPerLevel',l:'-建造耗时'});
    if (code === 'barracks' || code === 'stable' || code === 'workshop') {
      c.push({k:'trainTimeReducePerLevel',l:'-训练耗时'});
      c.push({k:'trainCostReducePerLevel',l:'-训练花费'});
    }
    return c;
  }
  var bFields = ['maxLevel','maxCount','mainBaseLevel','prosperityPerLevel','popGrowthPerLevel'];
  var bLabels = ['最高等级','每村最多建造(-1不限)','所需主基地级','繁荣/级','人口增长/级·时'];
  var h = '<div class="hint">配置中心的每栋建筑独立卡片——建筑属性(顶部) + 通用逐级参数 + 建筑专属奖励列 + 贸易中心/雇佣兵营地/炼金炉功能参数(如有)。宝库的「每级主/备用槽」可直接修改；保险库的五种「每级保护量」会逐级累加并在攻城拆建筑后重新计算。保存会校验并写回 CSV、镜像到共享配置并排队创建配置 PR；GM 实时状态和删档不会改变这些默认值。</div>';
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
    if (code === 'alchemy'){
      var constRows = DATA.constants || [], refineRow = null;
      for (var cr=0;cr<constRows.length;cr++) if (constRows[cr].key === 'alchemy_refine_sec') { refineRow = constRows[cr]; break; }
      var refineValue = refineRow && refineRow.value != null ? refineRow.value : '';
      h += '<div style="margin-top:8px"><span style="color:#f0b070;font-size:12px">炼金炉功能参数（合并在升级消耗栏）</span>';
      h += '<table class="bt"><thead><tr><th>参数</th><th>当前值</th><th>说明</th></tr></thead><tbody>';
      h += '<tr><td class="lbl">炼化时间（秒）<small style="color:#7a86a8">(alchemy_refine_sec)</small></td>';
      h += '<td><input type="number" min="1" step="1" value="'+esc(refineValue)+'" data-t="constants" data-k="alchemy_refine_sec" data-f="value" oninput="onEdit(this)"></td>';
      h += '<td class="lbl">三个同品质宝物炼化所需时间；修改后新炼化立即使用</td></tr>';
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
  html += sectionFounding();
  html += sectionReputation();
  html += sectionTerrain();
  html += sectionMarchSize();
  html += sectionCavalry();
  html += sectionHorseHunter();
  html += sectionCityState();
  html += sectionKingdom();
  html += sectionM8();
  html += sectionAmbush();
  for (var i=0;i<TABLES.length;i++){
    var t = TABLES[i];
    if (t === 'buildings' || t === 'building_levels' || t === 'trade_center' || t === 'merc_camp' || t === 'academy' || t === 'quest_objectives' || t === 'quest_effects') continue; // 已在专用视图合并渲染
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
  const requireConfigRoute = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers['x-config-route'] === '1') return true;
    void reply.code(410).send({ ok: false, reason: 'CSV 配置编辑已迁移到 /config；GM 只允许修改实时 JSON 状态' });
    return false;
  };

  // 配置中心与 GM 共用认证，但使用独立 URL 命名空间。兼容旧版书签的 /gm 配置
  // 路由仍保留，GM 首页不再暴露它们；配置页面自身只请求 /config/*。
  const configProxy = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const suffix = req.url.slice('/config'.length) || '/';
    const headers: Record<string, string> = {};
    headers['x-config-route'] = '1';
    const gmToken = req.headers['x-gm-token'];
    if (typeof gmToken === 'string') headers['x-gm-token'] = gmToken;
    const result = await fastify.inject({
      method: req.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: `/gm${suffix}`,
      headers,
      payload: req.body as any,
    } as any) as any;
    reply.code(result.statusCode);
    const contentType = result.headers['content-type'];
    if (typeof contentType === 'string') reply.type(contentType);
    void reply.send(result.body);
  };

  /**
   * GM 面板允许直接编辑 player 文档。村庄坐标同时存在于 Player 快照和
   * World 地图地块中，写入前通过 World owner 命令同步地图，避免行军使用旧坐标。
   */
  const syncPlayerVillageTiles = async (body: unknown): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!body || typeof body !== 'object') return { ok: true };
    const raw = body as Record<string, unknown>;
    const rows = Array.isArray(raw.ownedVillages)
      ? raw.ownedVillages
      : (typeof raw.villageId === 'string' && Number.isFinite(Number(raw.q)) && Number.isFinite(Number(raw.r)))
        ? [{ id: raw.villageId, q: raw.q, r: raw.r, name: raw.name }]
        : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') return { ok: false, reason: 'bad_village_coordinates' };
      const village = row as Record<string, unknown>;
      const refId = typeof village.id === 'string' ? village.id.trim() : '';
      const q = Number(village.q), r = Number(village.r);
      if (!refId || !Number.isFinite(q) || !Number.isFinite(r)) return { ok: false, reason: 'bad_village_coordinates' };
      const moved = await gameApp.commands.send({
        name: 'world.MoveVillage',
        from: 'gm',
        payload: { refId, q, r, name: typeof village.name === 'string' ? village.name : undefined },
      });
      if (!moved.ok) return { ok: false, reason: moved.reason ?? 'village_coordinate_sync_failed' };
    }
    return { ok: true };
  };

  // GET /gm — Web 面板
  fastify.get('/gm', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_PANEL_HTML);
  });

  // 独立配置中心入口与页面。旧编辑器通过 configPage 重写为 /config API。
  fastify.get('/config', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(CONFIG_CENTER_HTML);
  });
  fastify.get('/config/balance', (_req, reply) => void reply.type('text/html; charset=utf-8').send(configPage(GM_BALANCE_HTML)));
  fastify.get('/config/quests', (_req, reply) => void reply.type('text/html; charset=utf-8').send(configPage(GM_QUESTS_HTML)));
  fastify.get('/config/quest-modules', (_req, reply) => void reply.type('text/html; charset=utf-8').send(configPage(GM_QUEST_MODULES_HTML)));
  fastify.get('/config/quest-graph', (_req, reply) => void reply.type('text/html; charset=utf-8').send(configPage(GM_QUEST_GRAPH_HTML)));
  fastify.get('/config/dialogues', (_req, reply) => void reply.type('text/html; charset=utf-8').send(configPage(GM_DIALOGUES_HTML)));
  fastify.get('/config/status', async (req, reply) => {
    if (!auth(req, reply)) return;
    const status = await gameApp.configAuthority.inspectStatus();
    const blocked = status.syncState === 'conflict' || status.syncState === 'error' || Boolean(status.lastStatusError);
    void reply.send({ ok: !blocked, ...status });
  });
  fastify.post('/config/sync', async (req, reply) => {
    if (!auth(req, reply)) return;
    await gameApp.configAuthority.flush();
    const inspected = await gameApp.configAuthority.inspectStatus();
    const blocked = inspected.syncState === 'conflict' || inspected.syncState === 'error' || Boolean(inspected.lastStatusError);
    void reply.send({ ok: !blocked, ...inspected });
  });
  fastify.get('/config/sync/conflicts', async (req, reply) => {
    if (!auth(req, reply)) return;
    try {
      const details = await gameApp.configAuthority.conflictDetails();
      void reply.send({ ok: true, ...details });
    } catch (err) {
      void reply.code(409).send({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.post('/config/sync/resolve', async (req, reply) => {
    if (!auth(req, reply)) return;
    try {
      const body = (req.body ?? {}) as { expectedHeadSha?: string; files?: Array<{ file?: string; content?: string }> };
      const files = (body.files ?? []).map((entry) => ({ file: entry.file ?? '', content: entry.content ?? '' }));
      const status = await gameApp.configAuthority.resolveConflicts({ expectedHeadSha: body.expectedHeadSha, files });
      const inspected = await gameApp.configAuthority.inspectStatus();
      const blocked = inspected.syncState === 'conflict' || inspected.syncState === 'error' || Boolean(inspected.lastStatusError);
      void reply.send({ ok: !blocked, ...inspected });
    } catch (err) {
      void reply.code(409).send({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.all('/config/*', configProxy);

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
  fastify.put('/gm/:collection/:key', async (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection, key } = req.params as { collection: string; key: string };
    const body = req.body;
    if (body === undefined || body === null) {
      void reply.code(400).send({ ok: false, reason: '请求 body 不能为空（发送 JSON 文档）' });
      return;
    }
    if (collection === 'player') {
      const sync = await syncPlayerVillageTiles(body);
      if (!sync.ok) {
        void reply.code(sync.reason === 'tile_occupied' ? 409 : 400).send({ ok: false, reason: sync.reason });
        return;
      }
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
  fastify.post('/gm/ops/reset', async (req, reply) => {
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
    const { accounts } = await gameApp.resetWorld(opts);
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

  // POST /gm/ops/sell-treasure / discard-treasure — GM 测试：出售/丢弃村庄宝物（body: {villageId, code}）
  const treasureDispose = (name: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth(req, reply)) return;
    const { villageId, code } = (req.body ?? {}) as { villageId?: string; code?: string };
    if (!villageId || !code) {
      void reply.code(400).send({ ok: false, reason: 'villageId 与 code 必填' });
      return;
    }
    const res: any = await gameApp.commands.send({ name, from: 'gm', payload: { villageId, code } });
    if (!res.ok) {
      void reply.code(400).send({ ok: false, reason: res.reason ?? 'failed', payload: res.payload });
      return;
    }
    store.flush();
    void reply.send(res);
  };
  fastify.post('/gm/ops/sell-treasure', treasureDispose('treasure.Sell'));
  fastify.post('/gm/ops/discard-treasure', treasureDispose('treasure.Discard'));

  // POST /gm/ops/cancel-scout-encounters — 解除旧版本错误产生的侦察野战并让双方返村
  fastify.post('/gm/ops/cancel-scout-encounters', async (req, reply) => {
    if (!auth(req, reply)) return;
    const res: any = await gameApp.commands.send({ name: 'movement.CancelScoutEncounters', from: 'gm', payload: {} });
    if (!res.ok) {
      void reply.code(400).send({ ok: false, reason: res.reason ?? 'cancel_failed', payload: res.payload });
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
  fastify.post('/gm/ops/task/reopen-completed', (req, reply) => taskOp(req, reply, 'task.GmReopenCompleted', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/retrigger-completed-main', (req, reply) => taskOp(req, reply, 'task.GmRetriggerCompletedMain', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/untrigger-main', (req, reply) => taskOp(req, reply, 'task.GmUntriggerMain', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/retrigger-abandoned', (req, reply) => taskOp(req, reply, 'task.GmRetriggerAbandoned', (b) => ({ villageId: b.villageId, code: b.code })));
  fastify.post('/gm/ops/task/refresh', (req, reply) => taskOp(req, reply, 'task.GmRefreshRandom', (b) => ({ villageId: b.villageId })));
  fastify.post('/gm/ops/task/reset', (req, reply) => taskOp(req, reply, 'task.GmReset', (b) => ({ villageId: b.villageId })));
  fastify.post('/gm/ops/task/reset-all', (req, reply) => taskOp(req, reply, 'task.GmResetAll', () => ({})));

  // GET /gm/tasks — 任务管理 Web 面板
  fastify.get('/gm/tasks', (_req, reply) => {
    void reply.type('text/html; charset=utf-8').send(GM_TASKS_HTML);
  });

  // GET /gm/quests — 任务目录(quests.csv) Web 编辑器
  fastify.get('/gm/quests', (_req, reply) => { void reply.redirect('/config/quests'); });

  // GET /gm/quest-modules — 任务图模块化编辑器。六张表必须作为一个事务校验后才写回。
  fastify.get('/gm/quest-modules', (_req, reply) => { void reply.redirect('/config/quest-modules'); });

  // GET/POST /gm/dialogues — NPC 对话目录编辑器。写回前复制整份 config 到临时目录校验。
  fastify.get('/gm/dialogues', (_req, reply) => { void reply.redirect('/config/dialogues'); });

  fastify.get('/gm/dialogues/data', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const doc = parseCsvStructured(readFileSync(join(gameApp.configDir, 'dialogues.csv'), 'utf-8'));
    const quests = loadCsv(join(gameApp.configDir, 'quests.csv'));
    const ensured = ensureDefaultSideDialogueRows(doc.rows, quests);
    void reply.send({ ok: true, header: doc.header, rows: sortDialogueRows(ensured.rows) });
  });

  fastify.post('/gm/dialogues/save', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const body = (req.body ?? {}) as { rows?: CsvRow[] };
    if (!Array.isArray(body.rows)) {
      void reply.code(400).send({ ok: false, reason: 'rows 必填' });
      return;
    }
    const dir = gameApp.configDir;
    const tmp = mkdtempSync(join(tmpdir(), 'kow-dialogues-'));
    try {
      const doc = parseCsvStructured(readFileSync(join(dir, 'dialogues.csv'), 'utf-8'));
      const previousRows: ConfigRowsSnapshot = {
        'dialogues.csv': doc.rows.map((row) => ({ ...row })),
      };
      // 支持新增/删除行：移除旧数据行、保留表头/注释，再把当前编辑器行追加到文档尾。
      const oldDataIndices = new Set(doc.rowIndices);
      const raw = doc.raw.filter((_, index) => !oldDataIndices.has(index));
      doc.raw = raw;
      doc.headerIndex = raw.findIndex((line) => line.split(',').map((x) => x.trim()).join(',') === doc.header.join(','));
      doc.rows = sortDialogueRows(body.rows.map((row) => Object.fromEntries(doc.header.map((h) => [h, row[h] ?? '']))));
      doc.rowIndices = [];
      for (let i = 0; i < doc.rows.length; i++) {
        doc.raw.push('');
        doc.rowIndices.push(doc.raw.length - 1);
      }
      const csv = serializeCsv(doc);
      cpSync(dir, tmp, { recursive: true });
      writeFileSync(join(tmp, 'dialogues.csv'), csv, 'utf-8');
      loadGameConfig(tmp); // 校验失败不写线上配置
      writeFileSync(join(dir, 'dialogues.csv'), csv, 'utf-8');
      persistConfigFiles(gameApp, ['dialogues.csv'], previousRows);
      gameApp.configAuthority.recordChange(['dialogues.csv']);
      gameApp.reloadConfig();
      void reply.send({ ok: true, count: doc.rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void reply.code(400).send({ ok: false, reason: msg });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  fastify.get('/gm/quest-modules/data', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const dir = gameApp.configDir;
    const tables: Record<string, { header: string[]; rows: CsvRow[] }> = {};
    for (const file of QUEST_MODULE_TABLES) {
      const doc = parseCsvStructured(readFileSync(join(dir, file), 'utf-8'));
      tables[file] = { header: doc.header, rows: doc.rows };
    }
    void reply.send({ ok: true, tables });
  });

  fastify.post('/gm/quest-modules/save', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const body = (req.body ?? {}) as { tables?: Record<string, { rows?: CsvRow[] }> };
    if (!body.tables) {
      void reply.code(400).send({ ok: false, reason: 'tables 必填' });
      return;
    }
    const dir = gameApp.configDir;
    const tmp = mkdtempSync(join(tmpdir(), 'kow-quest-graph-'));
    let dialogueAdded = 0;
    try {
      const previousRows = snapshotConfigRows(dir, [...QUEST_MODULE_TABLES, 'dialogues.csv']);
      const csvByFile: Record<string, string> = {};
      for (const file of QUEST_MODULE_TABLES) {
        const rows = body.tables[file]?.rows;
        if (!Array.isArray(rows)) throw new Error(`${file} 缺少 rows`);
        const doc = parseCsvStructured(readFileSync(join(dir, file), 'utf-8'));
        // 去掉旧数据行、保留表头/注释/空行，再按本次 rows 重建数据行；支持增删行。
        const oldDataIndices = new Set(doc.rowIndices);
        const raw = doc.raw.filter((_, i) => !oldDataIndices.has(i));
        doc.headerIndex = raw.findIndex((line) => line.split(',').map((x) => x.trim()).join(',') === doc.header.join(','));
        doc.raw = raw;
        doc.rows = rows.map((row) => Object.fromEntries(doc.header.map((h) => [h, row[h] ?? ''])));
        doc.rowIndices = [];
        for (let i = 0; i < doc.rows.length; i++) {
          doc.raw.push('');
          doc.rowIndices.push(doc.raw.length - 1);
        }
        csvByFile[file] = serializeCsv(doc);
      }
      cpSync(dir, tmp, { recursive: true });
      for (const file of QUEST_MODULE_TABLES) writeFileSync(join(tmp, file), csvByFile[file], 'utf-8');
      dialogueAdded = ensureSideDialogueTemplatesInDir(tmp).added;
      loadGameConfig(tmp); // 整图校验失败时绝不写入线上 configDir。
      for (const file of QUEST_MODULE_TABLES) writeFileSync(join(dir, file), csvByFile[file], 'utf-8');
      const changedFiles = [...QUEST_MODULE_TABLES, ...(dialogueAdded > 0 ? ['dialogues.csv' as const] : [])];
      if (dialogueAdded > 0) copyFileSync(join(tmp, 'dialogues.csv'), join(dir, 'dialogues.csv'));
      persistConfigFiles(gameApp, changedFiles, previousRows);
      gameApp.configAuthority.recordChange(changedFiles);
      gameApp.reloadConfig();
      void reply.send({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void reply.code(400).send({ ok: false, reason: msg });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // GET /gm/quest-graph — 按任务线/节点/条件/目标/效果/边展示声明式任务图。
  fastify.get('/gm/quest-graph', (_req, reply) => {
    void reply.redirect('/config/quest-graph');
  });

  // GM 只读审查数据：配置仍以 config/quest_*.csv 为唯一事实源，避免线上覆盖漂移。
  fastify.get('/gm/quest-graph/data', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    void reply.send({ ok: true, graph: gameApp.config.questGraph });
  });

  // GET /gm/quests/data — 返回 quests.csv 解析后的行 + 表头（供编辑器渲染）
  fastify.get('/gm/quests/data', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const dir = gameApp.configDir;
    const text = readFileSync(join(dir, 'quests.csv'), 'utf-8');
    const doc = parseCsvStructured(text);
    void reply.send({ ok: true, rows: doc.rows, header: doc.header });
  });

  // POST /gm/quests/save — 写回 quests.csv 并热重载（body: { rows: CsvRow[] }）
  fastify.post('/gm/quests/save', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const body = (req.body ?? {}) as { rows?: Record<string, string>[] };
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      void reply.code(400).send({ ok: false, reason: 'rows 必填且非空' });
      return;
    }
    const dir = gameApp.configDir;
    const tmp = mkdtempSync(join(tmpdir(), 'kow-quests-'));
    let dialogueAdded = 0;
    try {
      const previousRows = snapshotConfigRows(dir, ['quests.csv', 'dialogues.csv']);
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
      dialogueAdded = ensureSideDialogueTemplatesInDir(tmp).added;
      loadGameConfig(tmp); // 校验：失败在此抛出（不落盘）
      writeFileSync(join(dir, 'quests.csv'), csv, 'utf-8');
      const changedFiles = ['quests.csv' as const, ...(dialogueAdded > 0 ? ['dialogues.csv' as const] : [])];
      if (dialogueAdded > 0) copyFileSync(join(tmp, 'dialogues.csv'), join(dir, 'dialogues.csv'));
      persistConfigFiles(gameApp, changedFiles, previousRows);
      gameApp.configAuthority.recordChange(changedFiles);
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
    void reply.redirect('/config/balance');
  });

  // GET /gm/balance/data — 旧路径只保留兼容读取；配置编辑入口已迁移到 /config/balance。
  // 运行时只读取 CSV，不再把 balance_overrides.json 叠加到返回结果。
  fastify.get('/gm/balance/data', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const dir = gameApp.configDir;
    const data: Record<string, unknown> = { meta: BALANCE_TABLES };
    const buildingNames: Record<string, string> = {};
    for (const r of loadCsv(join(dir, 'buildings.csv'))) buildingNames[r.code] = r.name;
    for (const name of Object.keys(BALANCE_TABLES)) {
      let rows = loadCsv(join(dir, BALANCE_TABLES[name].file));
      if (name === 'building_levels') {
        for (const r of rows) {
          r.name = buildingNames[r.code] ?? r.code;
          // 旧版共享 CSV 可能在新增的酒馆专属列留下空值。空值在配置编辑器中
          // 表示“未覆盖”，运行时会回退到 0.5；直接展示空白会误导管理员，
          // 因此这里返回实际运行时默认值，保存时仍允许明确填 0 关闭支线刷新。
          if (r.code === 'tavern' && (r.taskSideQuestChance === undefined || r.taskSideQuestChance.trim() === '')) {
            r.taskSideQuestChance = '0.5';
          }
        }
      }
      data[name] = rows;
    }
    void reply.send({ ok: true, ...data });
  });

  // POST /gm/balance/save — 旧路径兼容入口；正式配置编辑请使用 /config/balance。
  fastify.post('/gm/balance/save', (req, reply) => {
    if (!auth(req, reply)) return;
    if (!requireConfigRoute(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, Record<string, Record<string, string>>>;
    const dir = gameApp.configDir;
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
      const changedFiles = edits.map(([, table]) => table.file);
      const previousRows = snapshotConfigRows(dir, changedFiles);
      // 校验：把本次编辑应用到临时 configDir 副本，跑 loadGameConfig；失败整段回滚。
      const tmp = mkdtempSync(join(tmpdir(), 'kow-balance-'));
      try {
        cpSync(dir, tmp, { recursive: true });
        for (const [, table, changes] of edits) {
          applyBalanceEdits(dir, tmp, table, changes);
        }
        loadGameConfig(tmp); // 失败在此抛出

        // 校验通过后将同一份 CSV 写回当前配置目录并镜像到共享配置目录。
        for (const [, table] of edits) {
          copyFileSync(join(tmp, table.file), join(dir, table.file));
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      persistConfigFiles(gameApp, changedFiles, previousRows);
      gameApp.configAuthority.recordChange(changedFiles);
      // 热重载（内存 + 存量村庄派生值即时生效）
      gameApp.reloadConfig();
      void reply.send({ ok: true, config: gameApp.configAuthority.status() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void reply.code(400).send({ ok: false, reason: msg });
    }
  });
}

const GM_QUEST_MODULES_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>任务模块编辑</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#101722;color:#dce7f7;font:13px ui-monospace,monospace}h1{margin:0 0 6px;color:#65c7ff;font-size:19px}.hint{color:#9bb0c9;margin:0 0 14px;line-height:1.55}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}button{background:#173550;border:1px solid #65c7ff;color:#dce7f7;border-radius:4px;padding:6px 9px;cursor:pointer;font:inherit}.save{border-color:#74d68c;color:#b9f6c8}.danger{border-color:#db7272;color:#ffb6b6}.tab.active{background:#315b7b;color:#fff}#status{color:#f1c575}.table-wrap{overflow:auto;border:1px solid #304c69;max-height:calc(100vh - 180px)}table{border-collapse:collapse;min-width:100%;background:#121d2b}th,td{border:1px solid #29435e;padding:4px;white-space:nowrap}th{position:sticky;top:0;background:#20354c;color:#8ed5ff}input{width:150px;background:#0d1622;border:1px solid #365671;border-radius:2px;color:#e5eef8;padding:4px;font:inherit}td:first-child input{width:70px}.row-actions{min-width:46px}a{color:#79cfff}
</style></head><body>
<h1>任务模块编辑</h1><p class="hint">编辑顺序：任务线 → 任务 → 条件 / 目标 / 效果 → 关系边。六张表会作为一个整体校验：引用不存在的任务、无效目标或循环依赖都会被拒绝。效果参数示例：grant_resources=wood:100|clay:100；grant_population=5；grant_population_growth=10:86400（+10%人口增长24小时）。每行效果的 id 必须唯一，questCode 决定奖励归属任务。<a href="/gm/quest-graph">查看关系图</a></p>
<div class="bar" id="tabs"></div><div class="bar"><button onclick="addRow()">+ 新增行</button><button class="save" onclick="save()">保存全部模块</button><span id="status">加载中…</span></div><div class="table-wrap"><table id="grid"></table></div>
<script>
const TABLES=['quest_lines.csv','quests.csv','quest_conditions.csv','quest_objectives.csv','quest_effects.csv','quest_edges.csv'];let data={},active=TABLES[0],token=sessionStorage.getItem('gmToken')??'';
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(url,opt={}){opt.headers=Object.assign({},opt.headers||{},token?{'X-GM-Token':token}:{},opt.body?{'Content-Type':'application/json'}:{});let r=await fetch(url,opt);if(r.status===401){let x=prompt('GM Token:',token);if(x!==null){token=x.trim();sessionStorage.setItem('gmToken',token);return api(url,opt)}}let j=await r.json();if(!r.ok||!j.ok)throw Error(j.reason||'请求失败');return j}
function tabs(){let el=document.getElementById('tabs');el.innerHTML=TABLES.map(f=>'<button class="tab '+(f===active?'active':'')+'" data-tab="'+esc(f)+'">'+esc(f)+'</button>').join('');for(let b of el.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>selectTab(b.dataset.tab))}
function selectTab(f){active=f;tabs();render()}
function render(){let t=data[active],h=t.header;let html='<thead><tr>'+h.map(x=>'<th>'+esc(x)+'</th>').join('')+'<th>操作</th></tr></thead><tbody>';for(let i=0;i<t.rows.length;i++){html+='<tr>'+h.map(k=>'<td><input data-r="'+i+'" data-k="'+esc(k)+'" value="'+esc(t.rows[i][k])+'" oninput="edit(this)"></td>').join('')+'<td class="row-actions"><button class="danger" onclick="removeRow('+i+')">删除</button></td></tr>'}document.getElementById('grid').innerHTML=html+'</tbody>';document.getElementById('status').textContent=active+'：'+t.rows.length+' 行'}
function edit(el){data[active].rows[Number(el.dataset.r)][el.dataset.k]=el.value}
function addRow(){let r={};for(let h of data[active].header)r[h]='';data[active].rows.push(r);render()}
function removeRow(i){if(confirm('删除这一行？')){data[active].rows.splice(i,1);render()}}
async function save(){try{document.getElementById('status').textContent='整图校验中…';await api('/gm/quest-modules/save',{method:'POST',body:JSON.stringify({tables:data})});document.getElementById('status').textContent='已保存并热重载';}catch(e){document.getElementById('status').textContent='保存失败：'+e.message}}
api('/gm/quest-modules/data').then(x=>{data=x.tables;tabs();render()}).catch(e=>document.getElementById('status').textContent='加载失败：'+e.message);
</script></body></html>`;

const GM_QUEST_GRAPH_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>任务关系图</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#101722;color:#dce7f7;font:13px ui-monospace,monospace}h1{margin:0 0 5px;color:#65c7ff;font-size:19px}.hint{color:#9bb0c9;margin:0 0 16px;line-height:1.6}.line{border:1px solid #33506f;border-radius:8px;margin:12px 0;background:#172333}.line>h2{margin:0;padding:9px 12px;font-size:15px;background:#20354c;color:#8ed5ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:10px;padding:10px}.quest{border:1px solid #304c69;border-radius:6px;padding:9px;background:#121d2b}.quest h3{margin:0 0 5px;color:#fff;font-size:14px}.code{color:#6fc8ff}.desc{color:#b9c7d6;margin:4px 0 8px;line-height:1.45}.section{border-top:1px solid #2a4058;padding-top:6px;margin-top:6px}.label{color:#f2be71}.tag{display:inline-block;margin:2px 4px 2px 0;padding:2px 5px;border-radius:3px;background:#263c54;color:#cfe6ff}.edge{color:#a9db95}.warn{color:#f2be71}.empty{color:#71849a}a{color:#79cfff}#status{color:#9bb0c9}
</style></head><body>
<h1>任务关系图</h1><p class="hint">定义按 <b>任务线 → 任务 → 条件 / 目标 / 效果 → 关系边</b> 拆分。<a href="/gm/quest-modules">打开模块编辑器</a>；每次保存都会整图校验并热重载。</p>
<p id="status">加载中…</p><main id="app"></main>
<script>
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
let token=sessionStorage.getItem('gmToken')??'';
async function load(){let h={};if(token)h['X-GM-Token']=token;let r=await fetch('/gm/quest-graph/data',{headers:h});if(r.status===401){let x=prompt('GM Token:',token);if(x!==null){token=x.trim();sessionStorage.setItem('gmToken',token);return load();}}let d=await r.json();if(!d.ok)throw Error(d.reason||'加载失败');return d.graph;}
function tags(rows,fmt){return rows.length?rows.map(x=>'<span class="tag">'+esc(fmt(x))+'</span>').join(''):'<span class="empty">无</span>';}
function render(g){let out='';let lines=Object.values(g.lines).sort((a,b)=>a.order-b.order);for(let line of lines){let qs=Object.values(g.quests).filter(q=>q.lineCode===line.code).sort((a,b)=>a.id-b.id);out+='<section class="line"><h2>'+esc(line.name)+' <span class="code">'+esc(line.code)+'</span> · 入口 '+esc(line.entryQuest)+'</h2><div class="grid">';for(let q of qs){let cs=g.conditions.filter(x=>x.questCode===q.code);let os=g.objectives.filter(x=>x.questCode===q.code).sort((a,b)=>a.order-b.order);let es=g.effects.filter(x=>x.questCode===q.code).sort((a,b)=>a.order-b.order);let incoming=g.edges.filter(x=>x.toQuest===q.code);let outgoing=g.edges.filter(x=>x.fromQuest===q.code);let hasNatalieStage=es.some(x=>x.kind==='natalie_choice');let effectLabel=hasNatalieStage?'阶段 2 · 选择/效果：':'效果：';out+='<article class="quest"><h3>'+esc(q.name)+' <span class="code">'+esc(q.code)+'</span></h3><div class="desc">'+esc(q.desc)+'</div><div class="section"><span class="label">条件：</span>'+tags(cs,x=>x.phase+' / '+x.kind+':'+x.value)+'</div><div class="section"><span class="label">'+(hasNatalieStage?'阶段 1 · 目标：':'目标：')+'</span>'+tags(os,x=>x.kind+' '+x.params)+'</div><div class="section"><span class="label">'+effectLabel+'</span>'+tags(es,x=>x.kind==='natalie_choice'?'释放 → 领取任务奖励；放入宝库 → 任务失败，仅保留宝物':x.phase+' / '+x.kind+' '+x.params)+'</div><div class="section edge"><span class="label">关系：</span>'+tags(incoming,x=>x.fromQuest+' —'+x.relation+'→ 本任务')+tags(outgoing,x=>'本任务 —'+x.relation+'→ '+x.toQuest)+'</div></article>';}out+='</div></section>';}document.getElementById('app').innerHTML=out;document.getElementById('status').textContent='已加载 '+Object.keys(g.quests).length+' 个任务、'+g.conditions.length+' 个条件、'+g.objectives.length+' 个目标、'+g.effects.length+' 个效果、'+g.edges.length+' 条关系。';}
load().then(render).catch(e=>document.getElementById('status').textContent='加载失败：'+e.message);
</script></body></html>`;

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
  // task.GetState 返回 active 数组（旧版 GM 曾按 Record 遍历，导致数组下标
  // 0/1 被当成任务 code，点击“回退主线”就会收到 unknown_quest）。
  var active=Array.isArray(s.active)?s.active:Object.keys(s.active||{}).map(function(k){var t=s.active[k];return Object.assign({code:k},t);});
  h+='<h2>进行中 ('+active.length+')</h2>';
  for(var ai=0;ai<active.length;ai++){var t=active[ai];var c=String(t.code||'');
    h+='<div class="card" data-code="'+esc(c)+'"><b>'+esc(t.name)+'</b> ['+esc(t.type)+'] code='+esc(c);
    if(t.objective&&t.objective.kind==='submit_resources')h+=' 已交:'+esc(JSON.stringify(t.submitted))+' / 需'+esc(JSON.stringify(t.required));
    if(t.objective&&t.objective.kind==='clear_camp')h+=' 营地'+esc(t.campCleared)+'/'+esc(t.campTotal);
    if(t.objective&&['build_buildings','population_reached','resource_owned','explore_tiles'].indexOf(t.objective.kind)>=0)h+=' 进度'+esc(t.progress||0)+'/'+esc(t.objective.count||0);
    if(t.awaitingNatalieDecision)h+=' <div>当前阶段：2/2 · 等待报告中选择「释放」或「放入宝库」</div>';
    else if(t.natalieDecision==='release')h+=' <div>当前阶段：2/2 · 已释放，等待领取任务奖励</div>';
    h+=' <button class="act" data-act="complete" data-code="'+esc(c)+'">完成</button>';
    if(t.type==='main')h+=' <button class="act" data-act="untrigger-main" data-code="'+esc(c)+'">回退为未触发</button>';
    if(t.canAbandon)h+=' <button class="act" data-act="abandon" data-code="'+esc(c)+'">放弃</button>';
    if(t.objective&&t.objective.kind==='submit_resources')h+=' 资源<input class="res" data-code="'+esc(c)+'" placeholder="wood:100,clay:100" style="width:160px"> <button class="act" data-act="submit" data-code="'+esc(c)+'">上交</button>';
    h+='</div>';
  }
  h+='<h2>酒馆展示（日常可接取 '+((s.offered||[]).length)+'）</h2>';
  for(var i=0;i<(s.offered||[]).length;i++){var o=s.offered[i];
    h+='<div class="card" data-code="'+esc(o.code)+'">'+esc(o.name)+' ['+esc(o.type)+'] <button class="act" data-act="accept" data-code="'+esc(o.code)+'">接取</button></div>';
  }
  h+='<h2>支线可接取（'+((s.offeredSide||[]).length)+'）</h2>';
  for(var j=0;j<(s.offeredSide||[]).length;j++){var so=s.offeredSide[j];
    h+='<div class="card" data-code="'+esc(so.code)+'">'+esc(so.name)+' ['+esc(so.type)+'] <button class="act" data-act="accept" data-code="'+esc(so.code)+'">接取</button></div>';
  }
  h+='<h2>已完成主线</h2>';
  for(var cm=0;cm<(s.completedMain||[]).length;cm++){var mc=s.completedMain[cm];
    h+='<div class="card">'+esc(mc)+' <button class="act" data-act="retrigger-main" data-code="'+esc(mc)+'">重新触发</button></div>';
  }
  if(!(s.completedMain||[]).length)h+='<div class="card">无</div>';
  h+='<h2>已完成支线</h2>';
  for(var k=0;k<(s.completedSide||[]).length;k++){var sc=s.completedSide[k];
    h+='<div class="card">'+esc(sc)+' <button class="act" data-act="reopen" data-code="'+esc(sc)+'">标记未完成（重新触发）</button></div>';
  }
  if(!(s.completedSide||[]).length)h+='<div class="card">无</div>';
  h+='<h2>已放弃支线</h2>';
  if((s.abandonedSide||[]).length){
    for(var m=0;m<(s.abandonedSide||[]).length;m++){var ab=s.abandonedSide[m];
      h+='<div class="card">'+esc(ab)+' <button class="act" data-act="retrigger" data-code="'+esc(ab)+'">重新触发</button></div>';
    }
  } else { h+='<div class="card">无</div>'; }
  document.getElementById('content').innerHTML=h;
}
document.addEventListener('click',function(e){
  var btn=e.target.closest('.act');if(!btn)return;
  var act=btn.getAttribute('data-act');var code=btn.getAttribute('data-code');
  if(act==='complete')doComplete(code);
  else if(act==='abandon')doAbandon(code);
  else if(act==='accept')doAccept(code);
  else if(act==='submit')doSubmit(code);
  else if(act==='reopen')doReopen(code);
  else if(act==='retrigger')doRetrigger(code);
  else if(act==='retrigger-main')doRetriggerMain(code);
  else if(act==='untrigger-main')doUntriggerMain(code);
});
async function doComplete(code){var r=await api('POST','/ops/task/complete',{villageId:vid(),code:code});after(r,'完成');}
async function doAbandon(code){var r=await api('POST','/ops/task/abandon',{villageId:vid(),code:code});after(r,'放弃');}
async function doAccept(code){var r=await api('POST','/ops/task/accept',{villageId:vid(),code:code});after(r,'接取');}
async function doReopen(code){if(!confirm('标记 '+code+' 为未完成后，必须再次满足触发条件才能接取。继续？'))return;var r=await api('POST','/ops/task/reopen-completed',{villageId:vid(),code:code});after(r,'标记未完成');}
async function doRetrigger(code){if(!confirm('重新触发 '+code+'？该支线将从「已放弃」移出并重新进入可接取列表。'))return;var r=await api('POST','/ops/task/retrigger-abandoned',{villageId:vid(),code:code});after(r,'重新触发');}
async function doRetriggerMain(code){if(!confirm('重新触发主线 '+code+'？'))return;var r=await api('POST','/ops/task/retrigger-completed-main',{villageId:vid(),code:code});after(r,'重新触发主线');}
async function doUntriggerMain(code){if(!confirm('将进行中的主线 '+code+' 回退为未触发并清理其任务实体？'))return;var r=await api('POST','/ops/task/untrigger-main',{villageId:vid(),code:code});after(r,'回退主线');}
async function doSubmit(code){var raw=document.querySelector('input.res[data-code="'+code+'"]').value.trim();var res={};raw.split(',').forEach(function(p){var kv=p.split(':');if(kv.length===2)res[kv[0].trim()]=Number(kv[1].trim());});var r=await api('POST','/ops/task/submit',{villageId:vid(),code:code,resources:res});after(r,'上交');}
async function refreshRandom(){var r=await api('POST','/ops/task/refresh',{villageId:vid()});after(r,'刷新随机');}
async function resetTasks(){if(!confirm('确认重置该村全部任务进度（重激活主线 m1）？'))return;var r=await api('POST','/ops/task/reset',{villageId:vid()});after(r,'重置');}
async function after(r,act){if(!r.ok){statusMsg(act+'失败: '+(r.reason||''),true);return;}statusMsg(act+'成功');loadTasks();}
loadTasks();
</script>
</body></html>`;

const GM_DIALOGUES_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>对话编辑</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#101722;color:#dce7f7;font:13px ui-monospace,monospace}h1{margin:0 0 6px;color:#65c7ff;font-size:19px}.hint{color:#9bb0c9;margin:0 0 14px;line-height:1.55}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}button{background:#173550;border:1px solid #65c7ff;color:#dce7f7;border-radius:4px;padding:6px 9px;cursor:pointer;font:inherit}.save{border-color:#74d68c;color:#b9f6c8}.danger{border-color:#db7272;color:#ffb6b6}#status{color:#f1c575}.table-wrap{overflow:auto;border:1px solid #304c69;max-height:calc(100vh - 180px)}table{border-collapse:collapse;min-width:100%;background:#121d2b}th,td{border:1px solid #29435e;padding:4px;vertical-align:top}th{position:sticky;top:0;background:#20354c;color:#8ed5ff;white-space:nowrap}input,textarea{width:190px;min-width:120px;background:#0d1622;border:1px solid #365671;border-radius:2px;color:#e5eef8;padding:4px;font:inherit}textarea{height:96px;resize:vertical}.small{width:70px;min-width:70px}.row-actions{min-width:54px;white-space:nowrap}a{color:#79cfff}
</style></head><body>
<h1>NPC 对话编辑</h1>
<p class="hint">同一 <b>id</b> 对象可以包含多个有序段落；触发后玩家关闭对话或选择回复，会立即进入下一段直到结束。<b>accept</b> 是接取/自动激活，<b>after_accept</b> 是任务接取成功后触发（S3 使用独立的 <b>s3_after_accept</b> 对象），<b>deliver</b> 是交付；交付弹窗只有配置了 replies 才显示按钮，没有 replies 时只能点右上角关闭。交付常用 <b>take:收下</b>，M8/M9 的成功文本使用默认触发点，失败文本使用对应的 <b>accept_failure</b>/<b>deliver_failure</b>。replies 格式为 <b>key:玩家看到的文字|key2:文字</b>。npcName/npcText 支持服务端变量 <b>{villageName}</b>（当前玩家村庄名）和 <b>{fiefName}</b>（当前玩家所属封地名），配置中心保存变量名，客户端收到的是已替换文本。只有 npcName、npcText、replies 可编辑，id/code/taskCode/trigger/段落序号由对象和段落操作维护；空白模板不会阻塞任务接取。</p>
<div class="bar"><button onclick="addObject()">+ 新增对话对象</button><button class="save" onclick="save()">保存并热重载</button><span id="status">加载中…</span></div>
<div class="table-wrap"><table id="grid"></table></div>
<script>
let token=sessionStorage.getItem('gmToken')??'',header=[],rows=[];
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
async function api(url,opt={}){opt.headers=Object.assign({},opt.headers||{},token?{'X-GM-Token':token}: {},opt.body?{'Content-Type':'application/json'}:{});let r=await fetch(url,opt);if(r.status===401){let x=prompt('GM Token:',token);if(x!==null){token=x.trim();sessionStorage.setItem('gmToken',token);return api(url,opt)}}let j=await r.json();if(!r.ok||!j.ok)throw Error(j.reason||'请求失败');return j}
 const editable=new Set(['npcName','npcText','replies']);
 function compareNatural(a,b){let aa=String(a??'').match(/\\d+|\\D+/g)||[''],bb=String(b??'').match(/\\d+|\\D+/g)||[''];let n=Math.min(aa.length,bb.length);for(let i=0;i<n;i++){let x=aa[i],y=bb[i],nx=/^\\d+$/.test(x),ny=/^\\d+$/.test(y);if(nx&&ny){let ux=x.replace(/^0+(?=\\d)/,''),uy=y.replace(/^0+(?=\\d)/,'');if(ux.length!==uy.length)return ux.length-uy.length;if(ux!==uy)return ux<uy?-1:1;if(x.length!==y.length)return x.length-y.length;continue}if(x!==y)return x<y?-1:1}return aa.length-bb.length}
function compareDialogueCode(a,b){let aa=String(a??'').split('_'),bb=String(b??'').split('_'),n=Math.min(aa.length,bb.length);for(let i=0;i<n;i++){let order=compareNatural(aa[i],bb[i]);if(order!==0)return order}return aa.length-bb.length}
function rowCompare(a,b){let codeA=String(a.code??''),codeB=String(b.code??''),codeOrder=compareDialogueCode(codeA,codeB);if(codeOrder!==0)return codeOrder;let taskCodeA=String(a.taskCode??''),taskCodeB=String(b.taskCode??''),taskCodeOrder=compareNatural(taskCodeA,taskCodeB);if(taskCodeOrder!==0)return taskCodeOrder;let segA=Number(a.segment),segB=Number(b.segment);if(Number.isFinite(segA)&&Number.isFinite(segB)&&segA!==segB)return segA-segB;if(Number.isFinite(segA)!==Number.isFinite(segB))return Number.isFinite(segA)?-1:1;let idA=Number(a.id),idB=Number(b.id);if(Number.isFinite(idA)&&Number.isFinite(idB)&&idA!==idB)return idA-idB;return 0}
function sortRows(){rows.sort(rowCompare)}
function render(){sortRows();let h='<thead><tr>'+header.map(x=>'<th>'+esc(x)+'</th>').join('')+'<th>操作</th></tr></thead><tbody>';for(let i=0;i<rows.length;i++){h+='<tr>'+header.map(k=>{let v=rows[i][k]??'';let control='';if(!editable.has(k)){control='<span class="readonly">'+esc(v)+'</span>'}else if(k==='npcText'){control='<textarea data-i="'+i+'" data-k="'+esc(k)+'" oninput="edit(this)">'+esc(v)+'</textarea>'}else{control='<input data-i="'+i+'" data-k="'+esc(k)+'" value="'+esc(v)+'" oninput="edit(this)">'}return '<td>'+control+'</td>'}).join('')+'<td class="row-actions"><button onclick="addSegment('+i+')">+ 段落</button><button class="danger" onclick="removeRow('+i+')">删除</button></td></tr>'}document.getElementById('grid').innerHTML=h+'</tbody>';document.getElementById('status').textContent='已按 code（下划线优先、数字感知）、taskCode 排序，加载 '+rows.length+' 段'}
function edit(el){rows[Number(el.dataset.i)][el.dataset.k]=el.value}
function addObject(){let id=prompt('对象 id（正整数）：');if(id===null)return;let code=prompt('稳定对话 code：');if(code===null)return;let taskCode=prompt('绑定任务 code：');if(taskCode===null)return;let trigger=prompt('触发点（如 accept）：','accept');if(trigger===null)return;let r={};for(let k of header)r[k]='';r.id=id.trim();r.code=code.trim();r.taskCode=taskCode.trim();r.trigger=trigger.trim()||'accept';r.segment='1';if(r.trigger==='deliver')r.replies='take:收下';rows.push(r);render()}
function addSegment(i){let base=rows[i], group=rows.filter(x=>x.id===base.id&&x.code===base.code);let next=Math.max(...group.map(x=>Number(x.segment)||0),0)+1;let r={};for(let k of header)r[k]='';['id','code','taskCode','trigger'].forEach(k=>r[k]=base[k]??'');r.segment=String(next);if(r.trigger==='deliver')r.replies='take:收下';rows.splice(i+1,0,r);render()}
function removeRow(i){if(!confirm('删除这一段？'))return;let base=rows[i];rows.splice(i,1);let group=rows.filter(x=>x.id===base.id&&x.code===base.code).sort((a,b)=>(Number(a.segment)||0)-(Number(b.segment)||0));group.forEach((row,index)=>row.segment=String(index+1));render()}
async function load(){try{let d=await api('/gm/dialogues/data');header=d.header;rows=d.rows||[];render()}catch(e){document.getElementById('status').textContent='加载失败：'+e.message}}
async function save(){try{document.getElementById('status').textContent='校验并保存中…';let d=await api('/gm/dialogues/save',{method:'POST',body:JSON.stringify({rows})});document.getElementById('status').textContent='已保存并热重载（'+d.count+' 行）'}catch(e){document.getElementById('status').textContent='保存失败：'+e.message}}
load();
</script></body></html>`;

function configPage(html: string): string {
  // 旧编辑器沿用成熟的渲染脚本，但页面与 API 均改到 /config 命名空间，
  // 让配置编辑器不再出现在 GM 的实时状态入口下。
  return html
    .replaceAll("fetch('/gm' +", "fetch('/config' +")
    .replaceAll("fetch('/gm'+", "fetch('/config'+")
    .replaceAll("fetch('/gm/", "fetch('/config/")
    .replaceAll("'/gm/", "'/config/")
    .replaceAll('GM 面板', '配置中心')
    .replaceAll('改 CSV 即时生效（无需刷档）', '配置中心 · CSV 版本化（合并并部署后生效）')
    .replaceAll('保存并热重载', '提交配置并热重载');
}

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
<div style="font-size:12px;color:#8a7a5a;margin:6px 0 12px;line-height:1.7">
  目标类型 objKind：<b>submit_resources</b>=上交资源(objParam 形如 wood:200|clay:200) ·
  <b>clear_camp</b>=清剿营地(objParam 形如 task_camp:1) ·
  <b>build_buildings</b>=建造建筑(objParam 形如 inner:2/outer:1) ·
  <b>population_reached</b>=人口达到数量(objParam 形如 30) ·
  <b>resource_owned</b>=拥有资源且不扣除(objParam 形如 gold:100) ·
  <b>explore_tiles</b>=累计探索格数(objParam 形如 100) ·
  <b>sell_discard_treasure</b>=出售/丢弃稀有+宝物(objParam 形如 rare:2，minRarity:count)。<br>
  触发条件 trigger（仅随机任务）：<b>building_built:&lt;建筑code&gt;</b> = 建造完成该建筑后才进酒馆（如 building_built:treasury=建好宝库）；留空=无触发常驻可刷。
</div>
<div id="status" class="ok">就绪</div>
<div class="toolbar">
  <button onclick="load()">重新加载</button>
  <button onclick="addRow()">新增一行</button>
  <button class="save" onclick="save()">保存并热重载</button>
</div>
<div id="grid"></div>
<script>
let token=sessionStorage.getItem('gmToken')??'';
var COLS=['id','code','name','desc','type','requires','objKind','objParam','rewardRes','rewardTreasure','weight','trigger'];
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
