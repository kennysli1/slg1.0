import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WireResponse } from '@slg/shared';
import { WIRE_VERSION } from '@slg/shared';

import { createGameApp } from './app.js';
import { Gateway, type ClientConnection } from './gateway/gateway.js';
import { registerGmRoutes } from './gateway/gm.js';
import { initLogger } from './infra/logger.js';
import { TokenBucket } from './infra/rate-limit.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

/** 最大 WebSocket 消息体积（32 KB）。 */
const WS_MAX_PAYLOAD = 32 * 1024;

/** HTTP bodyLimit（32 KB）。 */
const HTTP_BODY_LIMIT = 32 * 1024;

/**
 * 最大并发 WebSocket 连接数。
 * 建议根据服务器 CPU/内存调整；默认 500 适合轻量服务器。
 */
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 500);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 构造拒绝响应信封（连接内发，不抛）。 */
function rejectMsg(id: string, code: string, msg: string): WireResponse {
  return { v: WIRE_VERSION, type: 'res', id, ts: Date.now(), ok: false, payload: {}, error: { code, msg } };
}

async function main() {
  // 1. 组装游戏内核（数据落盘到 data/game.json）
  const dataPath = process.env.DATA_PATH ?? join(__dirname, '../../../data/game.json');
  const logDir = process.env.LOG_DIR ?? join(__dirname, '../../../data/logs');
  initLogger(logDir);
  const app = createGameApp({ storePath: dataPath });
  const gateway = new Gateway(app);

  // 进程退出前把数据刷盘，避免丢最后几秒的变更
  const flushSafe = () => {
    try { app.store.flush(); } catch { /* ignore */ }
  };
  const flushAndExit = (code = 0) => {
    flushSafe();
    process.exit(code);
  };
  process.on('SIGINT', () => flushAndExit(0));
  process.on('SIGTERM', () => flushAndExit(0));
  process.on('beforeExit', flushSafe);
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err);
    flushAndExit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
    flushAndExit(1);
  });

  // 初始化世界（PvE 目标）。已有存档则跳过，避免覆盖已被打掉/重生中的目标状态。
  const fresh = app.store.all('player').length === 0;
  if (fresh) {
    app.setupWorld();
    console.log('[server] 全新存档：已初始化世界与 PvE 目标');
  } else {
    const synced = await app.syncWorldVillages();
    if (synced.synced || synced.failed) {
      console.log(`[server] 已校准 ${synced.synced} 个村庄地图坐标${synced.failed ? `，${synced.failed} 个失败` : ''}`);
    }
    app.resume();
    console.log(`[server] 载入存档：${app.store.all('player').length} 个玩家，已恢复在途任务`);
  }

  // 2. HTTP/WS 服务器
  const fastify = Fastify({ logger: true, bodyLimit: HTTP_BODY_LIMIT });
  await fastify.register(websocket, {
    options: {
      // ws 库：超限自动以 1009 关闭连接，无需应用层手动截断
      maxPayload: WS_MAX_PAYLOAD,
    },
  });

  // 托管前端静态文件（构建后的 client）。开发时用 Vite dev server，此目录可能不存在。
  const clientDist = join(__dirname, '../../client/dist');
  let buildId = 'development';
  let releaseCommit = 'development';
  let releaseBranch = 'development';
  try {
    const meta = JSON.parse(readFileSync(join(clientDist, 'version.json'), 'utf8')) as {
      buildId?: unknown;
      releaseCommit?: unknown;
      releaseBranch?: unknown;
    };
    if (typeof meta.buildId === 'string' && meta.buildId) buildId = meta.buildId;
    if (typeof meta.releaseCommit === 'string' && meta.releaseCommit) releaseCommit = meta.releaseCommit;
    if (typeof meta.releaseBranch === 'string' && meta.releaseBranch) releaseBranch = meta.releaseBranch;
  } catch { /* 开发环境可能还没有 client/dist */ }
  if (existsSync(clientDist)) {
    await fastify.register(fastifyStatic, { root: clientDist, prefix: '/' });
  }

  // 连接计数（用于限制最大并发连接数）
  let activeConnections = 0;

  // WebSocket 端点：每个连接是一个会话
  fastify.register(async (f) => {
    f.get('/ws', { websocket: true }, (socket) => {
      // ── 连接上限检查 ────────────────────────────────────────────────────────
      if (activeConnections >= MAX_CONNECTIONS) {
        socket.send(JSON.stringify(rejectMsg('unknown', 'server_full', '服务器连接已达上限，请稍后重试')));
        socket.close(1013, 'try again later');
        return;
      }
      activeConnections++;

      // ── 每连接消息令牌桶（防消息洪水）──────────────────────────────────────
      // 已登录连接：60 tokens，20/s 补充（允许短期突发 60 条，稳态 20 条/s）
      const msgBucket = new TokenBucket(60, 20);
      // 未登录连接额外预算（login/register 专用）：初始 10 tokens，0.2/s 补充（约 5 秒 1 次）
      const unauthBucket = new TokenBucket(10, 0.2);
      /** 空闲超时：超过 IDLE_MS 无消息则主动关闭（防僵尸连接）。 */
      const IDLE_MS = Number(process.env.WS_IDLE_MS ?? 10 * 60 * 1000);
      let lastActivity = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity >= IDLE_MS) {
          try { socket.close(1001, 'idle timeout'); } catch { /* ignore */ }
        }
      }, Math.min(60_000, Math.max(5_000, Math.floor(IDLE_MS / 2))));

      // 浏览器会自动响应 WS ping。pong 也算活跃，避免玩家只是阅读页面就被当僵尸踢下线。
      const pingTimer = setInterval(() => {
        try { socket.ping(); } catch { /* close handler 会清理 */ }
      }, 30_000);
      socket.on('pong', () => { lastActivity = Date.now(); });

      const conn: ClientConnection = {
        send: (msg) => {
          try { socket.send(JSON.stringify(msg)); } catch { /* 连接可能已关闭 */ }
        },
      };
      const session = gateway.addClient(conn);

      socket.on('message', async (raw: Buffer) => {
        lastActivity = Date.now();
        // ── 手动二次尺寸检查（ws maxPayload 按帧处理，这里按完整消息检查）──
        if (raw.length > WS_MAX_PAYLOAD) {
          conn.send(rejectMsg('unknown', 'payload_too_large', `消息体积超限（最大 ${WS_MAX_PAYLOAD} 字节）`));
          return;
        }

        // ── 每连接消息令牌桶 ─────────────────────────────────────────────────
        if (!msgBucket.tryConsume()) {
          conn.send(rejectMsg('unknown', 'rate_limited', '消息过于频繁，请放慢操作速度'));
          return;
        }

        // ── 未登录连接额外预算 ───────────────────────────────────────────────
        if (!session.playerId && !unauthBucket.tryConsume()) {
          conn.send(rejectMsg('unknown', 'rate_limited', '登录尝试过于频繁，请稍后重试'));
          return;
        }

        // ── JSON 解析 ────────────────────────────────────────────────────────
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          conn.send(rejectMsg('unknown', 'parse_error', 'JSON 解析失败'));
          return;
        }

        // ── 交给 Gateway（含信封校验、schema 校验、路由、业务）───────────────
        let res: WireResponse;
        try {
          res = await gateway.handleRequest(parsed, session);
        } catch (err) {
          console.error('[gateway] unhandled error in handleRequest:', err);
          res = rejectMsg('unknown', 'internal_error', '服务器内部错误');
        }
        conn.send(res);
      });

      socket.on('close', () => {
        clearInterval(idleTimer);
        clearInterval(pingTimer);
        activeConnections--;
        gateway.removeClient(session);
      });

      socket.on('error', (err: Error) => {
        console.error('[ws] socket error:', err.message);
      });
    });
  });

  // 健康检查
  fastify.get('/health', async () => ({ ok: true, ts: app.now() }));
  fastify.get('/version', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    return { buildId, releaseCommit, releaseBranch };
  });

  // GM 调试 API（始终挂载；如需关闭设 GM_ENABLED=off）
  if (process.env.GM_ENABLED !== 'off') {
    registerGmRoutes(fastify, app.store, app);
    console.log('[server] GM API 已启用 — /gm/collections');
  }

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[server] listening on http://${HOST}:${PORT}  (ws: /ws)`);
  console.log(`[server] maxConnections=${MAX_CONNECTIONS}  wsMaxPayload=${WS_MAX_PAYLOAD}B`);
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
