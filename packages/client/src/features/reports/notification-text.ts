/**
 * 推送事件 → 中文战报文案。
 * 纯函数、无 DOM 依赖，单测直接跑（见 src/test/unit.test.ts）。
 * BattleTick 返回 null：它走实时战斗快照，不写进战报流水。
 */
import { fmt, secLeft } from '../../shared/utils/format.js';
import {
  fieldInfo, buildingInfo, resInfo, unitInfo,
  treasureRarityName, treasureInfo,
} from '../../app/config.js';
import type { ReportKind } from '../../app/state.js';

function unitName(key: string): string { return unitInfo(key).name; }

/** 战报语义分类：驱动列表的图标、色带与筛选。类型定义在 app/state 以守住依赖方向。 */
export type { ReportKind };

export function notificationKind(event: string, payload?: any): ReportKind {
  if (event === 'BuildingBuilt' || event === 'BuildingUpgraded' || event === 'BuildingRepaired' || event === 'BuildingDemolished' || event === 'BuildingDemolishing') return 'build';
  if (event === 'BuildingBattleDamaged') return 'battle';
  if (event === 'TroopTrained') return 'train';
  if (event === 'BattleStarted' || event === 'BattleEnded' || event === 'MarchIntercepted' || event === 'ScoutReport') return 'battle';
  if (event === 'MarchSent' || event === 'MarchReturned' || event === 'MarchRecalled' || event === 'VillageFounded') return 'march';
  if (event === 'IncomingAttack' || event === 'CropDeficit') return 'alarm';
  if (event.startsWith('Treasure')) return 'treasure';
  if (event === 'PopulationChanged') return payload?.event === 'famine' || payload?.event === 'starved' ? 'alarm' : 'pop';
  if (event === 'TradeCenterUpdated') return 'trade';
  if (event === 'TechCompleted' || event === 'RpChanged') return 'research';
  return 'info';
}

export function notificationText(event: string, payload: any, ts?: number): string | null {
  const time = ts ? `[${new Date(ts).toLocaleTimeString()}] ` : '';
  if (event === 'BuildingBuilt' || event === 'BuildingUpgraded' || event === 'BuildingRepaired') {
    const name = fieldInfo(payload.kind).name ?? buildingInfo(payload.kind).name ?? payload.kind;
    const verb = event === 'BuildingBuilt' ? '建造完成' : event === 'BuildingRepaired' ? '修复完成' : '升级完成';
    return `${time}${verb}：${name} → ${payload.level}级`;
  } else if (event === 'BuildingDemolished') {
    const name = buildingInfo(payload.kind).name ?? payload.kind;
    return `${time}拆除完成：${name}`;
  } else if (event === 'TroopTrained') {
    return `${time}训练出 ${unitName(payload.unit)}（共${payload.total}）`;
  } else if (event === 'MarchSent') {
    return `${time}出征已派出`;
  } else if (event === 'BattleStarted') {
    if (payload.side === 'attacker') return `${time}战斗开始！攻${payload.attackPower} vs 防${payload.defensePower}，交战中…`;
    return `${time}遭遇进攻！攻${payload.attackPower} vs 防${payload.defensePower}，正在防守…`;
  } else if (event === 'BattleEnded') {
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    const mine = payload.side === 'attacker' ? payload.attackerLosses : payload.defenderLosses;
    const lossStr = Object.entries(mine || {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
    if (payload.side === 'attacker') {
      const win = payload.attackerWins ? '胜利' : '失败';
      const damage = (payload.buildingDamage ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'}${d.fromLevel}→${d.toLevel}`).join('、');
      const mode = payload.battleLabel ? `·${payload.battleLabel}` : '';
      return `${time}战斗结束（${mode}${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜我方损失：${lossStr}｜建筑损坏：${damage || '无'}｜战利品：${loot || '无'}`;
    } else {
      const win = payload.attackerWins ? '城破' : '守住';
      const damage = (payload.buildingDamage ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'}${d.fromLevel}→${d.toLevel}`).join('、');
      const mode = payload.battleLabel ? `·${payload.battleLabel}` : '';
      return `${time}被进攻结束（${mode}${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜守军损失：${lossStr}｜建筑损坏：${damage || '无'}｜被抢：${loot || '无'}`;
    }
  } else if (event === 'ScoutReport') {
    const losses = Number(payload.attackerLosses ?? 0);
    const troops = Object.entries(payload.defenderTroops ?? {}).map(([u, n]: any) => `${unitName(u)}${n}`).join('、') || '无';
    if (payload.scoutType === 'scout_buildings') {
      const b = payload.buildings ?? {};
      const list = [...(b.center ?? []), ...(b.inner ?? []), ...(b.outer ?? [])].map((x: any) => `${x.name ?? x.kind}${x.level}级`).join('、') || '无';
      return `${time}侦察报告：发现目标城内外建筑 ${list}｜守军 ${troops}${losses ? `｜侦察兵损失 ${losses}` : ''}`;
    }
    const resources = Object.entries(payload.resources ?? {}).map(([k, n]: any) => `${resInfo(k).name}${fmt(Number(n) || 0)}`).join('、') || '无';
    return `${time}侦察报告：资源 ${resources}｜守军 ${troops}${losses ? `｜侦察兵损失 ${losses}` : ''}`;
  } else if (event === 'BuildingBattleDamaged') {
    const damage = (payload.destroyed ?? []).map((d: any) => `${buildingInfo(d.kind).name ?? d.kind}${d.mode === 'demolish' ? (d.removed ? '拆除（建筑移除）' : '拆除') : '破坏'} ${d.fromLevel}→${d.toLevel}`).join('、');
    return `${time}战斗建筑${payload.mode === 'demolish' ? '拆除' : '损坏'}：${damage || '无'}`;
  } else if (event === 'IncomingAttack') {
    const atStr = payload.at ? ` 于 (${payload.at.q},${payload.at.r})` : '';
    return `${time}警报！有敌军来袭${atStr}，预计 ${secLeft(payload.arriveAt)} 后抵达！`;
  } else if (event === 'MarchIntercepted') {
    const at = payload.at ? `(${payload.at.q},${payload.at.r})` : '途中';
    if (payload.side === 'winner') {
      const surv = Object.entries(payload.winnerSurvivors || {}).map(([u, n]: any) => `${unitName(u)}${n}`).join(' ') || '无';
      return `${time}遭遇开战胜利 ${at}！我军幸存：${surv}`;
    }
    return `${time}遭遇开战失利 ${at}！出征部队全灭`;
  } else if (event === 'MarchRecalled') {
    return `${time}撤回令已下达，部队开始返程`;
  } else if (event === 'MarchReturned') {
    const loot = Object.entries(payload.loot || {}).map(([t, n]: any) => `${resInfo(t).name}${n}`).join(' ');
    return `${time}部队返回，带回：${loot || '无'}`;
  } else if (event === 'VillageFounded') {
    return `${time}拓荒成功，新村庄已建立${payload?.q != null ? ` (${payload.q},${payload.r})` : ''}`;
  } else if (event === 'TreasureDropped') {
    const d = payload.dropped || {};
    const rare = treasureRarityName(d.rarity) || d.rarity || '';
    if (d.sold) {
      return `${time}清理野营获得宝物「${d.name}」(${rare})，宝物栏已满自动售出 → +${fmt(d.gold)} 金币`;
    }
    return `${time}清理野营获得宝物「${d.name}」(${rare})，已收入宝物栏`;
  } else if (event === 'TreasurePendingDropped') {
    const rare = treasureRarityName(payload.rarity) || payload.rarity || '';
    return `${time}军队带回宝物「${payload.name}」(${rare})，待你前往报告页确认领取`;
  } else if (event === 'TreasurePendingExpired') {
    const rare = treasureRarityName(payload.rarity) || payload.rarity || '';
    return `${time}宝物「${payload.name}」(${rare}) 确认超时，已自动遗弃`;
  } else if (event === 'TreasureCarriedArrived') {
    const codes = payload.codes ?? [];
    const names = codes.map((c: string) => treasureInfo(c)?.name ?? c).join('、');
    if (payload.captured) return `${time}敌军部队被歼灭，其携带的宝物「${names}」被我方缴获，待你前往报告页处理`;
    const source = payload.fromVillageName ? `来自「${payload.fromVillageName}」` : '来自其他村庄';
    const pending = payload.pending ?? [];
    const stored = payload.stored ?? [];
    const storedNames = stored.map((c: string) => treasureInfo(c)?.name ?? c).join('、');
    const pendingNames = pending.map((c: string) => treasureInfo(c)?.name ?? c).join('、');
    if (pending.length > 0 && stored.length > 0) {
      return `${time}${source}的转移部队已送达：宝物「${storedNames}」已收入本村宝物栏；宝物「${pendingNames}」因宝物栏已满，请前往本村报告页处理`;
    }
    if (pending.length > 0) return `${time}${source}的转移部队将宝物「${pendingNames}」送达本村，但宝物栏已满，请前往本村报告页处理`;
    return `${time}${source}的转移部队已将宝物「${storedNames || names}」收入本村宝物栏`;
  } else if (event === 'TreasureDemolishRedistributed') {
    const kept = (payload.kept ?? []).map((c: string) => treasureInfo(c)?.name ?? c).join('、');
    const count = payload.pendingCount ?? (payload.pending?.length ?? 0);
    if (count > 0) {
      return `${time}宝库被拆除：价值最高的宝物「${kept}」留于城镇中心，其余 ${count} 件转入报告页待你处理`;
    }
    return `${time}宝库被拆除：宝物「${kept}」已留于城镇中心`;
  } else if (event === 'TreasureReport') {
    const coords: Array<{ q: number; r: number }> = payload.coords ?? [];
    if (!coords.length) return `${time}秘密字条化作一片空白——附近没有可标记的空地`;
    const list = coords.map((c: any) => `(${c.q}, ${c.r})`).join('、');
    return `${time}秘密字条显现出可疑坐标：${list}（前往探查可解锁后续任务）`;
  } else if (event === 'TechCompleted') {
    return `${time}科技研发完成：${payload?.name ?? payload?.techCode ?? ''}`;
  } else if (event === 'RpChanged') {
    // 科研点每小时判定一次，成功才值得进战报；失败是静默的
    if (!payload?.gained) return null;
    return `${time}学院取得突破，科研点 +${fmt(payload.gained)}（当前 ${fmt(payload.rp ?? 0)}）`;
  } else if (event === 'CropDeficit') {
    return `${time}粮食告急！军队可能逃亡`;
  } else if (event === 'PopulationChanged') {
    // 只有带 event 字段的离散事件才上报（静默增长不扰战报流）
    const evTag: string | undefined = (payload as any).event;
    if (!evTag) return null;
    const popVal = fmt(Math.round(Number((payload as any).currentPop) ?? 0));
    if (evTag === 'consumed') {
      const consumed = Number((payload as any).consumed) || 0;
      if (consumed <= 0) return null;
      return `${time}征兵：劳动人口 -${fmt(consumed)} 转为军队 → 当前平民 ${popVal}（总人口不变）`;
    }
    if (evTag === 'returned') {
      const returned = Number((payload as any).returned);
      const retStr = returned > 0 ? `+${fmt(returned)} 人返还，` : '';
      return `${time}解散归队，${retStr}当前平民 ${popVal}`;
    }
    if (evTag === 'famine' || evTag === 'starved') {
      const reduced = fmt(Number((payload as any).reduced) || 0);
      return `${time}粮食告急，减员 -${reduced} 人 → 当前平民 ${popVal}`;
    }
    if (evTag === 'recovery') {
      return `${time}粮食恢复，人口停止下降`;
    }
    if (evTag === 'capChanged') {
      const hardCap = fmt(Number((payload as any).hardCap) ?? 0);
      return `${time}人口上限变更 → 硬上限 ${hardCap}`;
    }
    if (evTag === 'recovered') {
      const recovered = Number((payload as any).recovered) || 0;
      const permanentDead = Number((payload as any).permanentDead) || 0;
      if (recovered > 0) {
        const recStr = `+${fmt(recovered)} 人经医院回收为平民`;
        const deadStr = permanentDead > 0 ? `（永久损失 ${fmt(permanentDead)} 人）` : '';
        return `${time}战死回收${recStr}${deadStr} → 当前平民 ${popVal}`;
      }
      const deadStr = permanentDead > 0 ? `永久损失 ${fmt(permanentDead)} 人` : '无伤亡';
      return `${time}战损（${deadStr}） → 当前平民 ${popVal}`;
    }
    return `${time}人口变化：当前平民 ${popVal}`;
  }
  return null;
}
