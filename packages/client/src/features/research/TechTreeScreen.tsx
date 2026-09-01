/**
 * 科技页：科研点总览 + 三分支科技树。
 *
 * 数据来自 `techTree` / `researchState` 两个信号（refresh.reloadResearch 填充），
 * 服务端推 `RpChanged` / `TechCompleted` 时自动重拉，界面无需手动刷新。
 */
import { useEffect, useState } from 'preact/hooks';
import { techTree, researchState, tick, sessionVersion, dataVersion } from '../../app/store.js';
import { reloadResearch, act } from '../../app/refresh.js';
import { req, me } from '../../api.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import {
  Panel, SectionHead, Btn, Tag, Bar, Empty, Icon, IconPlate, TimerBar,
} from '../../ui/index.js';
import '../../styles/research.css';

type Branch = 'military' | 'production' | 'social';

const BRANCHES: { key: Branch; name: string; icon: string }[] = [
  { key: 'military', name: '军事', icon: 'ui_icon_atk' },
  { key: 'production', name: '生产', icon: 'res_wood' },
  { key: 'social', name: '社会', icon: 'ui_icon_pop' },
];

export function TechTreeScreen() {
  const [branch, setBranch] = useState<Branch>('military');
  sessionVersion.value;
  dataVersion.value;
  const currentVillageId = me?.villageId ?? '';

  // 进页面及切换村庄后拉取当前村科技树；科研推送仍会触发 refresh。
  useEffect(() => { void reloadResearch(); }, [currentVillageId]);

  const tree = techTree.value;
  const state = researchState.value;

  if (!tree) return <div class="loading">科技数据加载中…</div>;

  const rp: number = tree.rp ?? 0;
  const techs: any[] = tree.techs ?? [];
  const academyCount: number = state?.academy?.academyCount ?? 0;
  const researching = state?.researching ?? null;

  return (
    <div class="tech-command-desk">
      <section class="tech-current-research">
        <SectionHead>当前研究</SectionHead>
        <RpPanel rp={rp} state={state} researching={researching} />
      </section>

      {academyCount === 0 && (
        <Empty icon="🏛️" title="尚未建造学院">
          <p>把<b>主基地</b>升到 <b>Lv3</b>，再在<b>城内空槽</b>建造一所<b>学院</b>即可解锁科技页面。</p>
        </Empty>
      )}

      <section class="tech-full-tree">
        <SectionHead actions={
          <div class="tech-branch-tabs" role="tablist" aria-label="科技分支">
            {BRANCHES.map((b) => (
              <button
                key={b.key}
                role="tab"
                aria-selected={branch === b.key}
                class={`tech-branch-btn${branch === b.key ? ' active' : ''}`}
                onClick={() => setBranch(b.key)}
              >
                <Icon icon={b.icon} label={b.name} size="xs" />
                {b.name}
              </button>
            ))}
          </div>
        }>
          科技树
        </SectionHead>
        <TechBranch
          branch={branch}
          techs={techs}
          rp={rp}
          researchingCode={researching?.code ?? null}
          academyAvailable={academyCount > 0}
        />
      </section>
    </div>
  );
}

/** 顶部：科研点余额 + 研发进度 + 学院产出状态。 */
function RpPanel({ rp, state, researching }: { rp: number; state: any; researching: any }) {
  tick.value;

  const academy = state?.academy ?? {};
  const count: number = academy.academyCount ?? 0;
  const highest: number = academy.highestLevel ?? 0;
  const failStreak: number = academy.failStreak ?? 0;
  const intervalSec: number = state?.intervalSec ?? 0;
  const lastCheck: number = academy.lastCheckTime ?? Date.now();

  // 概率随连续失败递增（保底机制），公式与服务端一致
  const baseProb = 0.10 + Math.max(0, highest - 1) * 0.01;
  const maxProb = 0.30 + Math.max(0, highest - 1) * 0.02;
  const curProb = count > 0 ? Math.min(maxProb, baseProb + failStreak * 0.02) : 0;

  async function cancel() {
    await act(req('CancelResearch', {}), { okToast: '已取消研发，按剩余进度的 90% 返还科研点' });
    await reloadResearch();
  }

  return (
    <Panel variant="gold" corners pad class="rp-panel">
      <div class="rp-main">
        <div class="rp-num">
          <span class="num">{fmt(rp)}</span>
          <small>科研点</small>
        </div>
        {count > 0 && (
          <div class="rp-prob">
            <div class="rp-prob-head">
              <span>下次判定成功率</span>
              <span class="num">{(curProb * 100).toFixed(1)}%</span>
            </div>
            <Bar pct={(curProb / Math.max(0.01, maxProb)) * 100} kind="steel" thin />
            <div class="rp-prob-foot">连续失败 {failStreak} 次 · 上限 {(maxProb * 100).toFixed(0)}%</div>
          </div>
        )}
      </div>

      {researching && (
        <div class="rp-researching">
          <TimerBar
            startAt={researching.startedAt}
            finishAt={researching.startedAt + (researching.durationMs ?? 0)}
            label={<>正在研发：<b>{researching.name ?? researching.code}</b></>}
            kind="gold"
          />
          <Btn size="sm" variant="danger" onClick={cancel}>取消研发</Btn>
        </div>
      )}

      {count > 0 && !researching && intervalSec > 0 && (
        <div class="rp-next">
          <TimerBar
            startAt={lastCheck}
            finishAt={lastCheck + intervalSec * 1000}
            label="下次产出判定"
            kind="steel"
          />
        </div>
      )}
    </Panel>
  );
}

function toRoman(value: number): string {
  return ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'][Math.max(0, value - 1)] ?? String(value);
}

/** 从服务端效果生成极短的专精标签，避免用一段解释性副文案占位。 */
function techFocus(t: any): string | null {
  const effects = Array.isArray(t.effects) && t.effects.length ? t.effects : [t];
  const effect = effects.find((item: any) => item.effectType);
  if (!effect) return null;
  if (effect.effectType === 'combat_atk' || effect.effectType === 'combat_def') {
    const form = effect.effectKey === 'form:melee' ? '近战' : effect.effectKey === 'form:ranged' ? '远程' : '全军';
    return `${form}${effect.effectType === 'combat_atk' ? '攻击' : '防御'}`;
  }
  const labels: Record<string, string> = {
    resource_rate: '资源产出', storage_cap: '资源容量', build_speed: '建筑效率',
    train_speed: '训练效率', march_speed: '行军速度', pop_growth: '人口增长',
    mechanism: '制度效果', unit_unlock: '兵种解锁', building_unlock: '建筑解锁',
  };
  return labels[effect.effectType] ?? null;
}

/** 一个分支的科技阶段树；军事节点按攻防形态明确分流。 */
function TechBranch({ branch, techs, rp, researchingCode, academyAvailable }: {
  branch: Branch;
  techs: any[];
  rp: number;
  researchingCode: string | null;
  academyAvailable: boolean;
}) {
  const list = techs.filter((t) => t.branch === branch);
  if (!list.length) {
    return <Empty icon="📚" title="该分支暂无科技">配置表里还没有这个分支的条目</Empty>;
  }

  const tiers = [...new Set(list.map((t) => t.tier))].sort((a, b) => Number(a) - Number(b));
  const names = new Map(techs.map((t) => [t.code, t.name]));

  return (
    <div class={`tech-tree-board tech-tree-board--${branch}`}>
      <div class="tech-tree-legend" aria-label="科技树状态">
        <span><i class="tech-legend-dot tech-legend-dot--done" />已掌握</span>
        <span><i class="tech-legend-dot tech-legend-dot--ready" />可研发</span>
        <span><i class="tech-legend-dot tech-legend-dot--locked" />等待前置</span>
      </div>
      <div class="tech-tree-stages">
        {tiers.map((tier, index) => (
          <section key={tier} class="tech-tree-stage">
            <div class="tech-stage-head">
              <span class="tech-stage-index">{toRoman(Number(tier))}</span>
              <span>阶段 {tier}</span>
              <small>{list.filter((t) => t.tier === tier).length} 项</small>
            </div>
            <div class="tech-stage-nodes">
              {list.filter((t) => t.tier === tier).map((t) => (
                <TechNode
                  key={t.code}
                  t={t}
                  rp={rp}
                  researchingCode={researchingCode}
                  names={names}
                  academyAvailable={academyAvailable}
                />
              ))}
            </div>
            {index < tiers.length - 1 && <div class="tech-stage-arrow" aria-hidden="true">↓</div>}
          </section>
        ))}
      </div>
    </div>
  );
}

function TechNode({ t, rp, researchingCode, names, academyAvailable }: {
  t: any;
  rp: number;
  researchingCode: string | null;
  names: Map<string, string>;
  academyAvailable: boolean;
}) {
  const completed = t.status === 'completed';
  const researching = t.status === 'researching' || researchingCode === t.code;
  const locked = t.status === 'locked';
  const poor = t.status === 'available' && rp < t.rpCost;
  const canStart = academyAvailable && t.status === 'available' && rp >= t.rpCost && !researchingCode;

  const state = completed ? 'done'
    : researching ? 'doing'
      : locked ? 'locked'
        : canStart ? 'ready' : 'poor';
  const requires: string[] = t.requires ?? [];
  const focus = techFocus(t);

  async function start() {
    await act(req('StartResearch', { techCode: t.code }), { okToast: `开始研发「${t.name}」` });
    await reloadResearch();
  }

  return (
    <Panel variant="flat" class={`tech-node tech-node--${state}`}>
      <div class="tech-node-top">
        <IconPlate
          icon={t.icon}
          fallbackIcon="bld_academy"
          label={t.name}
          size="sm"
          plate={completed ? 'gold' : 'stone'}
        />
        <div class="tech-node-title">
          <div class="tech-node-name">{t.name}</div>
          <div class="tech-node-state">
            <span class={`tech-state-orb tech-state-orb--${state}`} aria-hidden="true" />
            {completed ? '已掌握' : researching ? '正在推演' : !academyAvailable ? '需要学院' : locked ? '等待前置' : poor ? '科研点不足' : '可投入研发'}
          </div>
        </div>
        {t.scope === 'player' && <Tag kind="gold" title="对全部村庄生效">全局</Tag>}
      </div>

      {focus && <div class="tech-node-focus">{focus}</div>}
      <div class="tech-node-effect">{t.desc}</div>

      <div class="tech-node-meta">
        <span><Icon icon="bld_academy" label="科研点" size="2xs" /> <b>{fmt(t.rpCost)}</b> RP</span>
        <span><Icon icon="ui_icon_time" label="研发时长" size="2xs" /> {fmtDur((t.durationSec ?? 0) * 1000)}</span>
      </div>

      {requires.length > 0 && (
        <div class="tech-requires" aria-label="前置科技">
          <span>前置</span>
          {requires.map((code) => <em key={code}>{names.get(code) ?? code}</em>)}
        </div>
      )}

      <div class="tech-node-action">
        {completed ? <Tag kind="jade">已完成</Tag>
          : researching ? <Tag kind="ember">研发中…</Tag>
            : !academyAvailable ? <Tag>需要学院</Tag>
              : locked ? <Tag>前置未满足</Tag>
              : poor ? <Tag kind="crimson">科研点不足</Tag>
                : (
                  <Btn size="sm" variant="primary" disabled={!canStart} onClick={start}
                    title={researchingCode ? '已有科技在研发中' : `研发 ${t.name}`}>
                    {researchingCode ? '有研发进行中' : '研发'}
                  </Btn>
                )}
      </div>
    </Panel>
  );
}
