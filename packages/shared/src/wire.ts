/**
 * 边界① · 框架外信封：服务器 ↔ 客户端（跨网络）
 * 对应设计文档 04_通信格式规范.md 边界①
 *
 * 核心原则：固定外层信封，自由内层 payload。
 * 三类消息：Request(客户端→服务器) / Response(应答) / Push(服务器主动推)
 */

/** 所有外部消息共享的信封字段 */
export interface WireEnvelope {
  /** 协议版本号，用于兼容演进 */
  v: number;
  /** 消息唯一 id：请求-响应配对、去重 */
  id: string;
  /** 服务器时间戳(ms)，客户端用于对齐倒计时 */
  ts: number;
}

/** 1. Request：客户端 → 服务器，"我要做某事/要数据" */
export interface WireRequest extends WireEnvelope {
  type: 'req';
  /** 动作名，决定 payload 结构。例：UpgradeBuilding / GetVillage */
  action: string;
  /** 业务内容，结构由 action 定义，自由 */
  payload: Record<string, unknown>;
}

/** 2. Response：服务器 → 客户端，对某个 Request 的应答 */
export interface WireResponse extends WireEnvelope {
  type: 'res';
  /** 对应 Request 的 id */
  id: string;
  ok: boolean;
  payload: Record<string, unknown>;
  /** ok=false 时说明原因 */
  error?: { code: string; msg: string };
}

/** 3. Push：服务器 → 客户端，主动推送 */
export interface WirePush extends WireEnvelope {
  type: 'push';
  /** 事件名，决定 payload 结构。例：BuildDone / UnderAttack */
  event: string;
  payload: Record<string, unknown>;
}

export type WireMessage = WireRequest | WireResponse | WirePush;

/** 当前协议版本 */
export const WIRE_VERSION = 1;

/** 服务端持久化的单条通知/战报（结构化存储，展示文案由客户端负责）。 */
export interface StoredNotification {
  id: string;
  /** 对外推送事件名（与 WirePush.event 一致，如 BattleEnded / BuildingUpgraded）。 */
  event: string;
  payload: Record<string, unknown>;
  /** 事件发生时刻(ms)，来自源事件的 ts。 */
  ts: number;
}
