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
import { req, me, selectVillage, applyMe, applyVillageRename } from '../api.js';
import { errText } from '../shared/ui/text.js';
import { worldW, worldH } from './config.js';
import type { StoredNotification } from '@slg/shared';
import {
  getCache, setCache, setPopState, getPopState, markResFetched, setPendingTreasures,
  addReport, seedReports, patchMovement, dropMovement, type ReportKind, type StoredReport,
} from './state.js';
import {
  bumpData, bumpReports, bumpSession, showToast, mercCamp, tradeCenter,
  techTree, researchState, putBattle, dropBattle, modals, tab,
  setTaskState, setPlayerTaskState, setTaskMarkers, foreignMoves, mapCenter, mapAreaStale,
  beginVillageSwitch, endVillageSwitch, patchForeignArmy, dropForeignArmy,
  kingdomState,
} from './store.js';
import type { MarchStepPush, MarchRemovedPush, ForeignArmyStepPush, ForeignArmyRemovedPush } from '@slg/shared';
import { notificationText, notificationKind } from '../features/reports/notification-text.js';

let mapCenterLegacy: { q: number; r: number } | null = null;

/**
 * GM 可直接调整村庄坐标/名称；玩家快照不会主动推送这些字段。
 * 地图区域中自己的村庄由 World 实时下发，因此每次完整刷新都用它校准本地村庄列表，
 * 避免旧标签和旧坐标让玩家误以为两个村在同一格。
 */
function reconcileVillagesFromArea(areaPayload: any): void {
  if (!me?.villages?.length) return;
  const tiles = Array.isArray(areaPayload?.tiles) ? areaPayload.tiles : [];
  const byId = new Map<string, { q: number; r: number; name?: string }>();
  for (const tile of tiles) {
    if (tile?.kind !== 'village' || typeof tile.refId !== 'string') continue;
    if (tile.visibility === 'unexplored') continue;
    const q = Number(tile.q), r = Number(tile.r);
    if (Number.isFinite(q) && Number.isFinite(r)) byId.set(tile.refId, { q, r, name: typeof tile.name === 'string' ? tile.name : undefined });
  }
  let changed = false;
  const villages = me.villages.map((v) => {
    const tile = byId.get(v.id);
    if (!tile) return v;
    const next = {
      ...v,
      q: tile.q,
      r: tile.r,
      ...(tile.name ? { name: tile.name } : {}),
    };
    if (next.q !== v.q || next.r !== v.r || next.name !== v.name) changed = true;
    return next;
  });
  if (!changed) return;
  const current = villages.find((v) => v.id === me?.villageId);
  applyMe({
    ...me,
    villages,
    ...(current ? { q: current.q, r: current.r } : {}),
  });
}

export function getMapCenter(): { q: number; r: number } | null {
  return mapCenter.value ?? mapCenterLegacy;
}
export function setMapCenter(c: { q: number; r: number } | null): void {
  mapCenter.value = c;
  mapCenterLegacy = c;
}
/** 登录态失效时由 App 注册的回调（回登录页）。 */
let onSessionLost: ((msg: string) => void) | null = null;
export function setSessionLostHandler(fn: (msg: string) => void): void { onSessionLost = fn; }

export interface RefreshOptions {
  includeArea?: boolean;
  waitForTasks?: boolean;
  /** 后台补齐数据时不把瞬时网络错误写进玩家战报。 */
  silent?: boolean;
}

/**
 * 首屏关键快照：只取资源和村庄布局。
 *
 * Gateway 会把同一村庄的请求放进串行车道。首屏原来一次发十多个请求，
 * 其中全量地图和历史任务会让后续请求在 10 秒客户端超时之前一直排队，
 * 用户看到的就是长时间 loading 以及误报的“网络连接异常”。
 * 先提交这两个渲染村庄页必需的快照，地图/军队/任务等由后台刷新补齐。
 */
export async function refreshInitial(): Promise<boolean> {
  if (!me) return false;
  try {
    // 人口和声望同样属于首屏 HUD 的关键快照，不能等完整地图请求结束后才加载。
    // 每个请求单独兜底：某一个读请求超时不能把已经成功的其它快照一起丢掉。
    const safe = (action: string) => req(action).catch(() => null);
    const [res, vil, pop, reputation] = await Promise.all([
      safe('GetResources'),
      safe('GetVillageLayout'),
      safe('GetPopulation'),
      safe('GetReputation'),
    ]);
    const failed = [res, vil, pop, reputation].find((x) => x && !x.ok);
    const failedCode = failed?.error?.code;
    if (failedCode === 'not_logged_in') {
      onSessionLost?.('连接已断开，请重新登录');
      return false;
    }
    const hasCore = Boolean(res?.ok || vil?.ok || pop?.ok || reputation?.ok);
    if (!hasCore) {
      pushReport(`刷新失败：${errText(failedCode ?? 'network_error')}`);
      return false;
    }
    setCache({
      ...getCache(),
      ...(res?.ok ? { res: res.payload } : {}),
      ...(vil?.ok ? { vil: vil.payload } : {}),
      ...(reputation?.ok ? { reputation: reputation.payload } : {}),
    });
    if (pop?.ok) applyPopPayload(pop.payload);
    if (res?.ok) markResFetched();
    // 地图尚未补齐；若玩家立刻切到地图页，MapScreen 会主动重试全量区域。
    mapAreaStale.value = true;
    bumpData();
    return true;
  } catch {
    pushReport('刷新失败：网络连接异常');
    return false;
  }
}

let refreshInFlight: Promise<void> | null = null;
let queuedRefresh: RefreshOptions | null = null;

export function mergeRefreshOptions(a: RefreshOptions, b: RefreshOptions): RefreshOptions {
  return {
    includeArea: a.includeArea !== false || b.includeArea !== false,
    waitForTasks: a.waitForTasks === true || b.waitForTasks === true,
    // 只要有一个前台请求需要反馈，就保留错误提示；纯后台刷新才静默。
    silent: a.silent === true && b.silent === true,
  };
}

/** 一次性拉齐主界面所需的全部快照，并合并同时到来的刷新请求。 */
export function refreshAll(options: RefreshOptions = {}): Promise<void> {
  if (refreshInFlight) {
    queuedRefresh = queuedRefresh ? mergeRefreshOptions(queuedRefresh, options) : options;
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    let next: RefreshOptions | null = options;
    while (next) {
      const current = next;
      next = null;
      await performRefreshAll(current);
      if (queuedRefresh) {
        next = queuedRefresh;
        queuedRefresh = null;
      }
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefreshAll(options: RefreshOptions = {}): Promise<void> {
  if (!me) return;
  const includeArea = options.includeArea !== false;
  try {
    const center = getMapCenter() ?? { q: me.q, r: me.r };
    const safe = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
    // 全图模式：一次拉全部非空地块（full=true），之后拖拽/缩放/跳转都是纯视觉变换。
    const [res, vil, army, area, moves, playerMoves, pop, treasures, reputation, alchemy, kingdom] = await Promise.all([
      safe(req('GetResources')),
      safe(req('GetVillageLayout')),
      safe(req('GetArmy')),
      includeArea
        ? safe(req('GetArea', { cq: center.q, cr: center.r, r: Math.max(worldW(), worldH()), full: true }))
        : Promise.resolve(null),
      safe(req('ListMovements')),
      safe(req('ListPlayerMovements')),
      safe(req('GetPopulation')),
      safe(req('ListTreasures')),
      safe(req('GetReputation')),
      safe(req('GetAlchemy')),
      safe(req('GetKingdomState')),
    ]);

    const failed = [res, vil, army, ...(includeArea ? [area] : []), moves, playerMoves]
      .find((x) => !x?.ok);
    if (failed?.error?.code === 'not_logged_in') {
      onSessionLost?.('连接已断开，请重新登录');
      return;
    }
    const hasSnapshot = [res, vil, army, area, moves, playerMoves, pop, treasures, reputation, alchemy, kingdom]
      .some((x) => x?.ok);
    if (!hasSnapshot) {
      if (!options.silent) pushReport('刷新失败：网络连接异常');
      return;
    }
    if (failed && !options.silent) {
      const code = failed.error?.code ?? '网络连接异常';
      pushReport(`刷新失败：${errText(code)}`);
    }

    if (area?.ok) reconcileVillagesFromArea(area.payload);
    setCache({
      ...getCache(),
      ...(res?.ok ? { res: res.payload } : {}),
      ...(vil?.ok ? { vil: vil.payload } : {}),
      ...(army?.ok ? { army: army.payload } : {}),
      ...(area?.ok ? { area: area.payload } : {}),
      ...(moves?.ok ? { moves: moves.payload } : {}),
      ...(playerMoves?.ok ? { playerMoves: playerMoves.payload } : {}),
      ...(treasures?.ok ? { treasures: treasures.payload } : {}),
      ...(reputation?.ok ? { reputation: reputation.payload } : {}),
      ...(alchemy?.ok ? { alchemy: alchemy.payload } : {}),
      ...(kingdom?.ok ? { kingdom: kingdom.payload } : {}),
    });
    if (kingdom?.ok) kingdomState.value = kingdom.payload;
    if (area?.ok) mapAreaStale.value = false;
    if (treasures?.ok) {
      setPendingTreasures((treasures.payload as any)?.pending ? (treasures.payload as any).pending : []);
    }
    if (res?.ok) markResFetched();
    if (pop?.ok) applyPopPayload(pop.payload);
    bumpData();
    void refreshForeignMoves();

    // 任务快照按玩家聚合；地图仍按 villageId 保留任务营地标记。
    const taskRefresh = reloadPlayerTasks();
    if (options.waitForTasks !== false) await taskRefresh;
  } catch {
    if (!options.silent) pushReport('刷新失败：网络连接异常');
  }
}

/** 进入地图页时补拉此前为降低切村等待而跳过的整张地图。 */
export async function refreshMapArea(): Promise<boolean> {
  if (!me) return false;
  try {
    const center = getMapCenter() ?? { q: me.q, r: me.r };
    const area = await req('GetArea', { cq: center.q, cr: center.r, r: Math.max(worldW(), worldH()), full: true });
    if (!area.ok) return false;
    reconcileVillagesFromArea(area.payload);
    setCache({ ...getCache(), area: area.payload });
    mapAreaStale.value = false;
    bumpData();
    return true;
  } catch {
    return false;
  }
}

/** 切换当前操作村庄：统一互斥、刷新和完成时机，避免各组件各自实现产生竞态。 */
export async function switchVillage(villageId: string): Promise<{ ok: boolean; error?: string }> {
  if (!me || !villageId || villageId === me.villageId) return { ok: true };
  const target = me.villages?.find((v) => v.id === villageId);
  if (!target) return { ok: false, error: 'village_not_found' };
  if (!beginVillageSwitch(target.id, target.name)) return { ok: false, error: 'switch_in_progress' };
  try {
    const result = await selectVillage(villageId);
    if (!result.ok) return result;
    bumpSession();
    const onMap = tab.value === 'map';
    if (!onMap) mapAreaStale.value = true;
    // 任务聚合不会阻塞当前村庄数据可用；它在后台完成，避免切村卡住页面。
    await refreshAll({ includeArea: onMap, waitForTasks: false });
    return { ok: true };
  } finally {
    endVillageSwitch();
  }
}

/** 轻量刷新玩家任务板，供任务推送使用。 */
export async function reloadPlayerTasks(): Promise<void> {
  const taskRes = await req('task.GetPlayerState').catch(() => null);
  if (taskRes?.ok) setPlayerTaskState(taskRes.payload);
}

export async function reloadKingdom(): Promise<void> {
  const result = await req('GetKingdomState').catch(() => null);
  if (!result?.ok) return;
  kingdomState.value = result.payload;
  setCache({ ...getCache(), kingdom: result.payload });
  bumpData();
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
      research: prosperityMult,
    },
    softLimit: Number(pick(p.softLimit, prev?.softLimit ?? availableLabor)),
    lastTick: Number(pick(p.lastTick, prev?.lastTick ?? Date.now())),
    fetchedAt: Date.now(),
  });
}

function pushReport(line: string, kind: ReportKind = 'info', details?: Record<string, any>): void {
  addReport(line, kind, Date.now(), details);
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

/** 重拉视野内的外国军队（脱敏）。地图页切换时 / 30s 兜底 / MarchStep 后防御触发。 */
export async function refreshForeignMoves(): Promise<void> {
  if (!me) return;
  const r = await req('ListForeign').catch(() => ({ ok: false } as any));
  if (r.ok) foreignMoves.value = r.payload;
}

/** 只刷新己方行军与实时来袭预警，不拉资源、建筑、任务或地图大包。 */
export async function refreshMovements(): Promise<void> {
  if (!me) return;
  const [moves, playerMoves] = await Promise.all([
    req('ListMovements').catch(() => ({ ok: false } as any)),
    req('ListPlayerMovements').catch(() => ({ ok: false } as any)),
  ]);
  if (!moves.ok && !playerMoves.ok) return;
  setCache({
    ...getCache(),
    ...(moves.ok ? { moves: moves.payload } : {}),
    ...(playerMoves.ok ? { playerMoves: playerMoves.payload } : {}),
  });
  bumpData();
}

/** 只刷新军队页需要的驻军/训练快照，避免为打开军队页拉整包村庄数据。 */
export async function refreshArmySnapshot(): Promise<boolean> {
  if (!me) return false;
  const result = await req('GetArmy').catch(() => null);
  if (!result?.ok) return false;
  setCache({ ...getCache(), army: result.payload });
  bumpData();
  return true;
}

/** 只刷新宝物栏及待领取宝物；村庄页和报告页均按需使用。 */
export async function refreshTreasures(): Promise<boolean> {
  if (!me) return false;
  const result = await req('ListTreasures').catch(() => null);
  if (!result?.ok) return false;
  const payload = result.payload as any;
  setCache({ ...getCache(), treasures: payload });
  setPendingTreasures(Array.isArray(payload?.pending) ? payload.pending : []);
  bumpData();
  return true;
}

/** 村庄页的次级面板数据（炼金炉等）按需加载，不阻塞人口/建筑首屏。 */
export async function refreshVillageSecondary(): Promise<boolean> {
  if (!me) return false;
  const [treasures, alchemy] = await Promise.all([
    req('ListTreasures').catch(() => null),
    req('GetAlchemy').catch(() => null),
  ]);
  const next = { ...getCache() };
  let changed = false;
  if (treasures?.ok) {
    next.treasures = treasures.payload;
    const pending = (treasures.payload as any)?.pending;
    setPendingTreasures(Array.isArray(pending) ? pending : []);
    changed = true;
  }
  if (alchemy?.ok) {
    next.alchemy = alchemy.payload;
    changed = true;
  }
  if (changed) {
    setCache(next);
    bumpData();
  }
  return changed;
}

let _foreignDebounceTimer: number | null = null;
/** 在 delayMs 后触发一次 refreshForeignMoves（debounce：重复调用只保留最后一次）。 */
export function scheduleForeignRefresh(delayMs = 1000): void {
  if (_foreignDebounceTimer !== null) window.clearTimeout(_foreignDebounceTimer);
  _foreignDebounceTimer = window.setTimeout(() => {
    _foreignDebounceTimer = null;
    void refreshForeignMoves();
  }, delayMs);
}

/** 登录后拉一次历史通知，播种战报列表。 */
export async function hydrateReports(options: { notifyOnError?: boolean } = {}): Promise<void> {
  try {
    const res = await req('GetNotifications');
    if (!res.ok) return;
    const list = ((res.payload as any).notifications ?? []) as StoredNotification[];
    const seeded: StoredReport[] = [];
    for (const n of list) {
      const text = notificationText(n.event, n.payload);
      if (text) {
        const details = n.event === 'BattleStarted' || n.event === 'BattleEnded' ? n.payload : undefined;
        seeded.push({ text, kind: notificationKind(n.event, n.payload), ts: n.ts, ...(details ? { details } : {}) });
      }
    }
    seedReports(seeded);
    bumpReports();
  } catch {
    if (options.notifyOnError !== false) pushReport('历史战报加载失败：网络连接异常');
  }
}

/** 推送分发：把服务端事件变成战报文案 + 必要的数据刷新。 */
export function handlePush(event: string, payload: any): void {
  // 战报文案 + 语义分类（分类来自事件名，不靠猜文案）
  const text = notificationText(event, payload);
  if (text) {
    const details = event === 'BattleStarted' || event === 'BattleEnded' ? payload : undefined;
    pushReport(text, notificationKind(event, payload), details);
  }

  // 战斗实时快照
  if (event === 'BattleTick' || event === 'BattleStarted') putBattle(payload);
  if (event === 'BattleEnded' && payload?.battleId) dropBattle(payload.battleId);
  if (event === 'BattleCancelled') {
    if (payload?.battleId) dropBattle(payload.battleId);
    void refreshMovements();
    return;
  }

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
  // 村名由 Player 模块作为玩家维度推送；刷新地图区域缓存，避免选中格/名称标签残留旧值。
  if (event === 'VillageRenamed') {
    applyVillageRename(String(payload?.villageId ?? ''), String(payload?.name ?? ''));
    void refreshAll();
    return;
  }

  if (event === 'MercenaryCampUpdated') { void reloadMercCamp(); return; }
  if (event === 'TradeCenterUpdated') { void reloadTrade(); return; }
  if (event === 'AlchemyUpdated') { void refreshAll(); return; }
  // 科研点每次判定都会推 RpChanged，频率高：只重拉科研快照，不做整体刷新
  if (event === 'RpChanged') { void reloadResearch(); return; }
  if (event === 'TechCompleted') { void reloadResearch(); }

  // 任务推送：直接写信号，不触发整页刷新（任务更新频繁且与其它数据解耦）
  if (event === 'TaskListChanged') { setTaskState(payload); void reloadPlayerTasks(); return; }
  if (event === 'TaskMapUpdated') { setTaskMarkers(payload); return; }
  if (event === 'KingdomUpdated') { void reloadKingdom(); return; }

  // 来袭预警是当前视野的实时派生状态：只重拉行军，不写入战报。
  if (event === 'IncomingWarningChanged') {
    void refreshMovements();
    scheduleForeignRefresh(0);
    return;
  }

  // 行军逐格推送：增量合并，避免 refreshAll 开销；1s 后补一次外国军队视野
  if (event === 'MarchStep') {
    patchMovement(payload as MarchStepPush);
    bumpData();
    scheduleForeignRefresh(1000);
    return;
  }
  if (event === 'MarchRemoved') {
    dropMovement((payload as MarchRemovedPush).id);
    bumpData();
    return;
  }
  if (event === 'ForeignArmyStep') {
    patchForeignArmy((payload as ForeignArmyStepPush).army);
    bumpData();
    return;
  }
  if (event === 'ForeignArmyRemoved') {
    dropForeignArmy((payload as ForeignArmyRemovedPush).id);
    bumpData();
    return;
  }

  void refreshAll();
}

/** 当前是否在某个页签（供推送时判断是否值得刷新次级数据）。 */
export function isTab(k: string): boolean { return tab.value === k; }
/** 是否有弹层打开。 */
export function modalOpen(): boolean { return modals.value.length > 0; }
/** 主缓存读取的语法糖。 */
export function cache(): any { return getCache(); }
