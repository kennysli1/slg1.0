/**
 * 雇佣兵营地弹窗（Preact + signals）。
 *
 * 对外只暴露 openMercCamp(): void，签名固定，由村庄建筑弹窗调用。
 * 内部订阅 mercCamp 信号，服务端 push（MercenaryCampUpdated）自动触发
 * reloadMercCamp() → 信号更新 → 弹窗局部重渲，无需手动刷新。
 *
 * 文件归属：trade owner（在 army 文件夹，但 owner 为 trade）。
 * 不得修改同目录下的其他任何文件。
 */
import { useEffect } from 'preact/hooks';
import { openModal, mercCamp, tick } from '../../app/store.js';
import { act, reloadMercCamp } from '../../app/refresh.js';
import { req } from '../../api.js';
import { resInfo, mercenaryInfo } from '../../app/config.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import {
  Modal, SectionHead, Empty, Btn, Tag, Icon, IconPlate,
  Bar, StatGrid, Stat,
} from '../../ui/index.js';
import '../../styles/trade.css';

// ---- 工具 ----

/** 剩余时长格式化统一走 fmtDur（时长语义），别再各页自己实现一份。 */
const fmtRemaining = fmtDur;

// ---- 公共入口 ----

/** 打开雇佣兵营地弹窗（供村庄建筑弹窗调用，签名固定）。 */
export function openMercCamp(): void {
  void reloadMercCamp();
  openModal((close) => <MercCampModal onClose={close} />, 'merc-camp');
}

// ---- 主组件 ----

function MercCampModal({ onClose }: { onClose: () => void }) {
  // 订阅 mercCamp 信号（push 后自动重渲）
  const c = mercCamp.value as any;

  useEffect(() => {
    void reloadMercCamp();
  }, []);

  if (!c) {
    return (
      <Modal
        title="雇佣兵营地"
        icon={<IconPlate icon="bld_merccenter" label="雇佣兵营地" size="sm" plate="gold" />}
        wide
        onClose={onClose}
      >
        <div class="empty"><h4>加载中…</h4></div>
      </Modal>
    );
  }

  if (!c.built) {
    return (
      <Modal
        title="雇佣兵营地"
        icon={<IconPlate icon="bld_merccenter" label="雇佣兵营地" size="sm" plate="gold" />}
        wide
        onClose={onClose}
      >
        <Empty icon="⚔️" title="尚未建造">
          请到「城外」空槽建造雇佣兵营地后，再来此招募。
        </Empty>
      </Modal>
    );
  }

  // ---- 派生数据 ----
  const gold: number = c.gold ?? 0;
  const storedRefreshes: number = c.storedRefreshes ?? 0;
  const maxStored: number = c.maxStored ?? 0;
  const refreshSec: number = c.refreshSec ?? 3600;
  const nextRefreshAt: number = c.nextRefreshAt ?? 0;
  const offers: any[] = c.offers ?? [];

  // ---- 动作 ----

  async function handleHire(code: string) {
    const ok = await act(req('HireMerc', { code }), { okToast: '雇佣成功！' });
    if (ok) void reloadMercCamp();
  }

  async function handleRefresh() {
    const ok = await act(req('RefreshMercCamp'), { okToast: '名单已刷新' });
    if (ok) void reloadMercCamp();
  }

  // ---- 渲染 ----

  return (
    <Modal
      title="雇佣兵营地"
      sub="金币购买 · 永久持有"
      icon={<IconPlate icon="bld_merccenter" label="雇佣兵营地" size="sm" plate="gold" />}
      wide
      onClose={onClose}
    >
      {/* 顶部：金币 + 卖点 */}
      <div class="merc-header">
        <Icon icon={resInfo('gold').icon} label="金币" size="md" />
        <div>
          <div style="font-size:var(--f-xs);color:var(--c-ink-dim)">持有金币</div>
          <div class="merc-gold-num">{fmt(gold)}</div>
        </div>
        <div class="merc-selling-points">
          <span>✓ 不占人口上限</span>
          <span>✓ 不耗粮食口粮</span>
          <span>✓ 永久持有不流失</span>
        </div>
      </div>

      {/* 刷新信息 */}
      <div class="merc-refresh-row">
        {storedRefreshes > 0
          ? (
            <Btn size="sm" onClick={handleRefresh}>
              手动刷新 ({storedRefreshes}/{maxStored})
            </Btn>
          )
          : <span>无存储刷新次数</span>}
        <div class="merc-refresh-timer">
          <span style="font-size:var(--f-2xs)">
            每 {refreshSec}s 自动刷新（上限 {maxStored} 次）
          </span>
          {nextRefreshAt > 0 && (
            <MercRefreshTimer nextAt={nextRefreshAt} refreshSec={refreshSec} />
          )}
        </div>
      </div>

      {/* 可雇佣名单 */}
      <SectionHead sub="金币一次性购买，不需要人口，不消耗粮食">可雇佣名单</SectionHead>

      {offers.length === 0
        ? (
          <Empty icon="🗡️" title="当前无可雇佣名额">
            点击「手动刷新」或等待自动刷新，获取新的雇佣兵名单。
          </Empty>
        )
        : (
          <div class="merc-offer-list">
            {offers.map((o: any) => (
              <MercCard key={o.code} offer={o} gold={gold} onHire={handleHire} />
            ))}
          </div>
        )}
    </Modal>
  );
}

// ---- 刷新倒计时条 ----

function MercRefreshTimer({ nextAt, refreshSec }: { nextAt: number; refreshSec: number }) {
  tick.value;
  const rem = Math.max(0, nextAt - Date.now());
  const pct = refreshSec > 0 ? Math.max(0, Math.min(100, (1 - rem / (refreshSec * 1000)) * 100)) : 100;

  return (
    <div style="display:flex;flex-direction:column;gap:4px;">
      <span style="font-size:var(--f-2xs);color:var(--c-ink-dim)">
        下次自动刷新：{rem > 0 ? fmtRemaining(rem) : '即将刷新'}
      </span>
      <Bar pct={pct} kind="gold" thin />
    </div>
  );
}

// ---- 雇佣兵名额卡片 ----

function MercCard({
  offer: o,
  gold,
  onHire,
}: {
  offer: any;
  gold: number;
  onHire: (code: string) => void;
}) {
  const goldCost: number = o.goldCost ?? 0;
  const canAfford = gold >= goldCost;
  const formLabel = o.form === 'ranged' ? '远程' : '近战';

  // 优先从 config 取完整属性（含 rangedDef、carry），回退到 payload 字段
  const cfgInfo = mercenaryInfo(o.code);
  const meleeAtk = cfgInfo?.meleeAtk ?? o.meleeAtk ?? 0;
  const meleeDef = cfgInfo?.meleeDef ?? o.meleeDef ?? 0;
  const rangedAtk = cfgInfo?.rangedAtk ?? o.rangedAtk ?? 0;
  const rangedDef = cfgInfo?.rangedDef ?? o.rangedDef ?? 0;
  const speed = cfgInfo?.speed ?? o.speed ?? 0;
  const carry = cfgInfo?.carry ?? o.carry ?? 0;

  return (
    <div class="merc-card">
      <IconPlate icon={o.icon} label={o.name} size="lg" plate="stone" />

      <div class="merc-card-body">
        <div class="merc-card-name">
          {o.name}
          <Tag kind="steel">{formLabel}</Tag>
        </div>

        <StatGrid>
          <Stat icon="ui_icon_atk" label="近战攻击" value={meleeAtk} />
          <Stat icon="ui_icon_def" label="近战防御" value={meleeDef} />
          <Stat icon="ui_icon_atk" label="远程攻击" value={rangedAtk} />
          <Stat icon="ui_icon_def" label="远程防御" value={rangedDef} />
          <Stat icon="ui_icon_speed" label="速度" value={speed} />
          <Stat icon="ui_icon_carry" label="负重" value={carry} />
        </StatGrid>

        <div class="merc-card-footer">
          <div class="merc-price">
            <Icon icon={resInfo('gold').icon} label="金币" size="xs" />
            {fmt(goldCost)}
          </div>

          {canAfford
            ? (
              <Btn variant="primary" size="sm" onClick={() => onHire(o.code)}>
                雇佣
              </Btn>
            )
            : (
              <div style="display:flex;align-items:center;gap:var(--s-2)">
                <Btn variant="default" size="sm" disabled>
                  雇佣
                </Btn>
                <span class="merc-lack-reason">
                  金币不足（差 {fmt(goldCost - gold)}）
                </span>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
