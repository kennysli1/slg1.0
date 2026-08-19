import type { WireRequest, WireResponse, WirePush, DomainEvent } from '@slg/shared';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';
import type { GameApp } from '../app.js';
import { aggregateManifests } from './manifest.js';
import { MODULE_MANIFESTS } from './routes.js';
import { validatePayload } from './validate.js';
import { KeyedTokenBuckets } from '../infra/rate-limit.js';

/**
 * 接入层 · Gateway（唯一翻译官 + 多人会话管理）
 * 对应设计文档 03_架构总览.md 第三节、04_通信格式规范.md(两边界衔接)
 *
 * 职责：
 *  - 维护每个连接的会话身份（playerId / villageId）。
 *  - 首先严格校验 WireRequest 信封（版本、id、action、payload 结构）。
 *  - 对 Login/Register 做按规范化账号名的令牌桶频控。
 *  - 把外部 Request(action) 翻译成内部 Command；对"自己村"的操作强制注入会话的
 *    villageId（玩家不能伪造别人的村做操作 → 安全）。
 *  - 订阅内部 Event，按事件 payload 里的 villageId **定向推送**给对应玩家（不再广播）。
 *
 * 路由表集中在接入层 routes.ts。领域模块不知道鉴权、会话注入与外部 payload schema。
 *
 * 不含游戏逻辑，只做翻译、路由、会话与权限。
 */

export interface ClientConnection {
  send(msg: WireResponse | WirePush): void;
}

/** 会话：一个连接的身份。 */
interface Session {
  conn: ClientConnection;
  playerId?: string;
  /** 当前操作村（ownVillage 注入用） */
  villageId?: string;
  /** 该玩家全部村庄（推送索引：任一村事件都推到此连接） */
  villageIds?: string[];
}

const { actionRoutes: ACTION_ROUTES, eventToPush: EVENT_TO_PUSH } = aggregateManifests(MODULE_MANIFESTS);

export class Gateway {
  private sessions = new Set<Session>();
  /** villageId → 会话集合（同一玩家可能多端登录）。用于定向推送。 */
  private byVillage = new Map<string, Set<Session>>();
  /** playerId → 会话集合（外军增量推送、跨村玩家维度事件）。 */
  private byPlayer = new Map<string, Set<Session>>();

  /**
   * Login/Register 按规范化账号名的令牌桶：
   * capacity=5，refillRate=0.1（约每 10 秒 1 次），即短期内最多 5 次尝试。
   */
  private readonly authRateLimit = new KeyedTokenBuckets(5, 0.1, () => this.app.now());

  constructor(private app: GameApp) {
    this.subscribeEvents();
  }

  addClient(conn: ClientConnection): Session {
    const s: Session = { conn };
    this.sessions.add(s);
    return s;
  }

  removeClient(session: Session): void {
    this.sessions.delete(session);
    this.unindexSession(session);
  }

  /**
   * 处理来自客户端的原始消息（unknown，含未经校验的 JSON 对象）。
   * 信封校验失败返回格式化错误响应，不抛异常。
   */
  async handleRequest(raw: unknown, session: Session): Promise<WireResponse> {
    // ── 1. 严格信封校验（最先执行，防止格式炸弹）──────────────────────────
    const envelope = this.validateEnvelope(raw);
    if (!envelope.ok) {
      return this.makeErrorResponse(
        typeof (raw as any)?.id === 'string' ? (raw as any).id : 'unknown',
        envelope.code,
        envelope.msg,
      );
    }
    const req = raw as WireRequest;

    // ── 2. 路由查找 ─────────────────────────────────────────────────────────
    const route = ACTION_ROUTES[req.action];
    if (!route) return this.errorRes(req, 'unknown_action', `未知动作: ${req.action}`);

    // ── 3. 鉴权 ─────────────────────────────────────────────────────────────
    if (route.needAuth && !session.playerId) {
      return this.errorRes(req, 'not_logged_in', '请先登录');
    }

    // ── 4. Payload schema 校验 + 剥离未声明字段 ──────────────────────────────
    let payload: Record<string, unknown> = req.payload;
    if (route.schema !== undefined) {
      const vr = validatePayload(payload, route.schema);
      if (!vr.ok) return this.errorRes(req, vr.code, vr.msg);
      payload = vr.cleaned;
    }

    // ── 5. Login/Register 按账号名频控 ───────────────────────────────────────
    if (req.action === 'Login' || req.action === 'Register') {
      const name = ((payload as any).name as string ?? '').trim().toLowerCase();
      if (name && !this.authRateLimit.tryConsume(name)) {
        return this.errorRes(req, 'rate_limited', '请求过于频繁，请稍后再试');
      }
    }

    // ── 6. 注入会话身份（防伪造）────────────────────────────────────────────
    if (route.ownVillage) {
      payload = { ...payload, villageId: session.villageId };
    }
    if (route.injectPlayerId) {
      payload = { ...payload, playerId: session.playerId };
    }

    const dispatch = (): Promise<WireResponse> =>
      this.app.commands
        .send({ name: route.command, from: 'gateway', payload })
        .then((result) => {
          // 注册/登录/持久会话恢复成功 → 绑定这条新连接
          if ((req.action === 'Login' || req.action === 'Register' || req.action === 'ResumeSession') && result.ok) {
            const player = (result.payload as any).player;
            const villages: string[] = (player.villages ?? []).map((v: { id: string }) => v.id);
            const current = player.currentVillageId ?? player.capitalVillageId ?? player.villageId;
            this.bindSession(session, player.id, current, villages.length ? villages : [current]);
          }
          // 切村成功 → 只改当前操作村，推送索引保持全部村
          if (req.action === 'SelectVillage' && result.ok) {
            const current = (result.payload as any).currentVillageId as string;
            const player = (result.payload as any).player;
            const villages: string[] = (player?.villages ?? []).map((v: { id: string }) => v.id);
            if (session.playerId && current) {
              this.bindSession(
                session,
                session.playerId,
                current,
                villages.length ? villages : (session.villageIds ?? [current]),
              );
            }
          }
          return {
            v: WIRE_VERSION, type: 'res' as const, id: req.id, ts: this.app.now(),
            ok: result.ok, payload: result.payload,
            ...(result.ok ? {} : { error: { code: result.reason ?? 'failed', msg: result.reason ?? '操作失败' } }),
          };
        });

    // ── 7. 序列化排队 ────────────────────────────────────────────────────────
    // Register 的账号维度串行化在 player.ts 内通过 serialQueue 处理，
    // 此处不重复包装（避免同 key 双层嵌套导致死锁）。

    // ownVillage 请求通过全局共享 serialQueue（key = "village:<id>"）串行排队，
    // 与 Scheduler 定时任务共用同一车道，消除同村写竞争。
    if (route.ownVillage && session.villageId) {
      return this.app.serialQueue.run(`village:${session.villageId}`, dispatch);
    }
    return dispatch();
  }

  // ── 信封校验 ──────────────────────────────────────────────────────────────

  private validateEnvelope(
    raw: unknown,
  ): { ok: true } | { ok: false; code: string; msg: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ok: false, code: 'bad_envelope', msg: '请求必须为 JSON 对象' };
    const r = raw as Record<string, unknown>;
    // 版本校验（严格：低于 MIN 或高于当前版本均拒绝）
    if (typeof r.v !== 'number' || r.v < WIRE_MIN_VERSION || r.v > WIRE_VERSION)
      return { ok: false, code: 'version_mismatch', msg: `协议版本不兼容（期望 ${WIRE_VERSION}，收到 ${r.v}）` };
    if (r.type !== 'req')
      return { ok: false, code: 'bad_envelope', msg: 'type 必须为 "req"' };
    if (typeof r.id !== 'string' || !r.id)
      return { ok: false, code: 'bad_envelope', msg: 'id 必须为非空字符串' };
    if (typeof r.action !== 'string' || !r.action)
      return { ok: false, code: 'bad_envelope', msg: 'action 必须为非空字符串' };
    if (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload))
      return { ok: false, code: 'bad_envelope', msg: 'payload 必须为对象' };
    return { ok: true };
  }

  // ── 会话管理 ──────────────────────────────────────────────────────────────

  private unindexSession(session: Session): void {
    for (const vid of session.villageIds ?? (session.villageId ? [session.villageId] : [])) {
      this.byVillage.get(vid)?.delete(session);
    }
    if (session.playerId) this.byPlayer.get(session.playerId)?.delete(session);
  }

  private bindSession(
    session: Session,
    playerId: string,
    currentVillageId: string,
    allVillageIds: string[],
  ): void {
    this.unindexSession(session);
    session.playerId = playerId;
    session.villageId = currentVillageId;
    session.villageIds = [...new Set(allVillageIds)];
    for (const vid of session.villageIds) {
      let set = this.byVillage.get(vid);
      if (!set) { set = new Set(); this.byVillage.set(vid, set); }
      set.add(session);
    }
    let pset = this.byPlayer.get(playerId);
    if (!pset) { pset = new Set(); this.byPlayer.set(playerId, pset); }
    pset.add(session);
  }

  private subscribeEvents(): void {
    for (const [internalName, pushEvent] of Object.entries(EVENT_TO_PUSH)) {
      this.app.bus.on(internalName, (evt: DomainEvent) => {
        const raw = evt.payload as Record<string, unknown>;
        const villageId = raw?.villageId as string | undefined;
        const playerIds = raw?.playerIds as string[] | undefined;
        // 剥离路由字段，避免把观察者名单泄露给客户端
        const { playerIds: _drop, ...outPayload } = raw;
        const push: WirePush = {
          v: WIRE_VERSION, type: 'push', id: `push-${evt.ts}`, ts: evt.ts,
          event: pushEvent, payload: outPayload,
        };
        if (villageId) this.sendToVillage(villageId, push);
        else if (playerIds?.length) this.sendToPlayers(playerIds, push);
      });
    }
  }

  private sendToPlayers(playerIds: string[], push: WirePush): void {
    const seen = new Set<Session>();
    for (const pid of playerIds) {
      const set = this.byPlayer.get(pid);
      if (!set) continue;
      for (const s of set) {
        if (seen.has(s)) continue;
        seen.add(s);
        try { s.conn.send(push); } catch { /* ignore */ }
      }
    }
  }

  private sendToVillage(villageId: string, push: WirePush): void {
    const set = this.byVillage.get(villageId);
    if (!set) return;
    for (const s of set) {
      try { s.conn.send(push); } catch { /* ignore */ }
    }
  }

  // ── 错误响应构造 ──────────────────────────────────────────────────────────

  private errorRes(req: WireRequest, code: string, msg: string): WireResponse {
    return { v: WIRE_VERSION, type: 'res', id: req.id, ts: this.app.now(), ok: false, payload: {}, error: { code, msg } };
  }

  private makeErrorResponse(id: string, code: string, msg: string): WireResponse {
    return { v: WIRE_VERSION, type: 'res', id, ts: this.app.now(), ok: false, payload: {}, error: { code, msg } };
  }
}
