import { useEffect, useState } from 'preact/hooks';
import { me, req } from '../../api.js';
import { allianceTargetPicker, allianceWarTarget, dataVersion, sessionVersion, showToast, tab } from '../../app/store.js';
import { unitInfo } from '../../app/config.js';
import { Btn, Empty, Panel, SectionHead, Tag } from '../../ui/index.js';
import { errText } from '../../shared/ui/text.js';
import '../../styles/alliance.css';

type Pane = 'members' | 'buildings' | 'tech' | 'war' | 'control';
const ROLE_NAMES: Record<string, string> = { logistics: '后勤主管', war: '战争专家', tech: '首席科技官', ambassador: '形象大使', leader: '盟主' };
const ROLE_FALLBACK = [
  { code: 'logistics', name: '后勤主管', requiredAllianceLevel: 1, unlocked: true, effect: '所有村庄资源产量 +20%' },
  { code: 'war', name: '战争专家', requiredAllianceLevel: 3, unlocked: false, effect: '所有村庄军队移速 +15%，攻防 +10%' },
  { code: 'tech', name: '首席科技官', requiredAllianceLevel: 5, unlocked: false, effect: '所有村庄科技点获得概率 +10%' },
  { code: 'ambassador', name: '形象大使', requiredAllianceLevel: 7, unlocked: false, effect: '每次获得声望额外 +1' },
];

export function AllianceScreen() {
  sessionVersion.value; dataVersion.value;
  const [alliance, setAlliance] = useState<any>(null);
  const [alliances, setAlliances] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>('members');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [sourceVillageId, setSourceVillageId] = useState(me?.villageId ?? '');
  const villages = me?.villages ?? [];

  async function load() {
    const own = await req('GetAlliance');
    const a = own.ok ? (own.payload as any)?.alliance : null;
    setAlliance(a);
    if (!a) {
      const list = await req('ListAlliances', query ? { query } : {});
      if (list.ok) setAlliances((list.payload as any)?.alliances ?? []);
    }
  }
  useEffect(() => { void load(); }, [query, me?.id]);

  async function action(actionName: string, payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await req(actionName, payload);
      if (!result.ok) { const error = (result as any).error; showToast(error?.message ?? errText(error?.code ?? (result as any).reason), 'bad'); return; }
      showToast('操作成功', 'ok'); await load();
    } finally { setBusy(false); }
  }

  if (!alliance) return <NoAlliance alliances={alliances} query={query} setQuery={setQuery} busy={busy} name={name} setName={setName} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} villages={villages} onCreate={() => action('CreateAlliance', { name, sourceVillageId })} onApply={(id: string) => action('ApplyAlliance', { allianceId: id })} />;

  const isLeader = alliance.leaderId === me?.id;
  const roles: string[] = isLeader ? ['leader', ...(alliance.roles?.[me?.id ?? ''] ?? [])] : (alliance.roles?.[me?.id ?? ''] ?? []);
  return (
    <div class="alliance-page">
      <header class="alliance-header">
        <div><h1>{alliance.name}</h1><p>Lv.{alliance.level} · {alliance.members?.length ?? 0}/{alliance.memberCap} 名 · 盟主：{alliance.leaderName}</p></div>
        <div class="alliance-header-actions">
          {alliance.disconnected && <Tag kind="crimson">联盟失联 · 请盟主重建联盟大厅</Tag>}
          {!isLeader && <Btn variant="danger" size="sm" disabled={busy} onClick={() => { if (window.confirm('确定退出该联盟吗？')) void action('LeaveAlliance', {}); }}>退出联盟</Btn>}
        </div>
      </header>
      <nav class="alliance-tabs" aria-label="联盟板块">
        {([['members', '成员'], ['buildings', '联盟建筑'], ['tech', '联盟科技'], ['war', '联盟战事'], ...(isLeader ? [['control', '联盟控制']] : [])] as [Pane, string][]).map(([key, label]) => <button class={pane === key ? 'active' : ''} onClick={() => setPane(key)} type="button">{label}</button>)}
      </nav>
      {pane === 'members' && <MemberPane alliance={alliance} />}
      {pane === 'buildings' && <BuildingPane alliance={alliance} isLeader={isLeader} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'tech' && <TechPane alliance={alliance} isLeader={isLeader} roles={roles} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'war' && <WarPane alliance={alliance} isLeader={isLeader} roles={roles} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'control' && <ControlPane alliance={alliance} busy={busy} onAction={action} />}
    </div>
  );
}

function VillageSelect({ villages, value, onChange }: { villages: any[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>{villages.map((v) => <option value={v.id}>{v.name}</option>)}</select>;
}

function NoAlliance(props: any) {
  return <div class="alliance-page"><SectionHead>王国联盟</SectionHead><div class="alliance-create"><h2>建立联盟</h2><p>需要联盟大厅；创建时支付木材、泥土、铁矿、粮食各 300 与 600 金币。</p><input placeholder="联盟名称" value={props.name} onInput={(e) => props.setName((e.currentTarget as HTMLInputElement).value)} /><VillageSelect villages={props.villages} value={props.sourceVillageId} onChange={props.setSourceVillageId} /><Btn disabled={props.busy || !props.name.trim()} onClick={props.onCreate}>建立联盟</Btn></div><div class="alliance-list"><div class="alliance-search"><input placeholder="搜索联盟或盟主" value={props.query} onInput={(e) => props.setQuery((e.currentTarget as HTMLInputElement).value)} /></div>{props.alliances.length === 0 ? <Empty title="暂无联盟" /> : props.alliances.map((a: any) => <div class="alliance-row"><div><strong>{a.name}</strong><span>盟主 {a.leaderName}</span></div><span>{a.memberCount}/{a.memberCap}</span>{!a.full && <Btn onClick={() => props.onApply(a.id)}>申请加入</Btn>}</div>)}</div></div>;
}

function MemberPane({ alliance }: { alliance: any }) {
  const roleCatalog = alliance.roleCatalog?.length ? alliance.roleCatalog : ROLE_FALLBACK.map((r) => ({ ...r, unlocked: alliance.level >= r.requiredAllianceLevel }));
  const members = alliance.members ?? [];
  return <Panel><SectionHead>成员名单</SectionHead><div class="alliance-role-slots">{roleCatalog.map((role: any) => { const holders = members.filter((m: any) => (m.roles ?? []).includes(role.code)); return <div class={`alliance-role-slot${role.unlocked ? '' : ' locked'}`}><b>{role.name}</b><strong>{role.unlocked ? (holders.map((m: any) => m.name).join('、') || '暂无任职') : `${role.requiredAllianceLevel}级联盟解锁`}</strong><small>{role.effect}</small></div>; })}</div><div class="member-table"><div class="member-head"><span>成员</span><span>村庄/人口</span><span>声望</span><span>贡献</span><span>职位</span></div>{members.map((m: any) => <div class="member-row"><span><b>{m.name}</b><small>{m.id}</small></span><span>{m.villages} / {m.population}</span><span>{m.reputation}</span><span>资源 {Object.values(m.resourceContribution ?? {}).reduce((x: number, y: any) => x + Number(y || 0), 0)}<br />科技 {m.techContribution ?? 0}<br />军队人口 {m.militaryPopulation ?? 0}</span><span>{(m.roles ?? []).map((r: string) => ROLE_NAMES[r] ?? r).join('、') || '成员'}</span></div>)}</div></Panel>;
}

function BuildingPane({ alliance, isLeader, busy, onAction, villages, sourceVillageId, setSourceVillageId }: any) {
  const plan = alliance.researchingBuilding;
  const canPlan = isLeader || (alliance.roles?.[me?.id ?? ''] ?? []).includes('logistics');
  const pending = alliance.pendingResourceDeliveries ?? [];
  const inProgress = plan?.state === 'in_progress';
  return <Panel><SectionHead>联盟建筑</SectionHead><p>联盟仓库：木 {Math.floor(alliance.warehouse?.wood ?? 0)} · 泥 {Math.floor(alliance.warehouse?.clay ?? 0)} · 铁 {Math.floor(alliance.warehouse?.iron ?? 0)} · 粮 {Math.floor(alliance.warehouse?.crop ?? 0)}</p>{plan && <p class="alliance-notice">{inProgress ? `建造中：${plan.code} Lv.${plan.targetLevel}，预计 ${new Date(plan.completeAt).toLocaleTimeString()} 完成。` : `当前规划：${plan.code} Lv.${plan.targetLevel}（需要木${plan.required.wood} 泥${plan.required.clay} 铁${plan.required.iron} 粮${plan.required.crop}）。资源未满足前可随时更改规划；满足后自动开始建造。`} 来源村需要贸易中心和空闲贸易路线，资源将由商队运抵大厅后入库。</p>}{pending.length > 0 && <p class="alliance-notice">运输中：{pending.map((d: any) => `${Object.entries(d.amount ?? {}).map(([k, v]) => `${k}${v}`).join('、')}（预计 ${new Date(d.arriveAt).toLocaleTimeString()}）`).join('；')}</p>}<div class="alliance-catalog">{(alliance.buildingCatalog ?? []).map((b: any) => <div class="alliance-catalog-row"><span><b>{b.name}</b><small>{b.code} · {b.description}</small></span><span>Lv.{alliance.buildings?.[b.code] ?? 0}/{b.maxLevel}</span>{canPlan && <Btn size="sm" disabled={busy || inProgress} onClick={() => onAction('StartAllianceBuilding', { code: b.code })}>{plan && !inProgress ? (plan.code === b.code ? '保持规划' : '改为此项') : '规划'}</Btn>}</div>)}</div><div class="alliance-contribute"><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><input type="number" min="0" placeholder="木" id="alliance-wood" /><input type="number" min="0" placeholder="泥" id="alliance-clay" /><input type="number" min="0" placeholder="铁" id="alliance-iron" /><input type="number" min="0" placeholder="粮" id="alliance-crop" /><Btn disabled={busy || !plan || inProgress} onClick={() => onAction('DepositAllianceResources', { sourceVillageId, amount: { wood: Number((document.getElementById('alliance-wood') as HTMLInputElement)?.value), clay: Number((document.getElementById('alliance-clay') as HTMLInputElement)?.value), iron: Number((document.getElementById('alliance-iron') as HTMLInputElement)?.value), crop: Number((document.getElementById('alliance-crop') as HTMLInputElement)?.value) } })}>贡献资源</Btn></div></Panel>;
}

function TechPane({ alliance, isLeader, roles, busy, onAction, villages, sourceVillageId, setSourceVillageId }: any) {
  const canPlan = isLeader || roles.includes('tech');
  const plan = alliance.researchingTech;
  const inProgress = plan?.state === 'in_progress';
  return <Panel><SectionHead>联盟科技</SectionHead><p>联盟科技点：{alliance.techPointStock ?? 0}</p>{plan && <p class="alliance-notice">{inProgress ? `研发中：${plan.code} Lv.${plan.targetLevel}，预计 ${new Date(plan.completeAt).toLocaleTimeString()} 完成。` : `当前规划：${plan.code} Lv.${plan.targetLevel}（需要 ${plan.required} 点）。科技点未满足前可随时更改规划；满足后自动开始研发。`}</p>}<div class="alliance-catalog">{(alliance.techCatalog ?? []).map((t: any) => <div class="alliance-catalog-row"><span><b>{t.name}</b><small>{t.code} · {t.description}</small></span><span>Lv.{alliance.technologies?.[t.code] ?? 0}/{t.maxLevel}</span>{canPlan && <Btn size="sm" disabled={busy || inProgress} onClick={() => onAction('StartAllianceTech', { code: t.code })}>{plan && !inProgress ? (plan.code === t.code ? '保持规划' : '改为此项') : '规划'}</Btn>}</div>)}</div><div class="alliance-contribute"><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><input type="number" min="1" defaultValue="1" id="alliance-tech-amount" /><Btn disabled={busy || !plan || inProgress} onClick={() => onAction('ContributeAllianceTech', { sourceVillageId, amount: Number((document.getElementById('alliance-tech-amount') as HTMLInputElement)?.value) })}>贡献科技点</Btn></div></Panel>;
}

function WarPane({ alliance, isLeader, roles, busy, onAction, villages, sourceVillageId, setSourceVillageId }: any) {
  const canPlan = isLeader || roles.includes('war');
  const picked = allianceWarTarget.value;
  const [mode, setMode] = useState<'raid' | 'attack' | 'reinforce'>('raid');
  const [countdown, setCountdown] = useState('60');
  const [now, setNow] = useState(Date.now());
  const [troops, setTroops] = useState<Record<string, number>>({});
  const targetKind = picked?.kind === 'village' ? 'village' : 'pve';
  const targetId = picked?.refId ?? '';
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { setTroops({}); }, [sourceVillageId]);
  const available = (alliance.availableTroopsByVillage?.[sourceVillageId] ?? {}) as Record<string, number>;
  const catalog = (alliance.unitCatalog ?? []) as Array<{ code: string; name: string; form: string }>;
  const availableCodes = Object.keys(available).filter((code) => Number(available[code]) > 0).sort();
  const selectedTroops = Object.fromEntries(Object.entries(troops).filter(([, count]) => Number(count) > 0));
  const countdownSec = Number(countdown);
  const statusName: Record<string, string> = { open: '集结中', dispatched: '已全部派出', cancelled: '已取消' };
  const remainingSec = (plan: any) => Math.max(0, Math.ceil((Number(plan.deadlineAt) - now) / 1000));
  const recallablePlan = (plan: any) => plan.status === 'dispatched' && Number.isFinite(Number(plan.allDispatchedAt)) && now - Number(plan.allDispatchedAt) < 90_000;
  return <Panel><SectionHead>联盟战事</SectionHead>{canPlan && <div class="war-plan-form"><select value={mode} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as any)}><option value="raid">掠夺</option><option value="attack">攻城</option><option value="reinforce">增援</option></select><Btn variant="ghost" onClick={() => { allianceTargetPicker.value = true; tab.value = 'map'; }}>从地图选择目标</Btn><span class="war-target-picked">{picked ? `${picked.name} (${picked.q},${picked.r})` : '尚未选择目标'}</span><label>倒计时 <input type="number" min="10" max="604800" step="1" value={countdown} onInput={(e) => setCountdown((e.currentTarget as HTMLInputElement).value)} /> 秒</label><Btn disabled={busy || !picked || !Number.isInteger(countdownSec) || countdownSec < 10 || (mode === 'reinforce' && targetKind !== 'village')} onClick={() => onAction('CreateAllianceWarPlan', { mode, targetKind, targetId: targetKind === 'pve' ? targetId : undefined, targetVillage: targetKind === 'village' ? targetId : undefined, q: picked?.q ?? 0, r: picked?.r ?? 0, countdownSec })}>创建目标</Btn></div>}<div class="war-plan-list">{(alliance.warPlans ?? []).map((p: any) => { const remain = remainingSec(p); return <div class="war-plan"><b>{p.mode === 'raid' ? '掠夺' : p.mode === 'attack' ? '攻城' : '增援'} · {p.targetId ?? p.targetVillage}</b><span>{statusName[p.status] ?? p.status} · 倒计时剩余 {remain} 秒 · {Object.keys(p.participants ?? {}).length} 人参加</span><div class="war-plan-actions">{canPlan && p.status === 'open' && remain > 0 && <Btn variant="danger" size="sm" disabled={busy} onClick={() => onAction('CancelAllianceWarPlan', { planId: p.id })}>取消行动</Btn>}{canPlan && recallablePlan(p) && <Btn variant="danger" size="sm" disabled={busy} onClick={() => onAction('RecallAllianceWarPlan', { planId: p.id })}>全员撤回（{Math.max(0, 90 - Math.floor((now - Number(p.allDispatchedAt)) / 1000))}秒）</Btn>}</div>{p.status === 'open' && remain > 0 && <><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><div class="war-troop-picker">{availableCodes.length ? availableCodes.map((code) => { const max = Number(available[code]) || 0; const info = catalog.find((item) => item.code === code); return <label class="war-troop-row"><span>{info?.name ?? unitInfo(code).name} <small>可用 {max}</small></span><input type="number" min="0" max={max} value={troops[code] ?? 0} onInput={(e) => { const value = Math.max(0, Math.min(max, Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0))); setTroops((prev) => ({ ...prev, [code]: value })); }} /></label>; }) : <small>该村暂无可派出的驻军</small>}</div><Btn disabled={busy || !Object.keys(selectedTroops).length} onClick={() => onAction('JoinAllianceWarPlan', { planId: p.id, sourceVillageId, troops: selectedTroops })}>加入行动</Btn></>}</div>; })}</div></Panel>;
}

function ControlPane({ alliance, busy, onAction }: any) { const [role, setRole] = useState('logistics'); return <Panel><SectionHead>联盟控制</SectionHead><div class="request-list">{Object.keys(alliance.joinRequests ?? {}).map((id: string) => <div><span>{id}</span><Btn disabled={busy} onClick={() => onAction('ReviewAllianceRequest', { applicantId: id, approve: true })}>批准</Btn><Btn disabled={busy} onClick={() => onAction('ReviewAllianceRequest', { applicantId: id, approve: false })}>拒绝</Btn></div>)}</div><div class="role-list">{(alliance.members ?? []).map((m: any) => <div><span>{m.name}{m.id === alliance.leaderId ? '（盟主）' : ''}</span><select value={role} onChange={(e) => setRole((e.currentTarget as HTMLSelectElement).value)}><option value="logistics">后勤主管</option><option value="war">战争专家</option><option value="tech">首席科技官</option><option value="ambassador">形象大使</option></select><Btn disabled={busy} onClick={() => onAction('SetAllianceRole', { targetPlayerId: m.id, role })}>任命</Btn><Btn disabled={busy} onClick={() => onAction('SetAllianceRole', { targetPlayerId: m.id, role: '' })}>罢免全部职位</Btn>{m.id !== alliance.leaderId && <Btn variant="danger" disabled={busy} onClick={() => onAction('RemoveAllianceMember', { targetPlayerId: m.id })}>移除</Btn>}</div>)}</div></Panel>; }
