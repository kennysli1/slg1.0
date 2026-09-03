import { useEffect, useMemo, useState } from 'preact/hooks';
import { req } from '../../api.js';

interface CatalogUnit { code: string; name: string; tribe: string; attack: number; defense: number; hp: number; traits: { name: string; description: string }[]; }
interface Catalog { units: CatalogUnit[]; constants: { damageFormula: string; traits: string[] }; }
interface Row { code: string; count: string }
interface SideForm { rows: Row[]; attackPct: string; defensePct: string; hpPct: string; }

export function toggleMultiSelection(selected: string[], code: string, checked: boolean): string[] {
  return checked ? (selected.includes(code) ? selected : [...selected, code]) : selected.filter((item) => item !== code);
}

const emptySide = (first?: CatalogUnit): SideForm => ({ rows: first ? [{ code: first.code, count: '100' }] : [], attackPct: '0', defensePct: '0', hpPct: '0' });
const percent = (value: string): number => { const n = Number(value); return Number.isFinite(n) ? n / 100 : 0; };

export function BattleSimulatorScreen() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attacker, setAttacker] = useState<SideForm>(emptySide());
  const [defender, setDefender] = useState<SideForm>(emptySide());
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void req('GetCatalog').then((response) => {
    if (!response.ok) { setError(response.error?.msg ?? '无法读取模拟器配置'); return; }
    const next = response.payload as unknown as Catalog; setCatalog(next); setAttacker(emptySide(next.units[0])); setDefender(emptySide(next.units[0]));
  }).catch(() => setError('连接服务器失败，请刷新页面重试')); }, []);
  const unitByCode = useMemo(() => new Map((catalog?.units ?? []).map((unit) => [unit.code, unit])), [catalog]);
  const toSide = (side: SideForm) => ({ troops: Object.fromEntries(side.rows.map((row) => [row.code, Math.max(0, Math.floor(Number(row.count) || 0))])), tech: { attackPct: percent(side.attackPct), defensePct: percent(side.defensePct), hpPct: percent(side.hpPct) } });
  async function simulate(event: Event) { event.preventDefault(); setBusy(true); setError(''); try { const response = await req('Simulate', { scenario: { attacker: toSide(attacker), defender: toSide(defender) } }); if (!response.ok) setError(response.error?.msg ?? '模拟失败'); else setReport(response.payload); } catch { setError('模拟请求失败'); } finally { setBusy(false); } }
  if (!catalog) return <main class="battle-sim-page"><h1>战斗模拟器</h1><p>{error || '正在读取兵种配置…'}</p></main>;
  return <main class="battle-sim-page"><header class="battle-sim-header"><div><h1>战斗模拟器</h1><p>与线上结算共用同一公式：伤害 = 总攻击² /（总攻击 + 敌方总防御）。</p></div><a href="/">返回主游戏</a></header>
    <form onSubmit={simulate}><section class="battle-sim-toolbar"><span class="battle-sim-rule">双方同时结算；伤害按兵种人数比例分摊，按各自生命累计阵亡。{catalog.constants.traits.join('；')}</span><button type="submit" disabled={busy}>{busy ? '计算中…' : '开始模拟'}</button></section><div class="battle-sim-sides"><SideEditor title="进攻方" value={attacker} setValue={setAttacker} catalog={catalog} unitByCode={unitByCode}/><SideEditor title="防守方" value={defender} setValue={setDefender} catalog={catalog} unitByCode={unitByCode}/></div></form>
    {error && <p class="battle-sim-error">{error}</p>}{report && <ReportView report={report}/>}</main>;
}

function SideEditor({ title, value, setValue, catalog, unitByCode }: { title: string; value: SideForm; setValue: (next: SideForm) => void; catalog: Catalog; unitByCode: Map<string, CatalogUnit> }) {
  const row = (index: number, patch: Partial<Row>) => setValue({ ...value, rows: value.rows.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const input = (field: 'attackPct' | 'defensePct' | 'hpPct', label: string) => <label>{label}<span class="battle-sim-input"><input type="number" step="any" value={value[field]} onInput={(event) => setValue({ ...value, [field]: (event.currentTarget as HTMLInputElement).value })}/><small>%</small></span></label>;
  return <section class="battle-sim-side"><h2>{title}</h2><h3>部队</h3>{value.rows.map((item, index) => { const unit = unitByCode.get(item.code); return <div class="battle-sim-row" key={`${index}-${item.code}`}><select value={item.code} onChange={(event) => row(index, { code: (event.currentTarget as HTMLSelectElement).value })}>{catalog.units.map((entry) => <option key={entry.code} value={entry.code}>{entry.name}（攻 {entry.attack} / 防 {entry.defense} / 生 {entry.hp}）</option>)}</select><input type="number" min="0" value={item.count} onInput={(event) => row(index, { count: (event.currentTarget as HTMLInputElement).value })}/><span class="battle-sim-unit-hint">{unit?.traits.map((trait) => trait.name).join('、') || '无种族特性'}</span><button type="button" onClick={() => setValue({ ...value, rows: value.rows.filter((_, i) => i !== index) })}>删除</button></div>; })}<button type="button" onClick={() => setValue({ ...value, rows: [...value.rows, { code: catalog.units[0]?.code ?? '', count: '0' }] })}>＋添加兵种</button><h3>手工修正</h3><div class="battle-sim-mods">{input('attackPct', '攻击')}{input('defensePct', '防御')}{input('hpPct', '生命')}</div></section>;
}

function ReportView({ report }: { report: any }) {
  return <section class="battle-sim-report"><div class="battle-sim-report-title"><h2>战斗报告</h2><strong>{report.winner === 'draw' ? '无法继续结算' : report.winner === 'attacker' ? '进攻方胜利' : '防守方胜利'}</strong></div><p>最终兵力：进攻方 {report.totals.attacker}，防守方 {report.totals.defender}</p><p>{report.rules.damageFormula}；{report.rules.distribution}</p>{(report.stages ?? []).map((stage: any) => <details open key={stage.name}><summary>{stage.name}</summary>{stage.steps.map((step: any) => <article class="battle-sim-step" key={step.round}><h3>第 {step.round} 回合</h3><div class="battle-sim-numbers"><span>进攻攻击 {step.attackPower.attacker.toFixed(2)} · 防守攻击 {step.attackPower.defender.toFixed(2)}</span><span>进攻防御 {step.defensePower.attacker.toFixed(2)} · 防守防御 {step.defensePower.defender.toFixed(2)}</span><span>对进攻方伤害 {step.damageToAttacker.toFixed(2)} / 阵亡 {step.lossesToAttacker}</span><span>对防守方伤害 {step.damageToDefender.toFixed(2)} / 阵亡 {step.lossesToDefender}</span></div><pre>{JSON.stringify({ before: step.before, after: step.after }, null, 2)}</pre></article>)}</details>)}</section>;
}
