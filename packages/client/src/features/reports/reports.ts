/** 报告页：战报列表 + 服务端推送事件 → 战报文案。 */
import { secStr } from '../../shared/utils/format.js';
import { fieldInfo, buildingInfo, resInfo } from '../../app/config.js';
import { getReports, addReport, seedReports, setBattleSnapshot, clearBattleSnapshot } from '../../app/state.js';
import { unitName } from '../army/army.js';
import type { StoredNotification } from '@slg/shared';
import { escapeHtml } from '../../shared/ui/widgets.js';

export function renderReports(): string {
  const reports = getReports();
  if (!reports.length) return '<div class="empty">暂无战报。去地图掠夺野怪或进攻其他玩家！</div>';
  return reports.map((r) => `<div class="report">${escapeHtml(r)}</div>`).join('');
}

/**
 * 把一条推送事件转成战报文案。
 * BattleTick 返回 null（走实时快照，不写战报流水）。
 */
export function notificationText(event: string, payload: any, ts?: number): string | null {
  const time = ts ? `[${new Date(ts).toLocaleTimeString()}] ` : '';
  if (event === 'BuildingUpgraded') {
    return `${time}✅ 建造完成：${fieldInfo(payload.kind).name ?? buildingInfo(payload.kind).name ?? payload.kind} → ${payload.level}级`;
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
      return `${time}⚔️ 战斗结束（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜我方损失：${lossStr}｜战利品：${loot || '无'}`;
    } else {
      const win = payload.attackerWins ? '💀 城破' : '🎉 守住';
      return `${time}🛡️ 被进攻结束（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜守军损失：${lossStr}｜被抢：${loot || '无'}`;
    }
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
  }
  return null;
}

/** 把一条服务端推送事件转成战报文案（追加到 reports）。 */
export function handlePush(event: string, payload: any): void {
  if (event === 'BattleTick') {
    setBattleSnapshot(payload);
    return;
  }
  if (event === 'BattleEnded') clearBattleSnapshot(payload.battleId);
  const text = notificationText(event, payload);
  if (text) addReport(text);
}

/** 用服务端历史通知播种战报列表（登录后调用一次）。 */
export function hydrateReports(notifications: StoredNotification[]): void {
  const texts = notifications
    .map((n) => notificationText(n.event, n.payload, n.ts))
    .filter((t): t is string => t !== null);
  seedReports(texts);
}

