/**
 * Map target workflow: assess the selected tile, prepare a dispatch, then confirm.
 * Existing request payloads remain unchanged; only the interaction is staged.
 */
import { useState } from 'preact/hooks';
import { getCache } from '../../app/state.js';
import { dataVersion, selected, openModal } from '../../app/store.js';
import {
  worldW, worldH, treasureInfo, treasureRarityName, treasureCarryCap,
  unitInfo, resourceKeys, resInfo,
} from '../../app/config.js';
import { act } from '../../app/refresh.js';
import { req, me, isOwnVillageId, selectVillage, abandonVillage } from '../../api.js';
import { fmt } from '../../shared/utils/format.js';
import { Btn, Icon, IconPlate, Modal, Panel, Tag } from '../../ui/index.js';

type WorkflowStep = 1 | 2 | 3;
type DispatchMode = 'attack' | 'raid' | 'transport';
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
  isCapital?: boolean;
}

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
  const modeLabel = meta.mode === 'transport' ? '运输' : meta.mode === 'raid' ? '掠夺' : '进攻';
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
      <ol class="expedition-steps" aria-label={`${modeLabel}流程`}>
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
  meta, onNext, onSwitch, onAbandon,
}: {
  meta: TargetMeta;
  onNext: () => void;
  onSwitch?: () => void;
  onAbandon?: () => void;
}) {
  const isTransport = meta.mode === 'transport';
  const copy = isTransport
    ? '选择运输部队、物资与随队宝物。运输需要同时携带部队和货物。'
    : meta.mode === 'raid'
      ? '野怪据点会触发掠夺战。确认兵力与宝物后再派出部队。'
      : '这是其他玩家的村庄。进攻会进入战斗流程，请在确认前复核编队。';

  return (
    <div class="target-body expedition-body">
      <section class="expedition-assessment">
        <div class="expedition-kicker">目标评估</div>
        <div class="expedition-assessment-title">
          {isTransport ? '己方村庄补给线' : meta.mode === 'raid' ? '野怪据点' : '敌对村庄'}
        </div>
        <p>{copy}</p>
        <div class="expedition-facts">
          <span>目标坐标 <b>{meta.q},{meta.r}</b></span>
          <span>行军距离 <b>{meta.dist} 格</b></span>
          <span>行动类型 <Tag kind={isTransport ? 'steel' : meta.mode === 'raid' ? 'ember' : 'crimson'}>{isTransport ? '运输' : meta.mode === 'raid' ? '掠夺' : '进攻'}</Tag></span>
        </div>
      </section>

      {meta.isOwn && (
        <div class="target-actions target-actions--management">
          <Btn onClick={onSwitch}>切换到此村</Btn>
          {!meta.isCapital && <Btn variant="danger" onClick={onAbandon}>放弃此村</Btn>}
        </div>
      )}

      <div class="target-foot expedition-foot">
        <Btn variant={meta.mode === 'attack' ? 'danger' : 'primary'} size="lg" block onClick={onNext}>
          继续：{isTransport ? '编队与装载' : '编队'}
        </Btn>
      </div>
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
  troops, setTroops, transport,
}: { troops: NumberMap; setTroops: (troops: NumberMap) => void; transport: boolean }) {
  const army = getCache().army;
  const entries = Object.entries(army?.troops ?? {}).filter(([, amount]) => Number(amount) > 0);
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

function CargoPlanner({ cargo, setCargo }: { cargo: NumberMap; setCargo: (cargo: NumberMap) => void }) {
  const resources = getCache().res?.resources ?? {};
  return (
    <section class="target-section">
      <div class="target-section-head"><span>运输货物</span><small>不含金币</small></div>
      <div class="cargo-inputs">
        {resourceKeys().filter((key) => key !== 'gold').map((key) => {
          const max = Math.floor(resources[key] ?? 0);
          const info = resInfo(key);
          return (
            <label key={key} class="cargo-row">
              <Icon icon={info.icon} label={info.name} size="xs" />
              <span>{info.name}</span>
              <NumberInput
                value={cargo[key] ?? 0}
                max={max}
                label={`${info.name}数量，最多${max}`}
                onChange={(amount) => setCargo({ ...cargo, [key]: amount })}
              />
              <small class="cargo-max">/{fmt(max)}</small>
            </label>
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
  meta, troops, setTroops, cargo, setCargo, treasures, setTreasures, onBack, onNext,
}: {
  meta: TargetMeta;
  troops: NumberMap;
  setTroops: (troops: NumberMap) => void;
  cargo: NumberMap;
  setCargo: (cargo: NumberMap) => void;
  treasures: string[];
  setTreasures: (codes: string[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const troopCount = total(troops);
  const cargoCount = total(cargo);
  const canContinue = troopCount > 0 && (meta.mode !== 'transport' || cargoCount > 0);
  return (
    <div class="target-body expedition-body">
      <TroopPlanner troops={troops} setTroops={setTroops} transport={meta.mode === 'transport'} />
      {meta.mode === 'transport' && <CargoPlanner cargo={cargo} setCargo={setCargo} />}
      <TreasurePlanner selectedCodes={treasures} setSelectedCodes={setTreasures} troopCount={troopCount} />
      <div class="expedition-validation" aria-live="polite">
        {canContinue
          ? `已选择 ${fmt(troopCount)} 名部队${meta.mode === 'transport' ? `，装载 ${fmt(cargoCount)} 单位物资` : ''}。`
          : meta.mode === 'transport'
            ? '运输需要至少选择一支部队和一种货物。'
            : '请选择至少一名部队。'}
      </div>
      <div class="target-foot expedition-foot expedition-foot--split">
        <Btn onClick={onBack}>上一步</Btn>
        <Btn variant={meta.mode === 'attack' ? 'danger' : 'primary'} size="lg" disabled={!canContinue} onClick={onNext}>继续：确认</Btn>
      </div>
    </div>
  );
}

function Confirmation({
  meta, troops, cargo, treasures, onBack, onDispatch,
}: { meta: TargetMeta; troops: NumberMap; cargo: NumberMap; treasures: string[]; onBack: () => void; onDispatch: () => void }) {
  const treasureNames = treasures.map((code) => treasureInfo(code)?.name ?? code);
  const action = meta.mode === 'transport' ? '确认运输' : meta.mode === 'raid' ? '确认掠夺' : '确认进攻';
  return (
    <div class="target-body expedition-body">
      <section class="expedition-confirm-card">
        <div class="expedition-kicker">出征命令</div>
        <h3>{action}至「{meta.name}」</h3>
        <dl>
          <div><dt>目标</dt><dd>({meta.q},{meta.r}) · {meta.dist} 格</dd></div>
          <div><dt>部队</dt><dd>{formatUnitSummary(troops)}</dd></div>
          {meta.mode === 'transport' && <div><dt>物资</dt><dd>{Object.entries(cargo).filter(([, amount]) => amount > 0).map(([key, amount]) => `${resInfo(key).name} ${fmt(amount)}`).join(' · ')}</dd></div>}
          <div><dt>宝物</dt><dd>{treasureNames.length ? treasureNames.join(' · ') : '不携带'}</dd></div>
        </dl>
      </section>
      {meta.mode === 'attack' && <p class="expedition-warning">这是最终确认：部队抵达目标后将立即进入战斗。</p>}
      <div class="target-foot expedition-foot expedition-foot--split">
        <Btn onClick={onBack}>返回调整</Btn>
        <Btn variant={meta.mode === 'attack' ? 'danger' : 'primary'} size="lg" onClick={onDispatch}>{action}</Btn>
      </div>
    </div>
  );
}

function ExpeditionWorkflow({ meta, onClose }: { meta: TargetMeta; onClose: () => void }) {
  const [step, setStep] = useState<WorkflowStep>(1);
  const [troops, setTroops] = useState<NumberMap>({});
  const [cargo, setCargo] = useState<NumberMap>({});
  const [treasures, setTreasures] = useState<string[]>([]);

  async function dispatch() {
    const selectedTroops = Object.fromEntries(Object.entries(troops).filter(([, amount]) => amount > 0));
    const selectedCargo = Object.fromEntries(Object.entries(cargo).filter(([, amount]) => amount > 0));
    const cap = treasureCarryCap(total(selectedTroops));
    const selectedTreasures = treasures.slice(0, cap);
    let ok = false;
    if (meta.mode === 'transport') {
      ok = await act(req('SendTransport', {
        targetVillage: meta.refId, troops: selectedTroops, cargo: selectedCargo, treasures: selectedTreasures,
      }), { okToast: '运输部队出发' });
    } else if (meta.mode === 'raid') {
      ok = await act(req('SendRaid', { targetId: meta.refId, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '掠夺部队出发' });
    } else {
      ok = await act(req('SendAttack', { targetVillage: meta.refId, troops: selectedTroops, treasures: selectedTreasures }), { okToast: '攻击部队出发' });
    }
    if (ok) onClose();
  }

  async function switchVillage() {
    const result = await selectVillage(meta.refId);
    if (result.ok) onClose();
  }

  function confirmAbandon() {
    openModal((close) => (
      <Modal
        title="放弃村庄"
        sub={meta.name}
        onClose={close}
        foot={<><Btn onClick={close}>取消</Btn><Btn variant="danger" onClick={async () => {
          close();
          if (await abandonVillage(meta.refId)) onClose();
        }}>确认放弃</Btn></>}
      >
        <p class="expedition-modal-copy">确认放弃「{meta.name}」？驻军将解散、资源清空且地块回归空地。此操作不可撤销。</p>
      </Modal>
    ), 'abandon-village');
  }

  return (
    <Panel variant={meta.mode === 'attack' ? 'danger' : 'gold'} corners class="map-target-panel">
      <WorkflowHeader meta={meta} step={step} onClose={onClose} />
      {step === 1 && <Assessment meta={meta} onNext={() => setStep(2)} onSwitch={switchVillage} onAbandon={confirmAbandon} />}
      {step === 2 && <Preparation meta={meta} troops={troops} setTroops={setTroops} cargo={cargo} setCargo={setCargo} treasures={treasures} setTreasures={setTreasures} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
      {step === 3 && <Confirmation meta={meta} troops={troops} cargo={cargo} treasures={treasures} onBack={() => setStep(2)} onDispatch={dispatch} />}
    </Panel>
  );
}

function EmptyTilePanel({ q, r, dist, onClose }: { q: number; r: number; dist: number; onClose: () => void }) {
  const [step, setStep] = useState<WorkflowStep>(1);
  async function found() {
    if (await act(req('FoundVillage', { q, r }), { okToast: '拓荒令已发出' })) onClose();
  }
  const meta: TargetMeta = { refId: '', q, r, dist, name: '空地', icon: 'bld_main', mode: 'transport' };
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <WorkflowHeader meta={meta} step={step} onClose={onClose} />
      <div class="target-body expedition-body">
        {step === 1 && <section class="expedition-assessment"><div class="expedition-kicker">目标评估</div><div class="expedition-assessment-title">可拓荒空地</div><p>需主基地与人口规模达标，并备齐 3 名拓荒者与开城资源。失败不退开城包。</p></section>}
        {step === 2 && <section class="expedition-assessment"><div class="expedition-kicker">拓荒准备</div><div class="expedition-assessment-title">由服务器复核条件</div><p>提交后将由服务器校验拓荒者、资源、人口和村庄数量限制。</p></section>}
        {step === 3 && <section class="expedition-confirm-card"><div class="expedition-kicker">确认命令</div><h3>拓荒至 ({q},{r})</h3><p>确认后将消耗开城资源并派遣拓荒者。</p></section>}
        <div class="target-foot expedition-foot expedition-foot--split">
          {step > 1 && <Btn onClick={() => setStep((step - 1) as WorkflowStep)}>上一步</Btn>}
          <Btn variant="primary" size="lg" block={step === 1} onClick={() => step < 3 ? setStep((step + 1) as WorkflowStep) : found()}>
            {step < 3 ? '继续' : '确认拓荒'}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

export function TargetPanel() {
  const _dv = dataVersion.value;
  const sel = selected.value;
  if (!sel || !me) return null;
  const dist = hexDistanceWrapped({ q: sel.q, r: sel.r }, { q: me.q, r: me.r }, worldW(), worldH());
  const close = () => { selected.value = null; };
  if (sel.kind === 'empty') return <EmptyTilePanel q={sel.q} r={sel.r} dist={dist} onClose={close} />;

  const isOwn = sel.kind === 'own_village' || isOwnVillageId(sel.refId);
  const village = me.villages?.find((item) => item.id === sel.refId);
  const meta: TargetMeta = {
    refId: sel.refId,
    q: sel.q,
    r: sel.r,
    name: sel.name,
    dist,
    icon: isOwn ? 'bld_main' : sel.kind === 'pve' ? (sel.icon ?? 'pve_bandits') : 'bld_main',
    mode: isOwn ? 'transport' : sel.kind === 'pve' ? 'raid' : 'attack',
    isOwn,
    isCapital: village?.isCapital || sel.refId === me.capitalVillageId,
  };

  return <ExpeditionWorkflow meta={meta} onClose={close} />;
}
