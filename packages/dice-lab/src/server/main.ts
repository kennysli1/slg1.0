/**
 * Dice Lab 独立服务入口。只加载实验场规则与静态页面，不组装 KOW GameApp、不读取游戏存档。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Difficulty } from '../domain/ai.js';
import type { PlayerAction } from '../domain/engine.js';
import { DiceLabSessions, SessionError } from './sessions.js';

const PORT = Number(process.env.DICE_LAB_PORT ?? 8091);
const HOST = process.env.DICE_LAB_HOST ?? '127.0.0.1';
const ACCESS_TOKEN = process.env.DICE_LAB_TOKEN ?? '';
const TARGET_SCORE = 4_000;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const clientDist = join(__dirname, '../client');

type CreateBody = { difficulty?: Difficulty; targetScore?: number; token?: string };
type ActionBody = { expectedRevision?: number; action?: PlayerAction; token?: string };

function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlayerAction(value: unknown): value is PlayerAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as { type?: unknown; selectedDieIds?: unknown };
  if (action.type === 'forfeit') return action.selectedDieIds === undefined;
  if (action.type === 'roll') return action.selectedDieIds === undefined || isStringArray(action.selectedDieIds);
  return action.type === 'bank' && isStringArray(action.selectedDieIds);
}

function authorized(request: FastifyRequest, bodyToken?: string): boolean {
  if (!ACCESS_TOKEN) return true;
  const header = request.headers['x-dice-lab-token'];
  return (typeof header === 'string' && header === ACCESS_TOKEN) || bodyToken === ACCESS_TOKEN;
}

function sendSessionError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof SessionError)) {
    reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '实验场内部错误' } });
    return;
  }
  const status = error.code === 'not_found' ? 404 : error.code === 'stale_revision' ? 409 : 400;
  reply.code(status).send({ ok: false, error: { code: error.code, message: error.message } });
}

async function main(): Promise<void> {
  if (process.env.DICE_LAB_ENABLED === 'off') {
    console.log('[dice-lab] disabled (DICE_LAB_ENABLED=off)');
    return;
  }
  const fastify = Fastify({ logger: true, bodyLimit: 16 * 1024 });
  const sessions = new DiceLabSessions();

  if (existsSync(clientDist)) {
    await fastify.register(fastifyStatic, { root: clientDist, prefix: '/dice-lab/', index: 'index.html' });
  }
  fastify.get('/dice-lab', async (_request, reply) => reply.redirect('/dice-lab/'));
  fastify.get('/health', async () => ({ ok: true, service: 'dice-lab', ts: Date.now() }));

  fastify.post<{ Body: CreateBody }>('/dice-lab/api/sessions', async (request, reply) => {
    if (!authorized(request, request.body?.token)) return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: '需要实验场访问码' } });
    const difficulty = isDifficulty(request.body?.difficulty) ? request.body.difficulty : 'normal';
    const targetScore = request.body?.targetScore === undefined ? TARGET_SCORE : Number(request.body.targetScore);
    if (!Number.isInteger(targetScore) || targetScore < 500 || targetScore > 20_000) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_target', message: '目标分数必须是500到20000之间的整数' } });
    }
    return { ok: true, session: sessions.create(difficulty, targetScore) };
  });

  fastify.get<{ Params: { id: string } }>('/dice-lab/api/sessions/:id', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: '需要实验场访问码' } });
    try { return { ok: true, session: sessions.get(request.params.id) }; } catch (error) { sendSessionError(reply, error); }
  });

  fastify.post<{ Params: { id: string }; Body: ActionBody }>('/dice-lab/api/sessions/:id/actions', async (request, reply) => {
    if (!authorized(request, request.body?.token)) return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: '需要实验场访问码' } });
    const expectedRevision = request.body?.expectedRevision;
    const action = request.body?.action;
    if (expectedRevision === undefined || !Number.isInteger(expectedRevision) || !isPlayerAction(action)) {
      return reply.code(400).send({ ok: false, error: { code: 'invalid_action', message: '动作格式无效' } });
    }
    try {
      return { ok: true, session: sessions.act(request.params.id, expectedRevision, action) };
    } catch (error) { sendSessionError(reply, error); }
  });

  fastify.delete<{ Params: { id: string } }>('/dice-lab/api/sessions/:id', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: '需要实验场访问码' } });
    sessions.remove(request.params.id);
    return { ok: true };
  });

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[dice-lab] listening on http://${HOST}:${PORT}/dice-lab/`);
}

main().catch((error) => {
  console.error('[dice-lab] failed to start:', error);
  process.exitCode = 1;
});
