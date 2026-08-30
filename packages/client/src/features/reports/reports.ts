/** 报告页：战报列表 + 服务端推送事件 → 战报文案。 */
import { secStr } from '../../shared/utils/format.js';
import { fieldInfo, buildingInfo, resInfo } from '../../app/config.js';
import { getReports, addReport, seedReports, setBattleSnapshot, clearBattleSnapshot, getPopState, setPopState, type StoredReport } from '../../app/state.js';
import { unitName } from '../army/army.js';
import type { StoredNotification } from '@slg/shared';
import { escapeHtml } from '../../shared/ui/widgets.js';
import { fmt } from '../../shared/utils/format.js';
import { rerenderPopPanel } from '../village/population.js';

/** 兼容新旧侦察战报：新载荷按兵种记录战损，旧载荷仍可能是总数。 */
function troopMapText(value: unknown): string {
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([code, raw]) => [code, Math.max(0, Math.floor(Number(raw) || 0))] as const)
      .filter(([, count]) => count > 0);
    return entries.map(([code, count]) => `${unitName(code)}${fmt(count)}`).join('、') || '无';
  }
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return count > 0 ? fmt(count) : '无';
}

export function renderReports(): string {
  const reports = getReports();
  if (!reports.length) return `<div class="empty empty-hero">
    <div class="empty-icon">📜</div>
    <div class="empty-title">战报空空如也</div>
    <div class="empty-sub">去地图掠夺野怪或进攻其他玩家<br/>胜负、损失与战利品都会记录在这里</div>
  </div>`;
  return reports.map((r) => `<div class="report">${escapeHtml(r)}</div>`).join('');
}

/**
 * 把一条推送事件转成战报文案。
 * BattleTick 返回 null（走实时快照，不写战报流水）。
 */
export function notificationText(event: string, payload: any, ts?: number): string | null {
  const time = ts ? `[${new Date(ts).toLocaleTimeString()}] ` : '';
  if (event === 'BuildingBuilt' || event === 'BuildingUpgraded' || event === 'BuildingRepaired') {
    const name = fieldInfo(payload.kind).name ?? buildingInfo(payload.kind).name ?? payload.kind;
    const verb = event === 'BuildingBuilt' ? '建造完成' : event === 'BuildingRepaired' ? '修复完成' : '升级完成';
    return `${time}✅ ${verb}：${name} → ${payload.level}级`;
  } else if (event === 'TroopTrained') {
    return `${time}🎯 训练出 ${unitName(payload.unit)}（共${payload.total}）`;
  } else if (event === 'MarchSent') {
    return `${time}🏃 出征已派出`;
  } else if (event === 'BattleStarted') {
    if (payload.side === 'attacker') return `${time}⚔️ 战斗开始！攻${payload.attackPower} vs 防${payload.defensePower}，交战中…`;
    return `${time}🛡️ 遭遇进攻！攻${payload.attackPower} vs 防${payload.defensePower}，正在防守…`;
  } else if (event === 'BattleEnded') {
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    const mine = payload.side === 'attacker' ? payload.attackerLosses : payload.defenderLosses;
    const lossStr = Object.entries(mine || {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
    if (payload.side === 'attacker') {
      const win = payload.attackerWins ? '🎉 胜利' : '💀 失败';
      const damage = (payload.buildingDamage ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'}${d.fromLevel}→${d.toLevel}`).join('、');
      const mode = payload.battleLabel ? `·${payload.battleLabel}` : '';
      return `${time}⚔️ 战斗结束（${mode}${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜我方损失：${lossStr}｜建筑损坏：${damage || '无'}｜战利品：${loot || '无'}`;
    } else {
      const isAmbush = payload.battleLabel === '伏击';
      const win = isAmbush ? (payload.attackerWins ? '💀 失败' : '🎉 胜利') : (payload.attackerWins ? '💀 城破' : '🎉 守住');
      const damage = (payload.buildingDamage ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'}${d.fromLevel}→${d.toLevel}`).join('、');
      const mode = payload.battleLabel ? `·${payload.battleLabel}` : '';
      if (isAmbush) return `${time}🗡️ 被伏击结束（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜我方损失：${lossStr}`;
      return `${time}🛡️ 被进攻结束（${mode}${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜守军损失：${lossStr}｜建筑损坏：${damage || '无'}｜被抢：${loot || '无'}`;
    }
  } else if (event === 'ScoutReport') {
    if (payload.context === 'village_scout' && payload.outcome === 'attacker_destroyed' && payload.side === 'attacker') {
      const deployed = troopMapText(payload.deployedTroops);
      const losses = troopMapText(payload.attackerLosses);
      return `${time}🔭 侦察战失败：我方侦察部队全灭｜派出 ${deployed}｜阵亡 ${losses}`;
    }
    if (payload.context === 'village_scout' && payload.side === 'defender') {
      const incoming = troopMapText(payload.deployedTroops);
      const losses = troopMapText(payload.attackerLosses);
      return `${time}🛡️ 侦察战报告：来袭侦察兵 ${incoming}｜死亡 ${losses}`;
    }
    if (payload.context === 'incoming_intercept') {
      const own = payload.side === 'attacker' ? payload.attackerLosses : payload.defenderLosses;
      const enemy = payload.side === 'attacker' ? payload.defenderLosses : payload.attackerLosses;
      const ownLoss = Object.entries(own ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join('、') || '无';
      const enemyLoss = Object.entries(enemy ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join('、') || '无';
      const at = payload.at ? `(${payload.at.q},${payload.at.r})` : '途中';
      if (payload.side === 'defender') return `${time}🔭 反侦察报告：${at}｜我方侦察兵损失 ${ownLoss}｜敌方损失 ${enemyLoss}`;
      const troops = Object.entries(payload.defenderTroops ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join('、') || '无';
      return `${time}🔭 途中侦察${payload.perfectVictory ? '完胜' : '报告'}：${at}｜来袭兵力 ${troops}｜我方损失 ${ownLoss}｜敌方侦察兵损失 ${enemyLoss}`;
    }
    const losses = troopMapText(payload.attackerLosses);
    if (payload.side === 'defender' || payload.detected) {
      const deployed = troopMapText(payload.deployedTroops);
      const source = payload.attackerVillage ? `（来自 ${payload.attackerVillage}）` : '';
      return `${time}🔭 反侦察报告：发现敌方侦察部队${source} ${deployed}｜敌方损失 ${losses}`;
    }
    if (payload.scoutType === 'scout_buildings') {
      const b = payload.buildings ?? {};
      const list = [...(b.center ?? []), ...(b.inner ?? []), ...(b.outer ?? [])].map((x: any) => `${x.name ?? x.kind}${x.level}级`).join('、') || '无';
      const troops = Object.entries(payload.defenderTroops ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
      return `${time}🔭 侦察报告：发现城内外建筑 ${list}｜守军 ${troops}｜我方损失 ${losses}`;
    }
    const resources = Object.entries(payload.resources ?? {}).map(([k, n]: any) => `${resInfo(k).name}${fmt(Number(n) || 0)}`).join(' ') || '无';
    const troops = Object.entries(payload.defenderTroops ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
    return `${time}🔭 侦察报告：资源 ${resources}｜守军 ${troops}｜我方损失 ${losses}`;
  } else if (event === 'BuildingBattleDamaged') {
    const damage = (payload.destroyed ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'} ${d.fromLevel}→${d.toLevel}`).join('、');
    return `${time}🏚️ 战斗建筑${payload.mode === 'demolish' ? '拆除' : '损坏'}：${damage || '无'}`;
  } else if (event === 'IncomingAttack') {
    return `${time}🚨 警报！有敌军来袭，预计 ${secStr(payload.arriveAt)} 后抵达！`;
  } else if (event === 'MarchIntercepted') {
    const at = payload.at ? `(${payload.at.q},${payload.at.r})` : '途中';
    if (payload.side === 'winner') {
      const surv = Object.entries(payload.winnerSurvivors || {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
      return `${time}⚔️ 遭遇战胜利 ${at}！我军幸存：${surv}`;
    } else {
      return `${time}💀 遭遇战失利 ${at}！出征部队全灭`;
    }
  } else if (event === 'MarchReturned') {
    const loot = Object.entries(payload.loot || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    return `${time}🏠 部队返回，带回：${loot || '无'}`;
  } else if (event === 'CropDeficit') {
    return `${time}⚠️ 粮食告急！军队可能逃亡`;
  } else if (event === 'PopulationChanged') {
    // 只有带 event 字段的离散事件才上报（静默增长不扰战报流）
    const evTag: string | undefined = (payload as any).event;
    if (!evTag) return null;
    const popVal = fmt(Math.round(Number((payload as any).currentPop) ?? 0));
    if (evTag === 'wounded') {
      const wTotal = fmt(Number((payload as any).woundedTotal) || 0);
      return `${time}🩹 战斗伤兵登记，伤兵池 ${wTotal} 人，当前平民 ${popVal}`;
    }
    if (evTag === 'healed') {
      const healed = Number((payload as any).healed);
      const healedStr = healed > 0 ? `+${fmt(healed)} 人归队，` : '';
      return `${time}💚 伤兵治愈归队，${healedStr}当前平民 ${popVal}`;
    }
    if (evTag === 'consumed') {
      const consumed = fmt(Number((payload as any).consumed) || 0);
      return `${time}🎯 征兵消耗 -${consumed} 人口 → 当前平民 ${popVal}`;
    }
    if (evTag === 'returned') {
      const returned = Number((payload as any).returned);
      const retStr = returned > 0 ? `+${fmt(returned)} 人返还，` : '';
      return `${time}🏠 解散归队，${retStr}当前平民 ${popVal}`;
    }
    // server 推送事件名为 famine_reduction（含减员量 reduced、快照 softLimit）
    if (evTag === 'famine_reduction') {
      const reduced = fmt(Number((payload as any).reduced) || 0);
      return `${time}💀 粮食告急，减员 -${reduced} 人 → 当前平民 ${popVal}`;
    }
    if (evTag === 'recovery') {
      return `${time}✅ 粮食恢复，人口停止下降`;
    }
    return `${time}👥 人口变化：当前平民 ${popVal}`;
  }
  return null;
}

/** 把一条服务端推送事件转成战报文案（追加到 reports）。 */
export function handlePush(event: string, payload: any, ts?: number): void {
  if (event === 'BattleTick') {
    setBattleSnapshot(payload);
    return;
  }
  if (event === 'BattleEnded') clearBattleSnapshot(payload.battleId);

  // T7.5：PopulationChanged — 立即校正本地人口快照，不等下次全量刷新。
  // 严禁在此处调 refreshAll() / GetPopulation，防止 push→refresh→settle→emit 正反馈死循环。
  //
  // 字段说明（与服务端实际 payload 对齐）：
  //   famine_reduction 事件：currentPop, woundedTotal, reduced, softLimit
  //   consumed 事件：currentPop, woundedTotal, consumed
  //   returned 事件：currentPop, woundedTotal, returned
  //   wounded  事件：currentPop, woundedTotal, wounded, permanentDead
  //   healed   事件：currentPop, woundedTotal, healed
  //   garrisonPop/totalPop/laborRatio 不在 push payload 中，保留快照旧值
  if (event === 'PopulationChanged') {
    const current = getPopState();
    if (current) {
      // 用 != null 判断（非 !== 0），确保 currentPop=0 能正确写入
      const newCurrentPop = payload.currentPop != null ? Number(payload.currentPop) : current.currentPop;
      const newSoftLimit = payload.softLimit != null ? Number(payload.softLimit) : current.softLimit;
      const evTag: string | undefined = payload.event;

      // inFamine 推断：
      //   famine_reduction 事件 → 明确处于饥荒（服务端已触发减员）
      //   recovery 事件 → 明确脱离饥荒
      //   其他 → 由 currentPop vs softLimit 推断
      let newInFamine: boolean;
      if (evTag === 'famine_reduction') {
        newInFamine = true;
      } else if (evTag === 'recovery') {
        newInFamine = false;
      } else {
        newInFamine = newSoftLimit > 0 && newCurrentPop > newSoftLimit;
      }

      // totalPop 重新推算（garrisonPop 保留快照，无 push 更新）
      const newWoundedTotal = payload.woundedTotal != null ? Number(payload.woundedTotal) : current.wounded.total;
      const newTotalPop = newCurrentPop + current.garrisonPop + newWoundedTotal;
      const newLaborRatio = newTotalPop > 0 ? newCurrentPop / newTotalPop : 1;

      setPopState({
        ...current,
        currentPop: newCurrentPop,
        totalPop: newTotalPop,
        softLimit: newSoftLimit,
        laborRatio: newLaborRatio,
        inFamine: newInFamine,
        growthPerHour: payload.growthPerHour != null ? Number(payload.growthPerHour) : current.growthPerHour,
        lambdaRatio: payload.lambdaRatio != null ? Number(payload.lambdaRatio) : current.lambdaRatio,
        wounded: {
          ...current.wounded,
          total: newWoundedTotal,
        },
        fetchedAt: Date.now(),
      });
      // 局部刷新人口面板（不重建整页）
      rerenderPopPanel();
    }
  }

  const eventTs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const text = notificationText(event, payload, eventTs);
  if (text) addReport(text, 'info', eventTs);
}

/** 用服务端历史通知播种战报列表（登录后调用一次）。 */
export function hydrateReports(notifications: StoredNotification[]): void {
  const seed: StoredReport[] = [];
  for (const n of notifications) {
    const t = notificationText(n.event, n.payload, n.ts);
    if (t) seed.push({ text: t, kind: 'info', ts: n.ts ?? Date.now() });
  }
  seedReports(seed);
}

