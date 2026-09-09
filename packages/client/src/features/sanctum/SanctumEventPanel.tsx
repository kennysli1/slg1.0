/**
 * 远弦圣地事件面板。
 *
 * 本面板只消费 sanctum.GetState 返回的「当前玩家视图」。特别是圣地坐标、私有
 * 线索和可执行动作都不在前端推导，避免客户端缓存成为泄露全局事件信息的渠道。
 */
import { useState } from 'preact/hooks';
import { me, req } from '../../api.js';
import { openModal, sanctumState, showToast, tab, tick } from '../../app/store.js';
import { act, reloadSanctum, setMapCenter } from '../../app/refresh.js';
import { Btn, Panel, SectionHead, Tag } from '../../ui/index.js';
import { Modal } from '../../ui/Modal.js';
import { fmtDur } from '../../shared/utils/format.js';

type SanctumAction = 'Activate' | 'BeginCondition' | 'SubmitRune' | 'Contribute' | 'Discover' | 'Claim' | 'TakeRelic';
type ResourceKey = 'wood' | 'clay' | 'iron' | 'crop';

interface ActionSpec {
  command: string;
  label?: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  reason?: string;
}

const RESOURCE_NAMES: Record<ResourceKey, string> = { wood: '木材', clay: '泥土', iron: '铁矿', crop: '粮食' };
const PHASE_NAMES: Record<string, string> = {
  dormant: '残印未现',
  seal_race: '残印争夺',
  awaiting_activation: '等待唤醒',
  active: '条件开放',
  sanctum_hidden: '寻找圣地',
  sanctum_active: '圣地争夺',
  relic_in_transit: '圣物归途',
  completed: '远弦谢幕',
  ended: '远弦谢幕',
};
const ACTION_NAMES: Record<SanctumAction, string> = {
  Activate: '唤醒残印',
  BeginCondition: '开始条件',
  SubmitRune: '提交符文',
  Contribute: '贡献资源',
  Discover: '探查圣地',
  Claim: '占领圣地',
  TakeRelic: '携带圣物返程',
};
const ACTION_ALIASES: Record<SanctumAction, string[]> = {
  // `begin` / `join` are intentionally supported for the compact server action map.
  // Both still invoke the public canonical gateway routes below.
  Activate: ['activate', 'join'],
  BeginCondition: ['begincondition', 'begin'],
  SubmitRune: ['submitrune'],
  Contribute: ['contribute'],
  Discover: ['discover'],
  Claim: ['claim'],
  TakeRelic: ['takerelic'],
};

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizedAction(value: unknown): string {
  return String(value ?? '')
    .replace(/^sanctum[.:/]/i, '')
    .replace(/[_.\-\s]/g, '')
    .toLowerCase();
}

function isAction(value: unknown, wanted: SanctumAction): boolean {
  return ACTION_ALIASES[wanted].includes(normalizedAction(value));
}

/**
 * Supports the intentionally small public action contract:
 * - string[]: ["BeginCondition", "sanctum.SubmitRune"]
 * - object map: { BeginCondition: { enabled, label, payload } }
 * - object[]: [{ action, enabled, label, payload }]
 *
 * A server may put action metadata on a target, player, sanctum, or event root. The
 * closest object is consulted first, so per-target denial never turns into a global
 * button accidentally.
 */
function actionFrom(source: any, wanted: SanctumAction): ActionSpec | null {
  if (!source || typeof source !== 'object') return null;
  // The initial server view exposes this one action as an explicit permission flag
  // while the rest use `actions`. It remains server-authoritative and keeps the
  // s23 confirmation usable during a rolling deployment.
  if (wanted === 'Activate' && source.canActivate === true) {
    return { command: 'sanctum.Activate', payload: {}, enabled: true };
  }
  const raw = source.actions ?? source.availableActions ?? source.allowedActions;
  if (!raw) return null;
  const defaultCommand = `sanctum.${wanted}`;
  const readEntry = (entry: any, name?: string): ActionSpec | null => {
    if (typeof entry === 'string') {
      return isAction(entry, wanted) ? {
        command: entry.includes('.') ? entry : defaultCommand,
        label: normalizedAction(entry) === 'join' ? '开始寻迹' : undefined,
        payload: {}, enabled: true,
      } : null;
    }
    if (entry === true && name && isAction(name, wanted)) return { command: defaultCommand, payload: {}, enabled: true };
    if (entry === false && name && isAction(name, wanted)) return { command: defaultCommand, payload: {}, enabled: false };
    if (!entry || typeof entry !== 'object') return null;
    const declared = entry.action ?? entry.key ?? entry.name ?? name;
    if (!isAction(declared, wanted)) return null;
    return {
      command: text(entry.command, text(entry.route, defaultCommand)),
      label: text(entry.label) || (normalizedAction(declared) === 'join' ? '开始寻迹' : undefined),
      payload: entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload) ? entry.payload : {},
      enabled: entry.enabled !== false && entry.allowed !== false,
      reason: text(entry.reason ?? entry.disabledReason) || undefined,
    };
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const found = readEntry(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof raw === 'object') {
    for (const [name, entry] of Object.entries(raw)) {
      const found = readEntry(entry, name);
      if (found) return found;
    }
  }
  return null;
}

function firstAction(sources: any[], wanted: SanctumAction): ActionSpec | null {
  for (const source of sources) {
    const result = actionFrom(source, wanted);
    if (result) return result;
  }
  return null;
}

function actionLabel(action: SanctumAction, spec: ActionSpec | null): string {
  return spec?.label || ACTION_NAMES[action];
}

function eventTime(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function countdown(value: unknown): string | null {
  const until = eventTime(value);
  return until == null ? null : fmtDur(until - Date.now());
}

function resourceText(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  const chunks = (Object.keys(RESOURCE_NAMES) as ResourceKey[])
    .filter((key) => Number(value[key]) > 0)
    .map((key) => `${RESOURCE_NAMES[key]} ${Math.floor(Number(value[key]))}`);
  return chunks.length ? chunks.join(' · ') : null;
}

function rewardText(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => rewardText(item)).filter(Boolean).join(' · ') || null;
  if (typeof value !== 'object') return null;
  return text(value.text ?? value.label ?? value.name ?? value.description) || resourceText(value.resources) || null;
}

function conditionName(condition: any): string {
  return text(condition?.name ?? condition?.title, text(condition?.code, '未命名条件'));
}

function conditionId(condition: any): string {
  return text(condition?.conditionId ?? condition?.id ?? condition?.code);
}

function locationOf(target: any): { q: number; r: number } | null {
  const source = target?.location ?? target?.point ?? target;
  const q = Number(source?.q);
  const r = Number(source?.r);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
}

function FocusMapButton({ target }: { target: any }) {
  const location = locationOf(target);
  if (!location) return null;
  return <Btn size="sm" variant="ghost" onClick={() => { setMapCenter(location); tab.value = 'map'; }}>定位地图</Btn>;
}

function RuneSubmitModal({ condition, disabled, onClose, onSubmit }: {
  condition: any;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (answer: string[]) => Promise<boolean>;
}) {
  const [answerText, setAnswerText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const answer = answerText.split(/[\s,，、>＞]+/).map((entry) => entry.trim()).filter(Boolean);
    if (!answer.length) { showToast('请填写符文答案', 'bad'); return; }
    setBusy(true);
    try {
      if (await onSubmit(answer)) onClose();
    } finally { setBusy(false); }
  };
  const hint = text(condition?.runeHint ?? condition?.inputHint ?? condition?.hint);
  return (
    <Modal
      title={`破解：${conditionName(condition)}`}
      sub="按符文顺序以空格、逗号或“>”分隔输入；服务端会验证答案。"
      onClose={busy ? () => undefined : onClose}
      foot={<><Btn variant="ghost" disabled={busy} onClick={onClose}>取消</Btn><Btn variant="primary" disabled={disabled || busy} onClick={() => void submit()}>{busy ? '验证中…' : '提交符文'}</Btn></>}
    >
      {hint && <p class="sanctum-modal-hint">线索：{hint}</p>}
      <input
        class="sanctum-input"
        data-modal-initial-focus
        placeholder="例如：月影 > 潮汐 > 王冠"
        value={answerText}
        onInput={(event) => setAnswerText((event.currentTarget as HTMLInputElement).value)}
        disabled={busy}
      />
    </Modal>
  );
}

function ContributeModal({ condition, sourceVillageId, disabled, onClose, onSubmit }: {
  condition: any;
  sourceVillageId: string;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (resources: Record<ResourceKey, number>) => Promise<boolean>;
}) {
  const [amounts, setAmounts] = useState<Record<ResourceKey, string>>({ wood: '', clay: '', iron: '', crop: '' });
  const [busy, setBusy] = useState(false);
  const setAmount = (key: ResourceKey, value: string) => setAmounts((prev) => ({ ...prev, [key]: value }));
  const submit = async () => {
    const resources = Object.fromEntries((Object.keys(RESOURCE_NAMES) as ResourceKey[])
      .map((key) => [key, Math.max(0, Math.floor(Number(amounts[key]) || 0))])) as Record<ResourceKey, number>;
    if (!Object.values(resources).some((value) => value > 0)) { showToast('至少贡献一种资源', 'bad'); return; }
    setBusy(true);
    try {
      if (await onSubmit(resources)) onClose();
    } finally { setBusy(false); }
  };
  const required = resourceText(condition?.resourceRequirements ?? condition?.requirements?.resources ?? condition?.requiredResources);
  return (
    <Modal
      title={`贡献：${conditionName(condition)}`}
      sub={`来源村庄：${me?.villages?.find((v) => v.id === sourceVillageId)?.name ?? sourceVillageId}`}
      onClose={busy ? () => undefined : onClose}
      foot={<><Btn variant="ghost" disabled={busy} onClick={onClose}>取消</Btn><Btn variant="primary" disabled={disabled || busy} onClick={() => void submit()}>{busy ? '运送中…' : '确认贡献'}</Btn></>}
    >
      {required && <p class="sanctum-modal-hint">本条件需要：{required}</p>}
      <p class="sanctum-modal-hint">资源扣除、贸易线路与有效贡献由服务端再次校验。</p>
      <div class="sanctum-resource-inputs">
        {(Object.keys(RESOURCE_NAMES) as ResourceKey[]).map((key) => (
          <label key={key}>{RESOURCE_NAMES[key]}<input type="number" min="0" inputMode="numeric" value={amounts[key]} onInput={(event) => setAmount(key, (event.currentTarget as HTMLInputElement).value)} disabled={busy} /></label>
        ))}
      </div>
    </Modal>
  );
}

/** 远弦圣地事件入口，放在任务页且只在服务端返回事件视图时出现。 */
export function shouldShowSanctumEventPanel(state: any): boolean {
  if (!state || state.enabled === false) return false;
  // dormant 表示残印尚未触发。本阶段玩家不应在任务栏看到整块圣地
  // 事件入口；真正持有残印的玩家仍会通过 s23 任务卡进入唤醒流程。
  return String(state.phase ?? '').trim().toLowerCase() !== 'dormant';
}

export function SanctumEventPanel() {
  // 倒计时仅使用本地心跳重绘，绝不为此轮询事件接口。
  tick.value;
  const raw = sanctumState.value;
  // GetState 的事件身份位于 event，而个人/公开/圣地视图位于顶层。
  // 合并而不是直接取 raw.event，才能兼容该契约以及旧的扁平快照。
  const state = raw?.event && typeof raw.event === 'object' ? { ...raw, ...raw.event } : raw;
  if (!shouldShowSanctumEventPanel(state)) return null;
  return <SanctumEventBody state={state} />;
}

/** Keep stateful UI in a child so an initially absent server snapshot never changes hook order. */
function SanctumEventBody({ state }: { state: any }) {
  const player = state.player ?? state.personal ?? {};
  const targets = list(state.publicTargets ?? state.conditions ?? state.targets);
  const sanctum = state.sanctum ?? state.sanctuary ?? null;
  const relic = state.relic ?? sanctum?.relic ?? null;
  const roundId = text(state.roundId);
  const phase = text(state.phase, 'active');
  const [busy, setBusy] = useState<SanctumAction | null>(null);
  const villages = me?.villages ?? [];
  const [selectedVillageId, setSelectedVillageId] = useState(() => me?.villageId ?? villages[0]?.id ?? '');
  const availableVillageId = villages.some((v) => v.id === selectedVillageId)
    ? selectedVillageId
    : (me?.villageId ?? villages[0]?.id ?? '');
  const carriers = list(relic?.eligibleCarrierMovements ?? sanctum?.eligibleCarrierMovements ?? state.eligibleCarrierMovements);
  const [selectedMovementId, setSelectedMovementId] = useState('');
  const availableMovementId = carriers.some((carrier) => String(carrier?.id ?? carrier?.movementId) === selectedMovementId)
    ? selectedMovementId
    : text(carriers[0]?.id ?? carriers[0]?.movementId);

  const run = async (action: SanctumAction, spec: ActionSpec | null, payload: Record<string, unknown>): Promise<boolean> => {
    if (!spec || !spec.enabled || busy || !roundId) return false;
    setBusy(action);
    try {
      const command = spec.command.includes('.') ? spec.command : `sanctum.${action}`;
      return await act(req(command, { ...spec.payload, roundId, ...payload }), {
        okToast: `${actionLabel(action, spec)}成功`,
        onOk: () => {
          // act() 随动作已完成一次基础/地图刷新；这里仅更新圣地脱敏投影，
          // 避免动作回调再把同一张地图标记为待刷新。
          void reloadSanctum({ markMapStale: false });
        },
      });
    } finally {
      setBusy(null);
    }
  };

  const records = list(player.conditionRecords ?? player.completedConditionRecords ?? player.completedConditionsList ?? player.records);
  const reportedCompleted = Number(player.conditionsCompleted ?? player.completedConditions ?? player.conditionCount);
  const completed = Number.isFinite(reportedCompleted) ? reportedCompleted : records.length;
  const required = Number(player.conditionsRequired ?? state.conditionsRequired ?? state.requiredConditions ?? 6);
  const qualified = Boolean(player.qualified ?? player.eligible ?? player.canClaim ?? player.qualifiedAt);
  const hints = list(player.hints ?? player.clues ?? player.sanctumHints);
  const isPioneer = player.isPioneer === true || state.pioneerPlayerId === me?.id;
  const holder = text(
    sanctum?.holderName ?? sanctum?.occupantName ?? sanctum?.ownerName,
    text(sanctum?.holderId ?? sanctum?.occupantId ?? sanctum?.occupantPlayerId, '暂无'),
  );
  const guardEndsAt = sanctum?.guardEndsAt ?? sanctum?.guardDueAt ?? sanctum?.holdEndsAt ?? sanctum?.defendEndsAt;
  const relicStatus = text(relic?.status, relic?.carried ? '携带中' : relic?.returned ? '已归还' : relic?.available ? '待取走' : '尚未出现');
  const relicArrival = relic?.arriveAt ?? relic?.returnAt;

  const openRune = (condition: any, spec: ActionSpec | null) => {
    const id = conditionId(condition);
    if (!id || !spec) return;
    openModal((close) => (
      <RuneSubmitModal
        condition={condition}
        disabled={!spec.enabled || Boolean(busy)}
        onClose={close}
        onSubmit={(answer) => run('SubmitRune', spec, { conditionId: id, answer })}
      />
    ), `sanctum-rune-${id}`);
  };
  const openContribute = (condition: any, spec: ActionSpec | null) => {
    const id = conditionId(condition);
    if (!id || !spec || !availableVillageId) return;
    openModal((close) => (
      <ContributeModal
        condition={condition}
        sourceVillageId={availableVillageId}
        disabled={!spec.enabled || Boolean(busy)}
        onClose={close}
        onSubmit={(resources) => run('Contribute', spec, { conditionId: id, sourceVillageId: availableVillageId, resources })}
      />
    ), `sanctum-contribute-${id}`);
  };

  return (
    <Panel variant="gold" pad class="sanctum-event-panel">
      <SectionHead
        sub="全局支线事件"
        actions={<Tag kind={phase === 'completed' || phase === 'ended' ? 'jade' : 'gold'}>{PHASE_NAMES[phase] ?? phase}</Tag>}
      >远弦圣地</SectionHead>

      {phase === 'awaiting_activation' && <p class="sanctum-event-notice">请在全局支线「圣印现世」中与学者交谈，并明确选择“唤醒残印”。关闭对话或离开不会开启活动。</p>}
      <div class="sanctum-event-summary">
        <div><small>个人条件</small><strong>{Math.max(0, completed)}/{Math.max(1, required)}</strong></div>
        <div><small>进入资格</small><strong>{qualified ? '已获得' : '尚未获得'}</strong></div>
        <div><small>先发者</small><strong>{isPioneer ? '你' : text(state.pioneerName ?? state.pioneerPlayerName, '尚未产生')}</strong></div>
        {player.hasSeal != null && <div><small>圣地残印</small><strong>{player.hasSeal ? '持有' : '未持有'}</strong></div>}
      </div>
      {text(player.statusText ?? player.message) && <p class="sanctum-event-notice">{text(player.statusText ?? player.message)}</p>}

      <details class="sanctum-section" open>
        <summary>公共条件 <span>{targets.length} 项</span></summary>
        <div class="sanctum-condition-list">
          {targets.length === 0 && <p class="sanctum-muted">尚未公开可完成的圣地条件。</p>}
          {targets.map((condition, index) => {
            const id = conditionId(condition);
            const begin = firstAction([condition, player, state], 'BeginCondition');
            const submitRune = firstAction([condition, player, state], 'SubmitRune');
            const contribute = firstAction([condition, player, state], 'Contribute');
            const isComplete = condition.completed === true || condition.status === 'completed';
            const status = text(condition.status, isComplete ? '已完成' : condition.repeatable ? '可重复完成' : '可争夺');
            const reward = rewardText(condition.rewards ?? condition.reward);
            const expires = countdown(condition.investigationDueAt ?? condition.expiresAt ?? condition.availableUntil);
            return (
              <article class={`sanctum-condition${isComplete ? ' is-complete' : ''}`} key={id || index}>
                <header><div><b>{conditionName(condition)}</b><small>{text(condition.kind ?? condition.type, '公共条件')} · {status}{condition.repeatable ? ' · 可重复' : ''}</small></div><Tag kind={isComplete ? 'jade' : 'steel'}>{text(condition.difficulty, '条件')}</Tag></header>
                {text(condition.description ?? condition.desc) && <p>{text(condition.description ?? condition.desc)}</p>}
                {reward && <p class="sanctum-reward">完成奖励：{reward}</p>}
                {expires && <small class="sanctum-timer">{condition.investigationDueAt ? '驻留调查剩余：' : '本轮剩余：'}{expires}</small>}
                <div class="sanctum-actions">
                  <FocusMapButton target={condition} />
                  {begin && <Btn size="sm" disabled={!id || !begin.enabled || Boolean(busy)} title={begin.reason} onClick={() => void run('BeginCondition', begin, { conditionId: id })}>{actionLabel('BeginCondition', begin)}</Btn>}
                  {submitRune && <Btn size="sm" disabled={!id || !submitRune.enabled || Boolean(busy)} title={submitRune.reason} onClick={() => openRune(condition, submitRune)}>{actionLabel('SubmitRune', submitRune)}</Btn>}
                  {contribute && <Btn size="sm" disabled={!id || !contribute.enabled || Boolean(busy) || !availableVillageId} title={contribute.reason} onClick={() => openContribute(condition, contribute)}>{actionLabel('Contribute', contribute)}</Btn>}
                </div>
              </article>
            );
          })}
        </div>
      </details>

      <details class="sanctum-section" open={Boolean(sanctum || hints.length)}>
        <summary>个人线索与圣地 <span>{sanctum ? '已显现' : `${hints.length} 条线索`}</span></summary>
        <div class="sanctum-personal-grid">
          <div>
            <h4>个人线索</h4>
            {hints.length ? <ul class="sanctum-list">{hints.map((hint, index) => <li key={text(hint?.id, String(index))}>{text(hint?.text ?? hint?.description ?? hint, '一条未解线索')}</li>)}</ul> : <p class="sanctum-muted">完成条件后将获得仅自己可见的位置提示。</p>}
          </div>
          <div>
            <h4>圣地状态</h4>
            {sanctum ? <>
              <p><b>{text(sanctum.name, '远弦圣地')}</b> · 持有者：{holder}</p>
              {guardEndsAt && <p>守卫倒计时：{countdown(guardEndsAt)}</p>}
              {text(sanctum.status ?? sanctum.state) && <p class="sanctum-muted">{text(sanctum.status ?? sanctum.state)}</p>}
              <div class="sanctum-actions">
                <FocusMapButton target={sanctum} />
                {(() => { const spec = firstAction([sanctum, player, state], 'Discover'); return spec ? <Btn size="sm" disabled={!spec.enabled || Boolean(busy)} title={spec.reason} onClick={() => void run('Discover', spec, { sanctumId: text(sanctum.id ?? sanctum.sanctumId) })}>{actionLabel('Discover', spec)}</Btn> : null; })()}
                {(() => { const spec = firstAction([sanctum, player, state], 'Claim'); return spec ? <Btn size="sm" variant="primary" disabled={!spec.enabled || Boolean(busy) || !availableVillageId} title={spec.reason} onClick={() => void run('Claim', spec, { sanctumId: text(sanctum.id ?? sanctum.sanctumId), sourceVillageId: availableVillageId })}>{actionLabel('Claim', spec)}</Btn> : null; })()}
              </div>
            </> : <p class="sanctum-muted">尚未发现圣地。线索不会公开给其他玩家。</p>}
          </div>
        </div>
        {villages.length > 1 && <label class="sanctum-source-select">行动来源村庄<select value={availableVillageId} onChange={(event) => setSelectedVillageId((event.currentTarget as HTMLSelectElement).value)}>{villages.map((village) => <option key={village.id} value={village.id}>{village.name}</option>)}</select></label>}
      </details>

      <details class="sanctum-section" open={Boolean(relic)}>
        <summary>圣物状态 <span>{relicStatus}</span></summary>
        {relic ? <div class="sanctum-relic">
          <div><small>状态</small><strong>{relicStatus}</strong></div>
          <div><small>携带者</small><strong>{text(relic.carrierName ?? relic.holderName ?? relic.movementName, '—')}</strong></div>
          <div><small>归还目标</small><strong>{text(relic.returnVillageName ?? relic.destinationName, '—')}</strong></div>
          {relicArrival && <div><small>预计抵达</small><strong>{countdown(relicArrival)}</strong></div>}
          {(() => {
            const spec = firstAction([relic, sanctum, player, state], 'TakeRelic');
            if (!spec) return null;
            return <div class="sanctum-relic-action"><p class="sanctum-muted">只有已在圣地的合格军队能携带圣物返程；服务器会再次确认军队位置和资格。</p>{carriers.length > 0 && <label>携带军队<select value={availableMovementId} onChange={(event) => setSelectedMovementId((event.currentTarget as HTMLSelectElement).value)}>{carriers.map((carrier, index) => { const id = text(carrier?.id ?? carrier?.movementId, String(index)); return <option key={id} value={id}>{text(carrier?.name ?? carrier?.label, id)}</option>; })}</select></label>}<Btn size="sm" variant="primary" disabled={!spec.enabled || Boolean(busy) || !availableVillageId} title={spec.reason} onClick={() => void run('TakeRelic', spec, { sanctumId: text(sanctum?.id ?? sanctum?.sanctumId), ...(availableMovementId ? { movementId: availableMovementId } : {}), returnVillageId: availableVillageId })}>{actionLabel('TakeRelic', spec)}</Btn></div>;
          })()}
        </div> : <p class="sanctum-muted">圣物尚未现世。占领者完成守卫后才可携带返程。</p>}
      </details>

      {records.length > 0 && <details class="sanctum-section sanctum-history"><summary>已完成条件 <span>{records.length} 项</span></summary><ul class="sanctum-list">{records.map((record, index) => <li key={text(record?.id, String(index))}><b>{text(record?.name ?? record?.title, '已完成条件')}</b>{text(record?.rewardText ?? record?.reward) && <small>奖励：{text(record?.rewardText ?? record?.reward)}</small>}</li>)}</ul></details>}
    </Panel>
  );
}
