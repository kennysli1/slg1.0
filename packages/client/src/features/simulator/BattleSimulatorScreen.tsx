import { useEffect, useMemo, useState } from 'preact/hooks';
import { req } from '../../api.js';
import { Btn, Panel, SectionHead, Tag } from '../../ui/index.js';

interface CatalogTrait { code?: string; name: string; description: string; }
interface CatalogUnit { code: string; name: string; tribe: string; attack: number; defense: number; hp: number; traits: CatalogTrait[]; }
interface Catalog { units: CatalogUnit[]; constants: { damageFormula?: string; traits?: string[] }; }
interface Row { code: string; count: string }
interface SideForm { rows: Row[]; }
type Side = 'attacker' | 'defender';
type Troops = Record<string, number>;

interface SimulationStep {
  phase?: string;
  step?: string | number;
  round?: number;
  name?: string;
  label?: string;
  before?: Partial<Record<Side, Troops>>;
  after?: Partial<Record<Side, Troops>>;
  attackPower?: Partial<Record<Side, number>>;
  defensePower?: Partial<Record<Side, number>>;
  damage?: Partial<Record<Side, number>>;
  losses?: Partial<Record<Side, number>>;
  damageToAttacker?: number;
  damageToDefender?: number;
  lossesToAttacker?: number;
  lossesToDefender?: number;
  traits?: unknown;
  traitSummary?: unknown;
  effects?: unknown;
}

interface SimulationPhase { id?: string; name?: string; label?: string; steps?: SimulationStep[]; traits?: unknown; traitSummary?: unknown; effects?: unknown; }
interface SimulationReport {
  winner?: 'attacker' | 'defender' | 'draw';
  totals?: Partial<Record<Side, number>>;
  rules?: { damageFormula?: string; distribution?: string; simultaneous?: boolean };
  phases?: SimulationPhase[];
  stages?: SimulationPhase[];
}

const stepPhaseMeta: Record<string, { id: string; name: string }> = {
  bow_cavalry: { id: 'bow_cavalry', name: '第一阶段：弓骑齐射' },
  cavalry_charge: { id: 'cavalry_charge', name: '第一阶段：冲锋' },
  ranged: { id: 'ranged', name: '第二阶段：远程打击' },
  melee: { id: 'melee', name: '第三阶段：近战互殴' },
};

const emptySide = (first?: CatalogUnit): SideForm => ({ rows: first ? [{ code: first.code, count: '100' }] : [] });

function numberOf(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function fmt(value: unknown, digits = 0): string {
  return numberOf(value).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function sumTroops(rows: Row[]): Troops {
  return rows.reduce<Troops>((troops, row) => {
    const count = Math.max(0, Math.floor(numberOf(row.count)));
    if (row.code && count > 0) troops[row.code] = (troops[row.code] ?? 0) + count;
    return troops;
  }, {});
}

function phaseName(phase: SimulationPhase, index: number): string {
  const raw = phase.label ?? phase.name ?? phase.id ?? '';
  const lower = raw.toLowerCase();
  if (lower.includes('mounted') || raw.includes('弓骑')) return '弓骑齐射';
  if (lower.includes('charge') || raw.includes('冲锋')) return '冲锋';
  if (lower.includes('range') || raw.includes('远程')) return '远程';
  if (lower.includes('melee') || raw.includes('近战')) return '近战';
  return raw || `阶段 ${index + 1}`;
}

function isMeleePhase(phase: SimulationPhase): boolean {
  const raw = `${phase.id ?? ''} ${phase.name ?? ''} ${phase.label ?? ''}`.toLowerCase();
  return raw.includes('melee') || raw.includes('近战');
}

function metric(step: SimulationStep, kind: 'attack' | 'defense' | 'damage' | 'losses', side: Side): number {
  const fields = kind === 'attack' ? step.attackPower
    : kind === 'defense' ? step.defensePower
      : kind === 'damage' ? step.damage
        : step.losses;
  if (fields && side in fields) return numberOf(fields[side]);
  if (kind === 'damage') return numberOf(side === 'attacker' ? step.damageToAttacker : step.damageToDefender);
  if (kind === 'losses') return numberOf(side === 'attacker' ? step.lossesToAttacker : step.lossesToDefender);
  return 0;
}

function snapshot(step: SimulationStep, point: 'before' | 'after', side: Side): Troops {
  const value = step[point]?.[side];
  return value && typeof value === 'object' ? value : {};
}

function traitLines(value: unknown, traitByCode: Map<string, CatalogTrait>): string[] {
  if (typeof value === 'string') {
    const trait = traitByCode.get(value);
    return value ? [trait ? `${trait.name}：${trait.description}` : value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => traitLines(item, traitByCode));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const direct = [record.description, record.label, record.name, record.text].filter((item): item is string => typeof item === 'string');
  if (direct.length) return direct;
  return Object.values(record).flatMap((item) => traitLines(item, traitByCode));
}

function displayPhases(report: SimulationReport): SimulationPhase[] {
  const source = report.phases ?? report.stages ?? [];
  const phases: SimulationPhase[] = [];
  for (const phase of source) {
    const knownSteps = new Map<string, SimulationStep[]>();
    const unknownSteps: SimulationStep[] = [];
    for (const step of phase.steps ?? []) {
      const key = typeof step.step === 'string' ? step.step : '';
      if (stepPhaseMeta[key]) {
        const group = knownSteps.get(key) ?? [];
        group.push(step);
        knownSteps.set(key, group);
      } else unknownSteps.push(step);
    }
    if (knownSteps.size === 0) {
      phases.push(phase);
      continue;
    }
    for (const [key, steps] of knownSteps) {
      phases.push({ ...stepPhaseMeta[key], steps });
    }
    if (unknownSteps.length) phases.push({ ...phase, steps: unknownSteps });
  }
  return phases;
}

export function BattleSimulatorScreen() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attacker, setAttacker] = useState<SideForm>(emptySide());
  const [defender, setDefender] = useState<SideForm>(emptySide());
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void req('GetCatalog').then((response) => {
      if (!response.ok) { setError(response.error?.msg ?? '无法读取模拟器配置'); return; }
      const next = response.payload as unknown as Catalog;
      setCatalog(next);
      setAttacker(emptySide(next.units[0]));
      setDefender(emptySide(next.units[0]));
    }).catch(() => setError('连接服务器失败，请刷新页面重试'));
  }, []);

  const unitByCode = useMemo(() => new Map((catalog?.units ?? []).map((unit) => [unit.code, unit])), [catalog]);
  const traitByCode = useMemo(() => new Map((catalog?.units ?? []).flatMap((unit) => unit.traits.map((trait) => [trait.code ?? trait.name, trait] as const))), [catalog]);

  async function simulate(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await req('Simulate', { scenario: { attacker: { troops: sumTroops(attacker.rows) }, defender: { troops: sumTroops(defender.rows) } } });
      if (!response.ok) setError(response.error?.msg ?? '模拟失败');
      else setReport(response.payload as unknown as SimulationReport);
    } catch {
      setError('模拟请求失败');
    } finally {
      setBusy(false);
    }
  }

  if (!catalog) return <main class="battle-sim-page"><Panel pad><h1>战斗模拟器</h1><p>{error || '正在读取兵种配置…'}</p></Panel></main>;

  return (
    <main class="battle-sim-page">
      <header class="battle-sim-header">
        <div><h1>战斗模拟器</h1><p>按弓骑齐射、冲锋、远程、近战顺序结算；每一步均以开始时兵力快照同时承伤。</p></div>
        <a href="/">返回主游戏</a>
      </header>
      <form onSubmit={simulate}>
        <Panel pad class="battle-sim-toolbar">
          <span class="battle-sim-rule">{catalog.constants.damageFormula ? `伤害公式：${catalog.constants.damageFormula}。` : ''} {catalog.constants.traits?.join('；')}</span>
          <Btn type="submit" variant="primary" disabled={busy}>{busy ? '计算中…' : '开始模拟'}</Btn>
        </Panel>
        <div class="battle-sim-sides">
          <SideEditor title="进攻方" value={attacker} setValue={setAttacker} catalog={catalog} unitByCode={unitByCode}/>
          <SideEditor title="防守方" value={defender} setValue={setDefender} catalog={catalog} unitByCode={unitByCode}/>
        </div>
      </form>
      {error && <p class="battle-sim-error" role="alert">{error}</p>}
      {report && <ReportView report={report} unitByCode={unitByCode} traitByCode={traitByCode}/>}
    </main>
  );
}

function SideEditor({ title, value, setValue, catalog, unitByCode }: { title: string; value: SideForm; setValue: (next: SideForm) => void; catalog: Catalog; unitByCode: Map<string, CatalogUnit> }) {
  const row = (index: number, patch: Partial<Row>) => setValue({ ...value, rows: value.rows.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return (
    <Panel pad class="battle-sim-side">
      <SectionHead sub="仅填写参战兵力；属性和阶段特性由配置中心下发">{title}</SectionHead>
      <div class="battle-sim-roster">
        {value.rows.map((item, index) => {
          const unit = unitByCode.get(item.code);
          return <div class="battle-sim-row" key={`${index}-${item.code}`}>
            <select aria-label={`${title}兵种`} value={item.code} onChange={(event) => row(index, { code: (event.currentTarget as HTMLSelectElement).value })}>
              {catalog.units.map((entry) => <option key={entry.code} value={entry.code}>{entry.name}（攻 {entry.attack} / 防 {entry.defense} / 生 {entry.hp}）</option>)}
            </select>
            <input aria-label={`${unit?.name ?? '兵种'}数量`} type="number" min="0" value={item.count} onInput={(event) => row(index, { count: (event.currentTarget as HTMLInputElement).value })}/>
            <span class="battle-sim-unit-hint" title={unit?.traits.map((trait) => trait.description).join('；')}>{unit?.traits.map((trait) => trait.name).join('、') || '无阶段特性'}</span>
            <Btn size="sm" variant="ghost" onClick={() => setValue({ ...value, rows: value.rows.filter((_, i) => i !== index) })}>删除</Btn>
          </div>;
        })}
      </div>
      <Btn size="sm" onClick={() => setValue({ ...value, rows: [...value.rows, { code: catalog.units[0]?.code ?? '', count: '0' }] })}>＋ 添加兵种</Btn>
    </Panel>
  );
}

function ReportView({ report, unitByCode, traitByCode }: { report: SimulationReport; unitByCode: Map<string, CatalogUnit>; traitByCode: Map<string, CatalogTrait> }) {
  const phases = displayPhases(report);
  const winner = report.winner === 'attacker' ? '进攻方胜利' : report.winner === 'defender' ? '防守方胜利' : '未分胜负';
  return (
    <section class="battle-sim-report" aria-label="战斗报告">
      <div class="battle-sim-report-title"><div><h2>战斗报告</h2><p>{report.rules?.damageFormula}{report.rules?.distribution ? `；${report.rules.distribution}` : ''}</p></div><Tag kind={report.winner === 'draw' ? 'ember' : 'jade'}>{winner}</Tag></div>
      <div class="battle-sim-final"><span>最终进攻方 <strong>{fmt(report.totals?.attacker)}</strong></span><span>最终防守方 <strong>{fmt(report.totals?.defender)}</strong></span></div>
      {phases.length ? phases.map((phase, index) => <PhaseCard key={`${phase.id ?? phase.name ?? index}-${index}`} phase={phase} index={index} unitByCode={unitByCode} traitByCode={traitByCode}/>) : <p class="battle-sim-empty">服务端没有返回阶段明细。</p>}
    </section>
  );
}

function PhaseCard({ phase, index, unitByCode, traitByCode }: { phase: SimulationPhase; index: number; unitByCode: Map<string, CatalogUnit>; traitByCode: Map<string, CatalogTrait> }) {
  const title = phaseName(phase, index);
  const steps = phase.steps ?? [];
  const traits = traitLines(phase.traits ?? phase.traitSummary ?? phase.effects, traitByCode);
  const body = <div class="battle-sim-phase-body">
    {traits.length > 0 && <TraitList traits={traits}/>}
    {steps.length === 0 ? <p class="battle-sim-empty">本阶段没有可结算的目标。</p> : steps.map((step, stepIndex) => <StepCard key={`${step.round ?? stepIndex}-${stepIndex}`} step={step} index={stepIndex} unitByCode={unitByCode} traitByCode={traitByCode}/>)}</div>;
  if (isMeleePhase(phase)) {
    const finalStep = steps.at(-1);
    const summaryTraits = traits.length || !finalStep ? traits : traitLines(finalStep.traits ?? finalStep.traitSummary ?? finalStep.effects, traitByCode);
    return <article class="battle-sim-phase battle-sim-phase--melee">
      <PhaseHeading title={title} steps={steps.length}/>
      {finalStep && <PhaseSummary step={finalStep} traits={summaryTraits} unitByCode={unitByCode}/>}
      <details class="battle-sim-melee-details"><summary>展开近战回合</summary>{body}</details>
    </article>;
  }
  return <article class="battle-sim-phase"><PhaseHeading title={title} steps={steps.length}/>{body}</article>;
}

function PhaseHeading({ title, steps }: { title: string; steps: number }) {
  return <div class="battle-sim-phase-heading"><div><h3>{title}</h3><span>{steps > 1 ? `${steps} 个结算步骤` : steps === 1 ? '1 个结算步骤' : '未触发'}</span></div></div>;
}

function PhaseSummary({ step, traits, unitByCode }: { step: SimulationStep; traits: string[]; unitByCode: Map<string, CatalogUnit> }) {
  return <div class="battle-sim-phase-summary">
    <div class="battle-sim-metrics">
      <MetricPair label="总攻击" left={metric(step, 'attack', 'attacker')} right={metric(step, 'attack', 'defender')}/>
      <MetricPair label="总防御" left={metric(step, 'defense', 'attacker')} right={metric(step, 'defense', 'defender')}/>
      <MetricPair label="承受伤害" left={metric(step, 'damage', 'attacker')} right={metric(step, 'damage', 'defender')} digits={2}/>
      <MetricPair label="阵亡" left={metric(step, 'losses', 'attacker')} right={metric(step, 'losses', 'defender')}/>
    </div>
    {traits.length > 0 && <TraitList traits={traits}/>}
    <div class="battle-sim-survivors"><TroopList title="进攻方存活" troops={snapshot(step, 'after', 'attacker')} unitByCode={unitByCode}/><TroopList title="防守方存活" troops={snapshot(step, 'after', 'defender')} unitByCode={unitByCode}/></div>
  </div>;
}

function StepCard({ step, index, unitByCode, traitByCode }: { step: SimulationStep; index: number; unitByCode: Map<string, CatalogUnit>; traitByCode: Map<string, CatalogTrait> }) {
  const traits = traitLines(step.traits ?? step.traitSummary ?? step.effects, traitByCode);
  const title = step.label ?? step.name ?? (typeof step.step === 'string' ? step.step : step.round != null ? `第 ${step.round} 回合` : step.step != null ? `步骤 ${step.step}` : `步骤 ${index + 1}`);
  return <article class="battle-sim-step">
    <div class="battle-sim-step-title"><h4>{title}</h4>{traits.length > 0 && <span>{traits.length} 项特性生效</span>}</div>
    <div class="battle-sim-metrics">
      <MetricPair label="总攻击" left={metric(step, 'attack', 'attacker')} right={metric(step, 'attack', 'defender')}/>
      <MetricPair label="总防御" left={metric(step, 'defense', 'attacker')} right={metric(step, 'defense', 'defender')}/>
      <MetricPair label="承受伤害" left={metric(step, 'damage', 'attacker')} right={metric(step, 'damage', 'defender')} digits={2}/>
      <MetricPair label="阵亡" left={metric(step, 'losses', 'attacker')} right={metric(step, 'losses', 'defender')}/>
    </div>
    {traits.length > 0 && <TraitList traits={traits}/>}
    <div class="battle-sim-survivors">
      <TroopList title="进攻方存活" troops={snapshot(step, 'after', 'attacker')} unitByCode={unitByCode}/>
      <TroopList title="防守方存活" troops={snapshot(step, 'after', 'defender')} unitByCode={unitByCode}/>
    </div>
  </article>;
}

function MetricPair({ label, left, right, digits = 0 }: { label: string; left: number; right: number; digits?: number }) {
  return <div class="battle-sim-metric"><span>{label}</span><strong>{fmt(left, digits)}</strong><i>vs</i><strong>{fmt(right, digits)}</strong></div>;
}

function TraitList({ traits }: { traits: string[] }) {
  return <ul class="battle-sim-traits">{traits.map((trait, index) => <li key={`${trait}-${index}`}>{trait}</li>)}</ul>;
}

function TroopList({ title, troops, unitByCode }: { title: string; troops: Troops; unitByCode: Map<string, CatalogUnit> }) {
  const rows = Object.entries(troops).filter(([, count]) => numberOf(count) > 0);
  return <div class="battle-sim-survivor-side"><h5>{title}</h5>{rows.length ? <ul>{rows.map(([code, count]) => <li key={code}><span>{unitByCode.get(code)?.name ?? code}</span><strong>×{fmt(count)}</strong></li>)}</ul> : <p>全军阵亡</p>}</div>;
}
