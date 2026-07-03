import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WireRequest } from '@slg/shared';

import { createGameApp } from './app.js';
import { Gateway, type ClientConnection } from './gateway/gateway.js';
import { registerGmRoutes } from './gateway/gm.js';
import { initLogger } from './infra/logger.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // 1. 组装游戏内核（数据落盘到 data/game.json）
  const dataPath = process.env.DATA_PATH ?? join(__dirname, '../../../data/game.json');
  const logDir = join(__dirname, '../../../data/logs');
  initLogger(logDir);
  const app = createGameApp({ storePath: dataPath });
  const gateway = new Gateway(app);

  // 进程退出前把数据刷盘，避免丢最后几秒的变更
  const flushAndExit = () => {
    try { (app.store as any).flush?.(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);

  // 初始化世界（PvE 目标）。已有存档则跳过，避免覆盖已被打掉/重生中的目标状态。
  const fresh = app.store.all('player').length === 0;
  if (fresh) {
    app.setupWorld();
    console.log('[server] 全新存档：已初始化世界与 PvE 目标');
  } else {
    app.resume();
    console.log(`[server] 载入存档：${app.store.all('player').length} 个玩家，已恢复在途任务`);
  }

  // 2. HTTP/WS 服务器
  const fastify = Fastify({ logger: true });
  await fastify.register(websocket);

  // 托管前端静态文件（构建后的 client）。开发时用 Vite dev server，此目录可能不存在。
  const clientDist = join(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    await fastify.register(fastifyStatic, { root: clientDist, prefix: '/' });
  }

  // WebSocket 端点：每个连接是一个会话
  fastify.register(async (f) => {
    f.get('/ws', { websocket: true }, (socket) => {
      const conn: ClientConnection = {
        send: (msg) => socket.send(JSON.stringify(msg)),
      };
      const session = gateway.addClient(conn);

      socket.on('message', async (raw: Buffer) => {
        let req: WireRequest;
        try {
          req = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (req?.type !== 'req') return;
        const res = await gateway.handleRequest(req, session);
        conn.send(res);
      });

      socket.on('close', () => gateway.removeClient(session));
    });
  });

  // 健康检查
  fastify.get('/health', async () => ({ ok: true, ts: app.now() }));

  // GM 调试 API（始终挂载；如需关闭设 GM_ENABLED=off）
  if (process.env.GM_ENABLED !== 'off') {
    registerGmRoutes(fastify, app.store);
    console.log('[server] GM API 已启用 — /gm/collections');
  }

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[server] listening on http://${HOST}:${PORT}  (ws: /ws)`);
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
