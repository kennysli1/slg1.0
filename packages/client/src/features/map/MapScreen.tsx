/**
 * MapScreen — 地图页顶层容器。
 * 布局：全屏 SVG 地图 + 桌面右侧战术栏（目标工作流与行军态势）。
 * 手机上目标工作流变为贴底抽屉，避免把表单和地图控件挤在同一视野内。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { mapVersion, selected, garrisonContinue, mapAreaStale } from '../../app/store.js';
import { getCache, type SelectedTarget } from '../../app/state.js';
import { HexMap, type MapCameraApi } from './HexMap.js';
import { TargetPanel } from './TargetPanel.js';
import { MarchList } from './MarchList.js';
import { refreshMapArea } from '../../app/refresh.js';
import { IncomingWarnings } from '../../shared/ui/IncomingWarnings.js';
import { MapVillageIndex } from './MapVillageIndex.js';
import { MobileMapButtons, MobileMapSheet, type MobileMapOverlayKind } from './MobileMapOverlay.js';
import { MobileTargetPreview } from './MobileTargetPreview.js';

function useMobileViewport() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width: 720px)'); const update = () => setMobile(query.matches); update(); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  return mobile;
}

export function MapScreen() {
  const target = selected.value;
  const continuing = garrisonContinue.value;
  const mobile = useMobileViewport();
  const camera = useRef<MapCameraApi>(null);
  const [mobileOverlay, setMobileOverlay] = useState<MobileMapOverlayKind>('none');
  const [targetStage, setTargetStage] = useState<'preview' | 'actions'>('preview');
  const targetKey = target ? `${target.kind}:${target.refId}:${target.q}:${target.r}` : '';
  const areaStale = mapAreaStale.value;
  useEffect(() => {
    if (areaStale) void refreshMapArea();
  }, [areaStale]);
  useEffect(() => { if (!mobile) { setMobileOverlay('none'); return; } if (continuing) { setTargetStage('actions'); setMobileOverlay('target'); } else if (target) { setTargetStage('preview'); setMobileOverlay('target'); } }, [mobile, targetKey, continuing]);
  useEffect(() => { const onEscape = (event: KeyboardEvent) => { if (event.key !== 'Escape' || !mobileOverlay) return; if (mobileOverlay === 'target' && targetStage === 'actions') setTargetStage('preview'); else { setMobileOverlay('none'); if (mobileOverlay === 'target') selected.value = null; } }; window.addEventListener('keydown', onEscape); return () => window.removeEventListener('keydown', onEscape); }, [mobileOverlay, targetStage]);
  const showPanel = !!target || !!continuing;
  const closeTarget = () => { selected.value = null; setMobileOverlay('none'); };
  return (
    <div class="map-screen">
      {/* 全屏 SVG 地图（含浮层导航控件和图例） */}
      <HexMap cameraApi={camera} />

      {!mobile && <aside class="map-tactical-stack" aria-label="地图战术面板">
        <IncomingWarnings />
        <MapVillageIndex />
        {showPanel && <TargetPanel />}
        <MarchList />
      </aside>}
      {mobile && <MobileMapUi
        active={mobileOverlay}
        target={target}
        continuing={continuing}
        targetStage={targetStage}
        camera={camera}
        onOpen={setMobileOverlay}
        onTargetStage={setTargetStage}
        onCloseTarget={closeTarget}
      />}
    </div>
  );
}

/** 移动端按钮单独订阅行军版本，桌面地图树不会被每次行军推送带着重渲染。 */
function MobileMapUi({
  active, target, continuing, targetStage, camera, onOpen, onTargetStage, onCloseTarget,
}: {
  active: MobileMapOverlayKind;
  target: SelectedTarget | null;
  continuing: { movementId: string; movementType?: 'garrison' | 'ambush' | 'investigate' } | null;
  targetStage: 'preview' | 'actions';
  camera: { current: MapCameraApi | null };
  onOpen: (kind: MobileMapOverlayKind) => void;
  onTargetStage: (stage: 'preview' | 'actions') => void;
  onCloseTarget: () => void;
}) {
  mapVersion.value;
  const warnings = getCache().playerMoves?.incomingWarnings?.length ?? getCache().moves?.incomingWarnings?.length ?? 0;
  const marches = getCache().moves?.movements?.length ?? 0;
  return (
    <div class="map-mobile-ui" aria-live="polite">
      <MobileMapButtons active={active} warnings={warnings} marches={marches} camera={camera} onOpen={onOpen} />
      {active === 'situation' && <MobileMapSheet kind="situation" camera={camera} onClose={() => onOpen('none')}><IncomingWarnings /><MarchList /></MobileMapSheet>}
      {active === 'tools' && <MobileMapSheet kind="tools" camera={camera} onClose={() => onOpen('none')}><MapVillageIndex /></MobileMapSheet>}
      {active === 'target' && targetStage === 'preview' && target && !continuing && <MobileTargetPreview target={target} onOpen={() => onTargetStage('actions')} onClose={onCloseTarget} onChoose={(next: SelectedTarget) => { selected.value = next; onTargetStage('preview'); }} />}
      {active === 'target' && targetStage === 'actions' && (target || continuing) && <div class="map-mobile-target-actions"><TargetPanel /></div>}
    </div>
  );
}
