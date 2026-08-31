const BASIC_LOOT_RESOURCES = ['wood', 'clay', 'iron', 'crop'] as const;

export type LootPlan = {
  stored: Record<string, number>;
  building: Record<string, number>;
  looted: Record<string, number>;
};

export function mergeResources(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) out[key] = (out[key] ?? 0) + amount;
  }
  return out;
}

/** 从攻城战可掠夺存量中扣除保险库保护额。 */
export function subtractProtected(
  resources: Record<string, number>,
  protectedAmount: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(resources)) {
    const available = Math.max(0, Number(value) || 0);
    const safe = Math.max(0, Number(protectedAmount[key]) || 0);
    out[key] = Math.max(0, available - safe);
  }
  return out;
}

/** 规划 PvP 战利品装载：金币优先，基础资源尽量平均，仓储来源优先于建筑来源。 */
export function planPvpLoot(
  storedAvailable: Record<string, number>,
  buildingLoot: Record<string, number>,
  carry: number,
): LootPlan {
  const stored: Record<string, number> = {};
  const building: Record<string, number> = {};
  let remaining = Math.max(0, Math.floor(Number(carry) || 0));

  const storedGoldTake = Math.min(positiveInt(storedAvailable.gold), remaining);
  if (storedGoldTake > 0) stored.gold = storedGoldTake;
  remaining -= storedGoldTake;
  const buildingGoldTake = Math.min(positiveInt(buildingLoot.gold), remaining);
  if (buildingGoldTake > 0) building.gold = buildingGoldTake;
  remaining -= buildingGoldTake;

  const storedBasic = allocateAverage(storedAvailable, remaining);
  mergeInto(stored, storedBasic);
  remaining -= sumResources(storedBasic);
  const buildingBasic = allocateAverage(buildingLoot, remaining);
  mergeInto(building, buildingBasic);
  return { stored, building, looted: mergeResources(building, stored) };
}

export function scaleResources(resources: Record<string, number>, ratio: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(resources)) {
    const amount = Math.floor(Math.max(0, Number(value) || 0) * Math.max(0, ratio));
    if (amount > 0) out[key] = amount;
  }
  return out;
}

function positiveInt(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function allocateAverage(source: Record<string, number>, carry: number): Record<string, number> {
  const available: Record<string, number> = {};
  for (const key of BASIC_LOOT_RESOURCES) available[key] = positiveInt(source[key]);
  const out: Record<string, number> = {};
  let remaining = Math.max(0, Math.floor(Number(carry) || 0));

  while (remaining > 0) {
    const active = BASIC_LOOT_RESOURCES.filter((key) => (available[key] ?? 0) > (out[key] ?? 0));
    if (active.length === 0) break;
    const share = Math.floor(remaining / active.length);
    if (share <= 0) {
      for (const key of active) {
        if (remaining <= 0) break;
        if ((out[key] ?? 0) < (available[key] ?? 0)) {
          out[key] = (out[key] ?? 0) + 1;
          remaining -= 1;
        }
      }
      continue;
    }
    for (const key of active) {
      if (remaining <= 0) break;
      const room = (available[key] ?? 0) - (out[key] ?? 0);
      const take = Math.min(room, share);
      if (take > 0) {
        out[key] = (out[key] ?? 0) + take;
        remaining -= take;
      }
    }
  }
  return out;
}

function mergeInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function sumResources(resources: Record<string, number>): number {
  return Object.values(resources).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}
