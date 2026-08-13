/**
 * 数据层：统一刷新、动作提交、推送分发。
 * 视图不直接调 req()——一律走 act()，保证「失败有反馈、成功必刷新」。
 *
 * 刷新策略（不做盲轮询）：
 *  1) 玩家动作后 act() → refreshAll；
 *  2) 服务器推送确认 → refreshAll（人口除外，见下）；
 *  3) 标签页从后台切回 → 补一次；
 *  纯 UI 推进（资源数字/倒计时/人口外插）由 1 秒心跳本地完成，不访问服务器。
 */
import { req, me, selectVillage } from '../api.js';
import { errText } from '../shared/ui/text.js';
import { worldW, worldH } from './config.js';
import type { StoredNotification } from '@slg/shared';
import {
  getCache, setCache, setPopState, getPopState, markResFetched, setPendingTreasures,
  addReport, seedReports, type ReportKind, type StoredReport,
} from './state.js';
import {
  bumpData, bumpReports, bumpSession, showToast, mercCamp, tradeCenter,
  techTree, researchState, putBattle, dropBattle, modals, tab,
  setTaskState, setTaskMarkers,
} from './store.js';
import { notificationText, notificationKind } from '../features/reports/notification-text.js';

let mapCenter: { q: number; r: number } | null = null;
export function getMapCenter(): { q: number; r: number } | null { return mapCenter; }
export function setMapCenter(c: { q: number; r: number } | null): void { mapCenter = c; }

/** 登录态失效时由 App 注册的回调（回登录页）。 */
let onSessionLost: ((msg: string) => void) | null = null;
export function setSessionLostHandler(fn: (msg: string) => void): void { onSessionLost = fn; }

/** 一次性拉齐主界面所需的全部快照。 */
export async function refreshAll(): Promise<void> {
  if (!me) return;
  try {
    const center = mapCenter ?? { q: me.q, r: me.r };
    // 全图模式：一次拉全部非空地块（full=true），之后拖拽/缩放/跳转都是纯视觉变换。
    const [res, vil, army, area, moves, pop, treasures] = await Promise.all([
      req('GetResources'),
      req('GetVillageLayout'),
      req('GetArmy'),
      req('GetArea', { cq: center.q, cr: center.r, r: Math.max(worldW(), worldH()), full: true }),
      req('ListMovements'),
      req('GetPopulation').catch(() => ({ ok: false } as any)),
      req('ListTreasures').catch(() => ({ ok: false } as any)),
    ]);

    const failed = [res, vil, army, area, moves].find((x) => !x.ok);
    if (failed) {
      const code = failed.error?.code ?? 'failed';
      if (code === 'not_logged_in') onSessionLost?.('连接已断开，请重新登录');
      else pushReport(`刷新失败：${errText(code)}`);
      return;
    }

    setCache({
      res: res.payload, vil: vil.payload, army: army.payload,
      area: area.payload, moves: moves.payload,
      treasures: treasures.ok ? treasures.payload : null,
    });
    setPendingTreasures(treasures.ok && (treasures.payload as any)?.pending ? (treasures.payload as any).pending : []);
    markResFetched();
    if (pop.ok) applyPopPayload(pop.payload);
    bumpData();

    // 任务快照（任务条常驻村庄页，登录/刷新即拉取）
    const taskRes = await req('task.GetState').catch(() => null);
    if (taskRes?.ok) setTaskState(taskRes.payload);
  } catch {
    pushReport('刷新失败：网络连接异常');
  }
}

/**
 * GetPopulation / PopulationChanged 的载荷 → PopSnapshot。
 * `merge=true` 用于 PopulationChanged：它的 payload 是**增量**，缺失字段必须沿用
 * 旧快照，否则会把上限、繁荣度等一整片数值误清成 0。
 */
function applyPopPayload(p: any, merge = false): void {
  const prev = merge ? getPopState() : null;
  const pick = <T>(v: T | undefined | null, fb: T): T => (v == null ? fb : v);

  const currentPop = Number(pick(p.currentPop, prev?.currentPop ?? 0));
  const soldierPop = Number(pick(p.soldierPop, prev?.soldierPop ?? 0));
  const hardCap = Number(pick(p.hardCap, prev?.hardCap ?? 0));
  const availableLabor = Number(pick(p.availableLabor, prev?.availableLabor ?? currentPop));
  const prosperityMult = Number(pick(p.prosperityMult, prev?.prosperityMult ?? 1));

  // inFamine：服务端权威字段优先，其次按事件推断，最后沿用旧值
  const evTag: string | undefined = p.event;
  const inFamine = p.inFamine != null ? !!p.inFamine
    : evTag === 'famine' || evTag === 'starved' ? true
      : evTag === 'recovery' ? false
        : (prev?.inFamine ?? false);

  setPopState({
    currentPop,
    soldierPop,
    totalPop: Number(pick(p.totalPop, prev?.totalPop ?? currentPop + soldierPop)),
    trainingPop: Number(pick(p.trainingPop, prev?.trainingPop ?? 0)),
    hardCap,
    availableLabor,
    popCeiling: Number(pick(p.popCeiling, prev?.popCeiling ?? hardCap)),
    laborRatio: Number(pick(p.laborRatio, prev?.laborRatio ?? 0)),
    prosperityBonus: Number(pick(p.prosperityBonus, prev?.prosperityBonus ?? 0)),
    prosperityMult,
    growthPerHour: Number(pick(p.growthPerHour, prev?.growthPerHour ?? 0)),
    potentialGrowthPerHour: Number(pick(p.potentialGrowthPerHour, prev?.potentialGrowthPerHour ?? 0)),
    mobilizeCap: Number(pick(p.mobilizeCap, prev?.mobilizeCap ?? 0)),
    // 露天仓库溢出扣减系数（0~1，四资源均溢率）：服务端 publicPayload 携带，逐字段 pick 时必须带上
    overflowRatio: Number(pick(p.overflowRatio, prev?.overflowRatio ?? 0)),
    popProsperityFullRatio: pick(p.popProsperityFullRatio, prev?.popProsperityFullRatio),
    mainLevel: Number(pick(p.mainLevel, prev?.mainLevel ?? 1)),
    inFamine,
    goldPerHour: Number(pick(p.goldPerHour, prev?.goldPerHour ?? 0)),
    civilianCropPerHour: Number(pick(p.civilianCropPerHour, prev?.civilianCropPerHour ?? 0)),
    // 以下 4 个字段服务端快照不携带（GetPopulation 无 wounded/garrisonPop/lambdaRatio/cropDeficitRate），
    // 由客户端用 soldierPop / 旧快照兜底；PopulationChanged merge 时沿用 prev 旧值。
    garrisonPop: Number(pick(p.garrisonPop, prev?.garrisonPop ?? soldierPop)),
    lambdaRatio: Number(pick(p.lambdaRatio, prev?.lambdaRatio ?? 0)),
    wounded: {
      total: Number(pick(p.wounded?.total, prev?.wounded?.total ?? 0)),
      entries: (p.wounded?.entries ?? prev?.wounded?.entries ?? []) as any[],
    },
    cropDeficitRate: Number(pick(p.cropDeficitRate, prev?.cropDeficitRate ?? 0)),
    laborMults: pick(p.laborMults, prev?.laborMults) ?? {
      production: prosperityMult, build: prosperityMult, train: prosperityMult,
      research: prosperityMult, smithy: prosperityMult,
    },
    softLimit: Number(pick(p.softLimit, prev?.softLimit ?? availableLabor)),
    lastTick: Number(pick(p.lastTick, prev?.lastTick ?? Date.now())),
    fetchedAt: Date.now(),
  });
}

function pushReport(line: string, kind: ReportKind = 'info'): void {
  addReport(line, kind);
  bumpReports();
}

/**
 * 统一动作提交：成功后刷新，失败转中文提示。
 * @param p     req(...) 的 Promise
 * @param opts  okToast=成功提示语；onOk=成功回调（拿到 payload）
 */
export async function act(
  p: Promise<any>,
  opts?: { okToast?: string; onOk?: (payload: any) => void; silent?: boolean },
): Promise<boolean> {
  try {
    const res = await p;
    if (!res.ok) {
      const code = res.error?.code;
      showToast(errText(code), 'bad');
      if (code !== 'queue_full' && code !== 'queue_busy') pushReport(`操作失败：${errText(code)}`);
      await refreshAll();
      return false;
    }
    if (opts?.okToast) showToast(opts.okToast, 'ok');
    opts?.onOk?.(res.payload);
    if (!opts?.silent) await refreshAll();
    return true;
  } catch {
    showToast('网络连接异常', 'bad');
    return false;
  }
}

/** 重拉雇佣兵营地快照（营地弹层打开时用）。 */
export async function reloadMercCamp(): Promise<void> {
  const r = await req('GetMercCamp').catch(() => ({ ok: false } as any));
  if (r.ok) mercCamp.value = r.payload;
}

/** 重拉贸易中心快照。 */
export async function reloadTrade(): Promise<void> {
  const r = await req('GetTradeCenter').catch(() => ({ ok: false } as any));
  if (r.ok) tradeCenter.value = r.payload;
}

/** 重拉科研快照（科技树 + 学院状态）。科技页与学院弹窗都订阅这两个信号。 */
export async function reloadResearch(): Promise<void> {
  const [tree, state] = await Promise.all([
    req('GetTechTree').catch(() => ({ ok: false } as any)),
    req('GetState').catch(() => ({ ok: false } as any)),
  ]);
  if (tree.ok) techTree.value = tree.payload;
  if (state.ok) researchState.value = state.payload;
}

/** 登录后拉一次历史通知，播种战报列表。 */
export async function hydrateReports(): Promise<void> {
  try {
    const res = await req('GetNotifications');
    if (!res.ok) return;
    const list = ((res.payload as any).notifications ?? []) as StoredNotification[];
    const seeded: StoredReport[] = [];
    for (const n of list) {
      const text = notificationText(n.event, n.payload);
      if (text) seeded.push({ text, kind: notificationKind(n.event, n.payload), ts: n.ts });
    }
    seedReports(seeded);
    bumpReports();
  } catch {
    pushReport('历史战报加载失败：网络连接异常');
  }
}

/** 推送分发：把服务端事件变成战报文案 + 必要的数据刷新。 */
export function handlePush(event: string, payload: any): void {
  // 战报文案 + 语义分类（分类来自事件名，不靠猜文案）
  const text = notificationText(event, payload);
  if (text) pushReport(text, notificationKind(event, payload));

  // 战斗实时快照
  if (event === 'BattleTick' || event === 'BattleStarted') putBattle(payload);
  if (event === 'BattleEnded' && payload?.battleId) dropBattle(payload.battleId);

  // 人口变化很频繁：只校正快照，绝不触发 refreshAll，
  // 否则会形成 push → refresh → settle → emit 的正反馈死循环。
  if (event === 'PopulationChanged') {
    applyPopPayload(payload, true);
    bumpData();
    return;
  }

  if (event === 'VillageFounded' && me?.villageId) {
    void selectVillage(me.villageId).then((r) => { if (r.ok) bumpSession(); });
  }

  if (event === 'MercenaryCampUpdated') { void reloadMercCamp(); return; }
  if (event === 'TradeCenterUpdated') { void reloadTrade(); return; }
  // 科研点每次判定都会推 RpChanged，频率高：只重拉科研快照，不做整体刷新
  if (event === 'RpChanged') { void reloadResearch(); return; }
  if (event === 'TechCompleted') { void reloadResearch(); }

  // 任务推送：直接写信号，不触发整页刷新（任务更新频繁且与其它数据解耦）
  if (event === 'TaskListChanged') { setTaskState(payload); return; }
  if (event === 'TaskMapUpdated') { setTaskMarkers(payload); return; }

  void refreshAll();
}

/** 当前是否在某个页签（供推送时判断是否值得刷新次级数据）。 */
export function isTab(k: string): boolean { return tab.value === k; }
/** 是否有弹层打开。 */
export function modalOpen(): boolean { return modals.value.length > 0; }
/** 主缓存读取的语法糖。 */
export function cache(): any { return getCache(); }
