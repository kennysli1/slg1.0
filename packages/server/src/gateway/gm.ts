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
 *
 * 安全：GM_TOKEN=<secret> 时所有请求需带 X-GM-Token header（面板自动处理）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Store } from '../infra/store.js';

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
button.save{border-color:#70f070;color:#70f070}
button.save:hover{background:#70f070;color:#16213e}
#editor{flex:1;background:#0d1117;color:#c9d1d9;padding:12px;font-family:monospace;font-size:12px;border:none;resize:none;outline:none;overflow:auto}
#status{padding:4px 12px;font-size:11px;color:#a0a8c0;background:#16213e;border-top:1px solid #0f3460;flex-shrink:0}
#cur-key{color:#4cc9f0;font-weight:bold}
.empty{padding:20px;color:#555;text-align:center}
</style>
</head>
<body>
<div id="sidebar">
  <h2>集合</h2>
  <div id="col-list"><div class="empty">加载中…</div></div>
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

refreshAll();
</script>
</body>
</html>`;

export function registerGmRoutes(fastify: FastifyInstance, store: Store): void {
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
    void reply.send({ ok: true, collection, key, doc: body });
  });

  // DELETE /gm/:collection/:key
  fastify.delete('/gm/:collection/:key', (req, reply) => {
    if (!auth(req, reply)) return;
    const { collection, key } = req.params as { collection: string; key: string };
    const deleted = store.delete(collection, key);
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
    void reply.send({ ok: true, collection, cleared: true });
  });
}

