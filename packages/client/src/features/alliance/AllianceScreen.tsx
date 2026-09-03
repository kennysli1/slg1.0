import { useEffect, useRef, useState } from 'preact/hooks';
import { me, req } from '../../api.js';
import { allianceTargetPicker, allianceWarFocus, allianceWarTarget, dataVersion, sessionVersion, showToast, tab } from '../../app/store.js';
import { treasureCarryCap, treasureInfo, treasureRarityName, unitInfo } from '../../app/config.js';
import { Btn, Empty, Panel, SectionHead, Tag } from '../../ui/index.js';
import { errText } from '../../shared/ui/text.js';
import '../../styles/alliance.css';

type Pane = 'members' | 'buildings' | 'tech' | 'war' | 'services' | 'directory' | 'control';
const ROLE_NAMES: Record<string, string> = { logistics: '后勤主管', war: '战争专家', tech: '首席科技官', ambassador: '形象大使', leader: '盟主' };
const ROLE_FALLBACK = [
  { code: 'logistics', name: '后勤主管', requiredAllianceLevel: 1, unlocked: true, effect: '所有村庄资源产量 +20%' },
  { code: 'war', name: '战争专家', requiredAllianceLevel: 2, unlocked: false, effect: '所有村庄军队移速 +15%，攻防 +10%' },
  { code: 'tech', name: '首席科技官', requiredAllianceLevel: 3, unlocked: false, effect: '所有村庄科技点获得概率 +10%' },
  { code: 'ambassador', name: '形象大使', requiredAllianceLevel: 4, unlocked: false, effect: '每次获得声望额外 +1' },
];

function formatWarDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}时 ${m}分 ${s}秒`;
}

export function AllianceScreen() {
  sessionVersion.value; dataVersion.value;
  const [alliance, setAlliance] = useState<any>(null);
  const [alliances, setAlliances] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>(() => allianceWarFocus.value ? 'war' : 'members');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [sourceVillageId, setSourceVillageId] = useState(me?.villageId ?? '');
  const villages = me?.villages ?? [];

  async function load() {
    const own = await req('GetAlliance');
    const a = own.ok ? (own.payload as any)?.alliance : null;
    setAlliance(a);
    const list = await req('ListAlliances', query ? { query } : {});
    if (list.ok) setAlliances((list.payload as any)?.alliances ?? []);
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

  // 大厅失联时联盟关系和申请记录仍保留，但联盟建筑/科技/战事面板暂不
  // 可操作；成员只能查看公开目录，申请按钮也不会误显示为可用。
  if (alliance.disconnected) {
    return <DisconnectedAlliance alliance={alliance} alliances={alliances} query={query} setQuery={setQuery} busy={busy} onLeave={() => action('LeaveAlliance', {})} />;
  }

  const isLeader = alliance.leaderId === me?.id;
  const roles: string[] = isLeader ? ['leader', ...(alliance.roles?.[me?.id ?? ''] ?? [])] : (alliance.roles?.[me?.id ?? ''] ?? []);
  return (
    <div class="alliance-page">
      <header class="alliance-header">
        <div><h1>{alliance.name}</h1><p>Lv.{alliance.level} · 联盟声望 {alliance.allianceReputation ?? 0} · {alliance.members?.length ?? 0}/{alliance.memberCap} 名 · 盟主：{alliance.leaderName}</p></div>
        <div class="alliance-header-actions">
          {alliance.disconnected && <Tag kind="crimson">联盟失联 · 请盟主重建联盟大厅</Tag>}
          {!isLeader && <Btn variant="danger" size="sm" disabled={busy} onClick={() => { if (window.confirm('确定退出该联盟吗？')) void action('LeaveAlliance', {}); }}>退出联盟</Btn>}
        </div>
      </header>
      <nav class="alliance-tabs" aria-label="联盟板块">
        {([['members', '成员'], ['buildings', '联盟建筑'], ['tech', '联盟科技'], ['war', '联盟战事'], ['services', '王国服务'], ['directory', '所有联盟'], ...(isLeader ? [['control', '联盟控制']] : [])] as [Pane, string][]).map(([key, label]) => <button class={pane === key ? 'active' : ''} onClick={() => { allianceWarFocus.value = false; setPane(key); }} type="button">{label}</button>)}
      </nav>
      {pane === 'members' && <MemberPane alliance={alliance} />}
      {pane === 'buildings' && <BuildingPane alliance={alliance} isLeader={isLeader} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'tech' && <TechPane alliance={alliance} isLeader={isLeader} roles={roles} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'war' && <WarPane alliance={alliance} isLeader={isLeader} roles={roles} busy={busy} onAction={action} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} />}
      {pane === 'services' && <ServicePane alliance={alliance} isAmbassador={(alliance.roles?.[me?.id ?? ''] ?? []).includes('ambassador')} busy={busy} onAction={action} />}
      {pane === 'directory' && <AllianceDirectory alliances={alliances} query={query} setQuery={setQuery} canApply={false} onApply={(id: string) => action('ApplyAlliance', { allianceId: id })} />}
      {pane === 'control' && <ControlPane alliance={alliance} busy={busy} onAction={action} />}
    </div>
  );
}

function VillageSelect({ villages, value, onChange }: { villages: any[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>{villages.map((v) => <option value={v.id}>{v.name}</option>)}</select>;
}

function NoAlliance(props: any) {
  return <div class="alliance-page"><SectionHead>王国联盟</SectionHead><div class="alliance-create"><h2>建立联盟</h2><p>需要联盟大厅；创建时支付木材、泥土、铁矿、粮食各 300 与 600 金币。</p><input placeholder="联盟名称" value={props.name} onInput={(e) => props.setName((e.currentTarget as HTMLInputElement).value)} /><VillageSelect villages={props.villages} value={props.sourceVillageId} onChange={props.setSourceVillageId} /><Btn disabled={props.busy || !props.name.trim()} onClick={props.onCreate}>建立联盟</Btn></div><AllianceDirectory alliances={props.alliances} query={props.query} setQuery={props.setQuery} canApply onApply={props.onApply} /></div>;
}

function DisconnectedAlliance({ alliance, alliances, query, setQuery, busy, onLeave }: { alliance: any; alliances: any[]; query: string; setQuery: (value: string) => void; busy: boolean; onLeave: () => void }) {
  const isLeader = alliance.leaderId === me?.id;
  return <div class="alliance-page"><SectionHead>联盟失联</SectionHead><div class="alliance-header"><div><h1>{alliance.name}</h1><p>联盟大厅当前失联 · 盟主：{alliance.leaderName}</p></div>{!isLeader && <Btn variant="danger" size="sm" disabled={busy} onClick={() => { if (window.confirm('确定退出该失联联盟吗？')) onLeave(); }}>退出联盟</Btn>}</div><p class="alliance-notice">联盟关系和已有申请会保留，待盟主恢复大厅后再统一处理。恢复前不能操作建筑、科技或联盟战事。</p><AllianceDirectory alliances={alliances} query={query} setQuery={setQuery} canApply={false} onApply={() => { /* 已加入联盟的玩家不能申请其它联盟。 */ }} /></div>;
}

function AllianceDirectory({ alliances, query, setQuery, onApply, canApply = false }: { alliances: any[]; query: string; setQuery: (value: string) => void; onApply: (id: string) => void; canApply?: boolean }) {
  return <Panel><SectionHead>所有联盟</SectionHead><div class="alliance-search"><input placeholder="搜索联盟或盟主" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} /></div>{alliances.length === 0 ? <Empty title="暂无联盟" /> : <div class="alliance-list"><div class="alliance-directory-head"><span>联盟</span><span>盟主</span><span>等级</span><span>声望</span><span>成员</span><span></span></div>{alliances.map((a: any) => <div class="alliance-row alliance-directory-row" key={a.id}><strong>{a.name}</strong><span>{a.leaderName}</span><span>Lv.{a.level}</span><span>{a.reputation ?? 0}</span><span>{a.memberCount}/{a.memberCap}</span>{canApply && !a.full ? <Btn size="sm" onClick={() => onApply(a.id)}>申请加入</Btn> : <span class="alliance-muted">{a.full ? '已满' : '已加入联盟'}</span>}</div>)}</div>}</Panel>;
}

function ServicePane({ alliance, isAmbassador, busy, onAction }: any) {
  const services = alliance.allianceServices ?? [];
  return <Panel><SectionHead>王国服务</SectionHead><p class="alliance-notice">联盟声望：{alliance.allianceReputation ?? 0} · 当前加成倍率：{Number(alliance.allianceModifierMultiplier ?? 1).toFixed(2)}x</p>{!isAmbassador && <p class="alliance-muted">只有已任命的形象大使可以消耗声望购买服务，盟主不会自动获得权限。</p>}<div class="alliance-catalog">{services.map((service: any) => <div class="alliance-service-row" key={service.code}><span><b>{service.name}</b><small>{service.desc}</small></span><span>{service.category === 'supplies' ? `资源 木${service.resources?.wood ?? 0} 泥${service.resources?.clay ?? 0} 铁${service.resources?.iron ?? 0} 粮${service.resources?.crop ?? 0}` : `${service.unitCode} ×${service.unitCount}（临时增援）`}</span><span>消耗声望 {service.reputationCost}</span><Btn size="sm" disabled={!isAmbassador || busy || Number(alliance.allianceReputation ?? 0) < service.reputationCost || alliance.disconnected} onClick={() => onAction('BuyAllianceService', { serviceCode: service.code })}>购买</Btn></div>)}</div>{(alliance.serviceOrders ?? []).length > 0 && <><h3>服务订单</h3><div class="alliance-service-orders">{(alliance.serviceOrders ?? []).slice().reverse().map((order: any) => <div key={order.id}>{order.serviceName} · {order.status === 'pending' ? '运输/派遣中' : order.status === 'completed' ? '已完成' : `失败（${order.failureReason ?? '大厅失联'}）`}</div>)}</div></>}</Panel>;
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
  return <Panel><SectionHead>联盟建筑</SectionHead><p>联盟仓库：木 {Math.floor(alliance.warehouse?.wood ?? 0)} · 泥 {Math.floor(alliance.warehouse?.clay ?? 0)} · 铁 {Math.floor(alliance.warehouse?.iron ?? 0)} · 粮 {Math.floor(alliance.warehouse?.crop ?? 0)}</p>{plan && <p class="alliance-notice">{inProgress ? `建造中：${plan.code} Lv.${plan.targetLevel}，预计 ${new Date(plan.completeAt).toLocaleTimeString()} 完成。` : `当前规划：${plan.code} Lv.${plan.targetLevel}（需要木${plan.required.wood} 泥${plan.required.clay} 铁${plan.required.iron} 粮${plan.required.crop}）。资源未满足前可随时更改规划；满足后自动开始建造。`} 来源村需要贸易中心和空闲贸易路线，资源将由商队运抵大厅后入库。</p>}{pending.length > 0 && <p class="alliance-notice">运输中：{pending.map((d: any) => `${Object.entries(d.amount ?? {}).map(([k, v]) => `${k}${v}`).join('、')}（预计 ${new Date(d.arriveAt).toLocaleTimeString()}）`).join('；')}</p>}<div class="alliance-catalog">{(alliance.buildingCatalog ?? []).map((b: any) => { const unlocked = alliance.level >= Number(b.requiredAllianceLevel ?? 1); return <div class={`alliance-catalog-row${unlocked ? '' : ' locked'}`}><span><b>{b.name}</b><small>{b.code} · {b.description}</small></span><span>Lv.{alliance.buildings?.[b.code] ?? 0}/{b.maxLevel}</span>{canPlan && <Btn size="sm" disabled={busy || inProgress || !unlocked} onClick={() => onAction('StartAllianceBuilding', { code: b.code })}>{!unlocked ? `${b.requiredAllianceLevel}级解锁` : plan && !inProgress ? (plan.code === b.code ? '保持规划' : '改为此项') : '规划'}</Btn>}</div>; })}</div><div class="alliance-contribute"><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><input type="number" min="0" placeholder="木" id="alliance-wood" /><input type="number" min="0" placeholder="泥" id="alliance-clay" /><input type="number" min="0" placeholder="铁" id="alliance-iron" /><input type="number" min="0" placeholder="粮" id="alliance-crop" /><Btn disabled={busy || !plan || inProgress} onClick={() => onAction('DepositAllianceResources', { sourceVillageId, amount: { wood: Number((document.getElementById('alliance-wood') as HTMLInputElement)?.value), clay: Number((document.getElementById('alliance-clay') as HTMLInputElement)?.value), iron: Number((document.getElementById('alliance-iron') as HTMLInputElement)?.value), crop: Number((document.getElementById('alliance-crop') as HTMLInputElement)?.value) } })}>贡献资源</Btn></div></Panel>;
}

function TechPane({ alliance, isLeader, roles, busy, onAction, villages, sourceVillageId, setSourceVillageId }: any) {
  const canPlan = isLeader || roles.includes('tech');
  const plan = alliance.researchingTech;
  const inProgress = plan?.state === 'in_progress';
  return <Panel><SectionHead>联盟科技</SectionHead><p>联盟科技点：{alliance.techPointStock ?? 0}</p>{plan && <p class="alliance-notice">{inProgress ? `研发中：${plan.code} Lv.${plan.targetLevel}，预计 ${new Date(plan.completeAt).toLocaleTimeString()} 完成。` : `当前规划：${plan.code} Lv.${plan.targetLevel}（需要 ${plan.required} 点）。科技点未满足前可随时更改规划；满足后自动开始研发。`}</p>}<div class="alliance-catalog">{(alliance.techCatalog ?? []).map((t: any) => { const unlocked = alliance.level >= Number(t.requiredAllianceLevel ?? 1); return <div class={`alliance-catalog-row${unlocked ? '' : ' locked'}`}><span><b>{t.name}</b><small>{t.code} · {t.description}</small></span><span>Lv.{alliance.technologies?.[t.code] ?? 0}/{t.maxLevel}</span>{canPlan && <Btn size="sm" disabled={busy || inProgress || !unlocked} onClick={() => onAction('StartAllianceTech', { code: t.code })}>{!unlocked ? `${t.requiredAllianceLevel}级解锁` : plan && !inProgress ? (plan.code === t.code ? '保持规划' : '改为此项') : '规划'}</Btn>}</div>; })}</div><div class="alliance-contribute"><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><input type="number" min="1" defaultValue="1" id="alliance-tech-amount" /><Btn disabled={busy || !plan || inProgress} onClick={() => onAction('ContributeAllianceTech', { sourceVillageId, amount: Number((document.getElementById('alliance-tech-amount') as HTMLInputElement)?.value) })}>贡献科技点</Btn></div></Panel>;
}

function WarPane({ alliance, isLeader, roles, busy, onAction, villages, sourceVillageId, setSourceVillageId }: any) {
  const canPlan = isLeader || roles.includes('war');
  const picked = allianceWarTarget.value;
  const [mode, setMode] = useState<'raid' | 'attack' | 'reinforce'>('raid');
  const [totalParts, setTotalParts] = useState({ h: '0', m: '1', s: '0' });
  const [joinParts, setJoinParts] = useState({ h: '0', m: '0', s: '30' });
  const [now, setNow] = useState(Date.now());
  const [troops, setTroops] = useState<Record<string, number>>({});
  const targetKind = picked?.kind === 'village' ? 'village' : 'pve';
  const targetId = picked?.refId ?? '';
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { setTroops({}); }, [sourceVillageId]);
  const toSeconds = (parts: { h: string; m: string; s: string }) => Math.max(0, Number(parts.h) * 3600 + Number(parts.m) * 60 + Number(parts.s));
  const countdownSec = toSeconds(totalParts);
  const participationCountdownSec = toSeconds(joinParts);
  const available = (alliance.availableTroopsByVillage?.[sourceVillageId] ?? {}) as Record<string, number>;
  const availableTreasures = (alliance.availableTreasuresByVillage ?? {}) as Record<string, string[]>;
  const catalog = (alliance.unitCatalog ?? []) as Array<{ code: string; name: string; form: string }>;
  const modeOptions: Array<'raid' | 'attack' | 'reinforce'> = targetKind === 'village'
    ? (picked?.relation === 'allied' ? ['reinforce'] : ['raid', 'attack', 'reinforce'])
    : (picked?.cityState === true ? ['raid', 'attack'] : ['raid']);
  const targetModeAllowed = !!picked && modeOptions.includes(mode);
  useEffect(() => {
    if (!modeOptions.includes(mode)) setMode(modeOptions[0] ?? 'raid');
  }, [picked?.refId, picked?.relation, picked?.cityState, targetKind]);
  const participantStatus: Record<string, string> = { joined: '等待派出（已预定）', dispatched: '已派出', recalled: '已撤回', failed: '派出失败' };
  const memberNames = Object.fromEntries((alliance.members ?? []).map((member: any) => [member.id, member.name]));
  const remainingSec = (plan: any) => Math.max(0, Math.ceil((Number(plan.deadlineAt) - now) / 1000));
  const joinRemainingSec = (plan: any) => Math.max(0, Math.ceil((Number(plan.joinDeadlineAt ?? (plan.createdAt + Number(plan.participationCountdownSec ?? 0) * 1000)) - now) / 1000));
  const legacyPlan = (plan: any) => Number(plan.participationCountdownSec ?? 0) >= Number(plan.countdownSec ?? 0);
  const recallablePlan = (plan: any) => {
    if (plan.status !== 'dispatched' || !Number.isFinite(Number(plan.allDispatchedAt))) return false;
    const anchor = Number(plan.joinDeadlineAt ?? plan.deadlineAt ?? plan.allDispatchedAt);
    return Number.isFinite(anchor) && now >= anchor && now - anchor < 90_000;
  };
  const setPart = (setter: any, key: 'h' | 'm' | 's', value: string) => setter((prev: any) => ({ ...prev, [key]: key === 'h' ? value.replace(/\D/g, '').slice(0, 6) || '0' : String(Math.min(59, Math.max(0, Number(value.replace(/\D/g, '')) || 0))) }));
  const timeFields = (label: string, parts: any, setter: any) => <label class="war-countdown-group"><span>{label}</span><span><input type="number" min="0" value={parts.h} onInput={(e) => setPart(setter, 'h', (e.currentTarget as HTMLInputElement).value)} />时</span><span><input type="number" min="0" max="59" value={parts.m} onInput={(e) => setPart(setter, 'm', (e.currentTarget as HTMLInputElement).value)} />分</span><span><input type="number" min="0" max="59" value={parts.s} onInput={(e) => setPart(setter, 's', (e.currentTarget as HTMLInputElement).value)} />秒</span></label>;
  const isActive = (plan: any) => {
    if (plan.status !== 'open' && plan.status !== 'dispatched') return false;
    const deadline = Number(plan.deadlineAt);
    // dispatched 计划在服务端会保留为历史记录；倒计时结束后不能再当作活跃战事展开。
    return Number.isFinite(deadline) ? deadline > now : plan.status === 'open';
  };
  const sortedPlans = [...(alliance.warPlans ?? [])].sort((a: any, b: any) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
    const created = Number(b.createdAt ?? b.deadlineAt ?? 0) - Number(a.createdAt ?? a.deadlineAt ?? 0);
    return created || String(b.id).localeCompare(String(a.id));
  });
  return <Panel><SectionHead>联盟战事</SectionHead>{canPlan && <div class="war-plan-form"><select value={mode} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as any)}>{modeOptions.map((option) => <option value={option}>{option === 'raid' ? '掠夺' : option === 'attack' ? '攻城' : '增援'}</option>)}</select><Btn variant="ghost" onClick={() => { allianceTargetPicker.value = true; tab.value = 'map'; }}>从地图选择目标</Btn><span class="war-target-picked">{picked ? `${picked.name} (${picked.q},${picked.r})` : '尚未选择目标'}</span>{timeFields('战争倒计时', totalParts, setTotalParts)}{timeFields('参军倒计时', joinParts, setJoinParts)}<span class="war-travel-limit">允许最大行军时间：{formatWarDuration(Math.max(0, countdownSec - participationCountdownSec))}</span><Btn disabled={busy || !targetModeAllowed || countdownSec < 10 || participationCountdownSec <= 0 || participationCountdownSec >= countdownSec} onClick={() => onAction('CreateAllianceWarPlan', { mode, targetKind, targetId: targetKind === 'pve' ? targetId : undefined, targetVillage: targetKind === 'village' ? targetId : undefined, q: picked?.q ?? 0, r: picked?.r ?? 0, countdownSec, participationCountdownSec })}>创建目标</Btn></div>}<div class="war-plan-list">{sortedPlans.map((p: any) => <WarPlanCard key={p.id} p={p} now={now} canPlan={canPlan} busy={busy} onAction={onAction} villages={villages} sourceVillageId={sourceVillageId} setSourceVillageId={setSourceVillageId} available={available} availableTreasures={availableTreasures} catalog={catalog} troops={troops} setTroops={setTroops} memberNames={memberNames} participantStatus={participantStatus} remainingSec={remainingSec} joinRemainingSec={joinRemainingSec} legacyPlan={legacyPlan} recallablePlan={recallablePlan} />)}</div></Panel>;
}

function WarPlanCard({ p, now, canPlan, busy, onAction, villages, sourceVillageId, setSourceVillageId, available, availableTreasures, catalog, troops, setTroops, memberNames, participantStatus, remainingSec, joinRemainingSec, legacyPlan, recallablePlan }: any) {
  const active = (p.status === 'open' || p.status === 'dispatched')
    && (Number.isFinite(Number(p.deadlineAt)) ? Number(p.deadlineAt) > now : p.status === 'open');
  const [expanded, setExpanded] = useState(active);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // 活跃战事始终展开；战事结束后自动收起，避免历史记录占满页面。
  // 收起后仍允许玩家点击 summary 手动查看详情。
  useEffect(() => { setExpanded(active); }, [active]);
  // Preact 对原生 details 的 open 布尔属性不会在所有浏览器事件顺序下可靠同步，
  // 这里再同步一次 DOM property，确保倒计时结束时历史记录确实收起。
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = active || expanded;
  }, [active, expanded]);
  const remain = remainingSec(p);
  const joinRemain = joinRemainingSec(p);
  const participants = Object.values(p.participants ?? {}) as any[];
  const mine = p.participants?.[me?.id ?? ''];
  const cancelAnchor = Number(p.joinDeadlineAt ?? p.deadlineAt);
  const cancelWindow = canPlan
    && (p.status === 'open' || p.status === 'dispatched')
    && Number.isFinite(cancelAnchor)
    && now >= cancelAnchor
    && now - cancelAnchor < 90_000;
  const cancelRemain = Number.isFinite(cancelAnchor)
    ? Math.max(0, Math.ceil((cancelAnchor + 90_000 - now) / 1000))
    : 0;
  const availableCodes = Object.keys(available).filter((code) => Number(available[code]) > 0).sort();
  const selectedTroops = Object.fromEntries(Object.entries(troops).filter(([, count]) => Number(count) > 0));
  const troopCount = (Object.values(selectedTroops) as unknown[]).reduce<number>((sum, count) => sum + Number(count), 0);
  const treasureCodes = Array.from(new Set<string>((availableTreasures?.[sourceVillageId] ?? []).filter((code: unknown): code is string => typeof code === 'string' && code.length > 0)));
  const treasureCap = treasureCarryCap(troopCount);
  const [treasures, setTreasures] = useState<string[]>([]);
  const selectedTreasures = treasures.filter((code) => treasureCodes.includes(code)).slice(0, treasureCap);
  useEffect(() => { setTreasures([]); }, [p.id, sourceVillageId]);
  useEffect(() => { if (treasures.length > treasureCap) setTreasures((prev) => prev.slice(0, treasureCap)); }, [treasureCap]);
  const selectedTreasureKey = JSON.stringify(selectedTreasures);
  const selectedTroopKey = JSON.stringify(selectedTroops);
  const [travelPreview, setTravelPreview] = useState<any>(null);
  const [travelPreviewBusy, setTravelPreviewBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (p.status !== 'open' || joinRemain <= 0 || mine || !sourceVillageId || !Object.keys(selectedTroops).length) {
      setTravelPreview(null);
      setTravelPreviewBusy(false);
      return () => { live = false; };
    }
    setTravelPreview(null);
    setTravelPreviewBusy(true);
    const timer = window.setTimeout(() => {
      void req('PreviewAllianceWarParticipation', { planId: p.id, sourceVillageId, troops: selectedTroops, treasures: selectedTreasures })
        .then((result) => {
          if (!live) return;
          if (result.ok) setTravelPreview(result.payload);
          else setTravelPreview({ error: (result as any).error?.msg ?? (result as any).reason ?? '无法计算行军时间' });
        })
        .catch(() => { if (live) setTravelPreview({ error: '行军时间计算失败，请重试' }); })
        .finally(() => { if (live) setTravelPreviewBusy(false); });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [p.id, p.status, sourceVillageId, selectedTroopKey, selectedTreasureKey]);
  const troopSummary = (troopMap: Record<string, number>) => {
    const entries = Object.entries(troopMap ?? {}).filter(([, count]) => Number(count) > 0);
    const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
    const text = entries.map(([code, count]) => `${catalog.find((item: any) => item.code === code)?.name ?? unitInfo(code).name} ×${count}`).join('、');
    return { text: text || '未派出兵力', total };
  };
  const selectedCount = Object.keys(selectedTroops).length;
  const canSubmit = selectedCount > 0 && !travelPreviewBusy && travelPreview?.withinLimit === true;
  return <details ref={detailsRef} class={`war-plan${active ? ' war-plan--active' : ' war-plan--history'}`} open={active || expanded} onToggle={(event) => { if (!active) setExpanded((event.currentTarget as HTMLDetailsElement).open); }}><summary><b>{p.mode === 'raid' ? '掠夺' : p.mode === 'attack' ? '攻城' : '增援'} · {p.targetId ?? p.targetVillage}</b><span>{p.status === 'open' ? '集结中' : p.status === 'dispatched' ? '已全部派出' : p.status === 'cancelled' ? '已取消' : p.status} · 目标剩余 {remain} 秒 · {p.status === 'open' ? `报名剩余 ${joinRemain} 秒 · ` : ''}{participants.length} 人参加</span></summary><div class="war-plan-body"><div class="war-participants"><strong>参战成员与派兵</strong>{participants.length ? participants.map((participant: any) => { const summary = troopSummary(participant.troops); const carried = (participant.treasures ?? []).map((code: string) => treasureInfo(code)?.name ?? code); return <div class="war-participant-row" key={`${p.id}-${participant.playerId}`}><span><b>{memberNames[participant.playerId] ?? participant.playerId}</b><small>{participant.sourceVillageId} · {participantStatus[participant.status] ?? participant.status}</small></span><span>{summary.text}（共 {summary.total} 名）{carried.length > 0 && <small> · 宝物：{carried.join('、')}</small>}</span></div>; }) : <small>暂无成员参加</small>}</div><div class="war-plan-actions">{mine?.status === 'joined' && <Btn variant="danger" size="sm" disabled={busy} onClick={() => onAction('CancelAllianceWarParticipation', { planId: p.id })}>取消参加</Btn>}{cancelWindow && <Btn variant="danger" size="sm" disabled={busy} onClick={() => onAction('CancelAllianceWarPlan', { planId: p.id })}>取消行动并撤回（{cancelRemain}秒）</Btn>}{canPlan && recallablePlan(p) && <Btn variant="danger" size="sm" disabled={busy} onClick={() => onAction('RecallAllianceWarPlan', { planId: p.id })}>全员撤回（{Math.max(0, 90 - Math.floor((now - Number(legacyPlan(p) ? p.allDispatchedAt : p.joinDeadlineAt)) / 1000))}秒）</Btn>}</div>{p.status === 'open' && joinRemain > 0 && !mine && <><div class="war-travel-limit">本次行动允许的最大行军时间：{formatWarDuration(Math.max(0, Number(p.countdownSec ?? 0) - Number(p.participationCountdownSec ?? 0)))}</div><VillageSelect villages={villages} value={sourceVillageId} onChange={setSourceVillageId} /><div class="war-troop-picker">{availableCodes.length ? availableCodes.map((code) => { const max = Number(available[code]) || 0; const info = catalog.find((item: any) => item.code === code); return <label class="war-troop-row" key={code}><span>{info?.name ?? unitInfo(code).name} <small>可用 {max}</small></span><input type="number" min="0" max={max} value={troops[code] ?? 0} onInput={(e) => { const value = Math.max(0, Math.min(max, Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0))); setTroops((prev: any) => ({ ...prev, [code]: value })); }} /></label>; }) : <small>该村暂无可派出的驻军</small>}</div><div class="war-treasure-picker"><div class="war-treasure-header"><strong>随队宝物</strong><span>{treasureCap > 0 ? `${selectedTreasures.length}/${treasureCap} 件` : '兵力不足，无法携带'}</span></div>{treasureCodes.length ? treasureCodes.map((code) => { const info = treasureInfo(code); const checked = selectedTreasures.includes(code); const disabled = !checked && (treasureCap <= 0 || selectedTreasures.length >= treasureCap); return <label class="war-treasure-row" key={code}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => { const checkedNow = (e.currentTarget as HTMLInputElement).checked; setTreasures((prev) => checkedNow ? (prev.includes(code) || prev.length >= treasureCap ? prev : [...prev, code]) : prev.filter((item) => item !== code)); }} /><span>{info?.name ?? code}<small>{info ? `${treasureRarityName(info.rarity)} · ${info.effectType} ${info.effectValue}` : code}</small></span></label>; }) : <small>该村没有可携带的宝物</small>}</div>{selectedCount > 0 && <div class={`war-travel-preview${travelPreview?.withinLimit === false ? ' war-travel-preview--bad' : travelPreview?.withinLimit === true ? ' war-travel-preview--ok' : ''}`}>{travelPreviewBusy ? '正在计算当前兵力的行军时间…' : travelPreview?.error ? travelPreview.error : travelPreview ? <><span>当前兵力预计行军：{formatWarDuration(travelPreview.travelSec)}</span><span>规定最长行军：{formatWarDuration(travelPreview.maxTravelSec)} · {travelPreview.withinLimit ? '在规定时间内' : '超出规定时间，不能加入行动'}</span></> : '等待计算行军时间…'}</div>}<Btn disabled={busy || !canSubmit} onClick={() => onAction('JoinAllianceWarPlan', { planId: p.id, sourceVillageId, troops: selectedTroops, treasures: selectedTreasures })}>加入行动</Btn></>}{p.status === 'open' && joinRemain <= 0 && <small class="alliance-muted">报名已截止，等待已报名部队出发</small>}</div></details>;
}

function ControlPane({ alliance, busy, onAction }: any) { const [role, setRole] = useState('logistics'); return <Panel><SectionHead>联盟控制</SectionHead><div class="request-list">{Object.keys(alliance.joinRequests ?? {}).map((id: string) => <div><span>{id}</span><Btn disabled={busy} onClick={() => onAction('ReviewAllianceRequest', { applicantId: id, approve: true })}>批准</Btn><Btn disabled={busy} onClick={() => onAction('ReviewAllianceRequest', { applicantId: id, approve: false })}>拒绝</Btn></div>)}</div><div class="role-list">{(alliance.members ?? []).map((m: any) => <div><span>{m.name}{m.id === alliance.leaderId ? '（盟主）' : ''}</span><select value={role} onChange={(e) => setRole((e.currentTarget as HTMLSelectElement).value)}><option value="logistics">后勤主管</option><option value="war">战争专家</option><option value="tech">首席科技官</option><option value="ambassador">形象大使</option></select><Btn disabled={busy} onClick={() => onAction('SetAllianceRole', { targetPlayerId: m.id, role })}>任命</Btn><Btn disabled={busy} onClick={() => onAction('SetAllianceRole', { targetPlayerId: m.id, role: '' })}>罢免全部职位</Btn>{m.id !== alliance.leaderId && <Btn variant="danger" disabled={busy} onClick={() => onAction('RemoveAllianceMember', { targetPlayerId: m.id })}>移除</Btn>}</div>)}</div></Panel>; }
