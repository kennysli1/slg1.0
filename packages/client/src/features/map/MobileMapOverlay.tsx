import { useState } from 'preact/hooks';
import { Btn, Panel } from '../../ui/index.js';
import type { MapCameraApi } from './HexMap.js';

export type MobileMapOverlayKind = 'none' | 'situation' | 'tools' | 'target';
type CameraRef = { current: MapCameraApi | null };

export function MobileMapButtons({ active, warnings, marches, camera, onOpen }: { active: MobileMapOverlayKind; warnings: number; marches: number; camera: CameraRef; onOpen: (kind: 'none' | 'situation' | 'tools') => void }) {
  return <div class="map-mobile-buttons" aria-label="地图快捷操作">
    <button type="button" class="map-mobile-fab" onClick={() => camera.current?.focusCurrentVillage()} aria-label="回到当前村">◎</button>
    <button type="button" class={`map-mobile-fab map-mobile-fab--status${warnings ? ' is-danger' : ''}`} onClick={() => onOpen(active === 'situation' ? 'none' : 'situation')} aria-label={`地图态势${warnings ? `，${warnings} 个来袭预警` : marches ? `，${marches} 支部队行动中` : ''}`}>◉{(warnings || marches) > 0 && <b>{warnings || marches}</b>}</button>
    <button type="button" class="map-mobile-fab" onClick={() => onOpen(active === 'tools' ? 'none' : 'tools')} aria-label="打开地图工具">⌖</button>
  </div>;
}

export function MobileMapSheet({ kind, camera, onClose, children }: { kind: 'situation' | 'tools'; camera: CameraRef; onClose: () => void; children?: any }) {
  const [q, setQ] = useState(''); const [r, setR] = useState(''); const [error, setError] = useState(''); const [legendOpen, setLegendOpen] = useState(false);
  const title = kind === 'situation' ? '地图态势' : '地图工具';
  const jump = () => { const result = camera.current?.jumpTo(q, r); if (!result) setError('地图尚未准备好，请稍后重试'); else if (!result.ok) setError(result.error); else { setError(''); onClose(); } };
  return <Panel class="map-mobile-sheet map-mobile-sheet--full" role="dialog" aria-modal="false" aria-label={title}>
    <div class="map-mobile-sheet-grip" aria-hidden="true" /><div class="map-mobile-sheet-head"><strong>{title}</strong><button type="button" class="map-mobile-close" onClick={onClose} aria-label={`关闭${title}`}>×</button></div>
    {kind === 'situation' ? children : <><section class="map-mobile-tool-section"><strong>定位</strong><div class="map-mobile-coordinate-row"><label>X<input type="number" inputMode="numeric" value={q} onInput={(e) => { setQ(e.currentTarget.value); setError(''); }} /></label><label>Y<input type="number" inputMode="numeric" value={r} onInput={(e) => { setR(e.currentTarget.value); setError(''); }} /></label><Btn variant="primary" onClick={jump}>跳转</Btn></div>{error && <p class="map-mobile-tool-error" role="alert">{error}</p>}<Btn block onClick={() => { camera.current?.focusCurrentVillage(); onClose(); }}>回到当前村</Btn></section><section class="map-mobile-tool-section"><strong>缩放</strong><div class="map-mobile-tool-actions"><Btn onClick={() => camera.current?.zoom('out')}>− 缩小</Btn><Btn onClick={() => camera.current?.zoom('in')}>＋ 放大</Btn></div></section>{children}<section class="map-mobile-tool-section"><button type="button" class="map-mobile-legend-toggle" onClick={() => setLegendOpen(!legendOpen)} aria-expanded={legendOpen}>图例 <span>{legendOpen ? '收起' : '展开'}</span></button>{legendOpen && <div class="map-mobile-legend"><span>◆ 当前村 / 己方村</span><span>● 玩家与野怪目标</span><span>— 行军路线</span><span>🎯 任务营地</span></div>}</section></>}
  </Panel>;
}
