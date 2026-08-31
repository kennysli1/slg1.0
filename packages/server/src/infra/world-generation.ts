import { hexDistanceWrapped, wrapHex } from './hex.js';

export type Terrain = 'plain' | 'forest' | 'hills';

export interface WorldAnchor {
  id: string;
  type: string;
  q: number;
  r: number;
  /** 多格王国地标的实际占地（含中心格）；普通 PvE 不填写。 */
  footprint?: Array<{ q: number; r: number }>;
}

export interface GeneratedWorldPlan {
  w: number;
  h: number;
  seed: string;
  terrain: Terrain[];
  spawnSlots: Array<{ q: number; r: number }>;
  pveSpawns: WorldAnchor[];
  /** 固定点碰到旧世界动态占用时，按此确定性顺序寻找替代格。 */
  pveCandidates: Array<{ q: number; r: number }>;
}

const SPAWN_MIN_DISTANCE = 4;
const LARGE_WORLD_SPAWN_TARGET = 550;
const PVE_TYPES = ['rats', 'wolves', 'bandits', 'mercenaries', 'barbarians', 'fortress', 'dark_legion', 'bone_king'] as const;
const PVE_WEIGHTS = [28, 20, 14, 9, 6, 4, 2, 1] as const;
const PLAN_CACHE = new Map<string, GeneratedWorldPlan>();

export type KingdomLandmarkKind = 'capital' | 'fief';

/** 根据目标类型或地图 refId 识别王国地标。 */
export function kingdomLandmarkKind(value: string | undefined): KingdomLandmarkKind | undefined {
  if (value === 'royal_capital' || value === 'kingdom-capital') return 'capital';
  if (value === 'kingdom-fief-ne' || value === 'kingdom-fief-se' || value === 'kingdom-fief-sw' || value === 'kingdom-fief-nw') return 'fief';
  if (value === 'royal_fief_ne' || value === 'royal_fief_se' || value === 'royal_fief_sw' || value === 'royal_fief_nw') return 'fief';
  return undefined;
}

/** 王国地标的三角形占地偏移，均包含中心格。 */
export function kingdomLandmarkFootprintOffsets(value: string | undefined): Array<{ q: number; r: number }> {
  const kind = kingdomLandmarkKind(value);
  if (kind === 'capital') {
    // 倒三角三行：上窄下宽，1 + 2 + 3 = 6 格；中心位于中行右侧。
    return [
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: 0, r: 0 },
      { q: -2, r: 1 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];
  }
  if (kind === 'fief') {
    // 倒三角两行：上窄下宽，1 + 2 = 3 格；中心位于下行右侧。
    return [{ q: 0, r: -1 }, { q: -1, r: 0 }, { q: 0, r: 0 }];
  }
  return [];
}

/** 王国地标中心坐标对应的、已取模的实际占地。 */
export function kingdomLandmarkFootprint(value: string | undefined, center: { q: number; r: number }, w: number, h: number): Array<{ q: number; r: number }> {
  return kingdomLandmarkFootprintOffsets(value).map((offset) => wrapHex({ q: center.q + offset.q, r: center.r + offset.r }, w, h));
}

/** 王都与四封地的确定性锚点。中心/象限位置随世界尺寸变化，比例由 GM 常量控制。 */
export function kingdomLandmarkAnchors(w: number, h: number, offsetRatio = 0.25): WorldAnchor[] {
  const cq = Math.floor(w / 2), cr = Math.floor(h / 2);
  const oq = Math.max(1, Math.round(w * Math.max(0.05, Math.min(0.45, offsetRatio))));
  const or = Math.max(1, Math.round(h * Math.max(0.05, Math.min(0.45, offsetRatio))));
  return [
    { id: 'kingdom-capital', type: 'royal_capital', q: cq, r: cr },
    { id: 'kingdom-fief-ne', type: 'royal_fief_ne', q: cq + oq, r: cr - or },
    { id: 'kingdom-fief-se', type: 'royal_fief_se', q: cq + oq, r: cr + or },
    { id: 'kingdom-fief-sw', type: 'royal_fief_sw', q: cq - oq, r: cr + or },
    { id: 'kingdom-fief-nw', type: 'royal_fief_nw', q: cq - oq, r: cr - or },
  ].map((anchor) => {
    const wrapped = wrapHex(anchor, w, h);
    return {
      ...anchor,
      ...wrapped,
      footprint: kingdomLandmarkFootprint(anchor.id, wrapped, w, h),
    };
  });
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function unitHash(seed: string, q: number, r: number, salt: string): number {
  return hash32(`${seed}:${salt}:${q}:${r}`) / 0x1_0000_0000;
}

/** 周期连续场：地图接缝处数值连续，排序分位数保证三类地形严格接近 55/30/15。 */
function terrainScore(seed: string, q: number, r: number, w: number, h: number, salt: string): number {
  const phaseA = unitHash(seed, 0, 0, `${salt}:a`) * Math.PI * 2;
  const phaseB = unitHash(seed, 0, 0, `${salt}:b`) * Math.PI * 2;
  const x = (q / w) * Math.PI * 2;
  const y = (r / h) * Math.PI * 2;
  return Math.sin(x * 2 + phaseA) * 0.42
    + Math.cos(y * 3 + phaseB) * 0.34
    + Math.sin((x + y) * 2 - phaseB) * 0.18
    + unitHash(seed, q, r, salt) * 0.06;
}

function generateTerrain(seed: string, w: number, h: number): Terrain[] {
  const cells = Array.from({ length: w * h }, (_, index) => ({
    index,
    q: index % w,
    r: Math.floor(index / w),
  }));
  const byHeight = [...cells].sort((a, b) =>
    terrainScore(seed, b.q, b.r, w, h, 'height') - terrainScore(seed, a.q, a.r, w, h, 'height'));
  const hillsCount = Math.round(cells.length * 0.15);
  const hills = new Set(byHeight.slice(0, hillsCount).map((c) => c.index));
  const remaining = cells.filter((c) => !hills.has(c.index));
  remaining.sort((a, b) =>
    terrainScore(seed, b.q, b.r, w, h, 'moisture') - terrainScore(seed, a.q, a.r, w, h, 'moisture'));
  const forestCount = Math.round(cells.length * 0.30);
  const forest = new Set(remaining.slice(0, forestCount).map((c) => c.index));
  return cells.map((c) => hills.has(c.index) ? 'hills' : forest.has(c.index) ? 'forest' : 'plain');
}

function ringPositions(size: number, spacing: number, offset: number): number[] {
  const count = Math.floor(size / spacing);
  return Array.from({ length: count }, (_, i) => Math.floor(i * size / count + offset) % size);
}

function generateSpawnSlots(seed: string, w: number, h: number, blocked: Set<string>, avoid = blocked): Array<{ q: number; r: number }> {
  const maxLattice = Math.floor(w / SPAWN_MIN_DISTANCE) * Math.floor(h / SPAWN_MIN_DISTANCE);
  const wanted = Math.min(LARGE_WORLD_SPAWN_TARGET, maxLattice);
  let best: Array<{ q: number; r: number }> = [];
  for (let oq = 0; oq < SPAWN_MIN_DISTANCE; oq++) {
    for (let or = 0; or < SPAWN_MIN_DISTANCE; or++) {
      const qs = ringPositions(w, SPAWN_MIN_DISTANCE, oq);
      const rs = ringPositions(h, SPAWN_MIN_DISTANCE, or);
      const candidates = qs.flatMap((q) => rs.map((r) => ({ q, r })))
        .filter((p) => !blocked.has(`${p.q},${p.r}`));
      if (candidates.length > best.length) best = candidates;
    }
  }
  // 按局部相邻顺序开放槽位，让同期新玩家落在同一出生区；种子只决定起始区。
  const start = best.length > 0 ? hash32(`${seed}:spawn-start`) % best.length : 0;
  const ordered = [...best.slice(start), ...best.slice(0, start)];
  // blocked 参与晶格选择，avoid 只在最终出槽时过滤；这样新增多格地标
  // 不会改变原有出生区的晶格偏移，同时确保地标占地不会被分配给玩家。
  return ordered.filter((candidate) => !avoid.has(`${candidate.q},${candidate.r}`)).slice(0, wanted);
}

function pveTypeAt(index: number, total: number): string {
  const weightTotal = PVE_WEIGHTS.reduce((sum, n) => sum + n, 0);
  const cursor = ((index + 0.5) / total) * weightTotal;
  let sum = 0;
  for (let i = 0; i < PVE_WEIGHTS.length; i++) {
    sum += PVE_WEIGHTS[i]!;
    if (cursor <= sum) return PVE_TYPES[i]!;
  }
  return PVE_TYPES[PVE_TYPES.length - 1]!;
}

function cellsWithin(center: { q: number; r: number }, radius: number, w: number, h: number): Array<{ q: number; r: number }> {
  const out = new Map<string, { q: number; r: number }>();
  for (let dq = -radius; dq <= radius; dq++) {
    const minDr = Math.max(-radius, -dq - radius);
    const maxDr = Math.min(radius, -dq + radius);
    for (let dr = minDr; dr <= maxDr; dr++) {
      const p = wrapHex({ q: center.q + dq, r: center.r + dr }, w, h);
      out.set(`${p.q},${p.r}`, p);
    }
  }
  return [...out.values()];
}

function greedyCoverage(
  type: string,
  radius: number,
  required: number,
  slots: Array<{ q: number; r: number }>,
  anchors: WorldAnchor[],
  blocked: Set<string>,
  seed: string,
  w: number,
  h: number,
  terrain: Terrain[],
  preferred?: Terrain,
): WorldAnchor[] {
  const counts = slots.map((slot) => anchors.filter((a) => a.type === type && hexDistanceWrapped(slot, a, w, h) <= radius).length);
  const picked: WorldAnchor[] = [];
  while (true) {
    const slotIndex = counts.findIndex((n) => n < required);
    if (slotIndex < 0) return picked;
    let best: { q: number; r: number; gain: number; tie: number } | undefined;
    for (const p of cellsWithin(slots[slotIndex]!, radius, w, h)) {
      if (blocked.has(`${p.q},${p.r}`)) continue;
      let gain = 0;
      for (let i = 0; i < slots.length; i++) {
        if (counts[i]! < required && hexDistanceWrapped(slots[i]!, p, w, h) <= radius) gain++;
      }
      const preferencePenalty = preferred && terrain[p.r * w + p.q] !== preferred ? 1 : 0;
      const tie = preferencePenalty + unitHash(seed, p.q, p.r, `coverage:${type}`) * 0.5;
      if (!best || gain > best.gain || (gain === best.gain && tie < best.tie)) best = { ...p, gain, tie };
    }
    if (!best) throw new Error(`cannot satisfy ${type} spawn coverage`);
    blocked.add(`${best.q},${best.r}`);
    picked.push({ id: '', type, q: best.q, r: best.r });
    for (let i = 0; i < slots.length; i++) {
      if (hexDistanceWrapped(slots[i]!, best, w, h) <= radius) counts[i] = counts[i]! + 1;
    }
  }
}

/**
 * 纯函数式、确定性的环面世界计划。计划不落盘：同 seed + 尺寸 + 人工锚点必得同一结果。
 * 人工 PvE 锚点优先保留；自动点补足到 round(W*H*5%)（城邦占用其中的配置配额），且不占用首村保留槽位。
 */
export function generateWorldPlan(w: number, h: number, seed: string, anchors: WorldAnchor[], kingdomCityStateCount = 0): GeneratedWorldPlan {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8) throw new Error('world dimensions must be integers >= 8');
  const cityCount = Math.max(0, Math.floor(kingdomCityStateCount));
  const cacheKey = `${w}x${h}:${seed}:${cityCount}:${anchors.map((a) => `${a.id}/${a.type}/${a.q}/${a.r}/${a.footprint?.map((p) => `${p.q},${p.r}`).join(';') ?? ''}`).join('|')}`;
  const cached = PLAN_CACHE.get(cacheKey);
  if (cached) return cached;
  const normalizedAnchors: WorldAnchor[] = [];
  const occupied = new Set<string>();
  for (const anchor of anchors) {
    const p = wrapHex(anchor, w, h);
    const key = `${p.q},${p.r}`;
    if (occupied.has(key)) continue;
    const footprint = (anchor.footprint?.length
      ? anchor.footprint
      : kingdomLandmarkFootprint(anchor.id || anchor.type, p, w, h)).map((cell) => wrapHex(cell, w, h));
    occupied.add(key);
    for (const cell of footprint) occupied.add(`${cell.q},${cell.r}`);
    normalizedAnchors.push({ ...anchor, ...p, ...(footprint.length > 1 ? { footprint } : {}) });
  }
  const terrain = generateTerrain(seed, w, h);
  // 保持既有世界的出生槽确定性：多格地标不会改变槽位晶格的起始偏移；
  // 真实放置时 World.AllocateSpawn 仍会跳过已被地标占用的格子。
  const spawnBlocked = new Set(normalizedAnchors.map((anchor) => `${anchor.q},${anchor.r}`));
  const spawnAvoid = new Set(normalizedAnchors.flatMap((anchor) =>
    anchor.footprint?.map((cell) => `${cell.q},${cell.r}`) ?? [`${anchor.q},${anchor.r}`]));
  const spawnSlots = generateSpawnSlots(seed, w, h, spawnBlocked, spawnAvoid);
  const reserved = new Set(spawnSlots.map((p) => `${p.q},${p.r}`));
  const targetCount = Math.round(w * h * 0.05);
  // 城邦占用 PvE 配额，避免在旧世界中无界增加总目标数量；总密度仍保持约 5%。
  const supplement = Math.max(0, targetCount - normalizedAnchors.length - cityCount);
  // 出生槽位需要避开多格地标的全部占地；普通 PvE 的计划点则只避开
  // 地标中心，运行时由 World.PlacePve 在发生重叠时按后备点迁移，
  // 这样扩展地标不会扰动既有世界的普通 PvE 确定性分布。
  const pveBlocked = new Set<string>([
    ...normalizedAnchors.map((anchor) => `${anchor.q},${anchor.r}`),
    ...reserved,
  ]);
  const generatedBlocked = new Set(pveBlocked);
  const guaranteed = spawnSlots.length >= LARGE_WORLD_SPAWN_TARGET ? [
    ...greedyCoverage('rats', 4, 2, spawnSlots, normalizedAnchors, generatedBlocked, seed, w, h, terrain, 'plain'),
    ...greedyCoverage('wolves', 6, 1, spawnSlots, normalizedAnchors, generatedBlocked, seed, w, h, terrain, 'forest'),
  ] : [];
  if (guaranteed.length > supplement) throw new Error('PvE density is insufficient for spawn-slot guarantees');
  const candidates: Array<{ q: number; r: number; score: number }> = [];
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) {
    const key = `${q},${r}`;
    if (generatedBlocked.has(key)) continue;
    candidates.push({ q, r, score: unitHash(seed, q, r, 'pve-order') });
  }
  candidates.sort((a, b) => a.score - b.score);
  const fillCount = supplement - guaranteed.length;
  if (candidates.length < fillCount) throw new Error('world has insufficient cells for generated PvE targets');
  const fill: WorldAnchor[] = [];
  for (let i = 0; i < fillCount; i++) {
    const type = pveTypeAt(guaranteed.length + i, Math.max(1, supplement));
    const preferred: Terrain | undefined = type === 'wolves'
      ? 'forest'
      : (type === 'fortress' || type === 'dark_legion' || type === 'bone_king') ? 'hills' : undefined;
    let index = preferred
      ? candidates.findIndex((p) => terrain[p.r * w + p.q] === preferred)
      : 0;
    if (index < 0) index = 0;
    const [point] = candidates.splice(index, 1);
    if (!point) throw new Error('world has insufficient cells for generated PvE targets');
    fill.push({ id: '', type, q: point.q, r: point.r });
  }
  const generatedPoints: WorldAnchor[] = [...guaranteed, ...fill];
  // 生态偏好是软分布约束：覆盖保底完成后，把部分森林普通点转为狼群，使狼群明显偏向森林。
  const allForBias = [...normalizedAnchors, ...generatedPoints];
  let wolvesTotal = allForBias.filter((p) => p.type === 'wolves').length;
  let forestWolves = allForBias.filter((p) => p.type === 'wolves' && terrain[p.r * w + p.q] === 'forest').length;
  for (const point of fill) {
    if (forestWolves / Math.max(1, wolvesTotal) > 0.5) break;
    if (point.type === 'wolves' || terrain[point.r * w + point.q] !== 'forest') continue;
    if (point.type === 'fortress' || point.type === 'dark_legion' || point.type === 'bone_king') continue;
    point.type = 'wolves';
    wolvesTotal++;
    forestWolves++;
  }
  const generated = generatedPoints.map((p, i) => ({
    id: `gen-pve-${i}`,
    type: p.type,
    q: p.q,
    r: p.r,
  }));
  // 替代候选先列计划点，再列所有非保留格；旧世界碰撞时仍能补足总量。
  const plannedKeys = new Set(generatedPoints.map((p) => `${p.q},${p.r}`));
  const fallback = candidates.filter((p) => !plannedKeys.has(`${p.q},${p.r}`)).map(({ q, r }) => ({ q, r }));
  const cityBlocked = new Set<string>([
    ...pveBlocked,
    ...reserved,
    ...generatedPoints.map((p) => `${p.q},${p.r}`),
  ]);
  const cityCandidates: Array<{ q: number; r: number; score: number }> = [];
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) {
    const key = `${q},${r}`;
    if (cityBlocked.has(key)) continue;
    cityCandidates.push({ q, r, score: unitHash(seed, q, r, 'kingdom-city-state') });
  }
  cityCandidates.sort((a, b) => a.score - b.score);
  const cityPoints = cityCandidates.slice(0, Math.min(cityCount, cityCandidates.length)).map((p, i) => ({
    id: `kingdom-city-state-${i}`,
    type: 'kingdom_city_state',
    q: p.q,
    r: p.r,
  }));
  const plan = {
    w, h, seed, terrain, spawnSlots,
    pveSpawns: [...normalizedAnchors, ...generated, ...cityPoints],
    pveCandidates: [...generatedPoints.map(({ q, r }) => ({ q, r })), ...cityPoints.map(({ q, r }) => ({ q, r })), ...fallback],
  };
  PLAN_CACHE.set(cacheKey, plan);
  return plan;
}

export function terrainAt(plan: GeneratedWorldPlan, q: number, r: number): Terrain {
  const p = wrapHex({ q, r }, plan.w, plan.h);
  return plan.terrain[p.r * plan.w + p.q] ?? 'plain';
}
