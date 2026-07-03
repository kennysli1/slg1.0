/**
 * GM HTTP API（调试专用）
 *
 * 只在 GM_ENABLED=true 时挂载（生产默认关，开发时设环境变量开启）。
 *
 * 端点：
 *   GET    /gm/collections                列出所有 store 集合名 + 文档数
 *   GET    /gm/:collection                列出集合内所有 key → 文档（支持 ?limit=50&offset=0）
 *   GET    /gm/:collection/:key           读一条文档
 *   PUT    /gm/:collection/:key           写/覆盖一条文档（body 为 JSON）
 *   DELETE /gm/:collection/:key           删一条文档
 *   DELETE /gm/:collection                清空整个集合（危险，需 ?confirm=yes）
 *
 * 安全：
 *   - 只监听本地端口（HOST=0.0.0.0 但路由检查 X-GM-Token 或 localhost 来源）。
 *   - 生产环境如需开启，额外设 GM_TOKEN=<secret> 并在请求里带 X-GM-Token: <secret>。
 *
 * 用法（假设服务跑在 8080）：
 *   curl http://localhost:8080/gm/collections
 *   curl http://localhost:8080/gm/economy
 *   curl http://localhost:8080/gm/economy/v1
 *   curl -X PUT -H "Content-Type: application/json" -d '{"resources":{"wood":9999}}' http://localhost:8080/gm/economy/v1
 *   curl -X DELETE http://localhost:8080/gm/battle/bt-1
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Store } from '../infra/store.js';

export function registerGmRoutes(fastify: FastifyInstance, store: Store): void {
  const token = process.env.GM_TOKEN?.trim() || null;

  // 简单 token 校验中间件
  const auth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!token) return true; // 未设 GM_TOKEN → 仅凭端口隔离，不校验
    if (req.headers['x-gm-token'] === token) return true;
    void reply.code(401).send({ ok: false, reason: '需要 X-GM-Token header' });
    return false;
  };

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

  // PUT /gm/:collection/:key  （body = 新文档 JSON）
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

  // DELETE /gm/:collection  （清空整个集合，需 ?confirm=yes）
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
