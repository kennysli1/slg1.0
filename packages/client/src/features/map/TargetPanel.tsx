/**
 * TargetPanel — 选中格子的动作面板。
 * 读 selected signal，根据 kind 显示：空地→拓荒、己方村→运输/切换/放弃、
 * 敌方村→进攻（含兵力与宝物选择）、PvE→掠夺（同上）。
 * 放弃村庄使用 Modal 二次确认，禁止 window.confirm。
 */
import { useState, useRef, useCallback } from 'preact/hooks';
import { getCache } from '../../app/state.js';
import { dataVersion, selected, openModal } from '../../app/store.js';
import { worldW, worldH, treasureInfo, treasureRarityName, treasureCarryCap, unitInfo, resourceKeys, resInfo } from '../../app/config.js';
import { act } from '../../app/refresh.js';
import { req, me, isOwnVillageId, selectVillage, abandonVillage } from '../../api.js';
import { fmt } from '../../shared/utils/format.js';
import { Icon, IconPlate, Btn, Tag, Panel, Modal } from '../../ui/index.js';

// ─── hex distance helper ──────────────────────────────────────────────────────
function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
function hexDistanceWrapped(a: { q: number; r: number }, b: { q: number; r: number }, W: number, H: number): number {
  let best = hexDistance(a, b);
  for (let dq = -W; dq <= W; dq += W) {
    for (let dr = -H; dr <= H; dr += H) {
      if (dq === 0 && dr === 0) continue;
      const d = hexDistance(a, { q: b.q + dq, r: b.r + dr });
      if (d < best) best = d;
    }
  }
  return best;
}

// ─── troop input row ─────────────────────────────────────────────────────────
function TroopInputRow({ unitKey, max, inputsRef }: {
  unitKey: string;
  max: number;
  inputsRef: { current: Map<string, HTMLInputElement> };
}) {
  const info = unitInfo(unitKey);
  return (
    <div class="troop-input">
      <Icon icon={info.icon} label={info.name} size="xs" />
      <span class="troop-name">{info.name}</span>
      <input
        type="number"
        min={0}
        max={max}
        defaultValue={max}
        ref={(el) => { if (el) inputsRef.current.set(unitKey, el); else inputsRef.current.delete(unitKey); }}
        onChange={() => {}}
      />
      <small>/{max}</small>
    </div>
  );
}

function TransportTroopRow({ unitKey, max, inputsRef }: {
  unitKey: string;
  max: number;
  inputsRef: { current: Map<string, HTMLInputElement> };
}) {
  const info = unitInfo(unitKey);
  return (
    <div class="troop-input">
      <Icon icon={info.icon} label={info.name} size="xs" />
      <span class="troop-name">{info.name}</span>
      <input
        type="number"
        min={0}
        max={max}
        defaultValue={0}
        ref={(el) => { if (el) inputsRef.current.set(unitKey, el); else inputsRef.current.delete(unitKey); }}
        onChange={() => {}}
      />
      <small>/{max}</small>
    </div>
  );
}

// ─── carry section ────────────────────────────────────────────────────────────
function CarrySection({ troopInputsRef }: {
  troopInputsRef: { current: Map<string, HTMLInputElement> };
}) {
  const _dv = dataVersion.value;
  const t = getCache().treasures;
  const codes: string[] = Array.from(new Set<string>((t?.codes as string[]) ?? []));
  const checkRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const [capLabel, setCapLabel] = useState('可携带 0 件');

  const recalc = useCallback(() => {
    let total = 0;
    for (const inp of troopInputsRef.current.values()) total += Math.max(0, Number(inp.value) || 0);
    const cap = treasureCarryCap(total);
    if (cap === 0) {
      setCapLabel('兵力不足，不可携带');
      for (const cb of checkRefs.current.values()) { cb.disabled = true; cb.checked = false; }
      return;
    }
    const checked = Array.from(checkRefs.current.values()).filter((cb) => cb.checked).length;
    const full = checked >= cap;
    setCapLabel(`兵力 ${total} · 可携带 ${cap} 件`);
    for (const cb of checkRefs.current.values()) {
      if (!cb.checked) cb.disabled = full;
    }
  }, [troopInputsRef]);

  if (!codes.length) {
    return (
      <div class="target-section">
        <div class="target-section-head">携带宝物</div>
        <span class="muted" style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>暂无可携带宝物</span>
      </div>
    );
  }

  return (
    <div class="target-section">
      <div class="carry-header">
        <span class="target-section-head">携带宝物</span>
        <span class="carry-cap">{capLabel}</span>
      </div>
      <div class="carry-chips">
        {codes.map((code) => {
          const info = treasureInfo(code);
          const name = info?.name ?? code;
          const rar = info?.rarity ?? '';
          return (
            <label key={code} class="carry-chip" title={name}>
              <input
                type="checkbox"
                value={code}
                ref={(el) => { if (el) { checkRefs.current.set(code, el); el.addEventListener('change', recalc); } else checkRefs.current.delete(code); }}
              />
              {info?.icon && <Icon icon={info.icon} label={name} size="xs" />}
              <span class="carry-name">{name.slice(0, 6)}</span>
              <span class={`carry-rar rar-${rar}`}>{treasureRarityName(rar)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function collectCheckedTreasures(cap: number): string[] {
  const checked = Array.from(document.querySelectorAll<HTMLInputElement>('.carry-chip input[type="checkbox"]:checked')).map((c) => c.value);
  if (!checked.length) return [];
  if (cap === 0) return [];
  return checked.slice(0, cap);
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function TargetPanel() {
  const _dv = dataVersion.value;
  const sel = selected.value;
  if (!sel || !me) return null;

  const W = worldW(), H = worldH();
  const dist = hexDistanceWrapped({ q: sel.q, r: sel.r }, { q: me.q, r: me.r }, W, H);

  function close() { selected.value = null; }

  // ── Dispatch helper ──────────────────────────────────────────────────────
  function collectTroops(ref: { current: Map<string, HTMLInputElement> }): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, inp] of ref.current) {
      const n = Math.max(0, Number(inp.value) || 0);
      if (n > 0) out[key] = n;
    }
    return out;
  }

  function totalTroops(ref: { current: Map<string, HTMLInputElement> }): number {
    let n = 0;
    for (const inp of ref.current.values()) n += Math.max(0, Number(inp.value) || 0);
    return n;
  }

  // ─── Empty tile ──────────────────────────────────────────────────────────
  if (sel.kind === 'empty') {
    return (
      <EmptyPanel
        q={sel.q} r={sel.r} dist={dist}
        onClose={close}
      />
    );
  }

  // ─── Own village ─────────────────────────────────────────────────────────
  const isOwn = sel.kind === 'own_village' || isOwnVillageId(sel.refId);
  if (isOwn) {
    const v = me.villages?.find((v) => v.id === sel.refId);
    const isCapital = !!v?.isCapital || sel.refId === me.capitalVillageId;
    return (
      <OwnVillagePanel
        refId={sel.refId}
        q={sel.q} r={sel.r}
        name={sel.name}
        dist={dist}
        isCapital={isCapital}
        onClose={close}
        collectTroops={collectTroops}
        totalTroops={totalTroops}
      />
    );
  }

  // ─── PvE / enemy village ─────────────────────────────────────────────────
  const isPve = sel.kind === 'pve';
  const icon = isPve ? (sel.icon ?? 'pve_bandits') : 'bld_main';

  return (
    <AttackPanel
      refId={sel.refId}
      q={sel.q} r={sel.r}
      name={sel.name}
      dist={dist}
      isPve={isPve}
      icon={icon}
      onClose={close}
      collectTroops={collectTroops}
      totalTroops={totalTroops}
    />
  );
}

// ─── Empty tile panel ────────────────────────────────────────────────────────
function EmptyPanel({ q, r, dist, onClose }: { q: number; r: number; dist: number; onClose: () => void }) {
  async function doFound() {
    await act(req('FoundVillage', { q, r }), { okToast: '拓荒令已发出' });
    selected.value = null;
  }
  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="bld_main" label="空地" size="sm" />
        <div>
          <div class="target-title">空地</div>
          <div class="target-coord">坐标 ({q},{r}) · 距离 {dist} 格</div>
        </div>
        <button class="target-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div class="target-body">
        <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-soft)' }}>
          需主基地与人口规模达标，并备齐 3 名拓荒者与开城资源。失败不退开城包。
        </p>
        <div class="target-foot" style={{ border: 'none', padding: 0 }}>
          <Btn variant="primary" block onClick={doFound}>🚩 拓荒建村</Btn>
        </div>
      </div>
    </Panel>
  );
}

// ─── Own village panel ───────────────────────────────────────────────────────
function OwnVillagePanel({
  refId, q, r, name, dist, isCapital, onClose, collectTroops, totalTroops,
}: {
  refId: string; q: number; r: number; name: string; dist: number; isCapital: boolean;
  onClose: () => void;
  collectTroops: (ref: { current: Map<string, HTMLInputElement> }) => Record<string, number>;
  totalTroops: (ref: { current: Map<string, HTMLInputElement> }) => number;
}) {
  const _dv = dataVersion.value;
  const army = getCache().army;
  const res = getCache().res?.resources ?? {};
  const myTroops = Object.entries(army?.troops ?? {}).filter(([, n]: any) => n > 0);
  const troopInputsRef = useRef<Map<string, HTMLInputElement>>(new Map());
  const cargoInputsRef = useRef<Map<string, HTMLInputElement>>(new Map());

  async function doSwitch() {
    const r = await selectVillage(refId);
    if (!r.ok) { return; }
    selected.value = null;
  }

  function doAbandon() {
    openModal((close) => (
      <Modal
        title="放弃村庄"
        sub={name}
        onClose={close}
        foot={
          <>
            <Btn onClick={close}>取消</Btn>
            <Btn variant="danger" onClick={async () => {
              close();
              const r = await abandonVillage(refId);
              if (r.ok) {
                selected.value = null;
              }
            }}>确认放弃</Btn>
          </>
        }
      >
        <p style={{ color: 'var(--c-ink-soft)', fontSize: 'var(--f-sm)', lineHeight: 1.6 }}>
          确认放弃「{name}」？<br />
          驻军将就地解散，资源清空，地块变回空地。<br />
          <strong style={{ color: 'var(--c-crimson-hi)' }}>此操作不可撤销。</strong>
        </p>
      </Modal>
    ), 'abandon-village');
  }

  async function doTransport() {
    const troops = collectTroops(troopInputsRef);
    if (!Object.keys(troops).length) return;
    const cargo: Record<string, number> = {};
    for (const [key, inp] of cargoInputsRef.current) {
      const n = Math.max(0, Number(inp.value) || 0);
      if (n > 0) cargo[key] = n;
    }
    if (!Object.keys(cargo).length) return;
    const cap = treasureCarryCap(totalTroops(troopInputsRef));
    const treasures = collectCheckedTreasures(cap);
    await act(req('SendTransport', { targetVillage: refId, troops, cargo, treasures }), { okToast: '运输部队出发' });
    selected.value = null;
  }

  return (
    <Panel variant="gold" corners class="map-target-panel">
      <div class="target-head">
        <IconPlate icon="bld_main" label={name} size="sm" plate="gold" />
        <div>
          <div class="target-title">{name}{isCapital ? '（主城）' : ''}</div>
          <div class="target-coord">己方村庄 · ({q},{r}) · 距离 {dist} 格</div>
        </div>
        <button class="target-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div class="target-body">
        {/* Switch + abandon */}
        <div class="target-actions">
          <Btn size="sm" onClick={doSwitch}>切换到此村</Btn>
          {!isCapital && (
            <Btn size="sm" variant="danger" onClick={doAbandon}>放弃此村</Btn>
          )}
        </div>

        {/* Transport troops */}
        {myTroops.length > 0 && (
          <>
            <div class="target-section">
              <div class="target-section-head">运输部队（运力=负重）</div>
              <div class="troop-inputs">
                {myTroops.map(([u, n]: [string, any]) => (
                  <TransportTroopRow key={u} unitKey={u} max={Number(n)} inputsRef={troopInputsRef} />
                ))}
              </div>
            </div>

            <div class="target-section">
              <div class="target-section-head">运输货物</div>
              <div class="cargo-inputs">
                {resourceKeys().filter((k) => k !== 'gold').map((k) => {
                  const have = Math.floor(res[k] ?? 0);
                  const info = resInfo(k);
                  return (
                    <div key={k} class="cargo-row">
                      <Icon icon={info.icon} label={info.name} size="xs" />
                      <span>{info.name}</span>
                      <input
                        type="number"
                        min={0}
                        max={have}
                        defaultValue={0}
                        ref={(el) => { if (el) cargoInputsRef.current.set(k, el); else cargoInputsRef.current.delete(k); }}
                        onChange={() => {}}
                      />
                      <span class="cargo-max">/{fmt(have)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <CarrySection troopInputsRef={troopInputsRef} />

            <div class="target-foot">
              <Btn variant="primary" block onClick={doTransport}>📦 运输</Btn>
            </div>
          </>
        )}
        {!myTroops.length && (
          <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)' }}>无可用兵力</p>
        )}
      </div>
    </Panel>
  );
}

// ─── Attack / Raid panel ─────────────────────────────────────────────────────
function AttackPanel({
  refId, q, r, name, dist, isPve, icon, onClose, collectTroops, totalTroops,
}: {
  refId: string; q: number; r: number; name: string; dist: number;
  isPve: boolean; icon: string;
  onClose: () => void;
  collectTroops: (ref: { current: Map<string, HTMLInputElement> }) => Record<string, number>;
  totalTroops: (ref: { current: Map<string, HTMLInputElement> }) => number;
}) {
  const _dv = dataVersion.value;
  const army = getCache().army;
  const myTroops = Object.entries(army?.troops ?? {}).filter(([, n]: any) => n > 0);
  const troopInputsRef = useRef<Map<string, HTMLInputElement>>(new Map());

  async function doDispatch() {
    const troops = collectTroops(troopInputsRef);
    if (!Object.keys(troops).length) return;
    const cap = treasureCarryCap(totalTroops(troopInputsRef));
    const treasures = collectCheckedTreasures(cap);
    if (isPve) {
      await act(req('SendRaid', { targetId: refId, troops, treasures }), { okToast: '掠夺部队出发' });
    } else {
      await act(req('SendAttack', { targetVillage: refId, troops, treasures }), { okToast: '攻击部队出发' });
    }
    selected.value = null;
  }

  return (
    <Panel variant={isPve ? 'default' : 'danger'} class="map-target-panel">
      <div class="target-head">
        <IconPlate icon={icon} label={name} size="sm" />
        <div>
          <div class="target-title">{name}</div>
          <div class="target-coord">
            ({q},{r}) · 距离 {dist} 格 ·{' '}
            <Tag kind={isPve ? 'crimson' : 'steel'}>
              {isPve ? '野怪据点' : '玩家村庄'}
            </Tag>
          </div>
        </div>
        <button class="target-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div class="target-body">
        {myTroops.length > 0 ? (
          <>
            <div class="target-section">
              <div class="target-section-head">出征兵力</div>
              <div class="troop-inputs">
                {myTroops.map(([u, n]: [string, any]) => (
                  <TroopInputRow key={u} unitKey={u} max={Number(n)} inputsRef={troopInputsRef} />
                ))}
              </div>
            </div>

            <CarrySection troopInputsRef={troopInputsRef} />

            <div class="target-foot">
              <Btn variant={isPve ? 'primary' : 'danger'} block onClick={doDispatch}>
                {isPve ? '⚡ 掠夺' : '⚔️ 进攻'}
              </Btn>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 'var(--f-xs)', color: 'var(--c-ink-dim)', padding: 'var(--s-3) var(--s-4)' }}>
            无可用兵力，先去军队页训练
          </p>
        )}
      </div>
    </Panel>
  );
}
