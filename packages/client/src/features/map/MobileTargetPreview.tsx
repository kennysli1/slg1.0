import type { SelectedTarget } from '../../app/state.js';
import { Btn, Panel } from '../../ui/index.js';

function targetKind(target: SelectedTarget): string {
  if (target.kind === 'own_village') return '己方村庄';
  if (target.kind === 'village') return target.relation === 'hostile' ? '敌对村庄' : target.relation === 'allied' ? '盟军村庄' : '玩家村庄';
  if (target.kind === 'pve' || target.kind === 'taskcamp') return '野怪营地';
  if (target.kind === 'empty') return '野外空地';
  if (target.kind === 'incoming_warning') return '来袭预警';
  if (target.kind === 'caravan') return '移动商队';
  return target.kind === 'enemy_army' ? '敌方军队' : '行军部队';
}

export function MobileTargetPreview({ target, onOpen, onClose, onChoose }: {
  target: SelectedTarget;
  onOpen: () => void;
  onClose: () => void;
  onChoose: (next: SelectedTarget) => void;
}) {
  const stack = target.stackedTargets ?? [];
  return <Panel class="map-mobile-sheet map-mobile-target-preview" role="region" aria-label="已选地图目标">
    <div class="map-mobile-sheet-grip" aria-hidden="true" />
    <div class="map-mobile-preview-main"><div class="map-mobile-preview-copy"><strong>{target.name}</strong><span>{targetKind(target)} · X {target.q} · Y {target.r}</span></div><button type="button" class="map-mobile-close" onClick={onClose} aria-label="关闭目标预览">×</button></div>
    {stack.length > 1 && <div class="map-mobile-stack-list" aria-label="同格目标">{stack.map((item) => <button key={`${item.kind}:${item.refId}`} type="button" class="map-mobile-stack-row" onClick={() => onChoose(item)}><span>{targetKind(item)}</span><b>{item.name}</b></button>)}</div>}
    <Btn variant="primary" size="lg" block onClick={onOpen}>查看可用行动</Btn>
  </Panel>;
}
