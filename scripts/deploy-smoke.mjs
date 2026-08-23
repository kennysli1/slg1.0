#!/usr/bin/env node
/**
 * 生产部署冒烟：验证构建后的静态前端、HTTP 健康检查与真实 WebSocket 链路。
 * 无参数时启动隔离的本地生产进程；--url URL 时只读验证已部署环境。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { WIRE_VERSION } from '../packages/shared/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;
const urlAt = process.argv.indexOf('--url');
const externalUrl = urlAt >= 0 ? process.argv[urlAt + 1] : null;
const FETCH_TIMEOUT_MS = externalUrl ? 30_000 : 10_000;
const FETCH_ATTEMPTS = externalUrl ? 3 : 1;
const expectCommitAt = process.argv.indexOf('--expect-commit');
const expectedCommit = expectCommitAt >= 0 ? process.argv[expectCommitAt + 1] : null;
if (urlAt >= 0 && !externalUrl) throw new Error('[deploy-smoke] --url 后必须提供部署地址');
if (expectCommitAt >= 0 && !expectedCommit) throw new Error('[deploy-smoke] --expect-commit 后必须提供提交 SHA');

function assert(condition, message) {
  if (!condition) throw new Error(`[deploy-smoke] ${message}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  assert(port > 0, '无法分配临时端口');
  return port;
}

async function fetchOk(url, expectedType) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      assert(res.ok, `${url} 返回 HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (expectedType) assert(type.includes(expectedType), `${url} Content-Type 异常：${type || '缺失'}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert(bytes.byteLength > 0, `${url} 返回空内容`);
      return { bytes, type };
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 500));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) throw new Error(`[deploy-smoke] 生产进程提前退出（code=${child.exitCode}）`);
    try {
      const res = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        assert(body?.ok === true, '/health 未返回 ok=true');
        return;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`[deploy-smoke] 等待 /health 超时：${String(lastError ?? '无响应')}`);
}

class WireClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.type !== 'res') return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      pending.resolve(msg);
    });
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10_000);
      this.ws.once('open', () => { clearTimeout(timer); resolveOpen(); });
      this.ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  request(action, payload = {}) {
    assert(this.ws?.readyState === WebSocket.OPEN, 'WebSocket 未连接');
    const id = `deploy-smoke-${++this.seq}`;
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${action} 响应超时`));
      }, 10_000);
      this.pending.set(id, { resolve: resolveResponse, timer });
      const body = { v: WIRE_VERSION, type: 'req', id, ts: Date.now(), action, payload };
      this.ws.send(JSON.stringify(body), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.ws?.close();
  }
}

async function verifyFrontend(baseUrl) {
  const health = await fetchOk(`${baseUrl}/health`, 'application/json');
  assert(JSON.parse(Buffer.from(health.bytes).toString('utf8')).ok === true, '健康检查内容异常');
  const version = await fetchOk(`${baseUrl}/version`, 'application/json');
  const versionBody = JSON.parse(Buffer.from(version.bytes).toString('utf8'));
  assert(typeof versionBody?.buildId === 'string' && versionBody.buildId.length > 0, '版本探针缺少 buildId');
  if (expectedCommit) {
    assert(versionBody.releaseBranch === 'main', `生产版本分支异常：${String(versionBody.releaseBranch)}`);
    assert(versionBody.releaseCommit === expectedCommit,
      `生产版本提交不一致：期望 ${expectedCommit}，实际 ${String(versionBody.releaseCommit)}`);
  }
  const index = await fetchOk(`${baseUrl}/`, 'text/html');
  const html = Buffer.from(index.bytes).toString('utf8');
  assert(html.includes('id="app"'), '生产首页缺少 #app 挂载点');
  const assetPaths = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)]
    .map((match) => match[1]).filter((path) => path.startsWith('/assets/'));
  assert(assetPaths.some((path) => path.endsWith('.js')), '生产首页未引用 JS 产物');
  assert(assetPaths.some((path) => path.endsWith('.css')), '生产首页未引用 CSS 产物');
  for (const path of new Set(assetPaths)) {
    await fetchOk(`${baseUrl}${path}`, path.endsWith('.js') ? 'javascript' : 'text/css');
  }
  await fetchOk(`${baseUrl}/art/ui_logo.webp`, 'image/webp');
}

async function verifyWire(baseUrl, allowWrite) {
  const target = new URL(baseUrl);
  const protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new WireClient(`${protocol}//${target.host}/ws`);
  try {
    await client.connect();
    const config = await client.request('GetGameConfig');
    assert(config.ok, `GetGameConfig 失败：${config.error?.code ?? 'unknown'}`);
    assert(Array.isArray(config.payload?.resources) && config.payload.resources.length > 0, '资源配置为空');
    assert(Array.isArray(config.payload?.buildings) && config.payload.buildings.length > 0, '建筑配置为空');
    if (!allowWrite) return;

    const suffix = Date.now().toString(36).slice(-8);
    const registered = await client.request('Register', {
      name: `smk${suffix}`, password: 'smoke-pass-813', tribe: 'romans',
    });
    assert(registered.ok, `Register 失败：${registered.error?.code ?? 'unknown'}`);
    const player = registered.payload?.player;
    assert(player?.villageId, '注册响应缺少 villageId');
    const checks = [
      ['GetResources', {}], ['GetVillageLayout', {}], ['GetArmy', {}],
      ['ListMovements', {}], ['GetPopulation', {}], ['ListTreasures', {}],
      ['task.GetState', {}], ['GetArea', { cq: player.q, cr: player.r, r: 2 }],
    ];
    for (const [action, payload] of checks) {
      const response = await client.request(action, payload);
      assert(response.ok, `${action} 失败：${response.error?.code ?? 'unknown'}`);
    }
  } finally { client.close(); }
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

let child = null;
let tempDir = null;
let logs = '';
try {
  let baseUrl = externalUrl?.replace(/\/$/, '') ?? null;
  if (!baseUrl) {
    tempDir = mkdtempSync(join(tmpdir(), 'kow-deploy-smoke-'));
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['packages/server/dist/main.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
        DATA_PATH: join(tempDir, 'game.json'), LOG_DIR: join(tempDir, 'logs'),
        GM_ENABLED: 'off', GAME_LOG: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
    await waitForHealth(baseUrl, child);
  } else await waitForHealth(baseUrl, null);

  console.log(`→ 验证 HTTP 与前端产物：${baseUrl}`);
  await verifyFrontend(baseUrl);
  console.log('→ 验证真实 WebSocket 协议链路');
  await verifyWire(baseUrl, !externalUrl);
  if (child) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert(child.exitCode == null, `生产进程冒烟期间退出（code=${child.exitCode}）`);
    const fatal = /uncaughtException|unhandledRejection|server failed to start|\[gateway\] unhandled error|"level":50/i;
    assert(!fatal.test(logs), `服务端日志出现致命错误：\n${logs.slice(-3000)}`);
  }
  console.log(`✔ 部署冒烟通过（${externalUrl ? '已部署环境，只读' : '本地生产产物，完整链路'}）`);
} catch (error) {
  if (logs) console.error(`\n--- 生产进程日志 ---\n${logs.slice(-5000)}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopChild(child);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
