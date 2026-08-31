import type { Difficulty } from '../domain/ai.js';
import type { PlayerAction } from '../domain/engine.js';
import type { ClientSessionView } from './types.js';

type ApiResponse = { ok: true; session: ClientSessionView } | { ok: false; error: { code: string; message: string } };

export class DiceLabApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function createSession(token: string, difficulty: Difficulty, targetScore: number): Promise<ClientSessionView> {
  const response = await request('/dice-lab/api/sessions', token, {
    method: 'POST', body: JSON.stringify({ token, difficulty, targetScore }),
  });
  return unwrap(response);
}

export async function applyAction(
  token: string,
  sessionId: string,
  expectedRevision: number,
  action: PlayerAction,
): Promise<ClientSessionView> {
  const response = await request(`/dice-lab/api/sessions/${encodeURIComponent(sessionId)}/actions`, token, {
    method: 'POST', body: JSON.stringify({ token, expectedRevision, action }),
  });
  return unwrap(response);
}

async function request(path: string, token: string, init: RequestInit): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-dice-lab-token': token, ...(init.headers ?? {}) },
    });
  } catch {
    throw new DiceLabApiError('network_error', '实验场连接失败，请重新开始对局');
  }
  const body = await response.json() as ApiResponse;
  if (!response.ok && body.ok) throw new DiceLabApiError('http_error', `请求失败（HTTP ${response.status}）`);
  return body;
}

function unwrap(response: ApiResponse): ClientSessionView {
  if (!response.ok) throw new DiceLabApiError(response.error.code, response.error.message);
  return response.session;
}
