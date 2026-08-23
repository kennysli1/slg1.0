/**
 * Map target workflow: assess the selected tile, prepare a dispatch, then confirm.
 * Existing request payloads remain unchanged; only the interaction is staged.
 */
import { useEffect, useState } from 'preact/hooks';
import { getCache, type SelectedTarget } from '../../app/state.js';
import { dataVersion, selected, garrisonContinue, foreignMoves, tick, showToast, type TaskCampInfo } from '../../app/store.js';
import {
  worldW, worldH, treasureInfo, treasureRarityName, treasureCarryCap,
  unitInfo,
} from '../../app/config.js';
import { act } from '../../app/refresh.js';
import { req, me, isOwnVillageId } from '../../api.js';
import { fmt } from '../../shared/utils/format.js';
import { Btn, Icon, IconPlate, Panel, Tag } from '../../ui/index.js';
import { foreignArmyAt, foreignArmyName, ownStationedMoveAt } from './map-target-helpers.js';
import type { Movement } from '@slg/shared';

type WorkflowStep = 1 | 2 | 3;
type DispatchMode = 'attack' | 'raid' | 'transport' | 'transfer' | 'reinforce' | 'garrison' | 'explore' | 'scout';
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
const modeLabel = (mode: DispatchMode): string => ({ transport: '转移', transfer: '转移', reinforce: '增援', raid: '掠夺', attack: '攻城', garrison: '驻扎', explore: '探索', scout: '侦察' }[mode]);

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
  const copy = meta.mode === 'explore'
    ? '该格尚未探索。军队抵达后会立刻返城；若目标格已有设施或军队，则会在前一格掉头。集结点等级决定可探索的未探索深度。'
    : meta.mode === 'garrison'
    ? '派军队前往该坐标。抵达后若仍为空地便会原地驻扎；若已被设施或其他军队占据，部队将在前一格驻扎。'
    : isTransport
    ? '转移只能携带部队与随队宝物，不能携带木材、泥土、钢或粮食。'
    : meta.mode === 'raid'
      ? '野怪据点会触发掠夺战。确认兵力与宝物后再派出部队。'
    : meta.mode === 'reinforce' ? '盟军或中立村庄可接收增援，部队抵达后并入目标村。' : meta.mode === 'scout' ? (meta.targetKind === 'pve' || meta.targetKind === 'taskcamp' ? 'PvE 营地只能侦察资源与守军。只允许携带侦察兵；幸存部队会立即返城，若全军覆没则按 PvE 防守方规则处理携带宝物。' : '只允许携带侦察兵。抵达后获得目标情报，幸存部队会立即返城；携带宝物会随军返回，若全军覆没则被守方缴获。') : '这是其他玩家的村庄。请在确认前复核外交状态与编队。';
  const preparationLabel: Record<DispatchMode, string> = {
    attack: '编组攻城部队',
    raid: '编组掠夺部队',
    transport: '编组转移部队',
    transfer: '编组转移部队',
    reinforce: '编组增援部队',
    garrison: '编组驻扎部队',
    explore: '编组探索部队',
    scout: '编组侦察部队',
  };

  return (
    <div class="target-body expedition-body">
      {meta.taskInfo && <TaskCampInfoCard taskInfo={meta.taskInfo} />}
      <section class="expedition-assessment">
        <div class="expedition-kicker">目标评估</div>
        <div class="expedition-assessment-title">
          {meta.mode === 'explore' ? '未探索区域' : meta.mode === 'garrison' ? '野外空地' : isTransport ? '己方村庄转移' : meta.mode === 'reinforce' ? '盟军增援' : meta.mode === 'raid' ? '掠夺目标' : meta.targetKind === 'pve' || meta.targetKind === 'taskcamp' ? 'PvE 侦察目标' : '玩家村庄侦察目标'}
        </div>
        <p>{copy}</p>
        <div class="expedition-facts">
          <span>目标坐标 <b>{meta.q},{meta.r}</b></span>
          <span>行军距离 <b>{meta.dist} 格</b></span>
          <span>行动类型 <Tag kind={isTransport || meta.mode === 'reinforce' ? 'steel' : meta.mode === 'raid' ? 'ember' : meta.mode === 'garrison' || meta.mode === 'explore' ? 'gold' : 'crimson'}>{modeLabel(meta.mode)}</Tag></span>
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
  if (meta.targetKind === 'empty') return '可拓荒空地';
  if (meta.targetKind === 'unexplored') return '未探索区域';
  if (meta.targetKind === 'pve' || meta.targetKind === 'taskcamp') return 'PvE 营地';
  if (meta.targetKind === 'own_village' || meta.isOwn) return '己方村庄';
  return '玩家村庄';
}

function targetAssessmentCopy(meta: TargetMeta): string {
  if (meta.targetKind === 'empty') return '这是可行动的空地。可驻扎；拥有拓荒者时还可拓荒建村。';
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
  const scoutCodes = new Set(['equlegati', 'pathfinder', 'teuscout']);
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
  meta, onClose, initialStep = 1, modeOptions, onSelectMode,
}: {
  meta: TargetMeta;
  onClose: () => void;
  initialStep?: WorkflowStep;
  modeOptions?: ModeOption[];
  onSelectMode?: (option: ModeOption) => void;
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
    } else if (meta.mode === 'explore') {
      ok = await act(req('SendExplore', { q: meta.q, r: meta.r, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '探索部队出发，抵达后将返城' });
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
      {step === 2 && <Preparation meta={meta} troops={troops} setTroops={setTroops} treasures={treasures} setTreasures={setTreasures} scoutType={scoutType} setScoutType={setScoutType} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
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
  const [founding, setFounding] = useState(false);
  async function found() {
    if (await act(req('FoundVillage', { q, r }), { okToast: '拓荒令已发出' })) onClose();
  }
  const meta: TargetMeta = { refId: '', q, r, dist, name: '空地', icon: 'bld_main', mode: 'garrison' };
  const depth = visibility === 'unexplored' ? unexploredDepth(q, r) : 0;
  const maxExploreDepth = rallypointLevel();
  const allowExplore = visibility !== 'unexplored' || (depth >= 1 && depth <= maxExploreDepth);
  if (founding) return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={{ ...meta, mode: 'garrison' }} step={3} onClose={onClose} />
      <div class="target-body expedition-body"><section class="expedition-confirm-card"><div class="expedition-kicker">拓荒命令</div><h3>拓荒至 ({q},{r})</h3><p>服务器将复核拓荒者、开城资源、人口与村庄上限。</p></section><div class="target-foot expedition-foot expedition-foot--split"><Btn onClick={() => setFounding(false)}>返回</Btn><Btn variant="primary" size="lg" onClick={found}>确认拓荒</Btn></div></div>
    </Panel>
  );
  if (garrison) {
    const exploring = visibility === 'unexplored';
    return <ExpeditionWorkflow meta={{ ...meta, name: exploring ? '未探索区域' : '野外驻扎点', icon: 'pve_bandits', mode: exploring ? 'explore' : 'garrison' }} initialStep={2} onClose={onClose} />;
  }
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={meta} step={1} onClose={onClose} />
      <div class="target-body expedition-body">
        <section class="expedition-assessment">
          <div class="expedition-kicker">目标评估</div>
          <div class="expedition-assessment-title">{visibility === 'unexplored' ? '未探索区域' : '可拓荒空地'}</div>
          <p>{visibility === 'unexplored' ? allowExplore ? `未探索格不能驻扎；该格深度为 ${depth}，选择探索后军队抵达会立即返城。` : `该未探索格深度为 ${depth < 0 ? '未知' : depth}，当前集结点 ${maxExploreDepth} 级，最多探索 ${maxExploreDepth} 格深；无法探索。` : '可选择驻扎；拥有拓荒者时才显示拓荒模式。驻扎军抵达时会再次确认格子仍为空地。'}</p>
          <div class="expedition-facts">
            <span>目标坐标 <b>{q},{r}</b></span>
            <span>行军距离 <b>{dist} 格</b></span>
          </div>
          <div class="expedition-kicker expedition-mode-kicker">可用行军模式</div>
          <div class="target-actions target-actions--management expedition-mode-options">
            {allowExplore && <Btn variant="primary" block onClick={() => setGarrison(true)}>{visibility === 'unexplored' ? '探索' : '驻扎'}</Btn>}
            {visibility !== 'unexplored' && Number((getCache().army?.troops as any)?.settler ?? 0) > 0 && <Btn variant="ghost" block onClick={() => setFounding(true)}>拓荒</Btn>}
          </div>
          {!allowExplore && visibility === 'unexplored' && <p class="expedition-empty">当前没有可用的行军模式。</p>}
        </section>
      </div>
    </Panel>
  );
}

/** 驻扎军“行军”后的目标确认：兵力与宝物保持在原军中，不会重新扣兵或多占行军点。 */
function GarrisonContinuation({ movementId, target, onClose }: {
  movementId: string; target: { refId: string; kind: string; q: number; r: number; name: string; visibility?: string }; onClose: () => void;
}) {
  const mode: 'garrison' | 'explore' | 'raid' | 'attack' = target.kind === 'pve'
    ? 'raid'
    : target.kind === 'village' ? 'attack' : target.visibility === 'unexplored' ? 'explore' : 'garrison';
  const label = mode === 'raid' ? '掠夺' : mode === 'attack' ? '攻城' : mode === 'explore' ? '探索' : '驻扎';
  const depth = mode === 'explore' ? unexploredDepth(target.q, target.r) : 0;
  const maxExploreDepth = rallypointLevel();
  const allowExplore = mode !== 'explore' || (depth >= 1 && depth <= maxExploreDepth);
  async function continueMarch() {
    const payload: Record<string, unknown> = { movementId, q: target.q, r: target.r, mode };
    if (mode === 'raid') payload.targetId = target.refId;
    if (mode === 'attack') payload.targetVillage = target.refId;
    if (await act(req('ContinueGarrison', payload), { okToast: `驻扎军开始${label}` })) {
      garrisonContinue.value = null;
      onClose();
    }
  }
  return (
    <Panel variant={mode === 'attack' ? 'danger' : 'gold'} corners class="map-target-panel">
      <div class="target-head"><IconPlate icon={mode === 'garrison' ? 'pve_bandits' : 'bld_main'} label={target.name} size="sm" plate="gold" /><div class="target-heading-copy"><div class="target-title">选择行军模式</div><div class="target-coord">({target.q},{target.r})</div></div><button type="button" class="target-close" onClick={onClose} aria-label="取消行军模式">×</button></div>
      <div class="target-body expedition-body"><section class="expedition-confirm-card"><div class="expedition-kicker">保持编队</div><h3>{label}至「{target.name}」</h3><p>{allowExplore ? '该军队会从当前驻扎地出发，保持所携部队和宝物，并继续占用原有的一个行军点。' : `该未探索格深度为 ${depth < 0 ? '未知' : depth}，当前集结点 ${maxExploreDepth} 级，最多探索 ${maxExploreDepth} 格深；无法探索。`}</p></section><div class="target-foot expedition-foot expedition-foot--split"><Btn onClick={onClose}>{allowExplore ? '取消' : '返回'}</Btn>{allowExplore && <Btn variant={mode === 'attack' ? 'danger' : 'primary'} size="lg" onClick={continueMarch}>确认{label}</Btn>}</div></div>
    </Panel>
  );
}

/** 点击地图上己方驻扎军所在格：召回 / 续行，与行军列表一致。 */
function OwnStationedPanel({ move, onClose }: { move: Movement; onClose: () => void }) {
  const q = move.pos?.q ?? 0;
  const r = move.pos?.r ?? 0;
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="pve_bandits" label="野外驻扎" size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">己方驻扎军</div>
          <div class="target-coord">({q},{r})</div>
        </div>
        <button type="button" class="target-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div class="target-body expedition-body">
        <section class="expedition-assessment">
          <div class="expedition-kicker">驻扎中</div>
          <p>该格有你的驻扎军。可召回返城，或选择下一处行军模式（编队与宝物保持原样）。</p>
        </section>
        <div class="target-foot expedition-foot expedition-foot--split">
          <Btn onClick={async () => {
            if (await act(req('RecallGarrison', { movementId: move.id }), { okToast: '驻扎军开始返程' })) onClose();
          }}>召回</Btn>
          <Btn variant="primary" onClick={() => {
            garrisonContinue.value = { movementId: move.id };
            selected.value = null;
            showToast('请在地图上选择驻扎军的下一处行军目标');
            onClose();
          }}>选择行军模式</Btn>
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
    transport: '运输队', caravan: '商队', garrison: '驻扎军', explore: '探索军',
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
function GarrisonWaitPanel({ onCancel }: { onCancel: () => void }) {
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="pve_bandits" label="行军模式" size="sm" plate="gold" />
        <div class="target-heading-copy">
          <div class="target-title">选择下一处目标</div>
          <div class="target-coord">点击地图上的空地、野怪或玩家村庄</div>
        </div>
        <button type="button" class="target-close" onClick={onCancel} aria-label="取消行军模式">×</button>
      </div>
      <div class="target-body expedition-body">
        <p class="expedition-modal-copy">编队与宝物保持在原驻扎军中，不会重新扣兵或多占行军点。</p>
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
  if (pending && !sel) return <GarrisonWaitPanel onCancel={() => { garrisonContinue.value = null; }} />;
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

  const stationed = ownStationedMoveAt(sel.q, sel.r);
  if (stationed) {
    return <OwnStationedPanel move={stationed} onClose={clearSelection} />;
  }

  if (pending) return <GarrisonContinuation movementId={pending.movementId} target={sel} onClose={cancelAll} />;
  if (sel.kind === 'enemy_army') {
    return <EnemyArmyPanel sel={sel} onClose={clearSelection} />;
  }
  if (sel.kind === 'empty') return <EmptyTilePanel q={sel.q} r={sel.r} dist={dist} visibility={sel.visibility} onClose={clearSelection} />;

  const isOwn = sel.kind === 'own_village' || isOwnVillageId(sel.refId);
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
