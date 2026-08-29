/**
 * Map target workflow: assess the selected tile, prepare a dispatch, then confirm.
 * Existing request payloads remain unchanged; only the interaction is staged.
 */
import { useEffect, useState } from 'preact/hooks';
import { getCache, type SelectedTarget } from '../../app/state.js';
import { dataVersion, selected, garrisonContinue, foreignMoves, tick, showToast, tab, type TaskCampInfo } from '../../app/store.js';
import {
  worldW, worldH, treasureInfo, treasureRarityName, treasureCarryCap,
  unitInfo,
} from '../../app/config.js';
import { act, switchVillage } from '../../app/refresh.js';
import { req, me, isOwnVillageId } from '../../api.js';
import { fmt } from '../../shared/utils/format.js';
import { Btn, Icon, IconPlate, Panel, Tag } from '../../ui/index.js';
import { foreignArmyAt, foreignArmyName, ownArmyAt, ownStationedMoveAt } from './map-target-helpers.js';
import { confirmOwnedVillage } from './owned-village-selection.js';
import type { Movement } from '@slg/shared';

type WorkflowStep = 1 | 2 | 3;
type DispatchMode = 'attack' | 'raid' | 'transport' | 'transfer' | 'reinforce' | 'garrison' | 'explore' | 'auto_explore' | 'scout' | 'ambush' | 'investigate';
type NumberMap = Record<string, number>;

interface TargetMeta {
  refId: string;
  q: number;
  r: number;
  name: string;
  dist: number;
  icon: string;
  mode: DispatchMode;
  isOwn?: boolean;
  declareWar?: boolean;
  targetKind?: string;
  taskInfo?: TaskCampInfo;
}

type ModeOption = { mode: DispatchMode; label: string; requiresDeclaration?: boolean };
const modeLabel = (mode: DispatchMode): string => ({ transport: '转移', transfer: '转移', reinforce: '增援', raid: '掠夺', attack: '攻城', garrison: '驻扎', explore: '探索', auto_explore: '自动探索', scout: '侦察', ambush: '伏击', investigate: '调查' }[mode]);

function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

function hexDistanceWrapped(a: { q: number; r: number }, b: { q: number; r: number }, w: number, h: number): number {
  let best = hexDistance(a, b);
  for (let dq = -w; dq <= w; dq += w) {
    for (let dr = -h; dr <= h; dr += h) {
      if (dq || dr) best = Math.min(best, hexDistance(a, { q: b.q + dq, r: b.r + dr }));
    }
  }
  return best;
}

/** 地图快照包含整张世界的可见性；用同一六边形距离口径算未知格距已知区域的最小深度。 */
function unexploredDepth(q: number, r: number): number {
  const tiles = getCache().area?.tiles as Array<{ q: number; r: number; visibility?: string }> | undefined;
  if (!tiles?.length) return -1;
  let depth = Number.POSITIVE_INFINITY;
  for (const tile of tiles) {
    if (tile.visibility === 'unexplored') continue;
    depth = Math.min(depth, hexDistanceWrapped({ q, r }, tile, worldW(), worldH()));
  }
  return Number.isFinite(depth) ? depth : -1;
}

/** 集结点等级决定一次可踏入的未探索深度；没有集结点时不能探索。 */
function rallypointLevel(): number {
  const zones = getCache().vil?.zones;
  const placed = [...(zones?.inner?.placed ?? []), ...(zones?.outer?.placed ?? [])] as Array<{ kind?: string; level?: number }>;
  return Math.max(0, ...placed.filter((building) => building.kind === 'rallypoint').map((building) => Number(building.level) || 0));
}

function sanitizeCount(value: string, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(Number(value) || 0)));
}

function total(values: NumberMap): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function formatUnitSummary(troops: NumberMap): string {
  const entries = Object.entries(troops);
  if (!entries.length) return '未选择部队';
  return entries.map(([unitKey, amount]) => `${unitInfo(unitKey).name} ${fmt(amount)}`).join(' · ');
}

function WorkflowHeader({
  meta, step, onClose,
}: { meta: TargetMeta; step: WorkflowStep; onClose: () => void }) {
  const currentModeLabel = modeLabel(meta.mode);
  return (
    <>
      <div class="target-head">
        <IconPlate icon={meta.icon} label={meta.name} size="sm" plate={meta.mode === 'attack' ? 'round' : 'gold'} />
        <div class="target-heading-copy">
          <div class="target-title">{meta.name}</div>
          <div class="target-coord">({meta.q},{meta.r}) · 距离 {meta.dist} 格</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭目标面板">×</button>
      </div>
      <ol class="expedition-steps" aria-label={`${currentModeLabel}流程`}>
        {(['目标评估', '编队/运输', '确认'] as const).map((label, index) => {
          const num = (index + 1) as WorkflowStep;
          return (
            <li key={label} class={num === step ? 'is-current' : num < step ? 'is-done' : ''}>
              <span>{num}</span>
              <b>{label}</b>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Assessment({
  meta, onNext,
}: {
  meta: TargetMeta;
  onNext: () => void;
}) {
  const isTransport = meta.mode === 'transport' || meta.mode === 'transfer';
  const copy = meta.mode === 'auto_explore'
    ? '部队会沿当前选定路线逐格探索。首次在新视野中发现公共营地、其他玩家城池或非己方部队时，立刻返城；抵达该终点也会返城，不会主动战斗或驻扎。'
    : meta.mode === 'explore'
    ? '该格尚未探索。军队抵达后会立刻返城；若目标格已有设施或军队，则会在前一格掉头。集结点等级决定可探索的未探索深度。'
    : meta.mode === 'garrison'
    ? '派军队前往该坐标。抵达后若仍为空地便会原地驻扎；若已被设施或其他军队占据，部队将在前一格驻扎。'
    : meta.mode === 'ambush'
    ? '派军队前往该空地隐蔽伏击。抵达后视野缩小为1，只会被一格内的敌方军队发现；伏击战结束后双方幸存部队都会返城。'
    : meta.mode === 'investigate'
    ? '军队抵达秘密营地后进行调查，不发动战斗，随后驻扎等待下一条命令。选择掠夺会使寻找神秘人任务失败。'
    : isTransport
    ? '转移只能携带部队与随队宝物，不能携带木材、泥土、钢或粮食。'
    : meta.mode === 'raid'
      ? '野怪据点会触发掠夺战。确认兵力与宝物后再派出部队。'
    : meta.mode === 'reinforce' ? '盟军或中立村庄可接收增援，部队抵达后并入目标村。' : meta.mode === 'scout' ? (meta.targetKind === 'pve' || meta.targetKind === 'taskcamp' ? 'PvE 营地只能侦察资源与守军。可携带侦察兵或冒险者；冒险者不参与侦察战，遇到守方侦察兵会全部被发现并歼灭。幸存部队会立即返城，携带宝物会随军返回，若全军覆没则被守方缴获。' : '可携带侦察兵或冒险者。冒险者不参与侦察战，遇到守方侦察兵会全部被发现并歼灭；抵达后获得目标情报，幸存部队会立即返城，携带宝物会随军返回，若全军覆没则被守方缴获。') : '这是其他玩家的村庄。请在确认前复核外交状态与编队。';
  const preparationLabel: Record<DispatchMode, string> = {
    attack: '编组攻城部队',
    raid: '编组掠夺部队',
    transport: '编组转移部队',
    transfer: '编组转移部队',
    reinforce: '编组增援部队',
    garrison: '编组驻扎部队',
    ambush: '编组伏击部队',
    investigate: '编组调查部队',
    explore: '编组探索部队',
    auto_explore: '编组自动探索部队',
    scout: '编组侦察部队',
  };

  return (
    <div class="target-body expedition-body">
      {meta.taskInfo && <TaskCampInfoCard taskInfo={meta.taskInfo} />}
      <section class="expedition-assessment">
        <div class="expedition-kicker">目标评估</div>
        <div class="expedition-assessment-title">
          {meta.mode === 'explore' || meta.mode === 'auto_explore' ? '未探索区域' : meta.mode === 'garrison' || meta.mode === 'ambush' ? '野外空地' : meta.mode === 'investigate' ? '任务营地' : isTransport ? '己方村庄转移' : meta.mode === 'reinforce' ? '盟军增援' : meta.mode === 'raid' ? '掠夺目标' : meta.targetKind === 'pve' || meta.targetKind === 'taskcamp' ? 'PvE 侦察目标' : '玩家村庄侦察目标'}
        </div>
        <p>{copy}</p>
        <div class="expedition-facts">
          <span>目标坐标 <b>{meta.q},{meta.r}</b></span>
          <span>行军距离 <b>{meta.dist} 格</b></span>
          <span>行动类型 <Tag kind={isTransport || meta.mode === 'reinforce' ? 'steel' : meta.mode === 'raid' ? 'ember' : meta.mode === 'garrison' || meta.mode === 'explore' || meta.mode === 'auto_explore' || meta.mode === 'ambush' || meta.mode === 'investigate' ? 'gold' : 'crimson'}>{modeLabel(meta.mode)}</Tag></span>
        </div>
      </section>

      <div class="target-foot expedition-foot">
        <Btn variant={meta.mode === 'attack' ? 'danger' : 'primary'} size="lg" block onClick={onNext}>
          {preparationLabel[meta.mode]}
        </Btn>
      </div>
    </div>
  );
}

function targetAssessmentTitle(meta: TargetMeta): string {
  if (meta.targetKind === 'empty') return '野外空地';
  if (meta.targetKind === 'unexplored') return '未探索区域';
  if (meta.targetKind === 'pve' || meta.targetKind === 'taskcamp') return 'PvE 营地';
  if (meta.targetKind === 'own_village' || meta.isOwn) return '己方村庄';
  return '玩家村庄';
}

function targetAssessmentCopy(meta: TargetMeta): string {
  if (meta.targetKind === 'empty') return '这是可行动的空地。驻扎军可继续驻扎或伏击。';
  if (meta.targetKind === 'unexplored') return '该格尚未探索。只能执行探索，军队抵达后会立即返城。';
  if (meta.targetKind === 'pve' || meta.targetKind === 'taskcamp') return '这是地图上的 PvE 营地。可侦察资源与守军，或派兵掠夺。';
  if (meta.targetKind === 'own_village' || meta.isOwn) return '这是己方村庄。可将部队和随队宝物转移过去。';
  return '服务端会根据双方外交状态提供可用行动；中立目标的攻击行为会同时宣战。';
}

function TaskCampInfoCard({ taskInfo }: { taskInfo: TaskCampInfo }) {
  const taskTypeLabel = taskInfo.scope === 'global'
    ? '全局任务'
    : taskInfo.type === 'daily'
      ? '村庄日常任务'
      : '村庄任务';
  return (
    <section class="task-camp-info" aria-label="关联任务信息">
      <div class="expedition-kicker">关联任务</div>
      <div class="task-camp-info-title">{taskInfo.name}</div>
      <p>{taskInfo.desc || '该营地属于当前任务目标。'}</p>
      <div class="task-camp-info-facts">
        <span>任务类型 <b>{taskTypeLabel}</b></span>
        {Number(taskInfo.campTotal) > 0 && (
          <span>营地进度 <b>{Number(taskInfo.campCleared ?? 0)}/{Number(taskInfo.campTotal)}</b></span>
        )}
      </div>
    </section>
  );
}

function TargetAssessment({
  meta, options, onChoose,
}: {
  meta: TargetMeta;
  options: ModeOption[] | null;
  onChoose: (option: ModeOption) => void;
}) {
  return (
    <div class="target-body expedition-body">
      {meta.taskInfo && <TaskCampInfoCard taskInfo={meta.taskInfo} />}
      <section class="expedition-assessment">
        <div class="expedition-kicker">目标评估</div>
        <div class="expedition-assessment-title">{targetAssessmentTitle(meta)}</div>
        <p>{targetAssessmentCopy(meta)}</p>
        <div class="expedition-facts">
          <span>目标坐标 <b>{meta.q},{meta.r}</b></span>
          <span>行军距离 <b>{meta.dist} 格</b></span>
        </div>
        <div class="expedition-kicker expedition-mode-kicker">可用行军模式</div>
        {options === null ? (
          <p class="expedition-empty">正在读取外交关系与可用行动…</p>
        ) : options.length ? (
          <div class="target-actions target-actions--management expedition-mode-options">
            {options.map((option) => (
              <Btn key={option.mode} variant={option.requiresDeclaration ? 'danger' : 'primary'} block onClick={() => onChoose(option)}>
                {option.label}
              </Btn>
            ))}
          </div>
        ) : <p class="expedition-empty">当前目标没有可用的行军模式。</p>}
      </section>
    </div>
  );
}

function NumberInput({
  value, max, onChange, label,
}: { value: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      aria-label={label}
      onInput={(event) => onChange(sanitizeCount((event.currentTarget as HTMLInputElement).value, max))}
    />
  );
}

function TroopPlanner({
  troops, setTroops, transport, scoutOnly,
}: { troops: NumberMap; setTroops: (troops: NumberMap) => void; transport: boolean; scoutOnly?: boolean }) {
  const army = getCache().army;
  // 冒险者可执行探索/侦察行军，但不参与侦察战，也不能发现其他侦察部队。
  const scoutCodes = new Set(['equlegati', 'pathfinder', 'teuscout', 'adventurer']);
  const entries = Object.entries(army?.troops ?? {}).filter(([code, amount]) => Number(amount) > 0 && (!scoutOnly || scoutCodes.has(code)));
  if (!entries.length) return <p class="expedition-empty">无可用兵力，先去军队页训练。</p>;

  const maxTroops = Object.fromEntries(entries.map(([unitKey, raw]) => [
    unitKey, Math.max(0, Math.floor(Number(raw) || 0)),
  ])) as NumberMap;

  return (
    <section class="target-section">
      <div class="target-section-head">
        <span>{transport ? '运输部队' : '出征兵力'}</span>
        <span class="troop-section-actions">
          <small>已选 {fmt(total(troops))}</small>
          <Btn class="troop-max-all" variant="ghost" size="sm" onClick={() => setTroops(maxTroops)}>全部 MAX</Btn>
        </span>
      </div>
      <div class="troop-inputs">
        {entries.map(([unitKey, _raw]) => {
          const max = maxTroops[unitKey];
          const info = unitInfo(unitKey);
          return (
            <div key={unitKey} class="troop-input">
              <Icon icon={info.icon} label={info.name} size="xs" />
              <span class="troop-name">{info.name}</span>
              <NumberInput
                value={troops[unitKey] ?? 0}
                max={max}
                label={`${info.name}数量，最多${max}`}
                onChange={(amount) => setTroops({ ...troops, [unitKey]: amount })}
              />
              <small>/{fmt(max)}</small>
              <Btn class="troop-max-btn" variant="ghost" size="sm" onClick={() => setTroops({ ...troops, [unitKey]: max })}>MAX</Btn>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TreasurePlanner({
  selectedCodes, setSelectedCodes, troopCount,
}: { selectedCodes: string[]; setSelectedCodes: (codes: string[]) => void; troopCount: number }) {
  const codes: string[] = Array.from(new Set<string>((getCache().treasures?.codes as string[]) ?? []));
  const cap = treasureCarryCap(troopCount);
  if (!codes.length) return null;

  function toggle(code: string, checked: boolean) {
    if (checked) {
      if (cap <= selectedCodes.length) return;
      setSelectedCodes([...selectedCodes, code]);
    } else {
      setSelectedCodes(selectedCodes.filter((item) => item !== code));
    }
  }

  return (
    <section class="target-section">
      <div class="carry-header">
        <span class="target-section-head">随队宝物</span>
        <span class={cap ? 'carry-cap' : 'carry-cap carry-cap--zero'}>
          {cap ? `可携带 ${selectedCodes.length}/${cap} 件` : '兵力不足，无法携带'}
        </span>
      </div>
      <div class="carry-chips">
        {codes.map((code) => {
          const info = treasureInfo(code);
          const checked = selectedCodes.includes(code);
          const disabled = !checked && (cap === 0 || selectedCodes.length >= cap);
          return (
            <label key={code} class="carry-chip">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => toggle(code, (event.currentTarget as HTMLInputElement).checked)}
              />
              {info?.icon && <Icon icon={info.icon} label={info.name ?? code} size="xs" />}
              <span class="carry-name">{(info?.name ?? code).slice(0, 6)}</span>
              <span class={`carry-rar rar-${info?.rarity ?? ''}`}>{treasureRarityName(info?.rarity ?? '')}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function Preparation({
  meta, troops, setTroops, treasures, setTreasures, scoutType, setScoutType, onBack, onNext,
}: {
  meta: TargetMeta;
  troops: NumberMap;
  setTroops: (troops: NumberMap) => void;
  treasures: string[];
  setTreasures: (codes: string[]) => void;
  scoutType: 'scout_resources' | 'scout_buildings';
  setScoutType: (value: 'scout_resources' | 'scout_buildings') => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const troopCount = total(troops);
  const isTransfer = meta.mode === 'transport' || meta.mode === 'transfer';
  const canDispatch = troopCount > 0;
  return (
    <div class="target-body expedition-body">
      <TroopPlanner troops={troops} setTroops={setTroops} transport={isTransfer} scoutOnly={meta.mode === 'scout'} />
      {meta.mode === 'scout' && meta.targetKind !== 'pve' && meta.targetKind !== 'taskcamp' && <section class="expedition-assessment scout-type-picker"><div class="expedition-kicker">侦察报告</div><div class="target-actions target-actions--management"><Btn variant={scoutType === 'scout_resources' ? 'primary' : 'ghost'} onClick={() => setScoutType('scout_resources')}>资源与守军</Btn><Btn variant={scoutType === 'scout_buildings' ? 'primary' : 'ghost'} onClick={() => setScoutType('scout_buildings')}>城内外建筑</Btn></div></section>}
      {/* 转移行军不携带物资；资源转运统一走贸易中心的“转移资源”栏。 */}
      <TreasurePlanner selectedCodes={treasures} setSelectedCodes={setTreasures} troopCount={troopCount} />
      <div class="expedition-validation" aria-live="polite">
        {canDispatch ? `已选择 ${fmt(troopCount)} 名部队${isTransfer ? '，仅携带宝物' : ''}。` : '请选择至少一名部队。'}
      </div>
      <div class="target-foot expedition-foot expedition-foot--split">
        <Btn onClick={onBack}>上一步</Btn>
        <Btn variant={meta.mode === 'attack' ? 'danger' : 'primary'} size="lg" disabled={!canDispatch} onClick={onNext}>进入行军确认</Btn>
      </div>
    </div>
  );
}

function Confirmation({
  meta, troops, treasures, onBack, onDispatch,
}: { meta: TargetMeta; troops: NumberMap; treasures: string[]; onBack: () => void; onDispatch: () => void }) {
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => {
    let live = true;
    const villageTarget = meta.targetKind === 'village' || meta.targetKind === 'own_village';
    void req('PreviewMarch', { q: meta.q, r: meta.r, mode: meta.mode === 'transfer' ? 'transfer' : meta.mode, ...(villageTarget ? { targetVillage: meta.refId } : {}), troops })
      .then((res) => { if (live && res.ok) setPreview(res.payload); }).catch(() => undefined);
    return () => { live = false; };
  }, [meta.mode, meta.q, meta.r, meta.refId, JSON.stringify(troops)]);
  const treasureNames = treasures.map((code) => treasureInfo(code)?.name ?? code);
  const action = `确认${modeLabel(meta.mode)}`;
  return (
    <div class="target-body expedition-body">
      <section class="expedition-confirm-card">
        <div class="expedition-kicker">出征命令</div>
        <h3>{action}至「{meta.name}」</h3>
        <dl>
          <div><dt>目标</dt><dd>({meta.q},{meta.r}) · {meta.dist} 格</dd></div>
          <div><dt>部队</dt><dd>{formatUnitSummary(troops)}</dd></div>
          <div><dt>宝物</dt><dd>{treasureNames.length ? treasureNames.join(' · ') : '不携带'}</dd></div>
          {preview && <><div><dt>预计时长</dt><dd>{fmt(preview.travelSec ?? 0)} 秒</dd></div><div><dt>行军点</dt><dd>{preview.marchPoints?.used ?? 0}/{preview.marchPoints?.cap ?? 0} · 集结点 {preview.rallyPointLevel ?? 0} 级</dd></div><div><dt>可派兵力</dt><dd>{formatUnitSummary(preview.availableTroops ?? {})}</dd></div></>}
        </dl>
      </section>
      {(meta.mode === 'attack' || meta.mode === 'raid') && <p class="expedition-warning">{meta.declareWar ? '该目标当前为中立玩家，确认后将同时宣战。' : '这是最终确认：部队抵达目标后将立即进入战斗。'}</p>}
      <div class="target-foot expedition-foot expedition-foot--split">
        <Btn onClick={onBack}>返回调整</Btn>
        <Btn variant={meta.mode === 'attack' || meta.declareWar ? 'danger' : 'primary'} size="lg" onClick={onDispatch}>{action}</Btn>
      </div>
    </div>
  );
}

function ExpeditionWorkflow({
  meta, onClose, initialStep = 1, modeOptions, onSelectMode, onModeBack,
}: {
  meta: TargetMeta;
  onClose: () => void;
  initialStep?: WorkflowStep;
  modeOptions?: ModeOption[];
  onSelectMode?: (option: ModeOption) => void;
  /** When the preparation screen is entered from the mode menu, return to that menu. */
  onModeBack?: () => void;
}) {
  const [step, setStep] = useState<WorkflowStep>(initialStep);
  const [troops, setTroops] = useState<NumberMap>({});
  const [treasures, setTreasures] = useState<string[]>([]);
  const [scoutType, setScoutType] = useState<'scout_resources' | 'scout_buildings'>('scout_resources');

  async function dispatch() {
    const selectedTroops = Object.fromEntries(Object.entries(troops).filter(([, amount]) => amount > 0));
    const cap = treasureCarryCap(total(selectedTroops));
    const selectedTreasures = treasures.slice(0, cap);
    let ok = false;
    if (meta.mode === 'scout') {
      const isPve = meta.targetKind === 'pve' || meta.targetKind === 'taskcamp';
      ok = await act(req('SendScout', { ...(isPve ? { targetId: meta.refId } : { targetVillage: meta.refId }), troops: selectedTroops, treasures: selectedTreasures, scoutType: isPve ? 'scout_resources' : scoutType }), { okToast: '侦察部队出发' });
    } else if (meta.mode === 'transport' || meta.mode === 'transfer') {
      ok = await act(req('SendTransport', {
        targetVillage: meta.refId, troops: selectedTroops, cargo: {}, treasures: selectedTreasures, mode: 'transfer',
      }), { okToast: '转移部队出发' });
    } else if (meta.mode === 'reinforce') {
      ok = await act(req('SendReinforce', { targetVillage: meta.refId, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '增援部队出发' });
    } else if (meta.mode === 'raid') {
      const isPve = meta.targetKind === 'pve' || meta.targetKind === 'taskcamp';
      const p = isPve ? { targetId: meta.refId, troops: selectedTroops, treasures: selectedTreasures } : { targetVillage: meta.refId, troops: selectedTroops, treasures: selectedTreasures, declareWar: !!meta.declareWar };
      ok = await act(req(isPve ? 'SendRaid' : 'SendVillageRaid', p), { okToast: '掠夺部队出发' });
    } else if (meta.mode === 'garrison') {
      ok = await act(req('SendGarrison', { q: meta.q, r: meta.r, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '驻扎部队出发' });
    } else if (meta.mode === 'ambush') {
      ok = await act(req('SendAmbush', { q: meta.q, r: meta.r, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '伏击部队出发' });
    } else if (meta.mode === 'investigate') {
      ok = await act(req('SendInvestigate', { targetId: meta.refId, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '调查部队出发' });
    } else if (meta.mode === 'explore') {
      ok = await act(req('SendExplore', { q: meta.q, r: meta.r, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '探索部队出发，抵达后将返城' });
    } else if (meta.mode === 'auto_explore') {
      ok = await act(req('SendAutoExplore', { q: meta.q, r: meta.r, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '自动探索部队已出发' });
    } else {
      ok = await act(req('SendAttack', { targetVillage: meta.refId, troops: selectedTroops, treasures: selectedTreasures, declareWar: !!meta.declareWar }), { okToast: '攻城部队出发' });
    }
    if (ok) onClose();
  }

  return (
    <Panel variant={meta.mode === 'attack' ? 'danger' : 'gold'} corners class="map-target-panel">
      <WorkflowHeader meta={meta} step={step} onClose={onClose} />
      {step === 1 && (modeOptions
        ? <TargetAssessment meta={meta} options={modeOptions} onChoose={(option) => onSelectMode?.(option)} />
        : <Assessment meta={meta} onNext={() => setStep(2)} />)}
      {step === 2 && <Preparation meta={meta} troops={troops} setTroops={setTroops} treasures={treasures} setTreasures={setTreasures} scoutType={scoutType} setScoutType={setScoutType} onBack={() => { if (onModeBack) onModeBack(); else setStep(1); }} onNext={() => setStep(3)} />}
      {step === 3 && <Confirmation meta={meta} troops={troops} treasures={treasures} onBack={() => setStep(2)} onDispatch={dispatch} />}
    </Panel>
  );
}

/** 所有地图目标共用的模式选择层；外交关系与可用模式由服务端权威返回。 */
function ModeSelectPanel({ base, kind, onClose }: { base: TargetMeta; kind: string; onClose: () => void }) {
  const [options, setOptions] = useState<ModeOption[] | null>(null);
  const [choice, setChoice] = useState<ModeOption | null>(null);
  const [resolvedBase, setResolvedBase] = useState(base);
  useEffect(() => {
    let live = true;
    setResolvedBase(base);
    void req('GetMarchOptions', { q: base.q, r: base.r, kind, refId: base.refId || undefined })
      .then((res) => {
        if (!live || !res.ok) return;
        const payload = res.payload as any;
        setResolvedBase((prev) => ({
          ...prev,
          q: Number.isFinite(Number(payload.q)) ? Number(payload.q) : prev.q,
          r: Number.isFinite(Number(payload.r)) ? Number(payload.r) : prev.r,
          name: typeof payload.name === 'string' && payload.name ? payload.name : prev.name,
        }));
        setOptions((payload.modes ?? []) as ModeOption[]);
      })
      .catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [base.q, base.r, base.refId, kind]);
  if (choice) return (
    <ExpeditionWorkflow
      meta={{ ...resolvedBase, mode: choice.mode, declareWar: choice.requiresDeclaration }}
      initialStep={2}
      modeOptions={options ?? []}
      onSelectMode={setChoice}
      onModeBack={() => setChoice(null)}
      onClose={onClose}
    />
  );
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={resolvedBase} step={1} onClose={onClose} />
      <TargetAssessment meta={resolvedBase} options={options} onChoose={setChoice} />
      <div class="target-foot expedition-foot"><Btn onClick={onClose}>取消</Btn></div>
    </Panel>
  );
}

function EmptyTilePanel({ q, r, dist, visibility, onClose }: { q: number; r: number; dist: number; visibility?: string; onClose: () => void }) {
  const [garrison, setGarrison] = useState(false);
  const [autoExplore, setAutoExplore] = useState(false);
  const [ambush, setAmbush] = useState(false);
  const [founding, setFounding] = useState(false);
  async function found() {
    if (await act(req('FoundVillage', { q, r }), { okToast: '拓荒令已发出' })) onClose();
  }
  const meta: TargetMeta = { refId: '', q, r, dist, name: '空地', icon: 'bld_main', mode: 'garrison' };
  const depth = visibility === 'unexplored' ? unexploredDepth(q, r) : 0;
  const maxExploreDepth = rallypointLevel();
  const allowExplore = visibility !== 'unexplored' || (depth >= 1 && depth <= maxExploreDepth);
  const allowAutoExplore = visibility === 'unexplored' && maxExploreDepth >= 1;
  if (founding) return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={{ ...meta, mode: 'garrison' }} step={3} onClose={onClose} />
      <div class="target-body expedition-body"><section class="expedition-confirm-card"><div class="expedition-kicker">拓荒命令</div><h3>拓荒至 ({q},{r})</h3><p>服务器将复核拓荒者、开城资源、人口与村庄上限。</p></section><div class="target-foot expedition-foot expedition-foot--split"><Btn onClick={() => setFounding(false)}>返回</Btn><Btn variant="primary" size="lg" onClick={found}>确认拓荒</Btn></div></div>
    </Panel>
  );
  if (garrison || autoExplore) {
    const exploring = visibility === 'unexplored';
    return <ExpeditionWorkflow meta={{ ...meta, name: exploring ? '未探索区域' : ambush ? '野外伏击点' : '野外驻扎点', icon: 'pve_bandits', mode: autoExplore ? 'auto_explore' : exploring ? 'explore' : ambush ? 'ambush' : 'garrison' }} initialStep={2} onClose={onClose} />;
  }
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={meta} step={1} onClose={onClose} />
      <div class="target-body expedition-body">
        <section class="expedition-assessment">
          <div class="expedition-kicker">目标评估</div>
          <div class="expedition-assessment-title">{visibility === 'unexplored' ? '未探索区域' : '可拓荒空地'}</div>
          <p>{visibility === 'unexplored' ? allowExplore ? `可执行单点探索，或自动探索至该终点；自动探索会在沿途发现公共营地、他人城池或外军时提前返城。` : allowAutoExplore ? `该格深度为 ${depth < 0 ? '未知' : depth}，超过单点探索上限 ${maxExploreDepth} 格；仍可执行自动探索至该终点。` : `该未探索格深度为 ${depth < 0 ? '未知' : depth}，需要至少 1 级集结点才能自动探索。` : '可选择驻扎；拥有拓荒者时才显示拓荒模式。驻扎军抵达时会再次确认格子仍为空地。'}</p>
          <div class="expedition-facts">
            <span>目标坐标 <b>{q},{r}</b></span>
            <span>行军距离 <b>{dist} 格</b></span>
          </div>
          <div class="expedition-kicker expedition-mode-kicker">可用行军模式</div>
          <div class="target-actions target-actions--management expedition-mode-options">
            {allowExplore && <Btn variant="primary" block onClick={() => setGarrison(true)}>{visibility === 'unexplored' ? '探索' : '驻扎'}</Btn>}
            {allowAutoExplore && <Btn variant="ghost" block onClick={() => setAutoExplore(true)}>自动探索</Btn>}
            {visibility !== 'unexplored' && <Btn variant="ghost" block onClick={() => { setAmbush(true); setGarrison(true); }}>伏击</Btn>}
            {visibility !== 'unexplored' && Number((getCache().army?.troops as any)?.settler ?? 0) > 0 && <Btn variant="ghost" block onClick={() => setFounding(true)}>拓荒</Btn>}
          </div>
          {!allowExplore && visibility === 'unexplored' && <p class="expedition-empty">当前没有可用的行军模式。</p>}
        </section>
      </div>
    </Panel>
  );
}

/**
 * 驻扎军“行军”后的目标模式选择与确认。
 *
 * 这里不能根据目标类型在客户端硬编码一个模式：驻扎军续行与首次派遣
 * 使用的是同一套外交/目标规则，服务端 GetMarchOptions 才是唯一权威来源。
 * 续行仍保持原军的兵力和宝物，不重新扣兵或增加行军点。
 */
function GarrisonContinuation({ movementId, movementType, target, onClose }: {
  movementId: string; movementType?: 'garrison' | 'ambush' | 'investigate'; target: { refId: string; kind: string; q: number; r: number; name: string; visibility?: string }; onClose: () => void;
}) {
  const targetKind = target.visibility === 'unexplored' ? 'unexplored' : target.kind;
  const [options, setOptions] = useState<ModeOption[] | null>(null);
  const [choice, setChoice] = useState<ModeOption | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState(target);

  useEffect(() => {
    let live = true;
    setOptions(null);
    setChoice(null);
    setResolvedTarget(target);
    void req('GetMarchOptions', {
      q: target.q,
      r: target.r,
      kind: targetKind,
      refId: target.refId || undefined,
      movementId,
    }).then((res) => {
      if (!live || !res.ok) return;
      const payload = res.payload as any;
      setResolvedTarget((prev) => ({
        ...prev,
        q: Number.isFinite(Number(payload.q)) ? Number(payload.q) : prev.q,
        r: Number.isFinite(Number(payload.r)) ? Number(payload.r) : prev.r,
        name: typeof payload.name === 'string' && payload.name ? payload.name : prev.name,
      }));
      const available = (payload.modes ?? []) as ModeOption[];
      // 伏击只能从城镇直接派出；抵达后不再提供任何续行模式。
      // 其余筛选（例如混合编队不得侦察）由服务端按 movementId 完成。
      setOptions(movementType === 'ambush' ? [] : available);
    }).catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [movementId, target.q, target.r, target.refId, target.kind, target.visibility, targetKind, movementType]);

  const continueLabel = movementType === 'ambush' ? '伏击军' : movementType === 'investigate' ? '调查军' : '驻扎军';
  const chosenMode = choice?.mode;
  const chosenLabel = choice?.label ?? '';
  const isVillage = targetKind === 'village' || targetKind === 'own_village';
  const isPve = targetKind === 'pve' || targetKind === 'taskcamp';

  async function continueMarch() {
    if (!choice) return;
    const mode = choice.mode;
    const payload: Record<string, unknown> = {
      movementId,
      q: resolvedTarget.q,
      r: resolvedTarget.r,
      mode,
    };
    if (isPve && ['scout', 'raid', 'investigate'].includes(mode)) payload.targetId = resolvedTarget.refId;
    if (isVillage && ['scout', 'raid', 'attack', 'reinforce', 'transfer'].includes(mode)) payload.targetVillage = resolvedTarget.refId;
    if (await act(req('ContinueGarrison', payload), { okToast: `${continueLabel}开始${chosenLabel}` })) {
      garrisonContinue.value = null;
      onClose();
    }
  }

  if (!choice) {
    const headerMeta: TargetMeta = {
      refId: resolvedTarget.refId,
      q: resolvedTarget.q,
      r: resolvedTarget.r,
      name: resolvedTarget.name,
      dist: 0,
      icon: isPve ? 'pve_bandits' : 'bld_main',
      mode: 'garrison',
      targetKind,
    };
    return (
      <Panel variant="gold" corners class="map-target-panel">
        <WorkflowHeader meta={headerMeta} step={1} onClose={onClose} />
        <TargetAssessment meta={headerMeta} options={options} onChoose={setChoice} />
        <div class="target-foot expedition-foot"><Btn onClick={onClose}>取消选择</Btn></div>
      </Panel>
    );
  }

  return (
    <Panel variant={chosenMode === 'attack' ? 'danger' : 'gold'} corners class="map-target-panel">
      <WorkflowHeader meta={{
        refId: resolvedTarget.refId,
        q: resolvedTarget.q,
        r: resolvedTarget.r,
        name: resolvedTarget.name,
        dist: 0,
        icon: isPve ? 'pve_bandits' : 'bld_main',
        mode: chosenMode ?? 'garrison',
        targetKind,
        declareWar: choice?.requiresDeclaration,
      }} step={3} onClose={onClose} />
      <div class="target-body expedition-body">
        <section class="expedition-confirm-card">
          <div class="expedition-kicker">保持编队</div>
          <h3>{chosenLabel}至「{resolvedTarget.name}」</h3>
          <p>该{continueLabel}会从当前驻扎地出发，保持所携部队和宝物，并继续占用原有的一个行军点。</p>
        </section>
        {(choice?.requiresDeclaration || chosenMode === 'raid' || chosenMode === 'attack') && (
          <p class="expedition-warning">{choice?.requiresDeclaration ? '该目标当前为中立玩家，确认后将同时宣战。' : `确认后${chosenLabel}抵达目标将立即执行。`}</p>
        )}
        <div class="target-foot expedition-foot expedition-foot--split">
          <Btn onClick={() => setChoice(null)}>返回模式选择</Btn>
          <Btn variant={chosenMode === 'attack' || choice?.requiresDeclaration ? 'danger' : 'primary'} size="lg" onClick={continueMarch}>确认{chosenLabel}</Btn>
        </div>
      </div>
    </Panel>
  );
}

/** 点击地图上己方驻扎军所在格：召回 / 续行，与行军列表一致。 */
function OwnStationedPanel({ move, onClose }: { move: Movement; onClose: () => void }) {
  const ambush = move.type === 'ambush';
  const investigating = move.type === 'investigate';
  const q = move.pos?.q ?? 0;
  const r = move.pos?.r ?? 0;
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="pve_bandits" label={investigating ? '调查军' : ambush ? '野外伏击' : '野外驻扎'} size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">己方{investigating ? '调查' : ambush ? '伏击' : '驻扎'}军</div>
          <div class="target-coord">({q},{r})</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div class="target-body expedition-body">
        <section class="expedition-assessment">
          <div class="expedition-kicker">驻扎中</div>
          <p>该格有你的{investigating ? '调查' : ambush ? '伏击' : '驻扎'}军。可召回返城，或选择下一处行军模式（编队与宝物保持原样）。</p>
        </section>
        <div class="target-foot expedition-foot expedition-foot--split">
          <Btn onClick={async () => {
            if (await act(req('RecallGarrison', { movementId: move.id }), { okToast: `${investigating ? '调查军' : ambush ? '伏击军' : '驻扎军'}开始返程` })) onClose();
          }}>召回</Btn>
          {!ambush && <Btn variant="primary" onClick={() => {
            garrisonContinue.value = { movementId: move.id, movementType: investigating ? 'investigate' : 'garrison' };
            selected.value = null;
            showToast(`请在地图上选择${investigating ? '调查军' : '驻扎军'}的下一处行军目标`);
            onClose();
          }}>选择行军模式</Btn>}
        </div>
      </div>
    </Panel>
  );
}

/** 点击地图上己方其他村庄派出的军队：先切换来源村，才允许下达命令。 */
function OwnArmyPanel({ move, onClose }: { move: Movement; onClose: () => void }) {
  const source = me?.villages?.find((v) => v.id === move.fromVillage);
  const typeLabel: Record<string, string> = {
    raid: '掠夺军', attack: '攻城军', return: '返程军', found: '拓荒军',
    transport: '运输队', caravan: '商队', garrison: '驻扎军', explore: '探索军',
    scout: '侦察军', ambush: '伏击军',
  };
  const isCurrent = move.fromVillage === me?.villageId;
  const status = move.status === 'marching' ? '行军中'
    : move.status === 'paused' ? '交战中'
      : move.status === 'stationed' ? '驻扎中' : '已停止';
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="ui_tab_army" label="己方军队" size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">己方{typeLabel[move.type] ?? '军队'}</div>
          <div class="target-coord">({move.pos?.q ?? 0},{move.pos?.r ?? 0})</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div class="target-body expedition-body">
        <section class="expedition-assessment">
          <div class="expedition-kicker">军队状态</div>
          <dl class="enemy-army-facts">
            <div><dt>来源村庄</dt><dd>{source?.name ?? move.fromVillage ?? '未知'}</dd></div>
            <div><dt>当前状态</dt><dd>{status}</dd></div>
            {!move.status || move.status === 'stationed' ? null : <div><dt>目标坐标</dt><dd>({move.to?.q ?? '?'},{move.to?.r ?? '?'})</dd></div>}
          </dl>
          {!isCurrent ? (
            <p class="expedition-modal-copy">这支军队属于其他村庄。切换到来源村庄后，才能继续下达召回或下一步行军命令。</p>
          ) : (
            <p class="expedition-modal-copy">这是当前村庄的军队，可以在此查看状态；驻扎军请使用召回或行军操作。</p>
          )}
        </section>
        <div class="target-foot expedition-foot expedition-foot--split">
          {!isCurrent ? (
            <Btn variant="primary" onClick={async () => {
              if (!move.fromVillage) return;
              const result = await switchVillage(move.fromVillage);
              if (result.ok) { selected.value = null; showToast(`已切换到「${source?.name ?? '来源村庄'}」，现在可以下达命令`); }
            }}>切换到来源村庄</Btn>
          ) : move.recallable ? (
            <Btn variant="danger" onClick={async () => {
              if (await act(req('RecallMarch', { movementId: move.id }), { okToast: '撤回令已下达，部队开始返程' })) onClose();
            }}>撤回</Btn>
          ) : null}
          <Btn onClick={onClose}>关闭</Btn>
        </div>
      </div>
    </Panel>
  );
}

/** 点击地图上「视野内的外国军队」后展示的只读信息卡：仅显示归属与类型，绝不暴露兵力/携带物。 */
function EnemyArmyPanel({ sel, onClose }: { sel: SelectedTarget; onClose: () => void }) {
  // 订阅 dataVersion（每次外国军队轮询刷新）与 tick（ETA 每秒走字）
  const _dv = dataVersion.value;
  void tick.value;
  const m = (foreignMoves.value?.movements ?? []).find((x) => x.id === sel.refId);
  const typeLabel: Record<string, string> = {
    raid: '掠夺军', attack: '进攻军', return: '返程军', found: '拓荒军',
    transport: '运输队', caravan: '商队', garrison: '驻扎军', explore: '探索军', auto_explore: '自动探索军',
    ambush: '伏击军',
  };
  return (
    <Panel variant="danger" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="bld_main" label={sel.name} size="sm" plate="round" />
        <div class="target-heading-copy">
          <div class="target-title">{sel.name}</div>
          <div class="target-coord">({sel.q},{sel.r})</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div class="target-body expedition-body">
        {m ? (
          <section class="expedition-assessment">
            <div class="expedition-kicker">敌方军队（脱敏信息）</div>
            <dl class="enemy-army-facts">
              <div><dt>所属玩家</dt><dd>{m.ownerPlayerName ?? '未知'}</dd></div>
              <div><dt>来源城镇</dt><dd>{m.ownerVillageName ?? '未知'}</dd></div>
              <div><dt>军队类型</dt><dd>{typeLabel[m.type] ?? m.type}</dd></div>
              <div><dt>当前状态</dt><dd>{m.status === 'marching' ? '行军中' : m.status === 'paused' ? '交战中' : '驻扎中'}</dd></div>
            </dl>
            <p class="enemy-army-note">看不到具体兵力与携带物。</p>
          </section>
        ) : (
          <p class="expedition-empty">该军队已离开视野或抵达目的地。</p>
        )}
        <div class="target-foot expedition-foot">
          <Btn onClick={onClose}>关闭</Btn>
        </div>
      </div>
    </Panel>
  );
}

/** 驻扎军选择行军模式后，在地图上点选下一处目标。 */
function GarrisonWaitPanel({ movementType, onCancel }: { movementType?: 'garrison' | 'ambush' | 'investigate'; onCancel: () => void }) {
  const ambush = movementType === 'ambush';
  const investigating = movementType === 'investigate';
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="pve_bandits" label={investigating ? '调查模式' : ambush ? '伏击模式' : '驻扎模式'} size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">选择下一处目标</div>
          <div class="target-coord">点击地图上的空地、野怪或玩家村庄</div>
        </div>
        <button type="button" class="target-close" onClick={onCancel} aria-label="取消行军模式">×</button>
      </div>
      <div class="target-body expedition-body">
        <p class="expedition-modal-copy">编队与宝物保持在原{investigating ? '调查' : ambush ? '伏击' : '驻扎'}军中，不会重新扣兵或多占行军点。</p>
        <div class="target-foot expedition-foot">
          <Btn onClick={onCancel}>取消选择</Btn>
        </div>
      </div>
    </Panel>
  );
}

export function TargetPanel() {
  const _dv = dataVersion.value;
  void foreignMoves.value;
  const sel = selected.value;
  const pending = garrisonContinue.value;
  if (!me) return null;
  if (pending && !sel) return <GarrisonWaitPanel movementType={pending.movementType} onCancel={() => { garrisonContinue.value = null; }} />;
  if (!sel) return null;

  const dist = hexDistanceWrapped({ q: sel.q, r: sel.r }, { q: me.q, r: me.r }, worldW(), worldH());
  const clearSelection = () => { selected.value = null; };
  const cancelAll = () => { selected.value = null; garrisonContinue.value = null; };

  const foe = foreignArmyAt(sel.q, sel.r);
  if (foe?.id) {
    return (
      <EnemyArmyPanel
        sel={{ ...sel, refId: foe.id, kind: 'enemy_army', name: foreignArmyName(foe) }}
        onClose={clearSelection}
      />
    );
  }

  const own = (sel.kind === 'own_army'
    ? (getCache().playerMoves?.movements ?? []).find((m: Movement) => m.id === sel.refId)
    : ownArmyAt(sel.q, sel.r)) as Movement | undefined;
  if (own) {
    if (own.fromVillage === me.villageId && own.status === 'stationed') {
      return <OwnStationedPanel move={own} onClose={clearSelection} />;
    }
    return <OwnArmyPanel move={own} onClose={clearSelection} />;
  }

  const stationed = ownStationedMoveAt(sel.q, sel.r);
  if (stationed) {
    return <OwnStationedPanel move={stationed} onClose={clearSelection} />;
  }

  if (pending) return <GarrisonContinuation movementId={pending.movementId} movementType={pending.movementType} target={sel} onClose={cancelAll} />;
  if (sel.kind === 'enemy_army') {
    return <EnemyArmyPanel sel={sel} onClose={clearSelection} />;
  }
  if (sel.kind === 'empty') return <EmptyTilePanel q={sel.q} r={sel.r} dist={dist} visibility={sel.visibility} onClose={clearSelection} />;

  const isOwn = sel.kind === 'own_village' || isOwnVillageId(sel.refId);
  if (sel.kind === 'own_village' || isOwnVillageId(sel.refId)) {
    return <OwnVillagePanel village={sel} onClose={clearSelection} />;
  }

  const meta: TargetMeta = {
    refId: sel.refId,
    q: sel.q,
    r: sel.r,
    name: sel.name,
    dist,
    icon: isOwn ? 'bld_main' : sel.kind === 'pve' ? (sel.icon ?? 'pve_bandits') : 'bld_main',
    mode: isOwn ? 'transfer' : sel.kind === 'pve' ? 'raid' : 'attack',
    isOwn,
    targetKind: sel.kind,
    taskInfo: sel.taskInfo,
  };

  return <ModeSelectPanel base={meta} kind={sel.kind} onClose={clearSelection} />;
}

function OwnVillagePanel({ village, onClose }: { village: SelectedTarget; onClose: () => void }) {
  const isCurrent = village.refId === me?.villageId;
  const choose = async () => {
    const result = await confirmOwnedVillage(village.refId, me?.villageId, switchVillage);
    if (!result.ok) showToast('切换村庄失败，请稍后重试', 'bad');
  };
  return (
    <Panel class="map-target-panel own-village-target" pad>
      <div class="target-head">
        <IconPlate icon={(village as any).icon ?? getCache().vil?.townCenter?.icon ?? 'ui_logo'} label={village.name} size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">{village.name}</div>
          <div class="target-coord">己方村庄 · X {village.q} · Y {village.r}</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭村庄信息">×</button>
      </div>
      <div class="target-body">
        <p class="expedition-modal-copy">{isCurrent ? '这是当前操作村庄。可进入王国页处理建设、驻军与训练。' : '这座村庄已在地图中选中；资源、驻军、建造与训练仍属于当前操作村。确认后将留在地图。'}</p>
        <div class="target-actions">
          {!isCurrent && <Btn variant="primary" onClick={() => void choose()}>确认切换为当前村庄</Btn>}
          {isCurrent && <Btn variant="primary" onClick={() => { tab.value = 'village'; }}>进入王国管理</Btn>}
        </div>
      </div>
    </Panel>
  );
}
