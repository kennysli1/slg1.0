#!/usr/bin/env node
/**
 * 独立筛色子实验场冒烟：单独启动 dice-lab 服务，验证健康、静态页面、会话、版本闸门和一次完整动作链。
 * 不访问主游戏 Store、WebSocket 或生产存档。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(`[dice-lab-smoke] ${message}`);
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

async function waitForHealth(url, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`服务提前退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`等待健康检查超时：${String(lastError ?? '无响应')}`);
}

async function request(url, init) {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await response.json();
  assert(response.ok, `${init?.method ?? 'GET'} ${url} 返回 HTTP ${response.status}: ${body?.error?.message ?? 'unknown'}`);
  assert(body?.ok === true, `${url} 未返回 ok=true`);
  return body.session;
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['packages/dice-lab/dist/server/main.js'], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', DICE_LAB_ENABLED: 'on', DICE_LAB_HOST: '127.0.0.1', DICE_LAB_PORT: String(port), DICE_LAB_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  const health = await waitForHealth(`${baseUrl}/health`, child);
  assert(health?.service === 'dice-lab', '健康检查 service 异常');
  const page = await fetch(`${baseUrl}/dice-lab/`);
  assert(page.ok, `静态页面返回 HTTP ${page.status}`);
  const html = await page.text();
  assert(html.includes('id="app"'), '静态页面缺少 #app');
  const asset = await fetch(`${baseUrl}/dice-lab/art/ui_dice_lab_die.webp`);
  assert(asset.ok && (asset.headers.get('content-type') ?? '').includes('image/webp'), '骰子美术资源不可访问');
  const scoreboard = await fetch(`${baseUrl}/dice-lab/art/ui_dice_lab_scoreboard.png`);
  assert(scoreboard.ok && (scoreboard.headers.get('content-type') ?? '').includes('image/png'), '计分板美术资源不可访问');

  let session = await request(`${baseUrl}/dice-lab/api/sessions`, { method: 'POST', body: JSON.stringify({ difficulty: 'normal', targetScore: 500 }) });
  assert(session.state.phase === 'player' && session.state.dice.length === 0, '新会话初始状态异常');
  const stale = await fetch(`${baseUrl}/dice-lab/api/sessions/${session.id}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 99, action: { type: 'forfeit' } }),
  });
  assert(stale.status === 409, `旧 revision 未被拒绝（HTTP ${stale.status}）`);

  for (let turn = 0; turn < 40 && session.state.phase !== 'finished'; turn += 1) {
    if (session.state.dice.length === 0) {
      session = await request(`${baseUrl}/dice-lab/api/sessions/${session.id}/actions`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: session.revision, action: { type: 'roll' } }),
      });
      if (session.state.phase === 'finished') break;
      if (session.state.dice.length === 0) continue;
    }
    const option = session.selectableOptions[0];
    assert(option?.dieIds?.length, '掷骰后没有可用计分组合');
    session = await request(`${baseUrl}/dice-lab/api/sessions/${session.id}/actions`, {
      method: 'POST', body: JSON.stringify({ expectedRevision: session.revision, action: { type: 'bank', selectedDieIds: option.dieIds } }),
    });
  }
  assert(session.state.phase === 'finished', '动作链未在预期步数内结束');
  assert(session.state.winner === 'player' || session.state.winner === 'ai', '结束状态缺少 winner');
  console.log(`[dice-lab-smoke] passed: ${session.state.winner} wins, revision=${session.revision}`);
} catch (error) {
  console.error(`[dice-lab-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  if (logs) console.error(logs.slice(-4_000));
  process.exitCode = 1;
} finally {
  await stop(child);
}
