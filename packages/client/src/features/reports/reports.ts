/** 报告页：战报列表 + 服务端推送事件 → 战报文案。 */
import { secStr } from '../../shared/utils/format.js';
import { fieldInfo, buildingInfo, resInfo, treasureRarityName } from '../../app/config.js';
import { getReports, addReport, seedReports, setBattleSnapshot, clearBattleSnapshot, getPopState, setPopState } from '../../app/state.js';
import { unitName } from '../army/army.js';
import type { StoredNotification } from '@slg/shared';
import { escapeHtml } from '../../shared/ui/widgets.js';
import { fmt } from '../../shared/utils/format.js';
import { rerenderPopPanel } from '../village/population.js';

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
  if (event === 'BuildingBuilt' || event === 'BuildingUpgraded') {
    const name = fieldInfo(payload.kind).name ?? buildingInfo(payload.kind).name ?? payload.kind;
    const verb = event === 'BuildingBuilt' ? '建造完成' : '升级完成';
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
  } else if (event === 'TreasureDropped') {
    const d = payload.dropped || {};
    const rare = treasureRarityName(d.rarity) || d.rarity || '';
    const where = '清理野营';
    if (d.sold) {
      return `${time}💎 ${where}获得宝物「${d.name}」(${rare})，宝物栏已满自动售出 → +${fmt(d.gold)} 金币`;
    }
    return `${time}💎 ${where}获得宝物「${d.name}」(${rare})，已收入宝物栏`;
  } else if (event === 'CropDeficit') {
    return `${time}⚠️ 粮食告急！军队可能逃亡`;
  } else if (event === 'PopulationChanged') {
    // 只有带 event 字段的离散事件才上报（静默增长不扰战报流）
    const evTag: string | undefined = (payload as any).event;
    if (!evTag) return null;
    const popVal = fmt(Math.round(Number((payload as any).currentPop) ?? 0));
    if (evTag === 'consumed') {
      const consumed = Number((payload as any).consumed) || 0;
      if (consumed <= 0) return null;
      // 劳动人口即时转为士兵（总人数守恒）：payload.currentPop 为转化后平民数
      return `${time}🎯 征兵：劳动人口 -${fmt(consumed)} 转为军队 → 当前平民 ${popVal}（总人口不变）`;
    }
    if (evTag === 'returned') {
      const returned = Number((payload as any).returned);
      const retStr = returned > 0 ? `+${fmt(returned)} 人返还，` : '';
      return `${time}🏠 解散归队，${retStr}当前平民 ${popVal}`;
    }
    // 饥荒减员：服务端首触为 famine，持续为 starved（均含 reduced 减员量）
    if (evTag === 'famine' || evTag === 'starved') {
      const reduced = fmt(Number((payload as any).reduced) || 0);
      return `${time}💀 粮食告急，减员 -${reduced} 人 → 当前平民 ${popVal}`;
    }
    if (evTag === 'recovery') {
      return `${time}✅ 粮食恢复，人口停止下降`;
    }
    // 建筑建造/升级导致硬上限或主城等级变化
    if (evTag === 'capChanged') {
      const hardCap = fmt(Number((payload as any).hardCap) ?? 0);
      return `${time}🏗️ 人口上限变更 → 硬上限 ${hardCap}`;
    }
    // 战死回收：按医院等级把死亡士兵中的一部分回收为平民，其余计永久损失（总人数净降 permanentDead）
    if (evTag === 'recovered') {
      const recovered = Number((payload as any).recovered) || 0;
      const permanentDead = Number((payload as any).permanentDead) || 0;
      if (recovered > 0) {
        const recStr = `+${fmt(recovered)} 人经医院回收为平民`;
        const deadStr = permanentDead > 0 ? `（永久损失 ${fmt(permanentDead)} 人）` : '';
        return `${time}⚕️ 战死回收${recStr}${deadStr} → 当前平民 ${popVal}`;
      }
      // recovered=0：纯战损，无人口回收
      const deadStr = permanentDead > 0 ? `永久损失 ${fmt(permanentDead)} 人` : '无伤亡';
      return `${time}⚕️ 战损（${deadStr}） → 当前平民 ${popVal}`;
    }
    return `${time}👥 人口变化：当前平民 ${popVal}`;
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

  // T7：PopulationChanged — 立即校正本地人口快照，不等下次全量刷新。
  // 严禁在此处调 refreshAll() / GetPopulation，防止 push→refresh→settle→emit 正反馈死循环。
  //
  // 字段说明（与服务端 v3 硬上限 payload 对齐）：
  //   consumed   事件：currentPop, consumed
  //   returned   事件：currentPop, returned
  //   famine/starved 事件：currentPop, reduced, inFamine
  //   recovery   事件：currentPop, inFamine
  //   capChanged 事件：currentPop, hardCap, availableLabor, soldierPop, laborMults, prosperityMult...
  //   recovered  事件：currentPop, recovered, permanentDead
  // 不带 event 字段的静默增长不进战报，也无需校正（下一次 refreshAll 会拉新值）。
  if (event === 'PopulationChanged') {
    const current = getPopState();
    if (current) {
      const evTag: string | undefined = payload.event;
      // 用 != null 判断（非 !== 0），确保 currentPop=0 能正确写入
      const newCurrentPop = payload.currentPop != null ? Number(payload.currentPop) : current.currentPop;
      const newHardCap = payload.hardCap != null ? Number(payload.hardCap) : current.hardCap;
      const newSoldierPop = payload.soldierPop != null ? Number(payload.soldierPop) : current.soldierPop;
      const newTotalPop = payload.totalPop != null ? Number(payload.totalPop) : (current.totalPop ?? newCurrentPop + newSoldierPop);
      const newTrainingPop = payload.trainingPop != null ? Number(payload.trainingPop) : (current.trainingPop ?? 0);
      const newAvailableLabor = payload.availableLabor != null ? Number(payload.availableLabor) : current.availableLabor;
      const newPopCeiling = payload.popCeiling != null ? Number(payload.popCeiling) : (current.popCeiling ?? newHardCap);
      const newSoftLimit = payload.softLimit != null ? Number(payload.softLimit) : newAvailableLabor;
      const newLaborRatio = payload.laborRatio != null ? Number(payload.laborRatio) : current.laborRatio;
      const newProsperityBonus = payload.prosperityBonus != null ? Number(payload.prosperityBonus) : current.prosperityBonus;
      const newProsperityMult = payload.prosperityMult != null ? Number(payload.prosperityMult) : current.prosperityMult;
      const newGrowth = payload.growthPerHour != null ? Number(payload.growthPerHour) : current.growthPerHour;
      const newPotentialGrowth = payload.potentialGrowthPerHour != null ? Number(payload.potentialGrowthPerHour) : (current.potentialGrowthPerHour ?? 0);
      const newMobilizeCap = payload.mobilizeCap != null ? Number(payload.mobilizeCap) : current.mobilizeCap;
      const newMainLevel = payload.mainLevel != null ? Number(payload.mainLevel) : current.mainLevel;
      const newCivilianCrop = payload.civilianCropPerHour != null ? Number(payload.civilianCropPerHour) : current.civilianCropPerHour;

      // inFamine：服务端权威字段优先；否则按事件推断
      let newInFamine: boolean;
      if (payload.inFamine != null) {
        newInFamine = !!payload.inFamine;
      } else if (evTag === 'famine' || evTag === 'starved') {
        newInFamine = true;
      } else if (evTag === 'recovery') {
        newInFamine = false;
      } else {
        newInFamine = current.inFamine;
      }

      const newLaborMults = payload.laborMults != null ? {
        production: Number(payload.laborMults.production ?? newProsperityMult),
        build: Number(payload.laborMults.build ?? newProsperityMult),
        train: Number(payload.laborMults.train ?? newProsperityMult),
        research: Number(payload.laborMults.research ?? newProsperityMult),
        smithy: Number(payload.laborMults.smithy ?? newProsperityMult),
      } : current.laborMults;

      setPopState({
        ...current,
        currentPop: newCurrentPop,
        soldierPop: newSoldierPop,
        totalPop: newTotalPop,
        trainingPop: newTrainingPop,
        hardCap: newHardCap,
        availableLabor: newAvailableLabor,
        popCeiling: newPopCeiling,
        softLimit: newSoftLimit,
        laborRatio: newLaborRatio,
        prosperityBonus: newProsperityBonus,
        prosperityMult: newProsperityMult,
        growthPerHour: newGrowth,
        potentialGrowthPerHour: newPotentialGrowth,
        mobilizeCap: newMobilizeCap,
        mainLevel: newMainLevel,
        inFamine: newInFamine,
        civilianCropPerHour: newCivilianCrop,
        laborMults: newLaborMults,
        fetchedAt: Date.now(),
      });
      // 局部刷新人口面板（不重建整页）
      rerenderPopPanel();
    }
  }

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

