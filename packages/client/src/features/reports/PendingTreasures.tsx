/**
 * 待领取宝物卡片（军队带回 / 送达 → 玩家确认领取）。
 * 完整移植自旧 reports.ts：
 *   - kind='camp'  → 本村军队带回，单按钮「确认领取」，未归村时 disabled
 *   - kind='deliver' → 外部送达，三按钮「收下 / 出售 / 遗弃」
 * Action: ClaimPendingTreasure { movementId } 或 { movementId, decision }
 * 倒计时由 Countdown 原子处理（不再用 setInterval 跑 DOM ticker）。
 */
import { dataVersion } from '../../app/store.js';
import { me } from '../../api.js';
import { getPendingTreasures, type PendingTreasureView } from '../../app/state.js';
import {
  treasureInfo, treasureEffectText, treasureRarityName, treasureCategoryName,
} from '../../app/config.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { fmt } from '../../shared/utils/format.js';
import { Btn, IconPlate, Countdown, SectionHead, confirmDanger } from '../../ui/index.js';

function rarityClass(rarity: string): string {
  if (rarity === 'rare') return 'tcard--rare';
  if (rarity === 'epic') return 'tcard--epic';
  if (rarity === 'legend' || rarity === 'legendary') return 'tcard--legend';
  return 'tcard--common';
}

function rarityTextClass(rarity: string): string {
  if (rarity === 'rare') return 'tcard-rarity--rare';
  if (rarity === 'epic') return 'tcard-rarity--epic';
  if (rarity === 'legend' || rarity === 'legendary') return 'tcard-rarity--legend';
  return 'tcard-rarity--common';
}

async function claimTreasure(
  movementId: string,
  decision?: 'take' | 'sell' | 'discard' | 'release',
  name?: string,
  priceGold?: number,
): Promise<void> {
  const payload = decision ? { movementId, decision } : { movementId };
  const label = decision === 'sell' ? '出售' : decision === 'discard' ? '遗弃' : decision === 'release' ? '释放' : '领取';
  await act(req('ClaimPendingTreasure', payload), {
    okToast: decision === 'sell'
      ? `已出售宝物「${name ?? ''}」 → +${fmt(priceGold ?? 0)} 金币`
      : decision === 'discard'
        ? `已遗弃宝物「${name ?? ''}」`
        : decision === 'release'
          ? `已释放「${name ?? ''}」 → 娜塔莉获释；任务奖励请到任务栏点击「领取奖励」领取（500 金币与宝物「正直的心」）`
          : `已${label}宝物「${name ?? ''}」`,
  });
}

function TreasureCard({ p }: { p: PendingTreasureView }) {
  const isDeliver = p.kind === 'deliver';
  const isCamp = !isDeliver;
  const isArrived = !!p.arrivedAt;
  const canDecide = isDeliver || isArrived;
  const isCaptured = p.code === 'captured_natalies';

  // camp 未归村：仅显示占位卡片（不泄露宝物信息）
  if (isCamp && !isArrived) {
    return (
      <div class="tcard tcard--pending">
        <div class="tcard-art">
          <IconPlate icon="trs_unknown" label="未知宝物" size="lg" plate="stone" />
        </div>
        <div class="tcard-body">
          <div class="tcard-name">军队带回的宝物</div>
          <div class="tcard-effect">军队返程后才能知道是什么宝物</div>
          <div class="tcard-expiry">
            <span>预计抵达：</span>
            <Countdown until={p.expectedArrivalAt!} done="即将抵达…" />
          </div>
        </div>
      </div>
    );
  }

  const info = treasureInfo(p.code);
  const effectText = info ? treasureEffectText(info) : `${p.effectType}:${p.effectValue}`;
  const rareName = treasureRarityName(p.rarity) || p.rarity;
  const catName = treasureCategoryName(p.category) || p.category;
  const iconBase = info?.icon ?? 'trs_unknown';

  const confirmDiscard = async () => {
    const ok = await confirmDanger({
      title: `遗弃${p.name}`,
      body: '遗弃后宝物会永久消失，也不会获得出售金币。',
      confirmText: '确认遗弃',
    });
    if (!ok) return;
    await claimTreasure(p.movementId, 'discard', p.name);
  };

  return (
    <div class={`tcard ${rarityClass(p.rarity)}`}>
      <div class="tcard-art">
        <IconPlate icon={iconBase} label={p.name} size="lg" plate="gold" />
      </div>

      <div class="tcard-body">
        <div class="tcard-name">
          {p.name}
          <span class={`tcard-rarity ${rarityTextClass(p.rarity)}`}> [{rareName}]</span>
          <span class="tcard-cat">{catName}</span>
        </div>

        <div>
          {isDeliver ? (
            <span class="tcard-kind-badge tcard-kind-badge--deliver" title="军队把宝物送达本村，需你决定如何处理">
              📦 送达本村 · 待决策{p.fromVillageName ? ` · 来自「${p.fromVillageName}」` : ''}
            </span>
          ) : (
            <span class="tcard-kind-badge tcard-kind-badge--camp" title="本村军队带回的宝物，确认即收入宝物栏">
              🏠 本村带回
            </span>
          )}
        </div>

        <div class="tcard-effect">{effectText}</div>
        {p.rewardVillageId && (
          <div class="tcard-effect">任务奖励收件村：{me?.villages?.find((v) => v.id === p.rewardVillageId)?.name ?? p.rewardVillageId}</div>
        )}

        <div class="tcard-expiry">
          <span>⏳ 超时遗弃：</span>
          <Countdown until={p.expiresAt} done="已超时，等待回收" />
        </div>

        <div class="tcard-actions">
          {canDecide ? (
            isCaptured ? (
              <>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={() => void claimTreasure(p.movementId, 'take', p.name)}
                >
                  放入宝库
                </Btn>
                <Btn
                  variant="default"
                  size="sm"
                  onClick={() => void claimTreasure(p.movementId, 'release', p.name)}
                >
                  释放
                </Btn>
              </>
            ) : (
              <>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={() => void claimTreasure(p.movementId, 'take', p.name)}
                >
                  收下
                </Btn>
                {p.hasTradeCenter && <Btn variant="default" size="sm" onClick={() => void claimTreasure(p.movementId, 'sell', p.name, p.priceGold)}>出售 +{fmt(p.priceGold)} 金</Btn>}
                <Btn
                  variant="danger"
                  size="sm"
                  onClick={() => void confirmDiscard()}
                >
                  遗弃
                </Btn>
              </>
            )
          ) : (
            <Btn
              variant="primary"
              size="sm"
              disabled={!p.arrivedAt}
              title={p.arrivedAt ? undefined : '军队尚未归村，无法领取'}
              onClick={() => p.arrivedAt && void claimTreasure(p.movementId, undefined, p.name)}
            >
              {p.arrivedAt ? '确认领取' : '等待归村…'}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pending treasures section — reads dataVersion to re-render on data refresh. */
export function PendingTreasures() {
  dataVersion.value; // subscribe

  const pending = getPendingTreasures();
  if (!pending.length) return null;

  return (
    <section>
      <SectionHead sub={`${pending.length} 件待处理`}>{me?.villages?.find((v) => v.id === me?.villageId)?.name ?? '当前村'} · 待处理宝物</SectionHead>
      <div class="pending-treasures">
        {pending.map((p) => (
          <TreasureCard key={p.movementId} p={p} />
        ))}
        <p class="dim tiny" style={{ textAlign: 'center' }}>超时未确认将自动遗弃，请尽快处理</p>
      </div>
    </section>
  );
}
