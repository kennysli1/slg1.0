import type { WireRequest, WireResponse, WirePush, DomainEvent } from '@slg/shared';
import { WIRE_VERSION } from '@slg/shared';
import type { GameApp } from '../app.js';
import { aggregateManifests, type ModuleManifest } from './manifest.js';
import { PlayerModule } from '../modules/player.js';
import { EconomyModule } from '../modules/economy.js';
import { BuildingModule } from '../modules/building.js';
import { MilitaryModule } from '../modules/military.js';
import { WorldModule } from '../modules/world.js';
import { PveModule } from '../modules/pve.js';
import { MovementModule } from '../modules/movement.js';
import { MetaModule } from '../modules/meta.js';

/**
 * 接入层 · Gateway（唯一翻译官 + 多人会话管理）
 * 对应设计文档 03_架构总览.md 第三节、04_通信格式规范.md(两边界衔接)
 *
 * 职责：
 *  - 维护每个连接的会话身份（playerId / villageId）。
 *  - 把外部 Request(action) 翻译成内部 Command；对"自己村"的操作强制注入会话的
 *    villageId（玩家不能伪造别人的村做操作 → 安全）。
 *  - 订阅内部 Event，按事件 payload 里的 villageId **定向推送**给对应玩家（不再广播）。
 *
 * 路由表来源（阶段C）：由各模块的 static MANIFEST 汇总生成，不再手工维护。
 * 新增一个 action 只需在对应模块 manifest 加一行，避免"实现了但网关漏配"。
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
  villageId?: string;
}

/** 所有领域模块的 manifest（新增模块在此登记即可被网关汇总）。 */
const MODULE_MANIFESTS: ModuleManifest[] = [
  PlayerModule.MANIFEST,
  MetaModule.MANIFEST,
  EconomyModule.MANIFEST,
  BuildingModule.MANIFEST,
  MilitaryModule.MANIFEST,
  WorldModule.MANIFEST,
  PveModule.MANIFEST,
  MovementModule.MANIFEST,
];

const { actionRoutes: ACTION_ROUTES, eventToPush: EVENT_TO_PUSH } = aggregateManifests(MODULE_MANIFESTS);

export class Gateway {
  private sessions = new Set<Session>();
  /** villageId → 会话集合（同一玩家可能多端登录）。用于定向推送。 */
  private byVillage = new Map<string, Set<Session>>();

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
    if (session.villageId) this.byVillage.get(session.villageId)?.delete(session);
  }

  async handleRequest(req: WireRequest, session: Session): Promise<WireResponse> {
    const route = ACTION_ROUTES[req.action];
    if (!route) return this.errorRes(req, 'unknown_action', `未知动作: ${req.action}`);

    if (route.needAuth && !session.playerId) {
      return this.errorRes(req, 'not_logged_in', '请先登录');
    }

    // 自己村的操作：强制用会话 villageId，防止伪造他人村
    let payload = req.payload;
    if (route.ownVillage) {
      payload = { ...req.payload, villageId: session.villageId };
    }

    const result = await this.app.commands.send({ name: route.command, from: 'gateway', payload });

    // 注册/登录成功 → 绑定会话身份
    if ((req.action === 'Login' || req.action === 'Register') && result.ok) {
      const player = (result.payload as any).player;
      this.bindSession(session, player.id, player.villageId);
    }

    return {
      v: WIRE_VERSION, type: 'res', id: req.id, ts: this.app.now(),
      ok: result.ok, payload: result.payload,
      ...(result.ok ? {} : { error: { code: result.reason ?? 'failed', msg: result.reason ?? '操作失败' } }),
    };
  }

  private bindSession(session: Session, playerId: string, villageId: string): void {
    // 解绑旧村（若重登）
    if (session.villageId) this.byVillage.get(session.villageId)?.delete(session);
    session.playerId = playerId;
    session.villageId = villageId;
    let set = this.byVillage.get(villageId);
    if (!set) { set = new Set(); this.byVillage.set(villageId, set); }
    set.add(session);
  }

  private subscribeEvents(): void {
    for (const [internalName, pushEvent] of Object.entries(EVENT_TO_PUSH)) {
      this.app.bus.on(internalName, (evt: DomainEvent) => {
        const villageId = (evt.payload as any)?.villageId;
        const push: WirePush = {
          v: WIRE_VERSION, type: 'push', id: `push-${evt.ts}`, ts: evt.ts,
          event: pushEvent, payload: evt.payload,
        };
        // 定向：只推给拥有该村的连接
        if (villageId) this.sendToVillage(villageId, push);
      });
    }
  }

  private sendToVillage(villageId: string, push: WirePush): void {
    const set = this.byVillage.get(villageId);
    if (!set) return;
    for (const s of set) {
      try { s.conn.send(push); } catch { /* ignore */ }
    }
  }

  private errorRes(req: WireRequest, code: string, msg: string): WireResponse {
    return { v: WIRE_VERSION, type: 'res', id: req.id, ts: this.app.now(), ok: false, payload: {}, error: { code, msg } };
  }
}
