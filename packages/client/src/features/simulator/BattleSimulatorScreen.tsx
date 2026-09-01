import { useEffect, useMemo, useState } from 'preact/hooks';
import { req } from '../../api.js';

type SideName = 'attacker' | 'defender';
type Mode = 'ambush' | 'raid' | 'field' | 'siege';

interface CatalogUnit {
  code: string; name: string; tribe: string; form: 'melee' | 'ranged';
  meleeAtk: number; rangedAtk: number; meleeDef: number; rangedDef: number; hp: number;
  isCavalry: boolean; isScout: boolean; source: 'unit' | 'merc' | 'npc';
  traits: { code: string; name: string; effects: { effect: string; value: number }[] }[];
}
interface Catalog {
  units: CatalogUnit[];
  treasures: { code: string; name: string; effectType: string; effectValue: number }[];
  research: { code: string; name: string }[];
  modes: Mode[];
  constants: { wallBonusPerLevel: number; meleeRounds: number; cavalryVsCavalryCoeff: number; cavalryVsMeleeCoeff: number; cavalryVsRangedCoeff: number; rangedStrikeCoeff: number; meleeRoundCoeff: number };
}
interface Row { code: string; count: string }
interface SideForm { rows: Row[]; research: string[]; treasures: string[]; meleeAtkPct: string; rangedAtkPct: string; meleeDefPct: string; rangedDefPct: string; hpPct: string; wallLevel: string; wallBonusPct: string }

const modeLabels: Record<Mode, string> = { ambush: '伏击战', raid: '掠夺战', field: '野外遭遇战', siege: '攻城战' };

const emptySide = (first?: CatalogUnit): SideForm => ({
  rows: first ? [{ code: first.code, count: '10' }] : [], research: [], treasures: [],
  meleeAtkPct: '0', rangedAtkPct: '0', meleeDefPct: '0', rangedDefPct: '0', hpPct: '0', wallLevel: '0', wallBonusPct: '0',
});

function percent(value: string): number { const n = Number(value); return Number.isFinite(n) ? n / 100 : 0; }

export function BattleSimulatorScreen() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('field');
  const [seed, setSeed] = useState(String(Date.now() % 1_000_000));
  const [attacker, setAttacker] = useState<SideForm>(emptySide());
  const [defender, setDefender] = useState<SideForm>(emptySide());
  const [report, setReport] = useState<any>(null);
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

  function updateSide(side: SideName, patch: Partial<SideForm>) {
    const setter = side === 'attacker' ? setAttacker : setDefender;
    setter((previous) => ({ ...previous, ...patch }));
  }

  function addRow(side: SideName) {
    const value = side === 'attacker' ? attacker : defender;
    const setter = side === 'attacker' ? setAttacker : setDefender;
    const first = catalog?.units[0];
    if (!first) return;
    setter({ ...value, rows: [...value.rows, { code: first.code, count: '0' }] });
  }

  function updateRow(side: SideName, index: number, patch: Partial<Row>) {
    const value = side === 'attacker' ? attacker : defender;
    const setter = side === 'attacker' ? setAttacker : setDefender;
    setter({ ...value, rows: value.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) });
  }

  function removeRow(side: SideName, index: number) {
    const value = side === 'attacker' ? attacker : defender;
    const setter = side === 'attacker' ? setAttacker : setDefender;
    setter({ ...value, rows: value.rows.filter((_, rowIndex) => rowIndex !== index) });
  }

  async function simulate(event: Event) {
    event.preventDefault();
    if (!catalog) return;
    setBusy(true); setError('');
    const toSide = (side: SideForm) => ({
      troops: Object.fromEntries(side.rows.map((row) => [row.code, Math.max(0, Math.floor(Number(row.count) || 0))])),
      research: side.research,
      treasures: side.treasures,
      tech: {
        meleeAtkPct: percent(side.meleeAtkPct), rangedAtkPct: percent(side.rangedAtkPct),
        meleeDefPct: percent(side.meleeDefPct), rangedDefPct: percent(side.rangedDefPct), hpPct: percent(side.hpPct),
      },
      wallLevel: Math.max(0, Math.floor(Number(side.wallLevel) || 0)), wallBonusPct: percent(side.wallBonusPct),
    });
    try {
      const response = await req('Simulate', { scenario: { mode, seed: Number(seed) || 1, attacker: toSide(attacker), defender: toSide(defender) } });
      if (!response.ok) setError(response.error?.msg ?? response.error?.code ?? '模拟失败');
      else setReport(response.payload);
    } catch { setError('模拟请求失败，请稍后重试'); }
    finally { setBusy(false); }
  }

  if (!catalog) return <main class="battle-sim-page"><h1>阶段化战斗模拟器</h1><p>{error || '正在读取 CSV 兵种与特性配置…'}</p></main>;
  return (
    <main class="battle-sim-page">
      <header class="battle-sim-header"><div><h1>阶段化战斗模拟器</h1><p>独立服务器工具 · 只读取 CSV 配置，不读写主游戏状态</p></div><a href="/">返回主游戏</a></header>
      <form onSubmit={simulate}>
        <section class="battle-sim-toolbar">
          <label>战斗模式<select value={mode} onChange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as Mode)}>{catalog.modes.map((value) => <option value={value} key={value}>{modeLabels[value] ?? value}</option>)}</select></label>
          <label>随机种子<input type="number" value={seed} onInput={(event) => setSeed((event.currentTarget as HTMLInputElement).value)} /></label>
          <span class="battle-sim-rule">墙每级防御 +{(catalog.constants.wallBonusPerLevel * 100).toFixed(1)}% · 近战阶段 {catalog.constants.meleeRounds} 轮 · 伤害系数 冲锋 {catalog.constants.cavalryVsCavalryCoeff}/{catalog.constants.cavalryVsMeleeCoeff}/{catalog.constants.cavalryVsRangedCoeff} · 远程 {catalog.constants.rangedStrikeCoeff} · 近战 {catalog.constants.meleeRoundCoeff}</span>
          <button type="submit" disabled={busy}>{busy ? '计算中…' : '开始模拟'}</button>
        </section>
        <div class="battle-sim-sides">
          <SideEditor side="attacker" title="进攻方" value={attacker} catalog={catalog} unitByCode={unitByCode} onUpdate={updateSide} onAdd={addRow} onRowUpdate={updateRow} onRemove={removeRow} />
          <SideEditor side="defender" title="防守方" value={defender} catalog={catalog} unitByCode={unitByCode} onUpdate={updateSide} onAdd={addRow} onRowUpdate={updateRow} onRemove={removeRow} />
        </div>
      </form>
      {error && <p class="battle-sim-error">{error}</p>}
      {report && <ReportView report={report} unitByCode={unitByCode} />}
    </main>
  );
}

function SideEditor(props: { side: SideName; title: string; value: SideForm; catalog: Catalog; unitByCode: Map<string, CatalogUnit>; onUpdate: (side: SideName, patch: Partial<SideForm>) => void; onAdd: (side: SideName) => void; onRowUpdate: (side: SideName, index: number, patch: Partial<Row>) => void; onRemove: (side: SideName, index: number) => void }) {
  const { side, title, value, catalog, unitByCode, onUpdate, onAdd, onRowUpdate, onRemove } = props;
  const input = (field: keyof SideForm, label: string, suffix = '%') => <label>{label}<span class="battle-sim-input"><input type="number" step="any" value={String(value[field])} onInput={(event) => onUpdate(side, { [field]: (event.currentTarget as HTMLInputElement).value })} /><small>{suffix}</small></span></label>;
  return <section class="battle-sim-side"><h2>{title}</h2><h3>部队</h3>
    {value.rows.map((row, index) => { const unit = unitByCode.get(row.code); return <div class="battle-sim-row" key={`${index}-${row.code}`}><select value={row.code} onChange={(event) => onRowUpdate(side, index, { code: (event.currentTarget as HTMLSelectElement).value })}>{catalog.units.map((item) => <option value={item.code} key={item.code}>{item.name}（{item.code}）</option>)}</select><input aria-label={`${unit?.name ?? row.code}数量`} type="number" min="0" max="100000" value={row.count} onInput={(event) => onRowUpdate(side, index, { count: (event.currentTarget as HTMLInputElement).value })} /><span class="battle-sim-unit-hint">HP {unit?.hp ?? '-'} · {unit?.traits.map((trait) => trait.name).join('、') || '无特性'}</span><button type="button" onClick={() => onRemove(side, index)}>删除</button></div>; })}
    <button type="button" onClick={() => onAdd(side)}>＋添加兵种</button>
    <h3>科技（research.csv）</h3><select class="battle-sim-multi" multiple value={value.research as any} onChange={(event) => onUpdate(side, { research: Array.from((event.currentTarget as HTMLSelectElement).selectedOptions).map((option) => option.value) })}>{catalog.research.map((tech) => <option value={tech.code} key={tech.code}>{tech.name}（{tech.code}）</option>)}</select>
    <h3>宝物</h3><select class="battle-sim-multi" multiple value={value.treasures as any} onChange={(event) => onUpdate(side, { treasures: Array.from((event.currentTarget as HTMLSelectElement).selectedOptions).map((option) => option.value) })}>{catalog.treasures.map((treasure) => <option value={treasure.code} key={treasure.code}>{treasure.name}（{treasure.effectType} {treasure.effectValue}）</option>)}</select>
    <h3>手工加成</h3><div class="battle-sim-mods">{input('meleeAtkPct', '近战攻击')}{input('rangedAtkPct', '远程攻击')}{input('meleeDefPct', '近战防御')}{input('rangedDefPct', '远程防御')}{input('hpPct', '生命池')}</div>
    <h3>城墙</h3><div class="battle-sim-mods">{input('wallLevel', '城墙等级', '级')}{input('wallBonusPct', '额外防御')}</div>
  </section>;
}

function ReportView({ report, unitByCode }: { report: any; unitByCode: Map<string, CatalogUnit> }) {
  const label = (code: string) => unitByCode.get(code)?.name ?? code;
  return <section class="battle-sim-report"><div class="battle-sim-report-title"><h2>战斗报告</h2><strong>{report.winner === 'draw' ? '平局' : report.winner === 'attacker' ? '进攻方胜利' : '防守方胜利'}</strong><span>模式：{modeLabels[report.mode as Mode] ?? report.mode} · 种子：{report.seed}</span></div>
    <p>最终兵力：进攻方 {report.totals.attacker}，防守方 {report.totals.defender}</p>
    {(report.stages ?? []).map((stage: any) => <details open key={stage.name}><summary>{stage.name}</summary>{(stage.steps ?? []).map((step: any) => <article class="battle-sim-step" key={step.name}><h3>{step.name} · {step.description}</h3><div class="battle-sim-numbers"><span>进攻攻击 {Number(step.attackPower?.attacker ?? 0).toFixed(2)} · 防守攻击 {Number(step.attackPower?.defender ?? 0).toFixed(2)}</span><span>进攻防御 {Number(step.defensePower?.attacker ?? 0).toFixed(2)} · 防守防御 {Number(step.defensePower?.defender ?? 0).toFixed(2)}</span><span>生命池 {Number(step.healthPool?.attacker ?? 0).toFixed(2)} / {Number(step.healthPool?.defender ?? 0).toFixed(2)}</span><span>对进攻方伤害 {Number(step.damageToAttacker).toFixed(2)} / 损失 {step.lossesToAttacker}（{(Number(step.lossRatioToAttacker) * 100).toFixed(2)}%）</span><span>对防守方伤害 {Number(step.damageToDefender).toFixed(2)} / 损失 {step.lossesToDefender}（{(Number(step.lossRatioToDefender) * 100).toFixed(2)}%）</span></div><div class="battle-sim-json"><div><b>前后兵力</b><pre>{JSON.stringify({ before: step.before, after: step.after }, null, 2)}</pre></div><div><b>本步有效攻防/生命</b><pre>{JSON.stringify({ attacker: step.attackerStats, defender: step.defenderStats }, null, 2)}</pre></div></div><h4>特性目标选择与效果</h4>{step.traitAssignments?.length ? <table><thead><tr><th>来源</th><th>特性/效果</th><th>目标</th><th>命中人数</th><th>修正</th><th>浪费</th></tr></thead><tbody>{step.traitAssignments.map((assignment: any, index: number) => <tr key={`${assignment.sourceCode}-${assignment.effect}-${index}`}><td>{assignment.sourceSide === 'attacker' ? '进攻方' : '防守方'} · {label(assignment.sourceCode)}</td><td>{assignment.sourceTrait} · {assignment.effect}</td><td>{assignment.targetCode ? `${assignment.targetSide === 'attacker' ? '进攻方' : '防守方'} · ${label(assignment.targetCode)}` : '无符合目标'}</td><td>{assignment.assigned}</td><td>{assignment.value > 0 ? '+' : ''}{(assignment.value * 100).toFixed(1)}%</td><td>{assignment.wasted}</td></tr>)}</tbody></table> : <p>本步没有可触发的目标型特性。</p>}</article>)}</details>)}
  </section>;
}
