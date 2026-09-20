import { useState } from 'preact/hooks';
import type { IncomingWarning } from '@slg/shared';
import { dataVersion, tick, openModal, showToast } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { unitInfo, treasureCarryCap, treasureInfo } from '../../app/config.js';
import { act, switchVillage } from '../../app/refresh.js';
import { req, me } from '../../api.js';
import { Btn, Modal, Panel } from '../../ui/index.js';
import { fmt } from '../utils/format.js';

const SCOUT_CODES = new Set(['equlegati', 'pathfinder', 'teuscout', 'adventurer']);

function etaText(arriveAt: number): string {
  const seconds = Math.max(0, Math.ceil((arriveAt - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}时${minutes}分${rest}秒` : minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function IncomingScoutModal({ warning, close }: { warning: IncomingWarning; close: () => void }) {
  const available = Object.entries(getCache().army?.availableTroops ?? getCache().army?.troops ?? {})
    .filter(([code, count]) => SCOUT_CODES.has(code) && Number(count) > 0)
    .map(([code, count]) => ({ code, max: Math.max(0, Math.floor(Number(count))) }));
  const [troops, setTroops] = useState<Record<string, number>>({});
  const [treasures, setTreasures] = useState<string[]>([]);
  const total = Object.values(troops).reduce((sum, count) => sum + Math.max(0, count), 0);
  const cap = treasureCarryCap(total);
  const treasureCodes = Array.from(new Set<string>((getCache().treasures?.codes as string[]) ?? []));

  function setCount(code: string, raw: number, max: number) {
    const count = Math.max(0, Math.min(max, Math.floor(Number(raw) || 0)));
    setTroops({ ...troops, [code]: count });
  }

  function toggleTreasure(code: string, checked: boolean) {
    if (checked && treasures.length < cap) setTreasures([...treasures, code]);
    if (!checked) setTreasures(treasures.filter((item) => item !== code));
  }

  async function dispatch() {
    const selected = Object.fromEntries(Object.entries(troops).filter(([, count]) => count > 0));
    if (!Object.keys(selected).length) return;
    const ok = await act(req('SendIncomingScout', {
      movementId: warning.id,
      troops: selected,
      treasures: treasures.slice(0, cap),
    }), { okToast: '侦察兵已沿来袭路径出发' });
    if (ok) close();
  }

  return (
    <Modal
      title="侦察来袭部队"
      sub={`沿 ${warning.fromVillageName} 的来袭路径相会；侦察战不会中断敌军行军。`}
      onClose={close}
      foot={<><Btn onClick={close}>取消</Btn><Btn variant="primary" disabled={total <= 0} onClick={() => void dispatch()}>派出侦察兵/冒险者</Btn></>}
    >
      {available.length === 0 ? <p class="incoming-empty">当前村庄没有可用侦察兵或冒险者。</p> : (
        <div class="incoming-scout-units">
          {available.map(({ code, max }) => (
            <label key={code} class="incoming-scout-unit">
              <span>{unitInfo(code).name}</span>
              <input
                type="number" min={0} max={max} value={troops[code] ?? 0}
                onInput={(event) => setCount(code, Number((event.currentTarget as HTMLInputElement).value), max)}
              />
              <small>/{fmt(max)}</small>
              <Btn size="sm" variant="ghost" onClick={() => setCount(code, max, max)}>MAX</Btn>
            </label>
          ))}
          <Btn size="sm" onClick={() => setTroops(Object.fromEntries(available.map(({ code, max }) => [code, max])))}>全部 MAX</Btn>
        </div>
      )}
      {treasureCodes.length > 0 && (
        <section class="incoming-treasures">
          <div>随队宝物 <small>{cap > 0 ? `${treasures.length}/${cap}` : '兵力不足，无法携带'}</small></div>
          <div class="incoming-treasure-list">
            {treasureCodes.map((code) => {
              const checked = treasures.includes(code);
              return (
                <label key={code}>
                  <input
                    type="checkbox" checked={checked}
                    disabled={!checked && treasures.length >= cap}
                    onChange={(event) => toggleTreasure(code, (event.currentTarget as HTMLInputElement).checked)}
                  />
                  {treasureInfo(code)?.name ?? code}
                </label>
              );
            })}
          </div>
        </section>
      )}
      <p class="incoming-rule-note">有侦察兵存活即可获得兵力情报；本方侦察兵零损失且至少一名存活，视为完胜并额外识别敌军携带的宝物。</p>
    </Modal>
  );
}

export function IncomingWarnings() {
  dataVersion.value;
  tick.value;
  const warnings: IncomingWarning[] = getCache().playerMoves?.incomingWarnings
    ?? getCache().moves?.incomingWarnings
    ?? [];
  if (!warnings.length) return null;

  async function scout(warning: IncomingWarning) {
    if (warning.targetVillage !== me?.villageId) {
      const switched = await switchVillage(warning.targetVillage);
      if (!switched.ok) {
        showToast('无法切换到受袭村庄', 'bad');
        return;
      }
    }
    openModal(
      (close) => <IncomingScoutModal warning={warning} close={close} />,
      `incoming-scout-${warning.id}`,
    );
  }

  return (
    <Panel variant="flat" class="incoming-warnings">
      <div class="incoming-warnings-head">⚠ 来袭预警 ({warnings.length})</div>
      {warnings.map((warning) => {
        const intelligence = warning.intelligence;
        const troopText = intelligence
          ? Object.entries(intelligence.troops).map(([code, count]) => `${unitInfo(code).name} ${fmt(count)}`).join('、') || '无存活兵力'
          : '兵种与规模未知';
        const treasureText = intelligence?.treasures
          ? intelligence.treasures.length > 0
            ? intelligence.treasures.map((code) => treasureInfo(code)?.name ?? code).join('、')
            : '未携带宝物'
          : null;
        return (
          <article key={warning.id} class="incoming-warning-card">
            <div class="incoming-warning-top">
              <strong>{(warning as any).caravanRaid ? '商队遭到劫掠' : warning.battleType === 'siege' ? '攻城来袭' : '掠夺来袭'}</strong>
              <span>{etaText(warning.arriveAt)}</span>
            </div>
            <div>出发村庄：{warning.fromVillageName} ({warning.from.q},{warning.from.r})</div>
            <div>目标村庄：{warning.targetVillageName} ({warning.to.q},{warning.to.r})</div>
            <div class="incoming-warning-route" title="来袭军完整行军路径">
              路径：{warning.path.map((point) => `(${point.q},${point.r})`).join(' → ')}
            </div>
            <div class={intelligence ? 'incoming-intel incoming-intel--known' : 'incoming-intel'}>{intelligence ? '最近侦察兵力' : '兵力'}：{troopText}</div>
            {treasureText && <div class="incoming-intel incoming-intel--known">宝物：{treasureText}</div>}
            {(warning as any).caravanRaid ? <div class="incoming-rule-note">该预警针对你的商队，商队战斗将在相遇时结算。</div> : (
              <Btn size="sm" variant="primary" onClick={() => void scout(warning)}>
                {warning.targetVillage === me?.villageId ? '侦察来袭部队' : '切换到受袭村庄并侦察'}
              </Btn>
            )}
          </article>
        );
      })}
    </Panel>
  );
}
