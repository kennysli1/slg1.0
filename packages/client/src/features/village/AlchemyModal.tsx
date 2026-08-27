import { useState } from 'preact/hooks';
import { dataVersion, openModal, tick } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { buildingInfo, treasureRarityName } from '../../app/config.js';
import { Modal, IconPlate, Btn, Tag, Divider, TimerBar } from '../../ui/index.js';
import { BuildingManagement } from './BuildingManagement.js';

const KEY = 'alchemy';

export function openAlchemy(slotId: string): void {
  openModal((close) => <AlchemyModal slotId={slotId} onClose={close} />, KEY);
}

interface AvailableTreasure { code: string; location: 'town' | 'treasury' | 'reserve'; name: string; icon: string; rarity: string }

function AlchemyModal({ slotId, onClose }: { slotId: string; onClose: () => void }) {
  dataVersion.value;
  tick.value;
  const [selecting, setSelecting] = useState<number | null>(null);
  const data = getCache().alchemy as any;
  const info = buildingInfo('alchemy');
  if (!data) return <Modal title={info.name} sub="加载中…" onClose={onClose}>{null}</Modal>;

  const inputs = (data.inputs ?? []) as Array<any | null>;
  const firstRarity = inputs[0]?.rarity;
  const available = (data.available ?? []) as AvailableTreasure[];
  const optionsFor = (slot: number) => slot === 0 || !firstRarity
    ? available
    : available.filter((x) => x.rarity === firstRarity);
  const count = inputs.filter(Boolean).length;
  const refining = !!data.finishAt;

  async function choose(slot: number, item: AvailableTreasure) {
    const ok = await act(req('SelectAlchemyTreasure', { slot, code: item.code, location: item.location }), { okToast: `已放入「${item.name}」` });
    if (ok) setSelecting(null);
  }

  async function refine() {
    await act(req('StartAlchemy'), { okToast: '炼金炉已开始炼化' });
  }

  async function claim() {
    await act(req('ClaimAlchemy'), { okToast: '已收获炼化宝物' });
  }

  return (
    <Modal
      title={info.name}
      sub={data.built ? `Lv${data.level} · 三件同品质宝物炼化` : '尚未建成'}
      icon={<IconPlate icon={info.icon} label={info.name} size="md" plate="gold" />}
      onClose={onClose}
      wide
    >
      {!data.built ? <p>先建成炼金炉后才能使用。</p> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-3)' }}>
          {inputs.map((item, slot) => (
            <div key={slot} style={{ textAlign: 'center' }}>
              <div style={{ minHeight: '74px', display: 'grid', placeItems: 'center', border: '1px dashed var(--c-line)', borderRadius: 'var(--r-sm)' }}>
                {item ? <IconPlate icon={item.icon} label={item.name} size="md" plate="stone" /> : <span style={{ color: 'var(--c-ink-dim)' }}>空槽</span>}
              </div>
              <Btn size="sm" block disabled={refining || !!item || !!data.result} onClick={() => setSelecting(selecting === slot ? null : slot)}>放入</Btn>
              {item && <Tag kind="gold">{treasureRarityName(item.rarity)}</Tag>}
              {selecting === slot && !refining && !item && !data.result && (
                <div style={{ marginTop: 'var(--s-2)', maxHeight: '160px', overflowY: 'auto', textAlign: 'left', border: '1px solid var(--c-line)', borderRadius: 'var(--r-sm)', padding: 'var(--s-1)' }}>
                  {optionsFor(slot).length === 0 ? <span style={{ color: 'var(--c-ink-dim)' }}>没有可用的同品质宝物</span> : optionsFor(slot).map((x, i) => (
                    <button type="button" key={`${x.code}-${x.location}-${i}`} onClick={() => void choose(slot, x)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 'var(--s-1)', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer' }}>
                      {x.name} <small>({treasureRarityName(x.rarity)} · {x.location === 'reserve' ? '备用栏' : x.location === 'town' ? '城镇中心' : '宝库'})</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <Divider />
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
          <Btn variant="primary" disabled={refining || !!data.result || count !== 3} onClick={() => void refine()}>炼化</Btn>
          <Tag kind={count === 3 ? 'jade' : 'steel'}>{count}/3</Tag>
          {refining && data.finishAt && <span style={{ color: 'var(--c-ink-dim)' }}>炼化中</span>}
        </div>
        {refining && data.finishAt && <TimerBar startAt={data.finishAt - (data.refineSec * 1000)} finishAt={data.finishAt} label="炼化进度" kind="gold" />}

        <Divider />
        <div style={{ display: 'grid', placeItems: 'center', gap: 'var(--s-2)' }}>
          {data.result ? <>
            <IconPlate icon={data.result.icon} label={data.result.name} size="lg" plate="gold" />
            <Tag kind="gold">{treasureRarityName(data.result.rarity)}</Tag>
            <Btn variant="primary" onClick={() => void claim()}>收获</Btn>
          </> : <span style={{ color: 'var(--c-ink-dim)' }}>炼化结果槽</span>}
        </div>
        {data.result && <p style={{ color: 'var(--c-ink-dim)', fontSize: 'var(--f-xs)' }}>收获时按城镇中心→宝库主栏→备用栏存入；没有空位时提示宝库已满。</p>}
        <Divider />
        <BuildingManagement slotId={slotId} name="炼金炉" onClose={onClose} />
      </>}
    </Modal>
  );
}
