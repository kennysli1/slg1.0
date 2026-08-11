/**
 * "What can I build here?" picker modal.
 * Fetches GetBuildOptions for the given zone, lists buildable options with
 * art, description, production rate, CostRow, and a locked/unlocked state.
 * Build action → req('Build', { zone, kind }) via act().
 */
import { useState, useEffect } from 'preact/hooks';
import { openModal } from '../../app/store.js';
import { req } from '../../api.js';
import { act } from '../../app/refresh.js';
import { buildingInfo } from '../../app/config.js';
import {
  Modal, IconPlate, Btn, Tag, CostRow, canAfford, Empty,
} from '../../ui/index.js';

interface BuildOption {
  kind: string;
  name: string;
  icon: string;
  cost: Record<string, number> | null;
  timeSec: number | null;
  producing?: { ratePerHour: number } | null;
  unlocked: boolean;
  lockReason?: string | null;
}

interface BuildModalContentProps {
  zone: 'inner' | 'outer';
  freeSlots: number;
  close: () => void;
}

function BuildModalContent({ zone, freeSlots, close }: BuildModalContentProps) {
  const [options, setOptions] = useState<BuildOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await req('GetBuildOptions', { zone });
      if (!alive) return;
      if (!res.ok) {
        setError(res.error?.code ?? '请求失败');
      } else {
        const p = res.payload as { options?: BuildOption[]; freeSlots?: number };
        setOptions(p.options ?? []);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [zone]);

  const zoneLabel = zone === 'outer' ? '城外 · 生产量产' : '城内 · 民生研发';

  return (
    <Modal
      title={`可建建筑 · ${zoneLabel}`}
      sub={`空槽 ${freeSlots}`}
      onClose={close}
    >
      {loading && (
        <p style={{ color: 'var(--c-ink-dim)', fontSize: 'var(--f-sm)' }}>加载中…</p>
      )}
      {error && (
        <p style={{ color: 'var(--c-crimson-hi)', fontSize: 'var(--f-sm)' }}>加载失败：{error}</p>
      )}
      {!loading && !error && options !== null && (
        options.length === 0 ? (
          <Empty icon="🏗️" title="暂无可建建筑">
            该区已无可建建筑（或已全部建造）
          </Empty>
        ) : (
          <div class="build-options">
            {options.map((o) => {
              const info = buildingInfo(o.kind);
              const affordable = canAfford(o.cost);

              return (
                <div key={o.kind} class={`build-opt${o.unlocked ? '' : ' locked'}`}>
                  <IconPlate icon={o.icon ?? info.icon} label={o.name} size="md" plate="stone" />
                  <div class="build-opt-body">
                    <div class="build-opt-name">{o.name}</div>
                    {info.desc && (
                      <div class="build-opt-desc">{info.desc}</div>
                    )}
                    {o.producing && (
                      <div class="build-opt-prod">+{o.producing.ratePerHour}/h</div>
                    )}
                    <div class="build-opt-foot">
                      <CostRow cost={o.cost} timeSec={o.timeSec} />
                      {!o.unlocked ? (
                        <Tag kind="steel">{o.lockReason ?? '未解锁'}</Tag>
                      ) : (
                        <Btn
                          variant={affordable ? 'primary' : 'default'}
                          size="sm"
                          disabled={!affordable}
                          title={!affordable ? '资源不足' : `建造 ${o.name}`}
                          onClick={async () => {
                            const ok = await act(
                              req('Build', { zone, kind: o.kind }),
                              { okToast: `${o.name} 开始建造` },
                            );
                            if (ok) close();
                          }}
                        >
                          建造
                        </Btn>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </Modal>
  );
}

/** Open the build-options picker for a given zone. */
export function openBuildModal(zone: 'inner' | 'outer', freeSlots: number): void {
  openModal(
    (close) => <BuildModalContent zone={zone} freeSlots={freeSlots} close={close} />,
    'build',
  );
}
