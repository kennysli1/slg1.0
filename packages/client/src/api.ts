import type { WireRequest, WireResponse, WirePush } from '@slg/shared';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';

/**
 * 前端 WS 通信层：请求-响应配对 + 推送分发。
 * 多人版：不再写死村庄；登录后服务器据会话自动注入自己的 villageId。
 */

type PushHandler = (event: string, payload: any) => void;

let ws: WebSocket | null = null;
let seq = 0;
const REQUEST_TIMEOUT_MS = 10_000;
/** 重连指数退避：base 1s，上限 30s */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 协议版本不兼容时设置（非 null）。
 * 一旦设置：阻止后续重连、拒绝所有新请求。
 */
let protocolError: string | null = null;

/**
 * 纯函数：判断服务端发来的消息版本是否在客户端兼容范围内。
 * 导出供单测直接调用，无任何浏览器依赖。
 */
export function isCompatibleVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= WIRE_MIN_VERSION && v <= WIRE_VERSION;
}

/** 返回当前协议错误文案；null = 无协议错误。 */
export function getProtocolError(): string | null {
  return protocolError;
}

const pending = new Map<string, {
  resolve: (res: WireResponse) => void;
  reject: (err: Error) => void;
  timer: number;
}>();
let pushHandler: PushHandler = () => {};

export interface MeVillage {
  id: string;
  q: number;
  r: number;
  name: string;
  isCapital: boolean;
}

export interface Me {
  id: string;
  name: string;
  tribe: string;
  villageId: string;
  currentVillageId?: string;
  capitalVillageId?: string;
  q: number; // 当前操作村坐标
  r: number;
  villages?: MeVillage[];
}
export let me: Me | null = null;

/** 用登录/切村响应更新本地身份。 */
export function applyMe(player: Me): void {
  me = player;
}

/** 切到己方另一座村（会话当前操作村）。 */
export async function selectVillage(villageId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await req('SelectVillage', { villageId });
    if (res.ok) {
      me = (res.payload as any).player as Me;
      return { ok: true };
    }
    return { ok: false, error: res.error?.code };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export function isOwnVillageId(id: string): boolean {
  return !!me?.villages?.some((v) => v.id === id) || me?.villageId === id;
}

export function ownVillageAt(q: number, r: number): MeVillage | undefined {
  return me?.villages?.find((v) => v.q === q && v.r === r);
}

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

/** 持久化 onOpen/onClose 回调，重连时复用。 */
let savedOnOpen: (() => void) | null = null;
let savedOnClose: (() => void) | null = null;

export function connect(onOpen: () => void, onClose: () => void): void {
  // 防止重复建连：已在 CONNECTING 或 OPEN 状态时直接跳过
  if (ws !== null && ws.readyState !== WebSocket.CLOSED) return;

  // 取消未触发的重连计时器（外部主动调用 connect 时重置退避）
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  savedOnOpen = onOpen;
  savedOnClose = onClose;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempt = 0; // 连接成功，重置退避计数
    onOpen();
  };

  ws.onerror = () => rejectPending('network_error');

  ws.onclose = () => {
    clearSession();
    rejectPending('connection_closed');
    onClose();
    // 协议不兼容：不重连（客户端版本过旧，重连无意义，须刷新页面）
    if (protocolError) return;
    // 指数退避重连
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (savedOnOpen && savedOnClose) connect(savedOnOpen, savedOnClose);
    }, delay);
  };

  ws.onmessage = (ev) => {
    let raw: unknown;
    try {
      raw = JSON.parse(ev.data);
    } catch {
      console.warn('[api] 忽略无法解析的消息', ev.data);
      return;
    }
    // 基础信封校验：必须是对象且包含 type 和 id 字段
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      !('id' in raw) ||
      typeof (raw as Record<string, unknown>).id !== 'string'
    ) {
      console.warn('[api] 忽略格式异常的消息（缺少 type/id）');
      return;
    }
    // 版本兼容性校验：服务端版本必须在 [WIRE_MIN_VERSION, WIRE_VERSION] 范围内
    const msgV = (raw as Record<string, unknown>).v;
    if (!isCompatibleVersion(msgV)) {
      console.error(`[api] 协议版本不兼容（服务端 v=${msgV}，客户端接受 ${WIRE_MIN_VERSION}–${WIRE_VERSION}），停止重连`);
      protocolError = '协议版本不兼容，请刷新页面';
      rejectPending('protocol_error');
      ws?.close();
      return;
    }
    const msg = raw as WireResponse | WirePush;
    if (msg.type === 'res') {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        p.resolve(msg as WireResponse);
      }
      pending.delete(msg.id);
    } else if (msg.type === 'push') {
      if (!('event' in msg)) {
        console.warn('[api] push 消息缺少 event 字段');
        return;
      }
      pushHandler((msg as WirePush).event, (msg as WirePush).payload);
    }
  };
}

export function req(action: string, payload: Record<string, unknown> = {}): Promise<WireResponse> {
  if (protocolError) {
    return Promise.reject(new Error(protocolError));
  }
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
    if (res.ok) { applyMe((res.payload as any).player as Me); return { ok: true }; }
    return { ok: false, error: res.error?.code };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/** 登录：用户名+密码。成功后记住身份。 */
export async function login(name: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await req('Login', { name, password });
    if (res.ok) { applyMe((res.payload as any).player as Me); return { ok: true }; }
    return { ok: false, error: res.error?.code };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}
