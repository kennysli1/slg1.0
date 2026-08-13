import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';
import { createGameApp } from '../app.js';
import { Gateway, type ClientConnection } from '../gateway/gateway.js';

/**
 * Wire 边界校验测试：信封格式、版本校验、schema 校验、rate limit
 */

function makeGateway() {
  const app = createGameApp({ now: () => 1_000_000, manualScheduler: true });
  app.setupWorld();
  const gateway = new Gateway(app);
  return { gateway, app };
}

function makeFakeConn(): { conn: ClientConnection; sent: unknown[] } {
  const sent: unknown[] = [];
  const conn: ClientConnection = { send: (msg) => sent.push(msg) };
  return { conn, sent };
}

// ── 信封校验 ──────────────────────────────────────────────────────────────────

test('wire-boundary：缺少 id 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', action: 'GetGameConfig', payload: {} },
    s,
  );
  // id 缺失 → bad_envelope
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_envelope');
});

test('wire-boundary：id 为空字符串被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: '', action: 'GetGameConfig', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_envelope');
});

test('wire-boundary：type 不是 req 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'push' as any, id: 'x', action: 'GetGameConfig', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_envelope');
});

test('wire-boundary：版本低于 WIRE_MIN_VERSION 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_MIN_VERSION - 1, type: 'req', id: 'x', action: 'GetGameConfig', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'version_mismatch');
});

test('wire-boundary：版本高于 WIRE_VERSION 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION + 1, type: 'req', id: 'x', action: 'GetGameConfig', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'version_mismatch');
});

test('wire-boundary：payload 不是对象被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: 'x', action: 'GetGameConfig', payload: [1, 2, 3] as any },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_envelope');
});

test('wire-boundary：未知 action 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: 'x', action: 'NonExistent', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'unknown_action');
});

test('wire-boundary：未登录请求需鉴权的 action 被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: 'x', action: 'GetResources', payload: {} },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'not_logged_in');
});

test('wire-boundary：登录凭证可在新连接恢复会话，伪造凭证被拒绝', async () => {
  const { gateway } = makeGateway();
  const first = gateway.addClient(makeFakeConn().conn);
  const registered = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'register-session', action: 'Register',
      payload: { name: 'SessionUser', password: 'pass1234', tribe: 'romans' },
    },
    first,
  );
  assert.equal(registered.ok, true);
  const token = registered.payload.sessionToken;
  assert.equal(typeof token, 'string');

  const restored = gateway.addClient(makeFakeConn().conn);
  const resumed = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'resume-session', action: 'ResumeSession',
      payload: { token },
    },
    restored,
  );
  assert.equal(resumed.ok, true);
  const authed = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: 'authed', action: 'GetResources', payload: {} },
    restored,
  );
  assert.equal(authed.ok, true);

  const forged = gateway.addClient(makeFakeConn().conn);
  const rejected = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'forged-session', action: 'ResumeSession',
      payload: { token: `${String(token).slice(0, -1)}x` },
    },
    forged,
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'invalid_session');
});

// ── Schema 校验 ───────────────────────────────────────────────────────────────

test('wire-boundary：Register payload schema — name 过长被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'x', action: 'Register',
      payload: { name: 'x'.repeat(17), password: 'pass1234' },
    },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'too_long');
});

test('wire-boundary：Register payload schema — password 过短被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'x', action: 'Register',
      payload: { name: 'Alice', password: '12' },
    },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'too_short');
});

test('wire-boundary：Register 多余字段被剥离（不传到命令层）', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'x', action: 'Register',
      payload: { name: 'Alice', password: 'pass1234', extra: 'hack', __proto__: 'injected' },
    },
    s,
  );
  // 注册应成功（多余字段被剥离，不影响业务）
  assert.equal(res.ok, true, `Register 应成功: ${res.error?.msg}`);
});

test('wire-boundary：Login payload schema — name 缺失被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: 'x', action: 'Login',
      payload: { password: 'pass1234' },
    },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'missing_field');
});

test('wire-boundary：Build — zone 枚举值错误被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  // 需要先登录才能执行 Build（needAuth=true）；用 Register 注册并自动绑定会话
  const s = gateway.addClient(conn);
  await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: '1', action: 'Register', payload: { name: 'Bob', password: 'pass1234' } },
    s,
  );
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: '2', action: 'Build',
      payload: { zone: 'center', kind: 'barracks' }, // center 不合法（只有 inner/outer）
    },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_enum');
});

test('wire-boundary：SendRaid — troops 值不是整数被拒绝', async () => {
  const { gateway } = makeGateway();
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);
  await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: '1', action: 'Register', payload: { name: 'Charlie', password: 'pass1234' } },
    s,
  );
  const res = await gateway.handleRequest(
    {
      v: WIRE_VERSION, type: 'req', id: '2', action: 'SendRaid',
      payload: { targetId: 'pve-1', troops: { swordsman: 1.5 } },
    },
    s,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'bad_type');
});

// ── 频控 ───────────────────────────────────────────────────────────────────────

test('wire-boundary：Login/Register 账号频控', async () => {
  // 使用假时钟使令牌桶不自动补充
  let t = 0;
  const app = createGameApp({ now: () => t, manualScheduler: true });
  app.setupWorld();
  const gateway = new Gateway(app);
  const { conn } = makeFakeConn();
  const s = gateway.addClient(conn);

  // 注册成功（第1次）
  const r1 = await gateway.handleRequest(
    { v: WIRE_VERSION, type: 'req', id: '1', action: 'Register', payload: { name: 'Dave', password: 'pass1234' } }, s,
  );
  assert.equal(r1.ok, true, '首次注册应成功');

  // 同名登录连续失败触发频控（账号名相同，令牌桶共享）
  let rateLimited = false;
  for (let i = 0; i < 10; i++) {
    const r = await gateway.handleRequest(
      { v: WIRE_VERSION, type: 'req', id: `${i+2}`, action: 'Login', payload: { name: 'Dave', password: 'wrong' } }, s,
    );
    if (r.error?.code === 'rate_limited') { rateLimited = true; break; }
  }
  assert.equal(rateLimited, true, '多次失败登录应触发频控');
});
