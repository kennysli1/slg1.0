/** 报告页：战报列表 + 服务端推送事件 → 战报文案。 */
import { secStr } from '../../shared/utils/format.js';
import { fieldInfo, buildingInfo, resInfo } from '../../app/config.js';
import { getReports, addReport } from '../../app/state.js';
import { unitName } from '../army/army.js';

export function renderReports(): string {
  const reports = getReports();
  if (!reports.length) return '<div class="empty">暂无战报。去地图掠夺野怪或进攻其他玩家！</div>';
  return reports.map((r) => `<div class="report">${r}</div>`).join('');
}

/** 把一条服务端推送事件转成战报文案（追加到 reports）。返回是否需要刷新数据。 */
export function handlePush(event: string, payload: any): void {
  if (event === 'BuildingUpgraded') {
    addReport(`✅ 建造完成：${fieldInfo(payload.kind).name ?? buildingInfo(payload.kind).name ?? payload.kind} → ${payload.level}级`);
  } else if (event === 'TroopTrained') {
    addReport(`🎯 训练出 ${unitName(payload.unit)}（共${payload.total}）`);
  } else if (event === 'MarchSent') {
    addReport(`🏃 出征已派出`);
  } else if (event === 'RaidResolved') {
    const win = payload.attackerWins ? '🎉 胜利' : '💀 失败';
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    addReport(`掠夺${win}！攻${payload.attackPower} vs 防${payload.defensePower}｜战利品：${loot || '无'}`);
  } else if (event === 'AttackResolved') {
    const win = payload.attackerWins ? '攻方胜' : '守方胜';
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    if (payload.side === 'attacker') addReport(`⚔️ 进攻结算（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜抢得：${loot || '无'}`);
    else addReport(`🛡️ 被进攻（${win}）！攻${payload.attackPower} vs 防${payload.defensePower}｜被抢：${loot || '无'}`);
  } else if (event === 'IncomingAttack') {
    addReport(`🚨 警报！有敌军来袭，预计 ${secStr(payload.arriveAt)} 后抵达！`);
  } else if (event === 'MarchReturned') {
    const loot = Object.entries(payload.loot || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    addReport(`🏠 部队返回，带回：${loot || '无'}`);
  } else if (event === 'CropDeficit') {
    addReport('⚠️ 粮食告急！军队可能逃亡');
  }
}
