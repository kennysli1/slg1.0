/**
 * 实时战场面板：展示所有 active battles 的兵力对比条 + 兵种明细。
 *
 * 数据来源：`battles` signal（app/store.ts）。
 * - BattleStarted push → battles[id] = { villageId, side, battleId, targetKind, targetId, attackPower, defensePower }
 * - BattleTick push   → battles[id] = { villageId, side, battleId, attacker: Record<string,number>, defender: Record<string,number> }
 *   （BattleTick 会完全覆盖 BattleStarted，所以 attackPower/defensePower/targetId 可能丢失）
 *
 * 解决策略：模块级 battleMetaCache 在首次看到 BattleStarted 时缓存稳定元信息，
 * 后续 BattleTick 渲染时从缓存取回 attackPower/targetId 等字段。
 *
 * 推荐的 shared-layer 修复：将 putBattle 改为合并语义而非替换，
 * 即 `battles[id] = { ...prev, ...payload }`，则此缓存可省略。
 */
import { battles } from '../../app/store.js';
import { unitInfo } from '../../app/config.js';
import { Icon } from '../../ui/index.js';

interface BattleMeta {
  attackPower: number;
  defensePower: number;
  targetKind: 'village' | 'pve';
  targetId: string;
  side: 'attacker' | 'defender';
}

/** Stable meta from BattleStarted (survives BattleTick overwrites). */
const battleMetaCache = new Map<string, BattleMeta>();

/** Called during render; absorbs BattleStarted fields before they're overwritten. */
function absorbMeta(payload: any): void {
  const id: string = payload.battleId;
  if (!id) return;
  // BattleStarted has attackPower; BattleTick has attacker
  if (payload.attackPower != null && !battleMetaCache.has(id)) {
    battleMetaCache.set(id, {
      attackPower: payload.attackPower as number,
      defensePower: payload.defensePower as number,
      targetKind: payload.targetKind as 'village' | 'pve',
      targetId: payload.targetId as string,
      side: payload.side as 'attacker' | 'defender',
    });
  }
}

/** Total troop count across all unit kinds. */
function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((s, n) => s + n, 0);
}

/** Sort unit entries by count descending. */
function sortedUnits(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function UnitList({ counts }: { counts: Record<string, number> }) {
  const units = sortedUnits(counts).slice(0, 6);
  return (
    <div>
      {units.map(([code, n]) => {
        const info = unitInfo(code);
        return (
          <div class="battle-unit-row" key={code}>
            <Icon icon={info.icon} label={info.name} size="xs" />
            <span class="battle-unit-count">{n}</span>
            <span class="battle-unit-name">{info.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function BattleCard({ battleId, payload }: { battleId: string; payload: any }) {
  // Absorb meta if BattleStarted fields are present
  absorbMeta(payload);
  const meta = battleMetaCache.get(battleId);

  const attackerCounts: Record<string, number> = payload.attacker ?? {};
  const defenderCounts: Record<string, number> = payload.defender ?? {};
  const atkTotal = totalCount(attackerCounts);
  const defTotal = totalCount(defenderCounts);
  const grand = atkTotal + defTotal || 1;

  const atkPct = Math.round((atkTotal / grand) * 100);
  const defPct = 100 - atkPct;

  const side = meta?.side ?? (payload.side as 'attacker' | 'defender' | undefined);
  const mySideLabel = side === 'attacker' ? '我方（攻）' : side === 'defender' ? '我方（守）' : '攻方';
  const theirSideLabel = side === 'attacker' ? '敌方（守）' : side === 'defender' ? '敌方（攻）' : '守方';

  const hasUnits = atkTotal > 0 || defTotal > 0;
  const locationText = meta?.targetKind === 'pve' ? `野营 ${meta.targetId}` : meta?.targetKind === 'village' ? `村庄 ${meta.targetId.slice(-6)}` : '';

  return (
    <div class="battle-live" role="region" aria-label="实时战场">
      <div class="battle-live-head">
        <span class="battle-live-pulse" aria-hidden="true" />
        <span class="battle-live-title">⚔ 战斗进行中</span>
        {locationText && <span class="battle-live-badge">{locationText}</span>}
        {meta && (
          <span class="battle-live-badge" style={{ marginLeft: 'var(--s-2)' }}>
            攻 {meta.attackPower} vs 防 {meta.defensePower}
          </span>
        )}
      </div>

      <div class="battle-live-body">
        {/* 对峙强度条 */}
        {hasUnits && (
          <div class="battle-vs-bars">
            <div class="bvb-labels">
              <span class="bad">{mySideLabel} {atkTotal.toLocaleString()}</span>
              <span class="muted">{theirSideLabel} {defTotal.toLocaleString()}</span>
            </div>
            <div class="bvb-track" role="progressbar" aria-label="兵力对比" aria-valuenow={atkPct} aria-valuemin={0} aria-valuemax={100}>
              <div class="bvb-atk" style={{ width: `${atkPct}%` }} />
              <div class="bvb-def" style={{ width: `${defPct}%` }} />
              <div class="bvb-divider" aria-hidden="true" />
            </div>
          </div>
        )}

        {/* 兵种明细 */}
        {hasUnits && (
          <div class="battle-sides">
            <div class="battle-side-atk">
              <div class="battle-side-label">{mySideLabel}</div>
              <UnitList counts={attackerCounts} />
            </div>
            <div class="battle-side-vs" aria-hidden="true">VS</div>
            <div class="battle-side-def">
              <div class="battle-side-label">{theirSideLabel}</div>
              <UnitList counts={defenderCounts} />
            </div>
          </div>
        )}

        {!hasUnits && (
          <div class="battle-meta-row">
            <span class="battle-meta-item muted">战斗刚刚开始，等待兵力数据…</span>
          </div>
        )}

        {/* 元信息行 */}
        {meta && (
          <div class="battle-meta-row">
            <span class="battle-meta-item">
              <strong>初始攻力</strong>{meta.attackPower}
            </span>
            <span class="battle-meta-item">
              <strong>初始守力</strong>{meta.defensePower}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pinned live battle panels — shown when `battles.value` is non-empty. */
export function BattleLive() {
  const snaps = battles.value;
  const ids = Object.keys(snaps);
  if (!ids.length) return null;

  return (
    <>
      {ids.map((id) => (
        <BattleCard key={id} battleId={id} payload={snaps[id]} />
      ))}
    </>
  );
}
