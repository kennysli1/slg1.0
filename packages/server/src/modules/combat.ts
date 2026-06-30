/**
 * 领域模块 · Combat（战斗结算）— 无状态纯函数
 * 对应设计文档 03_架构总览(Combat无状态)、08_系统逻辑详解§7、1_原版拆解/03
 *
 * 关键：Combat 不持有任何状态、不读写 store。给它"进攻快照+防守快照"，
 * 返回"结果"（双方伤亡、是否破防、可掠夺额度系数）。调用方(Movement)负责
 * 把结果分发给各 owner 模块改状态。这样 PvE 和 PvP 共用同一个 Combat。
 *
 * 因此本文件导出的是纯函数，不是注册到 CommandBus 的模块类。
 */

/** 单兵种参战条目（来自 Military.GetCombatSnapshot 的口径）。 */
export interface UnitEntry {
  count: number;
  atk: number;
  defInf: number;
  defCav: number;
  carry: number;
  cat?: string; // infantry/cavalry/...
}

export type Snapshot = Record<string, UnitEntry>;

export interface CombatInput {
  attacker: Snapshot;
  defender: Snapshot;
  /** 防守方城墙等级（提供防御加成） */
  wallLevel?: number;
}

export interface CombatResult {
  attackerWins: boolean;
  /** 双方损失：兵种 -> 死亡数量 */
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  /** 战斗力对比（调试/战报展示） */
  attackPower: number;
  defensePower: number;
  /** 进攻方幸存者的总载货能力（Movement 据此决定能搬多少战利品） */
  survivorCarry: number;
}

/** 进攻总攻击力 = Σ count*atk。 */
function totalAttack(s: Snapshot): number {
  let a = 0;
  for (const u of Object.values(s)) a += u.count * u.atk;
  return a;
}

/**
 * 防守方按"进攻方步/骑构成比例"加权取对步防/对骑防。
 * 简化：算进攻方中步兵攻击占比 pInf，防御 = Σ count*(defInf*pInf + defCav*pCav)。
 */
function totalDefense(attacker: Snapshot, defender: Snapshot, wallLevel = 0): number {
  let atkInf = 0;
  let atkCav = 0;
  for (const u of Object.values(attacker)) {
    if (u.cat === 'cavalry') atkCav += u.count * u.atk;
    else atkInf += u.count * u.atk;
  }
  const tot = atkInf + atkCav || 1;
  const pInf = atkInf / tot;
  const pCav = atkCav / tot;

  let d = 0;
  for (const u of Object.values(defender)) {
    d += u.count * (u.defInf * pInf + u.defCav * pCav);
  }
  // 城墙加成：每级 +3%（占位）
  return d * (1 + wallLevel * 0.03);
}

/** 应用损失率到一组兵力，返回死亡数。 */
function applyLosses(s: Snapshot, ratio: number): Record<string, number> {
  const losses: Record<string, number> = {};
  for (const [k, u] of Object.entries(s)) {
    losses[k] = Math.min(u.count, Math.round(u.count * ratio));
  }
  return losses;
}

/**
 * 一次性结算（非回合制）。
 * 胜负由攻防比决定；用 Travian 风格的非线性损失：弱者损失重、强者损失轻。
 */
export function resolveCombat(input: CombatInput): CombatResult {
  const A = totalAttack(input.attacker);
  const D = totalDefense(input.attacker, input.defender, input.wallLevel ?? 0);

  const attackerWins = A > D;
  let attackerLossRatio: number;
  let defenderLossRatio: number;

  if (A <= 0 && D <= 0) {
    attackerLossRatio = 0;
    defenderLossRatio = 0;
  } else if (attackerWins) {
    // 强者(攻)损失小，弱者(守)接近全灭
    const ratio = D / A; // <1
    attackerLossRatio = Math.pow(ratio, 1.5);
    defenderLossRatio = 1; // 进攻胜，守军全灭（简化）
  } else {
    const ratio = A / (D || 1); // <=1
    defenderLossRatio = Math.pow(ratio, 1.5);
    attackerLossRatio = 1; // 进攻败，攻军全灭（简化）
  }

  const attackerLosses = applyLosses(input.attacker, attackerLossRatio);
  const defenderLosses = applyLosses(input.defender, defenderLossRatio);

  // 进攻方幸存者载货能力
  let survivorCarry = 0;
  for (const [k, u] of Object.entries(input.attacker)) {
    const survive = u.count - (attackerLosses[k] ?? 0);
    survivorCarry += survive * u.carry;
  }

  return {
    attackerWins,
    attackerLosses,
    defenderLosses,
    attackPower: Math.round(A),
    defensePower: Math.round(D),
    survivorCarry,
  };
}
