import type { WireRequest, WireResponse, WirePush } from '@slg/shared';
import { WIRE_VERSION } from '@slg/shared';

/**
 * 前端 WS 通信层：请求-响应配对 + 推送分发。
 * 多人版：不再写死村庄；登录后服务器据会话自动注入自己的 villageId。
 */

type PushHandler = (event: string, payload: any) => void;

let ws: WebSocket;
let seq = 0;
const pending = new Map<string, (res: WireResponse) => void>();
let pushHandler: PushHandler = () => {};

export interface Me {
  id: string;
  name: string;
  tribe: string;
  villageId: string;
  x: number;
  y: number;
}
export let me: Me | null = null;

export function onPush(h: PushHandler) {
  pushHandler = h;
}

export function connect(onOpen: () => void, onClose: () => void): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = onOpen;
  ws.onclose = () => { onClose(); setTimeout(() => connect(onOpen, onClose), 2000); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as WireResponse | WirePush;
    if (msg.type === 'res') {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if (msg.type === 'push') {
      pushHandler(msg.event, msg.payload);
    }
  };
}

export function req(action: string, payload: Record<string, unknown> = {}): Promise<WireResponse> {
  const id = `c-${++seq}`;
  const r: WireRequest = { v: WIRE_VERSION, type: 'req', id, ts: Date.now(), action, payload };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify(r));
  });
}

/** 注册：用户名+密码+种族。成功后记住身份。 */
export async function register(name: string, password: string, tribe: string): Promise<{ ok: boolean; error?: string }> {
  const res = await req('Register', { name, password, tribe });
  if (res.ok) { me = (res.payload as any).player as Me; return { ok: true }; }
  return { ok: false, error: res.error?.code };
}

/** 登录：用户名+密码。成功后记住身份。 */
export async function login(name: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await req('Login', { name, password });
  if (res.ok) { me = (res.payload as any).player as Me; return { ok: true }; }
  return { ok: false, error: res.error?.code };
}
