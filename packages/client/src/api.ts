import type { WireRequest, WireResponse, WirePush } from '@slg/shared';
import { WIRE_VERSION } from '@slg/shared';

/**
 * 前端 WS 通信层：请求-响应配对 + 推送分发。
 * 多人版：不再写死村庄；登录后服务器据会话自动注入自己的 villageId。
 */

type PushHandler = (event: string, payload: any) => void;

let ws: WebSocket | null = null;
let seq = 0;
const REQUEST_TIMEOUT_MS = 10_000;
const pending = new Map<string, {
  resolve: (res: WireResponse) => void;
  reject: (err: Error) => void;
  timer: number;
}>();
let pushHandler: PushHandler = () => {};

export interface Me {
  id: string;
  name: string;
  tribe: string;
  villageId: string;
  q: number; // 六边形轴坐标
  r: number;
}
export let me: Me | null = null;

export function onPush(h: PushHandler) {
  pushHandler = h;
}

export function clearSession(): void {
  me = null;
}

function rejectPending(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

export function connect(onOpen: () => void, onClose: () => void): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = onOpen;
  ws.onerror = () => rejectPending('network_error');
  ws.onclose = () => {
    clearSession();
    rejectPending('connection_closed');
    onClose();
    setTimeout(() => connect(onOpen, onClose), 2000);
  };
  ws.onmessage = (ev) => {
    let msg: WireResponse | WirePush;
    try {
      msg = JSON.parse(ev.data) as WireResponse | WirePush;
    } catch {
      console.warn('[api] 忽略无法解析的消息', ev.data);
      return;
    }
    if (msg.type === 'res') {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        p.resolve(msg);
      }
      pending.delete(msg.id);
    } else if (msg.type === 'push') {
      pushHandler(msg.event, msg.payload);
    }
  };
}

export function req(action: string, payload: Record<string, unknown> = {}): Promise<WireResponse> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('not_connected'));
  }
  const socket = ws;
  const id = `c-${++seq}`;
  const r: WireRequest = { v: WIRE_VERSION, type: 'req', id, ts: Date.now(), action, payload };
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request_timeout:${action}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify(r));
  });
}

/** 注册：用户名+密码+种族。成功后记住身份。 */
export async function register(name: string, password: string, tribe: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await req('Register', { name, password, tribe });
    if (res.ok) { me = (res.payload as any).player as Me; return { ok: true }; }
    return { ok: false, error: res.error?.code };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/** 登录：用户名+密码。成功后记住身份。 */
export async function login(name: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await req('Login', { name, password });
    if (res.ok) { me = (res.payload as any).player as Me; return { ok: true }; }
    return { ok: false, error: res.error?.code };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}
